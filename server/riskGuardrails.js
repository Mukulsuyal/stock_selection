// server/riskGuardrails.js
// Checks the trading-discipline rules that don't depend on any single
// stock: has today's loss limit been hit, has the daily trade count been
// hit, is there an active cooldown after a recent loss. All computed from
// the user's own Journal + their UserSettings - nothing external.
const Journal = require('./models/Journal');
const UserSettings = require('./models/UserSettings');

function tradePnl(trade) {
  if (trade.status !== 'closed' || trade.exit_price == null) return null;
  const perShare = trade.side === 'buy' ? (trade.exit_price - trade.price) : (trade.price - trade.exit_price);
  return perShare * trade.quantity;
}

async function getTradingStatus(userId) {
  const settings = await UserSettings.getFor(userId);
  const allTrades = await Journal.list(userId);

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todaysTrades = allTrades.filter((t) => new Date(t.trade_date) >= startOfToday);
  const todaysClosed = todaysTrades.filter((t) => t.status === 'closed');
  const todaysPnl = todaysClosed.reduce((sum, t) => sum + (tradePnl(t) || 0), 0);
  const todaysPnlPct = settings.capital ? (todaysPnl / settings.capital) * 100 : null;
  const dailyLimitHit = todaysPnlPct !== null && todaysPnlPct <= -Math.abs(settings.maxDailyLossPct);
  const maxTradesHit = todaysTrades.length >= settings.maxTradesPerDay;

  const closedSorted = allTrades
    .filter((t) => t.status === 'closed' && t.exit_date)
    .sort((a, b) => new Date(b.exit_date) - new Date(a.exit_date));
  const mostRecent = closedSorted[0];
  let inCooldown = false, cooldownMinutesLeft = 0;
  if (mostRecent) {
    const pnl = tradePnl(mostRecent);
    if (pnl !== null && pnl < 0) {
      const minutesSince = (Date.now() - new Date(mostRecent.exit_date).getTime()) / 60000;
      if (minutesSince < settings.cooldownMinutes) {
        inCooldown = true;
        cooldownMinutesLeft = Math.ceil(settings.cooldownMinutes - minutesSince);
      }
    }
  }

  return {
    settings,
    todaysPnl: Number(todaysPnl.toFixed(2)),
    todaysPnlPct: todaysPnlPct !== null ? Number(todaysPnlPct.toFixed(2)) : null,
    dailyLimitHit,
    tradesTakenToday: todaysTrades.length,
    maxTradesHit,
    inCooldown,
    cooldownMinutesLeft,
    canTakeNewTrade: !dailyLimitHit && !maxTradesHit && !inCooldown,
  };
}

module.exports = { getTradingStatus, tradePnl };
