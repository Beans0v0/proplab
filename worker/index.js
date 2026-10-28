/**
 * PropLab edge host. Same contract as Server.java, minus the disk.
 *
 *   GET /                 -> static files from ./public (via the ASSETS binding)
 *   GET /api/data?key=... -> nflverse open data (CSV)
 *   GET /api/nba?key=...  -> ESPN public JSON
 *   GET /api/health       -> liveness
 *
 * The proxy exists because the browser cannot fetch these files directly (no CORS
 * headers on GitHub release assets). The key whitelist is the SSRF guard: every
 * upstream URL is either a fixed map entry or assembled from digits only, so a
 * caller can never point this at an arbitrary address.
 *
 * Caching replaces .cache/: Cloudflare's edge cache holds each response for the
 * same TTLs the Java server used, so repeated views cost no upstream fetches.
 */

const NFL_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

/** Fixed allowlist. Keys map to exact URLs; nothing here is caller-controlled. */
const NFL = new Map([['games', `${NFL_BASE}/schedules/games.csv`]]);
for (const season of [2026, 2025, 2024]) {
  NFL.set(`player_${season}`, `${NFL_BASE}/stats_player/stats_player_week_${season}.csv`);
  NFL.set(`team_${season}`, `${NFL_BASE}/stats_team/stats_team_week_${season}.csv`);
  NFL.set(`inj_${season}`, `${NFL_BASE}/injuries/injuries_${season}.csv`);
  NFL.set(`snaps_${season}`, `${NFL_BASE}/snap_counts/snap_counts_${season}.csv`);
}

/**
 * NBA keys are validated by pattern and rebuilt from numbers only — the same
 * SSRF guarantee as the fixed map above. Source is ESPN's public JSON.
 */
function nbaUrl(key) {
  if (key === 'injuries') {
    return 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
  }
  if (key === 'teams') {
    return 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams';
  }
  let m = /^scoreboard:(\d{8}(?:-\d{8})?)$/.exec(key);
  if (m) return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${m[1]}`;

  m = /^roster:(\d{1,6})$/.exec(key);
  if (m) return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${m[1]}/roster`;

  m = /^teamschedule:(\d{1,6})$/.exec(key);
  if (m) return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${m[1]}/schedule`;

  // ESPN's core and site.web hosts answer 403 to Cloudflare's egress, so team statistics and
  // game logs come from site.api, which does serve them. Game logs there are byte-identical;
  // team statistics arrive in a different shape and without a season filter, both of which
  // public/engine/nba/data.js handles.
  m = /^teamstats:(\d{1,6}):(\d{4})$/.exec(key);
  if (m) {
    return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${m[1]}/statistics`;
  }

  m = /^player:(\d{1,9}):(\d{4})$/.exec(key);
  if (m) {
    return `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${m[1]}/gamelog?season=${m[2]}`;
  }
  return null;
}

/** Live feeds expire quickly; player history does not. Mirrors Server.ttlSeconds. */
function ttlSeconds(key) {
  if (key.startsWith('scoreboard')) return 600;
  if (key.startsWith('injur')) return 900;
  if (key.startsWith('roster')) return 21600;
  if (key.startsWith('teamstats')) return 3600;
  return 86400;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' };

function fail(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

/**
 * Stream the upstream body through so a 5 MB CSV never has to fit in memory.
 * cacheEverything keeps the edge copy warm for cacheTtl seconds.
 */
async function proxy(target, { cacheTtl, contentType, browserCache }) {
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        // Public data, no credentials. ESPN's core API rejects unknown clients
        // coming from datacenter ranges, so present as a browser and send a referer.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        referer: 'https://www.espn.com/',
      },
      cf: { cacheEverything: true, cacheTtl },
    });
  } catch (err) {
    return fail(502, `upstream fetch failed: ${err && err.message ? err.message : err}`);
  }

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 160).replace(/\s+/g, ' ');
    return fail(502, `upstream status ${upstream.status}: ${detail}`);
  }

  const headers = new Headers();
  headers.set('content-type', contentType || upstream.headers.get('content-type') || 'application/octet-stream');
  headers.set('cache-control', browserCache);
  headers.set('x-content-type-options', 'nosniff');
  return new Response(upstream.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true, runtime: 'workers' }), { headers: JSON_HEADERS });
    }

    if (pathname === '/api/data') {
      const key = url.searchParams.get('key');
      const target = key ? NFL.get(key) : null;
      if (!target) return fail(400, `unknown key: ${key}`);
      return proxy(target, { cacheTtl: 86400, contentType: 'text/csv; charset=utf-8', browserCache: 'public, max-age=86400' });
    }

    if (pathname === '/api/nba') {
      const key = url.searchParams.get('key');
      const target = key ? nbaUrl(key) : null;
      if (!target) return fail(400, `unknown nba key: ${key}`);
      return proxy(target, {
        cacheTtl: ttlSeconds(key),
        contentType: 'application/json; charset=utf-8',
        browserCache: 'no-store',
      });
    }

    if (pathname.startsWith('/api/')) return fail(404, `no such route: ${pathname}`);

    return env.ASSETS.fetch(request);
  },
};
