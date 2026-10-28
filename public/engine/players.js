/**
 * Player-level projections.
 *
 * Pipeline per player:
 *   1. role        -> share of team volume (targets / carries), snap share
 *   2. availability -> probability of playing, from the injury report
 *   3. vacated     -> redistribute the usage of teammates unlikely to play
 *   4. volume      -> projected team volume x adjusted share, blended with the player's own recent volume
 *   5. efficiency  -> shrunk, opponent-adjusted rate per opportunity
 *   6. environment -> scoring context, weather, rest, divisional familiarity
 *
 * Two details that matter more than they look:
 *
 * - Shares are shrunk toward the share implied by the player's own per-game
 *   volume, never toward zero. Shrinking to zero biases every low-sample player
 *   downward in a way that is invisible until you notice a 1,100-yard back
 *   projected for six carries.
 *
 * - The share/direct blend is weighted by sample size. Two games of history
 *   should not outvote his actual per-game usage.
 */

import { clamp, mean, sd, sum, weightedStats, shrink, blendPrior, cv } from './math.js';
import { availabilityFor } from './model.js';

const WINDOW = 8;
const DECAY = 0.10;
const TRANSFER = 0.8;             // share of a vacated role handed to healthy teammates
const MANUAL_WEATHER_TRUST = 0.6; // the market total already reflects the forecast
const SHARE_PRIOR_K = 3;          // games of prior weight for a share estimate

const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE', 'FB', 'K']);

function rateOf(pairs, refWeek, prior, k) {
  const ws = weightedStats(pairs, DECAY, refWeek);
  if (ws.n === 0) return { value: prior, n: 0, variance: 0, values: [] };
  return {
    value: shrink(ws.mean, ws.n, prior, k),
    n: ws.n,
    variance: ws.variance,
    raw: ws.mean,
    values: ws.values,
  };
}

function teamWeekMap(seasonIdx, team) {
  const m = new Map();
  for (const r of seasonIdx.teamWeeks.get(team) || []) m.set(r.week, r);
  return m;
}

function recentWeeks(seasonIdx, team, cutoffWeek) {
  const out = [];
  for (const p of seasonIdx.playersById.values()) {
    if (!SKILL_POS.has(p.pos)) continue;
    const w = p.weeks.filter((x) => x.team === team && x.week < cutoffWeek);
    if (!w.length) continue;
    out.push({ player: p, weeks: w.slice(-WINDOW) });
  }
  return out;
}

const perGame = (weeks, key) => {
  const v = weeks.map((w) => w[key]).filter(Number.isFinite);
  return v.length ? mean(v) : 0;
};

// ------------------------------------------------------------ team volume plan

export function teamVolumeProjection(profile, oppProfile, league, env, side) {
  const playsBase = 0.6 * profile.off.playsPerGame + 0.4 * oppProfile.def.playsFacedPerGame;
  const paceScale = Math.pow(clamp(env.total / env.leagueTotal, 0.78, 1.3), 0.35);
  const plays = playsBase * paceScale;

  const ownRate = shrink(profile.off.passRateRaw, profile.games, league.passRate, 4);
  let passRate = 0.72 * ownRate + 0.28 * oppProfile.def.passRateFaced;
  const margin = env.margin[side];
  const script = clamp(-margin, -14, 14) * 0.0035; // trailing teams throw more
  passRate = clamp(passRate + script, 0.32, 0.76);

  const dropbacks = plays * passRate;
  const attempts = dropbacks * (1 - profile.off.sackRate);
  const carries = plays * (1 - passRate);

  return {
    plays,
    paceScale,
    passRate,
    passRateRaw: ownRate,
    script,
    margin,
    dropbacks,
    attempts,
    carries,
  };
}

// --------------------------------------------------------------- environment

