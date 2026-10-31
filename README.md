# StockLens — NSE Stock Analysis, Watchlist, Alerts & Trade Journal

A full-stack app to help you check multiple factors (trend, momentum, volume,
volatility) before buying an Indian (NSE) stock, and decide whether it fits
a **long-term**, **short-term**, or **intraday** approach. Includes login,
a personal watchlist, price alerts (email optional), live price updates via
WebSocket, and a trade journal.

> ⚠️ **Not financial advice.** The "verdict" is a transparent, rule-based read
> of technical indicators (moving averages, RSI, MACD, volume, volatility).
> Always do your own research and manage your risk.

## Structure

```
stock-analyzer/
├── public/                # frontend (vanilla JS, no build step)
│   ├── index.html
│   ├── app.js
│   └── style.css
├── server/
│   ├── models/            # User, Watchlist, Alert, Journal (SQLite)
│   ├── routes/             # auth, stocks, watchlist, alerts, journal
│   ├── auth.js             # JWT + bcrypt
│   ├── db.js                # SQLite setup (file-based, zero config)
│   ├── indicators.js        # SMA/EMA/RSI/MACD + rule-based verdict engine
│   ├── marketData.js        # NSE India live data (quotes + historical)
│   ├── mailer.js            # optional email alerts (SMTP)
│   ├── rateLimit.js
│   ├── alertChecker.js      # cron job that checks price alerts
│   └── ws.js                 # WebSocket live price push
├── data/                    # SQLite db file lives here (auto-created)
├── .env.example
├── package.json
└── server.js
```

## Setup

```bash
npm install
cp .env.example .env      # already done for you; edit JWT_SECRET etc.
npm run dev                # nodemon, auto-restarts on changes
# or: npm start
```

App runs at **http://localhost:5000** (frontend + API + WebSocket all on one port).

## Market Holiday Awareness — no picks/actions on non-trading days

Directly addressing: **holiday/weekend pe koi bhi pick/action perform na
ho, bas existing list dikhe taaki RnD kar sako**.

`server/marketCalendar.js` is now the single gate every automated
background job checks first — daily recommendation logging, intraday
snapshots, EOD price updates, FII/DII collection, watchlist auto-checks
(emails), and price-alert checks. On a weekend or a configured market
holiday, each of these **skips itself entirely** (logged clearly in the
server console with the reason) — nothing new gets written to the
database, no emails go out, no picks get logged. Browsing/viewing the app
(Index Browser, search, your existing Track Record, etc.) keeps working
normally — that's read-only, so it just shows the last available data,
exactly for the "us din RnD kar sakoon" use case.

A **holiday banner** appears at the top of the Analysis tab on a
non-trading day ("🎉 Market closed today — Ganesh Chaturthi"). The frontend
auto-refresh logic (`isIndianMarketHours()`) also checks this, so it
doesn't attempt live updates on a holiday either.

**Holiday calendar** (`server/models/MarketHoliday.js`, managed in the
Settings tab): weekends are automatic (no setup needed). Pre-loaded with
fixed national holidays (Republic Day, Independence Day, Gandhi Jayanti,
Christmas) and NSE's **confirmed 2026 festival dates** (Ganesh Chaturthi
Sep 14, Dussehra Oct 20, Diwali–Balipratipada Nov 10, Guru Nanak Jayanti
Nov 24 — provided directly, not guessed). Add/remove any date in Settings
— for years beyond 2026, or if any date needs correcting, check
nseindia.com's official holiday circular and add it there; takes a few
seconds and every automated feature respects it immediately.

## Intraday Multi-Snapshot Tracking + Honest Move-Probability

Directly answering: **"morning mein ye bola tha, 2 ghante baad price/list
badal gaya — wo record kahan hai"** and **"aaj 1-5% upar jaane ka kitna
chance hai"**.

**Intraday snapshots** (`server/recommendations/IntradaySnapshot.js`,
`logIntradaySnapshot()` in `tracker.js`) — separate from the once-daily
Track Record log, this now runs **4 times during market hours** (9:30,
11:30, 13:30, 14:30 IST by default, configurable via
`INTRADAY_SNAPSHOT_CRON`) and records a full timestamped snapshot of every
pick's price/SL/target at that exact moment — nothing is overwritten, each
scan adds its own row. On any pick card, click **"🕐 Show today's
timeline"** to see every snapshot from that day side by side — exactly
"9:30 baje ye tha, 1:00 baje ye tha".

**Move-probability** (`server/probabilityEstimator.js`,
`estimateMoveProbability()`) — for every pick, an honest, **history-derived**
estimate: looking at this specific stock's own past data, every time a
similar signal occurred before, what % of the time did price go on to hit
+1%, +5%, or drop 2%+ within the next few days? This is a real frequency
count from actual past occurrences on that stock — not a machine-learning
prediction, not a guess. Sample size is always shown (`n=X`), and small
samples are flagged as "rough indication only" rather than presented as
confident stats. Shown inline on every Top Pick / Swing Setup / Golden
Setup card as "📊 History (n=X): Y% chance hit +1%, Z% chance hit +5%, W%
chance dropped 2%+".

Both features currently scope to Nifty 50 only (same as the daily Track
Record log) — extending to Midcap/Smallcap is possible but multiplies the
daily Yahoo API call volume significantly (150 more stocks × 4 extra scans
a day), so it's left as an opt-in change rather than turned on by default.

