/**
 * Projection engine.
 *
 * THE CORE IDEA: predict OPPORTUNITY and EFFICIENCY separately, then multiply.
 *
 *   projected stat = projected opportunities x projected rate per opportunity
 *
 * Opportunity (targets, carries, attempts, snaps) is far more predictable week to
 * week than efficiency (yards per catch, TD per carry). Most public "prop models"
 * regress a player's stat line on his own history and call it a projection; that
 * approach double-counts opponent quality through both terms. Splitting them lets
 * us attribute each adjustment to exactly one side of the multiplication, which is
 * also what makes the "why" panel in the UI possible at all.
 *
 * Every multiplier below is explicit, has a documented source, and is listed in
 * `factors` so the board can show its own work.
 */

import { clamp, mean, sd, weightedStats, shrink, blendPrior, cv, sum } from './math.js';

const RECENCY_DECAY = 0.10;   // per week
const WINDOW_WEEKS = 8;       // rolling window of games used for rates
const PRIOR_K = {             // shrinkage strength, in games
  teamRate: 4,
  teamVolume: 4,
  playerEff: 5,
  playerShare: 3,
  defense: 5,
};

// ---------------------------------------------------------------- league priors

export function leaguePriors(seasonIdx, cutoffWeek, excludeTeams) {
  const windowRows = (rows, team) => {
    if (excludeTeams.includes(team)) return [];
    return clip(rows, cutoffWeek);
  };

  const teamAgg = [];
  for (const [team, rows] of seasonIdx.teamWeeks) teamAgg.push(...windowRows(rows, team));

  const playersByGroup = new Map();
  for (const p of seasonIdx.playersById.values()) {
    const w = clip(p.weeks, cutoffWeek);
    if (!w.length) continue;
    const g = p.group || 'OTHER';
    if (!playersByGroup.has(g)) playersByGroup.set(g, []);
    playersByGroup.get(g).push(...w);
  }

  const groupRates = new Map();
  for (const [g, rows] of playersByGroup) {
    const t = agg(rows, 'targets');
    const r = agg(rows, 'rec');
    const rYd = agg(rows, 'recYds');
    const rTd = agg(rows, 'recTds');
    const carry = agg(rows, 'carries');
    const ruYd = agg(rows, 'rushYds');
    const ruTd = agg(rows, 'rushTds');
    const att = agg(rows, 'attempts');
    const pYd = agg(rows, 'passYds');
    const pTd = agg(rows, 'passTds');
    const ints = agg(rows, 'ints');
    groupRates.set(g, {
      catchRate: t > 0 ? clamp(r / t, 0.35, 0.85) : 0.62,
      ydsPerCatch: r > 0 ? clamp(rYd / r, 4, 20) : 10.5,
      ydsPerTarget: t > 0 ? clamp(rYd / t, 2, 12) : 7.0,
      tdPerCatch: r > 0 ? clamp(rTd / r, 0.01, 0.25) : 0.06,
      ypc: carry > 0 ? clamp(ruYd / carry, 2, 7) : 4.2,
      tdPerCarry: carry > 0 ? clamp(ruTd / carry, 0.002, 0.12) : 0.035,
      ypa: att > 0 ? clamp(pYd / att, 4, 10) : 7.1,
      tdPerAtt: att > 0 ? clamp(pTd / att, 0.01, 0.12) : 0.045,
      intPerAtt: att > 0 ? clamp(ints / att, 0.005, 0.08) : 0.025,
    });
  }

  const passAtt = agg(teamAgg, 'passAtt');
  const carries = agg(teamAgg, 'carries');
  const sacks = agg(teamAgg, 'sacks');
  const plays = passAtt + carries + sacks;
  const games = teamAgg.length;
  const passYds = agg(teamAgg, 'passYds');
  const rushYds = agg(teamAgg, 'rushYds');
  const passEpa = agg(teamAgg, 'passEpa');
  const rushEpa = agg(teamAgg, 'rushEpa');
  const comps = agg(teamAgg, 'completions');

  return {
    games,
    playsPerGame: games ? plays / games : 64,
    passRate: plays > 0 ? (passAtt + sacks) / plays : 0.55,
    passAttPerGame: games ? passAtt / games : 34,
    carriesPerGame: games ? carries / games : 27,
    passYdsPerGame: games ? passYds / games : 225,
    rushYdsPerGame: games ? rushYds / games : 115,
    passYdsPerAtt: passAtt + sacks > 0 ? passYds / (passAtt + sacks) : 7.0,
    sackRate: passAtt + sacks > 0 ? sacks / (passAtt + sacks) : 0.065,
    pointsPerGame: 22,
    rushYdsPerCarry: carries > 0 ? rushYds / carries : 4.3,
    passEpaPerPlay: plays > 0 ? passEpa / Math.max(passAtt + sacks, 1) : 0,
    rushEpaPerCarry: carries > 0 ? rushEpa / carries : 0,
    catchRate: passAtt > 0 ? comps / passAtt : 0.64,
    stYdsPerGame: games ? (agg(teamAgg, 'puntRetYds') + agg(teamAgg, 'kickRetYds')) / games : 18,
    fgAttPerGame: games ? agg(teamAgg, 'fgAtt') / games : 2.0,
    fgPct: agg(teamAgg, 'fgAtt') > 0 ? agg(teamAgg, 'fgMade') / agg(teamAgg, 'fgAtt') : 0.85,
    groupRates,
  };
}

