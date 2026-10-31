// server/marketCalendar.js
// Single source of truth for "is the market open today" - weekends AND
// NSE trading holidays (festivals, national holidays NSE observes). Every
// automated background job (recommendation logging, intraday snapshots,
// FII/DII collection, watchlist/alert checks) checks this first and skips
// itself entirely on a non-trading day - no picks, no new data logged,
// nothing performed. Browsing/viewing the app still works normally on a
// holiday (last available data), since that's read-only and doesn't touch
// any of this.
const { isMongoConfigured } = require('./mongo');
const MarketHoliday = require('./models/MarketHoliday');

let holidayCache = { dates: null, fetchedAt: 0 };
const CACHE_MS = 60 * 60 * 1000; // holidays don't change during a day - refresh hourly is plenty

async function getHolidaySet() {
  if (!isMongoConfigured()) return new Set();
  if (holidayCache.dates && Date.now() - holidayCache.fetchedAt < CACHE_MS) return holidayCache.dates;
  const docs = await MarketHoliday.find({}).lean();
  const dates = new Set(docs.map((d) => d.date));
  holidayCache = { dates, fetchedAt: Date.now() };
  return dates;
}

function todayIST(date = new Date()) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

async function getTradingDayStatus(date = new Date()) {
  const ist = todayIST(date);
  const day = ist.getDay(); // 0 Sun, 6 Sat
  if (day === 0 || day === 6) {
    return { isTradingDay: false, reason: 'Weekend', dateStr: ist.toISOString().slice(0, 10) };
  }
  const dateStr = ist.toISOString().slice(0, 10);
  const holidays = await getHolidaySet();
  if (holidays.has(dateStr)) {
    const docs = await MarketHoliday.findOne({ date: dateStr }).lean();
    return { isTradingDay: false, reason: docs?.name || 'Market Holiday', dateStr };
  }
  return { isTradingDay: true, reason: null, dateStr };
}

// Convenience for cron callbacks: run `fn` only if today is a trading day,
// otherwise log why it was skipped and do nothing.
async function runIfTradingDay(label, fn) {
  try {
    const status = await getTradingDayStatus();
    if (!status.isTradingDay) {
      console.log(`[marketCalendar] ${label} skipped — ${status.reason} (${status.dateStr}). No picks/actions performed today.`);
      return { ok: true, skipped: true, reason: status.reason };
    }
    return await fn();
  } catch (err) {
    console.error(`[marketCalendar] ${label} failed while checking trading-day status:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Counts trading days strictly AFTER fromDateStr up to and including
// toDateStr - skips weekends AND logged NSE holidays, so "predicted window
// elapsed" or "kitne din laga" always means trading days, never calendar
// days. Both args are 'YYYY-MM-DD'. Returns 0 if toDateStr <= fromDateStr.
async function countTradingDaysBetween(fromDateStr, toDateStr) {
  const holidays = await getHolidaySet();
  const from = new Date(`${fromDateStr}T00:00:00`);
  const to = new Date(`${toDateStr}T00:00:00`);
  if (to <= from) return 0;
  let count = 0;
  const cur = new Date(from);
  cur.setDate(cur.getDate() + 1);
  while (cur <= to) {
    const day = cur.getDay(); // 0 Sun, 6 Sat
    const dateStr = cur.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(dateStr)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

module.exports = { todayIST, getTradingDayStatus, runIfTradingDay, countTradingDaysBetween };
