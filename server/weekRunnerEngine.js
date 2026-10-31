/**
 * Week Runner Engine v2 — capital-protection first.
 *
 * Philosophy
 *  1. Signals are computed on COMPLETED daily bars only; entry is NEXT DAY OPEN (what you can really get).
 *  2. A stock must NOT have already run (1D/3D/5D/extension gates) and must be liquid, non-operator, no gap-prone junk.
 *  3. Market regime gate (Nifty trend + VIX + sharp-drop circuit breaker) can switch the whole system OFF.
 *  4. Every setup is walk-forward tested on the universe (net of costs, gap-aware exits). A setup only
 *     gets "LICENSED" to produce tradable picks if its OUT-OF-SAMPLE expectancy / profit factor /
 *     year-consistency are positive. Otherwise it is PAPER-ONLY. No licensed setup => NO TRADE.
 *  5. Per-stock stats are shrunk toward the setup average (small samples cannot fake a 90% win-rate).
 *  6. Position size from risk budget incl. gap buffer; heat & sector caps; forward-test kill switch (separate module).
 *
 * No claim of certainty anywhere: numbers shown are measured, with n and caveats.
 */
'use strict';

const CFG = {
  // ---- hard "already ran / extended" gates (%) ----
  MAX_1D: 2.5, MAX_3D: 5, MAX_5D: 7, MAX_ABOVE_SMA20: 8,
  // ---- universal quality gates ----
  MIN_PRICE: 30,
  MIN_TURNOVER_CR: 5,        // median 20d traded value, ₹ crore
  MIN_ATR_PCT: 1.8, MAX_ATR_PCT: 6.5,
  MAX_GAP_STD_PCT: 2.2,      // overnight-gap volatility cap
  MAX_ABS_1D_60: 12,         // any 12%+ daily move in 60d => event/operator-ish
  MAX_LIMIT_MOVES_60: 1,     // days with |ret|>9.5%
  MAX_VOL_SPIKE_20: 9,       // max vol(20d)/median vol(60d) => pump
  // ---- trade rules (shared) ----
  T2: 10,                    // informational +10% hit-rate
  STOP_MIN: 0.025,
  MAX_GAP_UP: 2.0,           // skip if next open > 2% above signal close
  SLIPPAGE_PCT: 0.10,        // on entry
  COST_PCT: 0.30,            // round trip brokerage+STT+charges+exit slippage
  // ---- Setup Lab / licensing (out-of-sample) ----
  LIC_MIN_TRAIN: 40, LIC_MIN_OOS: 40, LIC_MIN_ALL: 100, LIC_MIN_EXP: 0.4, LIC_MIN_PF: 1.25, LIC_MIN_POS_YEAR_FRAC: 0.6,
  REGIME_MIN_N: 20,
  // ---- sizing ----
  GAP_BUFFER_MULT: 1.0, MAX_POS_PCT: 25, MAX_PICKS: 5, MAX_PER_SECTOR: 2, EARNINGS_BLACKOUT_DAYS: 9,
  SHRINK_K: 8,
};

/* Exit profiles + stop widths the Lab searches over (chosen on TRAIN data only, judged on untouched TEST data) */
const EXITS = {
  W7:  { key: 'W7',  label: '7 din · +5% pe aadha', hold: 7,  t1: 5, t3: 15, trail: 2.2 },
  W10: { key: 'W10', label: '10 din · +6% pe aadha', hold: 10, t1: 6, t3: 18, trail: 2.5 },
  T15: { key: 'T15', label: '15 din · +8% pe aadha (trend ride)', hold: 15, t1: 8, t3: 30, trail: 2.8 },
};
const STOPS = { S12: 1.2, S20: 2.0, S30: 3.0 };  // × ATR
const stopMaxFor = (m) => (m >= 3 ? 0.12 : m >= 2 ? 0.09 : 0.06);

/* ----------------------------- small utils ----------------------------- */
const pct = (a, b) => (b ? (a / b - 1) * 100 : null);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function stdev(a) { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function wilsonLow(k, n, z = 1.64) { if (!n) return null; const p = k / n; const d = 1 + z * z / n; const c = p + z * z / (2 * n); const m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return (c - m) / d; }
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(1)));
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(2)));

/* ----------------------------- data hygiene ----------------------------- */
/**
 * Returns cleaned candles or null (with reason) if the stock must be skipped.
 * - drops invalid bars
 * - drops the LIVE (incomplete) bar if today's IST session is not finished
 * - rejects stale data
 */
function cleanCandles(raw, { todayIST = null, istMinutes = null } = {}) {
  if (!Array.isArray(raw) || raw.length < 260) return { c: null, reason: 'kam history (<260 din)' };
  let c = raw.filter((x) => x && x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0 && x.high >= x.low && x.date);
  if (c.length < 260) return { c: null, reason: 'kharab data' };
  if (todayIST && istMinutes != null && c[c.length - 1].date === todayIST && istMinutes < 15 * 60 + 45) c = c.slice(0, -1);
  if (todayIST) {
    const age = (new Date(todayIST) - new Date(c[c.length - 1].date)) / 86400000;
    if (age > 7) return { c: null, reason: 'stale data (>7 din purana)' };
  }
  return { c };
}

