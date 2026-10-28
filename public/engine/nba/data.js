/**
 * NBA data layer.
 *
 * Source: ESPN's public JSON feeds, fetched through Server.java's /api/nba proxy (pattern
 * validated keys, disk cached). No API key, and nothing is scraped out of rendered pages -
 * these are the same feeds espn.com's own site calls.
 *
 * Two seasons matter here. 2026-27 is about a week old, so a three- or four-game sample
 * cannot describe a player's role on its own. Last season supplies the prior, exactly the
 * way the NFL side blends the previous year.
 */

export const NBA_SEASON = 2027; // ESPN season year: 2027 is the 2026-27 season
export const NBA_PRIOR = 2026; // 2025-26

const apiKey = (k) => `/api/nba?key=${encodeURIComponent(k)}`;

async function getJson(k) {
  const res = await fetch(apiKey(k));
  if (!res.ok) throw new Error(`nba ${k} -> HTTP ${res.status}`);
  return res.json();
}

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const shiftDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** "6-14" -> [6, 14] */
function madeAtt(v) {
  const [m, a] = String(v ?? '').split('-');
  return [num(m) ?? 0, num(a) ?? 0];
}

/* ------------------------------------------------------------------- slate */

/**
 * The games around today: a few recent finals plus the upcoming week, with market lines.
 * ESPN's scoreboard rejects date ranges (400), so this walks one day at a time. Team rest
 * and recent form come from each team's own schedule, not from this, so the window only
 * needs to cover what can be selected.
 */
export async function loadSlate({ onProgress } = {}) {
  onProgress?.('nba: schedule');
  const today = new Date();
  const days = [];
  for (let d = -3; d <= 7; d++) days.push(ymd(shiftDays(today, d)));

  const teamsRaw = await getJson('teams');
  let done = 0;
  const sheets = await Promise.all(days.map(async (day) => {
    const sheet = await getJson(`scoreboard:${day}`).catch((err) => {
      console.warn(`nba scoreboard unavailable for ${day}`, err);
      return null;
    });
    done++;
    onProgress?.(`nba: schedule ${done}/${days.length}`);
    return sheet;
  }));
  const sched = { events: sheets.flatMap((s) => s?.events || []) };

  const teams = new Map();
  for (const sport of teamsRaw.sports || [])
    for (const league of sport.leagues || [])
      for (const entry of league.teams || []) {
        const t = entry.team || entry;
        teams.set(String(t.id), { id: String(t.id), abbr: t.abbreviation, name: t.displayName });
      }

  const seenGame = new Set();
  const games = (sched.events || []).filter((e) => {
    const id = String(e.id);
    if (seenGame.has(id)) return false;
    seenGame.add(id);
    return true;
  }).map((e) => {
    const comp = (e.competitions || [])[0] || {};
    const side = (hw) => (comp.competitors || []).find((x) => x.homeAway === hw) || {};
    const home = side('home');
    const away = side('away');
    const odds = (comp.odds || [])[0] || {};
    const played = comp.status?.type?.completed === true;
    const homeSpread = num(odds.spread) === null ? null : -num(odds.spread); // + = home favoured
    return {
      id: String(e.id),
      day: (e.date || '').slice(0, 10),
      tip: (e.date || '').slice(11, 16),
      awayId: String(away.team?.id ?? ''),
      homeId: String(home.team?.id ?? ''),
      away: away.team?.abbreviation,
      home: home.team?.abbreviation,
      awayName: away.team?.displayName,
      homeName: home.team?.displayName,
      awayScore: played ? num(away.score) : null,
      homeScore: played ? num(home.score) : null,
      played,
      total: num(odds.overUnder),
      homeSpread,
      details: odds.details || '',
      book: odds.provider?.name || '',
      venue: comp.venue?.fullName || '',
    };
  });

  games.sort((a, b) => (a.day + a.tip).localeCompare(b.day + b.tip));
  return { games, teams, fetchedAt: new Date().toISOString() };
}

/* ---------------------------------------------------------------- one game */