## Removal Tracking, Price History & Rare "Golden Setups"

Answering directly: **jo hata wo kyun hata, aur pehle jis price pe bola tha
uska ab kya hua** — both now tracked automatically.

- **Removed-from-list tracking** (`server/recommendations/RemovalEvent.js`,
  `detectRemovals()` in `tracker.js`) — every day, before logging new
  picks, the tracker compares against the previous day's picks per
  category. Anything that dropped out gets a `RemovalEvent` with a
  concrete reason: score dropped below zero, the momentum/reversal setup
  is no longer valid, or it's still positive but got displaced by
  stronger candidates today. Shown as a **"🚪 Recently removed"** panel on
  the Index Browser/Bulk Screener, each with its % change since it was
  first flagged.
- **"First flagged at ₹X, now ₹Y"** (`loadPriceHistory()` in `app.js`) —
  every pick in Top Picks / Swing Setups / Golden Setups now shows, right
  on the card, when it was first recommended and how the price has moved
  since — not just today's number in isolation.
- **Weekly/15-day/monthly averaging** (already built in the Track Record
  tab, `GET /api/recommendations/summary?period=...`) — win rate and
  average change % per category over 1W/15D/1M/3M/6M/All, computed from
  the same daily EOD price snapshots (`updateRecommendationPrices()` runs
  after market close, so `latestPrice` is effectively the day's closing
  price).
- **Golden Setups — deliberately rare** (`isGoldenSetup()` in
  `server/stockAnalysisEngine.js`) — a much stricter bar than the normal
  picks: score ≥ 4, R:R ≥ 3:1, volume ≥ 2x average, swing/positional only
  (not intraday noise). Most days this finds **nothing**, on purpose —
  when it does find something, it's shown in a distinct gold-highlighted
  "🌟 Rare Opportunity" panel separate from the daily picks, logged to the
  same tracking system so its performance gets graded too, honestly, like
  everything else.

## Upstox as primary data source — extended to historical, intraday, indices

Following up on the earlier partial integration — this round extends
`server/dataProviders/upstoxProvider.js` to actually cover what was
missing:

- **Historical daily candles** via Upstox's `/v2/historical-candle` endpoint
- **Intraday candles** via Upstox's `/v2/historical-candle/intraday` endpoint
  (1-minute/30-minute; Upstox's intraday history only covers the current
  session, unlike Yahoo's ~60-day window)
- **Nifty 50 / Bank Nifty / India VIX** quotes via Upstox's index instrument
  keys (`NSE_INDEX|...`), used by `server/marketRegimeDetector.js` — Upstox
  first, Yahoo fallback, same as everything else
- The aggregator (`server/dataProviders/aggregator.js`) now has
  `getMultiSourceHistorical()` and `getMultiSourceIntraday()` alongside the
  existing quote aggregation — same Upstox → Yahoo → unavailable pattern,
  same source+timestamp tracking

**What's still NOT done, and why:**
- **Upstox's own WebSocket tick feed** — Upstox's real-time stream uses a
  binary/protobuf protocol with its own connection handshake. Building
  that correctly without testing against a live account/token in this
  environment would risk shipping something that silently delivers wrong
  prices — worse than not having it. Instead, `server/ws.js` (the
  WebSocket *this app* serves to your browser) now polls through the same
  multi-source aggregator (Upstox first) on a short interval — functionally
  live for this app, automatically more accurate once Upstox is connected,
  without the risk of an untested binary protocol implementation. If you
  specifically need Upstox's raw tick-by-tick feed, that's a distinct,
  larger piece of work best scoped with live testing available.
- **FII/DII via Upstox** — Upstox's public Developer API is broker
  infrastructure (quotes, orders, holdings), not a documented source for
  NSE's published institutional-flow statistics. Rather than guess at an
  endpoint that likely doesn't exist, FII/DII stays sourced from NSE
  directly (unchanged, already built) — not swapped for an unverified
  Upstox call.
- **"Analytics Token"** — Upstox's public developer docs describe one
  OAuth-based API product (what's implemented here); if you have access to
  a distinct "Analytics Token" product with different scopes/endpoints,
  share the specifics and this can be wired in as an additional provider
  without touching the rest of the app.

Live price ticks (WebSocket) and the market regime banner now show which
provider actually supplied the number (hover the green dot next to a
stock's price, or check `source` in the regime data) — consistent with
"keep source + timestamp on important fields."

## Multi-Source Data Architecture (Upstox primary, Yahoo secondary)

New `server/dataProviders/` layer: for live quotes, every field is tried
against providers **in priority order** (Upstox → Yahoo → `unavailable`),
merged field-by-field — e.g. if Upstox has price/volume but not 52-week
high, that one field falls through to Yahoo instead of rejecting the whole
quote. Every field's response tracks **source, timestamp, and reliability**
(`GET /api/stocks/:symbol/data-quality`), and an overall **Data
Confidence %** is computed from how many fields came from a real source
vs. `unavailable` — nothing is ever fabricated to fill a gap.

**Honesty about Upstox specifically:** it's a real broker API (not a free
public one) — you need your own Upstox trading + developer account, and
its access tokens expire daily (~3:30 AM IST), so it needs a one-click
re-authorization each trading day at `/api/auth/upstox/login`. This
integration (`server/dataProviders/upstoxProvider.js`) is built from
Upstox's documented API structure, but **could not be tested against a
live account in this build environment** (no internet access here) —
please test it yourself and report back if something needs fixing. Nothing
else in the app depends on it working: if it's not configured or fails,
every field just falls back to Yahoo automatically, exactly as designed.

**Adding another provider later** (e.g. a paid data vendor): implement the
same shape (`isConfigured`, `getQuote`, `getHistorical`) as
`yahooProvider.js`, add it to the priority list in
`dataProviders/aggregator.js`. Nothing else needs to change.

## Phase 2: Risk Guardrails + Final Decision Card

New **Settings tab** — configurable capital, risk per trade %, minimum
R:R, max daily loss %, max trades/day, cooldown after a loss, max
sector/stock exposure %, minimum Data Confidence (`server/models/
UserSettings.js`, `GET/PUT /api/settings`).

New **"Final Decision Card"** on every stock's page
(`server/decisionEngine.js`, `GET /api/stocks/:symbol/decision`) combines:
technical score, Data Confidence, Market Regime, Risk:Reward, and your own
trading-discipline status (`server/riskGuardrails.js` — today's P&L vs.
your daily loss limit, trades taken vs. your max, active cooldown after a
recent loss) into ONE decision: **BUY NOW / BUY ON PULLBACK / WAIT /
WATCHLIST / NO TRADE** — with explicit **WHY** and **WHY NOT** reasons, an
Entry Quality score (0-100, A+/Good/WAIT/Weak/NO TRADE bands), and an
invalidation condition. A high technical score **never** overrides a
blown daily-loss limit, an active cooldown, low data confidence, or a
below-minimum R:R — those are hard gates checked first.

## Phase 3: Backtest Upgrade (costs, benchmark, Monte Carlo, walk-forward)

`server/backtest.js` significantly extended:
- **Real transaction costs** — brokerage, STT, exchange charges, GST,
  stamp duty, slippage (reasonable Indian delivery-trading defaults) —
  results now show gross vs. net return.
- **Nifty 50 benchmark** — alongside the existing buy-and-hold comparison.
- **Walk-forward validation** — in-sample (first 70%) vs. out-of-sample
  (last 30%) split, shown separately so a strategy that only worked in the
  optimized period is visible as such.
- **Monte Carlo** — 1,000 reshuffles of the same trades' returns, showing
  the range of outcomes (5th-95th percentile) and probability of an
  overall loss — sequencing luck, isolated from whether the trades
  themselves were any good.
- **Parameter sensitivity** — nudges entry/exit thresholds ±0.5 and checks
  how much results swing, flagging likely overfitting if a tiny change
  destroys performance.
- **Sample-size warning** — explicit warning below 20 trades.
- **Backtest Confidence score (0-100)** combining all of the above.
- **No-look-ahead confirmation** shown explicitly — every signal only uses
  `candles[0..i]`, verified by the code structure (`computeSeries`/
  `scoreAt` in `indicators.js`), not by trusting it after the fact.

## Phase 1 of the Trade Decision Engine upgrade: Multi-Timeframe + Market Regime

Starting the 60-point Trade Decision Engine spec in phases (see chat for
the full feasibility breakdown — most of it builds on free data, a few
things like delivery %, board-meeting/pledge/bulk-deal feeds, and true
market breadth aren't reliably free and are marked `not_available` rather
than guessed, consistent with how the rest of this app already handles
that).

**Multi-Timeframe Analysis** (`server/multiTimeframe.js`) — runs the same
rule engine across **5m, 15m, 1h, 4h, Daily, Weekly** and reports an
alignment score (what % of timeframes agree) and a dominant bias. New
"Multi-Timeframe Analysis" card on every stock's page (lazy-loaded via a
button, like backtest — 6 extra Yahoo calls per run, so it's on-demand
rather than automatic on every page load). Honest limit: Yahoo's free
intraday history is short (~60 days for 5m/15m/1h) — shorter timeframes
reflect recent price action only, not deep history. There's no native "4h"
interval either, so it's approximated by grouping four 60-minute candles
(not perfectly session-aligned to India's ~6.25-hour trading day, but a
reasonable directional read).

**Market Regime** (`server/marketRegimeDetector.js`) — Nifty 50 trend,
Bank Nifty trend, and India VIX level (all via free Yahoo tickers:
`^NSEI`, `^NSEBANK`, `^INDIAVIX`) combined into a trend regime
(Bullish/Bearish/Sideways) and volatility regime (High/Normal/Low, from
VIX level). Shown as a banner at the top of the Analysis tab, cached 5
minutes. Market breadth (advance/decline) is honestly `not_available` — no
free source for exchange-wide breadth data.

`GET /api/stocks/:symbol/mtf` and `GET /api/market/regime` — new endpoints
for both.

**Next phases** (not yet built — say the word to continue): Phase 2 risk
guardrails (daily loss limit, cooldown, no-trade engine, hard checklist,
final decision card) and Phase 3 backtest upgrades (transaction costs,
Monte Carlo, walk-forward validation, benchmark comparison).

## Full MongoDB migration — SQLite retired

The entire app (login, watchlist, alerts, trade journal) now runs on
**your MongoDB** (`MONGODB_URL` in `.env`) instead of the local SQLite
file. `server/db.js` and the `better-sqlite3` dependency are gone.

- Field names in API responses are unchanged (`stop_loss`, `trade_date`,
  `last_verdict`, etc.) — only the storage engine changed, not the
  contract, so nothing else in the app needed to change just for this.
- **Important:** since your previous account(s) lived in the old SQLite
  file, they don't exist in MongoDB — **register a fresh account** after
  updating. Stock search/analysis/backtest/etc. need no login and work
  regardless of database status; only login-gated features (watchlist,
  alerts, journal, institutional data, track record) require Mongo to be
  reachable.
- If `MONGODB_URL` is unreachable at startup, the server still starts
  (stock analysis keeps working) but logs a clear warning, and login-gated
  routes return a clear 503 instead of crashing.

## Daily Recommendation Tracking — did the picks actually work?

New **"Track Record"** tab. Every day, this app now logs its own picks —
exactly what "Today's Best for Intraday/Short-Mid/Long-term" and
"Momentum/Reversal" show — with the price at that moment, into MongoDB.
Every following day, it quietly refreshes the **latest price** on every
previously logged pick (not just today's), so you can look back honestly
and see whether a pick from a week, 15 days, or a month ago actually
worked out — not just today's opinion.

- `server/recommendations/tracker.js` → `logDailyRecommendations()` (cron,
  weekdays 3:45 PM IST — after the trading day, using that day's Nifty 50
  scan) and `updateRecommendationPrices()` (cron, weekdays 4:00 PM IST —
  refreshes every past pick's price).
- Each pick is logged **once per day** (re-runs the same day don't
  duplicate or reset it) — history accumulates permanently, nothing gets
  overwritten.
- Tracks whether the suggested stop-loss or target was ever hit since the
  pick was made, not just the current price.
- **Track Record tab** shows a win-rate/avg-change scorecard per category
  (Intraday/Short-Mid/Long-term/Momentum/Reversal) for a selectable period
  (1W/15D/1M/3M/6M/All), plus the full list of individual picks with
  then-vs-now price.
- API: `GET /api/recommendations` (list, filterable by `category`/
  `period`/`symbol`) and `GET /api/recommendations/summary` (win-rate
  scorecard).

This is the most honest thing in the whole app — it's the system grading
its own past homework, automatically, with nowhere to hide a bad call.

## Fixed: Yahoo fundamentals/earnings-date calls failing (all of them)

Root cause of the `[sectorSync] updated 0, 166 failed` you saw: Yahoo's
`quoteSummary` endpoint (used for fundamentals and earnings-calendar data)
started requiring a session **"crumb" token** on top of cookies — the
simpler chart/search endpoints don't need this, which is why those kept
working while fundamentals/events silently failed everywhere (sector sync,
the Fundamentals card, earnings-date warnings). Fixed by fetching and
attaching a crumb (`getCrumb()` in `server/marketData.js`, cached ~55 min,
auto-refreshed on a 401).

## FII/DII collector 403s — expected, not a bug

The `[fiiDiiCollector] failed: Request failed with status code 403` is the
same known NSE-blocking behavior flagged since early on in this project —
NSE's unofficial endpoint blocks many server/cloud IPs outright. This
isn't something a code fix can guarantee around; the collector already
retries with backoff and fails gracefully (skips that day, tries again on
the next scheduled run) rather than crashing anything else. If it's
consistently 403ing from your host, that host's IP is likely on NSE's
block-list — there's no free workaround for that beyond occasionally
succeeding from a different network/IP.

## Institutional Money Flow (MongoDB) — what's real vs. honestly unavailable

New **"Institutional Flow"** tab, backed by MongoDB (`MONGODB_URL` in
`.env` — separate from the SQLite DB the rest of the app uses; if unset,
this whole feature just returns 503 and nothing else is affected).

**What's REAL (not guessed):**
- **FII/DII daily cash-market buy/sell/net** — collected daily from NSE
  India's free provisional-data endpoint (`server/institutional/
  fiiDiiCollector.js`, cron: weekdays 6:30 PM IST, same NSE-blocking caveat
  as always applies — check server logs if it stops updating). Aggregated
  across 1D/1W/1M/3M/6M/YTD/1Y in `GET /api/institutional/overview`.
- **Sector mapping** — reused from the same free Yahoo fundamentals data
  already used elsewhere in the app (not a new/unverified source), synced
  weekly into MongoDB.

**What's honestly `not_available` (per your own instruction to never fake
numbers), and why:**
- **Mutual fund holdings-change** — AMFI doesn't centrally publish
  machine-readable portfolio disclosures; each of the ~40 AMCs discloses
  monthly on their own site in inconsistent PDF/Excel formats. No reliable
  free bulk source exists. Schema is ready
  (`server/institutional/models/MfHoldingChange.js`) for a real collector
  or manually-imported data later — it's just not populated yet.
- **Quarterly shareholding-pattern change** (Public/FII/DII %) — published
  per-company as BSE/NSE filings (PDF/XBRL), not as a simple bulk API.
  Same story: schema ready, not populated.
- **Sector-level and stock-level FII/DII positioning, top-buyers/sellers**
  — the free NSE data we collect is market-wide only (not broken down by
  sector or stock), so these can't be derived without the MF/shareholding
  data above. `GET /api/institutional/sector-flow`,
  `/stock-flow`, `/top-buyers`, `/top-sellers` all return explicit
  `not_available` markers with a reason instead of a fabricated number.

**Endpoints** (`server/institutional/routes.js`):
```
GET /api/institutional/overview
GET /api/institutional/sector-flow?period=1M
GET /api/institutional/stock-flow?symbols=RELIANCE,TCS&period=1M
GET /api/institutional/top-buyers?period=1M
GET /api/institutional/top-sellers?period=1M
```

If you later find/buy a specific data source for MF holdings or
shareholding patterns, wire it into the two model files above and the
`not_available` markers become real numbers automatically - the API
contract doesn't need to change.

## Fixed: charts not showing + "Chart is not defined" on backtest

Root cause: this app was depending on the Chart.js library from a CDN
(`cdnjs.cloudflare.com`). If that CDN doesn't load in your browser/network
for any reason, the global `Chart` never exists, and every chart creation
throws "Chart is not defined" — which was *also* why the Suggested Trade
Plan card wasn't appearing: it was called right after price-chart creation
in the same function, so the crash skipped it too.

Fix: **removed the Chart.js dependency entirely.** Both the price chart and
the backtest equity curve are now drawn with a small hand-rolled SVG line
chart (`renderSvgLineChart()` in `public/app.js`) — plain JS, zero external
dependencies, nothing to fail to load. This should resolve all three
symptoms (missing price chart, missing trade plan, backtest chart error)
at once, since they shared the same root cause.

## "Buy or not, at what price" — now shown directly in the picks

Top Picks and Swing-trade Setup cards now show a clear buy-zone verdict
right on the card, not just in the detailed trade plan:
- ✅ **In buy zone now** — price is within the suggested entry range
- ⏳ **Below buy zone** — could still fall further before it's a good entry
- ⏫ **Already ran past entry** — consider waiting for a pullback instead of chasing

Same entry/stop-loss/target numbers as the "Suggested Trade Plan" card,
just surfaced earlier in the decision so you don't have to open every
candidate to see if it's actually buyable right now.

## News & Earnings-date awareness (events that can wreck a swing trade)

Honest limitation still stands: true mutual-fund/FII buy-sell flow data
isn't available reliably for free — that needs a paid data vendor. But two
genuinely useful, free additions now cover the practical "events" risk:

- **Upcoming earnings warning** — via Yahoo's free `calendarEvents` data
  (`getEvents()` in `server/marketData.js`). If a stock's results are
  expected within 10 days, you'll see an amber warning wherever that stock
  shows up (its own page, and inline in Swing-trade Setup cards) — results
  day can gap a stock hard in either direction, blowing straight through a
  normal stop-loss, so it's worth knowing before entering a multi-day swing
  position.
- **News surfaced where you decide, not just on click-through** — Swing
  Setup cards (momentum + reversal candidates) now show the latest
  headline and any earnings warning inline, fetched in the background only
  for the handful of candidates shown (not the whole 50-stock scan) so it
  stays fast. This helps tell apart "fell on bad news, could keep falling"
  from "technical dip only, news is fine" before you even click in.

## Live auto-refresh (no manual page refresh) — 9:00–3:40 IST

The app now updates itself automatically during Indian market hours,
weekdays only — no need to hit refresh while a trade is running:
- The stock you're viewing: full analysis (price, verdict, indicators)
  silently re-fetches every 60 seconds — numbers update in place, no
  scroll jump, no loading flicker, and nothing you typed in the risk
  calculator or journal forms gets reset.
- Open positions (Position Manager) and Portfolio Overview refresh every
  60 seconds while that tab is open.
- Watchlist verdicts refresh every 5 minutes while that tab is open.
- A "Live · updated HH:MM:SS" label next to the price tells you it's
  actually auto-updating; outside market hours it says "Market closed"
  instead of pretending to be live.

This runs alongside the existing WebSocket tick (which still updates the
price every ~8s) — the 60s refresh is what keeps the *verdict and
indicators* current too, not just the price number.

## Swing-trade Setups — momentum AND reversal/bounce candidates

Every Index Browser/Bulk Screener scan now also shows a **"Swing-trade
setups"** panel with two lists, not just whatever is currently bullish:

- **Momentum** — stocks already trending up with a strong score (the
  existing Top Picks logic).
- **Reversal / Bounce** — stocks that fell meaningfully (15D/1M return
  notably negative), have just turned up for 1-3 days, and are either
  sitting near a support zone or showing RSI recovering out of oversold.
  This is exactly the "BEL girta raha, ab support leke upar aa raha hai"
  case — a pure "highest score right now" filter would miss it, since its
  longer-term trend score can still be negative even as the last few days
  turn up. Detected in `detectSetupType()` in `server/indicators.js`.

Both are computed from the same underlying data already fetched for the
table — no extra API calls.

## Suggested Trade Plan (entry range, stop-loss, target)

Every stock's page now has a **"Suggested Trade Plan"** card
(`generateTradePlan()` in `server/indicators.js`) with a concrete entry
range, stop-loss, and target instead of leaving that to guesswork:

- **Stop-loss** is placed just under the nearest *real* support level
  (not an arbitrary ATR multiple) where one exists — giving the trade room
  to breathe against ordinary daily noise instead of getting stopped out
  by normal wiggle, which is what "stop-loss trigger na ho" means in
  practice: a wider, more sensibly-placed stop, not a guarantee it never
  triggers.
- **Target** is placed just under the nearest resistance — a level price
  has actually struggled at before, which is more realistic to reach than
  an arbitrary far-off number.
- Shows the **risk:reward ratio** so you can judge at a glance whether a
  setup is worth taking (1:2 or better is generally considered solid).
- Falls back to ATR-based levels when no clear support/resistance exists
  nearby, and says so.

Same trade plan also appears inline in the Swing-trade Setups panel so you
can compare entry/stop/target across candidates without opening each one.

## This round's fixes & requested changes

**Chart wasn't showing** — root cause found: the canvas had `id="priceChart"`
which is the *exact same name* as the JS variable `let priceChart` holding
the Chart.js instance. Browsers can auto-expose DOM elements with an `id`
as global names, which collided with the variable and caused unreliable
behavior. Renamed the canvas to `priceChartCanvas` and gave it a proper
sized container so it always renders.

**"Opens below the list" navigation** — clicking a stock from Index
Browser/Bulk Screener now scrolls to top, hides the big list, and shows a
**"← Back to results"** button — it feels like a real page transition
instead of the analysis appearing somewhere below a long table you have to
scroll past.

**Auto-recommendations ("Top Picks")** — you no longer have to sort/filter
yourself to find what's worth looking at. Every Index Browser/Bulk Screener
run now shows an automatic **"Best for Intraday / Best for Short-term /
Best for Long-term"** panel above the table — top 3 bullish-scoring stocks
per horizon, computed from the same scores already shown in the table.
Still not a guarantee, just saves you the manual filtering.

**All periods shown together, sortable columns** — the old
dropdown-per-period sort is gone. The table now has one column per period
(1D/1W/15D/1M/2M/3M/1Y/5Y) plus Streak, Score, Verdict, and Horizon, all
visible at once so you can compare directly — click any column header to
sort by it (click again to reverse). Table scrolls horizontally on smaller
screens so nothing gets cut off.

**Losing/winning streak filter** — new "Streak" column plus a filter
dropdown (Falling 3+/4+/5+ days straight, Rising 3+/5+ days straight).
Finds stocks like your BEL example — down small amounts every day for
several days running — via `computeStreak()` in `server/indicators.js`,
which counts consecutive same-direction closes back from today.

## Fixed: "FOREIGN KEY constraint failed" on watchlist/alerts/journal

If you ever see this error in the terminal after replacing/resetting the
`data/app.db` file (e.g. downloading a fresh copy of this app) while your
browser still has an old login token saved: that token refers to a user ID
from the *previous* database, which no longer exists in the new one. Fixed
two ways:

- `requireAuth` (`server/auth.js`) now checks the user actually exists in
  the current database, not just that the JWT signature is valid — a stale
  token now gets a clear "please log in again" message instead of crashing
  the request with a raw SQLite error.
- The frontend now catches any 401 mid-session, clears the stale token, and
  automatically returns you to the login screen instead of repeating the
  same failure on every action.

If you hit this: just log out and log back in (or register again) — it's
expected after resetting the database, not a sign of anything broken.

## Debugging "Could not load / Request failed" issues

If things stop loading everywhere at once (chart, clicks, everything), the
most likely cause is **Yahoo Finance temporarily rate-limiting your
server's IP** — this happens most easily right after running Bulk Screener
or Index Browser (which fire off 25-100 requests in a row). Two ways to
check:

1. Open your browser's DevTools console (F12 → Console tab) — every failed
   request now logs the real HTTP status and response body there, instead
   of a generic "Request failed" message.
2. Visit `/api/health/data-provider` in your browser (or `curl
   localhost:5000/api/health/data-provider`) — it makes one test call to
   Yahoo and tells you plainly whether Yahoo is reachable or rate-limiting
   you right now.

If it is rate-limited: wait a few minutes before retrying, and avoid
running Bulk Screener/Index Browser scans back-to-back. This version also:
- Backs off much longer specifically on HTTP 429 responses (2s, 4s, 6s
  instead of a fixed short delay) before giving up.
- Spaces out requests within Bulk/Index scans (small delay between each,
  concurrency reduced from 6 to 4) so a big scan is gentler on Yahoo and
  less likely to trigger a block in the first place.
- Shows the real error (with HTTP status) in both the UI and the browser
  console, instead of masking everything as "Request failed".

Clickable rows/names (watchlist symbols, screener/index table rows) now
also show a hover highlight and dim briefly on click, so it's clear
something is happening instead of looking like nothing responded.

## Notes on live data

Market data comes from **Yahoo Finance's free public endpoints** — no API
key needed, and reliable from a server (NSE India's own unofficial API often
blocks server/cloud IPs, which is why an earlier version of this app showed
no data). Prices are real-time/near-real-time during market hours and
end-of-day otherwise. `server/marketData.js` is the **only** file that talks
to the data provider; the rest of the app doesn't care where the numbers
come from — swap in a paid feed (Upstox, Kite Connect, etc.) later by
reimplementing `search()`, `getQuote()`, `getHistorical()` in that one file.

## Bulk Screener

Paste up to 25 NSE symbols at once (comma or newline separated) in the
**Bulk Screener** tab. Every symbol gets analyzed in parallel and you get a
sorted table (best score first) with verdict, price, and suggested horizon —
so you can compare many candidates and decide what to actually buy, instead
of checking one stock at a time.

## Browse by Index (no search needed)

The Analysis tab now opens with three buttons: **Nifty 50 / Midcap /
Smallcap**. Click one and every stock in that list gets analyzed (price,
verdict, score, suggested horizon) and shown as a sorted table — best score
first — with no searching required. A small filter box appears above the
table to narrow it further by symbol (client-side, instant). The main search
bar at the top still works separately and searches **all** NSE/BSE stocks,
not just the loaded index.

These lists live in `server/indexConstituents.js` — they're a hand-curated
snapshot (NSE rebalances indexes twice a year), so edit that file directly
if you want to add/remove symbols or keep it closer to the official list
from niftyindices.com.

Because this fires off 50 analyses at once, it's throttled to 6 requests in
flight at a time (`server/routes/stocks.js` → `mapLimit`) so Yahoo doesn't
rate-limit us — expect it to take ~15-30 seconds per index.

## Risk Management — Position Size Calculator

Guessing "how many shares should I buy" is one of the biggest silent
account-killers. On any stock's page, the **Risk & Position Size
Calculator** card:

- Auto-suggests a stop-loss using the stock's own recent volatility —
  1.5× ATR(14) below the current price (ATR = Average True Range, now
  computed in `server/indicators.js`), editable if you want your own.
- You enter your total capital and how much of it you're willing to risk
  on this one trade (0.5-2% is the common rule of thumb).
- It tells you exactly **how many shares** to buy so that if the stop-loss
  is hit, you lose no more than that %, plus suggested 1:2 and 1:3
  risk-reward target prices.

This doesn't predict anything — it just makes sure one wrong call can't
wipe out your account, which matters more than being right often.

## Fundamentals

Every stock's page now has a **Fundamentals** card: Market Cap, trailing &
forward P/E, EPS, Price-to-Book, ROE, Profit Margin, Debt-to-Equity,
Dividend Yield, Beta, 52-week range, YoY revenue/earnings growth, sector &
industry, and Yahoo's own analyst consensus + target price — all free, via
`server/marketData.js` → `getFundamentals()` (Yahoo's `quoteSummary`
endpoint). Smaller/newer listings sometimes have gaps in this data — that's
a data-availability limit, not a bug.

## Market Trend Filter — trade with the market, not against it

Every analysis (single stock, bulk screener, index browser, CSV import) now
also checks the **Nifty 50's own current trend** (`server/marketTrend.js`,
same rule engine, 5-minute cache so it doesn't refetch on every request) and
folds it in as one more transparent factor (±0.5 to the score) — you'll see
it as "Nifty 50 (broader market) is trending bullish/bearish right now" in
the factor list, and a "Market context" note on the stock's page. This is a
genuinely evidence-backed idea (stocks statistically do better when the
broader index is trending the same way) — not a magic accuracy boost, just
one more honest input into the same transparent scoring system.

## Weekly Trend Confirmation

Every analysis now also reads the **weekly chart** — resampled from the
same daily candles already fetched (no extra API call), scored with the
exact same rule engine. When daily and weekly agree, that's a genuine
confidence signal (shown as a factor + small score bonus); when they
conflict, you get an explicit caution note instead of a silent miss. This
is a well-known technique ("multi-timeframe confirmation") for cutting down
false signals — daily-only reads catch more short-lived noise.

## Support/Resistance Levels & Candlestick Patterns

Every stock's page now has a **"Price Levels & Patterns"** card:

- **Support/Resistance** — recent swing highs/lows (last ~90 sessions),
  clustered into zones, shown with how many times price has touched that
  level (`findSupportResistance` in `server/indicators.js`). Useful for
  setting a stop-loss or target with more context than ATR alone.
- **Candlestick patterns** — Doji, Hammer, Shooting Star, Bullish/Bearish
  Engulfing, detected on the latest 1-3 candles (`detectCandlePatterns`).
  These describe short-term price action, not a prediction on their own.

## Portfolio Overview

The Trade Journal tab now opens with a **Portfolio Overview**: total
invested vs. current value, total P&L (₹ and %), and a **sector breakdown**
of your open positions with a concentration warning if any one sector is
over 40% of your portfolio (e.g. holding 4 bank stocks is one bet, not
four) — via `server/routes/journal.js` → `GET /journal/portfolio`, using
the sector info from each stock's free Yahoo fundamentals.

## Watchlist Auto-Alerts

Every watchlist entry is now re-checked automatically once an hour
(`server/watchlistChecker.js`, schedule configurable via
`WATCHLIST_CHECK_CRON` in `.env`). If a stock's verdict changes (say,
Neutral → Bullish lean, or Bullish → Bearish), you get **one digest email**
per run summarizing every change — no need to keep checking manually. Hit
"Refresh now" on the Watchlist tab for an on-demand check instead of
waiting for the next hourly run.

## Position Manager — "Hold or Exit?" for every open trade

This directly answers *"aaj/is week liya trade neeche gaya — hold karu ya
nikaalu?"*. The **Trade Journal** tab now opens with a **Position Manager**
panel that re-checks every OPEN trade against **live price + the same rule
engine**, right now, and gives one clear recommendation per position:

- **EXIT** — your stop-loss was hit (discipline over hope), or an intraday
  trade is still open past its day
- **BOOK PROFIT** — your target was reached
- **CONSIDER EXIT** — the technical read has flipped against your position
  (the reason you entered no longer holds — doesn't mean it'll keep
  falling, but the original setup is gone)
- **HOLD** — nothing's been hit and the technical read still doesn't
  contradict the position

To use this, add an optional **stop-loss and target** when logging a trade
(new fields in "Log a trade" — the Risk Calculator's suggested stop-loss is
a good value to copy in). Without them, only the technical-flip and
intraday-overdue checks apply. Hit **"Refresh positions"** any time to
re-check against the latest price.

## Backtest Engine — see the real historical win rate

**This is the most important addition, and the most honest one.** No tool —
free or paid — can promise 80% accuracy or guaranteed profit; markets move
on news and sentiment that no chart can predict. What a backtest *can* do is
tell you, honestly, how the app's own rule-based verdict engine would
actually have performed in the past — including the losing trades.

On any stock's page, hit **"Run backtest"**. It walks the exact same scoring
logic used for the live verdict (`server/indicators.js` → `scoreAt`, now
shared by both live analysis and `server/backtest.js`) day-by-day over up to
5 years of real history:

- **Buys** when the score first reaches "Bullish lean"
- **Sells** when the score drops to "Bearish lean", or after 60 trading
  days, whichever comes first

You get: win rate, average win vs. average loss, **expectancy** (average
return per trade — the single number that tells you if a rule has any edge
at all), total compounded return, an equity curve chart, max drawdown, a
full trade log, and — critically — a **buy-and-hold comparison** for the
same period, so you can see whether the rules actually beat just holding
the stock.

Expect the win rate to land closer to 45-55% than 80% — that's normal for
simple technical rules and matches what professional systematic traders see
too. What makes a system profitable isn't a high win rate, it's whether
average wins are meaningfully bigger than average losses (expectancy > 0).
No brokerage/STT/slippage is modelled, so real-world returns would be a bit
lower still.

## Period returns & sorting (1D → 5Y)

Every analysis — single stock, bulk screener, or index browser — now also
computes % return over **1 Day, 1 Week, 15 Days, 1 Month, 2 Months, 3 Months,
1 Year, and 5 Years** (`server/indicators.js` → `computePeriodReturns`, using
trading-day lookback counts, not calendar days). On a stock's own page this
shows as a "Returns by period" table. In the **Index Browser** and **Bulk
Screener**, a "Sort by" dropdown lets you rank the whole list by any of
these periods (or by score/volume-spike/RSI) with a gainers-first or
losers-first toggle — so "kaun kitna bada/gira hua hai" over any timeframe
is one click away. To support 5-year returns, historical fetches now pull
up to 5 years of daily candles (was ~1 year before) — this is why bulk/index
loads take a bit longer than before.

## "What's active right now" & "why is it moving"

On any stock's page:

- **Volume Spike** (already in Key Indicators, now also sortable across
  index/bulk lists) — today's volume vs. its own 20-day average. A spike
  well above 1x means unusually high interest right now; the "Why is it
  moving?" card turns this into a plain-language note.
- **News** — the latest headlines for that stock (free, via Yahoo Finance),
  linked out so you can read the actual reason (earnings, an upgrade/
  downgrade, sector news, etc.) instead of guessing from the chart alone.
- **Technical factors** (the existing bullish/bearish list) covers the
  "chart-based" reason side.

Honest limitation: real institutional/mutual-fund buying-vs-selling data
(FII/DII flow, delivery %, bulk/block deals) isn't available from any free
source reliably enough to build on — that needs a paid data vendor. Volume
spike + news is the closest free approximation, and it's what's here.

## About "Could not load data" errors

Yahoo Finance's endpoints are free and need no key, but being unauthenticated
they occasionally hiccup (a slow response, a momentary rate-limit). Two
things now handle that:

- **Backend**: `server/marketData.js` retries a failed request up to 3 times
  with a short backoff before giving up (`withRetry`).
- **Frontend**: if a load still fails after that, the app now clears the
  stale panel instead of leaving old numbers on screen next to the error
  (that mismatch — old indicators sitting under a "could not load" message —
  was a real bug in the previous version) and shows a **Retry** link.

If it keeps failing for a specific symbol, it usually means either the
symbol doesn't exist on Yahoo under that exact NSE ticker, or Yahoo is
rate-limiting your server's IP for a bit — retrying after a few seconds
almost always works.

## Import Your Own Data

The **Import Data** tab has two ways to feed in your own data:

1. **Paste CSV** — for any symbol, paste rows of `date,open,high,low,close,volume`
   (e.g. exported from your broker or Excel) and get the full factor
   checklist + verdict run against it, no live API needed.
2. **Upload screenshot(s)** — upload one or more screenshots (a chart, a
   watchlist row, a price table) and Claude's vision API extracts whatever
   price/candle data is visible, then runs the same analysis. This needs an
   `ANTHROPIC_API_KEY` in `.env` (get one at console.anthropic.com); without
   it, the app tells you clearly and the CSV-paste option still works fully.

## Email alerts (optional)

Alerts work without SMTP — they still trigger and mark as "triggered" in the
app. To also get an email, fill in `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` in
`.env` (e.g. a Gmail app password, or any SMTP provider).

## How the "verdict" is built

`server/indicators.js` computes SMA(20/50/200), EMA(9/21), RSI(14), MACD
histogram, a 20-day volume average, and average daily range %. Each factor
adds/subtracts a score (trend +1, momentum ±1, volume ±0.5 etc.), the total
score maps to a verdict label, and the average daily range decides whether
the setup looks more suited to intraday, short-term, or long-term — every
factor used is shown to the user in plain language so it's never a black box.

## Next steps you might want

- Add fundamentals (P/E, EPS growth) by scraping/using a fundamentals API
- Add a backtest mode for the verdict engine against historical data
- Add push notifications (web push) instead of/alongside email alerts
- Deploy: any Node host (Render, Railway, a VPS). SQLite file just needs a
  persistent disk; for serverless hosts, swap to a hosted Postgres instead.
