// server/watchlistChecker.js
// Periodically re-checks every user's watchlist against the live rule
// engine. When a stock's verdict flips (e.g. Neutral -> Bullish lean, or
// Bullish -> Bearish), that's a signal worth surfacing without the user
// having to remember to go check manually. Sends ONE digest email per user
// per run (not one email per stock) so it's useful, not spammy.
const cron = require('node-cron');
const Watchlist = require('./models/Watchlist');
const marketData = require('./marketData');
const { analyze } = require('./indicators');
const { getMarketTrend } = require('./marketTrend');
const { sendAlertEmail } = require('./mailer');
const { getTradingDayStatus } = require('./marketCalendar');

async function checkWatchlists() {
  const status = await getTradingDayStatus();
  if (!status.isTradingDay) return; // holiday/weekend - verdicts won't have meaningfully changed

  const rows = await Watchlist.allWithUsers();
  if (!rows.length) return;

  const bySymbol = rows.reduce((acc, r) => {
    (acc[r.symbol] = acc[r.symbol] || []).push(r);
    return acc;
  }, {});

  const marketContext = await getMarketTrend();
  const changesByUser = {}; // user_id -> [{symbol, from, to}]

  for (const symbol of Object.keys(bySymbol)) {
    try {
      const [quote, candles] = await Promise.all([
        marketData.getQuote(symbol),
        marketData.getHistorical(symbol, 300),
      ]);
      if (!candles.length) continue;
      const result = analyze(candles, quote, marketContext);

      for (const row of bySymbol[symbol]) {
        if (row.last_verdict && row.last_verdict !== result.verdict) {
          changesByUser[row.user_id] = changesByUser[row.user_id] || { email: row.user_email, changes: [] };
          changesByUser[row.user_id].changes.push({ symbol, from: row.last_verdict, to: result.verdict });
        }
        await Watchlist.updateVerdict(row.id, result.verdict, result.score);
      }
    } catch (err) {
      console.error(`[watchlistChecker] failed for ${symbol}:`, err.message);
    }
  }

  for (const [userId, { email, changes }] of Object.entries(changesByUser)) {
    const lines = changes.map((c) => `${c.symbol}: ${c.from} -> ${c.to}`).join('\n');
    await sendAlertEmail(
      email,
      `Watchlist update: ${changes.length} stock(s) changed signal`,
      `Your watchlist had these verdict changes:\n\n${lines}\n\nThis is a rule-based technical read, not financial advice - always check further before acting.`
    );
  }
}

function startWatchlistChecker() {
  const schedule = process.env.WATCHLIST_CHECK_CRON || '0 * * * *'; // hourly by default
  cron.schedule(schedule, () => {
    checkWatchlists().catch((err) => console.error('[watchlistChecker] run failed:', err.message));
  });
  console.log(`[watchlistChecker] scheduled with cron "${schedule}"`);
}

module.exports = { startWatchlistChecker, checkWatchlists };
