/**
 * Assemble an NBA game board.
 *
 * Emits exactly the prop shape the existing UI renders (same fields the NFL board
 * produces), which is what lets the board, the top-picks panel, the drawer, the
 * confidence tiers and the fair-price column work for basketball without a second UI.
 */

import { ladderFor, thresholdLine, thresholdLineShifted, pOverSamples, confidenceFor } from '../props.js';
import { clamp, mean, sd, quantile, cv } from '../math.js';
import { NBA_MARKETS, NBA_MARKET_BY_ID } from './markets.js';
import { simulateNba } from './sim.js';
import { buildEnv, leagueBaseline, positionalRates, projectPlayer } from './model.js';
import { NBA_SEASON, NBA_PRIOR } from './data.js';

export const NBA_DEFAULT_SETTINGS = { threshold: 0.65, sims: 6000 };

const seasonLabel = (year) => `${year - 1}-${String(year).slice(2)}`;

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

export function buildNbaBoard({ game, teams, settings = NBA_DEFAULT_SETTINGS }) {
  const baseline = leagueBaseline(teams.map((t) => t.profile));
  const env = buildEnv({ game, teams, baseline });
  const posRates = positionalRates(teams.flatMap((t) => t.players));

  // ---- projections ----------------------------------------------------------------
  const rows = [];
  for (const team of teams) {
    const opp = teams.find((x) => x.id !== team.id) || team;
    const side = team.abbr === game.home ? 'home' : 'away';
    for (const player of team.players) {
      const proj = projectPlayer({
        player: { ...player, side },
        profile: team.profile,
        oppProfile: opp.profile,
        env,
        baseline,
        posRates,
      });
      rows.push({ player, team, side, proj });
    }
  }

  // ---- simulation -----------------------------------------------------------------
  const simPlayers = rows.map((r) => ({
    id: r.player.id,
    minutes: r.proj.minutes,
    minuteCv: clamp(r.proj.minuteSd / Math.max(r.proj.minutes, 1), 0.1, 0.5),
    playProb: r.proj.availability.p,
    // per-minute rates: the simulator multiplies by the minutes it draws
    rates: r.proj.perMinute,
  }));
  const sim = simulateNba({
    players: simPlayers,
    env,
    settings,
    seed: `${game.id}|${settings.sims}|${NBA_SEASON}`,
  });

  // ---- props ----------------------------------------------------------------------
  const props = [];
  for (const r of rows) {
    const bucket = sim.out.get(r.player.id);
    if (!bucket || bucket.played < settings.sims * 0.25) continue; // not worth pricing
    const opp = game.away === r.team.abbr ? game.home : game.away;
    for (const market of NBA_MARKETS) {
      const drawn = bucket[market.id];
      if (!drawn || drawn.length < 200) continue;
      const samples = Float64Array.from(drawn);
      const mu = mean(drawn);
      if (!Number.isFinite(mu) || mu <= 0.05) continue;
      // A market where he has no realistic line at all is noise on a 170-row board:
      // nobody needs to read "over 0.5 blocks at 6%" for a point guard.
      if (mu < market.minLine * 0.5) continue;

      const ladder = ladderFor(market, mu, { span: market.id === 'pra' ? 6 : 5 });
      const thr = thresholdLine(ladder, samples, settings.threshold);
      const sorted = Array.from(samples).sort((a, b) => a - b);
      const statCv = mu > 0 ? sd(samples) / mu : 1;

      const naiveMean = r.proj.naiveStat?.[market.id];
      let naive = null;
      if (Number.isFinite(naiveMean) && naiveMean > 0) {
        const nv = thresholdLineShifted(ladder, samples, settings.threshold, naiveMean - mu);
        naive = { ...nv, mean: naiveMean };
      }

      const conf = confidenceFor({
        games: r.proj.metrics.gamesNow + r.proj.metrics.gamesPrior * 0.5,
        shareCv: r.proj.metrics.minutesCv,
        statCv,
        availabilityP: r.proj.availability.p,
        samplePrior: r.proj.metrics.gamesPrior > 20 ? 1 : 0.6,
      });

      props.push({
        sport: 'nba',
        id: `${r.player.id}|${market.id}`,
        playerId: r.player.id,
        player: r.player.name,
        pos: r.player.pos,
        team: r.team.abbr,
        opp,
        market: market.id,
        marketLabel: market.label,
        unit: market.unit,
        family: market.family,
        decimals: market.decimals,
        statKey: market.id,
        projection: mu,
        median: quantile(sorted, 0.5),
        sd: sd(samples),
        ladder: ladder.map((line) => ({ line, pOver: pOverSamples(samples, line), pUnder: 1 - pOverSamples(samples, line) })),
        threshold: { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold },
        _samples: samples,
        naive,
        naiveShift: naive ? naiveMean - mu : null,
        linePremium: naive ? +(thr.line - naive.line).toFixed(2) : null,
        histogram: histogram(sorted, market),
        confidence: conf,
        flags: r.proj.flags,
        factors: r.proj.factors,
        availability: r.proj.availability,
        playProb: r.proj.availability.p,
        minutes: r.proj.minutes,
        minutesSd: r.proj.minuteSd,
        usage: {},
        usageRows: usageRowsFor(r, env),
        snapPct: null,
        teamVol: null,
        games: r.proj.metrics.gamesNow,
        gamesPrior: r.proj.metrics.gamesPrior,
        sims: settings.sims,
      });
    }
  }
  props.sort((a, b) => b.threshold.prob - a.threshold.prob);

  // ---- team totals (a real market, anchored on the posted number) -----------------
  const teamProps = ['home', 'away'].map((side) => {
    const abbr = side === 'home' ? game.home : game.away;
    const samples = sim.teamTotals[side];
    const mu = mean(samples);
    const anchor = Math.floor(mu) + 0.5;
    const ladder = [];
    for (let k = -6; k <= 6; k++) ladder.push(+(anchor + k).toFixed(1));
    const thr = thresholdLine(ladder, samples, settings.threshold);
    const sorted = Array.from(samples).sort((a, b) => a - b);
    return {
      team: abbr,
      side,
      label: `${abbr} team total`,
      projection: mu,
      median: quantile(sorted, 0.5),
      sd: sd(samples),
      implied: env.implied?.[side] ?? null,
      ladder: ladder.map((line) => ({ line, pOver: pOverSamples(samples, line), pUnder: 1 - pOverSamples(samples, line) })),
      threshold: { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold },
      histogram: histogram(sorted, { decimals: 0 }),
      _samples: Float64Array.from(samples),
    };
  });

  return {
    sport: 'nba',
    season: seasonLabel(NBA_SEASON),
    priorSeason: seasonLabel(NBA_PRIOR),
    week: null,
    game: {
      id: game.id,
      away: game.away,
      home: game.home,
      awayName: game.awayName,
      homeName: game.homeName,
      gameday: game.day,
      gametime: game.tip,
      played: game.played,
      awayScore: game.awayScore,
      homeScore: game.homeScore,
      day: game.day,
    },
    env: {
      ...env,
      roof: env.venue ? 'arena' : '',
      kickoff: `${game.day} ${game.tip}`,
      awayImplied: env.implied?.away ?? null,
      homeImplied: env.implied?.home ?? null,
      divGame: false,
    },
    envRows: envRowsFor(game, env, teams, baseline),
    profileRows: profileRowsFor(teams, baseline),
    matchupRows: matchupRowsFor(teams),
    noteRows: injuryRowsFor(teams),
    props,
    teamProps,
    settings,
    notes: notesFor({ game, env, settings, props, baseline }),
  };
}

