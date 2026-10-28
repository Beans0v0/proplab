/**
 * Walk-forward calibration.
 *
 * A probability engine that has never been scored is just a confident opinion.
 * For each completed week we rebuild the board using ONLY information available
 * before that week (the engine's cutoff does this by construction), take the line
 * it would have recommended at your threshold, and check what actually happened.
 *
 * Output is a reliability table: when the board says 65%, how often did it hit?
 * Plus a Brier score, which is the proper scoring rule for probability forecasts
 * (mean squared error of the probability; lower is better; 0.25 = always saying 50%).
 */

import { buildBoard, DEFAULT_SETTINGS } from './board.js';
import { MARKET_BY_ID, thresholdLine, ladderFor, pOverSamples } from './props.js';
import { mean } from './math.js';

export const BACKTEST_DEFAULT_SIMS = 1000;

export async function runBacktest({
  data,
  season,
  settings = {},
  onProgress = () => {},
  shouldStop = () => false,
  sims = BACKTEST_DEFAULT_SIMS,
  minGames = 3,
  minPlayProb = 0.9,
  maxPropsPerGame = 45,
  weeks = null,
} = {}) {
  const completed = data.completedWeeks(season).filter((w) => w >= 3);
  const targetWeeks = weeks ?? completed;
  const seasonIdx = data.seasons.get(season);
  const rows = [];
  let gamesDone = 0;
  const totalGames = targetWeeks.reduce((s, w) => s + data.games(season, w).length, 0);

  for (const week of targetWeeks) {
    if (shouldStop()) break;
    for (const game of data.games(season, week)) {
      if (shouldStop()) break;
      if (!game.played) continue;

      let board;
      try {
        board = buildBoard({
          data,
          game,
          settings: { ...DEFAULT_SETTINGS, ...settings, sims, usePrior: settings.usePrior ?? true },
        });
      } catch (err) {
        onProgress({ gamesDone, totalGames, error: String(err) });
        continue;
      }

      const candidates = board.props
        .filter((p) => p.played >= sims * 0.5)
        .filter((p) => p.confidence.parts.avail >= minPlayProb)
        .filter((p) => playerGames(seasonIdx, p.playerId, week) >= minGames)
        .slice(0, maxPropsPerGame);

      for (const prop of candidates) {
        const actual = actualStat(seasonIdx, prop.playerId, week, MARKET_BY_ID.get(prop.market));
        if (actual === null) continue; // did not play: cannot score
        const line = prop.threshold.line;
        rows.push({
          week,
          market: prop.market,
          marketLabel: prop.marketLabel,
          predicted: prop.threshold.prob,
          line,
          actual,
          hit: actual > line ? 1 : 0,
        });
      }

      gamesDone++;
      onProgress({ gamesDone, totalGames, week });
      await maybeYield();
    }
  }

  return summarize(rows, { season, weeks: targetWeeks, gamesDone, sims });
}

/**
 * Yield to the UI, but only when there is reason to.
 *
 * Yielding once per game looked harmless and was not: a backgrounded browser tab
 * clamps setTimeout to roughly one per second, so 75 games spent 75 seconds doing
 * nothing. Waiting on elapsed time instead keeps progress painting while never
 * paying the timer tax more than a few times in a run.
 */
let lastYield = 0;
async function maybeYield() {
  const now = performance.now();
  if (now - lastYield < 40) return;
  lastYield = now;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function playerGames(seasonIdx, playerId, week) {
  const p = seasonIdx.playersById.get(playerId);
  if (!p) return 0;
  return p.weeks.filter((w) => w.week < week && (w.targets + w.carries + w.attempts) > 0).length;
}

function actualStat(seasonIdx, playerId, week, market) {
  const p = seasonIdx.playersById.get(playerId);
  if (!p) return null;
  const w = p.weeks.find((x) => x.week === week);
  if (!w) return null;
  if (market.stat === 'totalTds') return w.recTds + w.rushTds;
  return w[market.stat] ?? null;
}

export function summarize(rows, meta = {}) {
  if (!rows.length) return { rows: [], n: 0, meta };
  const n = rows.length;
  const brier = mean(rows.map((r) => (r.predicted - r.hit) ** 2));
  const avgPredicted = mean(rows.map((r) => r.predicted));
  const hitRate = mean(rows.map((r) => r.hit));

  const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const inBucket = rows.filter((r) => r.predicted >= lo && r.predicted < hi);
    if (!inBucket.length) continue;
    const p = mean(inBucket.map((r) => r.predicted));
    const hit = mean(inBucket.map((r) => r.hit));
    buckets.push({
      label: `${Math.round(lo * 100)}-${Math.round(Math.min(hi, 1) * 100)}%`,
      lo,
      hi,
      n: inBucket.length,
      predicted: p,
      actual: hit,
      error: hit - p,
      se: Math.sqrt((p * (1 - p)) / inBucket.length),
    });
  }

  const byMarket = new Map();
  for (const r of rows) {
    if (!byMarket.has(r.market)) byMarket.set(r.market, []);
    byMarket.get(r.market).push(r);
  }
  const markets = [...byMarket.entries()].map(([id, rs]) => ({
    id,
    label: rs[0].marketLabel,
    n: rs.length,
    predicted: mean(rs.map((r) => r.predicted)),
    actual: mean(rs.map((r) => r.hit)),
    brier: mean(rs.map((r) => (r.predicted - r.hit) ** 2)),
  })).sort((a, b) => b.n - a.n);

  const byWeek = new Map();
  for (const r of rows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week).push(r);
  }
  const perWeek = [...byWeek.entries()].map(([week, rs]) => ({
    week,
    n: rs.length,
    predicted: mean(rs.map((r) => r.predicted)),
    actual: mean(rs.map((r) => r.hit)),
  })).sort((a, b) => a.week - b.week);

  return {
    rows,
    n,
    brier,
    avgPredicted,
    hitRate,
    calibrationError: hitRate - avgPredicted,
    buckets,
    markets,
    perWeek,
    meta,
  };
}

/** Score a specific set of lines after the fact (used by the player detail view). */
export function scoreLines(samples, line) {
  return { pOver: pOverSamples(samples, line) };
}

export { ladderFor, thresholdLine };
