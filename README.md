# PropLab

An NFL player-prop probability engine that runs locally. It pulls real season data,
projects each player's opportunity and efficiency, simulates the game thousands of
times, and ranks props by **the highest standard line the player still clears at your
chosen probability floor** — then scores itself against what actually happened.

```
java Server.java          # then open http://127.0.0.1:8787
```

That is the whole install. No Node, no Python, no package manager, no API key, no
account. The only requirement is a JDK (built and tested on JDK 25). `Server.java`
serves the static site and proxies nflverse open data into `.cache/` on first run.

There is also a hosted copy, no install required:
**https://site-a797a758dcfe4e238a1db2b7157ee16d.freebuff.page**

## Why Java

The machine this was built on had no Node, no Python, no Bun, no Go, no Ruby — only a
JDK. Rather than add a toolchain, the host is a single dependency-free file, and the
engine is plain ES modules the browser runs directly. There is no build step at all:
edit a file, reload the page.

## Layout

| Path | What it is |
| --- | --- |
| `Server.java` | Static file host + whitelisted, disk-cached proxy for nflverse datasets (local use) |
| `worker/index.js` | The same two proxy routes as a Cloudflare Worker — edge cache instead of `.cache/` |
| `sites.manifest.json` | Deploy manifest for the hosted build (worker + `public/` as static assets) |
| `public/index.html` | Page shell |
| `public/styles.css` | Styling |
| `public/app.js` | UI: slate picker, prop board, matchup view, method, backtest runner |
| `public/engine/csv.js` | Column-wise CSV parser (handles the quoted headshot URLs that contain commas) |
| `public/engine/data.js` | Loads and indexes the season; derives defence-allowed by inversion |
| `public/engine/model.js` | League priors, team profiles, injury availability rules |
| `public/engine/players.js` | Per-player volume, efficiency, vacated usage, factor ledger |
| `public/engine/sim.js` | Monte Carlo: shared game draws, teammate usage competition |
| `public/engine/props.js` | Market definitions, standard line ladders, fair odds, confidence |
| `public/engine/board.js` | Assembles a game board; re-derives lines on threshold change |
| `public/engine/backtest.js` | Walk-forward calibration |
| `public/engine/nba/data.js` | NBA data layer: slate and odds, rosters, team form, injuries, per-player logs (two seasons) |
| `public/engine/nba/model.js` | NBA projections: minutes, per-minute rates, opponent/pace/script/rest adjustments |
| `public/engine/nba/sim.js` | NBA Monte Carlo: shared pace and script, minutes uncertainty, box-score decomposition |
| `public/engine/nba/markets.js` | NBA markets, families and plain-language phrasing |
| `public/engine/nba/board.js` | Assembles an NBA board into the same prop shape the UI renders |

## The hosted build

`worker/index.js` is a port of the two routes in `Server.java`: the same key allowlist,
the same URL construction from digits only, the same TTLs. The only difference is that
Cloudflare's edge cache replaces the `.cache/` directory, and responses are streamed
through rather than buffered, so a 5 MB CSV never has to fit in memory.

Two ESPN hosts — `sports.core.api.espn.com` and `site.web.api.espn.com` — answer **403 to
Cloudflare's egress** while answering 200 to a home connection. The hosted build therefore
reads everything from `site.api.espn.com`, where game logs and the injury feed are
byte-identical, and compensates for the two things that host does differently:

- **Team statistics arrive in another shape and with no season filter.** Both shapes are
  parsed. Pace, turnover ratio and offensive rebound rate are derived from the published
  box-score averages using the standard possession estimate
  (`FGA + 0.44·FTA − OREB + TOV`).
- **A prior-season team statistics call returns the current season.** That is detected by
  comparing the two payloads and the prior profile is dropped, so the baseline falls back to
  the current season instead of last year's numbers being silently mislabelled. Per-player
  prior-season logs come from the game-log endpoint and are unaffected.

The local `java Server.java` build still talks to the core API, so it gets ESPN's own pace
figure and a real prior-season team profile. Pace can differ in the second decimal between
the two builds; nothing else does.

## Reading the board

There is one engine and two reading levels, switched by **Detail level** in the top bar:

- **Simple** (default) — one card per prop, written as a sentence: *"Expects 1.8 passing
touchdowns. In 84% of 6,000 simulated games, he threw 1 or more touchdowns."* Every number
carries its unit, the line is explained as *the highest line he cleared that often*, and the
break-even price comes with its multiple (x1.15 your money). A **What do these numbers mean?**
panel at the top of the board walks through the projection, the percentage, the line, the price
and the confidence score using a real prop from the current game.
- **Expert** — the dense table with `Proj` (with units), `Line`, `P(over)`, `Conf`, `vs naive`,
`Fair price` and `Market`, plus sortable columns and the confidence tiers.

The numbers are identical in both; only the presentation changes. Clicking any row (either mode)
opens the drawer with the full distribution, the ladder and the factor ledger.