const agg = (rows, key) => sum(rows.map((r) => r[key]));

function clip(rows, cutoffWeek) {
  const out = rows
    .filter((r) => r.week < cutoffWeek && Number.isFinite(r.week))
    .sort((a, b) => a.week - b.week);
  return out.slice(Math.max(0, out.length - WINDOW_WEEKS));
}

/** Recency-weighted per-game value from a list of {week, value} pairs. */
function rate(pairs, refWeek, prior, k) {
  const ws = weightedStats(pairs, RECENCY_DECAY, refWeek);
  if (ws.n === 0) return { value: prior, n: 0, variance: 0 };
  return { value: shrink(ws.mean, ws.n, prior, k), n: ws.n, variance: ws.variance, raw: ws.mean };
}

// ------------------------------------------------------------- team profiles

export function buildTeamProfile(seasonIdx, priorIdx, team, cutoffWeek, league, pointsTable) {
  const rows = clip(seasonIdx.teamWeeks.get(team) || [], cutoffWeek);
  const allowed = clip(seasonIdx.allowedByTeam.get(team) || [], cutoffWeek);
  const priorRows = priorIdx ? clip(priorIdx.teamWeeks.get(team) || [], 99) : [];
  const ref = cutoffWeek - 1;
  const L = league;

  const off = {
    games: rows.length,
    playsPerGame: shrink(perGame(rows, 'plays'), rows.length, L.playsPerGame, PRIOR_K.teamVolume),
    passRateRaw: share(rows, 'passAtt', 'plays'),
    passYdsPerGame: shrink(perGame(rows, 'passYds'), rows.length, L.passYdsPerGame, PRIOR_K.teamRate),
    rushYdsPerGame: shrink(perGame(rows, 'rushYds'), rows.length, L.rushYdsPerGame, PRIOR_K.teamRate),
    passYdsPerAtt: shrink(perGame(rows, 'passYds') / Math.max(perGame(rows, 'passAtt'), 1), rows.length, L.passYdsPerAtt, PRIOR_K.teamRate),
    rushYdsPerCarry: shrink(perGame(rows, 'rushYds') / Math.max(perGame(rows, 'carries'), 1), rows.length, L.rushYdsPerCarry, PRIOR_K.teamRate),
    sackRate: shrink(
      perGame(rows, 'sacks') / Math.max(perGame(rows, 'passAtt') + perGame(rows, 'sacks'), 1),
      rows.length, L.sackRate, PRIOR_K.teamRate,
    ),
    passEpaPerPlay: perGame(rows, 'passEpa') / Math.max(perGame(rows, 'passAtt') + perGame(rows, 'sacks'), 1),
    rushEpaPerCarry: perGame(rows, 'rushEpa') / Math.max(perGame(rows, 'carries'), 1),
    pointsPerGame: 0,
  };

  const def = {
    games: allowed.length,
    playsFacedPerGame: shrink(perGame(allowed, 'plays'), allowed.length, L.playsPerGame, PRIOR_K.teamVolume),
    passRateFaced: share(allowed, 'passAtt', 'plays'),
    passYdsAllowedPerGame: shrink(perGame(allowed, 'passYds'), allowed.length, L.passYdsPerGame, PRIOR_K.defense),
    rushYdsAllowedPerGame: shrink(perGame(allowed, 'rushYds'), allowed.length, L.rushYdsPerGame, PRIOR_K.defense),
    passYdsPerAttAllowed: shrink(perGame(allowed, 'passYds') / Math.max(perGame(allowed, 'passAtt'), 1), allowed.length, L.passYdsPerAtt, PRIOR_K.defense),
    rushYdsPerCarryAllowed: shrink(perGame(allowed, 'rushYds') / Math.max(perGame(allowed, 'carries'), 1), allowed.length, L.rushYdsPerCarry, PRIOR_K.defense),
    passEpaAllowedPerPlay: perGame(allowed, 'passEpa') / Math.max(perGame(allowed, 'passAtt') + perGame(allowed, 'sacks'), 1),
    rushEpaAllowedPerCarry: perGame(allowed, 'rushEpa') / Math.max(perGame(allowed, 'carries'), 1),
    pointsAllowedPerGame: 0,
  };

  const st = {
    retYdsPerGame: shrink(perGame(rows, 'puntRetYds') + perGame(rows, 'kickRetYds'), rows.length, L.stYdsPerGame, PRIOR_K.teamRate),
    fgAttPerGame: shrink(perGame(rows, 'fgAtt'), rows.length, L.fgAttPerGame, PRIOR_K.teamRate),
    fgPct: shrink(fgPct(rows), rows.length, L.fgPct, PRIOR_K.teamRate),
    netPuntPerGame: perGame(rows, 'ptNet'),
    stTds: perGame(rows, 'stTds'),
    defTds: perGame(rows, 'defTds'),
  };

  if (priorRows.length) {
    off.playsPerGame = blendPrior(off.playsPerGame, perGame(priorRows, 'plays'), rows.length);
    off.passYdsPerGame = blendPrior(off.passYdsPerGame, perGame(priorRows, 'passYds'), rows.length);
    off.rushYdsPerGame = blendPrior(off.rushYdsPerGame, perGame(priorRows, 'rushYds'), rows.length);
  }

  const pts = pointsTable.get(team) || { for: L.pointsPerGame || 22, against: 22 };
  off.pointsPerGame = pts.for;
  def.pointsAllowedPerGame = pts.against;

  // Indices vs league: 1.0 = league average. These drive opponent adjustments.
  const idx = {
    passOff: off.passYdsPerGame / L.passYdsPerGame,
    rushOff: off.rushYdsPerGame / L.rushYdsPerGame,
    passDef: def.passYdsAllowedPerGame / L.passYdsPerGame,
    rushDef: def.rushYdsAllowedPerGame / L.rushYdsPerGame,
    pace: off.playsPerGame / L.playsPerGame,
    st: st.retYdsPerGame / L.stYdsPerGame,
  };

  return { team, off, def, st, idx, games: rows.length, ref };
}