/* ----------------------------- causal series ----------------------------- */
function rollingMean(a, p) { const o = new Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function rollingStd(a, p) { const o = new Array(a.length).fill(null); let s = 0, q = 0; for (let i = 0; i < a.length; i++) { s += a[i]; q += a[i] * a[i]; if (i >= p) { s -= a[i - p]; q -= a[i - p] * a[i - p]; } if (i >= p - 1) { const m = s / p; o[i] = Math.sqrt(Math.max(0, q / p - m * m) * p / (p - 1)); } } return o; }
function wilderATR(S, p = 14) {
  const o = new Array(S.n).fill(null); const tr = new Array(S.n).fill(0);
  for (let i = 0; i < S.n; i++) tr[i] = i === 0 ? S.high[0] - S.low[0] : Math.max(S.high[i] - S.low[i], Math.abs(S.high[i] - S.close[i - 1]), Math.abs(S.low[i] - S.close[i - 1]));
  if (S.n <= p) return o;
  let a = 0; for (let i = 1; i <= p; i++) a += tr[i]; a /= p; o[p] = a;
  for (let i = p + 1; i < S.n; i++) { a = (a * (p - 1) + tr[i]) / p; o[i] = a; }
  return o;
}
function wilderRSI(cl, p = 14) {
  const o = new Array(cl.length).fill(null); if (cl.length <= p) return o;
  let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return o;
}

function buildSeries(c, nifty) {
  const n = c.length;
  const S = { n, c, date: c.map((x) => x.date), open: c.map((x) => x.open), high: c.map((x) => x.high), low: c.map((x) => x.low), close: c.map((x) => x.close), vol: c.map((x) => x.volume || 0) };
  S.sma20 = rollingMean(S.close, 20); S.sma50 = rollingMean(S.close, 50); S.sma200 = rollingMean(S.close, 200);
  S.atr = wilderATR(S); S.rsi = wilderRSI(S.close);
  const sd20 = rollingStd(S.close, 20);
  S.bbw = S.close.map((_, i) => (sd20[i] != null && S.sma20[i] ? (4 * sd20[i]) / S.sma20[i] * 100 : null));
  S.ret1 = S.close.map((x, i) => (i ? pct(x, S.close[i - 1]) : 0));
  S.gap = S.open.map((x, i) => (i ? pct(x, S.close[i - 1]) : 0));
  S.nifty = null;
  if (nifty && nifty.length) {
    const m = new Map(nifty.map((x) => [x.date, x.close])); let last = null;
    S.nifty = S.date.map((d) => { const v = m.get(d); if (v != null) last = v; return last; });
  }
  return S;
}

/* ----------------------------- features (NO look-ahead) ----------------------------- */
function featuresAt(S, i) {
  if (i < 220 || i >= S.n) return null;
  const { close, high, low, vol } = S;
  const f = { i, date: S.date[i], close: close[i] };
  f.sma20 = S.sma20[i]; f.sma50 = S.sma50[i]; f.sma200 = S.sma200[i]; f.atr = S.atr[i]; f.rsi = S.rsi[i];
  if (!f.sma20 || !f.sma50 || !f.sma200 || !f.atr || f.rsi == null) return null;
  f.atrPct = (f.atr / f.close) * 100;
  f.d1 = pct(close[i], close[i - 1]); f.d3 = pct(close[i], close[i - 3]); f.d5 = pct(close[i], close[i - 5]);
  f.aboveSma20 = pct(close[i], f.sma20);
  f.trendUp = f.close > f.sma50 && f.sma50 > f.sma200;
  f.sma50Rising = S.sma50[i] > S.sma50[i - 10];
  let hi20 = -Infinity, lo10 = Infinity, hi10 = -Infinity, lo3 = Infinity, hi252 = -Infinity;
  for (let k = i - 20; k < i; k++) hi20 = Math.max(hi20, high[k]);
  for (let k = i - 9; k <= i; k++) { lo10 = Math.min(lo10, low[k]); hi10 = Math.max(hi10, high[k]); }
  for (let k = i - 2; k <= i; k++) lo3 = Math.min(lo3, low[k]);
  for (let k = i - 251; k <= i; k++) hi252 = Math.max(hi252, high[k]);
  Object.assign(f, { hi20, lo10, lo3, hi252 });
  f.distHigh20 = pct(hi20, close[i]);        // >0 below the 20d high, <0 already above
  f.distHigh252 = pct(hi252, close[i]);
  f.range10 = ((hi10 - lo10) / close[i]) * 100;
  // Bollinger-width percentile over 120d
  const cur = S.bbw[i]; let le = 0, tot = 0;
  for (let k = i - 119; k <= i; k++) { const w = S.bbw[k]; if (w != null) { tot++; if (w <= cur) le++; } }
  f.bbPctl = cur != null && tot > 60 ? (le / tot) * 100 : null;
  // volume
  let s20 = 0; for (let k = i - 20; k < i; k++) s20 += vol[k]; const v20 = s20 / 20;
  let s5 = 0; for (let k = i - 4; k <= i; k++) s5 += vol[k]; const v5 = s5 / 5;
  f.volRatio5v20 = v20 ? v5 / v20 : null; f.volToday = v20 ? vol[i] / v20 : null;
  let up = 0, dn = 0; for (let k = i - 19; k <= i; k++) { if (close[k] > close[k - 1]) up += vol[k]; else dn += vol[k]; }
  f.accum = dn ? up / dn : 2;
  const to = []; for (let k = i - 19; k <= i; k++) to.push(close[k] * vol[k]); f.turnoverCr = median(to) / 1e7;
  // risk / manipulation
  const gaps = []; let maxAbs = 0, limit = 0; for (let k = i - 59; k <= i; k++) { gaps.push(S.gap[k]); const a = Math.abs(S.ret1[k]); maxAbs = Math.max(maxAbs, a); if (a > 9.5) limit++; }
  f.gapStd = stdev(gaps); f.maxAbs1D60 = maxAbs; f.limitMoves60 = limit;
  const v60 = []; for (let k = i - 59; k <= i; k++) v60.push(vol[k]); const mv = median(v60) || 1;
  let mx20 = 0; for (let k = i - 19; k <= i; k++) mx20 = Math.max(mx20, vol[k]); f.volSpike20 = mx20 / mv;
  f.anomaly = false; for (let k = i - 259; k <= i; k++) if (k > 0 && Math.abs(S.ret1[k]) > 35) { f.anomaly = true; break; }
  // candle / range
  const rng = (k) => high[k] - low[k]; let minR = Infinity; for (let k = i - 6; k < i; k++) minR = Math.min(minR, rng(k)); f.nr7 = rng(i) <= minR;
  f.closePos = rng(i) > 0 ? (close[i] - low[i]) / rng(i) : 0.5;
  f.upClose = close[i] > close[i - 1];
  // relative strength vs Nifty
  if (S.nifty && S.nifty[i] != null && S.nifty[i - 60] != null) {
    f.rs20 = pct(close[i], close[i - 20]) - pct(S.nifty[i], S.nifty[i - 20]);
    f.rs60 = pct(close[i], close[i - 60]) - pct(S.nifty[i], S.nifty[i - 60]);
  } else { f.rs20 = null; f.rs60 = null; }
  return f;
}

/* ----------------------------- universal gates ----------------------------- */
function commonGate(f) {
  const x = [];
  if (f.anomaly) x.push('data anomaly (split/bad tick)');
  if (f.close < CFG.MIN_PRICE) x.push('price < ₹' + CFG.MIN_PRICE);
  if (f.turnoverCr < CFG.MIN_TURNOVER_CR) x.push(`illiquid (₹${f.turnoverCr.toFixed(1)}cr/din)`);
  if (f.atrPct < CFG.MIN_ATR_PCT) x.push('ATR kam — hafte me 5% mushkil');
  if (f.atrPct > CFG.MAX_ATR_PCT) x.push('ATR bahut zyada — risky/wild');
  if (f.gapStd > CFG.MAX_GAP_STD_PCT) x.push(`gap-prone (gap σ ${f.gapStd.toFixed(1)}%)`);
  if (f.maxAbs1D60 > CFG.MAX_ABS_1D_60 || f.limitMoves60 > CFG.MAX_LIMIT_MOVES_60) x.push('operator/event-type jump pichle 60d me');
  if (f.volSpike20 > CFG.MAX_VOL_SPIKE_20) x.push('volume pump pattern');
  if (f.d1 > CFG.MAX_1D) x.push(`aaj hi +${f.d1.toFixed(1)}% chal gaya`);
  if (f.d3 > CFG.MAX_3D) x.push(`3D +${f.d3.toFixed(1)}% chal chuka`);
  if (f.d5 > CFG.MAX_5D) x.push(`5D +${f.d5.toFixed(1)}% chal chuka`);
  if (f.aboveSma20 > CFG.MAX_ABOVE_SMA20) x.push(`SMA20 se ${f.aboveSma20.toFixed(1)}% upar (extended)`);
  return x;
}

/* ----------------------------- setups ----------------------------- */
const ck = (ok, name, need, have) => ({ ok: !!ok, msg: name, need, have });
const fx = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const SETUPS = {
  SQUEEZE: {
    label: 'Squeeze Pre-Breakout',
    plain: 'Stock kuch din se tight range me daba hai (volatility kam) aur 20-din ke high ke paas hai — breakout se pehle ki shant avastha.',
    checks: (f) => [
      ck(f.trendUp && f.sma50Rising, 'Uptrend', 'close > SMA50 > SMA200 aur SMA50 upar', f.trendUp ? (f.sma50Rising ? 'haan' : 'SMA50 gir raha') : 'nahi'),
      ck(f.distHigh20 >= 0 && f.distHigh20 <= 6, '20-din high se doori', '0–6% neeche', fx(f.distHigh20) + '%'),
      ck(f.bbPctl != null && f.bbPctl <= 35, 'Volatility squeeze', 'BB width ≤ 35 percentile', f.bbPctl == null ? '–' : Math.round(f.bbPctl) + ' pctl'),
      ck(f.rsi >= 45 && f.rsi <= 68, 'RSI', '45–68', fx(f.rsi, 0)),
      ck(f.accum >= 0.9, 'Buying vs selling volume', '≥ 0.9', fx(f.accum, 2)),
    ],
    score: (f) => 50 + Math.round((35 - (f.bbPctl ?? 35)) / 3) + (f.nr7 ? 6 : 0) + (f.rs20 > 0 ? Math.min(10, Math.round(f.rs20)) : 0) + (f.closePos >= 0.6 ? 4 : 0),
    why: (f) => [`20-din high se sirf ${f.distHigh20.toFixed(1)}% neeche`, `Volatility squeeze (BB ${Math.round(f.bbPctl)} percentile — kaafi shant)`, f.nr7 ? 'NR7: pichle 7 din ka sabse chhota range (spring coil)' : null, f.rs20 > 0 ? `Nifty se 20 din me ${f.rs20.toFixed(1)}% strong` : null],
    stopRef: (f) => f.lo10 - 0.1 * f.atr,
    trigger: (f) => `Kal open ≤ ₹${(f.close * 1.02).toFixed(2)} ho to hi lo. Behtar: ₹${(f.hi20 * 1.002).toFixed(2)} ke upar volume ke saath.`,
  },
  PULLBACK: {
    label: 'Uptrend Pullback Bounce',
    plain: 'Majboot uptrend wala stock thoda neeche aaya (SMA20 tak) aur wahan se bounce ki pehli candle bani.',
    checks: (f) => [
      ck(f.trendUp && f.sma50Rising, 'Uptrend', 'close > SMA50 > SMA200 aur SMA50 upar', f.trendUp ? 'haan' : 'nahi'),
      ck(f.rsi >= 38 && f.rsi <= 55, 'RSI', '38–55', fx(f.rsi, 0)),
      ck(f.d5 >= -7 && f.d5 <= 1, '5-din move', '-7% se +1%', fx(f.d5) + '%'),
      ck(f.lo3 <= f.sma20 * 1.015, 'SMA20 tak pullback', 'low ≤ SMA20 ke paas', fx(pct(f.lo3, f.sma20)) + '% SMA20 se'),
      ck(f.close > f.sma50 * 1.005, 'SMA50 ke upar', 'close > SMA50', fx(pct(f.close, f.sma50)) + '%'),
      ck(f.upClose && f.closePos >= 0.55, 'Bounce candle', 'up-close + strong close', f.upClose ? `close position ${fx(f.closePos, 2)}` : 'down-close'),
      ck(f.distHigh20 >= 3 && f.distHigh20 <= 12, '20-din high se doori', '3–12% neeche', fx(f.distHigh20) + '%'),
      ck(f.volRatio5v20 != null && f.volRatio5v20 <= 1.1, 'Pullback pe volume', '≤ 1.1× (kam volume = healthy)', fx(f.volRatio5v20, 2) + '×'),
    ],
    score: (f) => 50 + (f.rs20 > 0 ? Math.min(10, Math.round(f.rs20)) : 0) + (f.closePos >= 0.7 ? 5 : 0) + (f.accum >= 1.1 ? 5 : 0),
    why: (f) => [`Uptrend me SMA20 tak pullback (RSI ${f.rsi.toFixed(0)})`, 'Bounce candle confirm: up-close aur strong close', 'Pullback pe volume kam — bikwali ka dabaav nahi'],
    stopRef: (f) => f.lo3 - 0.2 * f.atr,
    trigger: (f) => `Kal open ≤ ₹${(f.close * 1.02).toFixed(2)} ho to lo. Usse upar gap-up khule to SKIP.`,
  },
  RS_BASE: {
    label: 'Relative-Strength Tight Base',
    plain: 'Nifty se zyada majboot stock, 52-hafte ke high ke paas, 10 din se bahut tight range me ruka hua.',
    checks: (f) => [
      ck(f.trendUp && f.sma50Rising, 'Uptrend', 'close > SMA50 > SMA200 aur SMA50 upar', f.trendUp ? 'haan' : 'nahi'),
      ck(f.rs20 != null && f.rs20 > 0 && f.rs60 > 0, 'Nifty se strength', '20d aur 60d dono > 0', `${fx(f.rs20)}% / ${fx(f.rs60)}%`),
      ck(f.distHigh252 <= 8, '52-hafte high se doori', '≤ 8%', fx(f.distHigh252) + '%'),
      ck(f.range10 <= 7, '10-din range', '≤ 7% (tight)', fx(f.range10) + '%'),
      ck(f.bbPctl != null && f.bbPctl <= 45, 'Volatility compress', '≤ 45 percentile', f.bbPctl == null ? '–' : Math.round(f.bbPctl) + ' pctl'),
      ck(f.distHigh20 >= 0 && f.distHigh20 <= 5, '20-din high se doori', '0–5% neeche', fx(f.distHigh20) + '%'),
      ck(f.volRatio5v20 != null && f.volRatio5v20 <= 1.2, 'Base me volume', '≤ 1.2× (shaant)', fx(f.volRatio5v20, 2) + '×'),
    ],
    score: (f) => 50 + Math.min(12, Math.round(f.rs60 / 2)) + (f.nr7 ? 5 : 0) + (f.accum >= 1.1 ? 5 : 0),
    why: (f) => [`52-hafte high se ${f.distHigh252.toFixed(1)}% neeche, 10-din range ${f.range10.toFixed(1)}% (tight)`, `Nifty se 20d ${f.rs20.toFixed(1)}% aur 60d ${f.rs60.toFixed(1)}% strong`],
    stopRef: (f) => f.lo10 - 0.1 * f.atr,
    trigger: (f) => `Kal open ≤ ₹${(f.close * 1.02).toFixed(2)} ho to lo, ya ₹${(f.hi20 * 1.002).toFixed(2)} ke upar volume trigger.`,
  },
  BREAKOUT: {
    label: 'Fresh Volume Breakout',
    plain: 'Stock ne abhi-abhi 20-din ka high zyada volume ke saath todha (par 2.5% se zyada nahi bhaaga) — breakout ka pehla/doosra din.',
    checks: (f) => [
      ck(f.trendUp && f.sma50Rising, 'Uptrend', 'close > SMA50 > SMA200 aur SMA50 upar', f.trendUp ? 'haan' : 'nahi'),
      ck(f.distHigh20 <= 0.5 && f.distHigh20 >= -2.5, '20-din high ke paas/upar', '-2.5% se +0.5%', fx(f.distHigh20) + '%'),
      ck(f.volToday != null && f.volToday >= 1.4, 'Aaj ka volume', '≥ 1.4× average', fx(f.volToday, 2) + '×'),
      ck(f.rs20 != null && f.rs20 > 0, 'Nifty se strength', '> 0', fx(f.rs20) + '%'),
      ck(f.rsi >= 55 && f.rsi <= 75, 'RSI', '55–75', fx(f.rsi, 0)),
      ck(f.closePos >= 0.6, 'Strong close', '≥ 0.6', fx(f.closePos, 2)),
    ],
    score: (f) => 50 + Math.min(12, Math.round((f.volToday - 1.4) * 8)) + (f.rs20 > 0 ? Math.min(8, Math.round(f.rs20)) : 0) + (f.closePos >= 0.8 ? 5 : 0),
    why: (f) => [`20-din high tod diya/paas hai (${f.distHigh20.toFixed(1)}%)`, `Volume ${f.volToday.toFixed(1)}× average — kharidaron ki bhid`, `RSI ${f.rsi.toFixed(0)} — momentum majboot par overheated nahi`],
    stopRef: (f) => Math.min(f.lo3, f.hi20 - 0.6 * f.atr),
    trigger: (f) => `Kal open ≤ ₹${(f.close * 1.02).toFixed(2)} ho to lo. Gap-up usse zyada ho to SKIP.`,
  },
  OVERSOLD: {
    label: 'Oversold Bounce (long-term uptrend me)',
    plain: 'Lambe uptrend (SMA200 ke upar) wala stock 1 hafte me tez gira (oversold) aur ab bounce candle bani — rubber-band jaisa wapsi ka mauka.',
    checks: (f) => [
      ck(f.close > f.sma200, 'Lambe trend ke upar', 'close > SMA200', fx(pct(f.close, f.sma200)) + '% SMA200 se'),
      ck(f.rsi <= 38, 'RSI oversold', '≤ 38', fx(f.rsi, 0)),
      ck(f.d5 <= -5, '5-din giravat', '≤ -5%', fx(f.d5) + '%'),
      ck(f.upClose && f.closePos >= 0.5, 'Bounce candle', 'up-close + close position ≥ 0.5', f.upClose ? `close position ${fx(f.closePos, 2)}` : 'down-close'),
      ck(f.distHigh252 <= 25, '52-hafte high se doori', '≤ 25% (toota hua stock nahi)', fx(f.distHigh252) + '%'),
    ],
    score: (f) => 50 + Math.min(12, Math.round((38 - f.rsi) / 2)) + (f.rs60 > 0 ? 5 : 0) + (f.closePos >= 0.7 ? 5 : 0),
    why: (f) => [`5 din me ${f.d5.toFixed(1)}% gira, RSI ${f.rsi.toFixed(0)} (oversold)`, `Phir bhi SMA200 se ${f.aboveSma200?.toFixed?.(1) ?? pct(f.close, f.sma200).toFixed(1)}% upar — lamba trend toota nahi`, 'Bounce candle ban gayi'],
    stopRef: (f) => f.lo3 - 0.2 * f.atr,
    trigger: (f) => `Kal open ≤ ₹${(f.close * 1.02).toFixed(2)} ho to lo. Gap-up usse zyada ho to SKIP.`,
  },
};

function planFor(f, key, stopMult = STOPS.S12) {
  const ref = SETUPS[key].stopRef(f);
  const dist = clamp(Math.max((f.close - ref) / f.close, (stopMult * f.atrPct) / 100), CFG.STOP_MIN, stopMaxFor(stopMult));
  return { dist, stopPrice: f.close * (1 - dist) };
}

/* ----------------------------- trade simulator (gap-aware, conservative) ----------------------------- */
function simulate(S, i, dist, atrAbs, X = EXITS.W7) {
  const H = X.hold;
  if (i + H > S.n - 1) return null;                // window not complete yet
  const sig = S.close[i], o = S.open[i + 1];
  const stop0 = sig * (1 - dist);
  if (o > sig * (1 + CFG.MAX_GAP_UP / 100)) return { skipped: 'gap_up' };
  if (o <= stop0) return { skipped: 'gap_through_stop' };
  const entry = o * (1 + CFG.SLIPPAGE_PCT / 100);
  const risk = (entry - stop0) / entry;
  const t1 = entry * (1 + X.t1 / 100), t2 = entry * (1 + CFG.T2 / 100), t3 = entry * (1 + X.t3 / 100);
  let stop = stop0, took1 = false, rem = 1, gross = 0, hh = entry, hit10 = false, gapExit = false, stopped = false, exitK = i + H, mae = 0, maxUp = 0;
  const realize = (frac, px) => { gross += frac * (px / entry - 1) * 100; };
  for (let k = i + 1; k <= i + H; k++) {
    const op = S.open[k], hi = S.high[k], lo = S.low[k];
    mae = Math.min(mae, (lo / entry - 1) * 100); maxUp = Math.max(maxUp, (hi / entry - 1) * 100);
    if (k > i + 1 && op <= stop) { realize(rem, op); rem = 0; gapExit = true; stopped = !took1; exitK = k; break; }
    if (lo <= stop) { realize(rem, stop); rem = 0; stopped = !took1; exitK = k; break; }   // stop before targets in same bar
    if (!took1 && hi >= t1) { realize(0.5, t1); rem -= 0.5; took1 = true; stop = Math.max(stop, entry * 1.002); }
    if (hi >= t2) hit10 = true;
    if (took1) {
      if (hi >= t3) { realize(rem, t3); rem = 0; exitK = k; break; }
      hh = Math.max(hh, hi); stop = Math.max(stop, hh - X.trail * atrAbs);
    }
    if (k === i + H) { realize(rem, S.close[k]); rem = 0; exitK = k; }
  }
  const net = gross - CFG.COST_PCT;
  return { entry, stop: stop0, riskPct: risk * 100, net, R: net / (risk * 100), took1, hit10, hit15: maxUp >= 15, stopped, gapExit, mae, maxUp, days: exitK - i, entryDate: S.date[i + 1], exitDate: S.date[exitK] };
}

/* ----------------------------- market regime ----------------------------- */
const REGIME_MULT = { GREEN: 1, AMBER: 0.5, BEAR: 0.5, CRASH: 0, UNKNOWN: 0.5 };
function buildRegime(nifty, vix) {
  const UNKNOWN = { state: 'UNKNOWN', mult: 0.5, reasons: ['Nifty data nahi mila — half size'], facts: null };
  if (!nifty || nifty.length < 230) return () => UNKNOWN;
  const cl = nifty.map((x) => x.close), s50 = rollingMean(cl, 50), s200 = rollingMean(cl, 200);
  const vmap = new Map((vix || []).map((x) => [x.date, x.close])); let lastV = null;
  const vixArr = nifty.map((x) => { const v = vmap.get(x.date); if (v != null) lastV = v; return lastV; });
  const arr = nifty.map((x, i) => {
    if (i < 205) return null;
    const d1 = pct(cl[i], cl[i - 1]), d5 = pct(cl[i], cl[i - 5]), d20 = pct(cl[i], cl[i - 20]), v = vixArr[i], v3 = vixArr[i - 3];
    const below50 = cl[i] < s50[i], falling50 = s50[i] < s50[i - 10], below200 = cl[i] < s200[i];
    const reasons = []; let crash = false, bear = false, amber = false;
    if (d5 < -3.5) { crash = true; reasons.push(`Nifty 5 din me ${d5.toFixed(1)}% gira (achanak giravat)`); } else if (d5 < -2) { amber = true; reasons.push(`Nifty 5 din me ${d5.toFixed(1)}%`); }
    if (d1 < -2) { crash = true; reasons.push(`Nifty aaj ${d1.toFixed(1)}% gira`); }
    if (v != null) {
      if (v > 26) { crash = true; reasons.push(`India VIX ${v.toFixed(1)} — darr bahut zyada`); }
      else if (v > 20) { amber = true; reasons.push(`India VIX ${v.toFixed(1)} — thoda zyada`); }
      if (v3 != null && v / v3 > 1.2) { amber = true; reasons.push('VIX 3 din me 20%+ badha'); }
    }
    if (below200) { bear = true; reasons.push('Nifty lambe trend (SMA200) ke neeche'); }
    if (below50 && falling50) { bear = true; reasons.push('Nifty SMA50 ke neeche aur SMA50 gir raha'); } else if (below50) { amber = true; reasons.push('Nifty SMA50 ke neeche'); }
    const state = crash ? 'CRASH' : bear ? 'BEAR' : amber ? 'AMBER' : 'GREEN';
    return { state, mult: REGIME_MULT[state], reasons: reasons.length ? reasons : ['Nifty trend theek, VIX shaant'],
      facts: { nifty: r1(cl[i]), sma50: r1(s50[i]), sma200: r1(s200[i]), d1: r2(d1), d5: r2(d5), d20: r2(d20), vix: v == null ? null : r1(v) } };
  });
  const dates = nifty.map((x) => x.date);
  return (date) => {
    let lo = 0, hi = dates.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
    return (ans >= 0 && arr[ans]) || UNKNOWN;
  };
}

/* ----------------------------- stats ----------------------------- */
function stats(sigs) {
  const n = sigs.length; if (!n) return { n: 0 };
  const s = [...sigs].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  const net = s.map((x) => x.net), wins = net.filter((x) => x > 0), losses = net.filter((x) => x <= 0);
  let streak = 0, maxStreak = 0; s.forEach((x) => { if (x.net <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; });
  const sw = wins.reduce((a, b) => a + b, 0), sl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const t1 = s.filter((x) => x.took1).length;
  return {
    n, winRate: r1((wins.length / n) * 100), t1Rate: r1((t1 / n) * 100), t1RateLow: r1(wilsonLow(t1, n) * 100),
    hit10: r1((s.filter((x) => x.hit10).length / n) * 100), hit15: r1((s.filter((x) => x.hit15).length / n) * 100),
    stopRate: r1((s.filter((x) => x.stopped).length / n) * 100), gapExitRate: r1((s.filter((x) => x.gapExit).length / n) * 100),
    avgWin: r2(avg(wins)), avgLoss: r2(avg(losses)), expectancy: r2(avg(net)), expLow: r2(avg(net) - (n > 1 ? 1.64 * stdev(net) / Math.sqrt(n) : 0)), expLow1: r2(avg(net) - (n > 1 ? stdev(net) / Math.sqrt(n) : 0)), expR: r2(avg(s.map((x) => x.R))),
    profitFactor: sl ? r2(sw / sl) : (sw ? 99 : 0), worst: r2(Math.min(...net)), medianNet: r2(median(net)), avgMAE: r2(avg(s.map((x) => x.mae))), maxLoseStreak: maxStreak,
  };
}

function portfolioSim(sigs, { riskPct = 0.75, maxOpen = 5 } = {}) {
  const s = [...sigs].sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : b.score - a.score));
  const open = []; const taken = [];
  for (const x of s) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k] <= x.entryDate) open.splice(k, 1);
    if (open.length >= maxOpen) continue;
    open.push(x.exitDate); taken.push(x);
  }
  taken.sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1));
  let eq = 100, peak = 100, maxDD = 0; const byYear = {};
  for (const x of taken) {
    const before = eq; eq *= 1 + (x.R * riskPct) / 100; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (1 - eq / peak) * 100);
    const y = x.exitDate.slice(0, 4); byYear[y] = byYear[y] || { start: before, end: before }; byYear[y].end = eq;
  }
  const yrs = {}; Object.entries(byYear).forEach(([y, v]) => { yrs[y] = r1((v.end / v.start - 1) * 100); });
  return { trades: taken.length, riskPerTradePct: riskPct, totalReturnPct: r1(eq - 100), maxDrawdownPct: r1(maxDD), byYear: yrs };
}