export function weatherEffect(weather) {
  // Returns the multiplicative effect on passing and on kicking accuracy.
  if (!weather || !weather.known) return { pass: 1, kick: 1, notes: [] };
  if (weather.isDome) return { pass: 1, kick: 1, notes: ['indoors: no weather effect'] };
  const notes = [];
  let pass = 1;
  let kick = 1;
  const wind = Number.isFinite(weather.wind) ? weather.wind : 0;
  const temp = Number.isFinite(weather.temp) ? weather.temp : 60;
  if (wind >= 12) {
    pass *= clamp(1 - 0.0045 * (wind - 12), 0.87, 1);
    kick *= clamp(1 - 0.007 * (wind - 12), 0.78, 1);
    notes.push(`${wind} mph wind`);
  }
  if (temp <= 28) {
    pass *= clamp(1 - 0.0015 * (28 - temp), 0.95, 1);
    kick *= clamp(1 - 0.0012 * (28 - temp), 0.95, 1);
    notes.push(`${temp}F`);
  }
  return { pass, kick, notes, trust: weather.manual ? MANUAL_WEATHER_TRUST : 1 };
}

function environmentFactors(env, side) {
  const factors = [];
  const implied = env.implied[side];
  const idx = implied / env.leagueImplied;

  // Scoring context is the one place we deliberately lean on the market total.
  factors.push({
    key: 'implied',
    label: 'Implied team total',
    kind: 'scoring',
    value: clamp(Math.pow(idx, 0.5), 0.86, 1.16),
    tdValue: clamp(Math.pow(idx, 0.75), 0.78, 1.30),
    detail: `${implied.toFixed(1)} pts vs ${env.leagueImplied.toFixed(1)} league average`,
  });

  if (env.divGame) {
    factors.push({
      key: 'division',
      label: 'Divisional opponent',
      kind: 'efficiency',
      value: 0.98,
      tdValue: 0.96,
      detail: 'familiarity compresses efficiency and raises variance (small weight, debated)',
    });
  }

  const rest = env.rest[side] ?? 7;
  const oppRest = env.rest[side === 'home' ? 'away' : 'home'] ?? 7;
  const restDiff = rest - oppRest;
  if (Number.isFinite(restDiff) && restDiff !== 0) {
    factors.push({
      key: 'rest',
      label: 'Rest differential',
      kind: 'efficiency',
      value: 1 + clamp(restDiff, -6, 6) * 0.006,
      detail: `${rest} days vs ${oppRest} for the opponent`,
    });
  }

  const wx = weatherEffect(env.weather);
  if (wx.pass !== 1) {
    const trust = wx.trust ?? 1;
    factors.push({
      key: 'weather',
      label: 'Weather',
      kind: 'efficiency',
      value: 1 + (wx.pass - 1) * trust,
      kickValue: 1 + (wx.kick - 1) * trust,
      detail: `${wx.notes.join(', ')}${env.weather.manual ? ' (manual forecast applied at 60%: the market total already prices it)' : ''}`,
    });
  }

  return factors;
}

// ------------------------------------------------------------------ main entry

