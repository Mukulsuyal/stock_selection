const express = require('express');
const path = require('path');
const { Worker } = require('worker_threads');
const router = express.Router();
const marketData = require('../marketData');
const { mapLimit } = require('../stockAnalysisEngine');
const { INDEXES } = require('../indexConstituents');
const E = require('../weekRunnerEngine');
const LOG = require('../weekRunnerLog');
const CAL = require('../weekRunnerCalendar');

const ANALYSIS_TTL = 30 * 60 * 1000;
const EARN_TTL = 12 * 3600 * 1000;
let cache = { at: 0, data: null, candles: null };
let running = null; let progress = { phase: 'idle', done: 0, total: 0 };
const earnCache = new Map();

function istNow() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const p = (n) => String(n).padStart(2, '0');
  return { todayIST: `${ist.getFullYear()}-${p(ist.getMonth() + 1)}-${p(ist.getDate())}`, istMinutes: ist.getHours() * 60 + ist.getMinutes() };
}

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'weekRunnerWorker.js'), { workerData: payload });
    w.once('message', (m) => (m.ok ? resolve(m.out) : reject(new Error(m.error))));
    w.once('error', reject);
  });
}

async function buildAnalysis() {
  const syms = [...new Set(Object.values(INDEXES).flatMap((i) => i.symbols))];
  progress = { phase: 'data', done: 0, total: syms.length };
  const [nifty, vix] = await Promise.all([
    marketData.getHistorical('^NSEI', 1260).catch(() => null),
    marketData.getHistorical('^INDIAVIX', 1260).catch(() => null),
  ]);
  const data = {};
  await mapLimit(syms, 5, async (s) => { try { data[s] = await marketData.getHistorical(s, 1260); } catch (_) {} },
    (done, total) => { progress = { phase: 'data', done, total }; });
  progress = { phase: 'analysis', done: 0, total: 1 };
  const hygiene = istNow();
  let sectors = {}; try { sectors = await require('../institutional/sectorSync').getSectorMap(); } catch (_) {}
  const out = await runWorker({ data, nifty, vix, hygiene, sectors });
  progress = { phase: 'idle', done: 1, total: 1 };
  const candles = {};
  for (const s of Object.keys(data)) { const { c } = E.cleanCandles(data[s], hygiene); if (c) candles[s] = c; }
  LOG.refreshOutcomes(candles);
  return { out, candles, niftyOk: !!nifty, vixOk: !!vix };
}

let holCache = { at: 0, set: null };
async function getHolidays() {
  if (holCache.set && Date.now() - holCache.at < 3600000) return holCache.set;
  const set = new Set(CAL.FALLBACK_HOLIDAYS_2026);
  try { const M = require('../models/MarketHoliday'); const docs = await M.find({}).lean(); docs.forEach((d) => d.date && set.add(d.date)); } catch (_) {}
  holCache = { at: Date.now(), set }; return set;
}

// Turn a pick into plain "kya karna hai" steps (dates, qty, exact rupees)
function attachAction(p, session, hol) {
  const qty = p.size?.qty || 0; const X = p.exit;
  const exitBy = CAL.nextTradingDay(session.actionDate, hol, X.hold - 1);
  const trail = p.atrRs ? Math.round(X.trail * p.atrRs * 100) / 100 : null;
  p.action = {
    buyDate: session.actionLabel, exitByDate: CAL.label(exitBy), holdDays: X.hold,
    steps: [
      `${session.actionLabel}: 9:30 ke baad LIMIT order — ₹${p.price} se ₹${p.skipIfOpenAbove} ke beech. Agar stock ₹${p.skipIfOpenAbove} se upar khul gaya to SKIP (chase mat karo).`,
      qty ? `Quantity: ${qty} shares.` : 'Quantity: capital daalo to milegi.',
      `Kharidte hi STOP-LOSS order lagao: ₹${p.stopPrice}. Isse neeche kabhi mat khiskao.`,
      `Agar ₹${p.targets.t1} (+${X.t1}%) touch ho: aadha (${qty ? Math.floor(qty / 2) : '½'} shares) bech do, aur stop-loss entry price ke upar le aao (loss-free).`,
      `Bacha hua: roz close pe stop = (ab tak ka sabse ucha bhav − ₹${trail ?? X.trail + '×ATR'}) tak upar karte raho (kabhi neeche nahi). ₹${p.targets.t3} (+${X.t3}%) pe bech do.`,
      `${CAL.label(exitBy)} (${X.hold}wa trading din) ko close se pehle jo bhi bacha ho nikal do.`,
    ],
  };
  return p;
}

