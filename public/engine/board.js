/**
 * Board assembly: one game in, a ranked prop board out.
 *
 * Ranking rule (the important bit):
 *   For every player x market, we take the STANDARD line ladder and ask what the
 *   highest line is that he still clears at your chosen probability threshold.
 *   Props are then ranked by that probability.
 *
 *   Ranking by raw probability at an arbitrary line is meaningless - it just finds
 *   the most trivial bet on the board ("over 4.5 receiving yards", 97%). Asking
 *   "what is the worst line he clears 65% of the time" produces a number you can
 *   actually compare against a price at your book, and it makes players comparable
 *   across markets.
 */

import { mean, sd, quantile, clamp } from './math.js';
import { leaguePriors, buildTeamProfile, buildPointsTable } from './model.js';
import { projectTeamPlayers, weatherEffect } from './players.js';
import { simulateGame } from './sim.js';
import {
  MARKETS, MARKET_BY_ID, ladderFor, pOverSamples, thresholdLine,
  thresholdLineShifted, confidenceFor, fairOdds,
} from './props.js';

export const DEFAULT_SETTINGS = {
  threshold: 0.65,
  sims: 6000,
  usePrior: true,
  weather: null,             // { wind, temp, isDome, known, manual }
  availabilityOverrides: {},  // playerId -> 'OUT' | 'DOUBTFUL' | 'QUESTIONABLE' | 'ACTIVE'
};

export function buildBoard({ data, game, settings: rawSettings = {} }) {
  const settings = { ...DEFAULT_SETTINGS, ...rawSettings, sim: { sims: rawSettings.sims ?? DEFAULT_SETTINGS.sims } };
  const seasonIdx = data.seasons.get(game.season);
  const priorIdx = settings.usePrior ? data.seasons.get(game.season - 1) : null;
  const cutoffWeek = game.week;

  const pointsTable = buildPointsTable(data, game.season, cutoffWeek);
  const league = leaguePriors(seasonIdx, cutoffWeek, [game.home, game.away]);
  const ptsVals = [...pointsTable.entries()]
    .filter(([t]) => t !== game.home && t !== game.away)
    .map(([, v]) => v.for);
  league.pointsPerGame = ptsVals.length ? mean(ptsVals) : 22;
  league.totalPerGame = league.pointsPerGame * 2;

  const profiles = {
    home: buildTeamProfile(seasonIdx, priorIdx, game.home, cutoffWeek, league, pointsTable),
    away: buildTeamProfile(seasonIdx, priorIdx, game.away, cutoffWeek, league, pointsTable),
  };

  const env = buildEnvironment({ game, profiles, league, settings });

  const homePlayers = projectTeamPlayers({
    seasonIdx, priorIdx, cutoffWeek, team: game.home, profile: profiles.home,
    opp: profiles.away, league, env, settings,
  });
  const awayPlayers = projectTeamPlayers({
    seasonIdx, priorIdx, cutoffWeek, team: game.away, profile: profiles.away,
    opp: profiles.home, league, env, settings,
  });
  const players = [...homePlayers, ...awayPlayers];

  const sim = simulateGame({
    players,
    profiles,
    env,
    settings,
    seed: `${game.id}|${settings.sims}|${settings.weather?.wind ?? ''}|${settings.weather?.temp ?? ''}`,
  });

  const props = [];
  for (const player of players) {
    const arrs = sim.samples.get(player.id);
    // A ruled-out player still has a handful of playing iterations, and a
    // probability computed from those would top the board with a number no book
    // would post. Require a quarter of the simulations to have him on the field.
    if ((sim.playCounts.get(player.id) || 0) < sim.n * 0.25) continue;

    for (const marketId of player.markets) {
      const market = MARKET_BY_ID.get(marketId);
      const samples = arrs[market.stat];
      if (!samples) continue;

      const prop = buildProp({ player, market, samples, sim, settings });
      if (prop) props.push(prop);
    }
  }

  const teamProps = buildTeamProps({ sim, env, profiles, settings, game });

  props.sort((a, b) => (b.threshold.prob - a.threshold.prob) || (b.confidence.score - a.confidence.score));

  return {
    game,
    season: game.season,
    week: game.week,
    env,
    league,
    profiles,
    players,
    props,
    teamProps,
    settings,
    simMeta: {
      sims: settings.sims,
      seed: `${game.id}|${settings.sims}`,
      cutoffWeek,
      gamesUsedPerTeam: { home: profiles.home.games, away: profiles.away.games },
    },
    notes: buildNotes({ game, env, league, seasonIdx }),
  };
}

