// Multi-Bagger Radar — rare, deep-conviction names (max 1–2 per batch).
// Runs after market close / weekend. Not a daily churn list. Not a profit guarantee.
// Combines universe scan + relative structure + fundamentals + news + market regime.
const { isMongoConfigured } = require('./mongo');
const { getCombinedUniverseScan } = require('./universeScan');
const { computeScoreBreakdown, assessPickQuality, isAffordableRecommendPrice } = require('./stockAnalysisEngine');
const marketData = require('./marketData');
const { getMarketTrend } = require('./marketTrend');
const MultibaggerPick = require('./models/MultibaggerPick');
const { startJob, updateJob, endJob } = require('./progressStore');

let lastResearchMeta = { nearMisses: [], note: null, batchDate: null, filterReject: null };

// No artificial "only 1–2" cap. Quality bar decides count.
// Soft max avoids a noisy laundry list if market is broadly strong.
const TARGET_COUNT = 5; // max 5 official multi-bagger names
const MIN_CONVICTION_SCORE = Number(process.env.MB_MIN_CONVICTION || 52);
// Technical/timing is SECONDARY — soft floors only (not primary multi-bag gates)
const MIN_RR_SOFT = Number(process.env.MB_MIN_RR_SOFT || 1.2);
const MAX_LOSS_PROB_SOFT = Number(process.env.MB_MAX_LOSS_SOFT || 60);
const MIN_PROFIT5_SOFT = Number(process.env.MB_MIN_PROFIT5_SOFT || 20);
const MIN_SAMPLE_SOFT = Number(process.env.MB_MIN_SAMPLE_SOFT || 6);
const MIN_TECH_SCORE = Number(process.env.MB_MIN_TECH || -2);
// Configurable pillar weights (must sum ~1)
const W_FUND = Number(process.env.MB_W_FUND || 0.55);
const W_GROWTH = Number(process.env.MB_W_GROWTH || 0.25);
const W_VAL = Number(process.env.MB_W_VAL || 0.15);
const W_TECH = Number(process.env.MB_W_TECH || 0.05);
const HORIZON_DAYS = Number(process.env.MB_HORIZON_DAYS || 180); // 6+ months

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function normPct(x) {
  if (x == null || !Number.isFinite(Number(x))) return null;
  const n = Number(x);
  return Math.abs(n) <= 5 ? n * 100 : n;
}

function scoreFundamentalQuality(extras) {
  // 0–100: ROE/ROCE, margins, debt, cash-quality proxies when available
  let s = 50;
  const reasons = [];
  const missing = [];
  const roe = extras.roe;
  const roce = extras.roce;
  const de = extras.debtToEquity;
  const margin = extras.profitMargin != null
    ? (extras.profitMargin <= 1.5 ? extras.profitMargin * 100 : extras.profitMargin)
    : null;
  const cfoPat = extras.cfoVsPat; // optional
  const fcf = extras.freeCashFlow;
  const interestCover = extras.interestCoverage;
  const promoter = extras.promoterHolding;
  const pledge = extras.promoterPledge;

  if (roe == null && roce == null) missing.push('ROE/ROCE');
  if (roe != null) {
    if (roe >= 20) { s += 18; reasons.push('PASS ROE strong'); }
    else if (roe >= 15) { s += 12; reasons.push('PASS ROE healthy'); }
    else if (roe >= 10) { s += 5; reasons.push('PASS ROE ok'); }
    else if (roe < 5) { s -= 14; reasons.push('FAIL ROE weak'); }
    else { s -= 4; reasons.push('WATCH ROE soft'); }
  }
  if (roce != null) {
    if (roce >= 18) { s += 10; reasons.push('PASS ROCE strong'); }
    else if (roce >= 12) { s += 5; }
    else if (roce < 8) { s -= 8; reasons.push('FAIL ROCE weak'); }
  }
  if (margin != null) {
    if (margin >= 15) { s += 8; reasons.push('PASS margins'); }
    else if (margin >= 8) { s += 3; }
    else if (margin < 3) { s -= 8; reasons.push('FAIL thin margins'); }
  } else missing.push('profitMargin');

  if (de == null) missing.push('debtToEquity');
  else {
    if (de <= 0.3) { s += 10; reasons.push('PASS low leverage'); }
    else if (de <= 0.8) { s += 5; reasons.push('PASS moderate debt'); }
    else if (de <= 1.5) { s -= 2; reasons.push('WATCH leverage'); }
    else if (de > 2.5) { s -= 16; reasons.push('FAIL high debt'); }
    else { s -= 8; reasons.push('FAIL elevated debt'); }
  }

  if (interestCover != null) {
    if (interestCover >= 5) { s += 6; reasons.push('PASS interest cover'); }
    else if (interestCover < 2) { s -= 10; reasons.push('FAIL interest cover'); }
  }
  if (cfoPat != null) {
    if (cfoPat >= 0.8) { s += 8; reasons.push('PASS CFO vs PAT'); }
    else if (cfoPat < 0.4) { s -= 8; reasons.push('FAIL cash conversion'); }
  }
  if (fcf != null) {
    if (fcf > 0) { s += 5; reasons.push('PASS positive FCF'); }
    else { s -= 6; reasons.push('WATCH negative FCF'); }
  }
  if (promoter != null) {
    if (promoter >= 50) { s += 4; }
    else if (promoter < 30) { s -= 4; reasons.push('WATCH low promoter'); }
  }
  if (pledge != null && pledge > 20) {
    s -= 10;
    reasons.push('FAIL high promoter pledge');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(s))),
    reasons,
    missing,
  };
}