/** Slider moves reuse the stored samples, exactly like the NFL board does. */
export function rethresholdNba(board, threshold) {
  board.settings = { ...board.settings, threshold };
  const apply = (item, markets) => {
    const market = markets.find((m) => m.id === item.market);
    if (!market || !item._samples) return;
    const ladder = ladderFor(market, mean(item._samples), { span: market.id === 'pra' ? 6 : 5 });
    const thr = thresholdLine(ladder, item._samples, threshold);
    item.ladder = ladder.map((line) => ({ line, pOver: pOverSamples(item._samples, line), pUnder: 1 - pOverSamples(item._samples, line) }));
    item.threshold = { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold };
    if (item.naive && Number.isFinite(item.naiveShift)) {
      const nv = thresholdLineShifted(ladder, item._samples, threshold, item.naiveShift);
      item.naive = { ...item.naive, line: nv.line, prob: nv.p };
      item.linePremium = +(item.threshold.line - nv.line).toFixed(2);
    }
  };
  for (const p of board.props) apply(p, NBA_MARKETS);
  for (const t of board.teamProps) {
    if (!t._samples) continue;
    const mu = mean(t._samples);
    const anchor = Math.floor(mu) + 0.5;
    const ladder = [];
    for (let k = -6; k <= 6; k++) ladder.push(+(anchor + k).toFixed(1));
    const thr = thresholdLine(ladder, t._samples, threshold);
    t.ladder = ladder.map((line) => ({ line, pOver: pOverSamples(t._samples, line), pUnder: 1 - pOverSamples(t._samples, line) }));
    t.threshold = { line: thr.line, prob: thr.p, belowThreshold: !!thr.belowThreshold };
  }
  return board;
}

