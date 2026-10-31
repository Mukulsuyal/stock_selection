require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { apiLimiter, authLimiter } = require('./server/rateLimit');
const { attachWebSocket } = require('./server/ws');
const { startAlertChecker } = require('./server/alertChecker');
const { startWatchlistChecker } = require('./server/watchlistChecker');
const { connectMongo, isMongoConfigured } = require('./server/mongo');
const { collectFiiDii } = require('./server/institutional/fiiDiiCollector');
const { collectBulkDeals } = require('./server/institutional/bulkDealsCollector');
const { syncAllKnownSectors } = require('./server/institutional/sectorSync');
const { refreshIndexLists } = require('./server/nseIndexList');
const { logDailyRecommendations, updateRecommendationPrices, logIntradaySnapshot, runForTrackedIndexes, TRACKED_INDEXES, backfillHitDetails } = require('./server/recommendations/tracker');
const { runWeekendResearch, updateWeekendPickPrices } = require('./server/weekendResearch');
const { recomputeFactorPerformance, loadAdjustmentCacheFromDb, maybeRecomputeIfStale } = require('./server/factorPerformance');
const { runMultibaggerResearch, updateMultibaggerPrices } = require('./server/multibaggerResearch');
const { runIfTradingDay, getTradingDayStatus } = require('./server/marketCalendar');
const { seedHolidaysIfEmpty } = require('./server/seedHolidays');
const marketCalendarRoutes = require('./server/routes/marketCalendarRoutes');

const authRoutes = require('./server/routes/auth');
const adminRoutes = require('./server/routes/admin');
const upstoxAuthRoutes = require('./server/routes/upstoxAuth');
const stockRoutes = require('./server/routes/stocks');
const marketRoutes = require('./server/routes/market');
const watchlistRoutes = require('./server/routes/watchlist');
const alertRoutes = require('./server/routes/alerts');
const journalRoutes = require('./server/routes/journal');
const importRoutes = require('./server/routes/imports');
const institutionalRoutes = require('./server/institutional/routes');
const recommendationsRoutes = require('./server/recommendations/routes');
const weekendPicksRoutes = require('./server/routes/weekendPicks');
const settingsRoutes = require('./server/routes/settings');
const ipoRoutes = require('./server/routes/ipo');
const multibaggerRoutes = require('./server/routes/multibagger');
const resultsCalendarRoutes = require('./server/routes/resultsCalendar');
const zeroLossRoutes = require('./server/routes/zeroLoss');
const fnoRoutes = require('./server/routes/fno');
const mobileAlertRoutes = require('./server/routes/mobileAlert');
const tomorrowConvictionRoutes = require('./server/routes/tomorrowConviction');
// fundamentals cache warm registered in cron block
const sectorAncillaryRoutes = require('./server/routes/sectorAncillary');
const morningStormRoutes = require('./server/routes/morningStorm');
const earlyOpportunityRoutes = require('./server/routes/earlyOpportunity');
const weekRunnerRoutes = require('./server/routes/weekRunner');
const crashRecoveryRoutes = require('./server/routes/crashRecovery');
const bestReversalRoutes = require('./server/routes/bestReversal');

const app = express();
app.set('trust proxy', 1);   // ← yeh line add karo
app.use(cors());
app.use(express.json());
app.use('/api/', apiLimiter);

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth/upstox', upstoxAuthRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/import', importRoutes);
app.use('/api/institutional', institutionalRoutes);
app.use('/api/recommendations', recommendationsRoutes);
app.use('/api/weekend-picks', weekendPicksRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/fno', fnoRoutes);
app.use('/api/mobile-alert', mobileAlertRoutes);
app.use('/api/ipo', ipoRoutes);
app.use('/api/multibagger', multibaggerRoutes);
app.use('/api/results-calendar', resultsCalendarRoutes);
app.use('/api/zero-loss', zeroLossRoutes);
app.use('/api/tomorrow-conviction', tomorrowConvictionRoutes);
app.use('/api/sector-ancillary', sectorAncillaryRoutes);
app.use('/api/early-opportunity', earlyOpportunityRoutes);
app.use('/api/week-runner', weekRunnerRoutes);
app.use('/api/crash-recovery', crashRecoveryRoutes);
app.use('/api/best-reversal', bestReversalRoutes);
app.use('/api/morning-storm', morningStormRoutes);
app.use('/api/market/calendar', marketCalendarRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), mongoConfigured: isMongoConfigured() }));

