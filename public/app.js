import { loadSeason, CURRENT_SEASON, TEAM_NAMES } from './engine/data.js';
import { buildBoard, rethreshold, DEFAULT_SETTINGS } from './engine/board.js';
import { MARKETS, MARKET_BY_ID, formatOdds, CONFIDENCE_NOTE } from './engine/props.js';
import { runBacktest } from './engine/backtest.js';
import { loadSlate, loadGame, NBA_SEASON, NBA_PRIOR } from './engine/nba/data.js';
import { buildNbaBoard, rethresholdNba, NBA_DEFAULT_SETTINGS } from './engine/nba/board.js';
import { NBA_MARKETS, NBA_MARKET_BY_ID, NBA_FAMILIES, NBA_PHRASE } from './engine/nba/markets.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (p, d = 1) => (Number.isFinite(p) ? `${(p * 100).toFixed(d)}%` : '—');
const pct0 = (p) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '—');
const teamName = (t) => TEAM_NAMES[t] || t;
const idxPct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}` : '—');

/** Plain-English names for the confidence tiers, for the simple view. */
const CONF_WORD = { A: 'strong', B: 'solid', C: 'thin', D: 'very thin' };
const CONF_SENTENCE = {
  A: 'Deep sample, stable role and healthy: the safest kind of number on the board.',
  B: 'Solid sample and a stable role.',
  C: 'Thin sample or a shaky role, so treat this as a lean rather than a read.',
  D: 'Too little data, or too much week-to-week swing, to trust much at all.',
};
const unitOf = (marketId) => state.markets.get(marketId)?.unit || '';

/**
 * How to say each market out loud. Every number on the board is in the units of
 * the market named on the same row, and this is what turns "1.8" into "about
 * 1.8 passing touchdowns".
 */
const PHRASE = {
  pass_yds: { noun: 'passing yards', says: (l) => `he threw for over ${fmt(l, 0)} yards` },
  pass_tds: { noun: 'passing touchdowns', says: (l, n) => `he threw ${n} or more touchdowns` },
  ints: { noun: 'interceptions', says: (l, n) => `he threw ${n} or more interceptions` },
  pass_att: { noun: 'pass attempts', says: (l, n) => `he attempted ${n} or more passes` },
  rush_yds: { noun: 'rushing yards', says: (l) => `he ran for over ${fmt(l, 0)} yards` },
  carries: { noun: 'carries', says: (l, n) => `he carried the ball ${n} or more times` },
  receptions: { noun: 'receptions', says: (l, n) => `he caught ${n} or more passes` },
  rec_yds: { noun: 'receiving yards', says: (l) => `he finished with over ${fmt(l, 0)} receiving yards` },
  anytime_td: { noun: 'touchdowns', says: () => 'he scored at least one touchdown' },
  fg_made: { noun: 'field goals', says: (l, n) => `he made ${n} or more field goals` },
};

/** The plain-English reading of one prop, shared by the simple rows, the guide and the drawer. */
function phrase(p) {
  const table = state.sport === 'nba' ? NBA_PHRASE : PHRASE;
  const def = table[p.market] || { noun: unitOf(p.market) || 'units', says: (l) => `he went over ${fmt(l, 1)}` };
  const line = p.threshold.line;
  return {
    noun: def.noun,
    expects: `about ${fmt(p.projection, p.decimals)} ${def.noun}`,
    over: def.says(line, Math.ceil(line)),
    headline: `${esc(p.player)} averaged ${fmt(p.projection, p.decimals)} ${def.noun}`,
  };
}

const state = {
  // 'nfl' | 'nba'. The prop shape is shared, so only the loaders, the market map and a
  // handful of panels differ between them.
  sport: 'nfl',
  markets: MARKET_BY_ID,
  families: null, // set below, once FAMILIES is defined (and swapped for NBA_FAMILIES)
  nba: { slate: null, gameId: null, teams: null, loaded: new Map(), current: null },
  data: null,
  season: CURRENT_SEASON,
  week: null,
  gameId: null,
  settings: { ...DEFAULT_SETTINGS, usePrior: true, sims: 6000 },
  board: null,
  building: false,
  view: 'board',
  // 'simple' leads with sentences and hides the analyst columns; 'expert' is the
  // dense table. Same engine, same numbers, two reading levels.
  mode: 'simple',
  sort: { key: 'prob', dir: 'desc' },
  filters: { family: 'all', team: 'all', hideFlagged: false },
  drawer: null,
  backtest: null,
  backtestRunning: false,
  backtestError: null,
  fatal: null,
};

const FAMILIES = [
  { id: 'all', label: 'All markets' },
  { id: 'passing', label: 'Passing' },
  { id: 'rushing', label: 'Rushing' },
  { id: 'receiving', label: 'Receiving' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'kicking', label: 'Kicking' },
];

state.families = FAMILIES;

const SORTS = {
  prob: (a, b) => b.threshold.prob - a.threshold.prob,
  player: (a, b) => a.player.localeCompare(b.player),
  proj: (a, b) => b.projection - a.projection,
  line: (a, b) => b.threshold.line - a.threshold.line,
  conf: (a, b) => b.confidence.score - a.confidence.score,
  premium: (a, b) => (b.linePremium ?? -99) - (a.linePremium ?? -99),
};

/* ---------------------------------------------------------------------- boot */

function bootScreen(text = 'starting engine') {
  $('#app').innerHTML = `
    <div class="boot" id="boot">
      <div class="boot-mark">PROPLAB</div>
      <div class="boot-msg" id="boot-msg">${esc(text)}</div>
      <div class="boot-bar"><span id="boot-bar"></span></div>
      <div class="boot-fine">nflverse + espn public feeds · local engine · no account, no API key</div>
    </div>`;
}

async function boot() {
  state.fatal = null;
  bootScreen(state.sport === 'nba' ? 'loading nba data' : 'starting engine');
  let step = 0;
  const bump = (text) => {
    step++;
    const msg = $('#boot-msg');
    const bar = $('#boot-bar');
    if (msg) msg.textContent = text;
    if (bar) bar.style.width = `${Math.min(95, (step / 12) * 100)}%`;
  };

  try {
    if (state.sport === 'nba') await loadNbaData(bump);
    else await loadNflData(bump);
    const bar = $('#boot-bar');
    if (bar) bar.style.width = '100%';
    window.__proplab = state; // debug handle: inspect the whole board from the console
    mount();
    await rebuild();
  } catch (err) {
    console.error(err);
    state.fatal = err;
    renderFatal(err);
  }
}

async function loadNflData(bump) {
  if (state.data) return; // already in memory for this session
  try {
    state.data = await loadSeason(CURRENT_SEASON, { withPrior: true, onProgress: bump });
  } catch (err) {
    console.warn('prior season unavailable; continuing with current season only', err);
    bump('retrying without last season');
    state.data = await loadSeason(CURRENT_SEASON, { withPrior: false, onProgress: bump });
  }
  selectDefaultGame();
}

async function loadNbaData(bump) {
  if (!state.nba.slate) state.nba.slate = await loadSlate({ onProgress: bump });
  if (!state.nba.gameId) {
    const today = new Date().toISOString().slice(0, 10);
    const list = state.nba.slate.games;
    const next = list.find((g) => !g.played && g.day >= today) || list[list.length - 1];
    state.nba.gameId = next ? next.id : null;
  }
  await ensureNbaGame(bump);
}

/** Pull (or reuse) one game's rosters, team form and player logs. */
async function ensureNbaGame(bump) {
  const slate = state.nba.slate;
  const game = slate.games.find((g) => g.id === state.nba.gameId);
  if (!game) throw new Error('no NBA game selected');
  let loaded = state.nba.loaded.get(game.id);
  if (!loaded) {
    loaded = await loadGame({ slate, game, onProgress: bump || ((t) => {}) });
    state.nba.loaded.set(game.id, loaded);
  }
  state.nba.current = { game, ...loaded };
  state.nba.teams = loaded.teams;
}

function selectDefaultGame() {
  const weeks = state.data.weeks(state.season);
  if (!weeks.length) {
    state.week = null;
    state.gameId = null;
    return;
  }
  const upcoming = weeks.find((w) => state.data.games(state.season, w).some((g) => !g.played));
  state.week = upcoming ?? weeks[weeks.length - 1];
  const games = state.data.games(state.season, state.week);
  state.gameId = (games.find((g) => !g.played) ?? games[0])?.id ?? null;
}

function currentGame() {
  return state.data.games(state.season, state.week).find((g) => g.id === state.gameId) || null;
}

async function rebuild() {
  if (state.sport === 'nfl' && !currentGame()) {
    state.board = null;
    render();
    return;
  }
  state.building = true;
  render();

  await new Promise((r) => setTimeout(r, 24)); // let the building state paint

  const t0 = performance.now();
  try {
    state.board = state.sport === 'nba' ? buildNbaBoard({
      game: state.nba.current.game,
      teams: state.nba.current.teams,
      settings: { threshold: state.settings.threshold, sims: state.settings.sims },
    }) : buildBoard({
      data: state.data,
      game: currentGame(),
      settings: {
        threshold: state.settings.threshold,
        sims: state.settings.sims,
        usePrior: state.settings.usePrior && state.season === CURRENT_SEASON,
        weather: state.settings.weather,
        availabilityOverrides: state.settings.availabilityOverrides,
      },
    });
  } catch (err) {
    console.error(err);
    state.fatal = err;
  } finally {
    state.buildMs = Math.round(performance.now() - t0);
    state.building = false;
    render();
  }
}

/** Switching sports keeps each side's loaded data, so going back is instant. */
async function switchSport(sport) {
  if (sport === state.sport) return;
  state.sport = sport;
  state.board = null;
  state.fatal = null;
  state.settings.weather = null;
  state.settings.availabilityOverrides = {};
  state.filters = { family: 'all', team: 'all', hideFlagged: false };
  state.sort = { key: 'prob', dir: 'desc' };
  state.drawer = null;
  closeDrawer();
  state.markets = sport === 'nba' ? NBA_MARKET_BY_ID : MARKET_BY_ID;
  state.families = sport === 'nba' ? NBA_FAMILIES : FAMILIES;
  state.settings.threshold = sport === 'nba' ? NBA_DEFAULT_SETTINGS.threshold : DEFAULT_SETTINGS.threshold;
  await boot();
}

async function selectNbaGame(id) {
  state.nba.gameId = id;
  state.building = true;
  render();
  try {
    await ensureNbaGame();
    await rebuild();
  } catch (err) {
    console.error(err);
    state.fatal = err;
    renderFatal(err);
  }
}

/** Threshold moves reuse stored samples: fast enough to feel instant. */
function applyThreshold(next) {
  state.settings.threshold = next;
  if (state.board) {
    if (state.sport === 'nba') rethresholdNba(state.board, next);
    else rethreshold(state.board, next);
  }
  render();
}

/* --------------------------------------------------------------------- mount */

function mount() {
  $('#app').innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="wordmark"><span>PROP<b>LAB</b></span><small>${state.sport === 'nba' ? 'nba' : 'nfl'} prop probability engine</small></div>
        <div class="controls">
          <div class="field"><label>Sport</label>
            <div class="segmented" id="sport">
              <button data-sport="nfl" aria-pressed="${state.sport === 'nfl'}">NFL</button>
              <button data-sport="nba" aria-pressed="${state.sport === 'nba'}">NBA</button>
            </div>
          </div>
          <div class="field"><label>Detail level</label>
            <div class="segmented" id="mode">
              <button data-mode="simple" aria-pressed="${state.mode === 'simple'}">Simple</button>
              <button data-mode="expert" aria-pressed="${state.mode === 'expert'}">Expert</button>
            </div>
          </div>
          ${state.sport === 'nba' ? '' : `<div class="field"><label for="season">Season</label>
            <select id="season">
              <option value="${CURRENT_SEASON}">${CURRENT_SEASON}</option>
              <option value="${CURRENT_SEASON - 1}">${CURRENT_SEASON - 1}</option>
            </select></div>
          <div class="field"><label for="week">Week</label><select id="week"></select></div>`}
          <div class="field"><label for="game">Game</label><select id="game"></select></div>
          <div class="field"><label for="thr">Probability floor</label>
            <div class="threshold">
              <input type="range" id="thr" min="52" max="88" step="1" value="${Math.round(state.settings.threshold * 100)}" />
              <span class="val" id="thr-val">${Math.round(state.settings.threshold * 100)}%</span>
            </div>
          </div>
          <div class="field"><label for="sims">Simulations</label>
            <select id="sims">
              <option value="3000">3,000</option>
              <option value="6000" selected>6,000</option>
              <option value="12000">12,000</option>
              <option value="24000">24,000</option>
            </select></div>
        </div>
      </div>
      <div class="tabs">
        <button data-view="board" aria-selected="true">Prop board</button>
        <button data-view="matchup">Matchup</button>
        <button data-view="method">Method</button>
        <button data-view="backtest">Backtest</button>
        <span class="spacer"></span>
        <span class="meta" id="tab-meta"></span>
      </div>
      <div id="view"></div>
    </div>
    <div class="scrim" id="scrim"></div>
    <aside class="drawer" id="drawer" aria-hidden="true"></aside>
  `;

  document.querySelectorAll('#sport button').forEach((btn) => {
    btn.addEventListener('click', () => switchSport(btn.dataset.sport));
  });

  document.querySelectorAll('#mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('#mode button').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
      });
      render();
    });
  });

  if ($('#season')) {
    $('#season').value = String(state.season);
    $('#season').addEventListener('change', (e) => {
      state.season = Number(e.target.value);
      state.settings.weather = null;
      state.settings.availabilityOverrides = {};
      selectDefaultGame();
      renderTopbar();
      rebuild();
    });
  }
  $('#week')?.addEventListener('change', (e) => {
    state.week = Number(e.target.value);
    const games = state.data.games(state.season, state.week);
    state.gameId = (games.find((g) => !g.played) ?? games[0])?.id ?? null;
    renderTopbar();
    rebuild();
  });
  $('#game').addEventListener('change', (e) => {
    if (state.sport === 'nba') return void selectNbaGame(e.target.value);
    state.gameId = e.target.value;
    rebuild();
  });
  $('#sims').addEventListener('change', (e) => {
    state.settings.sims = Number(e.target.value);
    rebuild();
  });

  const slider = $('#thr');
  slider.addEventListener('input', (e) => {
    $('#thr-val').textContent = `${e.target.value}%`;
    applyThreshold(Number(e.target.value) / 100);
  });

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      render();
    });
  });

  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  renderTopbar();
}