function scoreBusinessGrowth(extras) {
  // 0–100: revenue/EPS/PAT growth, industry tailwind proxy
  let s = 50;
  const reasons = [];
  const missing = [];
  const rg = normPct(extras.revenueYoY ?? extras.revenueGrowth);
  const eg = normPct(extras.earningsGrowth ?? extras.profitYoY);
  const rg3 = normPct(extras.revenueCagr3y);
  const eg3 = normPct(extras.earningsCagr3y);

  if (rg == null && eg == null && rg3 == null) missing.push('growth rates');

  const applyG = (val, label) => {
    if (val == null) return;
    if (val >= 25) { s += 14; reasons.push(`PASS ${label} very strong`); }
    else if (val >= 15) { s += 10; reasons.push(`PASS ${label} strong`); }
    else if (val >= 8) { s += 5; reasons.push(`PASS ${label} solid`); }
    else if (val >= 0) { s += 1; }
    else if (val > -8) { s -= 6; reasons.push(`WATCH ${label} soft`); }
    else { s -= 14; reasons.push(`FAIL ${label} negative`); }
  };
  applyG(rg3 ?? rg, 'revenue growth');
  applyG(eg3 ?? eg, 'earnings growth');

  // Sector / index bias as soft industry growth proxy
  if (extras.indexLabel && /mid|small/i.test(extras.indexLabel)) {
    s += 4;
    reasons.push('PASS mid/small growth runway');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(s))),
    reasons,
    missing,
  };
}

function scoreValuation(extras) {
  // Relative sense-check — not fixed PE cutoffs only
  let s = 50;
  const reasons = [];
  const missing = [];
  const pe = extras.pe;
  const pb = extras.priceToBook;
  const peg = extras.peg;
  const evEbitda = extras.evEbitda;
  const g = normPct(extras.earningsGrowth ?? extras.revenueGrowth);

  if (pe == null && pb == null) missing.push('PE/PB');

  if (pe != null && pe > 0) {
    // Context with growth (PEG-like)
    if (g != null && g > 0) {
      const impliedPeg = pe / g;
      if (impliedPeg < 1) { s += 14; reasons.push('PASS PE attractive vs growth'); }
      else if (impliedPeg < 1.5) { s += 8; reasons.push('PASS PE reasonable vs growth'); }
      else if (impliedPeg < 2.5) { s += 2; reasons.push('WATCH PE fair vs growth'); }
      else { s -= 10; reasons.push('FAIL PE rich vs growth'); }
    } else {
      if (pe < 18) { s += 10; reasons.push('PASS PE modest'); }
      else if (pe < 30) { s += 4; reasons.push('PASS PE ok'); }
      else if (pe < 50) { s -= 4; reasons.push('WATCH elevated PE'); }
      else { s -= 12; reasons.push('FAIL very high PE'); }
    }
  }
  if (peg != null) {
    if (peg < 1) { s += 8; reasons.push('PASS PEG < 1'); }
    else if (peg > 2.5) { s -= 8; reasons.push('FAIL high PEG'); }
  }
  if (pb != null && pb > 0) {
    if (pb < 3) s += 4;
    else if (pb > 12) { s -= 6; reasons.push('WATCH high P/B'); }
  }
  if (evEbitda != null) {
    if (evEbitda < 12) s += 4;
    else if (evEbitda > 25) { s -= 5; reasons.push('WATCH high EV/EBITDA'); }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(s))),
    reasons,
    missing,
  };
}

