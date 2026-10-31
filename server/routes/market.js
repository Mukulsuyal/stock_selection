const express = require('express');
const router = express.Router();
const { getMarketRegime } = require('../marketRegimeDetector');
const { getCombinedUniverseScan } = require('../universeScan');
const fundStore = require('../fundamentalsStore');
const { computeSectorRotation } = require('../sectorRotation');
const { computeTrackedUniverseBreadth } = require('../marketBreadth');
const { getSectorMap } = require('../institutional/sectorSync');
const { getIndianIndices, getGlobalIndices, getCommodities } = require('../marketIndices');
const { buildNiftyDeepDive, INDEX_CHART_PRESETS } = require('../niftyDeepDive');
const { buildMarketPlaybook } = require('../marketPlaybook');
const { buildSystemHealth } = require('../systemHealth');

router.get('/regime', async (req, res) => {
  try {
    if (String(req.query.fresh || '') === '1') {
      try { require('../marketRegimeDetector').clearMarketRegimeCache(); } catch (_) {}
    }
    const regime = await getMarketRegime();
    res.json({ regime });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not load market regime right now' });
  }
});

router.get('/sectors', async (req, res) => {
  try {
    const [{ results, marketContext, scannedAt }, sectorMap] = await Promise.all([
      getCombinedUniverseScan(),
      getSectorMap(),
    ]);
    if (!Object.keys(sectorMap).length) {
      return res.json({ sectors: [], scannedAt, note: 'Sector data not synced yet.' });
    }
    const sectors = computeSectorRotation(results, sectorMap, marketContext?.periodReturns);
    res.json({ sectors, scannedAt });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not compute sector rotation right now.' });
  }
});

router.get('/breadth', async (req, res) => {
  try {
    const { results, scannedAt } = await getCombinedUniverseScan();
    const breadth = computeTrackedUniverseBreadth(results);
    res.json({ breadth, scannedAt });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not compute market breadth right now.' });
  }
});

