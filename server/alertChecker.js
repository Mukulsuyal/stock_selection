// server/alertChecker.js
// Cron job: periodically checks active price alerts against live quotes.
const cron = require('node-cron');
const Alert = require('./models/Alert');
const User = require('./models/User');
const marketData = require('./marketData');
const { sendAlertEmail } = require('./mailer');
const { getTradingDayStatus } = require('./marketCalendar');
const stormAlerts = require('./morningStormAlerts');

function startAlertChecker() {
  const schedule = process.env.ALERT_CHECK_CRON || '*/1 * * * *';
  cron.schedule(schedule, async () => {
    try {
      const status = await getTradingDayStatus();
      if (!status.isTradingDay) return; // holiday/weekend - price is stale, nothing to check
    } catch { /* if the calendar check itself fails, fall through and check anyway */ }

    let active;
    try {
      active = await Alert.allActive();
    } catch (err) {
      console.error('[alertChecker] could not load active alerts (is MongoDB reachable?):', err.message);
      return;
    }
    if (!active.length) return;

    const bySymbol = active.reduce((acc, a) => {
      (acc[a.symbol] = acc[a.symbol] || []).push(a);
      return acc;
    }, {});

    for (const symbol of Object.keys(bySymbol)) {
      try {
        const quote = await marketData.getQuote(symbol);
        const price = quote.lastPrice;
        for (const alert of bySymbol[symbol]) {
          const hit =
            (alert.condition === 'above' && price >= alert.target_price) ||
            (alert.condition === 'below' && price <= alert.target_price);
          if (hit) {
            await Alert.markTriggered(alert.id);
            const user = await User.findById(alert.user_id);
            if (user) {
              await sendAlertEmail(
                user.email,
                `Price alert: ${symbol} is ${alert.condition} ${alert.target_price}`,
                `${symbol} just hit ${price} (target: ${alert.condition} ${alert.target_price}).`
              );
            }
          }
        }
      } catch (err) {
        console.error(`[alertChecker] failed for ${symbol}:`, err.message);
      }
    }

    // Morning Storm system watches (SL/T levels)
    try {
      const watches = await stormAlerts.getActiveWatches();
      const bySym = {};
      for (const w of watches) {
        (bySym[w.symbol] = bySym[w.symbol] || []).push(w);
      }
      for (const symbol of Object.keys(bySym)) {
        try {
          const quote = await marketData.getQuote(symbol);
          const price = quote?.lastPrice;
          if (price == null) continue;
          for (const w of bySym[symbol]) {
            const hit =
              (w.condition === 'above' && price >= w.targetPrice) ||
              (w.condition === 'below' && price <= w.targetPrice);
            if (hit) {
              await stormAlerts.markTriggered(w._id, price);
              console.log(`[alertChecker] MorningStorm ${symbol} ${w.tag} hit @ ${price}`);
            }
          }
        } catch (err) {
          console.error(`[alertChecker] storm watch ${symbol}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[alertChecker] storm watches', err.message);
    }
  });
  console.log(`[alertChecker] scheduled with cron "${schedule}"`);
}

module.exports = { startAlertChecker };