function renderTopbar() {
  if (!$('#game')) return;

  if (state.sport === 'nba') {
    const nbaSel = $('#game');
    const games = state.nba.slate?.games || [];
    nbaSel.innerHTML = games.map((g) => {
      const tag = g.played ? `${g.awayScore}-${g.homeScore}` : (Number.isFinite(g.total) ? `T ${g.total}` : 'no line');
      return `<option value="${g.id}">${esc(g.day.slice(5))} · ${esc(g.away)} @ ${esc(g.home)} · ${esc(g.tip)} · ${tag}</option>`;
    }).join('');
    nbaSel.value = String(state.nba.gameId ?? '');
    return;
  }

  const weekSel = $('#week');
  if (!weekSel) return;
  const weeks = state.data.weeks(state.season);
  const completed = new Set(state.data.completedWeeks(state.season));
  weekSel.innerHTML = weeks.map((w) => {
    const games = state.data.games(state.season, w);
    const done = games.filter((g) => g.played).length;
    return `<option value="${w}">Week ${w}${completed.has(w) ? ` · final` : ` · ${games.length} games`}</option>`;
  }).join('');
  weekSel.value = String(state.week);

  const gameSel = $('#game');
  const games = state.data.games(state.season, state.week);
  gameSel.innerHTML = games.map((g) => {
    const time = (g.gametime || '').slice(0, 5);
    const tag = g.played ? `${g.awayScore}-${g.homeScore}` : (Number.isFinite(g.total) ? `T ${g.total}` : 'no line');
    return `<option value="${g.id}">${g.away} @ ${g.home} · ${esc((g.gameday || '').slice(5))} ${time} · ${tag}</option>`;
  }).join('');
  gameSel.value = state.gameId;
}

/* -------------------------------------------------------------------- render */

function render() {
  if (state.fatal && !state.board) return renderFatal(state.fatal);
  const meta = $('#tab-meta');
  if (meta) {
    const b = state.board;
    meta.textContent = b
      ? (b.sport === 'nba'
        ? `${b.season} · ${b.game.away} @ ${b.game.home} · ${b.props.length} props · ${state.settings.sims.toLocaleString()} sims · built in ${state.buildMs}ms`
        : `${b.season} wk ${b.week} · ${b.props.length} props · ${state.settings.sims.toLocaleString()} sims · built in ${state.buildMs}ms`)
      : '';
  }

  if (state.view === 'board') return renderBoard();
  if (state.view === 'matchup') return renderMatchup();
  if (state.view === 'method') return renderMethod();
  if (state.view === 'backtest') return renderBacktest();
}

function renderFatal(err) {
  $('#app').innerHTML = `
    <div class="shell" style="padding-top:60px">
      <div class="errbox">
        <strong>Could not build the board.</strong>
        <p style="margin:8px 0 0">${esc(err?.message || err)}</p>
        <p style="margin:8px 0 0">Check that the local server is running (<code>java Server.java</code>) and that the data cache in <code>.cache/</code> was populated.</p>
      </div>
    </div>`;
}

function buildingHtml() {
  return `<div class="empty"><span class="spin"></span> running ${state.settings.sims.toLocaleString()} simulations…</div>`;
}

/* --------------------------------------------------------------------- board */

function renderBoard() {
  const b = state.board;
  if (state.building) return void ($('#view').innerHTML = buildingHtml());
  if (!b) return void ($('#view').innerHTML = '<div class="empty">No game selected.</div>');

  const simple = state.mode === 'simple';

  $('#view').innerHTML = `
    <div class="layout">
      <div>
        ${gameCard(b)}
        ${environmentPanel(b)}
        ${totalsPanel(b)}
        ${profilePanel(b)}
      </div>
      <div>
        ${picksPanelHtml(b)}
        <div class="panel">
          <div class="chips" id="chips">${chipsHtml(b)}</div>
          ${simple ? howToReadHtml(b) : expertLegend(b)}
          ${simple
    ? '<div class="slist" id="slist-body"></div>'
    : `<div class="table-wrap"><table class="board"><thead><tr id="head-row">${headRow(b)}</tr></thead><tbody id="rows"></tbody></table></div>`}
        </div>
        ${notesPanel(b)}
      </div>
    </div>`;

  wireChips();
  if (!simple) wireSort();
  renderPropList();
}

/** One entry point for both renderers, so filters and sorts work in either mode. */
function renderPropList() {
  if (state.mode === 'simple') renderSimpleRows();
  else renderRows();
  renderPicks();
}

/* --------------------------------------------------------------- top picks */

/** 5/6 = 83.3%, the probability that breaks even at -500. Nothing shorter is a bet. */
const PICKS_MAX_PROB = 5 / 6;
const PICKS_COUNT = 8;

/**
 * The curated short list: the most likely props that a person can actually act on.
 * Excluded, in order: rows below your floor, players carrying an injury or
 * sample-size flag, and anything priced worse than -500. One prop per player,
 * because two props on the same player rise and fall together.
 */
function pickList() {
  const seen = new Set();
  const out = [];
  const pool = visibleProps().slice().sort((a, z) => z.threshold.prob - a.threshold.prob);
  for (const p of pool) {
    if (p.threshold.belowThreshold) continue;
    if (p.threshold.prob > PICKS_MAX_PROB) continue;
    if (p.flags.some((f) => f.severity !== 'low')) continue;
    const key = p.playerId || p.player;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= PICKS_COUNT) break;
  }
  return out;
}