/** Everything the model needs for one matchup. Fetched in parallel, all cached on disk. */
export async function loadGame({ slate, game, onProgress } = {}) {
  const teamIds = [game.awayId, game.homeId];
  const step = (t) => onProgress?.(t);

  step('nba: rosters, team form, injuries');
  const [rosters, schedules, teamStatsNow, teamStatsPrior, injuries] = await Promise.all([
    Promise.all(teamIds.map((id) => getJson(`roster:${id}`))),
    Promise.all(teamIds.map((id) => getJson(`teamschedule:${id}`))),
    Promise.all(teamIds.map((id) => getJson(`teamstats:${id}:${NBA_SEASON}`))),
    Promise.all(teamIds.map((id) => getJson(`teamstats:${id}:${NBA_PRIOR}`))),
    getJson('injuries').catch(() => null),
  ]);

  const profiles = new Map();
  teamIds.forEach((id, i) => {
    // Some feeds ignore the season parameter, in which case the "prior" payload is just this
    // season again. Showing that as last year's pace would be a lie, so it is dropped and the
    // baseline falls back to the current season instead.
    const repeatsCurrent =
      teamStatsPrior[i] &&
      JSON.stringify(teamStatsPrior[i]) === JSON.stringify(teamStatsNow[i]);
    profiles.set(id, {
      ...profileFrom(teamStatsNow[i], schedules[i], NBA_SEASON, id),
      prior: repeatsCurrent ? null : profileFrom(teamStatsPrior[i], null, NBA_PRIOR, id),
      form: formFrom(schedules[i], id),
    });
  });

  const rostersByTeam = new Map();
  teamIds.forEach((id, i) => {
    rostersByTeam.set(id, parseRoster(rosters[i]).slice(0, 17));
  });

  const injuryIndex = parseInjuries(injuries);

  // Pass 1: who actually plays right now. Current-season logs are small, so fetch the whole
  // roster; pass 2 asks for last season only for the rotation, which is where the big files are.
  const current = await fetchLogs(teamIds.flatMap((id) => rostersByTeam.get(id)), NBA_SEASON, step, 'nba: current-season logs');
  const rotation = new Map();
  for (const id of teamIds) {
    const list = rostersByTeam.get(id)
      .map((p) => ({ p, log: current.get(p.id) }))
      .sort((a, b) => minutesPerGame(b.log) - minutesPerGame(a.log))
      .slice(0, 12)
      .map((x) => x.p);
    rotation.set(id, list);
  }
  const prior = await fetchLogs(
    teamIds.flatMap((id) => rotation.get(id)),
    NBA_PRIOR,
    step,
    'nba: last-season logs',
  );

  const players = [];
  for (const id of teamIds) {
    for (const p of rotation.get(id)) {
      const nowLog = current.get(p.id) || [];
      const priorLog = prior.get(p.id) || [];
      // A player with no minutes either season is not priceable in any market on the board.
      if (minutesPerGame(priorLog) < 6 && minutesPerGame(nowLog) < 6) continue;
      players.push({
        ...p,
        teamId: id,
        team: slate.teams.get(id)?.abbr || '',
        logs: nowLog,
        priorLogs: priorLog,
        injury: injuryIndex.get(p.id) || null,
      });
    }
  }

  return {
    teams: teamIds.map((id) => ({
      id,
      abbr: slate.teams.get(id)?.abbr,
      name: slate.teams.get(id)?.name,
      profile: profiles.get(id),
      players: players.filter((p) => p.teamId === id),
    })),
    players,
  };
}

async function fetchLogs(players, season, step, label) {
  const out = new Map();
  let done = 0;
  // Small concurrency ceiling: the proxy is single-process and ESPN throttles bursts.
  const queue = players.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        out.set(p.id, parseGamelog(await getJson(`player:${p.id}:${season}`)));
      } catch (err) {
        console.warn(`nba gamelog failed for ${p.name} (${season})`, err);
        out.set(p.id, []);
      }
      done++;
      step(`${label} ${done}/${players.length}`);
    }
  });
  await Promise.all(workers);
  return out;
}

/* -------------------------------------------------------------- team stats */

function statMap(raw) {
  const out = new Map();
  // ESPN serves team statistics in two shapes: the core API nests them under splits,
  // the site API under results.stats. Edge hosts can only reach the site API, so both
  // are read here and the rest of the model never has to care which one it got.
  const categories = raw?.splits?.categories || raw?.results?.stats?.categories || [];
  for (const category of categories)
    for (const s of category.stats || []) out.set(s.name, num(s.value));
  return out;
}