/* ------------------------------------------------------------------- display */

function usageRowsFor(r, env) {
  const m = r.proj.metrics;
  const rows = [
    { k: 'Projected minutes', v: `${r.proj.minutes.toFixed(1)} min` },
    { k: 'Minutes swing', v: `±${r.proj.minuteSd.toFixed(1)} min` },
    { k: 'Usage per game', v: `${r.proj.usage.usagePerGame.toFixed(1)} (FGA + 0.44·FTA + TOV)` },
    { k: 'Three-point rate', v: `${(r.proj.usage.threePct * 100).toFixed(1)}% on ${(r.proj.usage.tpaShare * 100).toFixed(0)}% of his shots` },
    { k: 'Rest', v: m.rest === null || m.rest === undefined ? '—' : `${m.rest} day${m.rest === 1 ? '' : 's'}` },
    { k: 'Team pace', v: `${m.pace.toFixed(1)} possessions` },
    { k: 'Games of data', v: `${m.gamesNow} this season · ${m.gamesPrior} last season` },
  ];
  if (Number.isFinite(env.implied?.home)) rows.push({ k: 'Team implied points', v: r.side === 'home' ? `${env.implied.home.toFixed(1)}` : `${env.implied.away.toFixed(1)}` });
  return rows;
}

function envRowsFor(game, env, teams, baseline) {
  const [away, home] = teams;
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  return [
    ['Tip-off', `${game.day} ${game.tip}${game.venue ? ` · ${game.venue}` : ''}`],
    ['Market', env.market],
    ['Rest', `${env.rest.away ?? '—'}d vs ${env.rest.home ?? '—'}d`],
    ['Pace (possessions)', `${fmt(env.pace)} vs ${fmt(baseline.pace)} baseline`],
    ['Points / game', `${fmt(away.profile.pointsPerGame)} vs ${fmt(home.profile.pointsPerGame)}`],
    ['Points allowed', `${fmt(away.profile.oppPointsPerGame)} vs ${fmt(home.profile.oppPointsPerGame)}`],
    ['Assists / game', `${fmt(away.profile.assistsPerGame)} vs ${fmt(home.profile.assistsPerGame)}`],
    ['Rebounds / game', `${fmt(away.profile.reboundsPerGame)} vs ${fmt(home.profile.reboundsPerGame)}`],
  ];
}