function renderPicks() {
  const wrap = $('#picks-body');
  if (!wrap) return;
  const list = pickList();
  const count = $('#picks-count');
  if (count) count.textContent = list.length ? `${list.length} picks` : 'none qualify';

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">No prop on this game clears your floor with a clean injury and
      sample picture. Lower the probability floor, or clear the filters.</div>`;
    return;
  }

  wrap.innerHTML = list.map((p, i) => `
    <div class="pick" tabindex="0" data-prop="${esc(p.id)}" title="Click for the full breakdown">
      <span class="pick-rank">${i + 1}</span>
      <span class="pick-who"><span class="pos-badge ${esc(p.pos)}">${esc(p.pos)}</span>${esc(p.player)}<span class="team-dot">${esc(p.team)}</span></span>
      <span class="pick-mkt">${esc(p.marketLabel)} <b>over ${fmt(p.threshold.line, 1)}</b></span>
      <span class="pick-prob">${pct0(p.threshold.prob)}</span>
      <span class="pick-fair">${formatOdds(p.threshold.prob)}</span>
      <span class="conf ${p.confidence.tier}" title="${esc(CONFIDENCE_NOTE[p.confidence.tier])}">${p.confidence.tier}${p.confidence.score}</span>
    </div>`).join('');

  wrap.querySelectorAll('.pick[data-prop]').forEach((row) => {
    const open = () => openDrawer(row.dataset.prop);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

function picksPanelHtml(b) {
  const floor = Math.round(b.settings.threshold * 100);
  return `
    <div class="panel" id="picks-panel">
      <div class="panel-head">
        <h2>Top picks @ ${floor}% floor</h2>
        <span class="badge" id="picks-count"></span>
      </div>
      <div id="picks-body"></div>
      <div class="footnote" style="padding:2px 13px 12px">
        Ranked by chance of hitting, one prop per player so you are not stacking correlated legs.
        Skips rows below your floor, players with an open injury or sample-size flag, and anything whose
        break-even price is worse than -500 — at that juice you are paying a fee, not taking a bet.
        <b style="color:var(--muted)">Break-even</b> is the price to beat: better than it is an edge, worse loses over time.
      </div>
    </div>`;
}

function expertLegend(b) {
  return `
    <div class="footnote" style="padding:9px 13px 0">
      Every number is in the units of the <b style="color:var(--muted)">Market</b> named at the end of its row,
      so <span class="u">1.8 TDs</span> means passing touchdowns while <span class="u">1.8 catches</span>
      means receptions.<br>
      <b style="color:var(--muted)">Proj</b> is his average result across the simulated games, in those units.
      <b style="color:var(--muted)">Line</b> is the highest standard line he still clears at your
      ${Math.round(b.settings.threshold * 100)}% floor — the worst number you would still take.
      <b style="color:var(--muted)">P(over)</b> is how often he finished past that line in the simulations.
      <b style="color:var(--muted)">Fair price</b> is break-even for that probability: better than it is an edge, worse is a losing bet.
      <b style="color:var(--muted)">vs naive</b> is how much the model's line beats the same distribution anchored to his raw season average.<br>
      A row flagged <span class="badge warn">below floor</span> has no standard line that clears your floor at all;
      the lowest line the market posts is shown, so read the percentage as a lean rather than a recommendation.
    </div>`;
}

function howToReadHtml(b) {
  const sims = b.settings.sims.toLocaleString();
  // Teach with a mid-board call rather than the safest line on the board: a 87%
  // prop on a 4.5-yard line is a bad example of what the numbers mean.
  const pool = b.props.length ? b.props : visibleProps();
  const ex = pool.slice().sort((x, y) => Math.abs(x.threshold.prob - 0.7) - Math.abs(y.threshold.prob - 0.7))[0];
  const ph = ex ? phrase(ex) : null;
  const example = ex && ph
    ? `<div class="howto-eg">
          <div class="eg-head"><span class="eg-name">${esc(ex.player)}</span><span class="team-dot">${esc(ex.team)}</span><span class="badge">${esc(ex.marketLabel)}</span></div>
          <div class="eg-line">Expects <b>${fmt(ex.projection, ex.decimals)} ${esc(ph.noun)}</b> — in <b>${pct0(ex.threshold.prob)}</b> of ${sims} simulated games, ${esc(ph.over)}.</div>
        </div>`
    : '';
  return `
    <details class="howto" open>
      <summary>What do these numbers mean?</summary>
      <div class="howto-body">
        ${example}
        <dl>
          <dt>the bold number at the top of a row, like ${ex ? `${fmt(ex.projection, ex.decimals)} ${esc(ph.noun)}` : '1.8 passing touchdowns'}</dt>
          <dd>The <b>projection</b>: his average across ${sims} simulated versions of this game, always in the units of the market named on the row — 1.8 <i>passing touchdowns</i>, 249 <i>passing yards</i>, 6.4 <i>receptions</i>. Not a prediction of the exact result; the middle of the range of things that could happen.</dd>
          <dt>the percentage, like ${ex ? pct0(ex.threshold.prob) : '71%'}</dt>
          <dd>How often he beat the line in those simulations. This is the actual product: a probability, not a guarantee. ${ex ? pct0(ex.threshold.prob) : '71%'} still fails roughly ${ex ? Math.max(1, Math.round((1 - ex.threshold.prob) * 10)) : 3} times in 10.</dd>
          <dt>the line, like over ${ex ? fmt(ex.threshold.line, 1) : '1.5'}</dt>
          <dd>Sits at your ${Math.round(b.settings.threshold * 100)}% floor: the highest standard line he still clears that often. Drag the slider in the top bar for safer shorter lines or bolder longer ones.</dd>
          <dt>break-even price</dt>
          <dd>The price that makes the bet fair at that probability. If your sportsbook offers something <i>worse</i> (a bigger negative number, or a smaller positive one), the bet loses money over time even when you win.</dd>
          <dt>confidence</dt>
          <dd>How much to trust the number, from games played, role stability and injury status. Separate from the probability: a 78% call built on two games is still a bad number.</dd>
        </dl>
        <p style="margin:11px 0 0">Some players have no standard line that clears your floor. Those rows are labelled
        <b>below floor</b> and show the lowest line the market posts instead, so you can see the lean without
        mistaking it for a recommendation.</p>
        <p style="margin:8px 0 0">Click any row for the full breakdown, including every adjustment that moved the number.</p>
      </div>
    </details>`;
}

function headRow(b) {
  const cols = [
    ['player', 'Player', 'left', 'Who the prop is about.'],
    ['proj', 'Proj', '', 'The projection: his average result across all the simulated games, in the units of this row\'s market (1.8 passing TDs, 249 passing yards, 6.4 receptions).'],
    ['line', 'Line', '', 'The number you would bet over or under. Chosen as the highest standard line he still clears at your probability floor.'],
    ['prob', `P(over) @ ${Math.round(b.settings.threshold * 100)}%`, '', 'How often he finished above that line in the simulations. This is the probability you are reading.'],
    ['conf', 'Conf', '', 'Confidence in the number (A best to D worst), from games played, role stability and injury status. Not the same thing as the probability.'],
    ['premium', 'vs naive', '', '"Naive" means simply taking his season average. This is how much more the model asks for than that baseline would justify. Positive means the adjustments are doing real work.'],
  ];
  const played = b.game.played
    ? '<th title="What he actually did in this game. Only shown for games already played, so you can check the model against reality.">Actual</th>'
    : '';
  return cols.map(([key, label, align, hint]) => {
    const sorted = state.sort.key === key ? ' sorted' : '';
    return `<th class="${sorted}" data-sort="${key}" style="text-align:${align || 'right'}" title="${esc(hint)}">${label}</th>`;
  }).join('') + played + '<th title="Break-even price for the probability shown. Better than this is profit; worse is a losing bet. The market column says which stat the bet is on.">Fair price</th><th>Market</th>';
}

function chipsHtml(b) {
  const teams = [b.game.away, b.game.home];
  const rankOptions = [
    ['prob', 'Rank: highest probability'],
    ['premium', 'Rank: model edge vs naive'],
    ['conf', 'Rank: confidence'],
    ['proj', 'Rank: projection size'],
  ];
  return `
    ${state.families.map((f) => `<button class="chip" data-family="${f.id}" aria-pressed="${state.filters.family === f.id}">${f.label}</button>`).join('')}
    ${teams.map((t) => `<button class="chip" data-team="${t}" aria-pressed="${state.filters.team === t}">${t}</button>`).join('')}
    <button class="chip toggle" data-toggle="flagged" aria-pressed="${state.filters.hideFlagged}">Hide flagged</button>
    <select id="rankby" title="How the board is ordered. Ranking by raw probability surfaces the safest lines; ranking by edge against a naive baseline surfaces the props where the model actually disagrees with his season average.">${rankOptions.map(([v, l]) => `<option value="${v}" ${state.sort.key === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span class="count" id="row-count"></span>`;
}

function wireChips() {
  $('#rankby')?.addEventListener('change', (e) => {
    state.sort = { key: e.target.value, dir: 'desc' };
    const head = $('#head-row');
    if (head) {
      head.innerHTML = headRow(state.board);
      wireSort();
    }
    renderPropList();
  });
  document.querySelectorAll('#chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.dataset.family) state.filters.family = chip.dataset.family;
      if (chip.dataset.team) state.filters.team = state.filters.team === chip.dataset.team ? 'all' : chip.dataset.team;
      if (chip.dataset.toggle === 'flagged') state.filters.hideFlagged = !state.filters.hideFlagged;
      document.querySelectorAll('#chips .chip').forEach((c) => {
        if (c.dataset.family) c.setAttribute('aria-pressed', String(state.filters.family === c.dataset.family));
        if (c.dataset.team) c.setAttribute('aria-pressed', String(state.filters.team === c.dataset.team));
        if (c.dataset.toggle) c.setAttribute('aria-pressed', String(state.filters.hideFlagged));
      });
      renderPropList();
    });
  });
}

function wireSort() {
  document.querySelectorAll('#head-row th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      else state.sort = { key, dir: 'desc' };
      $('#head-row').innerHTML = headRow(state.board);
      wireSort();
      renderRows();
    });
  });
}

/**
 * Simple mode: the same board as sentences. One card per prop, leading with what
 * the projection is *in words and units* rather than a bare number, and hiding
 * every analyst column that only makes sense once you already know the model.
 */
