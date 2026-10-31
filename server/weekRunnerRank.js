/**
 * Week Runner — Daily Best Stock (ranking engine)
 *
 * Idea: setups answer "does this chart shape pass a rule?" (binary). Ranking answers
 * "of everything tradable TODAY, which ONE is the best-placed?" — a relative question, so it
 * always has an answer. We then MEASURE how well "buy the daily #1" actually did
 * (net of costs, gap-aware, same simulator) on untouched test data, and label the pick honestly:
 *    PROVEN   -> passes full license (test expectancy lower-bound > 0, PF, years, n)
 *    LEAN     -> positive on test but not strong enough to trust fully  (half size)
 *    UNPROVEN -> no edge shown on test (tiny size / paper only)
 *
 * Factors (all from price/volume in our own universe; sector = Mongo SectorMap):
 *   stock strength vs Nifty (RS20/RS60), SECTOR strength (median RS of its sector + breadth),
 *   coil (Bollinger squeeze), distance to 20d/52w high, pullback depth, accumulation volume.
 * Variant, conviction threshold, stop width and exit style are chosen on TRAIN dates only.
 */
'use strict';
const E = require('./weekRunnerEngine');
const { CFG, EXITS, STOPS, SETUPS, featuresAt, commonGate, simulate, stats, learnRegimes, splitDate, portfolioSim, buildSeries, cleanCandles, buildRegime, stopMaxFor, clamp, median, pct, r1, r2, stdev, avg } = E;

const RAN_RE = /^(aaj hi|3D |5D |SMA20 se)/;
const COLS = ['rs20', 'rs60', 'd1', 'd5', 'd20', 'bbPctl', 'distH20', 'distH252', 'accum', 'rsi', 'volR', 'above50', 'above200', 'trendUp', 'sma50Up', 'atrPct', 'close', 'lo10', 'lo3', 'atr', 'hi20', 'closePos', 'gapStd', 'turn', 'volToday'];

const RANK_VARIANTS = {
  MOM: { label: 'Momentum + Strong Sector', w: { rs60: 0.30, rs20: 0.15, sec60: 0.25, sec20: 0.15, nH252: 0.15 }, ok: (c) => c.above200 > 0 && c.rs60 > 0 },
  COIL: { label: 'Coil near Breakout', w: { nbb: 0.30, nH20: 0.25, rs60: 0.20, accum: 0.15, sec20: 0.10 }, ok: (c) => c.above200 > 0 && c.rs60 > 0 && c.distH20 >= 0 && c.distH20 <= 8 },
  DIP: { label: 'Dip in a Strong Stock', w: { rs60: 0.30, sec60: 0.20, dip: 0.25, trend: 0.15, accum: 0.10 }, ok: (c) => c.trendUp === 1 && c.d5 <= 0 && c.d5 >= -8 },
  MIX: { label: 'All-rounder', w: { rs60: 0.20, sec60: 0.15, sec20: 0.10, nbb: 0.15, nH20: 0.10, dip: 0.10, accum: 0.10, nH252: 0.10 }, ok: (c) => c.above200 > 0 && c.rs60 > 0 },
};
const THR_LABELS = ['Roz (koi filter nahi)', 'Sirf upar ke 50% din', 'Sirf sabse achhe 25% din'];
const TOPK = 5;
const RANK_MIN_TRAIN = 120;

function pctRanks(vals) {
  const out = new Array(vals.length).fill(0.5);
  const idx = []; for (let i = 0; i < vals.length; i++) if (!Number.isNaN(vals[i])) idx.push(i);
  idx.sort((a, b) => vals[a] - vals[b]); const n = idx.length;
  idx.forEach((k, rank) => { out[k] = n > 1 ? rank / (n - 1) : 0.5; });
  return out;
}
const quantile = (arr, q) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };

/* ----------------------------- panel: features for EVERY stock-day (typed columns) ----------------------------- */
function buildPanel(seriesMap, regimeFn, sectorMap = {}) {
  const syms = Object.keys(seriesMap);
  const dateSet = new Set(); for (const s of syms) { const S = seriesMap[s]; for (let i = 220; i < S.n; i++) dateSet.add(S.date[i]); }
  const dates = [...dateSet].sort(); const dId = new Map(dates.map((d, k) => [d, k]));
  let total = 0; const start = syms.map((s) => { const st = total; total += Math.max(0, seriesMap[s].n - 220); return st; });
  const C = {}; COLS.forEach((n) => { C[n] = new Float32Array(total).fill(NaN); });
  const rowStock = new Int32Array(total), rowI = new Int32Array(total), rowDate = new Int32Array(total), rowGate = new Uint8Array(total);
  const events = [];
  syms.forEach((sym, si) => {
    const S = seriesMap[sym];
    for (let i = 220; i < S.n; i++) {
      const r = start[si] + i - 220; rowStock[r] = si; rowI[r] = i; rowDate[r] = dId.get(S.date[i]);
      const f = featuresAt(S, i); if (!f) continue;
      const fails = commonGate(f); const gate = fails.length === 0 ? 1 : (fails.every((m) => RAN_RE.test(m)) ? 2 : 0); rowGate[r] = gate;
      C.rs20[r] = f.rs20 ?? NaN; C.rs60[r] = f.rs60 ?? NaN; C.d1[r] = f.d1; C.d5[r] = f.d5; C.d20[r] = pct(S.close[i], S.close[i - 20]);
      C.bbPctl[r] = f.bbPctl ?? NaN; C.distH20[r] = f.distHigh20; C.distH252[r] = f.distHigh252; C.accum[r] = f.accum; C.rsi[r] = f.rsi; C.volR[r] = f.volRatio5v20 ?? NaN;
      C.above50[r] = pct(f.close, f.sma50); C.above200[r] = pct(f.close, f.sma200); C.trendUp[r] = f.trendUp ? 1 : 0; C.sma50Up[r] = f.sma50Rising ? 1 : 0;
      C.atrPct[r] = f.atrPct; C.close[r] = f.close; C.lo10[r] = f.lo10; C.lo3[r] = f.lo3; C.atr[r] = f.atr; C.hi20[r] = f.hi20; C.closePos[r] = f.closePos;
      C.gapStd[r] = f.gapStd; C.turn[r] = f.turnoverCr; C.volToday[r] = f.volToday ?? NaN;
      if (gate === 1 && i < S.n - 1) {
        let sc = null;
        for (const key of Object.keys(SETUPS)) if (SETUPS[key].checks(f).every((c) => c.ok)) { sc = sc || {}; sc[key] = SETUPS[key].score(f); }
        if (sc) events.push({ sym, i, date: f.date, regime: regimeFn(f.date).state, sc, f: { close: f.close, atr: f.atr, atrPct: f.atrPct, lo10: f.lo10, lo3: f.lo3, hi20: f.hi20, hi252: f.hi252 } });
      }
    }
  });
  // rows grouped by date (counting sort)
  const cnt = new Int32Array(dates.length + 1); for (let r = 0; r < total; r++) cnt[rowDate[r] + 1]++;
  for (let d = 0; d < dates.length; d++) cnt[d + 1] += cnt[d];
  const fill = cnt.slice(0, dates.length); const order = new Int32Array(total); for (let r = 0; r < total; r++) order[fill[rowDate[r]]++] = r;
  const secOf = syms.map((s) => (sectorMap[s] && sectorMap[s] !== 'Unknown' ? sectorMap[s] : null));
  const regimeByDate = dates.map((d) => regimeFn(d).state);
  return { syms, dates, C, rowStock, rowI, rowDate, rowGate, order, cnt, secOf, regimeByDate, events, hasSectors: secOf.some(Boolean) };
}

const valid = (P, r) => !Number.isNaN(P.C.close[r]);
function sectorStats(P, d) {
  const m = new Map();
  for (let k = P.cnt[d]; k < P.cnt[d + 1]; k++) {
    const r = P.order[k]; if (!valid(P, r)) continue; const sec = P.secOf[P.rowStock[r]]; if (!sec) continue;
    let b = m.get(sec); if (!b) { b = { n: 0, rs20: [], rs60: [], up: 0 }; m.set(sec, b); }
    b.n++; if (!Number.isNaN(P.C.rs20[r])) b.rs20.push(P.C.rs20[r]); if (!Number.isNaN(P.C.rs60[r])) b.rs60.push(P.C.rs60[r]); if (P.C.above50[r] > 0) b.up++;
  }
  const out = new Map();
  for (const [sec, b] of m) if (b.n >= 3) out.set(sec, { sector: sec, n: b.n, rs20: b.rs20.length ? median(b.rs20) : NaN, rs60: b.rs60.length ? median(b.rs60) : NaN, breadth: b.up / b.n });
  return out;
}