function scoreTechnicalTiming(r, marketContext) {
  // SECONDARY only — entry timing, not multi-bag identity
  let s = 50;
  const reasons = [];
  const q = assessPickQuality(r, marketContext);
  s += Math.min(15, (q.score || 0) * 1.5);
  if (r.score != null) s += Math.min(12, Math.max(-10, r.score * 4));
  const rr = r.tradePlan?.riskRewardRatio || 0;
  if (rr >= 2) { s += 10; reasons.push('PASS timing R:R'); }
  else if (rr >= MIN_RR_SOFT) { s += 4; }
  else if (rr > 0) { s -= 4; reasons.push('WATCH weak R:R (timing only)'); }
  const p = r.moveProbability;
  if (p?.status === 'ok') {
    if ((p.probabilityUp5PctPlus || 0) >= 40) s += 6;
    else if ((p.probabilityUp5PctPlus || 0) < MIN_PROFIT5_SOFT) { s -= 4; reasons.push('WATCH soft +5% history (timing)'); }
    if ((p.probabilityDown2PctPlus || 0) > MAX_LOSS_PROB_SOFT) {
      s -= 6;
      reasons.push('WATCH elevated near-term drop odds (timing)');
    }
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(s))),
    reasons,
  };
}

/**
 * Primary multi-bagger score: Fund 50% + Growth 25% + Val 15% + Tech/Timing 10%.
 * Returns 0–100 conviction + explainability.
 */
function multibaggerScore(r, marketContext, extras = {}) {
  const fund = scoreFundamentalQuality(extras);
  const growth = scoreBusinessGrowth(extras);
  const val = scoreValuation(extras);
  const tech = scoreTechnicalTiming(r, marketContext);

  const wSum = W_FUND + W_GROWTH + W_VAL + W_TECH || 1;
  const overall =
    (fund.score * W_FUND + growth.score * W_GROWTH + val.score * W_VAL + tech.score * W_TECH) / wSum;

  const missing = [...new Set([...(fund.missing || []), ...(growth.missing || []), ...(val.missing || [])])];
  const hardFails = [...fund.reasons, ...growth.reasons, ...val.reasons].filter((x) => x.startsWith('FAIL'));
  const passes = [...fund.reasons, ...growth.reasons, ...val.reasons].filter((x) => x.startsWith('PASS'));

  // Data confidence
  let confidence = 'medium';
  if (missing.length >= 4) confidence = 'low';
  else if (missing.length <= 1 && (extras.roe != null || extras.pe != null)) confidence = 'high';
  if (!extras.source && missing.length >= 3) confidence = 'low';

  const dataFreshness = extras.fetchedAt || extras.fromCache ? (extras.fromCache ? 'cache' : 'live') : 'unknown';

  return {
    overall: Number(overall.toFixed(1)),
    // backward-compatible: callers used convictionScore as number
    valueOf() { return this.overall; },
    pillars: {
      fundamentalQuality: fund.score,
      businessGrowth: growth.score,
      valuation: val.score,
      technicalTiming: tech.score,
    },
    weights: { fund: W_FUND, growth: W_GROWTH, valuation: W_VAL, technical: W_TECH },
    passReasons: passes.slice(0, 8),
    failReasons: hardFails.slice(0, 8),
    timingNotes: tech.reasons.slice(0, 4),
    missingData: missing,
    confidence,
    dataFreshness,
    source: extras.source || null,
  };
}

function convictionNumber(scoreObj) {
  if (scoreObj == null) return 0;
  if (typeof scoreObj === 'number') return scoreObj;
  return Number(scoreObj.overall || 0);
}

function buildThesis(r, extras, marketContext, scoreObj) {
  const parts = [];
  parts.push(`${r.symbol} — 6+ month multi-bagger research candidate (not a daily tip, not a guarantee).`);
  if (scoreObj?.pillars) {
    parts.push(
      `Pillars Q${scoreObj.pillars.fundamentalQuality}/G${scoreObj.pillars.businessGrowth}/V${scoreObj.pillars.valuation}/T${scoreObj.pillars.technicalTiming} (weights ${Math.round(W_FUND * 100)}/${Math.round(W_GROWTH * 100)}/${Math.round(W_VAL * 100)}/${Math.round(W_TECH * 100)}).`
    );
  }
  if (scoreObj?.passReasons?.length) parts.push(`Strengths: ${scoreObj.passReasons.slice(0, 4).join('; ')}.`);
  if (scoreObj?.failReasons?.length) parts.push(`Risks: ${scoreObj.failReasons.slice(0, 3).join('; ')}.`);
  if (extras.roe != null) parts.push(`ROE ~${Number(extras.roe).toFixed(1)}%.`);
  if (extras.pe != null) parts.push(`PE ~${Number(extras.pe).toFixed(1)}.`);
  if (r.tradePlan) {
    parts.push(`Entry timing (secondary): zone ₹${r.tradePlan.entryLow}–${r.tradePlan.entryHigh}, SL ₹${r.tradePlan.stopLoss}.`);
  }
  if (marketContext?.todayDirection) parts.push(`Market backdrop: ${marketContext.todayDirection}.`);
  parts.push('Multi-bag outcomes are rare and path-dependent — size for risk, not certainty.');
  return parts.join(' ');
}

