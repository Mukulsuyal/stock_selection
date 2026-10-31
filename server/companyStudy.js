/**
 * Company Study — structured dossier for Groww-style overview UI.
 * Real data only. Missing fields stay null / N/A.
 */
const marketData = require('./marketData');
const { analyze } = require('./indicators');
const { getShareholding } = require('./shareholdingFetch');

function num(v, d = 2) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(Number(v).toFixed(d));
}
function pctFromFrac(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const x = Number(v);
  return Math.abs(x) <= 5 ? num(x * 100, 1) : num(x, 1);
}
function crore(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return num(Number(v) / 1e7, 0);
}
function inr(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return num(v, 2);
}

function rangePos(price, low, high) {
  if (price == null || low == null || high == null || high <= low) return null;
  return Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100));
}

function pivotLevels(candles) {
  if (!candles || candles.length < 3) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const h = prev.high ?? prev.h;
  const l = prev.low ?? prev.l;
  const c = prev.close ?? prev.c;
  if (h == null || l == null || c == null) return null;
  const p = (h + l + c) / 3;
  const r1 = 2 * p - l;
  const s1 = 2 * p - h;
  const r2 = p + (h - l);
  const s2 = p - (h - l);
  const r3 = h + 2 * (p - l);
  const s3 = l - 2 * (h - p);
  return {
    pivot: num(p, 2),
    r1: num(r1, 2), r2: num(r2, 2), r3: num(r3, 2),
    s1: num(s1, 2), s2: num(s2, 2), s3: num(s3, 2),
    price: num(last.close ?? last.c, 2),
  };
}

function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return num(slice.reduce((a, b) => a + b, 0) / period, 2);
}

function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return num(e, 2);
}