/* ----------------------------- rank one date ----------------------------- */
function rankDate(P, d, wantDetail) {
  const C = P.C; const R = [];
  for (let k = P.cnt[d]; k < P.cnt[d + 1]; k++) { const r = P.order[k]; if (P.rowGate[r] === 1) R.push(r); }
  const res = { top: {}, nCand: R.length, baseRow: null };
  if (!R.length) { Object.keys(RANK_VARIANTS).forEach((v) => { res.top[v] = []; }); if (wantDetail) { res.R = []; res.Pk = {}; res.secs = sectorStats(P, d); } return res; }
  const secs = sectorStats(P, d);
  const g = (arr) => R.map((r) => arr(r));
  const secVal = (r, key) => { const s = P.secOf[P.rowStock[r]]; const st = s && secs.get(s); return st ? st[key] : NaN; };
  const F = {
    rs60: g((r) => C.rs60[r]), rs20: g((r) => C.rs20[r]), sec60: g((r) => secVal(r, 'rs60')), sec20: g((r) => secVal(r, 'rs20')),
    nH252: g((r) => -C.distH252[r]), nbb: g((r) => -C.bbPctl[r]), nH20: g((r) => -Math.max(C.distH20[r], 0)), accum: g((r) => C.accum[r]),
    dip: g((r) => clamp(-C.d5[r], 0, 8)), trend: g((r) => C.trendUp[r]),
  };
  const Pk = {}; for (const k of Object.keys(F)) Pk[k] = pctRanks(F[k]);
  res.baseRow = R[(d * 2654435761 >>> 0) % R.length];
  for (const [vk, V] of Object.entries(RANK_VARIANTS)) {
    const list = [];
    for (let j = 0; j < R.length; j++) {
      const r = R[j];
      const c = { above200: C.above200[r], rs60: C.rs60[r], distH20: C.distH20[r], trendUp: C.trendUp[r], d5: C.d5[r] };
      if (!V.ok(c)) continue;
      let sc = 0; for (const [k, w] of Object.entries(V.w)) sc += w * Pk[k][j];
      list.push({ r, j, score: sc });
    }
    list.sort((a, b) => b.score - a.score);
    res.top[vk] = list.slice(0, TOPK);
  }
  if (wantDetail) { res.R = R; res.Pk = Pk; res.secs = secs; }
  return res;
}

/* ----------------------------- backtest of "buy the daily #1" ----------------------------- */
function stopDist(C, r, stopMult) {
  return clamp(Math.max((C.close[r] - (C.lo10[r] - 0.1 * C.atr[r])) / C.close[r], (stopMult * C.atrPct[r]) / 100), CFG.STOP_MIN, stopMaxFor(stopMult));
}
function evalCombo(P, seriesMap, topByDate, K, thr, stopMult, X, tag) {
  const sigs = []; const lastExit = new Array(P.syms.length).fill(-1);
  for (let d = 0; d < P.dates.length; d++) {
    const tops = topByDate[d]; if (!tops) continue;
    for (let k = 0; k < K && k < tops.length; k++) {
      const t = tops[k]; if (t.score < thr) continue;
      const r = t.r, si = P.rowStock[r], i = P.rowI[r], S = seriesMap[P.syms[si]];
      if (i > S.n - 2 || i <= lastExit[si]) continue;
      const o = simulate(S, i, stopDist(P.C, r, stopMult), P.C.atr[r], X);
      if (!o || o.skipped) continue;
      lastExit[si] = i + o.days;
      sigs.push({ sym: P.syms[si], setup: tag, score: t.score, signalDate: P.dates[d], regime: P.regimeByDate[d], ...o });
    }
  }
  return sigs;
}