async function enrichSymbol(symbol) {
  const out = {
    sector: null, pe: null, roe: null, roce: null, debtToEquity: null, companyName: null, news: [],
    revenueGrowth: null, earningsGrowth: null, revenueYoY: null, profitYoY: null,
    marketCap: null, institutionsPercent: null, insidersPercent: null,
    profitMargin: null, priceToBook: null, bookValue: null, source: null,
    peg: null, evEbitda: null, freeCashFlow: null, cfoVsPat: null,
    interestCoverage: null, promoterHolding: null, promoterPledge: null,
    revenueCagr3y: null, earningsCagr3y: null, fromCache: false, fetchedAt: null,
  };
  try {
    const f = await marketData.getFundamentals(symbol, { maxAgeDays: 14 });
    if (!f) return out;
    out.sector = f.sector || f.industry || null;
    out.pe = f.peTrailing ?? f.peForward ?? null;
    out.roe = f.roe != null ? (f.roe <= 1.5 ? f.roe * 100 : f.roe) : null;
    out.roce = f.roce != null ? (f.roce <= 1.5 ? f.roce * 100 : f.roce) : null;
    out.debtToEquity = f.debtToEquity ?? null;
    out.companyName = f.companyName || null;
    out.revenueGrowth = f.revenueGrowth;
    out.earningsGrowth = f.earningsGrowth;
    out.revenueYoY = f.revenueYoY ?? f.revenueGrowth;
    out.profitYoY = f.profitYoY ?? f.earningsGrowth;
    out.marketCap = f.marketCap;
    out.institutionsPercent = f.shareholding?.institutionsPercent ?? null;
    out.insidersPercent = f.shareholding?.insidersPercent ?? null;
    out.profitMargin = f.profitMargin ?? null;
    out.priceToBook = f.priceToBook ?? null;
    out.bookValue = f.bookValue ?? null;
    out.source = f.source || null;
    out.fromCache = !!f.fromCache;
    out.peg = f.peg ?? null;
    out.evEbitda = f.evEbitda ?? f.enterpriseToEbitda ?? null;
    out.freeCashFlow = f.freeCashFlow ?? null;
    out.cfoVsPat = f.cfoVsPat ?? null;
    out.interestCoverage = f.interestCoverage ?? null;
    out.promoterHolding = f.promoterHolding ?? f.shareholding?.insidersPercent ?? null;
    out.promoterPledge = f.promoterPledge ?? null;
    out.revenueCagr3y = f.revenueCagr3y ?? null;
    out.earningsCagr3y = f.earningsCagr3y ?? null;
  } catch (_) {}
  try {
    const news = await marketData.getNews(symbol);
    out.news = (news || []).slice(0, 3).map((n) => n.title).filter(Boolean);
  } catch (_) {}
  return out;
}

async function lightFundStillOk(pick) {
  try {
    const extras = await enrichSymbol(pick.symbol);
    const fund = scoreFundamentalQuality(extras);
    const growth = scoreBusinessGrowth(extras);
    const hardFail = (fund.reasons || []).some((x) => String(x).startsWith('FAIL'));
    const score = fund.score * 0.7 + growth.score * 0.3;
    return {
      ok: !hardFail && score >= 48,
      score,
      fund,
      growth,
      extras,
      reason: hardFail
        ? (fund.reasons.filter((x) => String(x).startsWith('FAIL')).join('; ') || 'Fund FAIL')
        : (score < 48 ? `Fund quality drifted (score ${score.toFixed(0)})` : null),
    };
  } catch (e) {
    return { ok: true, score: pick.convictionScore || 50, reason: null }; // network fail → don't drop
  }
}

