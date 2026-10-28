/**
 * Monte Carlo game simulation.
 *
 * Why simulate instead of plugging into a formula? Player props are not one
 * distribution. A receiver's yardage is really catches x yards-per-catch, where
 * catches is binomial on a target count that is itself uncertain. TDs are rarer
 * still and multiply-correlated with volume. Simulating the generative process
 * gets the tails right, and it gives cross-player correlation for free.
 *
 * Two structural choices worth knowing:
 *
 * - Game pace and margin are drawn ONCE per iteration and shared by both teams.
 *   That makes every player in the game move together, which is what actually
 *   happens when a game turns into a shootout or a slog.
 *
 * - Usage noise is normalised across teammates, so target shares compete for the
 *   same 35-ish throws. Without this, every receiver on a team could simultaneously
 *   have a big week, which is not how a game works.
 *
 * Availability is drawn too: a Questionable player is treated as absent in a
 * fraction of iterations, and his probabilities are conditioned on playing, the
 * way a book prices him (a scratch voids the bet rather than losing it).
 */

import { makeRng, clamp } from './math.js';

const SIM_DEFAULTS = {
  sims: 6000,
  marginSd: 13.5,
  totalSd: 13.0,
  gamePaceSd: 0.05,
  teamPaceSd: 0.04,
  // Dispersion calibration. A first walk-forward run on 2026 weeks 4-7 scored
  // 2,332 props at 64.4% predicted against 58.0% actual: the engine was
  // overconfident in every bucket, worst in the volume-driven markets
  // (receptions -14.7pp) while TD and interception markets were already
  // calibrated. That is the signature of distributions that are too narrow, so
  // usage and efficiency noise were widened (shareCv 0.22 -> 0.32, carry
  // dispersion 1.35 -> 1.8, yards CVs up ~20%) and the run was repeated.
  shareCv: 0.32,
  carryDisp: 1.8,
  ypcCv: 0.58,
  ypcatchCv: 0.65,
  ypaCv: 0.25,
};