/* ----------------------------- SETUP LAB ----------------------------- */
/** Every (stock, day) that passes the universal gates and at least one setup. Computed ONCE; variants re-use it. */
function buildEvents(seriesMap, regimeFn) {
  const ev = [];
  for (const [sym, S] of Object.entries(seriesMap)) {
    for (let i = 220; i < S.n - 1; i++) {
      const f = featuresAt(S, i); if (!f || commonGate(f).length) continue;
      let sc = null;
      for (const key of Object.keys(SETUPS)) if (SETUPS[key].checks(f).every((c) => c.ok)) { sc = sc || {}; sc[key] = SETUPS[key].score(f); }
      if (!sc) continue;
      ev.push({ sym, i, date: f.date, regime: regimeFn(f.date).state, sc, f: { close: f.close, atr: f.atr, atrPct: f.atrPct, lo10: f.lo10, lo3: f.lo3, hi20: f.hi20, hi252: f.hi252 } });
    }
  }
  return ev;
}

function evaluateVariant(events, seriesMap, key, stopMult, X) {
  const sigs = []; const lastExit = {};
  for (const e of events) {
    if (e.sc[key] == null) continue;
    if (lastExit[e.sym] != null && e.i <= lastExit[e.sym]) continue;
    const S = seriesMap[e.sym];
    const { dist } = planFor(e.f, key, stopMult);
    const o = simulate(S, e.i, dist, e.f.atr, X);
    if (!o || o.skipped) continue;
    lastExit[e.sym] = e.i + o.days;
    sigs.push({ sym: e.sym, setup: key, score: e.sc[key], signalDate: e.date, regime: e.regime, ...o });
  }
  return sigs;
}