function runRankLab(P, seriesMap, rankDates) {
  const cut = splitDate(seriesMap);
  const tops = {}; Object.keys(RANK_VARIANTS).forEach((v) => { tops[v] = rankDates.map((x) => x.top[v]); });
  const baseTop = rankDates.map((x) => (x.baseRow == null ? null : [{ r: x.baseRow, score: 1 }]));
  const trainScores = {}; for (const v of Object.keys(RANK_VARIANTS)) trainScores[v] = tops[v].map((t, d) => (P.dates[d] < cut && t && t[0] ? t[0].score : null)).filter((x) => x != null);
  const rows = []; let best = null;
  for (const v of Object.keys(RANK_VARIANTS)) {
    const thrs = [0, quantile(trainScores[v], 0.5), quantile(trainScores[v], 0.75)];
    thrs.forEach((thr, ti) => {
      for (const [sk, m] of Object.entries(STOPS)) for (const [ek, X] of Object.entries(EXITS)) {
        const sigs = evalCombo(P, seriesMap, tops[v], 1, thr, m, X, 'RANK');
        const tr = sigs.filter((s) => s.entryDate < cut), te = sigs.filter((s) => s.entryDate >= cut);
        const allowed = learnRegimes(tr);
        const trA = tr.filter((s) => allowed.includes(s.regime)), teA = te.filter((s) => allowed.includes(s.regime));
        const trS = stats(trA), teS = stats(teA);
        const se = trA.length > 1 ? stdev(trA.map((x) => x.net)) / Math.sqrt(trA.length) : 0;
        const trainScore = trS.n >= RANK_MIN_TRAIN ? trS.expectancy - 1.5 * se : -99;
        const row = { variant: v, thrIdx: ti, thr, stopKey: sk, stopMult: m, exitKey: ek, allowed, trainScore, trainN: trS.n || 0, trainExp: trS.expectancy ?? null, testN: teS.n || 0, testExp: teS.expectancy ?? null };
        rows.push(row);
        if (!best || trainScore > best.row.trainScore) best = { row, sigs, tr, te, trA, teA, trS, teS };
      }
    });
  }
  const b = best, X = EXITS[b.row.exitKey], v = b.row.variant;
  const oos = b.teS, ins = b.trS;
  const yrs = {}; [...b.trA, ...b.teA].forEach((x) => { const y = x.exitDate.slice(0, 4); (yrs[y] = yrs[y] || []).push(x.net); });
  const yrRows = Object.entries(yrs).filter(([, a]) => a.length >= 8);
  const posFrac = yrRows.length ? yrRows.filter(([, a]) => avg(a) > 0).length / yrRows.length : 0;
  const reasons = [];
  if (b.row.trainScore === -99) reasons.push(`train sample kam (n<${RANK_MIN_TRAIN})`);
  if (!b.row.allowed.length) reasons.push('train me kisi mausam me paisa nahi bana');
  if (!(oos.n >= CFG.LIC_MIN_OOS)) reasons.push(`test sample n=${oos.n || 0} < ${CFG.LIC_MIN_OOS}`);
  if (!(oos.expectancy >= CFG.LIC_MIN_EXP)) reasons.push(`test me avg ${oos.expectancy ?? '–'}%/trade (chahiye ≥ ${CFG.LIC_MIN_EXP}%)`);
  if (oos.n >= 2 && !(oos.expLow > 0)) reasons.push(`test avg ka pakka hissa ${oos.expLow}% ≤ 0`);
  if (!(oos.profitFactor >= CFG.LIC_MIN_PF)) reasons.push(`test profit factor ${oos.profitFactor ?? '–'} (chahiye ≥ ${CFG.LIC_MIN_PF})`);
  if (!(ins.expectancy > 0)) reasons.push('train me bhi expectancy ≤ 0');
  if (posFrac < CFG.LIC_MIN_POS_YEAR_FRAC) reasons.push(`sirf ${Math.round(posFrac * 100)}% saal profitable`);
  const teSorted = [...b.teA].sort((x, y) => (x.entryDate < y.entryDate ? -1 : 1)); const mid = Math.floor(teSorted.length / 2);
  const h1 = stats(teSorted.slice(0, mid)), h2 = stats(teSorted.slice(mid));
  const halvesOk = h1.n >= 15 && h2.n >= 15 && h1.expectancy > 0 && h2.expectancy > 0;
  if (oos.n >= 30 && !halvesOk) reasons.push(`test ke dono aadhe hisse positive nahi (${h1.expectancy ?? '–'}% / ${h2.expectancy ?? '–'}%) — consistent nahi`);
  let tier = 'UNPROVEN';
  if (reasons.length === 0) tier = 'PROVEN';
  else if (oos.n >= 60 && oos.expectancy >= 0.2 && oos.expLow1 > 0 && oos.profitFactor >= 1.1 && ins.expectancy > 0 && halvesOk) tier = 'LEAN';
  // extras for context: top-3 and random baseline, same stop/exit/thr
  const sig3 = evalCombo(P, seriesMap, tops[v], 3, b.row.thr, b.row.stopMult, X, 'RANK3').filter((s) => s.entryDate >= cut && b.row.allowed.includes(s.regime));
  const sigB = evalCombo(P, seriesMap, baseTop, 1, 0, b.row.stopMult, X, 'BASE').filter((s) => s.entryDate >= cut && b.row.allowed.includes(s.regime));
  const sigBall = evalCombo(P, seriesMap, baseTop, 1, 0, b.row.stopMult, X, 'BASE').filter((s) => s.entryDate >= cut);
  const baseS = stats(sigBall), top3S = stats(sig3);
  const byRegime = {}; for (const st of ['GREEN', 'AMBER', 'BEAR']) byRegime[st] = { train: stats(b.tr.filter((x) => x.regime === st)), test: stats(b.te.filter((x) => x.regime === st)) };
  const sel = { variant: v, label: RANK_VARIANTS[v].label, thrIdx: b.row.thrIdx, thr: b.row.thr, thrLabel: THR_LABELS[b.row.thrIdx], exit: X, stopMult: b.row.stopMult, allowedRegimes: b.row.allowed };
  const top = [...rows].sort((a, c) => c.trainScore - a.trainScore).slice(0, 10).map((r) => ({ variant: RANK_VARIANTS[r.variant].label, thrLabel: THR_LABELS[r.thrIdx], exit: EXITS[r.exitKey].label, stopMult: r.stopMult, trainN: r.trainN, trainExp: r.trainExp, testN: r.testN, testExp: r.testExp }));
  const perVariant = Object.keys(RANK_VARIANTS).map((vk) => { const best_ = rows.filter((r) => r.variant === vk).sort((a, c) => c.trainScore - a.trainScore)[0]; return { variant: RANK_VARIANTS[vk].label, trainExp: best_.trainExp, trainN: best_.trainN, testExp: best_.testExp, testN: best_.testN }; });
  return {
    selected: sel, tier, reasons, train: ins, test: oos, test3: top3S, baseline: baseS, liftPct: oos.expectancy != null && baseS.expectancy != null ? r2(oos.expectancy - baseS.expectancy) : null,
    byRegime, halves: [h1.expectancy ?? null, h2.expectancy ?? null], yearsProfitablePct: Math.round(posFrac * 100), testFrom: cut, comboCount: rows.length, topCombos: top, perVariant,
    portfolioTest: portfolioSim(b.teA),
  };
}