async function earningsFor(symbols) {
  const res = {};
  await mapLimit(symbols, 3, async (s) => {
    const hit = earnCache.get(s);
    if (hit && Date.now() - hit.at < EARN_TTL) { res[s] = hit.v; return; }
    let v = { known: false, daysUntil: null };
    try { const ev = await marketData.getEvents(s); if (ev?.nextEarnings && ev.daysUntil != null && ev.daysUntil >= -1) v = { known: true, daysUntil: ev.daysUntil, date: ev.nextEarnings }; } catch (_) {}
    earnCache.set(s, { at: Date.now(), v }); res[s] = v;
  });
  return res;
}

async function liveCheck(picks) {
  await mapLimit(picks, 3, async (p) => {
    try {
      const q = await marketData.getQuote(p.symbol); const px = q?.lastPrice;
      if (px == null) return;
      p.live = { price: Number(px.toFixed(2)), vsSignalPct: Number(((px / p.price - 1) * 100).toFixed(1)) };
      if (px > p.skipIfOpenAbove) p.liveStatus = 'MISSED';
      else if (px <= p.stopPrice) p.liveStatus = 'INVALID';
      else p.liveStatus = 'OK';
    } catch (_) {}
  });
  return picks;
}

const REGIME_PLAIN = {
  GREEN: 'Market ka trend theek hai.',
  AMBER: 'Market thoda kamzor/volatile hai — size aadha.',
  BEAR: 'Market ka lamba trend neeche hai. Aaj ki +% sirf ek din ki uchhal ho sakti hai. Isliye sirf wahi tareeke allowed hain jinhone past me aise mausam me bhi kaam kiya.',
  CRASH: 'Achanak giravat ya darr (VIX) — koi naya trade nahi.',
  UNKNOWN: 'Nifty data nahi mila — size aadha.',
};
const TIER_MULT = { PROVEN: 1, LEAN: 0.4, UNPROVEN: 0.25, PAPER: 0 };
const TIER_LABEL = {
  PROVEN: 'PAKKA — test data me paisa banaya',
  LEAN: 'HALKA SANKET — kismat bhi ho sakta hai',
  UNPROVEN: 'BINA SABOOT — sirf bahut chhota size ya paper',
  PAPER: 'PAPER ONLY — guard ON',
};

function expectOf(st) {
  if (!st || !st.n) return null;
  return { n: st.n, expectancy: st.expectancy, t1Rate: st.t1Rate, stopRate: st.stopRate, profitFactor: st.profitFactor, rupeePer10k: Math.round((st.expectancy || 0) * 100), worst: st.worst, maxLoseStreak: st.maxLoseStreak };
}

function tierCons(tier, rankLab, regimeFit, regime) {
  const c = [];
  const t = rankLab.test || {};
  if (tier === 'UNPROVEN') c.push(`Is ranking ne untouched test me paisa NAHI banaya (${t.n || 0} trades, avg ${t.expectancy ?? '–'}%/trade). Isliye sirf bahut chhota size ya paper.`);
  if (tier === 'LEAN') c.push('Test me thoda sa edge dikha, par itna pakka nahi — kismat ka bhi ho sakta hai. Isliye size sirf 0.4×.');
  if (!regimeFit && rankLab.tier !== 'UNPROVEN') c.push(`Abhi ka mausam (${regime.state}) us mausam se alag hai jisme ye tareeka train me chala tha.`);
  if (tier === 'PAPER') c.push('Forward-test guard ON — pehle paper me dekho.');
  return c;
}

