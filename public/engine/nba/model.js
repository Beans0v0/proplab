/**
 * NBA projection model.
 *
 * The NFL side decomposes a stat into opportunities x rate per opportunity, because a
 * receiver's target share persists. Basketball's equivalent is simpler and more brutal:
 *   stat = minutes x rate per minute
 * and minutes is the thing that actually decides your bet. Foul trouble, a blowout, a
 * back-to-back, a coach's whim - the NBA has no snap counts to stabilise usage, so the
 * minutes model gets the most care and every adjustment is printed with its multiplier.
 */

import { clamp, mean, sd, weightedStats, shrink, blendPrior, cv } from '../math.js';

const DAY_MS = 86400000;

export function daysBetween(fromDay, toDay) {
  if (!fromDay || !toDay) return null;
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * Reference values. These come from the two teams' own prior seasons, and are only ever
 * used as ratios (this team vs that baseline), which keeps the model honest about the fact
 * that it is not fetching league-wide pace or ratings.
 */
export function leagueBaseline(profiles) {
  const pick = (fn) => {
    const vals = profiles.map(fn).filter((v) => Number.isFinite(v) && v > 0);
    return vals.length ? mean(vals) : null;
  };
  return {
    pace: pick((p) => p.prior?.pace ?? p.pace),
    pointsPerGame: pick((p) => p.prior?.pointsPerGame ?? p.pointsPerGame),
    oppPointsPerGame: pick((p) => p.prior?.oppPointsPerGame ?? p.oppPointsPerGame),
    reboundsPerGame: pick((p) => p.prior?.reboundsPerGame ?? p.reboundsPerGame),
    assistsPerGame: pick((p) => p.prior?.assistsPerGame ?? p.assistsPerGame),
    turnoverRatio: pick((p) => p.prior?.turnoverRatio ?? p.turnoverRatio),
  };
}

function restDays(form, gameDay) {
  if (!form?.lastDay) return null;
  return daysBetween(form.lastDay, gameDay);
}

/** Game environment: the market's total and spread, pace, rest, and each side's implied points. */
export function buildEnv({ game, teams, baseline }) {
  const [away, home] = teams;
  const spread = Number.isFinite(game.homeSpread) ? game.homeSpread : 0;
  const total = Number.isFinite(game.total) ? game.total : null;
  const paceVals = [home.profile.pace, away.profile.pace].filter((v) => Number.isFinite(v));
  const pace = paceVals.length ? mean(paceVals) : baseline.pace;
  const rest = {
    home: restDays(home.profile.form, game.day),
    away: restDays(away.profile.form, game.day),
  };
  return {
    day: game.day,
    total,
    spread,
    pace,
    paceIndex: baseline.pace ? clamp(pace / baseline.pace, 0.9, 1.12) : 1,
    implied: total === null
      ? null
      : { home: total / 2 + spread / 2, away: total / 2 - spread / 2 },
    rest,
    // A rest edge shows up in the fourth quarter, not as a per-minute rate; it is applied
    // to the opponent's defensive context rather than to a player's own projection.
    restEdge: {
      home: (rest.home ?? 3) - (rest.away ?? 3),
      away: (rest.away ?? 3) - (rest.home ?? 3),
    },
    market: total === null
      ? 'no posted total'
      : `${game.away} @ ${game.home} · total ${total} · ${game.details || (spread > 0 ? `${game.home} -${spread}` : `${game.away} -${-spread}`)}${game.book ? ` (${game.book})` : ''}`,
    venue: game.venue,
    book: game.book,
  };
}

/** Per-minute rates by position, from the players in this matchup: the shrinkage prior. */
export function positionalRates(players) {
  const keys = ['pts', 'reb', 'ast', 'tpm', 'tpa', 'stl', 'blk', 'fga', 'fta', 'tov'];
  const buckets = new Map();
  for (const p of players) {
    const rows = (p.priorLogs || []).filter((r) => r.min > 0);
    if (rows.length < 10) continue;
    const b = buckets.get(p.pos) || new Map();
    for (const k of keys) {
      const per = rows.map((r) => r[k] / r.min);
      if (!b.has(k)) b.set(k, []);
      b.get(k).push(mean(per));
    }
    buckets.set(p.pos, b);
  }
  const out = new Map();
  for (const [pos, b] of buckets) {
    const rates = {};
    for (const k of keys) rates[k] = mean(b.get(k) || [0]);
    out.set(pos, rates);
  }
  return out;
}

const RATE_KEYS = ['pts', 'reb', 'ast', 'tpm', 'tpa', 'stl', 'blk', 'fga', 'fta', 'tov'];

/** Weighted mean of a per-minute rate over a set of game rows. */
function rateOf(rows, key, day, decay) {
  return weightedStats(
    rows.map((r) => ({ week: Math.max(0, daysBetween(r.day, day) ?? 0) / 7, value: r[key] / Math.max(r.min, 1) })),
    decay,
    0,
  );
}

export function projectPlayer({ player, profile, oppProfile, env, baseline, posRates, decay = 0.9 }) {
  const nowRows = (player.logs || []).filter((r) => r.min > 0 && r.day);
  const priorRows = (player.priorLogs || []).filter((r) => r.min > 0 && r.day);
  const factors = [];
  const flags = [];

  // ---- minutes: recency-weighted this season, anchored by last season -------------
  const minNow = weightedStats(
    nowRows.map((r) => ({ week: Math.max(0, daysBetween(r.day, env.day) ?? 0) / 7, value: r.min })),
    decay,
    0,
  );
  const minPrior = weightedStats(
    priorRows.map((r) => ({ week: Math.max(0, daysBetween(r.day, env.day) ?? 0) / 7, value: r.min })),
    decay,
    0,
  );
  const priorMin = minPrior.n ? minPrior.mean : null;
  let minutes = minNow.n ? blendPrior(minNow.mean, priorMin ?? minNow.mean, minNow.n, 0.5) : priorMin;
  minutes = shrink(minutes ?? priorMin ?? 18, minNow.n + minPrior.n * 0.5, priorMin ?? 18, 3);
  minutes = clamp(minutes, 4, 40);

  factors.push({
    label: 'Minutes',
    kind: 'volume',
    value: 1,
    detail: minNow.n
      ? `${minNow.n} game${minNow.n === 1 ? '' : 's'} this season at ${minNow.mean.toFixed(1)} min, blended with ${priorMin ? `${priorMin.toFixed(1)} min last season` : 'no prior season'}`
      : `no games this season; last season's ${priorMin ? priorMin.toFixed(1) : '—'} min carries it`,
  });

  // Blowout script: a decided game costs the leaders minutes, and it moves both teams.
  const blowMult = clamp(1 - 0.012 * Math.max(0, Math.abs(env.spread) - 9), 0.85, 1);
  if (blowMult < 0.999) {
    minutes *= blowMult;
    factors.push({
      label: 'Blowout script',
      kind: 'volume',
      value: blowMult,
      detail: `market has this at ${Math.abs(env.spread)} points — decided games cut the main minutes`,
    });
    if (Math.abs(env.spread) >= 12 && minutes > 24) {
      flags.push({
        label: 'Blowout risk',
        severity: 'med',
        detail: `a ${Math.abs(env.spread)}-point line means the fourth quarter may not be competitive`,
      });
    }
  }

  // Rest: back-to-backs are the NBA's version of a short week.
  const rest = env.rest?.[player.side] ?? null;
  if (rest !== null && rest <= 1) {
    const mult = player.age && player.age >= 33 ? 0.93 : 0.96;
    minutes *= mult;
    factors.push({
      label: 'Back-to-back',
      kind: 'volume',
      value: mult,
      detail: `played ${rest === 0 ? 'yesterday' : 'the day before'}${player.age ? `, age ${player.age}` : ''}`,
    });
    flags.push({ label: 'Back to back', severity: 'low', detail: 'second game of a back-to-back' });
  }

  const minuteList = nowRows.concat(priorRows).slice(-25).map((r) => r.min);
  const dirNow = mean(nowRows.slice(-4).map((r) => r.min));
  const dirSeason = minNow.n ? minNow.mean : dirNow;
  if (nowRows.length >= 6 && Number.isFinite(dirNow) && dirSeason > 0 && Math.abs(dirNow - dirSeason) / dirSeason > 0.18) {
    flags.push({
      label: dirNow > dirSeason ? 'Minutes trending up' : 'Minutes trending down',
      severity: 'med',
      detail: `last 4 games ${dirNow.toFixed(1)} min vs ${dirSeason.toFixed(1)} min in the window`,
    });
  }
  if (minutes < 15) {
    flags.push({ label: 'Low minutes', severity: 'med', detail: `${minutes.toFixed(1)} projected minutes caps every market` });
  }
  if (nowRows.length + priorRows.length < 5) {
    flags.push({ label: 'Thin sample', severity: 'med', detail: `${nowRows.length + priorRows.length} games of data` });
  }

  // ---- per-minute rates, shrunk toward the positional baseline --------------------
  const posBase = posRates.get(player.pos) || {};
  const priorByKey = {};
  for (const k of RATE_KEYS) {
    const now = rateOf(nowRows, k, env.day, decay);
    const prior = rateOf(priorRows, k, env.day, decay);
    const anchor = Number.isFinite(prior.mean) && prior.n ? prior.mean : posBase[k] ?? 0;
    let value = now.n ? blendPrior(now.mean, anchor, now.n, 0.5) : anchor;
    value = shrink(value, now.n + prior.n * 0.6, posBase[k] ?? anchor, 4);
    priorByKey[k] = { now, prior, value, anchor };
  }

  const oppIndex = (v, base) => (Number.isFinite(v) && Number.isFinite(base) && base > 0 ? clamp(v / base, 0.85, 1.2) : 1);
  const paceMult = env.paceIndex;
  const oppDefMult = Math.pow(oppIndex(oppProfile.oppPointsPerGame ?? oppProfile.pointsPerGame, baseline.oppPointsPerGame), 0.5);
  const oppRebMult = Math.pow(1 / oppIndex(oppProfile.reboundsPerGame, baseline.reboundsPerGame), 0.35);
  const oppStlMult = Math.pow(oppIndex(oppProfile.turnoverRatio, baseline.turnoverRatio), 0.4);

  const mult = {
    pts: paceMult * oppDefMult,
    fga: paceMult * oppDefMult,
    fta: paceMult * oppDefMult,
    reb: paceMult * oppRebMult,
    ast: paceMult,
    tpm: paceMult,
    stl: paceMult * oppStlMult,
    blk: paceMult,
    tov: paceMult,
  };

  factors.push({
    label: 'Pace',
    kind: 'environment',
    value: paceMult,
    detail: `these two teams average ${env.pace.toFixed(1)} possessions against a ${baseline.pace?.toFixed(1) ?? '—'} baseline`,
  });
  factors.push({
    label: 'Opponent defence',
    kind: 'matchup',
    value: oppDefMult,
    detail: `${oppProfile === undefined ? '' : ''}allows ${(oppProfile.oppPointsPerGame ?? oppProfile.pointsPerGame ?? 0).toFixed(1)} points against a ${baseline.oppPointsPerGame?.toFixed(1) ?? '—'} baseline`,
  });
  factors.push({
    label: 'Opponent rebounding',
    kind: 'matchup',
    value: oppRebMult,
    detail: `they grab ${(oppProfile.reboundsPerGame ?? 0).toFixed(1)} rebounds per game, so fewer are available to him`,
  });

  // Shooting percentages are the noisiest numbers in basketball, so they get their own
  // shrinkage toward sane positional-ish priors rather than being used raw.
  const window_ = nowRows.concat(priorRows).slice(-25);
  const shareOf = (f) => {
    const vals = window_.map(f).filter(Number.isFinite);
    return vals.length ? mean(vals) : null;
  };
  const nWindow = window_.length;
  const fgaPerMin = priorByKey.fga.value;
  // Share of his field-goal attempts that come from three, which is an attempts ratio.
  const tpaShare = fgaPerMin > 0 ? clamp(priorByKey.tpa.value / Math.max(fgaPerMin, 0.01), 0, 0.85) : 0;
  const threePct = clamp(shrink(shareOf((r) => (r.tpa > 0 ? r.tpm / r.tpa : NaN)) ?? 0.34, nWindow, 0.34, 6), 0.2, 0.47);
  const ftPct = clamp(shrink(shareOf((r) => (r.fta > 0 ? r.ftm / r.fta : NaN)) ?? 0.78, nWindow, 0.78, 6), 0.5, 0.94);
  const twoPct = clamp(
    shrink(shareOf((r) => (r.fga - r.tpa > 0 ? (r.fgm - r.tpm) / (r.fga - r.tpa) : NaN)) ?? 0.52, nWindow, 0.52, 6),
    0.28,
    0.68,
  );

  // perMinute is what the simulator consumes: it scales by the minutes it draws.
  // projected is the same thing already multiplied out, for display and for the naive baseline.
  const perMinute = {};
  const projected = {};
  for (const k of RATE_KEYS) {
    perMinute[k] = priorByKey[k].value;
    projected[k] = priorByKey[k].value * minutes * mult[k];
  }
  for (const bag of [perMinute, projected]) {
    bag.threePct = threePct;
    bag.ftPct = ftPct;
    bag.twoPct = twoPct;
    bag.tpaShare = tpaShare;
  }

  // ---- usage: the honest explanation of where his touches come from ----------------
  const perGame = (rows, f) => mean(rows.slice(-12).map(f).filter(Number.isFinite));
  const usageNum = perGame(nowRows.concat(priorRows).slice(-12), (r) => r.fga + 0.44 * r.fta + r.tov);

  const naiveStat = {};
  for (const k of ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk']) {
    const rows = nowRows.length >= 4 ? nowRows : priorRows;
    naiveStat[k] = rows.length ? mean(rows.map((r) => r[k])) : 0;
  }
  naiveStat.pra = naiveStat.pts + naiveStat.reb + naiveStat.ast;

  const availability = player.injury
    ? {
      p: player.injury.playProb,
      source: 'ESPN injury report',
      injury: player.injury.injury || player.injury.status,
      status: player.injury.status,
    }
    : { p: 0.97, source: 'no injury reported', injury: null, status: 'Active' };
  if (player.injury) {
    flags.push({
      label: player.injury.status,
      severity: player.injury.status.toLowerCase() === 'out' ? 'high' : 'med',
      detail: player.injury.injury || player.injury.comment?.slice(0, 120) || 'listed on the injury report',
    });
  }

  return {
    minutes,
    minuteSd: Math.max(0.18 * minutes, Math.min(0.45 * minutes, sd(minuteList))),
    projected,
    perMinute,
    usage: {
      fgaPerMin,
      usagePerGame: usageNum,
      threePct,
      tpaShare,
    },
    naiveStat,
    priorStats: priorByKey,
    metrics: {
      gamesNow: nowRows.length,
      gamesPrior: priorRows.length,
      minutesCv: cv(minuteList),
      ptsCv: cv(nowRows.map((r) => r.pts)),
      pace: env.pace,
      paceIndex: paceMult,
      oppDefMult,
      oppRebMult,
      oppStlMult,
      blowMult,
      rest,
    },
    factors,
    flags,
    availability,
    posBase,
    quant: { quantitative: true },
  };
}