/* ----------------------------- live view for the latest date ----------------------------- */
function buildLive(P, seriesMap, lastDate, sel, rankLive) {
  const C = P.C; const { R, Pk, secs } = rankLive;
  const secList = [...secs.values()].map((s) => ({ ...s, comp: 0.6 * (Number.isNaN(s.rs20) ? 0 : s.rs20) + 0.4 * (Number.isNaN(s.rs60) ? 0 : s.rs60) })).sort((a, b) => b.comp - a.comp);
  const secRank = new Map(secList.map((s, k) => [s.sector, k + 1]));
  const sectors = secList.slice(0, 10).map((s) => ({ sector: s.sector, n: s.n, rs20: r1(s.rs20), rs60: r1(s.rs60), breadth: Math.round(s.breadth * 100), rank: secRank.get(s.sector) }));
  const V = RANK_VARIANTS[sel.variant];
  const jOf = new Map(R.map((r, j) => [r, j]));
  const mk = (t, rank) => {
    const r = t.r, j = jOf.get(r), si = P.rowStock[r]; const sym = P.syms[si]; const sector = P.secOf[si] || 'Unknown'; const st = secs.get(sector);
    const X = sel.exit; const dist = stopDist(C, r, sel.stopMult); const close = C.close[r];
    const c = {
      rank, symbol: sym, sector, score: r2(t.score), scorePct: Math.round(t.score * 100), price: r2(close), signalDate: P.dates[lastDate],
      d1: r1(C.d1[r]), d5: r1(C.d5[r]), d20: r1(C.d20[r]), rs20: r1(C.rs20[r]), rs60: r1(C.rs60[r]), secRS20: st ? r1(st.rs20) : null, secRS60: st ? r1(st.rs60) : null, secBreadth: st ? Math.round(st.breadth * 100) : null, secRank: secRank.get(sector) || null,
      bbPctl: Number.isNaN(C.bbPctl[r]) ? null : Math.round(C.bbPctl[r]), distH20: r1(C.distH20[r]), distH252: r1(C.distH252[r]), accum: r2(C.accum[r]), rsi: Math.round(C.rsi[r]), atrPct: r1(C.atrPct[r]), atrRs: r2(C.atr[r]), gapStdPct: r2(C.gapStd[r]), turnoverCr: r1(C.turn[r]),
      stopDist: dist, stopPrice: r2(close * (1 - dist)), riskPct: r1(dist * 100), skipIfOpenAbove: r2(close * (1 + CFG.MAX_GAP_UP / 100)),
      exit: X, stopMult: sel.stopMult, targets: { t1: r2(close * (1 + X.t1 / 100)), t3: r2(close * (1 + X.t3 / 100)) },
      pct: { rs60: r1(Pk.rs60[j] * 100), sec60: r1(Pk.sec60[j] * 100), nbb: r1(Pk.nbb[j] * 100) },
    };
    c.why = explain(c, sel.variant); c.cons = consOf(c);
    return c;
  };
  const top = (rankLive.top[sel.variant] || []).map((t, k) => mk(t, k + 1));
  // funnel
  let totalValid = 0, clean = 0, strong = 0, secStrong = 0, pool = 0; const half = Math.max(1, Math.ceil(secList.length / 2)); const strongSec = new Set(secList.slice(0, half).map((s) => s.sector));
  for (let k = P.cnt[lastDate]; k < P.cnt[lastDate + 1]; k++) {
    const r = P.order[k]; if (!valid(P, r)) continue; totalValid++;
    if (P.rowGate[r] !== 1) continue; clean++;
    if (C.above200[r] > 0 && C.rs60[r] > 0) { strong++; const sec = P.secOf[P.rowStock[r]]; if (!P.hasSectors || (sec && strongSec.has(sec))) secStrong++; }
    if (V.ok({ above200: C.above200[r], rs60: C.rs60[r], distH20: C.distH20[r], trendUp: C.trendUp[r], d5: C.d5[r] })) pool++;
  }
  const funnel = [
    { label: 'Saare stocks scan hue', n: totalValid },
    { label: 'Saaf & liquid (bhaage nahi, operator nahi)', n: clean },
    { label: 'Majboot trend + Nifty se aage', n: strong },
    { label: P.hasSectors ? 'Aur strong sector me' : 'Sector data nahi (skip)', n: secStrong },
    { label: `"${V.label}" shape me taiyar`, n: pool },
    { label: 'Aaj ka #1', n: top.length ? 1 : 0 },
  ];
  // "already ran" strong stocks (chase mat karo)
  const late = [];
  for (let k = P.cnt[lastDate]; k < P.cnt[lastDate + 1]; k++) {
    const r = P.order[k]; if (P.rowGate[r] !== 2 || !(C.above200[r] > 0) || !(C.rs60[r] > 0)) continue;
    late.push({ r, v: C.rs60[r] + 0.5 * (secs.get(P.secOf[P.rowStock[r]] || '')?.rs60 || 0) });
  }
  late.sort((a, b) => b.v - a.v);
  const lateOut = late.slice(0, 6).map((x) => {
    const sym = P.syms[P.rowStock[x.r]]; const f = featuresAt(seriesMap[sym], P.rowI[x.r]); const why = f ? commonGate(f)[0] : 'bhaag chuka';
    return { symbol: sym, price: r2(C.close[x.r]), d1: r1(C.d1[x.r]), d5: r1(C.d5[x.r]), d20: r1(C.d20[x.r]), why };
  });
  return { asOf: P.dates[lastDate], top, sectors, funnel, late: lateOut, sectorsAvailable: P.hasSectors };
}

