// Long-horizon Sector + Ancillary investment shortlist (NOT daily trading).
const marketData = require('./marketData');
const { getSectorMap } = require('./institutional/sectorSync');
const { isMongoConfigured } = require('./mongo');
const { startJob, updateJob, endJob } = require('./progressStore');
const mongoose = require('mongoose');

const CACHE_DAYS = 45;
const SOFT_FIT_MIN = 48;
const PER_THEME_MAX = 4;

const THEME_COLORS = {
  defence_aero: '#e85d4c',
  ems_electronics: '#6ea8fe',
  auto_ev_ancillary: '#3dd68c',
  specialty_chem: '#c084fc',
  renewable_power_equip: '#fbbf24',
  rail_infra_ancillary: '#fb923c',
  capital_goods: '#38bdf8',
  pharma_cdmo_api: '#f472b6',
  datacenter_digital_infra: '#a3e635',
};

const GROWTH_THEMES = [
  {
    id: 'defence_aero',
    name: 'Defence & Aerospace suppliers',
    whyGrowing: 'Indigenisation + export + multi-year order books.',
    horizon: '12–36 months',
    ancillaryFocus: 'Electronics, forgings, explosives — supply to primes / forces.',
    symbols: ['BEL', 'HAL', 'BDL', 'MAZDOCK', 'COCHINSHIP', 'DATAPATTNS', 'PARAS', 'ASTRAMICRO', 'MTAR', 'DYNAMATECH', 'SOLARINDS', 'PREMEXPLN', 'DCXINDIA'],
  },
  {
    id: 'ems_electronics',
    name: 'Electronics EMS / components',
    whyGrowing: 'PLI + localisation — EMS supplies brands/OEMs.',
    horizon: '12–36 months',
    ancillaryFocus: 'Contract manufacturers, PCB, design-to-box.',
    symbols: ['DIXON', 'KAYNES', 'SYRMA', 'PGEL', 'AVALON', 'CYIENTDLM', 'CENTUM', 'AMBER', 'ELIN'],
  },
  {
    id: 'auto_ev_ancillary',
    name: 'Auto & EV parts suppliers',
    whyGrowing: 'Content-per-car up; EV/hybrid; component exports.',
    horizon: '12–36 months',
    ancillaryFocus: 'Tyres, forgings, wiring, motors — supply to OEMs.',
    symbols: ['BHARATFORG', 'MOTHERSON', 'SONACOMS', 'UNOMINDA', 'ENDURANCE', 'BOSCHLTD', 'SKFINDIA', 'TIINDIA', 'BALKRISIND', 'APOLLOTYRE', 'EXIDEIND', 'SUPRAJIT', 'MINDACORP'],
  },
  {
    id: 'specialty_chem',
    name: 'Specialty chemicals',
    whyGrowing: 'China+1; agro/pharma/electronic chemical demand.',
    horizon: '12–36 months',
    ancillaryFocus: 'Intermediates sold into larger manufacturers.',
    symbols: ['CLEAN', 'NAVINFLUOR', 'SRF', 'AARTIIND', 'FINEORG', 'ANURAS', 'ROSSARI', 'VINATIORGA', 'GALAXYSURF', 'ALKYLAMINE', 'BALAMINES'],
  },
  {
    id: 'renewable_power_equip',
    name: 'Power & renewable equipment',
    whyGrowing: 'Grid + RE build needs cables, transformers, turbines.',
    horizon: '12–36 months',
    ancillaryFocus: 'Equipment makers supplying utilities / EPCs.',
    symbols: ['KEI', 'POLYCAB', 'FINCABLES', 'SUZLON', 'INOXWIND', 'TRITURBINE', 'TDPOWERSYS', 'APAR', 'VOLTAMP'],
  },
  {
    id: 'rail_infra_ancillary',
    name: 'Rail / metro suppliers',
    whyGrowing: 'Railway + metro capex ecosystem.',
    horizon: '12–36 months',
    ancillaryFocus: 'Coaches, bearings, cables for rail projects.',
    symbols: ['TITAGARH', 'TIMKEN', 'SKFINDIA', 'KEC', 'KALPATPOWR', 'APAR', 'TEXRAIL'],
  },
  {
    id: 'capital_goods',
    name: 'Industrial / capital-goods suppliers',
    whyGrowing: 'Private capex and automation cycle.',
    horizon: '12–36 months',
    ancillaryFocus: 'Electricals, compressors, process equipment.',
    symbols: ['SIEMENS', 'ABB', 'HAVELLS', 'CUMMINSIND', 'THERMAX', 'ELGIEQUIP', 'AIAENG', 'KSB', 'GRINDWELL'],
  },
  {
    id: 'pharma_cdmo_api',
    name: 'Pharma CDMO / API suppliers',
    whyGrowing: 'Global outsourcing to India CDMO/API.',
    horizon: '12–36 months',
    ancillaryFocus: 'API, CDMO — supply to big pharma.',
    symbols: ['DIVISLAB', 'LAURUSLABS', 'NEULANDLAB', 'SYNGENE', 'SUPRIYA', 'ANURAS'],
  },
  {
    id: 'datacenter_digital_infra',
    name: 'Data-centre & digital infra chain',
    whyGrowing: 'AI/cloud → power, cooling, cables, EMS.',
    horizon: '12–36 months',
    ancillaryFocus: 'Power/cooling/cables/EMS into DC buildout.',
    symbols: ['POLYCAB', 'KEI', 'SIEMENS', 'ABB', 'HAVELLS', 'DIXON', 'KAYNES', 'AMBER', 'VOLTAS', 'BLUESTARCO'],
  },
];