function perGame(rows, key) {
  const vals = rows.map((r) => r[key]).filter(Number.isFinite);
  return vals.length ? mean(vals) : 0;
}

function share(rows, numKey, denKey) {
  const num = sum(rows.map((r) => r[numKey]));
  const den = sum(rows.map((r) => r[denKey]));
  return den > 0 ? num / den : 0;
}

function fgPct(rows) {
  const att = sum(rows.map((r) => r.fgAtt));
  const made = sum(rows.map((r) => r.fgMade));
  return att > 0 ? made / att : 0.85;
}

/** Points for/against per team, from completed games only. */
export function buildPointsTable(data, season, cutoffWeek) {
  const table = new Map();
  for (const [week, games] of data.gamesBySeason.get(season) || []) {
    if (week >= cutoffWeek) continue;
    for (const g of games) {
      if (!g.played) continue;
      bump(table, g.home, g.homeScore, g.awayScore);
      bump(table, g.away, g.awayScore, g.homeScore);
    }
  }
  for (const [team, t] of table) {
    t.for = t.games ? t.for / t.games : 22;
    t.against = t.games ? t.against / t.games : 22;
  }
  return table;
}

function bump(table, team, scored, allowed) {
  if (!table.has(team)) table.set(team, { for: 0, against: 0, games: 0 });
  const t = table.get(team);
  t.for += scored;
  t.against += allowed;
  t.games += 1;
}

// -------------------------------------------------------------------- injuries

/** Probabilities are game-status based, the way availability actually resolves. */
export function availabilityProbability(status, practice) {
  const s = (status || '').toLowerCase();
  const p = (practice || '').toLowerCase();
  if (s === 'out') return 0.02;
  if (s === 'doubtful') return 0.15;
  if (s === 'questionable') {
    if (p.includes('did not') || p.includes('dnp')) return 0.55;
    if (p.includes('limited')) return 0.72;
    if (p.includes('full')) return 0.88;
    return 0.75;
  }
  return 1;
}

export function availabilityFor(seasonIdx, playerId, targetWeek, override) {
  if (override && override !== 'auto') {
    const map = { OUT: 'Out', DOUBTFUL: 'Doubtful', QUESTIONABLE: 'Questionable', ACTIVE: '' };
    const status = map[override] ?? override;
    return {
      status,
      practice: '',
      injury: override === 'ACTIVE' ? 'cleared by user' : 'user override',
      p: availabilityProbability(status, ''),
      source: 'manual override',
      stale: false,
      manual: true,
    };
  }

  const byWeek = seasonIdx.injuryByPlayerWeek.get(playerId);
  if (!byWeek || byWeek.size === 0) {
    return { status: '', practice: '', injury: '', p: 1, source: 'no report filed', stale: false };
  }
  if (byWeek.has(targetWeek)) {
    const e = byWeek.get(targetWeek);
    return { ...e, p: availabilityProbability(e.status, e.practice), source: `week ${targetWeek} report`, stale: false };
  }
  // Only a row that actually carries a game status counts as a report. Most rows
  // in the injury file have an empty status (they record practice notes only),
  // and treating those as reports flagged nearly every player as stale.
  let latest = null;
  for (const [wk, e] of byWeek) {
    if (wk < targetWeek && e.status && (!latest || wk > latest.week)) latest = e;
  }
  if (!latest) return { status: '', practice: '', injury: '', p: 1, source: 'no report filed', stale: false };
  return {
    ...latest,
    p: availabilityProbability(latest.status, latest.practice),
    source: `week ${latest.week} report (target week not released yet)`,
    stale: true,
  };
}
