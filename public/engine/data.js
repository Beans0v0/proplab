/**
 * Data layer: loads nflverse open data through the local proxy and builds the
 * season indexes the projection engine needs.
 *
 * Everything here is real, published data (nflverse, CC-BY-4.0):
 *   games.csv          -> schedules, spreads, totals, roof/temp/wind, rest, coaches, divisional flag
 *   stats_player_week  -> per-player weekly box score (targets, carries, EPA, air yards, ...)
 *   stats_team_week    -> per-team weekly offense; opponent rows give us defense-allowed by inversion
 *   snap_counts        -> offensive snap share (role stability)
 *   injuries           -> practice/game status (Out / Doubtful / Questionable)
 *
 * Deliberate design choice: defense-allowed is *derived by inversion* (team A's
 * offense in a game IS what team B's defense allowed that week). That avoids
 * scraping a second source and keeps offense/defense perfectly reconciled.
 */

import { parseCsv } from './csv.js';

export const CURRENT_SEASON = 2026;

const GAME_COLS = [
  'game_id', 'season', 'game_type', 'week', 'gameday', 'gametime',
  'away_team', 'away_score', 'home_team', 'home_score', 'total', 'overtime',
  'away_rest', 'home_rest', 'spread_line', 'total_line', 'div_game', 'roof',
  'surface', 'temp', 'wind', 'away_qb_name', 'home_qb_name', 'away_coach',
  'home_coach', 'referee', 'stadium',
];
const GAME_NUM = ['season', 'week', 'away_score', 'home_score', 'total', 'away_rest',
  'home_rest', 'spread_line', 'total_line', 'div_game', 'temp', 'wind'];

const PLAYER_COLS = [
  'player_id', 'player_name', 'player_display_name', 'position', 'position_group',
  'headshot_url', 'season', 'week', 'season_type', 'game_id', 'team', 'opponent_team',
  'completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions',
  'sacks_suffered', 'passing_air_yards', 'passing_epa', 'carries', 'rushing_yards',
  'rushing_tds', 'rushing_epa', 'receptions', 'targets', 'receiving_yards',
  'receiving_tds', 'receiving_air_yards', 'receiving_epa', 'target_share',
  'air_yards_share', 'special_teams_tds', 'fg_made', 'fg_att', 'fantasy_points_ppr',
];
const PLAYER_NUM = ['season', 'week', 'completions', 'attempts', 'passing_yards',
  'passing_tds', 'passing_interceptions', 'sacks_suffered', 'passing_air_yards',
  'passing_epa', 'carries', 'rushing_yards', 'rushing_tds', 'rushing_epa',
  'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'receiving_air_yards',
  'receiving_epa', 'target_share', 'air_yards_share', 'special_teams_tds',
  'fg_made', 'fg_att', 'fantasy_points_ppr'];

const TEAM_COLS = [
  'season', 'week', 'team', 'season_type', 'game_id', 'opponent_team', 'attempts',
  'completions', 'passing_yards', 'passing_tds', 'passing_interceptions',
  'sacks_suffered', 'passing_epa', 'carries', 'rushing_yards', 'rushing_tds',
  'rushing_epa', 'targets', 'receptions', 'receiving_yards', 'receiving_tds',
  'passing_first_downs', 'rushing_first_downs', 'punt_returns', 'punt_return_yards',
  'kickoff_returns', 'kickoff_return_yards', 'fg_made', 'fg_att', 'fg_pct',
  'pt_att', 'pt_yards', 'pt_net_yards', 'def_sacks', 'def_interceptions',
  'def_tds', 'special_teams_tds', 'penalties', 'penalty_yards',
];
const TEAM_NUM = ['season', 'week', 'attempts', 'completions', 'passing_yards',
  'passing_tds', 'passing_interceptions', 'sacks_suffered', 'passing_epa', 'carries',
  'rushing_yards', 'rushing_tds', 'rushing_epa', 'targets', 'receptions',
  'receiving_yards', 'receiving_tds', 'passing_first_downs', 'rushing_first_downs',
  'punt_returns', 'punt_return_yards', 'kickoff_returns', 'kickoff_return_yards',
  'fg_made', 'fg_att', 'fg_pct', 'pt_att', 'pt_yards', 'pt_net_yards', 'def_sacks',
  'def_interceptions', 'def_tds', 'special_teams_tds', 'penalties', 'penalty_yards'];