function splitDate(seriesMap) {
  let best = null; for (const S of Object.values(seriesMap)) if (!best || S.n > best.n) best = S;
  if (!best) return '9999-12-31';
  return best.date[220 + Math.floor((best.n - 220) * 0.6)];
}

/** Regimes in which the setup made money on TRAIN data only. */
function learnRegimes(train) {
  const ok = [];
  for (const st of ['GREEN', 'AMBER', 'BEAR', 'UNKNOWN']) {
    const s = stats(train.filter((x) => x.regime === st));
    if (s.n >= CFG.REGIME_MIN_N && s.expectancy > 0) ok.push(st);
  }
  return ok;
}

function runLab(events, seriesMap) {
  const cut = splitDate(seriesMap); const lab = {}; const selSigs = {};
  for (const key of Object.keys(SETUPS)) {
    const rows = []; let best = null;
    for (const [ek, X] of Object.entries(EXITS)) for (const [sk, m] of Object.entries(STOPS)) {
      const sigs = evaluateVariant(events, seriesMap, key, m, X);
      const tr = sigs.filter((s) => s.entryDate < cut), te = sigs.filter((s) => s.entryDate >= cut);
      const allowed = learnRegimes(tr);
      const trA = tr.filter((s) => allowed.includes(s.regime)), teA = te.filter((s) => allowed.includes(s.regime));
      const trS = stats(trA), teS = stats(teA);
      const se = trA.length > 1 ? stdev(trA.map((x) => x.net)) / Math.sqrt(trA.length) : 0;
      const trainScore = trS.n >= CFG.LIC_MIN_TRAIN ? trS.expectancy - se : -99;
      const row = { variant: `${ek}|${sk}`, exitKey: ek, stopKey: sk, exitLabel: X.label, stopMult: m, allowed, train: trS, test: teS, trainScore };
      rows.push(row);
      if (!best || trainScore > best.row.trainScore) best = { row, sigs, tr, te, trA, teA };
    }
    const b = best, oos = b.row.test, ins = b.row.train;
    const yrs = {}; [...b.trA, ...b.teA].forEach((x) => { const y = x.exitDate.slice(0, 4); (yrs[y] = yrs[y] || []).push(x.net); });
    const yrRows = Object.entries(yrs).filter(([, v]) => v.length >= 8);
    const posFrac = yrRows.length ? yrRows.filter(([, v]) => avg(v) > 0).length / yrRows.length : 0;
    const reasons = [];
    if (b.row.trainScore === -99) reasons.push(`train sample kam (n<${CFG.LIC_MIN_TRAIN}) ya koi mausam positive nahi`);
    if (!b.row.allowed.length) reasons.push('train data me koi bhi market-mausam me paisa nahi bana');
    if (b.trA.length + b.teA.length < CFG.LIC_MIN_ALL) reasons.push(`kul sample kam (n=${b.trA.length + b.teA.length} < ${CFG.LIC_MIN_ALL})`);
    if (!(oos.n >= CFG.LIC_MIN_OOS)) reasons.push(`untouched test sample n=${oos.n || 0} < ${CFG.LIC_MIN_OOS}`);
    if (!(oos.expectancy >= CFG.LIC_MIN_EXP)) reasons.push(`test me avg ${oos.expectancy ?? '–'}%/trade (chahiye ≥ ${CFG.LIC_MIN_EXP}%)`);
    if (oos.n >= 2 && !(oos.expLow > 0)) reasons.push(`test avg ka 'pakka' hissa (lower bound ${oos.expLow}%) ≤ 0 — natija kismat bhi ho sakta hai`);
    if (!(oos.profitFactor >= CFG.LIC_MIN_PF)) reasons.push(`test profit factor ${oos.profitFactor ?? '–'} (chahiye ≥ ${CFG.LIC_MIN_PF})`);
    if (!(ins.expectancy > 0)) reasons.push('train me bhi expectancy ≤ 0');
    if (posFrac < CFG.LIC_MIN_POS_YEAR_FRAC) reasons.push(`sirf ${Math.round(posFrac * 100)}% saal profitable`);
    const byRegime = {}; for (const st of ['GREEN', 'AMBER', 'BEAR']) byRegime[st] = { train: stats(b.tr.filter((x) => x.regime === st)), test: stats(b.te.filter((x) => x.regime === st)) };
    lab[key] = {
      key, label: SETUPS[key].label, plain: SETUPS[key].plain, licensed: reasons.length === 0, reasons,
      selected: { variant: b.row.variant, exit: EXITS[b.row.exitKey], stopMult: b.row.stopMult, allowedRegimes: b.row.allowed },
      train: ins, outOfSample: oos, byRegime, yearsProfitablePct: Math.round(posFrac * 100),
      variants: rows.map((r) => ({ variant: r.variant, exitLabel: r.exitLabel, stopMult: r.stopMult, allowed: r.allowed, trainN: r.train.n || 0, trainExp: r.train.expectancy ?? null, testN: r.test.n || 0, testExp: r.test.expectancy ?? null, testPF: r.test.profitFactor ?? null })),
    };
    selSigs[key] = { train: b.trA, test: b.teA };
  }
  return { lab, selSigs, cutoff: cut };
}