function explain(c, variant) {
  const w = [];
  if (c.secRS20 != null) w.push(`Sector ${c.sector} ${c.secRank <= 3 ? 'top-3 me' : 'theek'}: 20 din me Nifty se ${c.secRS20 >= 0 ? '+' : ''}${c.secRS20}% aage/peeche, ${c.secBreadth}% stocks SMA50 ke upar`);
  w.push(`Stock apne group ke top ${Math.max(1, Math.round(100 - c.pct.rs60))}% me hai (60 din me Nifty se ${c.rs60 >= 0 ? '+' : ''}${c.rs60}%)`);
  w.push(`Abhi tak bhaaga nahi: aaj ${c.d1}%, 5 din ${c.d5}%, 20 din ${c.d20}%`);
  if (c.bbPctl != null && c.bbPctl <= 35) w.push(`Volatility coil: pichle 6 mahine ka sabse shant ${c.bbPctl}% hissa`);
  if (c.distH20 >= 0 && c.distH20 <= 6) w.push(`20-din high se sirf ${c.distH20}% neeche — breakout ka trigger paas`);
  if (variant === 'DIP' || (c.d5 <= -2 && c.d5 >= -8)) w.push(`5 din me ${c.d5}% ka dip, par trend majboot — "dip kharido" mauka`);
  if (c.accum >= 1.15) w.push(`Volume me kharidari ka jhukav (up-din volume ${c.accum}× down-din)`);
  return w;
}
function consOf(c) {
  const k = [];
  if (c.secRS20 != null && c.secRS20 < 0) k.push(`Sector ${c.sector} abhi Nifty se peeche chal raha hai`);
  if (c.secRS20 == null) k.push('Sector data nahi — sector strength check nahi hua');
  if (c.riskPct >= 5) k.push(`Stop ${c.riskPct}% door — ek trade me itna loss ho sakta hai`);
  if (c.gapStdPct >= 1.6) k.push(`Raat ke gap zyada (σ ${c.gapStdPct}%) — stop se bhi zyada loss ka risk`);
  if (c.rsi >= 70) k.push(`RSI ${c.rsi} — thoda garam`);
  return k;
}