async function runMultibaggerResearch({ force = false, jobId = null } = {}) {
  // Keep open list until fundamentals worsen meaningfully — not every click / every day
  if (!force && isMongoConfigured()) {
    try {
      const openPicks = await MultibaggerPick.find({ status: 'open' }).sort({ rank: 1 }).lean();
      if (openPicks.length) {
        let weak = 0;
        const checks = [];
        for (const p of openPicks) {
          const c = await lightFundStillOk(p);
          checks.push({ symbol: p.symbol, ...c });
          if (!c.ok) weak++;
          await new Promise((r) => setTimeout(r, 80));
        }
        // Only full rescan if majority deteriorated
        if (weak < Math.max(1, Math.ceil(openPicks.length * 0.5))) {
          console.log('[multibagger] reuse open list — fund still OK', openPicks.map((p) => p.symbol).join(','));
          return {
            ok: true,
            skipped: true,
            batchDate: openPicks[0].batchDate,
            count: openPicks.length,
            symbols: openPicks.map((p) => p.symbol),
            note: 'List same rakhi — company fundamentals abhi materially change nahi hue. Force = full rescan.',
            fromCache: true,
            fundChecks: checks.map((c) => ({ symbol: c.symbol, ok: c.ok, score: c.score })),
          };
        }
        console.log('[multibagger] fund drift on', weak, 'names — full rescan');
      }
    } catch (e) {
      console.warn('[multibagger] reuse check', e.message);
    }
  }

  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };
  const batchDate = todayYmd();

  // Always force a real scan when user triggers research (jobId present) so
  // progress is visible and we are not serving a silent 10-min cache hit.
  const forceRefresh = Boolean(jobId) || force;
  if (jobId) {
    startJob(jobId, 100, 'Starting multi-bagger deep research…');
    updateJob(jobId, 1, {
      phase: 'universe',
      message: 'Preparing full universe scan (Nifty50 + Midcap + Smallcap)…',
      log: 'Research started — will analyse each stock (not a cache shortcut)',
      detail: null,
      recent: [],
    });
  }

  const recentSymbols = [];
  const onProgress = (p) => {
    if (!jobId) return;
    const total = p.total || 1;
    const completed = p.completed || 0;
    // Universe phase = 0–70% of job
    const pct = p.phase === 'cache'
      ? 35
      : Math.min(70, Math.round((completed / total) * 70));
    if (p.justFinished) {
      recentSymbols.push(p.justFinished);
      if (recentSymbols.length > 12) recentSymbols.shift();
    }
    updateJob(jobId, pct, {
      phase: p.phase || 'universe',
      message: p.message || `Scanning… ${completed}/${total}`,
      detail: p.symbol || null,
      log: p.justFinished ? `✓ ${p.justFinished}` : (p.symbol ? `→ ${p.symbol}` : p.message),
      recent: [...recentSymbols],
      scanCompleted: completed,
      scanTotal: total,
    });
  };

  const { results, symbolToIndex, marketContext } = await getCombinedUniverseScan({
    forceRefresh,
    onProgress,
    concurrency: 4,
  });
  if (jobId) {
    updateJob(jobId, 72, {
      phase: 'filter',
      message: `Universe complete (${results.length} stocks). Applying multi-bagger filters…`,
      log: `Filter stage on ${results.length} results`,
      detail: null,
    });
  }
  const mctx = marketContext || (await getMarketTrend().catch(() => null));

    // 6+ MONTH multi-bagger: fundamentals primary. Technical / +5% / -2% / R:R are TIMING only (soft).
  const reject = { error: 0, price: 0, sell: 0, fundEmpty: 0, hardFund: 0 };
  const nearMissRaw = [];
  // Broad candidate pool — enrich top by raw technical rank then re-score with fundamentals
  const candidates = [];
  for (const r of results) {
    if (r.error) { reject.error++; continue; }
    if (!isAffordableRecommendPrice(r)) { reject.price++; continue; }
    const dec = String(r.decision || '').toUpperCase();
    if (dec.includes('SELL') || dec.includes('AVOID') || dec.includes('NO TRADE')) {
      reject.sell++;
      continue;
    }
    // Soft tech floor only (not primary gate)
    if ((r.score || 0) < MIN_TECH_SCORE) continue;
    candidates.push(r);
  }
  console.log('[multibagger] pre-enrich pool', {
    universe: results.length,
    candidates: candidates.length,
    reject,
  });
  let nearMisses = []; // filled after enrich


  // Score then take top pool for expensive enrich
  if (jobId) {
    updateJob(jobId, 50, {
      phase: 'filter',
      message: `${candidates.length} candidates in pre-enrich pool (fund scoring next)`,
      log: `Filter pass: ${candidates.length} candidates`,
    });
  }
  // Pre-rank without full fund (cheap); take more names for fund enrich (fund is primary)
  const pre = candidates.map((r) => ({
    r,
    indexLabel: symbolToIndex[r.symbol] || null,
    preScore: convictionNumber(multibaggerScore(r, mctx, { indexLabel: symbolToIndex[r.symbol] })),
  })).sort((a, b) => b.preScore - a.preScore).slice(0, 40);

  const enriched = [];
  for (let i = 0; i < pre.length; i++) {
    const item = pre[i];
    if (jobId) {
      updateJob(jobId, 55 + Math.round((i / Math.max(pre.length, 1)) * 35), {
        phase: 'enrich',
        message: `Deep dive ${i + 1}/${pre.length}: ${item.r.symbol} — fundamentals, news, sector…`,
        detail: item.r.symbol,
        log: `Enriching ${item.r.symbol}`,
      });
    }
    const extras = await enrichSymbol(item.r.symbol);
    const scoreObj = multibaggerScore(item.r, mctx, { ...extras, indexLabel: item.indexLabel });
    const convictionScore = convictionNumber(scoreObj);
    // Hard fund fails: extreme leverage + weak ROE
    const hardFundFail = (scoreObj.failReasons || []).some((x) => /high debt|ROE weak|cash conversion/i.test(x));
    if (hardFundFail && convictionScore < MIN_CONVICTION_SCORE) {
      nearMissRaw.push({
        symbol: item.r.symbol,
        price: item.r.price,
        score: item.r.score,
        convictionScore,
        pillars: scoreObj.pillars,
        reasons: scoreObj.failReasons.length ? scoreObj.failReasons : ['Below fund quality bar'],
        missCount: (scoreObj.failReasons || []).length || 1,
        closeness: convictionScore,
        confidence: scoreObj.confidence,
        missingData: scoreObj.missingData,
      });
      continue;
    }
    // Require some fund data for official pick
    if ((extras.roe == null && extras.pe == null && extras.revenueGrowth == null && extras.marketCap == null)) {
      reject.fundEmpty = (reject.fundEmpty || 0) + 1;
      nearMissRaw.push({
        symbol: item.r.symbol,
        price: item.r.price,
        score: item.r.score,
        convictionScore,
        reasons: ['Missing fundamentals data'],
        missCount: 1,
        closeness: convictionScore * 0.5,
        confidence: 'low',
        missingData: scoreObj.missingData,
      });
      continue;
    }
    enriched.push({ ...item, extras, convictionScore, scoreObj });
    await new Promise((res) => setTimeout(res, 200));
  }
  enriched.sort((a, b) => b.convictionScore - a.convictionScore);

  // Near-misses from enrich: high fund almost clear
  for (const e of enriched) {
    if (e.convictionScore >= MIN_CONVICTION_SCORE) continue;
    if (e.convictionScore >= MIN_CONVICTION_SCORE - 12) {
      nearMissRaw.push({
        symbol: e.r.symbol,
        price: e.r.price,
        score: e.r.score,
        convictionScore: e.convictionScore,
        pillars: e.scoreObj?.pillars,
        reasons: (e.scoreObj?.failReasons?.length
          ? e.scoreObj.failReasons
          : [`Conviction ${e.convictionScore} < min ${MIN_CONVICTION_SCORE}`]).concat(
          e.scoreObj?.missingData?.length ? [`Missing: ${e.scoreObj.missingData.join(', ')}`] : []
        ),
        missCount: 1,
        closeness: e.convictionScore,
        confidence: e.scoreObj?.confidence,
        missingData: e.scoreObj?.missingData,
      });
    }
  }
  nearMissRaw.sort((a, b) => (b.closeness || 0) - (a.closeness || 0));
  nearMisses = nearMissRaw.slice(0, 5);

  let qualityPool = enriched.filter((e) => e.convictionScore >= MIN_CONVICTION_SCORE);
  // Soft research shortlist only — labeled near-miss path if empty official
  if (!qualityPool.length && enriched.length) {
    console.log('[multibagger] no official clears; top research scores', enriched.slice(0, 5).map((e) => e.r.symbol + ':' + e.convictionScore));
  }
  const chosen = [];
  const sectorsUsed = new Map(); // sector -> count
  for (const e of qualityPool) {
    if (chosen.length >= TARGET_COUNT) break;
    const sec = (e.extras.sector || 'unknown').toLowerCase();
    const n = sectorsUsed.get(sec) || 0;
    // Allow up to 2 per sector so we don't hide strong names
    if (n >= 2 && qualityPool.length > chosen.length + 1) continue;
    chosen.push(e);
    sectorsUsed.set(sec, n + 1);
  }
  // If diversification skipped someone strong, fill remaining slots by score
  if (chosen.length < Math.min(TARGET_COUNT, qualityPool.length)) {
    for (const e of qualityPool) {
      if (chosen.length >= TARGET_COUNT) break;
      if (chosen.find((c) => c.r.symbol === e.r.symbol)) continue;
      chosen.push(e);
    }
  }

  if (!chosen.length) {
    if (jobId) endJob(jobId, `No multi-bagger picks; ${nearMisses.length} near-miss(es)`);
    const note = nearMisses.length
      ? `Full multi-bagger bar clear nahi hua. Neeche ${nearMisses.length} near-miss — almost clear, minor gate pe ruké. Fake pick nahi diya.`
      : 'No name cleared filters and no close near-miss. Market/setup weak for multi-bag bar today.';
    lastResearchMeta = { nearMisses, note, batchDate, filterReject: reject, count: 0 };
    return {
      ok: true,
      skipped: false,
      batchDate,
      count: 0,
      nearMisses,
      filterReject: reject,
      note,
    };
  }

  const newSymbols = new Set(chosen.slice(0, TARGET_COUNT).map((e) => e.r.symbol));
  // Retire previous open picks that no longer clear the bar
  const prevOpen = await MultibaggerPick.find({ status: 'open' }).lean();
  for (const prev of prevOpen) {
    if (newSymbols.has(prev.symbol)) continue;
    const check = await lightFundStillOk(prev);
    let action = 'HOLD';
    let guidance = 'List se hataya, lekin pehle wala thesis monitor karo; apna SL respect karo.';
    if (!check.ok) {
      action = 'EXIT bias';
      guidance = `Fundamentals weak/drift: ${check.reason || 'quality drop'}. Fresh multi-bag case nahi — size kam / exit socho.`;
    } else {
      guidance = 'Fund abhi bhi theek, lekin is batch me better names aa gaye / rank bahar. Zaruri nahi exit — thesis + SL se manage.';
    }
    await MultibaggerPick.updateOne(
      { _id: prev._id },
      {
        $set: {
          status: 'removed',
          removedDate: batchDate,
          removalReason: check.reason || 'No longer in top multi-bagger set (fund/growth/valuation rank)',
          actionGuidance: `${action}: ${guidance}`,
        },
      }
    );
  }

  await MultibaggerPick.deleteMany({ batchDate, status: { $ne: 'removed' } });
  const docs = chosen.slice(0, TARGET_COUNT).map((e, i) => {
    const r = e.r;
    const p = r.moveProbability || {};
    let plan = r.tradePlan || {};
    const px = r.price;
    // Long-term: if scan had no trade plan, synthesize conservative zone from price
    if ((!plan.entryLow || !plan.stopLoss) && px != null) {
      plan = {
        entryLow: Number((px * 0.97).toFixed(2)),
        entryHigh: Number((px * 1.02).toFixed(2)),
        stopLoss: Number((px * 0.88).toFixed(2)), // ~12% thesis risk band
        target: Number((px * 1.25).toFixed(2)),   // ~25% intermediate
        riskRewardRatio: px > 0 ? Number((((px * 1.25) - px) / (px - px * 0.88)).toFixed(2)) : null,
        ...plan,
      };
    }
    const t1 = plan.target != null ? plan.target : (px != null ? Number((px * 1.25).toFixed(2)) : null);
    const t2 = px != null ? Number((px * 1.6).toFixed(2)) : null; // stretch ~60% over 6m+ path — not a promise

    const so = e.scoreObj || {};
    const thesis = buildThesis(r, e.extras, mctx, so);
    return {
      batchDate,
      horizonDays: HORIZON_DAYS, // 6+ month research horizon
      rank: i + 1,
      symbol: r.symbol,
      indexLabel: e.indexLabel,
      companyName: e.extras.companyName,
      sector: e.extras.sector,
      priceAtResearch: r.price,
      entryLow: plan.entryLow,
      entryHigh: plan.entryHigh,
      stopLoss: plan.stopLoss,
      target1: t1,
      target2: t2,
      riskRewardRatio: plan.riskRewardRatio,
      convictionScore: Number(e.convictionScore.toFixed(1)),
      technicalScore: r.score,
      lossProbability2Pct: p.probabilityDown2PctPlus,
      profitProbability5Pct: p.probabilityUp5PctPlus,
      profitProbability1Pct: p.probabilityUp1PctPlus,
      probabilitySampleSize: p.sampleSize,
      thesis,
      bullCase: `Fund/growth case: if ROE/growth trajectory holds and valuation does not over-extend, path over ~${HORIZON_DAYS}d can compound. Timing zone ₹${plan.entryLow ?? '—'}–${plan.entryHigh ?? '—'}.`,
      bearCase: `Fails on fund deterioration (margins/debt), governance shock, or sustained sector derating. Near-term noise is secondary.`,
      invalidation: plan.stopLoss != null
        ? `Thesis break on results/debt/governance; timing invalidation below ₹${plan.stopLoss}.`
        : 'Invalidate on fund thesis break — size only with defined risk.',
      topFactors: (r.topFactors || []).slice(0, 8).map((f) => ({ factor: f.factor, signal: f.signal })),
      fundamentalsSnapshot: {
        pe: e.extras.pe,
        roe: e.extras.roe,
        roce: e.extras.roce,
        debtToEquity: e.extras.debtToEquity,
        profitMargin: e.extras.profitMargin,
        revenueGrowth: e.extras.revenueGrowth,
        earningsGrowth: e.extras.earningsGrowth,
        priceToBook: e.extras.priceToBook,
        sector: e.extras.sector,
        source: e.extras.source,
      },
      scorePillars: so.pillars || null,
      scoreWeights: so.weights || null,
      passReasons: so.passReasons || [],
      failReasons: so.failReasons || [],
      timingNotes: so.timingNotes || [],
      missingData: so.missingData || [],
      confidence: so.confidence || 'medium',
      fundScoreAtPick: so.pillars?.fundamentalQuality ?? null,
      dataFreshness: so.dataFreshness || null,
      notAGuarantee: true,
      marketBackdrop: mctx?.todayDirection || mctx?.direction || null,
      newsHeadlines: e.extras.news || [],
      latestPrice: r.price,
      latestPriceDate: batchDate,
      changePct: 0,
      status: 'open',
    };
  });
  await MultibaggerPick.insertMany(docs);
  if (jobId) {
    endJob(jobId, `Saved ${docs.length} multi-bagger pick(s): ${docs.map((d) => d.symbol).join(', ') || 'none'}`);
  }
  const nm = nearMisses.filter((n) => !docs.some((d) => d.symbol === n.symbol)).slice(0, 5);
  lastResearchMeta = { nearMisses: nm, note: null, batchDate, filterReject: reject, count: docs.length };
  return {
    ok: true,
    skipped: false,
    batchDate,
    count: docs.length,
    symbols: docs.map((d) => d.symbol),
    nearMisses: nm,
  };
}