/* ----------------------------- sizing ----------------------------- */
function sizePosition({ capital, riskPct = 0.75, entry, stopDist, gapStdPct = 1, regimeMult = 1, extraMult = 1, maxPosPct = CFG.MAX_POS_PCT }) {
  if (!capital || capital <= 0) return null;
  const stop = entry * (1 - stopDist);
  const riskPerShare = entry - stop + entry * (CFG.GAP_BUFFER_MULT * gapStdPct) / 100;
  const budget = (capital * riskPct / 100) * regimeMult * extraMult;
  let qty = Math.floor(budget / riskPerShare);
  qty = Math.min(qty, Math.floor((capital * maxPosPct / 100) / entry));
  if (qty < 1) return { qty: 0, note: 'Risk budget me 1 share bhi nahi aata — skip' };
  return {
    qty, capitalUsed: Math.round(qty * entry), pctOfCapital: r1((qty * entry / capital) * 100),
    riskBudgetRs: Math.round(budget), maxLossIfStopHits: Math.round(qty * (entry - stop)),
    gapWorstCaseRs: Math.round(qty * (entry - stop + entry * 2 * gapStdPct / 100)),
  };
}

/* ----------------------------- plain-language scorecard ----------------------------- */
function scorecard(c, setup, regimeNow) {
  const pros = [...c.why]; const cons = [];
  const oos = setup.outOfSample || {};
  pros.push(`Liquid hai: roz ~₹${c.turnoverCr} crore ka vyapaar`);
  if (setup.licensed) pros.push(`Is setup ne untouched test data me ${oos.n} trades me avg ${oos.expectancy}%/trade diya (₹10,000 pe ≈ ₹${Math.round(oos.expectancy * 100)})`);
  else if (!oos.n) cons.push('Is setup ke test-period me itne signal hi nahi bane ki parkha ja sake — yaani koi saboot nahi. Bina saboot ke paisa lagana jua hai.');
  else cons.push(`Is setup ne untouched test data me paisa NAHI banaya: ${oos.n} trades me avg ${oos.expectancy}%/trade (profit factor ${oos.profitFactor}). ₹10,000 lagao to har trade me avg ${oos.expectancy < 0 ? '₹' + Math.abs(Math.round(oos.expectancy * 100)) + ' ka NUKSAN' : '₹' + Math.round(oos.expectancy * 100) + ' ka fayda (par itna pakka nahi ki bharosa karein)'}.`);
  if (setup.licensed && !c.regimeAllowed) cons.push(`Abhi market "${regimeNow.state}" hai — past data me ye setup is mausam me paisa nahi bana paya (sirf ${setup.selected.allowedRegimes.join('/') || 'koi nahi'} me chala).`);
  if (regimeNow.state === 'CRASH') cons.push('Market me achanak giravat/darr (CRASH) — koi naya trade nahi.');
  const own = c.proof.own;
  if (own.n >= 3) (own.expectancy > 0 ? pros : cons).push(`Isi stock pe ye setup ${own.n} baar bana: avg ${own.expectancy}%/trade`);
  if (c.riskPct >= 5) cons.push(`Stop ${c.riskPct}% door hai — ek trade me itna loss ho sakta hai`);
  if (c.gapStdPct >= 1.6) cons.push(`Raat ke gap zyada hote hain (σ ${c.gapStdPct}%) — stop se zyada loss ka risk`);
  return { pros, cons };
}