/* ----------------------------- orchestrator ----------------------------- */
function runAll(dataBySymbol, nifty, vix, hygiene = {}, sectorMap = {}) {
  const regimeFn = buildRegime(nifty, vix);
  const seriesMap = {}; const skipped = {};
  for (const [sym, raw] of Object.entries(dataBySymbol)) {
    const { c, reason } = cleanCandles(raw, hygiene);
    if (!c) { skipped[reason] = (skipped[reason] || 0) + 1; continue; }
    seriesMap[sym] = buildSeries(c, nifty);
  }
  const P = buildPanel(seriesMap, regimeFn, sectorMap);
  const { lab, selSigs, cutoff } = E.runLab(P.events, seriesMap);
  const live = E.scanLive(seriesMap, regimeFn, lab, selSigs);
  const lastDate = P.dates.length - 1;
  const rankDates = P.dates.map((_, d) => (d === lastDate ? rankDate(P, d, true) : rankDate(P, d, false)));
  const rankLab = runRankLab(P, seriesMap, rankDates);
  const rankLive = buildLive(P, seriesMap, lastDate, rankLab.selected, rankDates[lastDate]);
  const licensedTest = Object.keys(lab).filter((k) => lab[k].licensed).flatMap((k) => selSigs[k].test);
  const licensedAll = Object.keys(lab).filter((k) => lab[k].licensed).flatMap((k) => [...selSigs[k].train, ...selSigs[k].test]);
  return {
    scanned: Object.keys(seriesMap).length, dataSkipped: skipped, events: P.events.length, testFrom: cutoff,
    licensing: lab, portfolioOOS: portfolioSim(licensedTest), portfolioAll: portfolioSim(licensedAll),
    anyLicensed: Object.values(lab).some((x) => x.licensed), ...live,
    rank: { lab: rankLab, live: rankLive },
    caveats: [
      'Backtest current index constituents pe hai (survivorship bias) — asli result thoda kamzor ho sakta hai.',
      'Koi bhi system 90% nahi deta. Sab numbers measured hain, costs aur gap ke baad.',
      'Daily-#1 ranking me variant/threshold/stop/exit sirf TRAIN (pehle 60%) se chune jate hain, phir untouched TEST (aakhri 40%) se parkhe jate hain. Phir bhi forward test zaruri hai.',
      'Thresholds baar-baar tune karke backtest "sundar" mat banao — wo overfit hai.',
      'Circuit/halt, news-shock aur overnight gap me stop se zyada loss ho sakta hai.',
    ],
  };
}

module.exports = { RANK_VARIANTS, THR_LABELS, buildPanel, rankDate, runRankLab, buildLive, runAll, explain, consOf, pctRanks };