// ------------------------------------------------------------------ environment

function buildEnvironment({ game, profiles, league, settings }) {
  const home = profiles.home;
  const away = profiles.away;

  // Model-based fallback when the market has not posted a line yet.
  const homeEst = (home.off.pointsPerGame + away.def.pointsAllowedPerGame) / 2;
  const awayEst = (away.off.pointsPerGame + home.def.pointsAllowedPerGame) / 2;
  const hasMarket = Number.isFinite(game.total) && Number.isFinite(game.spread);

  const total = hasMarket ? game.total : (homeEst + awayEst + league.totalPerGame) / 2;
  const spread = hasMarket ? game.spread : (homeEst - awayEst) * 0.5;

  const stHome = clamp((home.idx.st - 1) * 0.35, -0.8, 0.8);
  const stAway = clamp((away.idx.st - 1) * 0.35, -0.8, 0.8);
  const homeImplied = Math.max(6, total / 2 + spread / 2 + stHome);
  const awayImplied = Math.max(6, total - total / 2 - spread / 2 + stAway);

  const roof = (game.roof || '').toLowerCase();
  const isDome = roof.includes('dome') || roof.includes('closed');
  let weather;
  if (settings.weather) {
    weather = { ...settings.weather, known: true, manual: true, isDome: settings.weather.isDome ?? isDome };
  } else if (Number.isFinite(game.temp) || Number.isFinite(game.wind)) {
    weather = { wind: game.wind ?? 0, temp: game.temp ?? 60, isDome, known: true, manual: false };
  } else {
    weather = { wind: null, temp: null, isDome, known: false, manual: false };
  }

  return {
    total: Math.round(total * 2) / 2,
    spread,
    market: hasMarket ? 'posted' : 'model estimate (no line yet)',
    homeImplied,
    awayImplied,
    implied: { home: homeImplied, away: awayImplied },
    margin: { home: spread, away: -spread },
    side: { [game.home]: 'home', [game.away]: 'away' },
    leagueTotal: league.totalPerGame,
    leagueImplied: league.pointsPerGame,
    divGame: !!game.div,
    rest: { home: game.homeRest, away: game.awayRest },
    roof: game.roof,
    surface: game.surface,
    weather,
    stAdjust: { home: stHome, away: stAway },
    coaches: { home: game.homeCoach, away: game.awayCoach },
    referee: game.referee,
    stadium: game.stadium,
    kickoff: `${game.gameday} ${game.gametime || ''}`.trim(),
    stEffect: weatherEffect(weather),
  };
}

// ----------------------------------------------------------------- single prop