/* ----------------------------- live scan ----------------------------- */
const MANAGEMENT = [
  'Entry: SIGNAL KE AGLE DIN. Open signal close se 2% se zyada upar ho to SKIP (late = loss).',
  'Stop-loss order lagate hi lagao. Kabhi neeche mat khiskao.',
  'Pehla target touch ho to aadha becho aur stop entry ke upar (break-even) le aao.',
  'Bacha hua: trailing stop ya final target pe exit.',
  'Hold-limit ke din jo bacha ho, close pe nikal do (dead money mat rakho).',
];

function scanLive(seriesMap, regimeFn, lab, selSigs, opts = {}) {
  const dates = Object.values(seriesMap).map((S) => S.date[S.n - 1]).sort();
  const asOf = dates[dates.length >> 1];
  const regimeNow = regimeFn(asOf);
  const rejectCounts = {}; const cands = []; const near = []; let nearHidden = 0;
  for (const [sym, S] of Object.entries(seriesMap)) {
    const i = S.n - 1; const f = featuresAt(S, i); if (!f) continue;
    const fails = commonGate(f);
    if (fails.length) { const k = fails[0].replace(/[\d.]+/g, '#'); rejectCounts[k] = (rejectCounts[k] || 0) + 1; continue; }
    let best = null; let nm = null;
    for (const key of Object.keys(SETUPS)) {
      const ch = SETUPS[key].checks(f); const bad = ch.filter((c) => !c.ok);
      const L = lab[key]; const regimeOk = regimeNow.state !== 'CRASH' && L.selected.allowedRegimes.includes(regimeNow.state);
      if (!bad.length) {
        const sc = SETUPS[key].score(f); const pri = (L.licensed && regimeOk ? 2 : L.licensed ? 1 : 0) * 1000 + sc;
        if (!best || pri > best.pri) best = { key, sc, pri };
      } else if (bad.length === 1) {
        if (L.licensed && regimeOk) { if (!nm || nm.pri < 1) nm = { key, c: bad[0], pri: 1 }; } else nearHidden++;
      }
    }
    if (!best) {
      if (nm) near.push({ symbol: sym, price: r2(f.close), setup: SETUPS[nm.key].label, check: nm.c.msg, need: nm.c.need, have: nm.c.have, passed: SETUPS[nm.key].checks(f).filter((c) => c.ok).map((c) => c.msg) });
      continue;
    }
    const L = lab[best.key]; const X = L.selected.exit; const plan = planFor(f, best.key, L.selected.stopMult);
    const regimeAllowed = regimeNow.state !== 'CRASH' && L.selected.allowedRegimes.includes(regimeNow.state);
    const all = [...selSigs[best.key].train, ...selSigs[best.key].test];
    const own = all.filter((x) => x.sym === sym); const ownS = stats(own);
    const setupAll = stats(all);
    const prior = setupAll.expectancy ?? 0, priorT1 = (setupAll.t1Rate ?? 0) / 100, K = CFG.SHRINK_K;
    const expPost = (own.reduce((a, x) => a + x.net, 0) + K * prior) / (own.length + K);
    const t1Post = (own.filter((x) => x.took1).length + K * priorT1) / (own.length + K);
    let grade = 'PAPER';
    if (L.licensed) grade = !regimeAllowed ? 'REGIME' : (expPost >= 1.0 && t1Post >= 0.5 && own.length >= 3) ? 'A' : (expPost >= 0.5 ? 'B' : 'C');
    const cand = {
      symbol: sym, setup: best.key, setupLabel: SETUPS[best.key].label, setupPlain: SETUPS[best.key].plain, grade, regimeAllowed, setupScore: best.sc, price: r2(f.close), signalDate: f.date,
      why: SETUPS[best.key].why(f).filter(Boolean), exit: X, stopMult: L.selected.stopMult,
      stopDist: plan.dist, stopPrice: r2(plan.stopPrice), riskPct: r1(plan.dist * 100), skipIfOpenAbove: r2(f.close * (1 + CFG.MAX_GAP_UP / 100)),
      targets: { t1: r2(f.close * (1 + X.t1 / 100)), t3: r2(f.close * (1 + X.t3 / 100)) }, trigger: SETUPS[best.key].trigger(f),
      atrPct: r1(f.atrPct), atrRs: r2(f.atr), gapStdPct: r2(f.gapStd), turnoverCr: r1(f.turnoverCr), rs20: r1(f.rs20),
      proof: { setupLicensed: L.licensed, setupOOS: L.outOfSample, own: ownS, expectancyShrunk: r2(expPost), t1RateShrunk: r1(t1Post * 100) },
      rank: expPost * 10 + best.sc * 0.3 + t1Post * 20,
    };
    cand.scorecard = scorecard(cand, L, regimeNow);
    cands.push(cand);
  }
  const order = { A: 0, B: 1, C: 2, REGIME: 3, PAPER: 4 };
  cands.sort((a, b) => order[a.grade] - order[b.grade] || b.rank - a.rank);
  near.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { asOf, regimeNow, candidates: cands, nearMiss: near.slice(0, 15), nearMissHidden: nearHidden, rejectCounts };
}