Above the board, the **Top picks** panel is the curated short list for the selected game. It
ranks by chance of hitting and excludes, in this order: rows where no standard line clears your
floor, players carrying an injury or sample-size flag, and anything whose break-even price is
worse than -500 (at that juice you are paying a fee rather than taking a bet). It shows one prop
per player, because two props on the same player rise and fall together. It respects the market
and team chips, so filtering to one team gives that team's picks. If nothing qualifies it says so
instead of padding the list.

## NBA mode

Switch **Sport** in the top bar. It is the same engine and the same UI — same board, same top
picks panel, same drawer, same ranking rule — with a different data layer and a different
projection, because basketball's constraint is not the same shape as football's.

**Where the data comes from.** ESPN's public JSON feeds: scoreboard (with DraftKings spread and
total), rosters, team schedule, team and per-player statistics, and the league-wide injury report.
No API key and no scraping of rendered pages — these are the endpoints espn.com's own site calls.
`Server.java` proxies them under pattern-validated keys (`player:<id>:<season>`, `roster:<id>`,
`scoreboard:<yyyymmdd>`, ...) built from digits only, so the proxy still cannot be pointed at an
arbitrary URL, and it caches each response on disk with a per-key TTL (10 minutes for the
scoreboard, 15 for injuries, 6 hours for rosters, a day for game logs).

**Two seasons, always.** The 2026-27 season is a week old, so a three-game sample cannot describe
anyone's role. Current-season logs are blended with all of last season, weighted so the prior fades
as the current sample grows — the same idea as the NFL side's `usePrior`. Preseason and playoff
games are excluded, because rotations and minutes limits are not the same animal.

**The model.** `stat = projected minutes × rate per minute`. Minutes are recency-weighted,
blended with last season, shrunk toward the positional baseline in that matchup, then adjusted for
the blowout script (from the posted spread), back-to-backs and age. Rates are shrunk with a prior of
4 games; shooting percentages with a prior of 6. Pace and both teams' scoring, rebounding and
turnover rates come from ESPN's team statistics, used as ratios against the two-team baseline.

**The simulation** draws pace and margin once per iteration and shares them across both teams,
draws each player's minutes around his projection, then builds the box score the way a box score is
built — field goals split into twos and threes, plus free throws — so a cold shooting night and a
heavy-minutes night cannot both land at once. PRA is the same three draws added together, which is
why it stays correlated.

**Markets:** points, rebounds, assists, threes made, PTS+REB+AST, steals and blocks, on the line
grids books post.

**What the NBA side does not have yet:** no walk-forward backtest (the Backtest tab says so rather
than borrowing the NFL numbers), no lineup-aware minutes model, and no opponent three-point defence
or assists-allowed adjustment. There are no prop prices in this data either, so the output is a
probability and a break-even price, not a verdict.

## Data