router.get('/indices', async (req, res) => {
  try {
    const [indian, global] = await Promise.all([getIndianIndices(), getGlobalIndices()]);
    res.json({ indian, global, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not load indices right now.' });
  }
});

router.get('/commodities', async (req, res) => {
  try {
    const commodities = await getCommodities();
    res.json({ commodities, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not load commodities right now.' });
  }
});

// Index Chart Reader — Nifty / Sensex / Midcap / Smallcap, long history analogs
router.get('/nifty-deep-dive', async (req, res) => {
  try {
    const key = (req.query.index || req.query.symbol || 'nifty50').toString();
    const data = await buildNiftyDeepDive(key);
    res.json(data);
  } catch (err) {
    console.error('[nifty-deep-dive]', err.message);
    res.status(502).json({ error: err.message || 'Could not build index chart reader' });
  }
});

router.get('/chart-reader/presets', (_req, res) => {
  res.json({ presets: INDEX_CHART_PRESETS });
});

router.get('/playbook', async (req, res) => {
  try {
    const [deepDive, regime] = await Promise.all([
      buildNiftyDeepDive('nifty50').catch(() => null),
      getMarketRegime().catch(() => null),
    ]);
    const playbook = buildMarketPlaybook(deepDive, regime);
    res.json({
      playbook,
      deepDive: deepDive
        ? {
            price: deepDive.price,
            dayPct: deepDive.dayPct,
            todayMove: deepDive.todayMove,
            supportLevels: (deepDive.supportLevels || []).slice(0, 4),
            scenarios: deepDive.scenarios,
            context: deepDive.context,
          }
        : null,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[market-playbook]', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.get('/under-200', async (req, res) => {
  try {
    const maxP = Math.min(500, Math.max(50, Number(req.query.maxPrice) || 200));
    const { results, symbolToIndex, scannedAt, marketContext } = await getCombinedUniverseScan();
    const cheap = (results || []).filter(
      (r) => r && r.price != null && Number.isFinite(r.price) && r.price > 0 && r.price < maxP
    );

    // Optional market-level FII/DII (not stock-specific) for context only
    let marketFii = null;
    try {
      if (require('../mongo').isMongoConfigured()) {
        const Fii = require('../institutional/models/FiiDiiFlow');
        const row = await Fii.findOne({}).sort({ date: -1 }).lean();
        if (row) {
          const fiiNet = row.fiiNet ?? row.fii_net ?? row.netFii ?? null;
          const diiNet = row.diiNet ?? row.dii_net ?? row.netDii ?? null;
          marketFii = {
            date: row.date,
            fiiNet,
            diiNet,
            fiiIncreasing: fiiNet != null ? fiiNet > 0 : null,
            diiIncreasing: diiNet != null ? diiNet > 0 : null,
          };
        }
      }
    } catch (_) {}

    function normRoe(v) {
      if (v == null || !Number.isFinite(Number(v))) return null;
      let x = Number(v);
      if (Math.abs(x) <= 1.5) x *= 100;
      return x;
    }

    function scoreFundamental(f) {
      if (!f) return { score: null, detail: 'No fund data', points: [] };
      let s = 45;
      const points = [];
      const roe = normRoe(f.roe);
      const roce = normRoe(f.roce);
      const pe = f.peTrailing ?? f.pe ?? f.trailingPE;
      const de = f.debtToEquity;
      const peg = f.pegRatio ?? f.peg;
      if (roe != null) {
        if (roe >= 18) { s += 18; points.push(`ROE ${roe.toFixed(1)}% strong`); }
        else if (roe >= 12) { s += 12; points.push(`ROE ${roe.toFixed(1)}%`); }
        else if (roe >= 8) { s += 5; points.push(`ROE ${roe.toFixed(1)}% ok`); }
        else { s -= 12; points.push(`ROE ${roe.toFixed(1)}% weak`); }
      }
      if (roce != null) {
        if (roce >= 15) { s += 10; points.push(`ROCE ${roce.toFixed(1)}%`); }
        else if (roce < 8) { s -= 6; points.push('ROCE weak'); }
      }
      if (de != null) {
        if (de <= 0.5) { s += 10; points.push('Low debt'); }
        else if (de <= 1) { s += 4; points.push('Debt ok'); }
        else if (de > 2) { s -= 14; points.push('High debt'); }
      }
      if (pe != null && pe > 0) {
        if (pe < 15) { s += 8; points.push(`PE ${Number(pe).toFixed(1)}`); }
        else if (pe < 25) { s += 3; points.push(`PE ${Number(pe).toFixed(1)}`); }
        else if (pe > 50) { s -= 8; points.push(`PE rich ${Number(pe).toFixed(0)}`); }
      }
      if (peg != null && peg > 0 && peg < 1) { s += 6; points.push('PEG < 1'); }
      s = Math.max(0, Math.min(100, s));
      return { score: Math.round(s), detail: points.slice(0, 4).join(' · ') || 'Mixed', points };
    }

    function scoreBusiness(f, r) {
      // Futuristic / growth proxy from available fields
      if (!f && !r) return { score: null, detail: 'No growth data', points: [] };
      let s = 40;
      const points = [];
      const revG = f?.revenueGrowth ?? f?.salesGrowth ?? f?.revenueGrowthYoY;
      const earnG = f?.earningsGrowth ?? f?.profitGrowth ?? f?.earningsGrowthYoY;
      const sector = (f?.sector || r?.sector || '').toLowerCase();
      const futureSectors = /it|software|pharma|defence|defense|renew|power|chemical|auto|electronic|semi|data|telecom|infra|capital goods|engineering/;
      if (revG != null) {
        const g = Number(revG) <= 1.5 && Number(revG) >= -1.5 ? Number(revG) * 100 : Number(revG);
        if (g >= 20) { s += 20; points.push(`Rev growth ~${g.toFixed(0)}%`); }
        else if (g >= 10) { s += 12; points.push(`Rev growth ~${g.toFixed(0)}%`); }
        else if (g >= 0) { s += 4; points.push('Rev flat/up'); }
        else { s -= 10; points.push('Rev declining'); }
      }
      if (earnG != null) {
        const g = Number(earnG) <= 1.5 && Number(earnG) >= -1.5 ? Number(earnG) * 100 : Number(earnG);
        if (g >= 20) { s += 15; points.push(`Earnings growth ~${g.toFixed(0)}%`); }
        else if (g < 0) { s -= 10; points.push('Earnings down'); }
      }
      if (sector && futureSectors.test(sector)) {
        s += 12;
        points.push(`Sector: ${f?.sector || r?.sector}`);
      }
      // 1Y/3M price as soft momentum of business interest
      const y1 = r?.periodReturns?.oneYear;
      const m3 = r?.periodReturns?.threeMonth;
      if (y1 != null && y1 > 15) { s += 6; points.push('1Y price constructive'); }
      if (m3 != null && m3 < -25) { s -= 5; points.push('3M heavy drawdown'); }
      s = Math.max(0, Math.min(100, s));
      return { score: Math.round(s), detail: points.slice(0, 4).join(' · ') || 'Limited growth fields', points };
    }

    function scoreOrderBook(r) {
      // True order-book depth not available on free feeds — volume / RVol proxy
      let s = 40;
      const points = [];
      const vs = r?.volSpike ?? r?.indicators?.volSpike;
      const rel = r?.relativeVolume ?? r?.indicators?.relativeVolume;
      if (vs != null) {
        if (vs >= 2) { s += 25; points.push(`Vol spike ${Number(vs).toFixed(1)}x`); }
        else if (vs >= 1.3) { s += 12; points.push(`Vol ${Number(vs).toFixed(1)}x`); }
        else if (vs < 0.7) { s -= 10; points.push('Thin volume'); }
        else points.push('Volume normal');
      }
      if (rel != null && rel >= 1.5) { s += 10; points.push(`RVol ${Number(rel).toFixed(1)}`); }
      if (r?.tradePlan?.riskRewardRatio >= 2) { s += 5; points.push('R:R ok'); }
      points.push('Order-book depth: proxy via volume (live book nahi)');
      s = Math.max(0, Math.min(100, s));
      return { score: Math.round(s), detail: points.slice(0, 3).join(' · '), points, proxy: true };
    }

    function scoreFiiDii(marketFii, r) {
      // Stock-level FII/DII rarely in free data — market context + delivery/volume soft
      let s = 50;
      const points = [];
      if (marketFii) {
        if (marketFii.fiiIncreasing) { s += 12; points.push('Market FII net +'); }
        else if (marketFii.fiiIncreasing === false) { s -= 10; points.push('Market FII net −'); }
        if (marketFii.diiIncreasing) { s += 12; points.push('Market DII net +'); }
        else if (marketFii.diiIncreasing === false) { s -= 8; points.push('Market DII net −'); }
      } else {
        points.push('FII/DII stock-level N/A');
        s = null;
        return { score: null, detail: 'Stock-level FII/DII not in free feed', points };
      }
      // Prefer names not dumping on red day
      const day = r?.periodReturns?.oneDay ?? r?.changePct;
      if (day != null && day > 0 && (r?.volSpike || 0) >= 1.2) {
        s += 6;
        points.push('Up + volume (accumulation soft)');
      }
      s = Math.max(0, Math.min(100, s));
      return { score: Math.round(s), detail: points.slice(0, 4).join(' · '), points, marketLevel: true };
    }

    function scoreTechnical(r) {
      const t = r?.scoreBreakdown?.technical ?? r?.technicalScore;
      if (t != null) return { score: Math.round(Number(t)), detail: r?.verdict || 'Technical score', points: [] };
      let s = 40;
      const rsi = r?.indicators?.rsi14;
      if (rsi != null) {
        if (rsi >= 45 && rsi <= 65) s += 15;
        else if (rsi < 30) s += 8;
        else if (rsi > 75) s -= 10;
      }
      const overall = r?.scoreBreakdown?.overall;
      if (overall != null) s = Math.round(0.5 * s + 0.5 * Number(overall));
      return { score: Math.max(0, Math.min(100, Math.round(s))), detail: r?.verdict || 'Tech', points: [] };
    }

    // Enrich top candidates with fund cache (cap concurrency)
    const limited = cheap.slice(0, 120);
    const enriched = [];
    for (const r of limited) {
      let fund = null;
      try {
        if (fundStore?.readCache) {
          const c = await fundStore.readCache(r.symbol, { maxAgeDays: 14, livePrice: r.price });
          fund = c?.data || null;
        }
      } catch (_) {}

      const fundamental = scoreFundamental(fund);
      const business = scoreBusiness(fund, r);
      const orderBook = scoreOrderBook(r);
      const fiiDii = scoreFiiDii(marketFii, r);
      const technical = scoreTechnical(r);

      // Momentum soft from existing period returns (no new calc engine)
      const mom1w = r?.periodReturns?.oneWeek ?? null;
      const mom1m = r?.periodReturns?.oneMonth ?? null;
      let momentumScore = null;
      if (mom1w != null || mom1m != null) {
        let ms = 50;
        if (mom1w != null) ms += Math.max(-20, Math.min(20, mom1w));
        if (mom1m != null) ms += Math.max(-15, Math.min(15, mom1m * 0.5));
        momentumScore = Math.max(0, Math.min(100, Math.round(ms)));
      }

      const rr = r?.tradePlan?.riskRewardRatio != null ? Number(r.tradePlan.riskRewardRatio) : null;
      let rrScore = null;
      if (rr != null && rr > 0) {
        rrScore = Math.max(0, Math.min(100, Math.round(40 + Math.min(rr, 4) * 15)));
      }

      // Existing composite (unchanged weights)
      const parts = [
        [fundamental.score, 0.30],
        [business.score, 0.25],
        [fiiDii.score, 0.20],
        [orderBook.score, 0.15],
        [technical.score, 0.10],
      ];
      let wSum = 0;
      let sSum = 0;
      for (const [sc, w] of parts) {
        if (sc == null) continue;
        sSum += sc * w;
        wSum += w;
      }
      const composite = wSum > 0 ? Math.round(sSum / wSum) : Math.round(technical.score || 0);

      // Investment mode: fund + business heavy (additive score, does not replace composite)
      const invParts = [
        [fundamental.score, 0.45],
        [business.score, 0.30],
        [fiiDii.score, 0.15],
        [technical.score, 0.10],
      ];
      let iw = 0, is_ = 0;
      for (const [sc, w] of invParts) {
        if (sc == null) continue;
        is_ += sc * w; iw += w;
      }
      const investmentScore = iw > 0 ? Math.round(is_ / iw) : composite;

      // Trading mode: tech + momentum + volume + rr
      const trParts = [
        [technical.score, 0.30],
        [momentumScore, 0.25],
        [orderBook.score, 0.20],
        [rrScore, 0.15],
        [fundamental.score, 0.10],
      ];
      let tw = 0, ts = 0;
      for (const [sc, w] of trParts) {
        if (sc == null) continue;
        ts += sc * w; tw += w;
      }
      const tradingScore = tw > 0 ? Math.round(ts / tw) : Math.round(technical.score || composite);

      // Action signal from available scores only
      const fundOk = fundamental.score == null || fundamental.score >= 50;
      const techOk = technical.score == null || technical.score >= 48;
      const riskHeavy = (fundamental.score != null && fundamental.score < 40)
        || (technical.score != null && technical.score < 35);
      let action = 'WATCH';
      if (riskHeavy) action = 'AVOID';
      else if (composite >= 68 && fundOk && techOk) action = 'BUY CANDIDATE';
      else if (composite >= 55) action = 'WATCH';
      else if (composite < 45) action = 'WAIT';
      else action = 'WATCH';

      // Why / positives / risks from existing point lists
      const why = [];
      if (fundamental.points?.length) why.push(...fundamental.points.slice(0, 2));
      if (business.points?.length) why.push(...business.points.slice(0, 1));
      if (technical.detail) why.push(String(technical.detail).slice(0, 60));
      if (rr != null) why.push(`R:R 1:${rr}`);
      const whyUnique = [...new Set(why)].slice(0, 4);

      const positives = [];
      if (fundamental.score != null && fundamental.score >= 60) positives.push('Fundamentals constructive');
      if (business.score != null && business.score >= 60) positives.push('Business/growth bias positive');
      if (orderBook.score != null && orderBook.score >= 60) positives.push('Volume supportive');
      if (momentumScore != null && momentumScore >= 58) positives.push('Momentum not weak');
      if (rr != null && rr >= 2) positives.push(`R:R 1:${rr}`);
      if (!positives.length && whyUnique.length) positives.push(...whyUnique.slice(0, 2));

      const riskFlags = [];
      if (fundamental.score == null) riskFlags.push('Fund data limited');
      if (fiiDii.score == null) riskFlags.push('Stock-level FII/DII N/A (market proxy)');
      if (orderBook.proxy) riskFlags.push('Order-book = volume proxy');
      if (fundamental.score != null && fundamental.score < 45) riskFlags.push('Weak fundamental score');
      if (technical.score != null && technical.score < 40) riskFlags.push('Weak technical score');
      if (r.price < 50) riskFlags.push('Very low price — liquidity/volatility risk');

      // Data quality
      let dq = 50;
      const dqNotes = [];
      if (fund) { dq += 20; } else { dq -= 15; dqNotes.push('No fund cache'); }
      if (technical.score != null) dq += 15; else dqNotes.push('Tech limited');
      if (fiiDii.score == null) { dq -= 10; dqNotes.push('FII/DII proxy'); }
      if (orderBook.proxy) { dq -= 5; dqNotes.push('Vol proxy for book'); }
      dq = Math.max(15, Math.min(95, dq));
      const dataQuality = {
        score: dq,
        label: dq >= 70 ? 'Good' : dq >= 50 ? 'Fair' : 'Limited',
        notes: dqNotes,
      };

      // Trading snapshot from existing tradePlan only
      let tradingSnapshot = null;
      const tp = r.tradePlan;
      if (tp && (tp.entryLow != null || tp.entryHigh != null || tp.target != null || tp.stopLoss != null)) {
        const px = r.price;
        const tgtPct = tp.target != null && px ? Number((((tp.target - px) / px) * 100).toFixed(1)) : null;
        const slPct = tp.stopLoss != null && px ? Number((((px - tp.stopLoss) / px) * 100).toFixed(1)) : null;
        tradingSnapshot = {
          entryZone: (tp.entryLow != null && tp.entryHigh != null)
            ? `₹${tp.entryLow}–₹${tp.entryHigh}`
            : (tp.entry != null ? `₹${tp.entry}` : null),
          trigger: tp.trigger || null,
          targetPct: tgtPct,
          stopLossPct: slPct,
          riskReward: tp.riskRewardRatio ?? rr,
          expectedHold: r.expectedHold || r.suggestedHorizon || null,
          setupType: r.setupType || r.setup || null,
        };
      }

      // Risk label soft
      let riskLabel = 'Medium';
      if (action === 'AVOID' || (fundamental.score != null && fundamental.score < 40)) riskLabel = 'High';
      else if (composite >= 65 && (fundamental.score == null || fundamental.score >= 55)) riskLabel = 'Lower';

      const mcap = fund?.marketCap ?? fund?.marketCapCr ?? null;

      enriched.push({
        symbol: r.symbol,
        price: r.price,
        changePct: r.changePct ?? r.periodReturns?.oneDay ?? null,
        indexLabel: symbolToIndex?.[r.symbol] || r.indexLabel || null,
        verdict: r.verdict || null,
        sector: fund?.sector || r.sector || null,
        marketCap: mcap,
        compositeScore: composite,
        investmentScore,
        tradingScore,
        momentumScore,
        rrScore,
        scores: {
          fundamental: fundamental.score,
          business: business.score,
          orderBook: orderBook.score,
          fiiDii: fiiDii.score,
          technical: technical.score,
          momentum: momentumScore,
          rr: rrScore,
        },
        scoreNotes: {
          fundamental: fundamental.detail,
          business: business.detail,
          orderBook: orderBook.detail,
          fiiDii: fiiDii.detail,
          technical: technical.detail,
        },
        action,
        why: whyUnique,
        positives: positives.slice(0, 4),
        riskFlags: riskFlags.slice(0, 5),
        riskLabel,
        dataQuality,
        tradingSnapshot,
        pe: fund?.peTrailing ?? fund?.pe ?? null,
        roe: fund?.roe != null ? normRoe(fund.roe) : null,
        setupType: r.setupType || r.setup || null,
      });
    }

    enriched.sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0));

    // Category cards from same list (no invented ranks)
    function pickBest(arr, key, minVal = 0) {
      const sorted = arr.filter((x) => x[key] != null && x[key] >= minVal).sort((a, b) => b[key] - a[key]);
      return sorted[0] || null;
    }
    const categories = {
      bestTrading: pickBest(enriched, 'tradingScore', 50),
      bestFundamental: pickBest(enriched, 'investmentScore', 50),
      bestMomentum: pickBest(enriched, 'momentumScore', 55),
      bestRr: pickBest(enriched, 'rrScore', 55),
      bestBounce: enriched
        .filter((x) => (x.changePct != null && x.changePct < -2) && (x.scores?.technical != null && x.scores.technical >= 50))
        .sort((a, b) => (b.scores.technical || 0) - (a.scores.technical || 0))[0] || null,
    };
    const catOut = {};
    for (const [k, v] of Object.entries(categories)) {
      catOut[k] = v ? { symbol: v.symbol, price: v.price, score: v.tradingScore || v.investmentScore || v.compositeScore, action: v.action } : null;
    }

    // Sectors list for filters
    const sectors = [...new Set(enriched.map((e) => e.sector).filter(Boolean))].sort();

    res.json({
      maxPrice: maxP,
      count: enriched.length,
      scannedAt,
      marketTrend: marketContext?.trend || null,
      marketFiiDii: marketFii,
      weights: {
        fundamental: 30,
        business: 25,
        fiiDii: 20,
        orderBook: 15,
        technical: 10,
      },
      weightsInvestment: { fundamental: 45, business: 30, fiiDii: 15, technical: 10 },
      weightsTrading: { technical: 30, momentum: 25, orderBook: 20, rr: 15, fundamental: 10 },
      categories: catOut,
      sectors,
      note: 'Rank: Fund → Business → FII/DII (market) → Volume proxy → Technical. Order-book depth free feed me nahi; volume proxy. Stock-level FII/DII limited. Action signals are filters on scores — not guaranteed BUY.',
      stocks: enriched.slice(0, 60),
    });

  } catch (err) {
    console.error('[under-200]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/system-health', async (req, res) => {
  try {
    res.json(await buildSystemHealth());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