/**
 * Apply per-user/per-day filters that need external data, then size.
 * ctx: { earnings, sectors, regime, capital, riskPct, forwardPause }
 */
function finalizePicks(cands, ctx) {
  const picks = [], paper = [], blocked = [];
  const perSector = {}; const regime = ctx.regime;
  for (const c of cands) {
    const e = ctx.earnings?.[c.symbol];
    const sector = ctx.sectors?.[c.symbol] || 'Unknown';
    const note = []; let extra = 1;
    if (e && e.known && e.daysUntil != null && e.daysUntil >= -1 && e.daysUntil <= CFG.EARNINGS_BLACKOUT_DAYS) { blocked.push({ symbol: c.symbol, reason: `Result ${e.daysUntil} din me — gap risk, skip` }); continue; }
    if (!e || !e.known) { extra = 0.5; note.push('Result date pata nahi — size aadha'); }
    const tradable = (c.grade === 'A' || c.grade === 'B') && regime.state !== 'CRASH' && !ctx.forwardPause;
    if (!tradable) {
      const reason = regime.state === 'CRASH' ? 'Market CRASH mode — no trade' : ctx.forwardPause && (c.grade === 'A' || c.grade === 'B') ? 'Forward-test drawdown guard ON' : c.grade === 'PAPER' ? 'Is setup ka out-of-sample proof nahi — sirf dekhne ke liye' : c.grade === 'REGIME' ? 'Abhi ke market-mausam me ye setup past me paisa nahi bana paya' : 'Edge kamzor — sirf dekho';
      paper.push({ ...c, paperReason: reason }); continue;
    }
    if (picks.length >= CFG.MAX_PICKS) continue;
    if ((perSector[sector] || 0) >= CFG.MAX_PER_SECTOR) { blocked.push({ symbol: c.symbol, reason: `Sector (${sector}) cap` }); continue; }
    perSector[sector] = (perSector[sector] || 0) + 1;
    const size = sizePosition({ capital: ctx.capital, riskPct: ctx.riskPct, entry: c.price, stopDist: c.stopDist, gapStdPct: c.gapStdPct, regimeMult: regime.mult, extraMult: extra });
    picks.push({ ...c, sector, earningsDays: e?.daysUntil ?? null, notes: note, size, management: MANAGEMENT });
  }
  return { picks, paper: paper.slice(0, 10), blocked };
}