async function buildCompanyStudy(symbol) {
  const sym = String(symbol || '').toUpperCase().replace(/\.(NS|BO)$/i, '');
  let fundamentals = null;
  let quote = null;
  let candles = [];

  try {
    // Prefer fresher merge for study page (fill N/A from Groww/Yahoo)
    fundamentals = await marketData.getFundamentals(sym, { maxAgeDays: 3, forceRefresh: false });
  } catch (_) {}
  // If still thin on key ratios, force one network pass (ignore window once)
  try {
    const thin = !fundamentals || (
      fundamentals.debtToEquity == null &&
      fundamentals.profitMargin == null &&
      fundamentals.beta == null &&
      fundamentals.faceValue == null
    );
    if (thin) {
      fundamentals = await marketData.getFundamentals(sym, {
        maxAgeDays: 0,
        forceRefresh: true,
        ignoreWindow: true,
      });
    }
  } catch (_) {}
  try {
    quote = await marketData.getQuote(sym);
  } catch (_) {}
  try {
    candles = await marketData.getHistorical(sym, 2000);
  } catch (_) {
    try {
      const qh = await marketData.getQuoteAndHistory(sym, 800);
      candles = qh.candles || [];
      if (!quote && qh.quote) quote = qh.quote;
    } catch (_) {}
  }

  const f = fundamentals || {};
  // Groww shareholding (exact Groww app numbers + quarter history)
  let shExtra = null;
  try {
    shExtra = await getShareholding(sym);
  } catch (_) {}
  const price = quote?.lastPrice ?? quote?.price ?? null;
  const changePct = quote?.pChange ?? quote?.changePct ?? null;
  let dayHigh = quote?.dayHigh ?? quote?.high ?? null;
  let dayLow = quote?.dayLow ?? quote?.low ?? null;
  let open = quote?.open ?? null;
  let prevClose = quote?.previousClose ?? quote?.prevClose ?? null;
  let volume = quote?.volume ?? null;
  // Candle fallback when quote thin
  if (candles?.length) {
    const last = candles[candles.length - 1];
    const prev = candles.length > 1 ? candles[candles.length - 2] : null;
    if (dayHigh == null) dayHigh = last.high ?? last.h ?? null;
    if (dayLow == null) dayLow = last.low ?? last.l ?? null;
    if (open == null) open = last.open ?? last.o ?? null;
    if (prevClose == null && prev) prevClose = prev.close ?? prev.c ?? null;
    if (volume == null) volume = last.volume ?? last.v ?? null;
  }

  let allTimeHigh = null;
  let allTimeLow = null;
  let allTimeHighDate = null;
  let allTimeLowDate = null;
  const closes = [];
  if (candles?.length) {
    for (const c of candles) {
      const h = c.high ?? c.h;
      const l = c.low ?? c.l;
      const cl = c.close ?? c.c;
      const dt = c.date || c.datetime || c.t || null;
      let dateStr = null;
      if (dt != null) {
        const d = typeof dt === 'number' ? new Date(dt > 1e12 ? dt : dt * 1000) : new Date(dt);
        if (!Number.isNaN(d.getTime())) dateStr = d.toISOString().slice(0, 10);
      }
      if (h != null) {
        if (allTimeHigh == null || h > allTimeHigh) {
          allTimeHigh = h;
          allTimeHighDate = dateStr;
        }
      }
      if (l != null && l > 0) {
        if (allTimeLow == null || l < allTimeLow) {
          allTimeLow = l;
          allTimeLowDate = dateStr;
        }
      }
      if (cl != null) closes.push(cl);
    }
  }

  const week52High = f.week52High ?? quote?.weekHigh52 ?? null;
  const week52Low = f.week52Low ?? quote?.weekLow52 ?? null;

  // Quarterly chart points (revenue / profit in Cr)
  function formatQuarterLabel(q) {
    const raw = q.endDate || q.period || q.date || q.asOfDate || q.label || '';
    if (!raw) return { short: '—', full: 'Date N/A' };
    const s = String(raw).trim();
    // ISO yyyy-mm-dd
    let d = new Date(s);
    if (Number.isNaN(d.getTime()) && /^\d{4}-\d{2}/.test(s)) {
      d = new Date(s.slice(0, 7) + '-01');
    }
    // Unix seconds
    if (Number.isNaN(d.getTime()) && /^\d{10}$/.test(s)) {
      d = new Date(Number(s) * 1000);
    }
    if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990) {
      const mon = d.toLocaleString('en-US', { month: 'short' });
      const yy = String(d.getFullYear()).slice(-2);
      const full = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      return { short: `${mon} '${yy}`, full: `Quarter ending ${full}` };
    }
    // Fallback: trim long strings
    return { short: s.slice(0, 8), full: s };
  }

  const quarterlyRaw = Array.isArray(f.quarterly) ? f.quarterly.slice(0, 8) : [];
  // Yahoo returns newest first — keep chronological left→right for chart
  const quarterlyOrdered = [...quarterlyRaw].reverse();
  const quarterly = quarterlyOrdered.map((q) => {
    const rev = q.totalRevenue ?? q.revenue ?? q.sales ?? null;
    const ni = q.netIncome ?? q.profit ?? null;
    const lab = formatQuarterLabel(q);
    return {
      label: lab.short,
      labelFull: lab.full,
      revenueCr: rev != null ? crore(rev) : null,
      profitCr: ni != null ? crore(ni) : null,
      raw: q.endDate || q.period || q.date || null,
    };
  });

  // Shareholding — Groww first (exact), Yahoo fallback
  const sh = f.shareholding || {};
  let promoterPct = null;
  let fiiPct = null;
  let diiPct = null;
  let publicPct = null;
  let shSource = null;
  let shAsOf = null;
  let shQuarters = [];
  if (shExtra && (shExtra.fiiPct != null || shExtra.diiPct != null || shExtra.publicPct != null)) {
    promoterPct = shExtra.promoterPct != null ? num(shExtra.promoterPct, 2) : 0;
    fiiPct = shExtra.fiiPct != null ? num(shExtra.fiiPct, 2) : null;
    diiPct = shExtra.diiPct != null ? num(shExtra.diiPct, 2) : null;
    publicPct = shExtra.publicPct != null ? num(shExtra.publicPct, 2) : null;
    shSource = shExtra.source || 'groww';
    shAsOf = shExtra.asOf || null;
    shQuarters = shExtra.quarters || [];
  } else {
    promoterPct = pctFromFrac(sh.insidersPercent);
    const instPct = pctFromFrac(sh.institutionsPercent);
    if (promoterPct != null && instPct != null) {
      publicPct = num(Math.max(0, 100 - promoterPct - instPct), 2);
    }
    shSource = promoterPct != null ? 'yahoo' : null;
  }
  function barsFrom(p, fii, dii, pub) {
    return [
      { key: 'Promoters', pct: p, color: '#a78bfa' },
      { key: 'DII', pct: dii, color: '#84cc16' },
      { key: 'FII', pct: fii, color: '#38bdf8' },
      { key: 'Public', pct: pub, color: '#f59e0b' },
    ].filter((x) => x.pct != null);
  }
  const shareholdingBars = barsFrom(promoterPct, fiiPct, diiPct, publicPct);
  const shareholdingMeta = { source: shSource, asOf: shAsOf, quarters: shQuarters };

  const fundHolders = (f.fundHolders || []).slice(0, 6).map((h) => ({
    name: h.organization || '—',
    pct: pctFromFrac(h.pctHeld),
  }));
  const institutionHolders = (f.institutionHolders || []).slice(0, 6).map((h) => ({
    name: h.organization || '—',
    pct: pctFromFrac(h.pctHeld),
  }));

  // Technicals from indicators engine when candles exist
  let technicals = null;
  try {
    if (candles.length >= 50) {
      const analysis = analyze(candles, quote || {});
      const ind = analysis.indicators || {};
      const sr = analysis.supportResistance || {};
      const supArr = Array.isArray(sr.support) ? sr.support : [];
      const resArr = Array.isArray(sr.resistance) ? sr.resistance : [];
      const supLevel = supArr[0]?.level ?? (typeof sr.support === 'number' ? sr.support : null);
      const resLevel = resArr[0]?.level ?? (typeof sr.resistance === 'number' ? sr.resistance : null);
      const macdVal = ind.macdHistogram ?? ind.macd ?? null;
      technicals = {
        verdict: analysis.verdict || null,
        score: analysis.score ?? null,
        rsi14: ind.rsi14 != null ? num(ind.rsi14, 1) : null,
        macd: macdVal != null && typeof macdVal !== 'object' ? num(macdVal, 2) : null,
        beta: f.beta != null ? num(f.beta, 2) : null,
        support: supLevel != null ? num(supLevel, 2) : null,
        resistance: resLevel != null ? num(resLevel, 2) : null,
        supportLevels: supArr.slice(0, 3).map((x) => num(x.level, 2)).filter((x) => x != null),
        resistanceLevels: resArr.slice(0, 3).map((x) => num(x.level, 2)).filter((x) => x != null),
      };
    }
  } catch (_) {}

  const pivots = pivotLevels(candles);
  const movingAverages = {
    sma10: sma(closes, 10),
    ema10: ema(closes, 10),
    sma20: sma(closes, 20),
    ema20: ema(closes, 20),
    sma50: sma(closes, 50),
    ema50: ema(closes, 50),
    sma100: sma(closes, 100),
    ema100: ema(closes, 100),
    sma200: sma(closes, 200),
    ema200: ema(closes, 200),
  };

  const overview = {
    symbol: sym,
    companyName: f.companyName || quote?.companyName || null,
    sector: f.sector || null,
    industry: f.industry || null,
    price: inr(price),
    changePct: num(changePct, 2),
    dayHigh: inr(dayHigh),
    dayLow: inr(dayLow),
    dayPos: rangePos(price, dayLow, dayHigh),
    week52High: inr(week52High),
    week52Low: inr(week52Low),
    week52Pos: rangePos(price, week52Low, week52High),
    open: inr(open),
    previousClose: inr(prevClose),
    volume,
    allTimeHigh: inr(allTimeHigh),
    allTimeLow: inr(allTimeLow),
    allTimeHighDate,
    allTimeLowDate,
    website: f.website || null,
    country: f.country || null,
    city: f.city || null,
    employees: f.employees ?? null,
  };

  const faceValue = f.faceValue != null ? num(f.faceValue, 2) : null;
  const bookValue = f.bookValue != null ? num(f.bookValue, 2) : null;
  // Industry PE rarely in free Yahoo — leave null unless present
  const industryPE = f.industryPE != null ? num(f.industryPE, 2) : (f.industryPe != null ? num(f.industryPe, 2) : null);

  const fundamentalsGrid = [
    { label: 'Market Cap', value: crore(f.marketCap) != null ? `₹${Number(crore(f.marketCap)).toLocaleString('en-IN')}Cr` : null },
    { label: 'ROE', value: pctFromFrac(f.roe) != null ? `${pctFromFrac(f.roe)}%` : null },
    { label: 'P/E Ratio (TTM)', value: num(f.peTrailing, 2) },
    { label: 'EPS (TTM)', value: f.eps != null ? num(f.eps, 2) : null },
    { label: 'P/B Ratio', value: num(f.priceToBook, 2) },
    { label: 'Dividend Yield', value: pctFromFrac(f.dividendYield) != null ? `${pctFromFrac(f.dividendYield)}%` : null },
    { label: 'Industry P/E', value: industryPE },
    { label: 'Book Value', value: bookValue },
    { label: 'Face Value', value: faceValue },
    { label: 'Debt to Equity', value: f.debtToEquity != null ? num(f.debtToEquity, 2) : null },
    { label: 'Profit Margin', value: pctFromFrac(f.profitMargin) != null ? `${pctFromFrac(f.profitMargin)}%` : null },
    { label: 'Current Ratio', value: num(f.currentRatio, 2) },
    { label: 'Beta', value: num(f.beta, 2) },
    { label: 'Forward P/E', value: num(f.peForward, 2) },
  ];

  const growth = {
    revenueYoY: pctFromFrac(f.revenueYoY ?? f.revenueGrowth),
    profitYoY: pctFromFrac(f.profitYoY ?? f.earningsGrowth),
    revenueQoQ: pctFromFrac(f.revenueQoQ),
    profitQoQ: pctFromFrac(f.profitQoQ),
  };

  const about = {
    summary: f.businessSummary || null,
    sector: f.sector || null,
    industry: f.industry || null,
    nseSymbol: sym,
    founded: null, // not reliably in free feed
    ceo: null,
  };

  // Simple valuation read (not advice) — PE vs growth, PB, vs industry when available
  function buildValuationVerdict() {
    const pe = f.peTrailing != null ? Number(f.peTrailing) : null;
    const pb = f.priceToBook != null ? Number(f.priceToBook) : null;
    const roe = pctFromFrac(f.roe);
    const revG = pctFromFrac(f.revenueGrowth ?? f.revenueYoY);
    const earnG = pctFromFrac(f.earningsGrowth ?? f.profitYoY);
    const indPE = industryPE;
    const peg = (pe != null && earnG != null && earnG > 0) ? num(pe / earnG, 2) : null;

    let tone = 'mixed'; // cheap | fair | expensive | stretched | mixed
    const bullets = [];
    let title = 'Valuation check';

    if (pe == null && pb == null) {
      return {
        tone: 'unknown',
        title: 'Valuation — data thin',
        headline: 'Abhi PE / PB clear nahi — is stock pe valuation call weak hai.',
        bullets: ['Fundamentals cache / API se PE ya P/B nahi mila.', 'Results ke baad numbers refresh ho sakte hain.'],
        metrics: { pe, pb, industryPE: indPE, peg, roe, revenueGrowth: revG, earningsGrowth: earnG },
      };
    }

    if (pe != null) {
      if (pe < 12) { bullets.push(`P/E ~${num(pe,1)} — earnings ke hisaab se relatively sasta side.`); tone = 'cheap'; }
      else if (pe < 22) { bullets.push(`P/E ~${num(pe,1)} — mid / fair zone (sector se compare zaroori).`); tone = 'fair'; }
      else if (pe < 40) { bullets.push(`P/E ~${num(pe,1)} — thoda mehnga; growth already price me ho sakti hai.`); tone = 'expensive'; }
      else { bullets.push(`P/E ~${num(pe,1)} — kaafi mehnga / stretched valuation.`); tone = 'stretched'; }
    }
    if (indPE != null && pe != null) {
      const diff = ((pe - indPE) / indPE) * 100;
      if (diff < -15) bullets.push(`Industry P/E ~${indPE} se ~${num(diff,0)}% sasta — sector peers se discount.`);
      else if (diff > 15) bullets.push(`Industry P/E ~${indPE} se ~${num(diff,0)}% mehnga — premium de rahe ho.`);
      else bullets.push(`Industry P/E ~${indPE} ke aas-paas — sector average jaisa.`);
    } else if (pe != null) {
      bullets.push('Industry P/E free feed me nahi mila — sirf stock ke apne PE pe lean karo.');
    }
    if (pb != null) {
      if (pb < 1.5) bullets.push(`P/B ~${num(pb,2)} — book value ke kareeb / neeche (banking/finance me alag context).`);
      else if (pb > 6) bullets.push(`P/B ~${num(pb,2)} — book se kaafi upar; growth story price me baked.`);
      else bullets.push(`P/B ~${num(pb,2)}.`);
    }
    if (bookValue != null) bullets.push(`Book value ~₹${bookValue}${faceValue != null ? ` · Face value ₹${faceValue}` : ''}.`);
    if (roe != null) {
      if (roe >= 15 && tone === 'expensive') bullets.push(`ROE ~${roe}% strong hai — mehnga PE kabhi-kabhi quality ke liye justify hota hai.`);
      else if (roe < 8 && (tone === 'expensive' || tone === 'stretched')) bullets.push(`ROE ~${roe}% weak + mehnga PE — valuation bekar side lag sakti hai.`);
      else if (roe >= 15) bullets.push(`ROE ~${roe}% — capital pe return healthy.`);
    }
    if (earnG != null) {
      if (earnG >= 20 && pe != null && pe < 35) bullets.push(`Earnings growth ~${earnG}% + PE manageable — growth-supported valuation.`);
      else if (earnG < 5 && pe != null && pe > 30) bullets.push(`Growth slow (~${earnG}%) lekin PE high — risk zyada.`);
    }
    if (peg != null) {
      if (peg < 1) bullets.push(`PEG ~${peg} (<1) — growth ke hisaab se PE attractive lag sakta hai.`);
      else if (peg > 2) bullets.push(`PEG ~${peg} (>2) — growth ke hisaab se mehnga.`);
      else bullets.push(`PEG ~${peg}.`);
    }

    if (tone === 'cheap') {
      title = 'Valuation — relatively attractive';
      headline = 'Numbers ke hisaab se abhi valuation sasti / fair-discount side dikh rahi hai (sector + risks alag check).';
    } else if (tone === 'fair') {
      title = 'Valuation — fair zone';
      headline = 'Na bahut sasta, na extreme mehnga — industry + growth dekh ke decide karo.';
    } else if (tone === 'expensive') {
      title = 'Valuation — on the higher side';
      headline = 'Price me growth already kaafi factor ho sakti hai — entry careful.';
    } else if (tone === 'stretched') {
      title = 'Valuation — stretched';
      headline = 'Fundamentals ke hisaab se stock mehnga lag raha hai — sirf momentum pe mat lean karo.';
    } else {
      title = 'Valuation — mixed';
      headline = 'Kuch metrics soft, kuch tight — pure PE se faisla mat lo.';
    }

    return {
      tone,
      title,
      headline,
      bullets,
      metrics: { pe: num(pe, 2), pb: num(pb, 2), industryPE: indPE, peg, roe, revenueGrowth: revG, earningsGrowth: earnG, bookValue, faceValue },
    };
  }

  const valuationVerdict = buildValuationVerdict();

  return {
    overview,
    valuationVerdict,
    fundamentalsGrid,
    growth,
    quarterly,
    shareholdingBars,
    shareholdingMeta,
    fundHolders,
    institutionHolders,
    about,
    technicals,
    pivots,
    movingAverages,
    source: f.source || quote?.source || null,
    dataNote: f.dataNote || null,
    honesty: [
      'Layout Groww-style overview jaisa hai; numbers free public data se aate hain.',
      'Shareholding kabhi-kabhi partial hota hai (Promoter/Institutions). DII/FII split NSE filing jaisa detailed nahi ho sakta.',
      'Delivery % / circuit limits free feed me always nahi milte — N/A reh sakta hai.',
      'Order book ladder free me nahi.',
    ],
    asOf: new Date().toISOString(),
  };
}

module.exports = { buildCompanyStudy };