function profileFrom(raw, schedule, season, teamId) {
  const s = statMap(raw);
  const g = (k) => s.get(k) ?? null;
  const form = schedule ? formFrom(schedule, teamId) : null;

  // The site API omits pace, turnover ratio and offensive rebound rate. They are all
  // recoverable from the box-score averages it does publish, using the standard
  // possession estimate: FGA + 0.44*FTA - OREB + TOV.
  const fga = g('avgFieldGoalsAttempted');
  const fgm = g('avgFieldGoalsMade');
  const fta = g('avgFreeThrowsAttempted');
  const oreb = g('avgOffensiveRebounds');
  const tov = g('avgTurnovers');
  const possessions =
    Number.isFinite(fga) && Number.isFinite(tov)
      ? fga + 0.44 * (fta ?? 0) - (oreb ?? 0) + tov
      : null;

  return {
    teamId,
    season,
    games: g('gamesPlayed'),
    pace: g('avgEstimatedPossessions') ?? g('paceFactor') ?? possessions,
    pointsPerGame: g('avgPoints'),
    oppPointsPerGame: form?.oppPointsPerGame ?? null,
    assistsPerGame: g('avgAssists'),
    reboundsPerGame: g('avgRebounds'),
    offReboundRate:
      g('offReboundRate') ??
      (Number.isFinite(fga) && Number.isFinite(fgm) && fga > fgm ? oreb / (fga - fgm) : null),
    defReboundRate: g('defReboundRate'),
    turnoverRatio: g('turnoverRatio') ?? (possessions ? tov / possessions : null),
    threePct: g('threePointPct'),
    threeAttemptRate: (g('avgThreePointFieldGoalsAttempted') && g('avgFieldGoalsAttempted'))
      ? g('avgThreePointFieldGoalsAttempted') / g('avgFieldGoalsAttempted')
      : null,
    fieldGoalPct: g('fieldGoalPct'),
    freeThrowRate: (g('avgFreeThrowsAttempted') && g('avgFieldGoalsAttempted'))
      ? g('avgFreeThrowsAttempted') / g('avgFieldGoalsAttempted')
      : null,
  };
}

/** Results and dates from the team schedule: recent form, rest days and points allowed. */
function formFrom(raw, teamId) {
  const myId = String(teamId ?? raw?.team?.id ?? '');
  const played = [];
  for (const e of raw?.events || []) {
    const comp = (e.competitions || [])[0];
    if (!comp || comp.status?.type?.completed !== true) continue;
    const comps = comp.competitors || [];
    const mine = comps.find((c) => String(c.team?.id ?? c.id) === myId);
    const other = comps.find((c) => c !== mine);
    // Competitor scores are objects here ({"value":121}) and plain strings in game logs.
    const scoreOf = (c) => num(c?.score?.value ?? c?.score);
    const myScore = scoreOf(mine);
    const oppScore = scoreOf(other);
    if (myScore === null || oppScore === null) continue;
    played.push({
      day: (e.date || '').slice(0, 10),
      opponentId: String(other?.team?.id ?? other?.id ?? ''),
      opponent: other?.team?.abbreviation || '',
      forPoints: myScore,
      againstPoints: oppScore,
      home: mine?.homeAway === 'home',
    });
  }
  played.sort((a, b) => a.day.localeCompare(b.day));
  const recent = played.slice(-10);
  const mean = (arr, f) => (arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : null);
  return {
    games: played.length,
    last: played.slice(-12),
    pointsPerGame: mean(recent, (x) => x.forPoints),
    oppPointsPerGame: mean(recent, (x) => x.againstPoints),
    lastDay: played.length ? played[played.length - 1].day : null,
  };
}

/* ------------------------------------------------------------------ players */

function parseRoster(raw) {
  const out = [];
  const seen = new Set();
  for (const a of raw?.athletes || []) {
    const id = String(a.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: a.fullName || a.displayName,
      pos: normalizePos(a.position?.abbreviation || a.position?.name),
      jersey: a.jersey,
      height: a.displayHeight,
      age: num(a.age),
      experience: num(a.experience?.years),
    });
  }
  return out;
}

