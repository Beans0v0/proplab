/**
 * NBA Monte Carlo.
 *
 * One iteration is a plausible version of the game, not forty independent coin flips:
 *   - pace and the margin are drawn once and shared by both teams, so a fast game lifts
 *     everyone and a blowout suppresses both sides' minutes;
 *   - minutes are drawn per player around the projection, because in the NBA minutes is
 *     where the variance actually lives;
 *   - points are built the way the box score is (field goals split into twos and threes,
 *     plus free throws) so a quiet shooting night and a heavy-minutes night cannot both
 *     land on the same player at once;
 *   - PRA is the same three draws added together, which is what makes it correlated.
 */

import { makeRng, clamp } from '../math.js';

const DISPERSION = { reb: 1.35, ast: 1.45, stl: 1.6, blk: 1.8, fga: 1.3, fta: 1.35 };

export function simulateNba({ players, env, settings, seed }) {
  const n = settings.sims;
  const rng = makeRng(`nba|${seed}|${n}`);
  const out = new Map();
  for (const p of players) {
    out.set(p.id, { pts: [], reb: [], ast: [], tpm: [], stl: [], blk: [], pra: [], min: [], played: 0 });
  }
  const teamTotals = { home: [], away: [] };

  for (let i = 0; i < n; i++) {
    const paceNoise = clamp(1 + rng.gauss(0, 0.06), 0.8, 1.25);
    const margin = (env.spread || 0) + rng.gauss(0, 12);
    const blow = clamp(1 - 0.012 * Math.max(0, Math.abs(margin) - 9), 0.85, 1);

    for (const p of players) {
      const bucket = out.get(p.id);
      if (rng.rng() >= p.playProb) continue; // priced conditional on playing
      bucket.played++;

      const minutes = clamp(p.minutes * (1 + rng.gauss(0, p.minuteCv)) * blow, 0, 44);
      const scale = minutes * paceNoise;

      // Points the way the box score is built.
      const fga = rng.overdispersedCount(p.rates.fga * scale, DISPERSION.fga);
      const tpa = Math.min(fga, rng.binomial(fga, clamp(p.rates.tpaShare, 0, 1)));
      const tpm = rng.binomial(tpa, clamp(p.rates.threePct * (1 + rng.gauss(0, 0.16)), 0.12, 0.6));
      const twoAtt = Math.max(0, fga - tpa);
      const twoPm = rng.binomial(twoAtt, clamp(p.rates.twoPct * (1 + rng.gauss(0, 0.1)), 0.28, 0.68));
      const fta = rng.overdispersedCount(p.rates.fta * scale, DISPERSION.fta);
      const ftm = rng.binomial(fta, clamp(p.rates.ftPct, 0.5, 0.94));
      const pts = 2 * twoPm + 3 * tpm + ftm;

      const reb = rng.overdispersedCount(p.rates.reb * scale, DISPERSION.reb);
      const ast = rng.overdispersedCount(p.rates.ast * scale, DISPERSION.ast);
      const stl = rng.overdispersedCount(p.rates.stl * scale, DISPERSION.stl);
      const blk = rng.overdispersedCount(p.rates.blk * scale, DISPERSION.blk);

      bucket.pts.push(pts);
      bucket.reb.push(reb);
      bucket.ast.push(ast);
      bucket.tpm.push(tpm);
      bucket.stl.push(stl);
      bucket.blk.push(blk);
      bucket.pra.push(pts + reb + ast);
      bucket.min.push(minutes);
    }

    // Team totals are anchored on the market's implied points with a normal game-to-game
    // spread, rather than summed from twelve players who do not cover the whole rotation.
    if (Number.isFinite(env.implied?.home)) {
      teamTotals.home.push(Math.max(60, env.implied.home + rng.gauss(0, 11)));
      teamTotals.away.push(Math.max(60, env.implied.away + rng.gauss(0, 11)));
    }
  }

  return { out, teamTotals };
}
