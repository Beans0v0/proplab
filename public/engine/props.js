/**
 * Market definitions, standard prop ladders, and the scoring rules.
 *
 * Two ideas here matter more than the rest of the app:
 *
 * 1. LINES COME FROM A STANDARD LADDER, not from the model. If we invented a line
 *    from our own projection, P(over) would sit at ~50% by construction and ranking
 *    by probability would be meaningless. Restricting to the lines a book would
 *    actually post keeps the probability honest and comparable across players.
 *
 * 2. THE RANKING LINE IS "THE WORST LINE STILL CLEARED AT YOUR THRESHOLD".
 *    Sorting by raw P(over) just surfaces trivial lines (over 9.5 receiving yards).
 *    Instead we ask: for this player and market, what is the highest standard line
 *    he still clears X% of the time? That is an actionable number, and it is the
 *    thing that can be compared to a price at your book.
 */

import { clamp } from './math.js';

// `unit` exists so the UI can say "1.8 TDs" instead of a bare "1.8": a number
// next to another number with no label is the single most confusing thing on the board.
export const MARKETS = [
  { id: 'pass_yds', label: 'Passing yards', unit: 'yards', stat: 'passYds', pos: ['QB'], inc: 25, minLine: 99.5, decimals: 0, kind: 'yards', family: 'passing' },
  { id: 'pass_tds', label: 'Passing TDs', unit: 'TDs', stat: 'passTds', pos: ['QB'], inc: 0.5, minLine: 0.5, decimals: 1, kind: 'count', family: 'passing' },
  { id: 'ints', label: 'Interceptions', unit: 'INTs', stat: 'ints', pos: ['QB'], inc: 0.5, minLine: 0.5, decimals: 1, kind: 'count', family: 'passing' },
  { id: 'pass_att', label: 'Pass attempts', unit: 'attempts', stat: 'attempts', pos: ['QB'], inc: 1, minLine: 14.5, decimals: 1, kind: 'count', family: 'passing' },
  { id: 'rush_yds', label: 'Rushing yards', unit: 'yards', stat: 'rushYds', pos: ['RB', 'QB', 'WR', 'TE'], inc: 5, minLine: 4.5, decimals: 0, kind: 'yards', family: 'rushing' },
  { id: 'carries', label: 'Rush attempts', unit: 'carries', stat: 'carries', pos: ['RB', 'QB'], inc: 0.5, minLine: 1.5, decimals: 1, kind: 'count', family: 'rushing' },
  { id: 'receptions', label: 'Receptions', unit: 'catches', stat: 'rec', pos: ['WR', 'TE', 'RB'], inc: 1, minLine: 0.5, decimals: 1, kind: 'count', family: 'receiving' },
  { id: 'rec_yds', label: 'Receiving yards', unit: 'yards', stat: 'recYds', pos: ['WR', 'TE', 'RB'], inc: 5, minLine: 4.5, decimals: 0, kind: 'yards', family: 'receiving' },
  { id: 'anytime_td', label: 'Anytime TD', unit: 'TDs', stat: 'totalTds', pos: ['RB', 'WR', 'TE'], inc: 1, minLine: 0.5, decimals: 1, kind: 'count', family: 'scoring', anytime: true },
  { id: 'fg_made', label: 'Field goals made', unit: 'field goals', stat: 'fgMade', pos: ['K'], inc: 0.5, minLine: 0.5, decimals: 1, kind: 'count', family: 'kicking' },
];

export const MARKET_BY_ID = new Map(MARKETS.map((m) => [m.id, m]));

/** Standard lines a book would post, anchored near the projection. */
export function ladderFor(market, mu, { span = 5 } = {}) {
  // Books post yardage in round numbers minus a half (249.5, 44.5) and counting
  // stats at the half point (5.5 receptions), so anchor the ladder the same way.
  const anchor = market.inc > 1
    ? Math.floor(mu / market.inc) * market.inc - 0.5
    : Math.floor(mu / market.inc) * market.inc + 0.5;
  const lines = [];
  for (let k = -span; k <= span; k++) {
    const line = +(anchor + k * market.inc).toFixed(2);
    if (line >= market.minLine) lines.push(line);
  }
  return lines;
}

export function pOverSamples(samples, line) {
  let hits = 0;
  for (let i = 0; i < samples.length; i++) if (samples[i] > line) hits++;
  return hits / samples.length;
}

export function pUnderSamples(samples, line) {
  let hits = 0;
  for (let i = 0; i < samples.length; i++) if (samples[i] < line) hits++;
  return hits / samples.length;
}

/**
 * Same as thresholdLine, but evaluated on a shifted distribution.
 * Used for the naive baseline: shifting every outcome by `shift` is equivalent to
 * asking for P(v > line + shift), so no array copy is needed.
 */
export function thresholdLineShifted(ladder, values, threshold, shift = 0) {
  // shifted outcomes are v + shift, so P(v + shift > line) = P(v > line - shift)
  let best = null;
  for (const line of ladder) {
    let hits = 0;
    for (let i = 0; i < values.length; i++) if (values[i] > line - shift) hits++;
    const p = hits / values.length;
    if (p >= threshold) best = { line, p };
    else if (best) break;
  }
  if (best) return best;
  let hits = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > ladder[0] - shift) hits++;
  return { line: ladder[0], p: hits / values.length, belowThreshold: true };
}

/** Highest standard line still cleared at `threshold` of the simulated outcomes. */
export function thresholdLine(ladder, samples, threshold) {
  let best = null;
  for (const line of ladder) {
    const p = pOverSamples(samples, line);
    if (p >= threshold) best = { line, p };
    else if (best) break; // ladder is increasing; once we miss we are done
  }
  if (best) return best;
  const line = ladder[0];
  return { line, p: pOverSamples(samples, line), belowThreshold: true };
}

/** American odds that break even at probability p. This is the "fair price". */
export function fairOdds(p) {
  const x = clamp(p, 0.001, 0.999);
  if (x >= 0.5) return Math.round(-100 * (x / (1 - x)));
  return Math.round(100 * ((1 - x) / x));
}

export function formatOdds(p) {
  const o = fairOdds(p);
  return o > 0 ? `+${o}` : `${o}`;
}

/** Implied probability from American odds (what a book's price means). */
export function impliedFromAmerican(american) {
  const a = Number(american);
  if (!Number.isFinite(a)) return NaN;
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

/**
 * Confidence is about how much to trust the number, not how likely the bet is.
 * Components are deliberately visible in the UI so the tier is not a black box.
 */
export function confidenceFor({ games, shareCv, statCv, availabilityP, samplePrior }) {
  const sample = clamp(games / 8, 0, 1);
  const role = clamp(1 - shareCv, 0, 1);
  const stability = clamp(1 - statCv * 0.6, 0, 1);
  const avail = clamp(availabilityP, 0, 1);
  const prior = samplePrior === undefined ? 1 : clamp(samplePrior, 0, 1);
  const score = 100 * (0.3 * sample + 0.28 * role + 0.22 * stability + 0.15 * avail + 0.05 * prior);
  let tier = 'D';
  if (score >= 80) tier = 'A';
  else if (score >= 68) tier = 'B';
  else if (score >= 55) tier = 'C';
  return {
    score: Math.round(score),
    tier,
    parts: { sample, role, stability, avail, prior },
  };
}

export const CONFIDENCE_NOTE = {
  A: 'Deep sample, stable role, healthy. Trust the number.',
  B: 'Solid sample and role. Normal uncertainty.',
  C: 'Thin sample or shaky role. Treat as a lean.',
  D: 'Too little data or too much volatility to trust.',
};