function buildProp({ player, market, samples, sim, settings }) {
  const n = sim.n;
  const mask = sim.playMask.get(player.id);

  // Condition on the player actually being on the field. Books void a prop when a
  // player is scratched, so mixing in his DNQ games would understate the price.
  const playing = [];
  for (let i = 0; i < n; i++) if (mask[i]) playing.push(samples[i]);
  const played = playing.length;

  const mu = mean(playing);
  if (!(mu > 0)) return null;

  const sorted = [...playing].sort((a, b) => a - b);
  const ladder = ladderFor(market, mu);
  const pByLine = ladder.map((line) => ({ line, pOver: pOverSamples(playing, line) }));
  for (let i = 0; i < ladder.length; i++) pByLine[i].pUnder = 1 - pByLine[i].pOver;

  const thr = thresholdLine(ladder, playing, settings.threshold);

  // Naive comparison: same distribution, shifted so its mean equals the player's
  // raw season average. Answers "what would just his average have suggested?"
  const statKey = market.stat === 'totalTds' ? 'totalTds' : market.stat;
  const naiveMean = player.naive?.[statKey];
  let naive = null;
  let naiveShift = null;
  if (Number.isFinite(naiveMean) && naiveMean > 0) {
    naiveShift = naiveMean - mu;
    naive = thresholdLineShifted(ladder, playing, settings.threshold, naiveShift);
    naive = { ...naive, mean: naiveMean };
  }

  const statCv = mu > 0 ? sd(playing) / mu : 1;
  // Role stability must be measured on the resource the market actually depends
  // on: a quarterback has no target share, and scoring his role on one docked
  // every passing prop a confidence tier for no reason.
  let shareCv;
  if (market.family === 'passing') shareCv = player.usage.attemptsCv;
  else if (market.family === 'rushing') shareCv = player.usage.carryShareCv;
  else if (market.family === 'receiving') shareCv = player.usage.targetShareCv;
  else if (market.family === 'kicking') shareCv = 0.3; // starting kicker volume treated as stable; a benching is not modelled
  else shareCv = Math.min(player.usage.carryShareCv, player.usage.targetShareCv);
  const confidence = confidenceFor({
    games: player.games,
    shareCv: Math.min(Number.isFinite(shareCv) ? shareCv : 0.9, 1),
    statCv: Math.min(statCv, 1.5),
    availabilityP: player.availability.p,
  });

  const bands = [0.1, 0.25, 0.5, 0.75, 0.9].map((q) => quantile(sorted, q));

  return {
    id: `${player.id}:${market.id}`,
    playerId: player.id,
    player: player.name,
    pos: player.pos,
    team: player.team,
    opp: player.opp,
    side: player.side,
    headshot: player.headshot,
    market: market.id,
    marketLabel: market.label,
    family: market.family,
    decimals: market.decimals,
    projection: mu,
    median: quantile(sorted, 0.5),
    sd: sd(playing),
    bands: { p10: bands[0], p25: bands[1], p50: bands[2], p75: bands[3], p90: bands[4] },
    histogram: histogram(sorted, market),
    ladder: pByLine,
    threshold: { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold },
    fair: fairOdds(thr.p),
    naive,
    naiveShift,
    statKey,
    _samples: playing,
    linePremium: naive ? +(thr.line - naive.line).toFixed(2) : null,
    confidence,
    games: player.games,
    playProb: player.availability.p,
    played,
    flags: player.flags,
    factors: player.factors,
    usage: player.usage,
    snapPct: player.snapPct,
    availability: player.availability,
    teamVol: player.volume.teamVol,
  };
}

function histogram(sorted, market) {
  const lo = quantile(sorted, 0.005);
  const hi = quantile(sorted, 0.995);
  const bins = 26;
  const width = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of sorted) {
    const idx = clamp(Math.floor((v - lo) / width), 0, bins - 1);
    counts[idx]++;
  }
  const total = sorted.length || 1;
  return { lo, hi, width, density: counts.map((c) => c / total), decimals: market.decimals };
}

// ---------------------------------------------------------------- team totals

function buildTeamProps({ sim, env, profiles, settings, game }) {
  const out = [];
  for (const side of ['home', 'away']) {
    const team = side === 'home' ? game.home : game.away;
    const samples = sim.teamTotals[side];
    const mu = mean(Array.from(samples));
    const inc = 1;
    const anchor = Math.floor(mu / inc) + 0.5;
    const ladder = [];
    for (let k = -6; k <= 6; k++) ladder.push(+(anchor + k * inc).toFixed(1));
    const thr = thresholdLine(ladder, samples, settings.threshold);
    const sorted = Array.from(samples).sort((a, b) => a - b);
    out.push({
      team,
      side,
      label: `${team} team total`,
      projection: mu,
      median: quantile(sorted, 0.5),
      sd: sd(Array.from(samples)),
      implied: env.implied[side],
      ladder: ladder.map((line) => ({ line, pOver: pOverSamples(samples, line), pUnder: 1 - pOverSamples(samples, line) })),
      threshold: { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold },
      _samples: samples,
      fair: fairOdds(thr.p),
      histogram: histogram(sorted, { decimals: 0 }),
      unit: 'points',
    });
  }
  return out;
}