async function updateMultibaggerPrices() {
  if (!isMongoConfigured()) return { ok: false };
  const open = await MultibaggerPick.find({ status: 'open' }).limit(20);
  let updated = 0;
  const today = todayYmd();
  for (const doc of open) {
    try {
      const q = await marketData.getQuote(doc.symbol);
      const price = q.lastPrice;
      if (price == null) continue;
      const changePct = ((price - doc.priceAtResearch) / doc.priceAtResearch) * 100;
      let status = 'open';
      if (doc.target2 && price >= doc.target2) status = 'hit_t2';
      else if (doc.target1 && price >= doc.target1) status = 'hit_t1';
      else if (doc.stopLoss && price <= doc.stopLoss) status = 'stopped';
      await MultibaggerPick.updateOne({ _id: doc._id }, {
        $set: { latestPrice: price, latestPriceDate: today, changePct, status },
      });
      updated++;
    } catch (_) {}
  }
  return { ok: true, updated };
}

async function getLatestBatch() {
  const open = await MultibaggerPick.find({ status: 'open' }).sort({ rank: 1, batchDate: -1 }).lean();
  // dedupe by symbol keep best rank / newest
  const seen = new Set();
  const picks = [];
  for (const p of open) {
    if (seen.has(p.symbol)) continue;
    seen.add(p.symbol);
    picks.push(p);
  }
  const removed = await MultibaggerPick.find({ status: 'removed' })
    .sort({ removedDate: -1, updated_at: -1 })
    .limit(15)
    .lean();
  const batchDate = picks[0]?.batchDate || removed[0]?.batchDate || null;
  return {
    batchDate,
    picks,
    removed: removed.map((r) => ({
      symbol: r.symbol,
      companyName: r.companyName,
      sector: r.sector,
      removedDate: r.removedDate,
      removalReason: r.removalReason,
      actionGuidance: r.actionGuidance,
      priceAtResearch: r.priceAtResearch,
      latestPrice: r.latestPrice,
      changePct: r.changePct,
      convictionScore: r.convictionScore,
      batchDate: r.batchDate,
    })),
  };
}

function getLastMultibaggerMeta() {
  return lastResearchMeta;
}

module.exports = {
  runMultibaggerResearch,
  getLastMultibaggerMeta,
  updateMultibaggerPrices,
  getLatestBatch,
  TARGET_COUNT,
};