// Diagnostic: checks whether Yahoo Finance itself is reachable/rate-limiting
// this server right now, separate from any app bug. Hit this in the browser
// or via curl when things seem broken to know which side the problem is on.
app.get('/api/health/data-provider', async (req, res) => {
  const marketData = require('./server/marketData');
  try {
    const start = Date.now();
    const quote = await marketData.getQuote('RELIANCE');
    res.json({ ok: true, tookMs: Date.now() - start, samplePrice: quote.lastPrice, message: 'Yahoo Finance is reachable right now.' });
  } catch (err) {
    const status = err.response?.status;
    res.status(502).json({
      ok: false,
      httpStatus: status || null,
      message: status === 429
        ? 'Yahoo Finance is rate-limiting this server right now (HTTP 429). Wait a few minutes before retrying, and avoid running Bulk Screener/Index Browser back-to-back.'
        : `Could not reach Yahoo Finance: ${err.message}`,
    });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

function startCronJobs() {

  // Multi-Bagger Radar: after market close weekdays + Saturday morning deep pass
  cron.schedule(process.env.MULTIBAGGER_CRON || '30 16 * * 1-5', () => {
    runIfTradingDay('Multi-bagger research', () => runMultibaggerResearch({ force: false }))
      .catch((err) => console.error('[cron] multibagger failed:', err.message));
  });
  cron.schedule(process.env.MULTIBAGGER_WEEKEND_CRON || '30 10 * * 6', () => {
    runMultibaggerResearch({ force: false }).catch((err) => console.error('[cron] multibagger weekend failed:', err.message));
  });
  cron.schedule(process.env.MULTIBAGGER_PRICE_CRON || '15 18 * * 1-5', () => {
    runIfTradingDay('Multi-bagger price update', updateMultibaggerPrices)
      .catch((err) => console.error('[cron] multibagger prices failed:', err.message));
  });

  // FII/DII: daily, weekdays after NSE publishes provisional figures.
  // Skips entirely on weekends/holidays - no point hitting NSE for a day
  // with no trading, and it keeps logs clean about what actually ran.
  
  // Morning Storm: resolve outcomes + carry board refresh (morning + EOD)
  try {
    const stormStore = require('./server/morningStormStore');
    cron.schedule(process.env.MORNING_STORM_RESOLVE_CRON || '20 9 * * 1-5', () => {
      stormStore.resolvePendingOutcomes()
        .then((r) => console.log('[cron] morning-storm resolve', r))
        .catch((e) => console.error('[cron] morning-storm resolve', e.message));
    });
    cron.schedule(process.env.MORNING_STORM_EOD_CRON || '40 15 * * 1-5', () => {
      stormStore.resolvePendingOutcomes()
        .then((r) => console.log('[cron] morning-storm EOD', r))
        .catch((e) => console.error('[cron] morning-storm EOD', e.message));
    });
    // Startup pass
    setTimeout(() => {
      stormStore.resolvePendingOutcomes().catch(() => {});
    }, 8000);
  } catch (e) {
    console.warn('[cron] morning-storm schedules skipped', e.message);
  }

  cron.schedule(process.env.FIIDII_CRON || '30 18 * * 1-5', () => {
    runIfTradingDay('FII/DII collection', collectFiiDii).catch((err) => console.error('[cron] FII/DII collection failed:', err.message));
  });
  // NSE publishes bulk deals a little later than FII/DII provisional
  // figures - give it extra buffer. Best-effort: see bulkDealsCollector.js
  // for why this can legitimately fail on some hosts (NSE IP blocking).
  cron.schedule(process.env.BULK_DEALS_CRON || '0 19 * * 1-5', () => {
    runIfTradingDay('Bulk deals collection', collectBulkDeals).catch((err) => console.error('[cron] bulk deals collection failed:', err.message));
  });
  // Sector map: weekly (this data barely changes day to day) - not
  // trading-day gated since it's not a "pick" action, just metadata sync.
  cron.schedule(process.env.SECTOR_SYNC_CRON || '0 3 * * 0', () => {
    syncAllKnownSectors().catch((err) => console.error('[cron] sector sync failed:', err.message));
  });
  // Official NSE index constituent lists: weekly. NSE only rebalances these
  // twice a year, so weekly is more than enough to stay in sync without
  // extra load - this just refreshes the in-memory INDEXES object, no DB.
  cron.schedule(process.env.INDEX_LIST_REFRESH_CRON || '30 3 * * 0', () => {
    refreshIndexLists().catch((err) => console.error('[cron] index list refresh failed:', err.message));
  });
  // Recommendations: log today's picks once daily (after market close), then
  // refresh every previously-logged pick's latest price so past picks stay
  // trackable (1W/15D/1M performance) - not just the day they were made.
  // Both skip on a market holiday - no new picks get logged, existing data
  // just sits as-is for you to review/plan against.
  // Runs across every index in TRACKED_INDEXES (nifty50 + midcap + smallcap
  // by default) — one index at a time, sequentially, to avoid hammering
  // Yahoo with 3 full scans simultaneously. Set TRACKED_INDEXES=nifty50 in
  // .env to go back to Nifty50-only tracking if API load becomes an issue.
  cron.schedule(process.env.RECOMMEND_LOG_CRON || '45 15 * * 1-5', () => {
    runIfTradingDay('Daily recommendation logging', () => runForTrackedIndexes(logDailyRecommendations, 'daily recommendation logging'))
      .catch((err) => console.error('[cron] recommendation logging failed:', err.message));
  });
  cron.schedule(process.env.RECOMMEND_PRICE_CRON || '0 16 * * 1-5', () => {
    runIfTradingDay('Recommendation price update', updateRecommendationPrices).catch((err) => console.error('[cron] recommendation price update failed:', err.message));
  });
  // Intraday snapshots: several times during market hours, so "9:30 baje ye
  // bola tha, 1:00 baje ye tha" has a real record - not just one EOD number.
  // Also holiday-gated - no snapshots get taken on a non-trading day.
  
  // Next-day high-conviction shortlist once after market close at 5:35 PM IST
  cron.schedule(process.env.TOMORROW_CONVICTION_CRON || '35 17 * * 1-5', () => {
    runIfTradingDay('Tomorrow conviction', async () => {
      const { runTomorrowConviction } = require('./server/tomorrowConviction');
      return runTomorrowConviction({ force: true });
    }).catch((err) => console.error('[cron] tomorrow conviction failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  
  
  // Sector+ancillary investment research — ~monthly (not daily trading)
  cron.schedule(process.env.SECTOR_ANCILLARY_CRON || '0 10 1 * *', () => {
    const { runSectorAncillaryResearch } = require('./server/sectorAncillaryInvest');
    runSectorAncillaryResearch({ force: true })
      .then((d) => console.log('[cron] sector-ancillary:', d.passedSoftFit, 'fits /', d.scanned, 'scanned'))
      .catch((err) => console.error('[cron] sector-ancillary failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  
  // Fundamentals cache warm — weekly Sunday morning (not every scan)
  cron.schedule(process.env.FUNDAMENTALS_WARM_CRON || '0 6 * * 0', async () => {
    try {
      const { INDEXES } = require('./server/indexConstituents');
      const marketData = require('./server/marketData');
      const syms = [...new Set(Object.values(INDEXES).flatMap((i) => (i.symbols || [])))].slice(0, 250);
      let n = 0;
      for (const sym of syms) {
        try {
          await marketData.getFundamentals(sym, { forceRefresh: true });
          n += 1;
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 350));
      }
      console.log('[cron] fundamentals cache refreshed', n, 'symbols');
    } catch (err) {
      console.warn('[cron] fundamentals warm failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

cron.schedule(process.env.TOMORROW_OUTCOME_CRON || '15 16 * * 1-5', () => {
    runIfTradingDay('Tomorrow conviction outcomes', async () => {
      const { resolveTomorrowOutcomes } = require('./server/tomorrowConviction');
      return resolveTomorrowOutcomes();
    }).catch((err) => console.error('[cron] tomorrow outcomes failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  cron.schedule(process.env.INTRADAY_SNAPSHOT_CRON || '30 9,11,13,14 * * 1-5', () => {
    runIfTradingDay('Intraday snapshot', () => runForTrackedIndexes(logIntradaySnapshot, 'intraday snapshot'))
      .catch((err) => console.error('[cron] intraday snapshot failed:', err.message));
  });
  // Weekend deep-dive: full Nifty50+Midcap+Smallcap universe scan, once,
  // ranked for "high profit odds / negligible loss odds" - the market's
  // closed anyway on a weekend, so this deliberately does NOT go through
  // runIfTradingDay (that would skip it every single time). Runs Saturday
  // morning by default; also self-guards (skips if this Monday's batch
  // already exists) so a server restart Sunday doesn't regenerate for no
  // reason - see runWeekendResearch's `force` option to override that.
  cron.schedule(process.env.WEEKEND_RESEARCH_CRON || '0 10 * * 6', () => {
    runWeekendResearch().catch((err) => console.error('[cron] weekend research failed:', err.message));
  });
  // Keeps last weekend's picks' prices fresh once the market reopens -
  // same after-close timing as the daily recommendation price update.
  cron.schedule(process.env.WEEKEND_PICK_PRICE_CRON || '10 16 * * 1-5', () => {
    runIfTradingDay('Weekend pick price update', updateWeekendPickPrices)
      .catch((err) => console.error('[cron] weekend pick price update failed:', err.message));
  });
  // The actual "training step" for the self-improving feedback loop (see
  // server/factorPerformance.js): recompute every signal's real win-rate
  // from whatever's resolved so far, once a week. Not trading-day-gated -
  // it only reads already-resolved historical rows, doesn't need the
  // market open, and Sunday morning is a natural quiet moment for it.
  cron.schedule(process.env.FACTOR_PERFORMANCE_CRON || '0 8 * * 0', () => {
    recomputeFactorPerformance()
      .then((r) => console.log('[cron] factor-performance recompute:', JSON.stringify(r)))
      .catch((err) => console.error('[cron] factor-performance recompute failed:', err.message));
  });
  console.log(`[cron] scheduled: FII/DII daily, sector map weekly, recommendation log + price-update daily, intraday snapshots 4x/day (Best of Today + Golden Opportunity only — not per-index Nifty50/Midcap/Smallcap tabs), weekend deep-dive research Saturdays, factor-performance recompute Sundays — all pick/logging actions skip automatically on weekends and market holidays (except the weekend research itself, which runs BECAUSE it's the weekend).`);
}

async function start() {
  // Doesn't need Mongo - just fetches the official NSE index lists into the
  // in-memory INDEXES object. Awaited before anything else touches INDEXES,
  // so the very first scan/cron run already uses the full ~450-stock
  // universe (Nifty50+Midcap150+Smallcap250) rather than briefly falling
  // back to the smaller hand-curated lists while this is still in flight.
  await refreshIndexLists().catch((err) => console.error('[startup] index list refresh failed, using fallback lists:', err.message));

  if (isMongoConfigured()) {
    try {
      await connectMongo();
      await seedHolidaysIfEmpty();
      // Makes sure exactly one admin exists (see server/models/User.js) -
      // safe/cheap to call on every startup, only actually touches the DB
      // the very first time there's no admin yet.
      require('./server/models/User').ensureAdminBootstrap()
        .catch((err) => console.error('[startup] admin bootstrap failed:', err.message));
      // Model Learning: on every start, if last recompute is older than
      // ~20h (or never), recompute from resolved picks. So Sat/Mon/anytime
      // you turn the server ON, learning updates without needing Sunday cron
      // or a permanently hosted machine. Env: LEARNING_STALE_HOURS (default 20).
      const staleHours = Number(process.env.LEARNING_STALE_HOURS || 20);
      maybeRecomputeIfStale(staleHours * 60 * 60 * 1000)
        .then((r) => {
          if (r?.skipped) console.log(`[startup] Model Learning cache warm (fresh, age ${r.ageHours}h)`);
          else if (r?.ok) console.log(`[startup] Model Learning recomputed: ${r.factorsTracked} signals from ${r.resolvedPicksUsed} resolved`);
          else console.log('[startup] Model Learning:', r?.reason || r?.error || r);
        })
        .catch((err) => console.error('[startup] Model Learning recompute failed:', err.message));
      startCronJobs();

      // Kal ke liye: if server starts anytime AFTER 5:35 PM IST on a trading
      // day and today's pack is missing, run once (local PC often off at exact 5:35).
      setTimeout(() => {
        try {
          const { maybeRunTomorrowConvictionIfDue } = require('./server/tomorrowConviction');
          maybeRunTomorrowConvictionIfDue()
            .then((r) => {
              if (r?.skipped) console.log('[startup] tomorrow-conviction:', r.reason, r.asOfDate || '');
              else console.log('[startup] tomorrow-conviction ran:', r?.pickCount, 'picks for', r?.asOfDate);
            })
            .catch((err) => console.error('[startup] tomorrow-conviction failed:', err.message));
        } catch (err) {
          console.error('[startup] tomorrow-conviction load failed:', err.message);
        }
      }, 8000);

      // Run once shortly after startup so there's data to look at without
      // waiting for the next scheduled time (each fails silently on its own
      // if Yahoo/NSE is unreachable right now - the cron will retry later).
      // Also holiday-gated, same as the scheduled runs.
      setTimeout(() => {
        // Not trading-day-gated - this only backfills missing detail fields
        // on already-resolved historical records (see backfillHitDetails
        // doc comment), it doesn't make new picks or need the market open.
        backfillHitDetails().catch((err) => console.error('[startup] hit-detail backfill failed:', err.message));
        runIfTradingDay('startup FII/DII collection', collectFiiDii).catch(() => {});
        
      // Full-index fundamentals cache: one-by-one into Mongo fundamentals_cache.
      // Skips symbols already fresh (<7d). Does NOT re-fetch every restart.
      setTimeout(() => {
        try {
          const { INDEXES } = require('./server/indexConstituents');
          const { warmFundamentals } = require('./server/fundamentalsWarm');
          const syms = [...new Set(Object.values(INDEXES).flatMap((i) => i.symbols || []))];
          try {
          const { dedupeFundamentalsCache } = require('./server/fundamentalsStore');
          dedupeFundamentalsCache()
            .then((r) => console.log('[startup] fundamentals_cache dedupe:', r))
            .catch((e) => console.warn('[startup] fund dedupe failed:', e.message));
        } catch (_) {}
        // Startup fund warm: skip full crawl on holiday/weekend if cache already healthy
        const { getTradingDayStatus } = require('./server/marketCalendar');
        getTradingDayStatus().then(async (st) => {
          if (!st.isTradingDay) {
            console.log('[startup] fundamentals warm skipped —', st.reason || 'non-trading day', '(cache already used; no market change expected)');
            return;
          }
          const { isFundamentalsRefreshWindow } = require('./server/fundamentalsWarm');
          if (!isFundamentalsRefreshWindow()) {
            console.log('[startup] fundamentals warm skipped — outside window (09:45–10:15 or after 15:30 IST). Using existing cache.');
            return { ok: true, skipped: true, reason: 'outside_fund_window' };
          }
          console.log('[startup] fundamentals warm starting for', syms.length, 'index symbols → collection fundamentals_cache');
          return warmFundamentals(syms, { jobId: 'startup-fund-warm', delayMs: 500, forceAll: false })
            .then((r) => console.log('[startup] fundamentals warm finished:', r));
        }).catch((err) => console.error('[startup] fundamentals warm failed:', err.message));
        } catch (err) {
          console.error('[startup] fundamentals warm schedule failed:', err.message);
        }
      }, 12000);

runIfTradingDay('startup bulk deals collection', collectBulkDeals).catch(() => {});
        // sector map: only on trading days (weekend/holiday restart mat peelo)
        getTradingDayStatus().then((st) => {
          if (!st.isTradingDay) {
            console.log('[startup] sectorSync skipped —', st.reason || 'non-trading');
            return;
          }
          return syncAllKnownSectors();
        }).catch(() => {});
        runIfTradingDay('startup recommendation logging', () => runForTrackedIndexes(logDailyRecommendations, 'startup recommendation logging')).catch(() => {});
        runIfTradingDay('startup recommendation price update', updateRecommendationPrices).catch(() => {});
        runIfTradingDay('startup intraday snapshot', () => runForTrackedIndexes(logIntradaySnapshot, 'startup intraday snapshot')).catch(() => {});
      }, 8000);
    } catch (err) {
      console.error('[mongo] Could not connect on startup:', err.message);
      console.error('[mongo] Login, watchlist, alerts, journal, and institutional data will not work until MONGODB_URL is reachable. Stock search/analysis (which does not need a database) still works.');
    }
  } else {
    console.warn('[mongo] MONGODB_URL is not set in .env - login, watchlist, alerts, journal, and institutional data are all disabled. Stock search/analysis still works since those need no database.');
  }

  attachWebSocket(server);
  startAlertChecker();
  startWatchlistChecker();

  server.listen(PORT, () => {
    console.log(`Stock Analyzer running at http://localhost:${PORT}`);
  });
}

start();