async function buildResponse(A, capital, riskPct) {
  const fwd = LOG.forwardStats();
  const hol = await getHolidays(); const ist = istNow();
  const session = CAL.sessionPlan({ todayIST: ist.todayIST, istMinutes: ist.istMinutes, hol });
  const regime = A.regimeNow; const crash = regime.state === 'CRASH';
  const rankLab = A.rank.lab; const sel = rankLab.selected;
  const regimeFit = sel.allowedRegimes.includes(regime.state);
  let baseTier = rankLab.tier;
  if (!regimeFit && (baseTier === 'PROVEN' || baseTier === 'LEAN')) baseTier = 'UNPROVEN';
  if (fwd.pause) baseTier = 'PAPER';
  let sectors = {}; try { sectors = await require('../institutional/sectorSync').getSectorMap(); } catch (_) {}

  // --- setup-based (proven shapes) picks
  const eligibleSetup = A.candidates.filter((c) => c.grade === 'A' || c.grade === 'B').slice(0, 14);
  const rankTop = (A.rank.live.top || []).map((c) => ({ ...c }));
  const earnings = crash ? {} : await earningsFor([...new Set([...eligibleSetup.map((c) => c.symbol), ...rankTop.map((c) => c.symbol)])]);
  const fin = E.finalizePicks(A.candidates, { earnings, sectors, regime, capital, riskPct, forwardPause: fwd.pause });
  if (session.blockNewEntries && fin.picks.length) { fin.picks.forEach((p) => fin.blocked.push({ symbol: p.symbol, reason: 'Entry ke baad lamba market-band — stop kaam nahi karega' })); fin.picks = []; }

  // --- rank-based daily best
  const blocked = [...fin.blocked];
  const rankOk = [];
  for (const c of rankTop) {
    const e = earnings[c.symbol];
    if (e && e.known && e.daysUntil != null && e.daysUntil >= -1 && e.daysUntil <= E.CFG.EARNINGS_BLACKOUT_DAYS) { blocked.push({ symbol: c.symbol, reason: `Result ${e.daysUntil} din me — gap risk` }); continue; }
    Object.assign(c, { kind: 'RANK', setupKey: 'RANK_' + sel.variant, tier: baseTier, earningsDays: e?.daysUntil ?? null, notes: [] });
    if (!e || !e.known) c.notes.push('Result date pata nahi — size aadha');
    rankOk.push(c);
  }
  await liveCheck([...fin.picks, ...rankOk.slice(0, 6)]);
  const okLive = (p) => !p.liveStatus || p.liveStatus === 'OK';
  const weakDay = !rankTop.length || rankTop[0].score < sel.thr;

  const sizeFor = (c, tier) => (tier === 'PAPER' ? null : E.sizePosition({ capital, riskPct, entry: c.price, stopDist: c.stopDist, gapStdPct: c.gapStdPct, regimeMult: regime.mult, extraMult: (TIER_MULT[tier] || 0) * (c.notes?.some((n) => /aadha/.test(n)) ? 0.5 : 1), maxPosPct: tier === 'PROVEN' ? 25 : tier === 'LEAN' ? 15 : 10 }));
  const finish = (c) => {
    c.tierLabel = TIER_LABEL[c.tier]; c.size = sizeFor(c, c.tier); c.cons = [...tierCons(c.tier, rankLab, regimeFit, regime), ...(c.cons || [])];
    c.expect = expectOf(rankLab.test);
    return c;
  };
  // setup pick as hero candidate
  const setupHeroSrc = fin.picks.filter(okLive)[0];
  let hero = null; let heroWhy = '';
  if (setupHeroSrc) {
    const L = A.licensing[setupHeroSrc.setup];
    hero = { ...setupHeroSrc, kind: 'SETUP', setupKey: setupHeroSrc.setup, tier: fwd.pause ? 'PAPER' : 'PROVEN', secRank: null, why: setupHeroSrc.scorecard.pros, cons: setupHeroSrc.scorecard.cons, expect: expectOf(L.outOfSample), tierLabel: fwd.pause ? TIER_LABEL.PAPER : TIER_LABEL.PROVEN, label: setupHeroSrc.setupLabel };
    hero.size = hero.tier === 'PAPER' ? null : setupHeroSrc.size; heroWhy = 'SETUP';
  } else if (!crash && !session.blockNewEntries && !weakDay) {
    const c = rankOk.filter(okLive)[0];
    if (c) { hero = finish(c); hero.label = sel.label; hero.setupLabel = sel.label; heroWhy = 'RANK'; }
  }
  const backups = rankOk.filter((c) => c !== hero && !(hero && c.symbol === hero.symbol)).slice(0, 4).map((c) => { const x = finish({ ...c }); x.label = sel.label; return x; });
  if (hero && hero.liveStatus !== 'MISSED') attachAction(hero, session, hol);

  const hasHero = !!hero && hero.tier !== 'PAPER';
  let verdict = 'NO_PICK', verdictText = '';
  if (crash) verdictText = 'Market me achanak giravat/darr hai — aaj koi naya trade nahi. Cash me rehna bhi position hai.';
  else if (session.blockNewEntries) verdictText = 'Entry ke turant baad lamba market-band aa raha hai — naya trade avoid.';
  else if (hero && hero.tier === 'PAPER') { verdict = 'PAPER'; verdictText = `Forward-test guard ON (${fwd.pauseReason}) — aaj sirf paper trade karo.`; }
  else if (hero) { verdict = { PROVEN: 'GO', LEAN: 'SMALL', UNPROVEN: 'TINY' }[hero.tier]; verdictText = { PROVEN: 'Aaj ka best stock mil gaya, aur uske tareeke ne test me paisa banaya hai.', LEAN: 'Aaj ka best stock mil gaya. Test me halka sanket hai — isliye chhota size.', UNPROVEN: 'Aaj ka best stock mil gaya. Par ye tareeka test me paisa nahi bana paya — isliye sirf bahut chhota size ya paper.' }[hero.tier]; }
  else if (weakDay) verdictText = 'Aaj ke #1 stock ka score itna kamzor hai ki (past data ke hisaab se) aise din paisa nahi bana. Aaj wait karo — kal phir.';
  else verdictText = 'Aaj koi stock sab filters pass nahi kar paya (result date / bhaag chuka / live price). Wait karo.';

  const checks = [
    { ok: regime.state === 'GREEN' || regime.state === 'AMBER', warn: regime.state === 'BEAR', title: `Market: ${regime.state}`, text: REGIME_PLAIN[regime.state] },
    { ok: rankLab.tier === 'PROVEN', warn: rankLab.tier === 'LEAN', title: 'Roz ka #1 tareeka (test)', text: rankLab.tier === 'PROVEN' ? 'Untouched test data me paisa banaya.' : rankLab.tier === 'LEAN' ? 'Halka sanket — pakka nahi.' : 'Test data me paisa nahi bana.' },
    { ok: regimeFit, title: 'Mausam se mel', text: regimeFit ? `Ye tareeka ${regime.state} mausam me train me chala tha.` : `Ye tareeka ${regime.state} mausam me train me nahi chala (chala: ${sel.allowedRegimes.join('/') || 'koi nahi'}).` },
    { ok: !fwd.pause, title: 'Forward-test guard', text: fwd.pause ? `ON: ${fwd.pauseReason}` : (fwd.picks.n ? `OFF — ${fwd.picks.n} live trades grade ho chuke.` : 'OFF — live record abhi shuru hona baaki.') },
    { ok: !weakDay, title: 'Aaj ka #1 kitna mazboot', text: rankTop[0] ? `Score ${rankTop[0].scorePct}/100 (kam se kam ${Math.round(sel.thr * 100)} chahiye).` : 'Koi stock nahi.' },
  ];

  const setupRest = fin.picks.filter((p) => !hero || p.symbol !== hero.symbol);
  if (hero && hero.liveStatus !== 'MISSED') LOG.logBest(hero, backups, regime);
  LOG.logPicks(setupRest.filter((p) => p.liveStatus !== 'MISSED'), [], regime);

  const invested = hasHero ? (hero.size?.capitalUsed || 0) : 0;
  const allocation = capital && hasHero && hero.size ? { capital, invested, cashLeft: capital - invested, investedPct: Math.round(invested / capital * 100), maxLoss: hero.size.maxLossIfStopHits, maxLossPct: Number((hero.size.maxLossIfStopHits / capital * 100).toFixed(2)), gapWorst: hero.size.gapWorstCaseRs } : null;

  return {
    ok: true, session, verdict, verdictText, hero, backups, weakDay, checks, allocation, asOf: A.asOf, regime, regimePlain: REGIME_PLAIN[regime.state],
    rank: { lab: rankLab, funnel: A.rank.live.funnel, sectors: A.rank.live.sectors, late: A.rank.live.late, sectorsAvailable: A.rank.live.sectorsAvailable, liveAsOf: A.rank.live.asOf },
    setupLab: A.licensing, testFrom: A.testFrom, portfolioOOS: A.portfolioOOS, setupPicks: setupRest, blocked, nearMiss: A.nearMiss, nearMissHidden: A.nearMissHidden,
    forward: fwd, scanned: A.scanned, dataSkipped: A.dataSkipped, rejectCounts: A.rejectCounts, caveats: A.caveats, vixOk: cache.vixOk, niftyOk: cache.niftyOk, cachedAt: new Date(cache.at).toISOString(),
  };
}

router.get('/status', (req, res) => res.json({ running: !!running, progress }));

// GET /api/week-runner/scan?force=1&capital=300000&risk=0.75
router.get('/scan', async (req, res) => {
  try {
    const capital = Math.max(0, Number(req.query.capital) || 0);
    const riskPct = Math.min(2, Math.max(0.25, Number(req.query.risk) || 0.75));
    if (req.query.force === '1' || !cache.data || Date.now() - cache.at > ANALYSIS_TTL) {
      if (!running) running = buildAnalysis().finally(() => { running = null; });
      const a = await running;
      cache = { at: Date.now(), data: a.out, candles: a.candles, niftyOk: a.niftyOk, vixOk: a.vixOk };
    }
    res.json(await buildResponse(cache.data, capital, riskPct));
  } catch (e) {
    console.error('[week-runner]', e);
    res.status(500).json({ error: 'Week runner scan failed', detail: e.message });
  }
});

router.get('/forward', (req, res) => res.json({ ok: true, ...LOG.forwardStats() }));
module.exports = router;