export function projectTeamPlayers({ seasonIdx, priorIdx, cutoffWeek, team, profile, opp, league, env, settings }) {
  const side = env.side[team];
  const teamWeeks = teamWeekMap(seasonIdx, team);
  const ref = cutoffWeek - 1;

  const roster = recentWeeks(seasonIdx, team, cutoffWeek);
  const priorRoster = priorIdx ? recentWeeks(priorIdx, team, 99) : [];
  const priorById = new Map();
  for (const r of priorRoster) priorById.set(r.player.id, priorStats(r));

  // ---- pass 1: raw usage, role, availability -----------------------------
  for (const r of roster) {
    const w = r.weeks;
    const snaps = seasonIdx.snapByPlayerWeek.get(r.player.name);
    if (snaps) {
      const pairs = w.filter((x) => snaps.has(x.week)).map((x) => ({ week: x.week, value: snaps.get(x.week) }));
      r.snapPct = pairs.length ? weightedStats(pairs, DECAY, ref).mean : null;
    } else r.snapPct = null;

    r.games = w.length;
    const attWeeks = w.filter((x) => x.attempts > 0).map((x) => x.attempts);
    r.attemptsCv = attWeeks.length > 1 ? cv(attWeeks) : 0.9;
    r.targetsPerGame = perGame(w, 'targets');
    r.carriesPerGame = perGame(w, 'carries');
    r.attemptsPerGame = perGame(w, 'attempts');
    r.availability = availabilityFor(
      seasonIdx, r.player.id, cutoffWeek, settings.availabilityOverrides?.[r.player.id],
    );
    r.shareTPairs = [];
    r.shareCPairs = [];
    for (const wk of w) {
      const t = teamWeeks.get(wk.week);
      if (!t) continue;
      if (t.passAtt >= 8) r.shareTPairs.push({ week: wk.week, value: wk.targets / t.passAtt });
      if (t.carries >= 5) r.shareCPairs.push({ week: wk.week, value: wk.carries / t.carries });
    }
  }

  const teamVol = teamVolumeProjection(profile, opp, league, env, side);

  // ---- pass 2: shares, shrink toward each player's own implied share ------
  const starters = new Map();
  const qbs = roster.filter((r) => r.player.pos === 'QB').sort((a, b) => b.attemptsPerGame - a.attemptsPerGame);
  if (qbs.length) starters.set(team, qbs[0]);

  for (const r of roster) {
    const priorT = teamVol.attempts > 0 ? clamp(r.targetsPerGame / teamVol.attempts, 0, 1) : 0;
    const priorC = teamVol.carries > 0 ? clamp(r.carriesPerGame / teamVol.carries, 0, 1) : 0;

    const ts = rateOf(r.shareTPairs, ref, priorT, SHARE_PRIOR_K);
    const cs = rateOf(r.shareCPairs, ref, priorC, SHARE_PRIOR_K);
    r.targetShare = ts.value;
    r.carryShare = cs.value;
    r.targetShareN = ts.n;
    r.carryShareN = cs.n;
    r.targetShareCv = ts.values.length > 1 ? cv(ts.values) : 0.9;
    r.carryShareCv = cs.values.length > 1 ? cv(cs.values) : 0.9;
  }

  // ---- pass 3: vacated usage --------------------------------------------
  // Teammates miss in proportion to their risk, and the expectation of their
  // share moves to whoever is healthy.
  let vacatedT = 0;
  let vacatedC = 0;
  for (const r of roster) {
    const miss = 1 - r.availability.p;
    vacatedT += miss * r.targetShare;
    vacatedC += miss * r.carryShare;
  }
  const healthyT = sum(roster.filter((r) => r.availability.p >= 0.5).map((r) => r.targetShare));
  const healthyC = sum(roster.filter((r) => r.availability.p >= 0.5).map((r) => r.carryShare));
  for (const r of roster) {
    const canAbsorb = r.availability.p >= 0.5;
    r.targetShareAdj = r.targetShare + (canAbsorb && healthyT > 0
      ? (TRANSFER * vacatedT * r.targetShare) / healthyT : 0);
    r.carryShareAdj = r.carryShare + (canAbsorb && healthyC > 0
      ? (TRANSFER * vacatedC * r.carryShare) / healthyC : 0);
    r.vacatedTargetShare = r.targetShareAdj - r.targetShare;
    r.vacatedCarryShare = r.carryShareAdj - r.carryShare;
  }

  // ---- pass 4: share-consistent team allocation --------------------------
  // The share/direct blend can over-allocate when a player's own average outruns
  // his role (small sample, hot streak). Left alone, a roster's projected targets
  // summed to 57 on a team projected for 34 throws, which is not a thing. Scale to
  // the team's projected volume, and only downward: an under-allocated roster just
  // means the leftover goes to players without markets.
  const alloc = new Map();
  let sumT = 0;
  let sumC = 0;
  for (const r of roster) {
    const wT = r.targetShareN / (r.targetShareN + 2);
    const wC = r.carryShareN / (r.carryShareN + 2);
    const t = clamp(wT * (r.targetShareAdj * teamVol.attempts) + (1 - wT) * r.targetsPerGame, 0, 22);
    const c = clamp(wC * (r.carryShareAdj * teamVol.carries) + (1 - wC) * r.carriesPerGame, 0, 34);
    alloc.set(r.player.id, { targets: t, carries: c });
    sumT += t;
    sumC += c;
  }
  const scaleT = sumT > teamVol.attempts ? teamVol.attempts / sumT : 1;
  const scaleC = sumC > teamVol.carries ? teamVol.carries / sumC : 1;
  for (const a of alloc.values()) {
    a.targets *= scaleT;
    a.carries *= scaleC;
  }

  // ---- environment & opponent -------------------------------------------
  const envFactors = environmentFactors(env, side);
  const scoring = envFactors.find((f) => f.key === 'implied');
  const effFactors = envFactors.filter((f) => f.kind === 'efficiency');

  const reg = opp.games / (opp.games + 4);
  const passDefIdx = opp.def.passYdsPerAttAllowed / (league.passYdsPerAtt || 7);
  const rushDefIdx = opp.def.rushYdsPerCarryAllowed / (league.rushYdsPerCarry || 4.3);
  const passEffAdj = 1 + (passDefIdx - 1) * 0.85 * reg;
  const rushEffAdj = 1 + (rushDefIdx - 1) * 0.85 * reg;
  const catchAdj = 1 + (passDefIdx - 1) * 0.35 * reg;
  const oppScoringIdx = opp.def.pointsAllowedPerGame / (league.pointsPerGame || 22);
  const tdScoringAdj = clamp(1 + (oppScoringIdx - 1) * 0.5 * reg, 0.8, 1.2);

  const effMult = effFactors.reduce((m, f) => m * f.value, 1);
  const kickMult = effFactors.reduce((m, f) => m * (f.kickValue ?? 1), 1);
  const yardsMult = scoring?.value ?? 1;
  const tdEnvMult = scoring?.tdValue ?? 1;

  const players = [];

  for (const r of roster) {
    const p = r.player;
    const group = p.group || p.pos;
    const prior = league.groupRates.get(group) || league.groupRates.get('WR') || {};
    const priorPlayer = priorById.get(p.id);
    const games = r.weeks.length;
    const avail = r.availability;
    const isQb = p.pos === 'QB';

    // ---- volume ----
    // Trust the share more as the sample grows; fall back to his own per-game
    // volume when there is not enough history to know his role.
    const { targets, carries } = alloc.get(p.id);

    let attempts = 0;
    if (isQb) {
      const isStarter = starters.get(team)?.player.id === p.id;
      // Capped at the team's own projected attempts. A quarterback cannot throw
      // more passes than his team throws, however hot his own average looks.
      const implied = teamVol.attempts > 0
        ? clamp(r.attemptsPerGame / teamVol.attempts, 0, 1) : 0;
      // A backup gets a token share rather than a second helping of the starter's
      // volume. This does not fix a team that has already changed starters.
      attempts = clamp(teamVol.attempts * implied * (isStarter ? 1 : 0.15), 0, 55);
    }

    // ---- efficiency ----
    const recWeeks = r.weeks.filter((w) => w.targets > 0);
    const catchRate = rateOf(recWeeks.map((w) => ({ week: w.week, value: w.rec / w.targets })),
      ref, prior.catchRate ?? 0.62, 5);
    const ypcatch = rateOf(recWeeks.filter((w) => w.rec > 0).map((w) => ({ week: w.week, value: w.recYds / w.rec })),
      ref, prior.ydsPerCatch ?? 10.5, 5);
    const tdPerCatch = rateOf(recWeeks.filter((w) => w.rec > 0).map((w) => ({ week: w.week, value: w.recTds / w.rec })),
      ref, prior.tdPerCatch ?? 0.06, 8);
    const runWeeks = r.weeks.filter((w) => w.carries > 0);
    const ypc = rateOf(runWeeks.map((w) => ({ week: w.week, value: w.rushYds / w.carries })),
      ref, prior.ypc ?? 4.3, 5);
    const tdPerCarry = rateOf(runWeeks.map((w) => ({ week: w.week, value: w.rushTds / w.carries })),
      ref, prior.tdPerCarry ?? 0.035, 8);
    const passWeeks = r.weeks.filter((w) => w.attempts > 0);
    const ypa = rateOf(passWeeks.map((w) => ({ week: w.week, value: w.passYds / w.attempts })),
      ref, prior.ypa ?? 7.1, 5);
    const tdPerAtt = rateOf(passWeeks.map((w) => ({ week: w.week, value: w.passTds / w.attempts })),
      ref, prior.tdPerAtt ?? 0.045, 8);
    const intPerAtt = rateOf(passWeeks.map((w) => ({ week: w.week, value: w.ints / w.attempts })),
      ref, prior.intPerAtt ?? 0.025, 8);

    const blendEff = (cur, priorVal) => (Number.isFinite(priorVal)
      ? blendPrior(cur, priorVal, games) : cur);

    const eff = {
      catchRate: clamp(catchRate.value * catchAdj, 0.2, 0.92),
      ydsPerCatch: Math.max(0.5, blendEff(ypcatch.value, priorPlayer?.ydsPerCatch) * passEffAdj * effMult),
      ydsPerTarget: 0,
      tdPerCatch: clamp(tdPerCatch.value * tdScoringAdj * tdEnvMult, 0.005, 0.4),
      ypc: Math.max(0.5, blendEff(ypc.value, priorPlayer?.ypc) * rushEffAdj * effMult),
      tdPerCarry: clamp(tdPerCarry.value * tdScoringAdj * tdEnvMult, 0.001, 0.3),
      ypa: Math.max(1, blendEff(ypa.value, priorPlayer?.ypa) * passEffAdj * effMult),
      tdPerAtt: clamp(tdPerAtt.value * tdScoringAdj * tdEnvMult, 0.005, 0.2),
      intPerAtt: clamp(intPerAtt.value * (2 - passEffAdj) * 0.9, 0.002, 0.12),
      fgPct: clamp(profile.st.fgPct * kickMult, 0.5, 0.99),
    };
    eff.ydsPerTarget = eff.catchRate * eff.ydsPerCatch;

    const fgAtt = p.pos === 'K'
      ? clamp(profile.st.fgAttPerGame * (teamVol.plays / (league.playsPerGame || 64)), 0.4, 6)
      : 0;

    // ---- market eligibility ----
    // Volume floors keep the board to props a book would actually post.
    const markets = [];
    if (isQb) {
      markets.push('pass_yds', 'pass_tds', 'ints', 'pass_att');
      if (r.carriesPerGame >= 3) markets.push('rush_yds');
    }
    if (p.pos === 'RB') {
      if (carries >= 4) markets.push('carries', 'rush_yds');
      else if (carries >= 2) markets.push('rush_yds');
      if (targets >= 1.5) markets.push('receptions', 'rec_yds');
      if (carries + targets >= 6) markets.push('anytime_td');
    }
    if (p.pos === 'WR' || p.pos === 'TE' || p.pos === 'FB') {
      if (targets >= 1.5) markets.push('receptions');
      if (targets >= 2) markets.push('rec_yds');
      if (targets >= 2.5) markets.push('anytime_td');
      if (p.pos !== 'FB' && r.carriesPerGame >= 2) markets.push('rush_yds');
    }
    if (p.pos === 'K') markets.push('fg_made');

    // ---- factor ledger ----
    const factors = [];
    factors.push({
      key: 'volume',
      label: 'Projected volume',
      kind: 'volume',
      value: 1,
      detail: isQb
        ? `${attempts.toFixed(1)} pass attempts (team projects ${teamVol.attempts.toFixed(1)})`
        : `${targets.toFixed(1)} targets, ${carries.toFixed(1)} carries`,
    });
    if (r.vacatedTargetShare > 0.002 || r.vacatedCarryShare > 0.002) {
      factors.push({
        key: 'vacated',
        label: 'Teammate usage vacated',
        kind: 'volume',
        value: 1 + r.vacatedTargetShare / Math.max(r.targetShare, 1e-6),
        detail: `+${(r.vacatedTargetShare * 100).toFixed(1)}pp target share, +${(r.vacatedCarryShare * 100).toFixed(1)}pp carry share from teammates unlikely to play`,
      });
    }
    if (Math.abs(teamVol.script) > 0.002) {
      factors.push({
        key: 'script',
        label: 'Game script',
        kind: 'volume',
        value: 1,
        detail: `${teamVol.margin > 0 ? 'favoured' : 'underdog'} by ${Math.abs(teamVol.margin).toFixed(1)}: pass rate ${teamVol.script > 0 ? '+' : ''}${(teamVol.script * 100).toFixed(1)}pp`,
      });
    }
    factors.push({
      key: 'def',
      label: 'Opponent defence',
      kind: 'efficiency',
      value: passEffAdj,
      detail: `${((passDefIdx - 1) * 100).toFixed(0)}% vs league on yards per attempt allowed, over ${opp.games} games`,
    });
    for (const f of envFactors) factors.push(f);

    // ---- flags ----
    const flags = [];
    if (avail.p < 0.5) flags.push({ code: 'unlikely', label: 'Not expected to play', severity: 'high', detail: avail.source });
    else if (avail.p < 0.9) flags.push({ code: 'questionable', label: 'Questionable', severity: 'med', detail: `${Math.round(avail.p * 100)}% play probability` });
    if (avail.stale) flags.push({ code: 'stale', label: 'Stale injury report', severity: 'med', detail: avail.source });
    if (games < 3) flags.push({ code: 'thin', label: 'Thin sample', severity: 'med', detail: `${games} games with a role` });
    if (r.targetShareCv > 0.6 && targets > 1) flags.push({ code: 'volatile', label: 'Volatile usage', severity: 'low', detail: 'target share swings week to week' });
    // Missing weather is a game-level condition, not a per-prop one: it is reported
    // once in the environment panel rather than as a dot on all 77 rows.
    if (r.snapPct !== null && r.snapPct < 0.45 && targets > 1.5) flags.push({ code: 'snaps', label: 'Part-time snaps', severity: 'low', detail: `${Math.round(r.snapPct * 100)}% of offensive snaps` });

    const naive = {};
    for (const key of ['rec', 'recYds', 'recTds', 'carries', 'rushYds', 'rushTds',
      'attempts', 'passYds', 'passTds', 'ints', 'fgMade']) {
      const ws = weightedStats(r.weeks.map((w) => ({ week: w.week, value: w[key] })), DECAY, ref);
      naive[key] = ws.n ? ws.mean : 0;
    }
    naive.totalTds = naive.recTds + naive.rushTds;

    players.push({
      id: p.id,
      name: p.name,
      pos: p.pos,
      group,
      team,
      opp: opp.team,
      headshot: p.headshot,
      side,
      games,
      snapPct: r.snapPct,
      availability: avail,
      usage: {
        targetShare: r.targetShare,
        targetShareAdj: r.targetShareAdj,
        carryShare: r.carryShare,
        carryShareAdj: r.carryShareAdj,
        vacatedTargetShare: r.vacatedTargetShare,
        vacatedCarryShare: r.vacatedCarryShare,
        targetShareCv: r.targetShareCv,
        carryShareCv: r.carryShareCv,
        attemptsCv: r.attemptsCv,
        targetsPerGame: r.targetsPerGame,
        carriesPerGame: r.carriesPerGame,
        attemptsPerGame: r.attemptsPerGame,
      },
      volume: { targets, carries, attempts, fgAtt, teamVol },
      eff: { ...eff, yardsMult },
      naive,
      factors,
      flags,
      markets,
    });
  }

  return players.filter((p) => p.markets.length > 0);
}

function priorStats(r) {
  const weeks = r.weeks;
  const t = perGame(weeks, 'targets');
  const c = perGame(weeks, 'carries');
  const rec = perGame(weeks, 'rec');
  const recYds = perGame(weeks, 'recYds');
  const rushYds = perGame(weeks, 'rushYds');
  const att = perGame(weeks, 'attempts');
  const passYds = perGame(weeks, 'passYds');
  return {
    ydsPerCatch: rec > 0 ? recYds / rec : NaN,
    ypc: c > 0 ? rushYds / c : NaN,
    ypa: att > 0 ? passYds / att : NaN,
    targets: t,
  };
}