export function simulateGame({ players, profiles, env, settings, seed }) {
  const cfg = { ...SIM_DEFAULTS, ...(settings.sim ?? {}) };
  const n = cfg.sims;
  const rng = makeRng(`proplab|${seed}|${n}`);

  const byTeam = { home: [], away: [] };
  for (const p of players) byTeam[p.side].push(p);

  // Hoist everything that does not change between iterations.
  const teamVol = {
    home: byTeam.home[0]?.volume.teamVol,
    away: byTeam.away[0]?.volume.teamVol,
  };

  // pre-allocate sample arrays
  const samples = new Map();
  const playCounts = new Map();
  const playMask = new Map();
  for (const p of players) {
    const arrs = {};
    for (const stat of STAT_KEYS) arrs[stat] = new Float32Array(n);
    samples.set(p.id, arrs);
    playCounts.set(p.id, 0);
    playMask.set(p.id, new Uint8Array(n));
  }
  const teamTotals = { home: new Float32Array(n), away: new Float32Array(n) };

  const total = env.total;
  const spread = env.spread;

  for (let i = 0; i < n; i++) {
    const gamePace = 1 + rng.gauss(0, cfg.gamePaceSd);
    const margin = spread + rng.gauss(0, cfg.marginSd);
    const gameTotal = Math.max(20, total + rng.gauss(0, cfg.totalSd));
    teamTotals.home[i] = Math.max(0, gameTotal / 2 + margin / 2);
    teamTotals.away[i] = Math.max(0, gameTotal / 2 - margin / 2);

    for (const side of ['home', 'away']) {
      const profile = profiles[side];
      const tv = teamVol[side];
      if (!tv) continue;

      const idio = 1 + rng.gauss(0, cfg.teamPaceSd);
      const plays = tv.plays * gamePace * idio;

      // Re-derive the pass/run split from the drawn margin: an underdog that is
      // behind throws more than the pre-game expectation.
      const signedMargin = side === 'home' ? margin : -margin;
      const expected = side === 'home' ? spread : -spread;
      const scriptShift = clamp(-signedMargin, -16, 16) * 0.0035 - clamp(-expected, -16, 16) * 0.0035;
      const passRate = clamp(tv.passRate + scriptShift, 0.3, 0.78);
      const dropbacks = plays * passRate;
      const attempts = dropbacks * (1 - profile.off.sackRate);
      const carries = plays * (1 - passRate);

      const roster = byTeam[side];
      const tNoise = usageNoise(roster, 'targetShareAdj', rng, cfg.shareCv);
      const cNoise = usageNoise(roster, 'carryShareAdj', rng, cfg.shareCv);

      for (const p of roster) {
        const arr = samples.get(p.id);
        const plays_ = rng.rng() < p.availability.p;
        if (!plays_) continue;
        playCounts.set(p.id, playCounts.get(p.id) + 1);
        playMask.get(p.id)[i] = 1;

        const v = p.volume;
        const e = p.eff;

        // --- receiving ------------------------------------------------
        if (p.markets.some((m) => ['receptions', 'rec_yds', 'anytime_td'].includes(m))) {
          const targets = Math.max(0, tv.attempts * p.usage.targetShareAdj * tNoise.get(p.id));
          const catchP = clamp(e.catchRate * rateUp(rng, 0.10), 0.05, 0.95);
          const catches = rng.binomial(targets, catchP);
          const ypc = Math.max(0, e.ydsPerCatch * rng.rateNoise(cfg.ypcatchCv));
          arr.rec[i] = catches;
          arr.recYds[i] = catches * ypc;
          arr.recTds[i] = rng.binomial(catches, clamp(e.tdPerCatch * rateUp(rng, 0.18), 0, 0.6));
        }

        // --- rushing ---------------------------------------------------
        if (p.markets.some((m) => ['carries', 'rush_yds', 'anytime_td'].includes(m))) {
          const carryMu = Math.max(0.05, tv.carries * p.usage.carryShareAdj * cNoise.get(p.id));
          const c = rng.overdispersedCount(carryMu, cfg.carryDisp);
          arr.carries[i] = c;
          arr.rushYds[i] = c * Math.max(0, e.ypc * rng.rateNoise(cfg.ypcCv));
          arr.rushTds[i] = rng.binomial(c, clamp(e.tdPerCarry * rateUp(rng, 0.22), 0, 0.5));
        }

        // --- passing ---------------------------------------------------
        if (p.pos === 'QB') {
          const share = tv.attempts > 0 ? Math.min(1, v.attempts / tv.attempts) : 0.9;
          const att = Math.max(0, attempts * share * rateUp(rng, 0.12));
          const ypa = Math.max(0, e.ypa * rng.rateNoise(cfg.ypaCv));
          arr.attempts[i] = att;
          arr.passYds[i] = att * ypa;
          arr.passTds[i] = rng.binomial(att, clamp(e.tdPerAtt * rateUp(rng, 0.2), 0, 0.3));
          arr.ints[i] = rng.binomial(att, clamp(e.intPerAtt * rateUp(rng, 0.35), 0, 0.2));
        }

        // --- kicking ---------------------------------------------------
        if (p.pos === 'K') {
          const fgAtt = rng.overdispersedCount(Math.max(0.1, v.fgAtt ?? 1.8), 1.2);
          arr.fgMade[i] = rng.binomial(fgAtt, clamp(e.fgPct * rateUp(rng, 0.12), 0.4, 0.99));
        }

        arr.totalTds[i] = arr.recTds[i] + arr.rushTds[i];
      }
    }
  }

  return { samples, playCounts, playMask, teamTotals, n };
}

export const STAT_KEYS = [
  'rec', 'recYds', 'recTds', 'carries', 'rushYds', 'rushTds',
  'attempts', 'passYds', 'passTds', 'ints', 'fgMade', 'totalTds',
];

/**
 * Multiplicative usage noise, rescaled so the team's total share is preserved.
 * This converts "who eats this week" into negative correlation between teammates.
 */
function usageNoise(roster, key, rng, cv) {
  const out = new Map();
  let raw = 0;
  let base = 0;
  for (const p of roster) {
    const share = p.usage[key] ?? 0;
    const noise = Math.max(0.05, 1 + rng.gauss(0, cv));
    out.set(p.id, noise);
    raw += share * noise;
    base += share;
  }
  const scale = raw > 0 && base > 0 ? base / raw : 1;
  for (const p of roster) out.set(p.id, (out.get(p.id) ?? 1) * scale);
  return out;
}

function rateUp(rng, sd) {
  return Math.exp(rng.gauss(0, sd) - (sd * sd) / 2);
}