function profileRowsFor(teams, baseline) {
  const [away, home] = teams;
  const idx = (v, base) => (Number.isFinite(v) && Number.isFinite(base) && base > 0 ? v / base : 1);
  const def = (p) => [
    ['Pace', p.pace, baseline.pace],
    ['Scoring', p.pointsPerGame, baseline.pointsPerGame],
    ['Defence (points allowed)', p.oppPointsPerGame, baseline.oppPointsPerGame],
    ['Rebounding', p.reboundsPerGame, baseline.reboundsPerGame],
    ['Playmaking', p.assistsPerGame, baseline.assistsPerGame],
    ['Three-point rate', p.threeAttemptRate, baseline.threeAttemptRate ?? away.profile.threeAttemptRate],
    ['Turnovers', p.turnoverRatio, baseline.turnoverRatio],
  ];
  return def(away.profile).map(([label, a, base], i) => ({
    label,
    awayIdx: idx(a, base),
    homeIdx: idx(def(home.profile)[i][1], base),
  }));
}

function matchupRowsFor(teams) {
  const [away, home] = teams;
  const rows = [
    ['Games played', (p) => p.games, 0],
    ['Points per game', (p) => p.pointsPerGame, 1],
    ['Points allowed per game', (p) => p.oppPointsPerGame, 1],
    ['Pace (possessions)', (p) => p.pace, 1],
    ['Assists per game', (p) => p.assistsPerGame, 1],
    ['Rebounds per game', (p) => p.reboundsPerGame, 1],
    ['Offensive rebound rate', (p) => p.offReboundRate, 3],
    ['Defensive rebound rate', (p) => p.defReboundRate, 3],
    ['Turnover ratio', (p) => p.turnoverRatio, 3],
    ['Three-point rate (attempts/FGA)', (p) => p.threeAttemptRate, 3],
    ['Field goal %', (p) => p.fieldGoalPct, 3],
  ];
  const prior = [
    ['Last season: points per game', (p) => p.prior?.pointsPerGame, 1],
    ['Last season: pace', (p) => p.prior?.pace, 1],
    ['Last season: games', (p) => p.prior?.games, 0],
  ];
  return rows.concat(prior).map(([label, get, d]) => ({
    label,
    away: get(away.profile),
    home: get(home.profile),
    decimals: d,
  }));
}

function injuryRowsFor(teams) {
  return teams.map((t) => ({
    team: t.abbr,
    players: t.players
      .filter((p) => p.injury)
      .map((p) => ({ name: p.name, status: p.injury.status, injury: p.injury.injury, playProb: p.injury.playProb })),
  }));
}

function notesFor({ game, env, settings, props, baseline }) {
  const notes = [
    { kind: 'source', text: 'ESPN public NBA feeds (scoreboard, rosters, team schedule, team and player statistics, injury report), proxied by Server.java and cached on disk. No API key.' },
    { kind: 'seasons', text: `Current season is ${seasonLabel(NBA_SEASON)} — only a few games old — so last season (${seasonLabel(NBA_PRIOR)}) carries the prior for minutes and rates.` },
    { kind: 'baseline', text: 'Pace, scoring, rebounding and turnover baselines are this matchup\'s two teams, used as ratios rather than as league averages.' },
    { kind: 'market', text: `Lines come from the market: ${env.market || 'no posted total available'}.` },
    { kind: 'model', text: 'Every projection is minutes × rate per minute. Minutes are recency-weighted this season, shrunk toward the positional baseline, and adjusted for the blowout script and back-to-backs.' },
    { kind: 'limits', text: 'No lineup-aware minutes model: a surprise starter or a mid-game injury is not anticipated. Three-point defence and assists allowed are not modelled per opponent. No prop prices are available, so the board shows probabilities and break-even prices, not edges.' },
    { kind: 'threshold', text: `Recommended lines are the highest standard line that clears your ${Math.round(settings.threshold * 100)}% floor, on ladders a book actually posts.` },
  ];
  const thin = props.filter((p) => p.games < 4).length;
  if (thin) notes.push({ kind: 'sample', text: `${thin} props rest on fewer than 4 games this season; their confidence tier says so.` });
  return notes;
}