function normalizePos(p) {
  const v = String(p || '').toUpperCase();
  if (v.startsWith('C')) return 'C';
  if (v.startsWith('F')) return 'F';
  if (v.startsWith('G')) return 'G';
  return 'F';
}

const LOG_STAT_INDEX = {
  minutes: 0, fg: 1, fgPct: 2, tp: 3, tpPct: 4, ft: 5, ftPct: 6,
  reb: 7, ast: 8, blk: 9, stl: 10, fouls: 11, tov: 12, pts: 13,
};

/** Flatten one athlete's game log into rows, newest last, tagging opponent and margin. */
function parseGamelog(raw) {
  const seasonBlocks = raw?.seasonTypes || [];
  const names = raw?.names || raw?.categories?.[0]?.names;
  if (!Array.isArray(names)) {
    // A rookie, or anyone who did not appear in that season, comes back with no season data
    // at all: that is a real answer, not an error. Anything else is a parse failure worth
    // seeing, because every number on the board is indexed off these column names.
    if (!seasonBlocks.length) return [];
    throw new Error('nba gamelog: stat names missing');
  }
  const idx = new Map(names.map((n, i) => [n, i]));
  const at = (stats, name) => {
    const i = idx.get(name);
    return i === undefined ? null : num(stats[i]);
  };
  const rawAt = (stats, name) => {
    const i = idx.get(name);
    return i === undefined ? '' : stats[i];
  };
  const rows = [];
  const meta = raw?.events || {};
  for (const seasonBlock of seasonBlocks) {
    for (const category of seasonBlock.categories || []) {
      // Preseason and playoff games are not the same animal: rotations, minutes limits and
      // pace all differ, and mixing them in corrupts the minutes model in October.
      if (/preseason|postseason|playoff/i.test(String(category.displayName || ''))) continue;
      for (const entry of category.events || []) {
        const m = meta[entry.eventId] || {};
        const stats = entry.stats || [];
        const min = at(stats, 'minutes');
        if (min === null) continue;
        const [fgm, fga] = madeAtt(rawAt(stats, 'fieldGoalsMade-fieldGoalsAttempted'));
        const [tpm, tpa] = madeAtt(rawAt(stats, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
        const [ftm, fta] = madeAtt(rawAt(stats, 'freeThrowsMade-freeThrowsAttempted'));
        rows.push({
          eventId: String(entry.eventId),
          day: (m.gameDate || '').slice(0, 10),
          opponentId: String(m.opponent?.id ?? ''),
          opponent: m.opponent?.abbreviation || '',
          home: m.atVs === 'vs',
          min,
          pts: at(stats, 'points') ?? 0,
          reb: at(stats, 'totalRebounds') ?? 0,
          ast: at(stats, 'assists') ?? 0,
          stl: at(stats, 'steals') ?? 0,
          blk: at(stats, 'blocks') ?? 0,
          tov: at(stats, 'turnovers') ?? 0,
          fouls: at(stats, 'fouls') ?? 0,
          fgm, fga, tpm, tpa, ftm, fta,
          result: m.gameResult || null,
          teamScore: num(m.homeTeamScore),
          oppScore: num(m.awayTeamScore),
          seasonType: seasonBlock.displayName || '',
        });
      }
    }
  }
  rows.sort((a, b) => a.day.localeCompare(b.day));
  return rows;
}

export function minutesPerGame(rows) {
  if (!rows || !rows.length) return 0;
  const recent = rows.slice(-12);
  return recent.reduce((s, r) => s + r.min, 0) / recent.length;
}

function parseInjuries(raw) {
  const out = new Map();
  for (const block of raw?.injuries || []) {
    for (const entry of block.injuries || []) {
      const id = String(entry.athlete?.id ?? '');
      if (!id) continue;
      const status = String(entry.status || '').toLowerCase();
      out.set(id, {
        status: entry.status || '',
        injury: entry.details?.type || entry.type?.description || entry.athlete?.injuries?.[0]?.type?.description || '',
        comment: (entry.longComment || '').slice(0, 400),
        teamId: String(block.id ?? ''),
        playProb: status === 'out' ? 0.02 : status.includes('day') ? 0.62 : 0.97,
      });
    }
  }
  return out;
}
