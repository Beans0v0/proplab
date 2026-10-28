/**
 * Seeded RNG + the distributions the simulator draws from.
 *
 * Deterministic by design: the same game + settings must always produce the same
 * board, otherwise a "probability" you looked at five minutes ago is unfalsifiable.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const base = mulberry32(h);
  let spare = null;

  function gauss(mu = 0, sd = 1) {
    if (spare !== null) { const s = spare; spare = null; return mu + sd * s; }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = base() * 2 - 1;
      v = base() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return mu + sd * u * mul;
  }

  /** Marsaglia-Tsang gamma. shape>0, scale>0, mean = shape*scale. */
  function gamma(shape, scale = 1) {
    if (!(shape > 0)) return 0;
    if (shape < 1) {
      const u = Math.max(base(), 1e-12);
      return gamma(shape + 1, scale) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = gauss();
      const v = 1 + c * x;
      if (v <= 0) continue;
      const v3 = v * v * v;
      const u = Math.max(base(), 1e-12);
      if (u < 1 - 0.0331 * x * x * x * x) return d * v3 * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) return d * v3 * scale;
    }
  }

  function beta(a, b) {
    const x = gamma(a, 1);
    const y = gamma(b, 1);
    return x + y <= 0 ? 0.5 : x / (x + y);
  }

  /**
   * Poisson-binomial over `n` trials. Accepts a fractional n so that a projected
   * 5.4 targets behaves like 5 or 6 targets, which matters at low volumes.
   */
  function binomial(n, p) {
    if (!(p > 0)) return 0;
    if (p >= 1) return Math.round(n);
    const whole = Math.floor(n);
    let count = 0;
    for (let i = 0; i < whole; i++) if (base() < p) count++;
    if (base() < n - whole && base() < p) count++;
    return count;
  }

  /** Overdispersed count: mean mu, variance mu*disp (disp=1 => Poisson). */
  function overdispersedCount(mu, disp) {
    if (!(mu > 0)) return 0;
    const d = Math.max(disp, 1.0001);
    return Math.round(gamma(mu / d, d));
  }

  /** Multiplicative noise with median ~1, used for efficiency rates. */
  function rateNoise(sd) {
    return Math.exp(gauss(0, sd) - (sd * sd) / 2);
  }

  return { rng: base, gauss, gamma, beta, binomial, overdispersedCount, rateNoise };
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const sum = (a) => a.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
export const mean = (a) => (a.length ? sum(a) / a.length : 0);

export function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) * (x - m))) / (a.length - 1));
}

/** Exponentially weighted stats: recent games matter more. */
export function weightedStats(pairs, decayPerWeek, refWeek) {
  let wsum = 0;
  let msum = 0;
  const vals = [];
  const weights = [];
  for (const { week, value } of pairs) {
    if (!Number.isFinite(value)) continue;
    const w = Math.exp(-decayPerWeek * Math.max(0, refWeek - week));
    wsum += w;
    msum += w * value;
    vals.push(value);
    weights.push(w);
  }
  if (wsum === 0) return { mean: 0, n: 0, values: [], weights: [] };
  const m = msum / wsum;
  let vsum = 0;
  for (let i = 0; i < vals.length; i++) vsum += weights[i] * (vals[i] - m) * (vals[i] - m);
  const variance = vals.length > 1 ? vsum / (wsum * (1 - 1 / Math.max(vals.length, 2))) : 0;
  return { mean: m, n: vals.length, variance, values: vals, weights };
}

/**
 * Shrink an observed rate toward a prior. k = strength of the prior in "games".
 * This is the single most important guard against small-sample nonsense: a
 * 2-game sample cannot move a projection far from the positional baseline.
 */
export function shrink(observed, games, prior, k) {
  if (!Number.isFinite(observed) || games <= 0) return prior;
  const w = games / (games + k);
  return w * observed + (1 - w) * prior;
}

/** Blend a current-season figure with last season, weighting down as sample grows. */
export function blendPrior(current, prior, games, baseWeight = 0.25) {
  if (!Number.isFinite(prior)) return current;
  const w = baseWeight * Math.exp(-games / 6);
  return (1 - w) * current + w * prior;
}

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function cv(values) {
  const m = mean(values);
  if (m <= 0) return 1;
  return sd(values) / m;
}