function runAnalysis(dataBySymbol, nifty, vix, hygiene = {}) {
  const regimeFn = buildRegime(nifty, vix);
  const seriesMap = {}; const skipped = {};
  for (const [sym, raw] of Object.entries(dataBySymbol)) {
    const { c, reason } = cleanCandles(raw, hygiene);
    if (!c) { skipped[reason] = (skipped[reason] || 0) + 1; continue; }
    seriesMap[sym] = buildSeries(c, nifty);
  }
  const events = buildEvents(seriesMap, regimeFn);
  const { lab, selSigs, cutoff } = runLab(events, seriesMap);
  const licensedTest = Object.keys(lab).filter((k) => lab[k].licensed).flatMap((k) => selSigs[k].test);
  const licensedAll = Object.keys(lab).filter((k) => lab[k].licensed).flatMap((k) => [...selSigs[k].train, ...selSigs[k].test]);
  const live = scanLive(seriesMap, regimeFn, lab, selSigs);
  return {
    scanned: Object.keys(seriesMap).length, dataSkipped: skipped, events: events.length, testFrom: cutoff,
    licensing: lab, portfolioOOS: portfolioSim(licensedTest), portfolioAll: portfolioSim(licensedAll),
    anyLicensed: Object.values(lab).some((x) => x.licensed), ...live,
    caveats: [
      'Backtest current index constituents pe hai (survivorship bias) — asli result thoda kamzor ho sakta hai.',
      'Past performance guarantee nahi. Koi bhi setup 90% nahi deta — numbers upar measured hain.',
      'Lab 5 setups × 6 variants try karta hai, par chunav sirf TRAIN data (pehle 60% samay) pe hota hai; tabhi 40% untouched test se judge hota hai. Phir bhi 5 setups me se ek ke "lucky" nikalne ka chance bacha rehta hai — isliye forward test zaruri hai.',
      'Thresholds baar-baar tune karke backtest "sundar" mat banao — wo overfit hai, live me loss deta hai.',
      'Pehle 3–4 hafte Forward Test (paper) chalao; tabhi asli paisa lagao.',
      'Circuit/halt, news-shock aur overnight gap me stop se zyada loss ho sakta hai (gapWorstCase dekho).',
    ],
  };
}

module.exports = { CFG, EXITS, STOPS, stopMaxFor, splitDate, REGIME_MULT, pct, avg, clamp, median, stdev, r1, r2, SETUPS, cleanCandles, buildSeries, featuresAt, commonGate, planFor, simulate, buildRegime, stats, portfolioSim, buildEvents, evaluateVariant, runLab, learnRegimes, sizePosition, scorecard, scanLive, finalizePicks, runAnalysis, wilsonLow };