let PackModel;
function model() {
  if (PackModel) return PackModel;
  if (!isMongoConfigured()) return null;
  const schema = new mongoose.Schema({
    key: { type: String, default: 'latest', unique: true },
    payload: mongoose.Schema.Types.Mixed,
    computedAt: Date,
  }, { collection: 'sector_ancillary_invest' });
  PackModel = mongoose.models.SectorAncillaryInvest
    || mongoose.model('SectorAncillaryInvest', schema);
  return PackModel;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function scoreQuality(f) {
  let s = 50;
  const roe = f?.roe;
  const margin = f?.profitMargin;
  const de = f?.debtToEquity;
  if (roe != null) {
    if (roe >= 0.18) s += 20;
    else if (roe >= 0.12) s += 12;
    else if (roe >= 0.08) s += 5;
    else if (roe < 0.05) s -= 12;
  }
  if (margin != null) {
    if (margin >= 0.15) s += 12;
    else if (margin >= 0.08) s += 6;
    else if (margin < 0.03) s -= 8;
  }
  if (de != null) {
    const d = de > 10 ? de / 100 : de;
    if (d <= 0.5) s += 10;
    else if (d <= 1) s += 4;
    else if (d > 2.5) s -= 10;
  }
  return clamp(Math.round(s), 0, 100);
}

function scoreGrowth(f, priceGrowth) {
  let s = 48;
  const rg = f?.revenueGrowth;
  const eg = f?.earningsGrowth;
  if (rg != null) {
    if (rg >= 0.25) s += 25;
    else if (rg >= 0.15) s += 18;
    else if (rg >= 0.08) s += 10;
    else if (rg < 0) s -= 12;
  }
  if (eg != null) {
    if (eg >= 0.25) s += 18;
    else if (eg >= 0.12) s += 10;
    else if (eg < 0) s -= 10;
  }
  if (rg == null && eg == null && priceGrowth) {
    // Differentiate growth score by actual 1Y return (avoid all-62 flat scores)
    const y1 = priceGrowth.y1;
    if (y1 != null) {
      if (y1 >= 100) s += 22;
      else if (y1 >= 60) s += 16;
      else if (y1 >= 30) s += 12;
      else if (y1 >= 15) s += 8;
      else if (y1 >= 0) s += 3;
      else if (y1 >= -15) s -= 4;
      else s -= 12;
    }
    if (priceGrowth.y3 != null) {
      if (priceGrowth.y3 >= 100) s += 10;
      else if (priceGrowth.y3 >= 40) s += 5;
    }
  }
  return clamp(Math.round(s), 0, 100);
}

function scoreValuation(f) {
  let s = 50;
  const pe = f?.peTrailing ?? f?.peForward;
  const pb = f?.priceToBook;
  if (pe != null && pe > 0) {
    if (pe < 20) s += 18;
    else if (pe < 35) s += 8;
    else if (pe < 55) s += 0;
    else if (pe < 80) s -= 8;
    else s -= 16;
  }
  if (pb != null && pb > 0) {
    if (pb < 3) s += 8;
    else if (pb > 12) s -= 8;
  }
  return clamp(Math.round(s), 0, 100);
}

function overallFit(q, g, v) {
  return Number((q * 0.35 + g * 0.40 + v * 0.25).toFixed(1));
}

function fitLabel(score) {
  if (score >= 70) return 'Strong fit';
  if (score >= 58) return 'Watchlist fit';
  if (score >= 48) return 'Borderline';
  return 'Weak';
}

function priceGrowthFromCandles(candles) {
  if (!candles?.length || candles.length < 30) return null;
  const last = candles[candles.length - 1].close;
  const y1 = candles.length > 252 ? candles[candles.length - 252].close : candles[0].close;
  const y3 = candles.length > 756 ? candles[candles.length - 756].close : null;
  return {
    y1: y1 ? Number((((last - y1) / y1) * 100).toFixed(1)) : null,
    y3: y3 ? Number((((last - y3) / y3) * 100).toFixed(1)) : null,
  };
}


/** Value-chain stage for curated theme lists (research labels, not legal classification). */
function valueChainStage(themeId, symbol) {
  // Core OEMs that sometimes appear in supplier lists
  const coreish = new Set(['HAL', 'BEL', 'MAZDOCK', 'COCHINSHIP', 'BHEL', 'SIEMENS', 'ABB']);
  if (coreish.has(symbol)) {
    return { stage: 'Core', chain: 'Core → Ancillary → Components → Equipment → Services' };
  }
  const byTheme = {
    defence_aero: 'Components',
    ems_electronics: 'Components',
    auto_ev_ancillary: 'Components',
    specialty_chem: 'Ancillary',
    renewable_power_equip: 'Equipment',
    rail_infra_ancillary: 'Equipment',
    capital_goods: 'Equipment',
    pharma_cdmo_api: 'Ancillary',
    datacenter_digital_infra: 'Services',
  };
  const stage = byTheme[themeId] || 'Ancillary';
  return { stage, chain: 'Core → Ancillary → Components → Equipment → Services' };
}

function themeExposure(themeId, symbol) {
  // Curated lists are mostly direct suppliers; a few names are broader / indirect.
  const indirect = new Set(['SIEMENS', 'ABB', 'BHEL', 'BEL', 'HAL']);
  const low = new Set([]);
  if (low.has(symbol)) return { level: 'Low', pct: null };
  if (indirect.has(symbol)) return { level: 'Indirect', pct: null };
  return { level: 'Direct', pct: null }; // % only when reliable segment data exists
}

function valuationStatus(f, vScore) {
  const pe = f?.peTrailing ?? f?.peForward ?? null;
  const g = f?.earningsGrowth ?? f?.revenueGrowth ?? null;
  const gPct = g == null ? null : (Math.abs(g) <= 5 ? g * 100 : g);
  let status = 'Fair';
  if (pe != null && pe > 0) {
    if (pe < 18) status = 'Cheap';
    else if (pe < 28) status = 'Reasonable';
    else if (pe < 45) status = 'Fair';
    else status = 'Expensive';
    // Growth context soft-adjust
    if (gPct != null && gPct >= 18 && status === 'Expensive') status = 'Fair';
    if (gPct != null && gPct < 0 && status === 'Cheap') status = 'Reasonable';
  } else if (vScore != null) {
    if (vScore >= 70) status = 'Cheap';
    else if (vScore >= 55) status = 'Reasonable';
    else if (vScore >= 40) status = 'Fair';
    else status = 'Expensive';
  }
  const peTxt = pe != null ? `PE ${Number(pe).toFixed(1)}` : 'PE n/a';
  const gTxt = gPct != null ? `growth ~${gPct >= 0 ? '+' : ''}${Number(gPct).toFixed(0)}%` : 'growth n/a';
  return {
    status,
    note: `${peTxt} · ${gTxt}`,
    pe,
    growthContext: gPct,
  };
}

function whyAncillaryLine(theme, symbol, stage) {
  const focus = theme.ancillaryFocus || 'supplies into the theme value chain';
  return `${symbol} sits as ${stage} in ${theme.name} — ${focus}`;
}

function thesis3to5Y(theme, f, metrics, valSt) {
  const whyNow = theme.whyGrowing || 'Multi-year demand tailwinds.';
  const risk = metrics?.debtToEquity != null && metrics.debtToEquity > 1.5
    ? 'Key risk: elevated leverage — size carefully.'
    : (valSt.status === 'Expensive'
      ? 'Key risk: rich valuation — growth must deliver.'
      : 'Key risk: cycle / policy delay can stretch the timeline.');
  return {
    whyNow: `Why now: ${whyNow}`,
    sectorGrowth: `Sector path: ${theme.horizon || '12–36m'} theme build-out; suppliers earn when OEMs/capex spend.`,
    keyRisk: risk,
    oneLiner: `${whyNow} ${risk}`,
  };
}

function exclusionReason(row) {
  if (!row) return null;
  if (row.skipped) return row.error || 'No fundamentals / price history';
  if (row.overall < SOFT_FIT_MIN) return `Below soft-fit (${row.overall} < ${SOFT_FIT_MIN})`;
  return null;
}

async function analyzeSymbol(symbol, theme, sectorMap) {
  let f = null;
  let fundError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      f = await marketData.getFundamentals(symbol);
      fundError = null;
      break;
    } catch (err) {
      fundError = err.message || 'fundamentals_failed';
      await new Promise((r) => setTimeout(r, 500 + attempt * 500));
    }
  }

  let priceGrowth = null;
  try {
    const candles = await marketData.getHistorical(symbol, 800);
    priceGrowth = priceGrowthFromCandles(candles);
  } catch (_) {}

  if (!f && !priceGrowth) {
    return {
      symbol,
      themeId: theme.id,
      themeName: theme.name,
      error: fundError || 'no_price_history',
      skipped: true,
    };
  }

  const q = scoreQuality(f || {});
  const g = scoreGrowth(f || {}, priceGrowth);
  const v = scoreValuation(f || {});
  let overall = overallFit(q, g, v);
  const mcap = f?.marketCap;
  if (mcap != null && mcap < 2e10) overall += 2;
  overall = Number(overall.toFixed(1));

  const vc = valueChainStage(theme.id, symbol);
  const exposure = themeExposure(theme.id, symbol);
  const metrics = {
    trailingPE: f?.peTrailing ?? null,
    forwardPE: f?.peForward ?? null,
    priceToBook: f?.priceToBook ?? null,
    returnOnEquity: f?.roe ?? null,
    profitMargins: f?.profitMargin ?? null,
    debtToEquity: f?.debtToEquity ?? null,
    revenueGrowth: f?.revenueGrowth ?? null,
    earningsGrowth: f?.earningsGrowth ?? null,
    marketCap: f?.marketCap ?? null,
    priceReturn1y: priceGrowth?.y1 ?? null,
    priceReturn3y: priceGrowth?.y3 ?? null,
  };
  const valSt = valuationStatus(f || {}, v);
  const thesisLong = thesis3to5Y(theme, f, metrics, valSt);
  const whyAncillary = whyAncillaryLine(theme, symbol, vc.stage);

  return {
    symbol,
    name: f?.companyName || symbol,
    themeId: theme.id,
    themeName: theme.name,
    role: 'ancillary_supplier',
    sector: sectorMap?.[symbol] || f?.sector || null,
    quality: q,
    growth: g,
    valuation: v,
    overall,
    fit: fitLabel(overall),
    dataSource: f?.source || (f ? (priceGrowth ? 'fundamentals+price' : 'fundamentals') : 'price_proxy'),
    fundError: f ? null : fundError,
    metrics,
    // Research fields (not a BUY signal)
    whyAncillary,
    themeExposure: exposure,
    thesis3to5Y: thesisLong,
    valuationStatus: valSt,
    valueChain: vc,
    thesis: whyAncillary,
    scoresNote: 'Q/G/V are research scores — not automatic BUY.',
    skipped: false,
  };
}