function renderSimpleRows() {
  const wrap = $('#slist-body');
  if (!wrap) return;
  const b = state.board;
  const list = visibleProps();
  const count = $('#row-count');
  if (count) count.textContent = `${list.length} of ${b.props.length} props`;
  const sims = b.settings.sims.toLocaleString();

  if (!list.length) {
    wrap.innerHTML = '<div class="empty">No props match these filters.</div>';
    return;
  }

  wrap.innerHTML = list.map((p) => {
    const actual = b.game.played ? actualFor(p) : null;
    const hit = actual === null ? null : actual > p.threshold.line;
    const ph = phrase(p);
    const prob = p.threshold.prob;
    const tierWord = CONF_WORD[p.confidence.tier] || 'thin';
    const flags = p.flags
      .map((f) => `<span class="flag ${f.severity}">${esc(f.label)}</span>`)
      .join('');
    const naive = p.naive
      ? `<span class="m">His ${b.season} average: <b>${fmt(p.naive.mean, p.decimals)}</b>
           <span class="dim">${Math.abs(p.linePremium ?? 0) < 0.05
    ? '— the model agrees with that'
    : `— the model asks ${fmt(Math.abs(p.linePremium), 1)} ${p.linePremium > 0 ? 'past' : 'below'} what that alone would give`}</span></span>`
      : '';

    return `
      <div class="srow" tabindex="0" data-prop="${esc(p.id)}">
        <div class="srow-top">
          <span class="pos-badge ${esc(p.pos)}">${esc(p.pos)}</span>
          <span class="srow-name">${esc(p.player)}</span>
          <span class="team-dot">${esc(p.team)}</span>
          <span class="srow-market">${esc(p.marketLabel)}</span>
          <span class="conf ${p.confidence.tier}" title="${esc(CONFIDENCE_NOTE[p.confidence.tier])}">${tierWord} ${p.confidence.score}</span>
        </div>
        <p class="srow-say">
          Expects <b>${fmt(p.projection, p.decimals)} ${esc(ph.noun)}</b>.
          In <b>${pct0(prob)}</b> of ${sims} simulated games, ${esc(ph.over)}.
        </p>
        <div class="srow-bar">
          <span class="bar"><i style="width:${Math.round(prob * 100)}%"></i></span>
          <span class="pct">${pct0(prob)}</span>
        </div>
        <div class="srow-meta">
          <span class="m">${p.threshold.belowThreshold
      ? `Lowest line the market posts: <b>${fmt(p.threshold.line, 1)}</b> ${esc(unitOf(p.market))} <span class="dim">— no standard line clears your ${Math.round(b.settings.threshold * 100)}% floor for him, so this is a below-floor lean, not a recommendation</span>`
      : `Over <b>${fmt(p.threshold.line, 1)}</b> ${esc(unitOf(p.market))} <span class="dim">— the highest line he cleared that often</span>`}</span>
          <span class="m">Break-even price <b>${formatOdds(prob)}</b> <span class="dim">(x${(1 / prob).toFixed(2)} your money)</span> <span class="dim">— any better price is an edge, any worse loses long-term</span></span>
          ${naive}
          ${actual !== null ? `<span class="m">Actual: <b>${fmt(actual, p.decimals)}</b> <span class="dim">${hit ? '✓ went over' : '✗ stayed under'}</span></span>` : ''}
        </div>
        ${flags ? `<div class="srow-flags">${flags}</div>` : ''}
      </div>`;
  }).join('');

  wrap.querySelectorAll('.srow[data-prop]').forEach((row) => {
    const open = () => openDrawer(row.dataset.prop);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

function visibleProps() {
  const b = state.board;
  const cmp = SORTS[state.sort.key] || SORTS.prob;
  const dir = state.sort.dir === 'desc' ? 1 : -1;
  return b.props
    .filter((p) => state.filters.family === 'all' || p.family === state.filters.family)
    .filter((p) => state.filters.team === 'all' || p.team === state.filters.team)
    .filter((p) => !state.filters.hideFlagged || !p.flags.some((f) => f.severity !== 'low'))
    .slice()
    .sort((a, b2) => dir * cmp(a, b2) || b2.confidence.score - a.confidence.score);
}

function renderRows() {
  const body = $('#rows');
  if (!body) return;
  const b = state.board;
  const list = visibleProps();
  $('#row-count').textContent = `${list.length} of ${b.props.length} props`;

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="9"><div class="empty">No props match these filters.</div></td></tr>';
    return;
  }

  body.innerHTML = list.map((p) => {
    const actual = b.game.played ? actualFor(p) : null;
    const hit = actual === null ? null : actual > p.threshold.line;
    const meterClass = p.threshold.prob >= 0.75 ? '' : p.threshold.prob >= 0.6 ? 'warn' : 'risk';
    const flags = p.flags.map((f) => `<span class="flagdot ${f.severity}" title="${esc(f.label)}: ${esc(f.detail)}"></span>`).join('');
    return `
      <tr tabindex="0" data-prop="${esc(p.id)}">
        <td class="name">
          <div class="player-cell">
            <span class="pos-badge ${esc(p.pos)}">${esc(p.pos)}</span>
            <span>${esc(p.player)}</span>
            <span class="team-dot">${esc(p.team)}</span>
            ${flags}
          </div>
        </td>
        <td class="num">${fmt(p.projection, p.decimals)} <span class="u">${esc(unitOf(p.market))}</span></td>
        <td class="num">${fmt(p.threshold.line, 1)}${p.threshold.belowThreshold ? ` <span class="badge warn" title="No standard line on this market's ladder clears your floor for him. The lowest line the market posts is shown, and he clears it ${pct(p.threshold.prob)} of the time — a lean, not the board's recommendation.">below floor</span>` : ''}</td>
        <td>
          <div class="prob-cell">
            <span class="num">${pct(p.threshold.prob)}</span>
            <span class="prob-meter ${meterClass}"><i style="width:${Math.round(p.threshold.prob * 100)}%"></i></span>
          </div>
        </td>
        <td><span class="conf ${p.confidence.tier}" title="${esc(CONFIDENCE_NOTE[p.confidence.tier])}">${p.confidence.tier}${p.confidence.score}</span></td>
        <td class="premium ${p.linePremium > 0 ? 'up' : 'down'}">${p.linePremium === null ? '—' : `${p.linePremium > 0 ? '+' : ''}${fmt(p.linePremium, 1)}`}</td>
        ${b.game.played ? `<td class="num">${actual === null ? '—' : fmt(actual, p.decimals)} ${hit === null ? '' : hit ? '<span style="color:var(--lime)">✓</span>' : '<span style="color:var(--dim)">✗</span>'}</td>` : ''}
        <td class="num" style="color:${p.threshold.prob >= 0.5 ? 'var(--lime)' : 'var(--muted)'}">${formatOdds(p.threshold.prob)}</td>
        <td class="market">${esc(p.marketLabel)}</td>
      </tr>`;
  }).join('');

  body.querySelectorAll('tr[data-prop]').forEach((tr) => {
    const open = () => openDrawer(tr.dataset.prop);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

function actualFor(prop) {
  const b = state.board;
  const idx = state.data.seasons.get(b.season);
  if (!idx) return null;
  const player = idx.playersById.get(prop.playerId);
  if (!player) return null;
  const w = player.weeks.find((x) => x.week === b.week);
  if (!w) return null;
  const key = prop.statKey;
  if (key === 'totalTds') return w.recTds + w.rushTds;
  return Number.isFinite(w[key]) ? w[key] : null;
}

/* -------------------------------------------------------------- board panels */

function gameCard(b) {
  const g = b.game;
  const kick = `${esc((g.gameday || '').slice(5))} ${esc((g.gametime || '').slice(0, 5))}`;
  return `
    <div class="panel">
      <div class="panel-head">
        <h2>${g.played ? 'Final' : 'Upcoming'} · ${Number.isFinite(b.week) ? `Week ${b.week}` : esc(String(g.gameday || '').slice(5))}</h2>
        <span class="badge ${b.env.divGame ? 'warn' : ''}">${b.env.divGame ? 'divisional' : 'non-divisional'}</span>
      </div>
      <div class="panel-body">
        <div class="matchup">
          <div class="team-block">
            <span class="team-abbr">${esc(g.away)}</span>
            <span class="team-sub">${esc(teamName(g.away))}${b.env.implied ? ` · ${fmt(b.env.awayImplied, 1)} pts` : ''}</span>
          </div>
          <div class="kick">${kick}<br>${g.played ? `${g.awayScore}–${g.homeScore}` : esc(b.env.market)}</div>
          <div class="team-block" style="text-align:right">
            <span class="team-abbr">${esc(g.home)}</span>
            <span class="team-sub">${fmt(b.env.homeImplied, 1)} pts · ${esc(teamName(g.home))}</span>
          </div>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><span class="k">Total</span><span class="v">${fmt(b.env.total, 1)}</span></div>
        <div class="metric"><span class="k">Home spread</span><span class="v">${b.env.spread > 0 ? '+' : ''}${fmt(b.env.spread, 1)}</span></div>
        <div class="metric"><span class="k">Roof</span><span class="v" style="font-size:12px">${esc(b.env.roof || '—')}</span></div>
      </div>
    </div>`;
}

function kvPanelHtml(title, rows, badge) {
  return `
    <div class="panel">
      <div class="panel-head"><h2>${esc(title)}</h2>${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</div>
      <div class="panel-body"><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
    </div>`;
}

function environmentPanel(b) {
  if (b.envRows) return kvPanelHtml('Game environment', b.envRows, b.env.market);
  const wx = b.env.weather;
  const wxText = wx.known
    ? `${fmt(wx.wind, 0)} mph · ${fmt(wx.temp, 0)}°F${wx.isDome ? ' · indoors' : ''}${wx.manual ? ' · manual' : ''}`
    : 'no forecast in data';
  const rows = [
    ['Kickoff', esc(b.env.kickoff || '—')],
    ['Weather', wxText],
    ['Surface', esc(b.env.surface || '—')],
    ['Rest', `${fmt(b.env.rest.away, 0)}d vs ${fmt(b.env.rest.home, 0)}d`],
    ['Coaches', `${esc(b.env.coaches.away || '—')} vs ${esc(b.env.coaches.home || '—')}`],
    ['Referee', esc(b.env.referee || '—')],
    ['League pace', `${fmt(b.league.playsPerGame, 1)} plays/team`],
    ['League pass rate', pct(b.league.passRate, 1)],
  ];
  return `
    <div class="panel">
      <div class="panel-head"><h2>Game environment</h2><span class="badge">${esc(b.env.market)}</span></div>
      <div class="panel-body"><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
    </div>`;
}

function totalsPanel(b) {
  return `
    <div class="panel">
      <div class="panel-head"><h2>Team totals @ ${Math.round(b.settings.threshold * 100)}%</h2></div>
      <div class="panel-body tight">
        <table class="mini">
          <thead><tr><th>Team</th><th>Over</th><th>P(over)</th><th>Fair</th></tr></thead>
          <tbody>
            ${b.teamProps.map((t) => `
              <tr><td>${esc(t.team)}</td><td>${fmt(t.threshold.line, 1)}</td>
              <td>${pct(t.threshold.prob)}</td><td>${formatOdds(t.threshold.prob)}</td></tr>`).join('')}
          </tbody>
        </table>
        <div class="footnote" style="padding:0 10px 10px">Projection ${fmt(b.teamProps[0]?.projection, 1)} / ${fmt(b.teamProps[1]?.projection, 1)} points, driven by the posted total and spread.</div>
      </div>
    </div>`;
}

function profileRowsPanel(b) {
  return `
    <div class="panel">
      <div class="panel-head"><h2>Team profile (100 = the two teams' average)</h2>
        <span class="badge">${esc(b.season)}</span></div>
      <div class="panel-body">
        ${b.profileRows.map((row) => {
          const a = row.awayIdx;
          const h = row.homeIdx;
          return `
            <div class="profile-row">
              <div class="profile-label"><span>${esc(row.label)}</span><span>${idxPct(a)} · ${idxPct(h)}</span></div>
              <div class="dual">
                <div class="bar left"><i class="${barClass(a)}" style="width:${barWidth(a)}%"></i></div>
                <div class="bar right"><i class="${barClass(h)}" style="width:${barWidth(h)}%"></i></div>
              </div>
            </div>`;
        }).join('')}
        <div class="legend"><span>${esc(b.game.away)}</span><span>${esc(b.game.home)}</span></div>
        <div class="footnote">Defence is points allowed: a longer bar means a softer matchup for the opposing offence. The baseline is the
        mean of these two teams' own prior seasons, since this build does not fetch league-wide pace.</div>
      </div>
    </div>`;
}

function profilePanel(b) {
  if (b.profileRows) return profileRowsPanel(b);
  const rows = [
    ['Pass offence', 'passOff'], ['Rush offence', 'rushOff'],
    ['Pass defence', 'passDef'], ['Rush defence', 'rushDef'],
    ['Pace', 'pace'], ['Special teams', 'st'],
  ];
  return `
    <div class="panel">
      <div class="panel-head"><h2>Team strength (100 = league)</h2></div>
      <div class="panel-body">
        ${rows.map(([label, key]) => {
          const a = b.profiles.away.idx[key];
          const h = b.profiles.home.idx[key];
          return `
            <div class="profile-row">
              <div class="profile-label"><span>${esc(label)}</span><span>${idxPct(a)} · ${idxPct(h)}</span></div>
              <div class="dual">
                <div class="bar left"><i class="${barClass(a)}" style="width:${barWidth(a)}%"></i></div>
                <div class="bar right"><i class="${barClass(h)}" style="width:${barWidth(h)}%"></i></div>
              </div>
            </div>`;
        }).join('')}
        <div class="legend"><span>${esc(b.game.away)}</span><span>${esc(b.game.home)}</span></div>
        <div class="footnote">Defence bars are strength-relative: a longer bar means more yards allowed, i.e. a softer matchup for the opposing offence.</div>
      </div>
    </div>`;
}

function barWidth(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(3, Math.min(100, 50 + (x - 1) * 130));
}

function barClass(x) {
  if (!Number.isFinite(x)) return 'mid';
  if (x > 1.08) return 'bad';
  if (x < 0.92) return 'good';
  return 'mid';
}

function notesPanel(b) {
  return `
    <div class="panel" style="margin-top:14px">
      <div class="panel-head"><h2>Provenance &amp; limitations</h2></div>
      <div class="panel-body">
        <div class="notes">
          ${b.notes.map((n) => `<div class="note"><span class="nk">${esc(n.kind)}</span><span>${esc(n.text)}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------- matchup */

function renderMatchup() {
  const b = state.board;
  if (state.building) return void ($('#view').innerHTML = buildingHtml());
  if (!b) return void ($('#view').innerHTML = '<div class="empty">No game selected.</div>');
  if (b.matchupRows) return renderNbaMatchup(b);

  const metricRows = [
    ['Points per game', (p) => p.off.pointsPerGame, 1],
    ['Points allowed', (p) => p.def.pointsAllowedPerGame, 1],
    ['Plays per game', (p) => p.off.playsPerGame, 1],
    ['Pass rate', (p) => p.off.passRateRaw, 3],
    ['Pass yards / game', (p) => p.off.passYdsPerGame, 1],
    ['Rush yards / game', (p) => p.off.rushYdsPerGame, 1],
    ['Yards per attempt', (p) => p.off.passYdsPerAtt, 2],
    ['Yards per carry', (p) => p.off.rushYdsPerCarry, 2],
    ['Pass EPA / play', (p) => p.off.passEpaPerPlay, 3],
    ['Rush EPA / carry', (p) => p.off.rushEpaPerCarry, 3],
    ['Pass D: yards/att allowed', (p) => p.def.passYdsPerAttAllowed, 2],
    ['Rush D: yards/carry allowed', (p) => p.def.rushYdsPerCarryAllowed, 2],
    ['Sack rate allowed', (p) => p.off.sackRate, 3],
    ['Special teams yards/game', (p) => p.st.retYdsPerGame, 1],
    ['FG attempts / game', (p) => p.st.fgAttPerGame, 1],
    ['FG accuracy', (p) => p.st.fgPct, 3],
    ['Games in window', (p) => p.games, 0],
  ];

  $('#view').innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Team profile — ${esc(b.game.away)} @ ${esc(b.game.home)}</h2>
        <span class="badge">window: max 8 games before week ${b.week}</span></div>
      <div class="panel-body tight">
        <table class="spec">
          <thead><tr><th>Metric</th><th>${esc(b.game.away)}</th><th>${esc(b.game.home)}</th><th>League avg</th></tr></thead>
          <tbody>
            ${metricRows.map(([label, get, d]) => `
              <tr><td>${esc(label)}</td><td class="num">${fmt(get(b.profiles.away), d)}</td>
              <td class="num">${fmt(get(b.profiles.home), d)}</td>
              <td class="num" style="color:var(--dim)">${leagueRef(label, b, d)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="layout" style="margin-top:14px">
      <div>${weatherPanel(b)}</div>
      <div>${availabilityPanel(b)}</div>
    </div>`;

  wireWeather(b);
  wireAvailability(b);
}

function leagueRef(label, b, d) {
  const L = b.league;
  const map = {
    'Points per game': L.pointsPerGame,
    'Points allowed': L.pointsPerGame,
    'Plays per game': L.playsPerGame,
    'Pass rate': L.passRate,
    'Pass yards / game': L.passYdsPerGame,
    'Rush yards / game': L.rushYdsPerGame,
    'Yards per attempt': L.passYdsPerAtt,
    'Yards per carry': L.rushYdsPerCarry,
    'Special teams yards/game': L.stYdsPerGame,
    'FG attempts / game': L.fgAttPerGame,
    'FG accuracy': L.fgPct,
  };
  const v = map[label];
  return Number.isFinite(v) ? fmt(v, d) : '—';
}

function weatherPanel(b) {
  const wx = b.env.weather;
  return `
    <div class="panel">
      <div class="panel-head"><h2>Weather</h2>
        <span class="badge ${wx.known ? 'ok' : 'warn'}">${wx.known ? (wx.manual ? 'manual' : 'recorded') : 'unknown'}</span></div>
      <div class="panel-body">
        <p style="margin:0 0 11px;font-size:12px;color:var(--muted);line-height:1.5">
          The dataset only carries weather for games already played, so an upcoming slate has none.
          Enter a forecast to include it. Because the market total already reflects the forecast,
          a manual entry is applied at 60% weight.
        </p>
        <div class="controls" style="margin:0;gap:12px">
          <div class="field"><label for="wx-wind">Wind mph</label>
            <input type="number" id="wx-wind" min="0" max="45" value="${Number.isFinite(wx.wind) ? wx.wind : 0}" style="width:90px"></div>
          <div class="field"><label for="wx-temp">Temp °F</label>
            <input type="number" id="wx-temp" min="-10" max="110" value="${Number.isFinite(wx.temp) ? wx.temp : 65}" style="width:90px"></div>
          <button class="ghost" id="wx-apply" style="align-self:flex-end">Apply</button>
          <button class="ghost" id="wx-clear" style="align-self:flex-end">Clear</button>
        </div>
        <div class="footnote">Wind at 12 mph starts to bite; the passing effect is ${pct(1 - (b.env.stEffect.pass ?? 1), 1)} right now.</div>
      </div>
    </div>`;
}

function wireWeather() {
  $('#wx-apply')?.addEventListener('click', () => {
    state.settings.weather = {
      wind: Number($('#wx-wind').value) || 0,
      temp: Number($('#wx-temp').value) || 65,
      isDome: false,
    };
    rebuild();
  });
  $('#wx-clear')?.addEventListener('click', () => {
    state.settings.weather = null;
    rebuild();
  });
}

function availabilityPanel(b) {
  const groups = [b.game.away, b.game.home];
  const idx = state.data.seasons.get(b.season);
  return `
    <div class="panel">
      <div class="panel-head"><h2>Availability &amp; injuries</h2>
        <span class="badge warn">week ${b.week} report ${hasWeekReport(idx, b) ? 'released' : 'not released — using most recent'}</span></div>
      <div class="panel-body tight">
        <table class="mini">
          <thead><tr><th>Player</th><th>Team</th><th>Injury</th><th>Status</th><th>Plays</th><th>Override</th></tr></thead>
          <tbody>
            ${groups.map((t) => injuredPlayers(idx, t, b.week).map((e) => {
              const p = e.entry;
              const prob = p.p;
              const cls = prob >= 0.9 ? 'ok' : prob >= 0.5 ? 'warn' : 'bad';
              const override = state.settings.availabilityOverrides[p.id] || 'auto';
              return `<tr>
                <td>${esc(e.name)}</td>
                <td>${esc(t)}</td>
                <td style="color:var(--muted)">${esc(e.injury || '—')}</td>
                <td>${esc(p.status || 'no status')}${p.practice ? ` <span style="color:var(--dim)">(${esc(p.practice)})</span>` : ''}</td>
                <td><span class="badge ${cls}">${pct0(prob)}</span></td>
                <td>
                  <select data-override="${esc(p.id)}" style="padding:3px 6px;font-size:11px">
                    ${['auto', 'ACTIVE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT'].map((o) => `<option value="${o}" ${override === o ? 'selected' : ''}>${o === 'auto' ? 'auto' : o.toLowerCase()}</option>`).join('')}
                  </select>
                </td></tr>`;
            }).join('')).join('')}
          </tbody>
        </table>
        <div class="footnote" style="padding:8px 10px 12px">
          <strong style="color:var(--muted)">Out</strong> 2% · <strong style="color:var(--muted)">Doubtful</strong> 15% ·
          <strong style="color:var(--muted)">Questionable</strong> 55–88% depending on practice participation ·
          <strong style="color:var(--muted)">no status</strong> 100%. Availability is drawn per simulation and props are priced conditional on playing.
          Usage from a player unlikely to suit up is redistributed to healthy teammates at 80% of his share.
        </div>
      </div>
    </div>`;
}

function hasWeekReport(idx, b) {
  for (const [, entries] of idx.injuriesByTeamWeek) {
    if (entries[0]?.week === b.week) return true;
  }
  return false;
}

function injuredPlayers(idx, team, week) {
  const out = [];
  const seen = new Set();
  for (const [key, entries] of idx.injuriesByTeamWeek) {
    const [t, w] = key.split('|');
    if (t !== team) continue;
    for (const e of entries) {
      if (!e.status) continue;
      // prefer the target week; otherwise fall back to the latest reported week
      const existing = seen.has(e.id) ? out.find((x) => x.key === e.id) : null;
      if (existing) {
        if (Number(w) > existing.week) Object.assign(existing, { week: Number(w), entry: enrich(e, idx, week, Number(w)) });
        continue;
      }
      seen.add(e.id);
      out.push({ key: e.id, name: e.name, injury: e.injury, week: Number(w), entry: enrich(e, idx, week, Number(w)) });
    }
  }
  return out
    .filter((x) => x.week <= week)
    .sort((a, b2) => (a.entry.p ?? 1) - (b2.entry.p ?? 1));
}

function enrich(entry, idx, targetWeek, reportedWeek) {
  const p = entry.p ?? availabilityForExit(entry, reportedWeek, targetWeek);
  return { ...entry, p, stale: reportedWeek < targetWeek };
}

// local mirror of the model's availability rule so the table matches the engine
function availabilityForExit(entry, reportedWeek, targetWeek) {
  const status = (entry.status || '').toLowerCase();
  const practice = (entry.practice || '').toLowerCase();
  let p = 1;
  if (status === 'out') p = 0.02;
  else if (status === 'doubtful') p = 0.15;
  else if (status === 'questionable') {
    if (practice.includes('did not') || practice.includes('dnp')) p = 0.55;
    else if (practice.includes('limited')) p = 0.72;
    else if (practice.includes('full')) p = 0.88;
    else p = 0.75;
  }
  return p;
}

function wireAvailability() {
  document.querySelectorAll('select[data-override]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.override;
      if (sel.value === 'auto') delete state.settings.availabilityOverrides[id];
      else state.settings.availabilityOverrides[id] = sel.value;
      rebuild();
    });
  });
}

/* ---------------------------------------------------------------------- drawer */

function openDrawer(propId) {
  const p = state.board.props.find((x) => x.id === propId);
  if (!p) return;
  state.drawer = propId;
  const actual = state.board.game.played ? actualFor(p) : null;
  const ph = phrase(p);
  const sims = state.board.settings.sims.toLocaleString();
  const d = $('#drawer');

  d.innerHTML = `
    <div class="drawer-head">
      <div class="who">
        <h3>${esc(p.player)} <span class="pos-badge ${esc(p.pos)}">${esc(p.pos)}</span></h3>
        <div class="sub">${esc(p.team)} vs ${esc(p.opp)} · ${esc(p.marketLabel)} · ${p.games ?? ''} games in window · ${p.playProb < 0.9 ? `<span class="badge bad">plays ${pct0(p.playProb)}</span>` : '<span class="badge ok">expected to play</span>'}</div>
      </div>
      <button class="iconbtn" id="drawer-close" aria-label="Close">×</button>
    </div>
    <div class="drawer-body">
      ${state.mode === 'simple' ? `
      <div class="plain-lead">
        In <b>${pct0(p.threshold.prob)}</b> of ${sims} simulated games, ${esc(ph.over)}.
        His average is <b>${fmt(p.projection, p.decimals)} ${esc(ph.noun)}</b>.
      </div>` : ''}
      <div class="hero-stats">
        <div class="hero-stat"><div class="k">Projection</div><div class="v">${fmt(p.projection, p.decimals)}</div><div class="s">${esc(unitOf(p.market))} · median ${fmt(p.median, p.decimals)} · typical swing ±${fmt(p.sd, p.decimals)}</div></div>
        <div class="hero-stat"><div class="k">Over ${fmt(p.threshold.line, 1)}</div><div class="v acc">${pct(p.threshold.prob)}</div><div class="s">break-even price ${formatOdds(p.threshold.prob)}</div></div>
        <div class="hero-stat"><div class="k">Confidence</div><div class="v">${p.confidence.tier}<span style="font-size:12px;color:var(--muted)"> /100 · ${p.confidence.score}</span></div><div class="s">${esc(CONFIDENCE_NOTE[p.confidence.tier].split('.')[0])}</div></div>
      </div>

      ${actual !== null ? `<div class="callout-quiet" style="margin-bottom:14px"><span class="badge ${actual > p.threshold.line ? 'ok' : 'bad'}">${actual > p.threshold.line ? 'over hit' : 'under hit'}</span> Actual: <span class="num">${fmt(actual, p.decimals)}</span> at ${esc(p.marketLabel)}</div>` : ''}

      <div class="section-title">Simulated distribution of ${esc(p.marketLabel.toLowerCase())} · line at ${fmt(p.threshold.line, 1)}</div>
      ${histogramSvg(p)}

      <div class="section-title">Ladder — every standard line, in ${esc(unitOf(p.market))}</div>
      <table class="mini">
        <thead><tr><th>Line</th><th>Over</th><th>Under</th><th>Fair over</th><th>Fair under</th></tr></thead>
        <tbody>
          ${p.ladder.map((row) => `
            <tr class="${row.line === p.threshold.line ? 'hl' : ''}">
              <td>${fmt(row.line, 1)}</td>
              <td>${pct(row.pOver)}</td>
              <td>${pct(1 - row.pOver)}</td>
              <td>${formatOdds(row.pOver)}</td>
              <td>${formatOdds(1 - row.pOver)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="footnote">Highlighted row is the recommendation at your ${Math.round(state.board.settings.threshold * 100)}% floor. Fair prices are break-even; you need a better price than that to have an edge.</div>

      <div class="section-title">Why the number moved</div>
      <div id="factors">
        ${p.factors.map((f) => `
          <div class="factor">
            <span class="fl">${esc(f.label)} <span class="badge">${esc(f.kind)}</span></span>
            <span class="fv ${Math.abs((f.value ?? 1) - 1) < 0.002 ? 'neutral' : ''}">×${fmt(f.value, 3)}${f.tdValue ? ` · TD ×${fmt(f.tdValue, 3)}` : ''}</span>
            <span class="fd">${esc(f.detail)}</span>
          </div>`).join('')}
      </div>

      <div class="section-title">Usage &amp; role</div>
      <dl class="kv">
        ${p.usageRows
    ? p.usageRows.map((r) => `<dt>${esc(r.k)}</dt><dd>${esc(r.v)}</dd>`).join('')
    : `<dt>Target share</dt><dd>${pct(p.usage.targetShare, 1)}${p.usage.vacatedTargetShare > 0.002 ? ` <span style="color:var(--lime)">(+${(p.usage.vacatedTargetShare * 100).toFixed(1)}pp vacated)</span>` : ''}</dd>
        <dt>Carry share</dt><dd>${pct(p.usage.carryShare, 1)}${p.usage.vacatedCarryShare > 0.002 ? ` <span style="color:var(--lime)">(+${(p.usage.vacatedCarryShare * 100).toFixed(1)}pp)</span>` : ''}</dd>
        <dt>Snap share</dt><dd>${p.snapPct === null ? '—' : pct(p.snapPct, 1)}</dd>
        <dt>Projected team pass att</dt><dd>${fmt(p.teamVol?.attempts, 1)}</dd>
        <dt>Projected team carries</dt><dd>${fmt(p.teamVol?.carries, 1)}</dd>`}
        <dt>Naive baseline</dt><dd>${p.naive ? `${fmt(p.naive.mean, p.decimals)} avg → line ${fmt(p.naive.line, 1)}` : '—'}</dd>
      </dl>

      ${p.flags.length ? `
        <div class="section-title">Flags</div>
        ${p.flags.map((f) => `<div class="factor"><span class="fl"><span class="flagdot ${f.severity}"></span> ${esc(f.label)}</span><span class="fv">${esc(f.severity)}</span><span class="fd">${esc(f.detail)}</span></div>`).join('')}
      ` : ''}

      <div class="footnote">Availability source: ${esc(p.availability.source)}${p.availability.injury ? ` · ${esc(p.availability.injury)}` : ''}</div>
    </div>`;

  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  $('#drawer-close').addEventListener('click', closeDrawer);
}

function closeDrawer() {
  $('#drawer')?.classList.remove('open');
  $('#drawer')?.setAttribute('aria-hidden', 'true');
  $('#scrim')?.classList.remove('open');
  state.drawer = null;
}

function histogramSvg(p) {
  const h = p.histogram;
  const width = 500;
  const height = 120;
  const pad = 18;
  const maxD = Math.max(...h.density) || 1;
  const bw = width / h.density.length;
  let bars = '';
  for (let i = 0; i < h.density.length; i++) {
    const bh = (h.density[i] / maxD) * (height - pad * 2);
    const isTail = h.lo + (i + 1) * h.width <= p.threshold.line;
    bars += `<rect x="${(i * bw).toFixed(2)}" y="${(height - pad - bh).toFixed(2)}" width="${(bw - 1.2).toFixed(2)}" height="${Math.max(0, bh).toFixed(2)}" fill="${isTail ? 'rgba(200,247,81,0.30)' : 'rgba(200,247,81,0.62)'}"/>`;
  }
  const x = (v) => ((v - h.lo) / (h.hi - h.lo || 1)) * width;
  const lx = Math.max(0, Math.min(width, x(p.threshold.line)));
  const medX = Math.max(0, Math.min(width, x(p.median)));
  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Simulated distribution">
      <line x1="0" y1="${height - pad}" x2="${width}" y2="${height - pad}" stroke="#2a3546" stroke-width="1"/>
      ${bars}
      <line x1="${medX.toFixed(1)}" y1="${pad - 6}" x2="${medX.toFixed(1)}" y2="${height - pad}" stroke="#6fb3ff" stroke-width="1" stroke-dasharray="3 3"/>
      <line x1="${lx.toFixed(1)}" y1="${pad - 10}" x2="${lx.toFixed(1)}" y2="${height - pad}" stroke="#c8f751" stroke-width="1.6"/>
      <text x="2" y="${height - 5}" fill="#5d6779" font-size="10" font-family="monospace">${fmt(h.lo, p.decimals)}</text>
      <text x="${width - 2}" y="${height - 5}" fill="#5d6779" font-size="10" font-family="monospace" text-anchor="end">${fmt(h.hi, p.decimals)}</text>
      <text x="${medX.toFixed(1)}" y="${pad - 9}" fill="#6fb3ff" font-size="10" font-family="monospace" text-anchor="middle">median</text>
      <text x="${lx.toFixed(1)}" y="${pad - 24}" fill="#c8f751" font-size="10" font-family="monospace" text-anchor="middle">line</text>
    </svg>`;
}

/* ---------------------------------------------------------------------- method */

function renderMethod() {
  if (state.sport === 'nba') return renderNbaMethod();
  $('#view').innerHTML = `
    <div class="panel"><div class="panel-body prose">
      <h2>The idea: separate opportunity from efficiency</h2>
      <p>
        Almost every public prop model regresses a player's stat line on his own history. That
        conflates two different predictions and quietly double-counts opponent quality. This engine
        splits them:
      </p>
      <div class="formula">projected stat = projected opportunities x projected rate per opportunity

targets  = team dropbacks x target share x availability &amp; vacated-usage adjustments
catches  = Binomial(targets, catch rate)
yards    = catches x yards-per-catch
TDs      = Binomial(catches, TD per catch)</div>
      <p>
        Opportunity is the stable part: a receiver's target share and a back's carry share persist
        week to week far better than his efficiency does. Efficiency is the noisy part, so it gets
        shrunk hard toward the positional baseline. Every adjustment below lands on exactly one side
        of that multiplication, and each one is printed in the drawer with its multiplier so you can
        audit the number instead of trusting it.
      </p>

      <h2>Adjustments and their weights</h2>
      <table class="spec">
        <thead><tr><th>Factor</th><th>How it is computed</th><th>Where it applies</th></tr></thead>
        <tbody>
          <tr><td>Recency</td><td>Exponential decay, 0.10 per week over the last 8 games. Last week counts ~2x week 8.</td><td>volume and efficiency</td></tr>
          <tr><td>Shrinkage</td><td>Observed rate pulled toward the positional baseline with prior strength of 5 games (team rates 4, shares 3). A 2-game heater cannot move a projection far.</td><td>volume and efficiency</td></tr>
          <tr><td>Opponent defence</td><td>Opponent's yards-per-attempt-allowed and yards-per-carry-allowed relative to league, applied at 85% and itself regressed by the opponent's own sample (k=4 games). Applied to efficiency only, never to volume.</td><td>efficiency</td></tr>
          <tr><td>Implied team total</td><td>From the posted total and spread. Yardage scales as <code>index^0.5</code>, TDs as <code>index^0.75</code>, both clamped. This is the one place the market is used directly, and it is the single largest swing factor on a board.</td><td>efficiency / scoring</td></tr>
          <tr><td>Game script</td><td>Expected margin moves the pass/run split by 0.35pp of pass rate per point. Underdogs throw more; a 7-point underdog gains ~2.5pp of pass rate.</td><td>volume</td></tr>
          <tr><td>Pace</td><td>Team plays per game blended 60/40 with the opponent's plays faced, then scaled by <code>(total/league total)^0.35</code>.</td><td>volume</td></tr>
          <tr><td>Injuries</td><td>Probabilities by game status: Out 2%, Doubtful 15%, Questionable 55–88% by practice participation, no status 100%. Drawn per simulation; props are priced conditional on playing, because a scratch voids a bet rather than losing it. His usage is not deleted: it is handed to healthy teammates at 80% of his share.</td><td>volume and availability</td></tr>
          <tr><td>Special teams</td><td>Return yards per game vs league, converted to +/-0.35 expected points per 1.0 of index, applied to the implied total. It reaches the offence through field position and scoring, not as a separate multiplier.</td><td>environment</td></tr>
          <tr><td>Coaching</td><td>Two measured tendencies: the team's actual pass rate versus the rate expected from the spread (a pass-rate-over-expected proxy), and the kicker's team FG attempts per game. Coaching quality is folded into team EPA/play rather than guessed at.</td><td>volume</td></tr>
          <tr><td>Rivalry</td><td>Divisional games: efficiency x0.98, TDs x0.96. Deliberately small and labelled as a debated effect - familiarity compresses efficiency but the signal is weak against week-to-week noise.</td><td>efficiency</td></tr>
          <tr><td>Rest</td><td>+/-0.6% per day of rest differential, capped at 6 days. Partly already inside the market line.</td><td>efficiency</td></tr>
          <tr><td>Weather</td><td>Wind above 12 mph cuts passing up to 13% and kicking up to 22%; cold below 28F adds a smaller effect. Applied at full weight for recorded conditions, 60% for a manual forecast, because the market total already prices the forecast.</td><td>efficiency</td></tr>
        </tbody>
      </table>

      <h2>Why simulate instead of using a formula</h2>
      <p>
        A prop is not one distribution. Receiving yards are catches times yards-per-catch, where the
        catch count is binomial on a target count that is itself uncertain, and TDs are rarer events
        correlated with volume. Closing-form answers get the tails wrong, and the tails are the whole
        product. So each game runs a Monte Carlo:
      </p>
      <ul>
        <li><b>Shared game draws.</b> Pace and margin are drawn once per iteration and used by both teams, so a shootout lifts everyone and a slog suppresses everyone. This is what makes cross-player correlation real rather than assumed.</li>
        <li><b>Usage competes.</b> Target and carry shares are perturbed then rescaled across teammates, so the team's throws are divided among the same receivers. Two teammates cannot both have season-best games.</li>
        <li><b>Efficiency is random too.</b> Yards per catch and per carry are drawn lognormally, which produces the right-skewed yardage distributions you actually see.</li>
        <li><b>Availability is drawn.</b> A Questionable player is absent in a fraction of iterations, and his probability is computed over the iterations he plays.</li>
      </ul>

      <h2>The ranking rule</h2>
      <div class="callout">
        Sorting by raw probability finds the most trivial bet on the board. Instead, for every player
        and market this engine reports <b>the highest standard line he still clears at your chosen
        probability floor</b> - the worst number you would still take. That is comparable across
        players, comparable to a price at your book, and it is what the board is ranked on.
      </div>
      <p>
        Lines come from a standard ladder (receptions in 1s, yardage in 5s, passing yards in 25s).
        That matters: if the engine invented its own line from its own projection, the probability
        would sit at 50% by construction and the ranking would be meaningless.
      </p>
      <p>
        <b>vs naive</b> shows how much the entire adjustment stack moved the recommended line against
        the same distribution shifted to the player's raw season average. Positive means the model is
        asking for a number his average alone would never have justified.
      </p>

      <h2>What is deliberately not modelled</h2>
      <ul>
        <li>Red-zone target and carry splits - outside this dataset, so TD rates come from observed TD-per-touch, shrunk hard (prior strength 8 games).</li>
        <li>Offensive line injuries, depth-chart churn, and backup-QB-specific efficiency. A team starting a backup quarterback will not be priced correctly.</li>
        <li>Same-game parlay correlation across props. The simulation has the raw ingredients, but pricing combos is a separate product.</li>
        <li>Any prop price. There are no prop odds in this dataset, so the output is a probability and a break-even price - not a verdict on whether a bet is good.</li>
      </ul>

      <h2>How to use it honestly</h2>
      <p>
        A probability is only useful if it is calibrated. The Backtest tab rebuilds each past week
        using only information available before that week and reports how often the recommended lines
        actually cleared. If 65% props hit 65% of the time, the engine is earning its keep. If they hit
        55%, then the model's edges are noise and the honest move is to ignore the board.
      </p>
      <p>
        Remember what a probability is not: a price. A 78% prop at -500 is a losing bet and a 55% prop
        at +120 is a good one. Every row shows its break-even price for exactly that reason.
      </p>
    </div></div>`;
}

/* -------------------------------------------------------------------- backtest */

function renderBacktest() {
  if (state.sport === 'nba') return renderNbaBacktestNote();
  const bt = state.backtest;
  $('#view').innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Walk-forward backtest</h2>
        <span class="badge">season ${state.season}</span></div>
      <div class="panel-body">
        <p style="margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.55;max-width:82ch">
          Rebuilds every completed week using only the games played before it, takes the line the board
          would have recommended at your ${Math.round(state.settings.threshold * 100)}% floor, and checks
          what actually happened. Players with less than 3 games of role and any availability doubt are
          excluded, so this scores the projection core rather than injury luck.
        </p>
        <div class="controls" style="margin:0">
          <button class="primary" id="bt-run" ${state.backtestRunning ? 'disabled' : ''}>
            ${state.backtestRunning ? '<span class="spin"></span> running…' : (bt ? 'Run again' : 'Run backtest')}</button>
          <span class="footnote" id="bt-progress" style="margin:0"></span>
        </div>
        ${state.backtestError ? `<div class="errbox" style="margin-top:12px">${esc(state.backtestError)}</div>` : ''}
        ${state.backtestRunning ? '<div class="progress"><i id="bt-bar" style="width:2%"></i></div>' : ''}
      </div>
    </div>
    ${bt ? backtestResults(bt) : '<div class="empty">No backtest yet. Use a smaller simulation count if it feels slow — 1,200 per game is plenty for calibration.</div>'}`;

  $('#bt-run')?.addEventListener('click', runBacktestClick);
}

async function runBacktestClick() {
  state.backtestRunning = true;
  state.backtestError = null;
  renderBacktest();

  try {
    const result = await runBacktest({
      data: state.data,
      season: state.season,
      settings: { threshold: state.settings.threshold, sims: 1200, usePrior: state.season === CURRENT_SEASON },
      onProgress: ({ gamesDone, totalGames }) => {
        const el = $('#bt-progress');
        const bar = $('#bt-bar');
        if (el) el.textContent = `game ${gamesDone} of ${totalGames}…`;
        if (bar) bar.style.width = `${Math.max(2, (gamesDone / Math.max(totalGames, 1)) * 100)}%`;
      },
    });
    state.backtest = result;
  } catch (err) {
    console.error(err);
    state.backtestError = err?.message || String(err);
  } finally {
    state.backtestRunning = false;
    renderBacktest();
  }
}

function backtestResults(bt) {
  if (!bt.n) return '<div class="empty">No scorable props were produced for this season.</div>';
  const errColor = (e) => (Math.abs(e) <= Math.max(0.03, Math.abs(e) * 0) ? 'var(--lime)' : Math.abs(e) <= 0.06 ? 'var(--amber)' : 'var(--red)');
  return `
    <div class="panel" style="margin-top:14px">
      <div class="panel-head"><h2>Result</h2><span class="badge">${bt.n.toLocaleString()} props scored</span></div>
      <div class="panel-body">
        <div class="bt-grid">
          <div class="bt-stat"><div class="k">Average call</div><div class="v">${pct(bt.avgPredicted)}</div><div class="s">what the board claimed</div></div>
          <div class="bt-stat"><div class="k">Actual hit rate</div><div class="v">${pct(bt.hitRate)}</div><div class="s">what happened</div></div>
          <div class="bt-stat"><div class="k">Calibration gap</div><div class="v" style="color:${errColor(bt.calibrationError)}">${bt.calibrationError > 0 ? '+' : ''}${(bt.calibrationError * 100).toFixed(1)}pp</div><div class="s">positive = model is conservative</div></div>
          <div class="bt-stat"><div class="k">Brier score</div><div class="v">${bt.brier.toFixed(4)}</div><div class="s">0.25 = always saying 50%</div></div>
        </div>

        <div class="section-title">Reliability — predicted vs actual, by probability bucket</div>
        ${bt.buckets.map((b) => `
          <div class="cal-row">
            <span class="lbl">${esc(b.label)}</span>
            <span class="cal-track">
              <span class="cal-pred" style="width:${(b.predicted * 100).toFixed(1)}%"></span>
              <span class="cal-act" style="left:${(b.actual * 100).toFixed(1)}%"></span>
            </span>
            <span class="n">n=${b.n}</span>
            <span class="err" style="color:${errColor(b.error)}">${b.error > 0 ? '+' : ''}${(b.error * 100).toFixed(1)}pp</span>
          </div>`).join('')}
        <div class="footnote">Blue edge marks the predicted rate, the green bar is where outcomes actually landed, and ± is the gap with its sample size. Small buckets swing hard: at n=40 a 65% call has a standard error of ±7.5pp, so read buckets with large n.</div>

        <div class="section-title">By market</div>
        <table class="spec">
          <thead><tr><th>Market</th><th>n</th><th>Predicted</th><th>Actual</th><th>Gap</th><th>Brier</th></tr></thead>
          <tbody>
            ${bt.markets.map((m) => `
              <tr><td>${esc(m.label)}</td><td class="num">${m.n}</td>
              <td class="num">${pct(m.predicted)}</td><td class="num">${pct(m.actual)}</td>
              <td class="num" style="color:${errColor(m.actual - m.predicted)}">${(m.actual - m.predicted) > 0 ? '+' : ''}${((m.actual - m.predicted) * 100).toFixed(1)}pp</td>
              <td class="num">${m.brier.toFixed(4)}</td></tr>`).join('')}
          </tbody>
        </table>

        <div class="section-title">By week</div>
        <table class="spec">
          <thead><tr><th>Week</th><th>n</th><th>Predicted</th><th>Actual</th><th>Gap</th></tr></thead>
          <tbody>
            ${bt.perWeek.map((w) => `
              <tr><td>Week ${w.week}</td><td class="num">${w.n}</td>
              <td class="num">${pct(w.predicted)}</td><td class="num">${pct(w.actual)}</td>
              <td class="num">${(((w.actual - w.predicted)) * 100).toFixed(1)}pp</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------- nba views */

function renderNbaMatchup(b) {
  $('#view').innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Team profile — ${esc(b.game.away)} @ ${esc(b.game.home)}</h2>
        <span class="badge">${esc(b.season)}${Number.isFinite(b.env.total) ? ` · total ${b.env.total}` : ''}</span></div>
      <div class="panel-body tight">
        <table class="spec">
          <thead><tr><th>Metric</th><th>${esc(b.game.away)}</th><th>${esc(b.game.home)}</th></tr></thead>
          <tbody>
            ${b.matchupRows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${fmt(r.away, r.decimals)}</td><td class="num">${fmt(r.home, r.decimals)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="layout" style="margin-top:14px">
      <div>${nbaInjuryPanel(b)}
        <div class="footnote">Injuries come from ESPN's report for every team, filtered to this matchup. Availability is drawn per simulation.</div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-head"><h2>Provenance &amp; limitations</h2></div>
          <div class="panel-body"><div class="notes">${b.notes.map((n) => `<div class="note"><span class="nk">${esc(n.kind)}</span><span>${esc(n.text)}</span></div>`).join('')}</div></div>
        </div>
      </div>
    </div>`;
}

function nbaInjuryPanel(b) {
  const rows = (b.noteRows || []).flatMap((t) => t.players.map((p) => ({ team: t.team, ...p })));
  return `
    <div class="panel">
      <div class="panel-head"><h2>Injury report</h2>
        <span class="badge ${rows.length ? 'warn' : 'ok'}">${rows.length ? `${rows.length} listed` : 'nobody listed'}</span></div>
      <div class="panel-body tight">
        ${rows.length
    ? `<table class="mini"><thead><tr><th>Player</th><th>Team</th><th>Status</th><th>Note</th><th>Plays</th></tr></thead><tbody>
            ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.team)}</td><td>${esc(r.status)}</td>
              <td style="text-align:left;color:var(--muted)">${esc(r.injury || '—')}</td>
              <td>${Math.round(r.playProb * 100)}%</td></tr>`).join('')}
          </tbody></table>`
    : '<div class="empty">Nobody on these two rosters is on the injury report.</div>'}
        <div class="footnote" style="padding:8px 10px 12px">ESPN carries two states for the NBA:
          <b style="color:var(--muted)">Out</b> at 2% to play and <b style="color:var(--muted)">Day-To-Day</b> at 62%.
          Props are priced conditional on playing, so a late scratch voids the bet rather than losing it.</div>
      </div>
    </div>`;
}

function renderNbaMethod() {
  $('#view').innerHTML = `
    <div class="panel"><div class="panel-body prose">
      <h2>The idea: in basketball, minutes are the bet</h2>
      <p>
        The NFL side splits a stat into opportunities × rate per opportunity, because a receiver's
        target share persists. Basketball is blunter about what decides your wager:
      </p>
      <div class="formula">projected stat = projected minutes × rate per minute

minutes = recency-weighted this season, blended with last season,
          shrunk toward the positional baseline, then
          × blowout script × back-to-back
points  = field goals (split into twos and threes) + free throws
PRA     = the same three draws added together, so it stays correlated</div>
      <p>
        Minutes are the NBA's version of volume, and they are far less stable than an NFL snap count:
        foul trouble, a blowout, a back-to-back, or a coach deciding to look at a rookie. So the minutes
        model gets the care, and every multiplier below is printed in the drawer for each prop, so the
        number can be audited rather than trusted.
      </p>

      <h2>Adjustments and their weights</h2>
      <table class="spec">
        <thead><tr><th>Factor</th><th>How it is computed</th><th>Where it applies</th></tr></thead>
        <tbody>
          <tr><td>Recency</td><td>Exponential decay of 0.9 per week: a game five days ago weighs about half a game from yesterday.</td><td>minutes and rates</td></tr>
          <tr><td>Shrinkage</td><td>Rates are pulled toward the positional baseline in this matchup with a prior of 4 games, so a two-game heater cannot move a projection far.</td><td>rates</td></tr>
          <tr><td>Last season</td><td>Blended in with a weight that decays as the current sample grows (0.5 at zero games). In October this does most of the work, because nobody has played enough games yet.</td><td>minutes and rates</td></tr>
          <tr><td>Pace</td><td>Both teams' possessions per game against the two-team baseline, applied linearly to every counting market: a fast game lifts everyone on the floor.</td><td>all markets</td></tr>
          <tr><td>Opponent defence</td><td>Points allowed per game against the baseline, applied as a square root, so a soft defence moves scoring without dominating it.</td><td>points</td></tr>
          <tr><td>Opponent rebounding</td><td>Their rebounds per game against the baseline, inverted and applied at a 0.35 power: a team that takes every board leaves fewer for him.</td><td>rebounds</td></tr>
          <tr><td>Opponent turnovers</td><td>Their turnover ratio against the baseline at 0.4 power, because loose hands are where steals come from.</td><td>steals</td></tr>
          <tr><td>Blowout script</td><td>1% of minutes per point beyond a 9-point margin, floored at 85%, drawn from the same margin as the rest of the game.</td><td>minutes</td></tr>
          <tr><td>Back-to-back</td><td>0.96 on minutes, 0.93 for players 33 or older, detected from the team's own game dates.</td><td>minutes</td></tr>
          <tr><td>Injuries</td><td>Out 2%, Day-To-Day 62%, nothing listed 97%. Drawn per simulation, and probabilities are conditional on playing.</td><td>availability</td></tr>
          <tr><td>Shooting rates</td><td>Two-point, three-point and free-throw percentages are each shrunk with a prior of 6 games toward 52%, 34% and 78%. Shooting is the noisiest thing in the sport.</td><td>points, threes</td></tr>
        </tbody>
      </table>

      <h2>Why simulate instead of using a formula</h2>
      <p>
        A closed form could give you the mean. It cannot give you the tails, and the tails are the
        product. Each iteration draws a plausible game:
      </p>
      <ul>
        <li><b>Pace and margin are shared.</b> Drawn once per iteration and used by both teams, so a fast game lifts everyone and a blowout suppresses both sides' minutes.</li>
        <li><b>Minutes are drawn, not fixed.</b> Around the projection with his own volatility, then scaled by the same blowout draw that moved the margin.</li>
        <li><b>Points are built like a box score.</b> Field goals split into twos and threes, plus free throws: a quiet shooting night and a heavy-minutes night cannot both land at once.</li>
        <li><b>PRA is the same draws added up,</b> so correlated markets stay correlated instead of being priced as if they were independent.</li>
      </ul>

      <h2>The ranking rule</h2>
      <div class="callout">
        Sorting by raw probability finds the most trivial bet on the board. For every player and market
        this engine reports <b>the highest standard line he still clears at your floor</b> — the worst
        number you would still take — and the board is ranked on that. Lines come from the grids books
        post, not from the projection, which is what keeps the probabilities honest.
      </div>

      <h2>What is deliberately not modelled</h2>
      <ul>
        <li>Lineups and rotations: a surprise starter, a mid-game injury, or a coach resting four players is not anticipated.</li>
        <li>Three-point defence and assists allowed: not in these feeds, so those markets ride on pace and his own rates.</li>
        <li>Any prop price. There are no prop odds in this data, so the output is a probability and a break-even price, not a verdict.</li>
        <li>Overtime explicitly: it reaches the distributions only through the right tail, not as an extra period.</li>
      </ul>

      <h2>Not calibrated yet</h2>
      <p>
        The NFL board has a walk-forward backtest. <b>This one does not.</b> Until it does, treat every
        basketball percentage as unvalidated: use the ranking and the break-even column, and bet nothing
        the price does not clearly beat.
      </p>
    </div></div>`;
}

function renderNbaBacktestNote() {
  $('#view').innerHTML = `
    <div class="panel"><div class="panel-head"><h2>Walk-forward backtest</h2>
      <span class="badge warn">not built for nba</span></div>
      <div class="panel-body">
        <p style="margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.6;max-width:82ch">
          The NFL side rebuilds every completed week using only games played before it, and reports how
          often the recommended lines actually cleared. The NBA engine does not have that yet, so its
          probabilities are <b>measured by nothing</b>. That is worth saying plainly rather than
          borrowing the NFL numbers.
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.6;max-width:82ch">
          What it would take: for each completed game, fetch both rosters and each player's logs up to
          that date, rebuild the board, and score the recommended line against the real box score.
          The data is already being fetched — the gap is the harness, not the inputs.
        </p>
        <p style="margin:0;font-size:13px;color:var(--text)">
          Until then: the ranking, the confidence tiers and the break-even prices are still useful.
          The percentages are a claim, not a record.
        </p>
      </div>
    </div>`;
}

boot();