const SNAP_COLS = ['season', 'week', 'player', 'position', 'team', 'opponent', 'offense_pct', 'offense_snaps', 'st_pct'];
const SNAP_NUM = ['season', 'week', 'offense_pct', 'offense_snaps', 'st_pct'];

const INJ_COLS = ['season', 'game_type', 'team', 'week', 'gsis_id', 'position', 'full_name',
  'report_primary_injury', 'report_status', 'practice_status'];
const INJ_NUM = ['season', 'week'];

/** Player-facing team metadata. */
export const TEAM_NAMES = {
  ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers',
  CHI: 'Bears', CIN: 'Bengals', CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos',
  DET: 'Lions', GB: 'Packers', HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars',
  KC: 'Chiefs', LA: 'Rams', LAC: 'Chargers', LV: 'Raiders', MIA: 'Dolphins',
  MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants', NYJ: 'Jets',
  PHI: 'Eagles', PIT: 'Steelers', SEA: 'Seahawks', SF: '49ers', TB: 'Buccaneers',
  TEN: 'Titans', WAS: 'Commanders',
};

async function getCsv(key, columns, numeric) {
  const res = await fetch(`/api/data?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`dataset ${key} failed (${res.status})`);
  const text = await res.text();
  return parseCsv(text, columns, { numeric });
}

/**
 * Loads one season. `withPrior` also loads season-1 to stabilise early-season rates.
 */
export async function loadSeason(season, { withPrior = true, onProgress = () => {} } = {}) {
  const seasons = withPrior ? [season, season - 1] : [season];
  const jobs = [];
  onProgress('schedules');
  jobs.push(getCsv('games', GAME_COLS, GAME_NUM));

  for (const s of seasons) {
    onProgress(`week ${s} player lines`);
    jobs.push(getCsv(`player_${s}`, PLAYER_COLS, PLAYER_NUM));
    jobs.push(getCsv(`team_${s}`, TEAM_COLS, TEAM_NUM));
    onProgress(`week ${s} snap counts`);
    jobs.push(getCsv(`snaps_${s}`, SNAP_COLS, SNAP_NUM));
    onProgress(`week ${s} injury report`);
    jobs.push(getCsv(`inj_${s}`, INJ_COLS, INJ_NUM));
  }

  const results = await Promise.all(jobs);
  const gamesRaw = results[0];
  const perSeason = [];
  for (let i = 0; i < seasons.length; i++) {
    const o = 1 + i * 4;
    perSeason.push({
      season: seasons[i],
      players: results[o],
      teams: results[o + 1],
      snaps: results[o + 2],
      injuries: results[o + 3],
    });
  }

  return buildIndex({ gamesRaw, perSeason, season });
}

function buildIndex({ gamesRaw, perSeason, season }) {
  const gamesBySeason = new Map(); // season -> Map<week, Game[]>
  {
    const g = gamesRaw;
    for (let i = 0; i < g.n; i++) {
      if (g.col('game_type')[i] !== 'REG') continue;
      const s = g.col('season')[i];
      const week = g.col('week')[i];
      const game = {
        id: g.col('game_id')[i],
        season: s,
        week,
        gameday: g.col('gameday')[i],
        gametime: g.col('gametime')[i],
        away: g.col('away_team')[i],
        home: g.col('home_team')[i],
        awayScore: g.col('away_score')[i],
        homeScore: g.col('home_score')[i],
        spread: g.col('spread_line')[i],      // home margin; + means home favoured
        total: g.col('total_line')[i],
        div: g.col('div_game')[i] === 1,
        roof: (g.col('roof')[i] || '').replace(/"/g, ''),
        surface: (g.col('surface')[i] || '').replace(/"/g, ''),
        temp: g.col('temp')[i],
        wind: g.col('wind')[i],
        awayRest: g.col('away_rest')[i],
        homeRest: g.col('home_rest')[i],
        awayCoach: g.col('away_coach')[i],
        homeCoach: g.col('home_coach')[i],
        awayQb: g.col('away_qb_name')[i],
        homeQb: g.col('home_qb_name')[i],
        referee: g.col('referee')[i],
        stadium: g.col('stadium')[i],
        played: Number.isFinite(g.col('home_score')[i]) && Number.isFinite(g.col('away_score')[i]),
      };
      if (!gamesBySeason.has(s)) gamesBySeason.set(s, new Map());
      const byWeek = gamesBySeason.get(s);
      if (!byWeek.has(week)) byWeek.set(week, []);
      byWeek.get(week).push(game);
    }
  }

  const seasonIndex = new Map();
  for (const block of perSeason) {
    seasonIndex.set(block.season, indexSeason(block));
  }

  return {
    season,
    gamesBySeason,
    seasons: seasonIndex,
    weeks(seasonYear) {
      const byWeek = gamesBySeason.get(seasonYear) || new Map();
      return [...byWeek.keys()].sort((a, b) => a - b);
    },
    completedWeeks(seasonYear) {
      const byWeek = gamesBySeason.get(seasonYear) || new Map();
      return [...byWeek.entries()]
        .filter(([, gs]) => gs.some((g) => g.played))
        .map(([w]) => w)
        .sort((a, b) => a - b);
    },
    games(seasonYear, week) {
      return (gamesBySeason.get(seasonYear) || new Map()).get(week) || [];
    },
  };
}

function indexSeason({ season, players, teams, snaps, injuries }) {
  // ---- team-week offense rows, keyed for fast inversion -------------------
  const teamRowsByGame = new Map(); // `${game_id}|${team}` -> row
  const teamWeeks = new Map();      // team -> [row]
  for (let i = 0; i < teams.n; i++) {
    const row = {
      season: teams.col('season')[i],
      week: teams.col('week')[i],
      team: teams.col('team')[i],
      opp: teams.col('opponent_team')[i],
      gameId: teams.col('game_id')[i],
      passAtt: teams.col('attempts')[i],
      completions: teams.col('completions')[i],
      passYds: teams.col('passing_yards')[i],
      passTds: teams.col('passing_tds')[i],
      passInts: teams.col('passing_interceptions')[i],
      sacks: teams.col('sacks_suffered')[i],
      // offensive plays = dropbacks + runs; the engine treats pace off this field
      plays: (teams.col('attempts')[i] || 0) + (teams.col('carries')[i] || 0) + (teams.col('sacks_suffered')[i] || 0),
      passEpa: teams.col('passing_epa')[i],
      carries: teams.col('carries')[i],
      rushYds: teams.col('rushing_yards')[i],
      rushTds: teams.col('rushing_tds')[i],
      rushEpa: teams.col('rushing_epa')[i],
      targets: teams.col('targets')[i],
      recYds: teams.col('receiving_yards')[i],
      stTds: teams.col('special_teams_tds')[i],
      puntRetYds: teams.col('punt_return_yards')[i],
      kickRetYds: teams.col('kickoff_return_yards')[i],
      fgAtt: teams.col('fg_att')[i],
      fgMade: teams.col('fg_made')[i],
      ptAtt: teams.col('pt_att')[i],
      ptNet: teams.col('pt_net_yards')[i],
      defSacks: teams.col('def_sacks')[i],
      defInts: teams.col('def_interceptions')[i],
      defTds: teams.col('def_tds')[i],
      penalties: teams.col('penalties')[i],
    };
    teamRowsByGame.set(`${row.gameId}|${row.team}`, row);
    if (!teamWeeks.has(row.team)) teamWeeks.set(row.team, []);
    teamWeeks.get(row.team).push(row);
  }

  // Invert: what a defense allowed IS the opponent's offensive row in the same game.
  const allowedByTeam = new Map(); // team -> [allowed row] (aligned by week)
  for (const [, row] of teamRowsByGame) {
    const oppRow = teamRowsByGame.get(`${row.gameId}|${row.opp}`);
    if (!oppRow) continue;
    if (!allowedByTeam.has(row.team)) allowedByTeam.set(row.team, []);
    allowedByTeam.get(row.team).push({ ...oppRow, week: row.week, opp: row.team });
  }

  // ---- player weekly lines ------------------------------------------------
  const playersById = new Map();
  for (let i = 0; i < players.n; i++) {
    const id = players.col('player_id')[i];
    const week = players.col('week')[i];
    if (players.col('season_type')[i] !== 'REG') continue;
    let p = playersById.get(id);
    if (!p) {
      p = {
        id,
        name: players.col('player_display_name')[i] || players.col('player_name')[i],
        pos: players.col('position')[i],
        group: players.col('position_group')[i],
        headshot: players.col('headshot_url')[i],
        weeks: [],
      };
      playersById.set(id, p);
    }
    p.weeks.push({
      week,
      team: players.col('team')[i],
      opp: players.col('opponent_team')[i],
      gameId: players.col('game_id')[i],
      completions: num(players.col('completions')[i]),
      attempts: num(players.col('attempts')[i]),
      passYds: num(players.col('passing_yards')[i]),
      passTds: num(players.col('passing_tds')[i]),
      ints: num(players.col('passing_interceptions')[i]),
      sacks: num(players.col('sacks_suffered')[i]),
      passEpa: num(players.col('passing_epa')[i]),
      carries: num(players.col('carries')[i]),
      rushYds: num(players.col('rushing_yards')[i]),
      rushTds: num(players.col('rushing_tds')[i]),
      targets: num(players.col('targets')[i]),
      rec: num(players.col('receptions')[i]),
      recYds: num(players.col('receiving_yards')[i]),
      recTds: num(players.col('receiving_tds')[i]),
      airYds: num(players.col('receiving_air_yards')[i]),
      recEpa: num(players.col('receiving_epa')[i]),
      stTds: num(players.col('special_teams_tds')[i]),
      fgMade: num(players.col('fg_made')[i]),
      fgAtt: num(players.col('fg_att')[i]),
    });
  }
  for (const p of playersById.values()) p.weeks.sort((a, b) => a.week - b.week);

  // ---- snap share by player+week -----------------------------------------
  const snapByPlayerWeek = new Map(); // id -> Map<week, pct>
  for (let i = 0; i < snaps.n; i++) {
    const name = snaps.col('player')[i];
    if (!name) continue;
    const week = snaps.col('week')[i];
    const pct = snaps.col('offense_pct')[i];
    if (!snapByPlayerWeek.has(name)) snapByPlayerWeek.set(name, new Map());
    snapByPlayerWeek.get(name).set(week, pct);
  }

  // ---- injuries by player+week -------------------------------------------
  const injuryByPlayerWeek = new Map(); // id -> Map<week, {status, practice, injury}>
  const injuriesByTeamWeek = new Map(); // `${team}|${week}` -> [entry]
  for (let i = 0; i < injuries.n; i++) {
    const id = injuries.col('gsis_id')[i];
    const week = injuries.col('week')[i];
    const entry = {
      id,
      name: injuries.col('full_name')[i],
      pos: injuries.col('position')[i],
      team: injuries.col('team')[i],
      week,
      status: (injuries.col('report_status')[i] || '').trim(),
      practice: (injuries.col('practice_status')[i] || '').trim(),
      injury: (injuries.col('report_primary_injury')[i] || '').trim(),
    };
    if (!id) continue;
    if (!injuryByPlayerWeek.has(id)) injuryByPlayerWeek.set(id, new Map());
    injuryByPlayerWeek.get(id).set(week, entry);
    const key = `${entry.team}|${week}`;
    if (!injuriesByTeamWeek.has(key)) injuriesByTeamWeek.set(key, []);
    injuriesByTeamWeek.get(key).push(entry);
  }

  return {
    season,
    playersById,
    teamWeeks,
    allowedByTeam,
    snapByPlayerWeek,
    injuryByPlayerWeek,
    injuriesByTeamWeek,
    playerByName: buildNameIndex(playersById),
  };
}

function buildNameIndex(playersById) {
  const m = new Map();
  for (const p of playersById.values()) {
    m.set(p.name.toLowerCase(), p);
    m.set(p.name.toLowerCase().replace(/[^a-z ]/g, ''), p);
  }
  return m;
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

/** Find a player record by name (used to reconcile snap-count names with player ids). */
export function snapPctFor(seasonIndex, player, week, nameIndex) {
  const byName = seasonIndex.snapByPlayerWeek.get(player.name);
  if (byName) {
    const v = byName.get(week);
    if (Number.isFinite(v)) return v;
  }
  return null;
}