All of it is [nflverse](https://github.com/nflverse/nflverse-data) open data (CC-BY-4.0),
fetched by `Server.java` and cached in `.cache/`:

- `games.csv` — schedules, closing spreads and totals, roof, temp, wind, rest days, coaches, divisional flag
- `stats_player_week_{season}.csv` — per-player weekly box scores (targets, carries, air yards, EPA, snap-adjacent usage)
- `stats_team_week_{season}.csv` — per-team weekly offence and special teams
- `snap_counts_{season}.csv` — offensive snap share
- `injuries_{season}.csv` — practice and game status

Two things worth knowing about how this data is used:

1. **Defence-allowed is derived by inversion.** Team A's offensive line in a game *is*
   what team B's defence allowed that week, so the two sides reconcile exactly instead
   of being scraped from a second source.
2. **The player file has quoted fields containing commas.** Naive comma splitting
   yields 151 fields against a 150-column header and silently shifts every column after
   it. This bit me during development; the parser handles quoting properly.

## The logic

### 1. Split opportunity from efficiency

```
projected stat = projected opportunities x projected rate per opportunity

targets  = team dropbacks x target share x availability & vacated-usage adjustments
catches  = Binomial(targets, catch rate)
yards    = catches x yards-per-catch
TDs      = Binomial(catches, TD per catch)
```

Opportunity is the predictable part — target and carry shares persist week to week far
better than efficiency does. Splitting them means each adjustment applies to exactly one
side of the multiplication, which is also what makes the "why" panel possible.

### 2. Adjustments and their weights

| Factor | How | Applied to |
| --- | --- | --- |
| Recency | Exponential decay 0.10/week over the last 8 games | both |
| Shrinkage | Toward positional/league baseline, prior strength 3–8 games depending on stability | both |
| Opponent defence | Yards-per-attempt and yards-per-carry allowed vs league, at 85%, itself regressed by the opponent's sample (k=4) | efficiency only |
| Implied team total | From the posted total and spread; yardage `index^0.5`, TDs `index^0.75`, clamped | efficiency/scoring |
| Game script | Expected margin moves the pass/run split 0.35pp of pass rate per point | volume |
| Pace | 60/40 blend of own plays and opponent's plays faced, scaled by `(total/league)^0.35` | volume |
| Injuries | Out 2%, Doubtful 15%, Questionable 55–88% by practice participation; drawn per simulation, props priced conditional on playing | volume/availability |
| Vacated usage | The expectation of an absent teammate's share moves to healthy teammates at 80% | volume |
| Special teams | Return yards vs league → ±0.35 expected points per 1.0 of index, into the implied total | environment |
| Coaching | Measured pass rate versus the rate expected from the spread, plus team FG attempts per game | volume |
| Rivalry | Divisional games: efficiency ×0.98, TDs ×0.96 (small, labelled as debated) | efficiency |
| Rest | ±0.6% per day of rest differential, capped at 6 | efficiency |
| Weather | Wind >12mph cuts passing up to 13% and kicking up to 22%; full weight for recorded conditions, 60% for a manual forecast | efficiency |

Shares are shrunk toward **the share implied by the player's own per-game volume**, never
toward zero. Shrinking to zero biases every low-sample player downward in a way that is
invisible until you notice a 1,100-yard back projected for six carries.

Per-player allocations are then scaled to the team's projected volume. Without that pass,
a roster's projected targets summed to 57 on a team projected for 34 throws.

### 3. Simulate rather than solve

A prop is not one distribution. Receiving yards are catches × yards-per-catch, where the
catch count is binomial on an uncertain target count, and TDs are rarer events correlated
with volume. Closing-form answers get the tails wrong, and the tails are the product.

- **Shared game draws.** Pace and margin are drawn once per iteration and used by both
  teams, so a shootout lifts everyone. That is where cross-player correlation comes from.
- **Usage competes.** Target and carry shares are perturbed then rescaled across teammates,
  so two receivers cannot both have season-best games.
- **Availability is drawn.** A Questionable player is absent in a fraction of iterations and
  his probability is computed over the iterations he plays.
- **Players unlikely to play are dropped.** A conditional probability for someone who is not
  playing is not a bet, so props below 25% play probability never reach the board.

### 4. The ranking rule

Sorting by raw probability alone finds the most trivial bet on the board. For every player
and market the engine reports **the highest standard line he still clears at your chosen
floor** — the worst number you would still take — and ranks on that. Ladders are restricted
to lines a book would actually post (receptions in 1s, yardage in 5s, passing yards in 25s);
if the engine invented its own line from its own projection, the probability would sit at
50% by construction and the ranking would mean nothing.

`vs naive` compares that line against the same distribution anchored to the player's raw
season average, so you can see where the adjustment stack is actually doing work.

## Calibration (it is measured, not asserted)

The Backtest tab rebuilds each completed week using only games played before it, takes the
line the board would have recommended, and checks the result. Season 2026, weeks 4–7:

| | Value |
| --- | --- |
| Props scored | 2,193 |
| Average call | 61.9% |
| Actual hit rate | 58.5% |
| Calibration gap | −3.4pp |
| Brier score | 0.2218 (0.25 = always saying 50%) |

By probability bucket:

| Bucket | n | Predicted | Actual |
| --- | --- | --- | --- |
| 50–60% | 168 | 56.5% | 50.6% |
| 60–70% | 638 | 66.2% | 63.2% |
| 70–80% | 623 | 74.2% | 67.7% |
| 80–90% | 239 | 83.9% | 74.1% |
| 90–100% | 37 | 91.6% | 89.2% |

By market: **Anytime TD is exactly calibrated (31.7% predicted, 31.7% actual, n=448)** and
passing yards, passing TDs and interceptions land *above* their predictions. The
volume-driven markets are where the residual overconfidence lives — receptions worst at
−11.5pp.

This run is the *second* measurement. The first scored 2,332 props at 64.4% predicted
against 58.0% actual (Brier 0.2344), overconfident in every bucket — the signature of
distributions that were too narrow. Usage dispersion and efficiency noise were widened
(share CV 0.22→0.32, carry dispersion 1.35→1.8, yardage CVs up ~20%) and the run repeated,
which halved the gap and improved Brier to 0.2218. Both numbers are in the code comments.

**Known residual:** receptions and rush attempts remain overconfident, and the 80–90%
bucket is off by ~10pp on a decent sample. Treat the top of the board as slightly
optimistic, and treat the high-probability rows as expensive rather than safe — every row
shows its break-even price for exactly that reason.

## What is not modelled

- Red-zone target and carry splits (outside this dataset, so TD rates come from observed
  TD-per-touch, shrunk hard)
- Offensive line injuries, depth-chart churn, and backup-QB-specific efficiency
- Same-game correlation between props (the simulation has the ingredients; pricing combos
  is a separate product)
- Any prop price. There are no prop odds in this dataset, so the output is a probability and
  a break-even price — not a verdict on whether a bet is good.

## Things you can do from here

- Add a calibration transform fitted out-of-sample rather than on the same season you report
- Fetch prop prices (e.g. an odds API) and convert probability into edge and expected value
- Extend the market list — the `MARKETS` table in `props.js` is the only place a new prop
  type needs to be declared
- Cover other sports: the engine is sport-agnostic, but it needs a data source shaped like
  the nflverse releases
