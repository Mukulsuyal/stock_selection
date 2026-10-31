/**
 * Trading-calendar logic for Week Runner (pure functions, UTC-safe date strings YYYY-MM-DD).
 * Answers: "kab karna hai, kab tak rakhna hai, expiry/holiday/long-weekend ka kya?"
 */
'use strict';
// Fallback only (DB holidays are merged on top). Source: NSE 2026 list; always confirm on nseindia.com.
const FALLBACK_HOLIDAYS_2026 = ['2026-11-10', '2026-11-24', '2026-12-25'];
const HOLD_TRADING_DAYS = 7;

const parse = (s) => new Date(s + 'T00:00:00Z');
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const weekday = (s) => parse(s).getUTCDay(); // 0 Sun .. 6 Sat
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const label = (s) => `${DOW[weekday(s)]} ${s.slice(8)}-${s.slice(5, 7)}`;

function isTradingDay(s, hol) { const w = weekday(s); return w !== 0 && w !== 6 && !hol.has(s); }
function nextTradingDay(s, hol, n = 1) { let d = s; let c = 0; while (c < n) { d = addDays(d, 1); if (isTradingDay(d, hol)) c++; } return d; }
function prevTradingDay(s, hol) { let d = addDays(s, -1); while (!isTradingDay(d, hol)) d = addDays(d, -1); return d; }

/** Nifty weekly expiry = Tuesday (previous trading day if Tuesday is a holiday). */
function expiryInfo(s, hol) {
  const w = weekday(s); const monOffset = w === 0 ? -6 : 1 - w;
  const tue = addDays(s, monOffset + 1);
  const exp = isTradingDay(tue, hol) ? tue : prevTradingDay(tue, hol);
  const isExpiry = exp === s;
  const monthly = isExpiry && addDays(tue, 7).slice(0, 7) !== tue.slice(0, 7); // last Tuesday of month (stock F&O monthly expiry too)
  return { isExpiry, monthly };
}

/**
 * @param todayIST 'YYYY-MM-DD' (IST), istMinutes minutes since midnight IST, hol Set of holiday dates
 */
function sessionPlan({ todayIST, istMinutes, hol }) {
  const tradingToday = isTradingDay(todayIST, hol);
  let mode, actionDate;
  if (tradingToday && istMinutes < 9 * 60 + 15) { mode = 'PRE_OPEN'; actionDate = todayIST; }
  else if (tradingToday && istMinutes < 15 * 60 + 45) { mode = 'LIVE'; actionDate = todayIST; }
  else { mode = tradingToday ? 'POST_CLOSE' : 'CLOSED'; actionDate = nextTradingDay(todayIST, hol, 1); }
  const exitBy = nextTradingDay(actionDate, hol, HOLD_TRADING_DAYS - 1);   // entry day = day 1
  const dayAfter = nextTradingDay(actionDate, hol, 1);
  const closedGapDays = (parse(dayAfter) - parse(actionDate)) / 86400000 - 1; // calendar days market stays shut after entry day
  const longClosureAfterEntry = closedGapDays >= 3;                           // normal weekend = 2
  const prevTD = prevTradingDay(actionDate, hol);
  const gapBefore = (parse(actionDate) - parse(prevTD)) / 86400000 - 1;       // shut days just before entry day
  const holidaysInWindow = []; for (let d = actionDate; d <= exitBy; d = addDays(d, 1)) if (weekday(d) !== 0 && weekday(d) !== 6 && hol.has(d)) holidaysInWindow.push(d);
  const ex = expiryInfo(actionDate, hol);
  const lines = []; const warnings = [];
  const when = mode === 'PRE_OPEN' ? 'Aaj subah (market khulne se pehle)' : mode === 'LIVE' ? 'Market chal raha hai' : mode === 'POST_CLOSE' ? 'Market band ho gaya' : 'Aaj market band hai';
  lines.push(`${when}. Ye scan ${mode === 'LIVE' ? 'kal ke close' : mode === 'POST_CLOSE' ? 'aaj ke close' : 'pichle trading din ke close'} ke data pe hai.`);
  lines.push(mode === 'LIVE' ? `Kharidna ho to AAJ (${label(actionDate)}) hi — par sirf agar stock abhi bhi "OK" dikhe (MISSED ho to chhodo).` : `Kharidne ka din: ${label(actionDate)} (agla trading din).`);
  lines.push('Kitne din rakhna hai: har stock ke card me likha hai (setup ke hisaab se 7–15 trading din) — wahi "nikalne ka din" follow karo.');
  if (gapBefore >= 2) warnings.push(`${label(actionDate)} se pehle market ${gapBefore} din band tha — weekend/holiday ki news ka gap aa sakta hai. Open dekhke hi lo, "SKIP" level strict rakho.`);
  if (ex.isExpiry) warnings.push(`${label(actionDate)} Nifty ${ex.monthly ? 'MONTHLY' : 'weekly'} expiry hai — subah volatility zyada. 9:30 se pehle order mat daalo; limit order hi use karo.`);
  if (longClosureAfterEntry) warnings.push(`${label(actionDate)} ke baad market ${closedGapDays} din band (lamba weekend/holiday) — us beech stop-loss kaam nahi karega. Naya entry AVOID.`);
  if (holidaysInWindow.length) warnings.push(`Is hold-window me holiday: ${holidaysInWindow.map(label).join(', ')} — exit-by date upar holiday ginke nikali gayi hai.`);
  return { mode, tradingToday, actionDate, actionLabel: label(actionDate), exitBy, exitByLabel: label(exitBy), lines, warnings, blockNewEntries: longClosureAfterEntry, isExpiryDay: ex.isExpiry, isMonthlyExpiry: ex.monthly, holidaysInWindow };
}

module.exports = { FALLBACK_HOLIDAYS_2026, isTradingDay, nextTradingDay, prevTradingDay, expiryInfo, sessionPlan, label, addDays, weekday };