function uniquePairs(themes) {
  const seen = new Set();
  const list = [];
  for (const th of themes) {
    for (const s of th.symbols) {
      if (seen.has(s)) continue;
      seen.add(s);
      list.push({ symbol: s, theme: th });
    }
  }
  return list;
}

function rankThemes(themes, ranked) {
  return themes.map((th) => {
    const members = ranked.filter((r) => r.themeId === th.id);
    const top = members.slice(0, PER_THEME_MAX);
    const rets = members.map((m) => m.metrics?.priceReturn1y).filter((x) => x != null);
    const avg1y = rets.length
      ? Number((rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(1))
      : null;
    const avgOverall = top.length
      ? Number((top.reduce((a, b) => a + b.overall, 0) / top.length).toFixed(1))
      : 0;
    const avgGrowth = top.length
      ? Number((top.reduce((a, b) => a + b.growth, 0) / top.length).toFixed(1))
      : 0;
    // Rank blend: recent performance + quality of shortlist + growth score
    const rankScore = Number((
      (avg1y != null ? clamp(avg1y / 2, -20, 40) : 0) +
      avgOverall * 0.55 +
      avgGrowth * 0.25
    ).toFixed(1));

    let futureOutlook = 'Neutral';
    if (avgGrowth >= 62 && avgOverall >= 58) futureOutlook = 'Constructive';
    else if (avgGrowth >= 55 && (avg1y == null || avg1y > 0)) futureOutlook = 'Watch positive';
    else if (avg1y != null && avg1y < -10) futureOutlook = 'Soft near-term';
    else if (avgOverall < 50) futureOutlook = 'Selective only';

    return {
      id: th.id,
      name: th.name,
      color: THEME_COLORS[th.id] || '#6ea8fe',
      whyGrowing: th.whyGrowing,
      horizon: th.horizon,
      ancillaryFocus: th.ancillaryFocus,
      avgReturn1y: avg1y,
      avgOverall,
      avgGrowth,
      rankScore,
      futureOutlook,
      pickCount: top.length,
      picks: top,
    };
  }).sort((a, b) => b.rankScore - a.rankScore);
}

async function runSectorAncillaryResearch({ force = false, jobId = null } = {}) {
  const M = model();
  if (!force && M) {
    const row = await M.findOne({ key: 'latest' }).lean();
    if (row?.payload?.computedAt) {
      const age = Date.now() - new Date(row.computedAt).getTime();
      if (age < CACHE_DAYS * 86400000) {
        return { ...row.payload, fromCache: true, cacheDays: CACHE_DAYS };
      }
    }
  }

  const jid = jobId || `sector-ancillary-${Date.now()}`;
  try {
    startJob(jid, 1, 'Sector ancillary research starting…');
  } catch (_) {}

  let sectorMap = {};
  try {
    sectorMap = (await getSectorMap()) || {};
  } catch (_) {}

  const pairs = uniquePairs(GROWTH_THEMES);
  const analyzed = [];
  const errorSamples = [];

  try {
    updateJob(jid, 0, { total: pairs.length, phase: 'scanning', message: 'Scanning symbols…', detail: pairs[0]?.symbol });
  } catch (_) {}

  for (let i = 0; i < pairs.length; i++) {
    const { symbol, theme } = pairs[i];
    try {
      updateJob(jid, i, {
        total: pairs.length,
        phase: 'analyzing',
        message: `${theme.name}: ${symbol}`,
        detail: symbol,
        log: `${i + 1}/${pairs.length} ${symbol}`,
      });
    } catch (_) {}

    const row = await analyzeSymbol(symbol, theme, sectorMap);
    analyzed.push(row);
    if (row.skipped && errorSamples.length < 10) {
      errorSamples.push({ symbol, error: row.error });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const ranked = analyzed
    .filter((a) => !a.skipped)
    .sort((a, b) => b.overall - a.overall);

  const viable = ranked.filter((a) => a.overall >= SOFT_FIT_MIN);
  const rankedThemes = rankThemes(GROWTH_THEMES, ranked);

  // Best tier: prefer full Q/G/V; also allow strong growth + strong 1Y when PE missing
  const bestNowAndAhead = ranked
    .filter((a) => {
      const hasFund = a.dataSource && a.dataSource.includes('fundamentals');
      if (hasFund) {
        return a.quality >= 56 && a.growth >= 54 && a.valuation >= 42 && a.overall >= 54;
      }
      // price-proxy path
      return a.growth >= 58 && (a.metrics?.priceReturn1y ?? 0) >= 25 && a.overall >= 52;
    })
    .map((a) => ({
      ...a,
      bestScore: Number((a.quality * 0.34 + a.growth * 0.40 + a.valuation * 0.26).toFixed(1)),
      whyBest: a.dataSource === 'price_proxy'
        ? 'Price momentum strong; fundamentals thin is run me — Q/V default band. Confirm ROE/PE before size.'
        : (a.quality >= 65 && a.growth >= 62
          ? 'Quality + growth strong; valuation acceptable.'
          : 'Balanced Q/G/V among ancillary pack.'),
    }))
    .sort((a, b) => b.bestScore - a.bestScore)
    .slice(0, 10);

  const byTheme = {};
  for (const th of rankedThemes) {
    byTheme[th.id] = th;
  }

  const excluded = analyzed
    .map((a) => {
      const reason = exclusionReason(a);
      if (!reason) return null;
      // also exclude ranked names that didn't make per-theme top-N later
      return {
        symbol: a.symbol,
        themeName: a.themeName,
        overall: a.overall ?? null,
        reason,
      };
    })
    .filter(Boolean);

  // Names analyzed but not in any theme top-N shortlist
  const shortlisted = new Set();
  for (const th of rankedThemes) {
    for (const p of th.picks || []) shortlisted.add(p.symbol);
  }
  for (const a of ranked) {
    if (!shortlisted.has(a.symbol) && a.overall >= SOFT_FIT_MIN) {
      excluded.push({
        symbol: a.symbol,
        themeName: a.themeName,
        overall: a.overall,
        reason: `Fit OK but outside top ${PER_THEME_MAX} in theme (selective shortlist)`,
      });
    }
  }

  const payload = {
    computedAt: new Date().toISOString(),
    reviewEvery: '1–2 months',
    cacheDays: CACHE_DAYS,
    softFitMin: SOFT_FIT_MIN,
    approach: {
      step1: 'Rank growing themes by recent returns + shortlist quality.',
      step2: 'Per theme only top 3–4 ancillary suppliers (selective).',
      step3: 'Score Quality · Growth · Valuation on each name (research scores, not BUY).',
      step4: 'Investment hold — review every 1–2 months.',
    },
    aspirationNote: 'Q/G/V = research scores only — not automatic BUY. Theme + ancillary map.',
    rankedThemes,
    themes: rankedThemes.map((th) => ({
      id: th.id,
      name: th.name,
      color: th.color,
      whyGrowing: th.whyGrowing,
      horizon: th.horizon,
      ancillaryFocus: th.ancillaryFocus,
      pickCount: th.pickCount,
      avgReturn1y: th.avgReturn1y,
      rankScore: th.rankScore,
      futureOutlook: th.futureOutlook,
    })),
    byTheme,
    bestNowAndAhead,
    topPicks: (viable.length ? viable : ranked).slice(0, 12),
    scanned: pairs.length,
    rankedCount: ranked.length,
    passedSoftFit: viable.length,
    failedOrSkipped: analyzed.filter((a) => a.skipped).length,
    errorSamples,
    universe: {
      scanned: pairs.length,
      ranked: ranked.length,
      softFit: viable.length,
      shortlisted: shortlisted.size,
      excludedCount: excluded.length,
      pipeline: `${pairs.length} scanned → ${ranked.length} ranked → ${viable.length} soft-fit → ${shortlisted.size} selective shortlist`,
    },
    exclusions: excluded.slice(0, 80),
    jobId: jid,
    disclaimer: 'Educational research scores (Q/G/V). Not investment advice. Not automatic BUY.',
  };

  try {
    if (M) {
      await M.updateOne(
        { key: 'latest' },
        { $set: { payload, computedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch (err) {
    console.warn('[sector-ancillary] persist:', err.message);
  }

  try {
    endJob(jid, `Done — ${payload.topPicks.length} top fits`);
  } catch (_) {}

  return enrichPayloadResearch({ ...payload, fromCache: false });
}


/** Fill research fields on cached picks (old payloads lack whyAncillary etc.). */
function enrichPickResearch(p) {
  if (!p || p.skipped) return p;
  const theme = GROWTH_THEMES.find((th) => th.id === p.themeId) || {
    id: p.themeId,
    name: p.themeName || 'Theme',
    whyGrowing: '',
    ancillaryFocus: '',
    horizon: '12–36 months',
  };
  const vc = p.valueChain?.stage ? p.valueChain : valueChainStage(theme.id, p.symbol);
  const exposure = p.themeExposure?.level ? p.themeExposure : themeExposure(theme.id, p.symbol);
  const valSt = p.valuationStatus?.status
    ? p.valuationStatus
    : valuationStatus({ peTrailing: p.metrics?.trailingPE, earningsGrowth: p.metrics?.earningsGrowth, revenueGrowth: p.metrics?.revenueGrowth }, p.valuation);
  const thesisLong = p.thesis3to5Y?.whyNow
    ? p.thesis3to5Y
    : thesis3to5Y(theme, null, p.metrics || {}, valSt);
  const whyAncillary = p.whyAncillary || whyAncillaryLine(theme, p.symbol, vc.stage);
  return {
    ...p,
    whyAncillary,
    themeExposure: exposure,
    valueChain: vc,
    valuationStatus: valSt,
    thesis3to5Y: thesisLong,
    scoresNote: p.scoresNote || 'Q/G/V are research scores — not automatic BUY.',
  };
}

function enrichPayloadResearch(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const mapList = (arr) => (arr || []).map(enrichPickResearch);
  const rankedThemes = (payload.rankedThemes || []).map((th) => ({
    ...th,
    picks: mapList(th.picks),
  }));
  const byTheme = {};
  for (const th of rankedThemes) byTheme[th.id] = th;
  const shortlisted = new Set();
  for (const th of rankedThemes) {
    for (const pk of th.picks || []) shortlisted.add(pk.symbol);
  }
  const universe = payload.universe || {
    scanned: payload.scanned,
    ranked: payload.rankedCount,
    softFit: payload.passedSoftFit,
    shortlisted: shortlisted.size,
    excludedCount: (payload.exclusions || []).length,
    pipeline: `${payload.scanned || '?'} scanned → ${payload.rankedCount || '?'} ranked → ${payload.passedSoftFit || '?'} soft-fit → ${shortlisted.size} selective shortlist`,
  };
  return {
    ...payload,
    rankedThemes,
    byTheme,
    bestNowAndAhead: mapList(payload.bestNowAndAhead),
    topPicks: mapList(payload.topPicks),
    universe,
    exclusions: payload.exclusions || [],
    aspirationNote: payload.aspirationNote || 'Q/G/V = research scores only — not automatic BUY.',
  };
}

async function getSectorAncillaryLatest() {
  const M = model();
  if (M) {
    const row = await M.findOne({ key: 'latest' }).lean();
    if (row?.payload) return enrichPayloadResearch({ ...row.payload, fromCache: true });
  }
  const fresh = await runSectorAncillaryResearch({ force: false });
  return enrichPayloadResearch(fresh);
}

module.exports = {
  runSectorAncillaryResearch,
  getSectorAncillaryLatest,
  GROWTH_THEMES,
  CACHE_DAYS,
};