/**
 * Re-derive every recommended line at a new probability threshold.
 * Reuses the stored simulated samples, so moving the slider is O(props x ladder)
 * instead of another Monte Carlo run. Probabilities stay stable while you explore,
 * which is the whole point of seeding the RNG.
 */
export function rethreshold(board, threshold) {
  board.settings = { ...board.settings, threshold };

  for (const prop of board.props) {
    const lines = prop.ladder.map((l) => l.line);
    const thr = thresholdLine(lines, prop._samples, threshold);
    prop.threshold = { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold };
    prop.fair = fairOdds(thr.p);

    if (Number.isFinite(prop.naiveShift)) {
      const nv = thresholdLineShifted(lines, prop._samples, threshold, prop.naiveShift);
      prop.naive = { ...prop.naive, line: nv.line, prob: nv.p };
      prop.linePremium = +(prop.threshold.line - nv.line).toFixed(2);
    }
    prop.ladder = prop.ladder.map((entry) => ({
      ...entry,
      pUnder: 1 - entry.pOver,
    }));
  }

  for (const tp of board.teamProps) {
    const lines = tp.ladder.map((l) => l.line);
    const thr = thresholdLine(lines, tp._samples, threshold);
    tp.threshold = { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold };
    tp.fair = fairOdds(thr.p);
  }

  board.props.sort((a, b) => (b.threshold.prob - a.threshold.prob) || (b.confidence.score - a.confidence.score));
  return board;
}

// --------------------------------------------------------------------- notes

function buildNotes({ game, env, league, seasonIdx }) {
  return [
    {
      kind: 'source',
      text: 'Data: nflverse open data (nflverse-data releases, CC-BY-4.0) - weekly player and team box scores, snap counts, injury reports, schedules with closing lines.',
    },
    {
      kind: 'window',
      text: `Projections use regular-season weeks before week ${game.week} of ${game.season} (max 8 games, recency-weighted, shrunk toward positional and league baselines).`,
    },
    {
      kind: 'market',
      text: env.market === 'posted'
        ? `Game context uses the market: total ${env.total}, home spread ${env.spread > 0 ? '+' : ''}${env.spread}.`
        : 'No posted line for this game yet: total and spread are model estimates.',
    },
    {
      kind: 'weather',
      text: env.weather.known
        ? (env.weather.manual
          ? 'Weather is a manual input. The market total already reflects the forecast, so the effect is applied at 60% to avoid double counting.'
          : 'Weather is recorded actual conditions for a played game, applied at full weight.')
        : 'No weather forecast in the dataset for this game, so no weather adjustment is applied. Enter wind/temp manually to include it.',
    },
    {
      kind: 'injury',
      text: 'Injury data covers the target week if released; otherwise the most recent report is used and flagged as stale. Availability is drawn per simulation and probabilities are conditioned on playing. Players expected to miss the game (under 25% play probability) are kept off the board entirely, because a conditional probability for someone who is not playing is not a bet.',
    },
    {
      kind: 'limits',
      text: 'Not modelled: red-zone target/carry splits, offensive line injuries, depth-chart changes, backup-QB-specific effects, and same-game correlation between props. TD rates come from observed TD-per-touch, shrunk hard, because play-by-play red-zone usage is outside this dataset.',
    },
    { kind: 'league', text: `League baselines from ${league.games} team-games: ${league.playsPerGame.toFixed(1)} plays, ${(league.passRate * 100).toFixed(1)}% pass rate, ${league.pointsPerGame.toFixed(1)} points per team.` },
    { kind: 'roster', text: `${seasonIdx.playersById.size} players indexed for ${game.season}.` },
  ];
}
