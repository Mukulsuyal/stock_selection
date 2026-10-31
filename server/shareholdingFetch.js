/**
 * Shareholding pattern — Groww public API.
 * Prefer shareholdingPatternV2 (matches Groww app UI: promoters/fii/dii/public).
 * Fallback to legacy shareHoldingPattern field mapping.
 */
const axios = require('axios');

const cache = new Map();
const CACHE_MS = 12 * 60 * 60 * 1000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://groww.in/',
};

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function parseLegacyQuarter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prom = raw.promoters || {};
  let p = 0;
  for (const k of ['individual', 'government', 'corporation']) p += Number(prom[k]?.percent) || 0;
  if (prom.percent != null) p = Number(prom.percent) || p;
  const fii = Number(raw.foreignInstitutions?.percent);
  const mf = Number(raw.mutualFunds?.percent) || 0;
  const ins = Number(raw.otherDomesticInstitutions?.insurance?.percent) || 0;
  const oth = Number(raw.otherDomesticInstitutions?.otherFirms?.percent) || 0;
  const dii = mf + ins + oth;
  const pub = Number(raw.retailAndOthers?.percent);
  return {
    promoterPct: Number.isFinite(p) ? num(p) : null,
    fiiPct: Number.isFinite(fii) ? num(fii) : null,
    diiPct: Number.isFinite(dii) ? num(dii) : null,
    publicPct: Number.isFinite(pub) ? num(pub) : null,
    mutualFundsPct: num(mf),
  };
}

function parseV2Quarter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // V2 keys: promoters, fii, dii, public (exact Groww UI)
  return {
    promoterPct: num(raw.promoters ?? raw.promoter),
    fiiPct: num(raw.fii ?? raw.FII),
    diiPct: num(raw.dii ?? raw.DII),
    publicPct: num(raw.public ?? raw.Public),
    mutualFundsPct: null,
  };
}

async function resolveSearchId(symbol) {
  const sym = String(symbol || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
  const res = await axios.get('https://groww.in/v1/api/search/v1/entity', {
    params: { query: sym, size: 8 },
    headers: HEADERS,
    timeout: 12000,
  });
  const content = res.data?.content || [];
  const stocks = content.filter((c) => (c.entity_type || '').toLowerCase() === 'stocks');
  const hit =
    stocks.find((c) => String(c.nse_scrip_code || '').toUpperCase() === sym) ||
    stocks.find((c) => String(c.search_id || '').toLowerCase().includes(sym.toLowerCase())) ||
    stocks[0];
  if (!hit) throw new Error('Groww search: symbol not found');
  return hit.search_id || hit.id;
}

async function fromGroww(symbol) {
  const searchId = await resolveSearchId(symbol);
  const res = await axios.get(
    `https://groww.in/v1/api/stocks_data/v1/company/search_id/${encodeURIComponent(searchId)}`,
    { headers: HEADERS, timeout: 15000 }
  );
  const body = res.data || {};

  // Prefer V2 — matches Groww UI percentages
  const v2 = body.shareholdingPatternV2?.data || body.shareholdingPatternV2;
  let quarters = [];
  if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) {
    quarters = Object.keys(v2)
      .map((label) => {
        const q = parseV2Quarter(v2[label]);
        if (!q) return null;
        return { label, ...q };
      })
      .filter(Boolean);
  }

  // Fallback legacy nested structure (can mis-label FII vs public on some names)
  if (!quarters.length) {
    const pattern = body.shareHoldingPattern;
    if (pattern && typeof pattern === 'object') {
      quarters = Object.keys(pattern)
        .map((label) => {
          const q = parseLegacyQuarter(pattern[label]);
          if (!q) return null;
          return { label, ...q };
        })
        .filter(Boolean);
    }
  }

  if (!quarters.length) return null;
  const latest = quarters[0];
  const prev = quarters[1] || null;
  const delta = (a, b) => (a != null && b != null ? num(a - b) : null);
  return {
    promoterPct: latest.promoterPct,
    fiiPct: latest.fiiPct,
    diiPct: latest.diiPct,
    publicPct: latest.publicPct,
    mutualFundsPct: latest.mutualFundsPct,
    fiiDelta: prev ? delta(latest.fiiPct, prev.fiiPct) : null,
    diiDelta: prev ? delta(latest.diiPct, prev.diiPct) : null,
    promoterDelta: prev ? delta(latest.promoterPct, prev.promoterPct) : null,
    publicDelta: prev ? delta(latest.publicPct, prev.publicPct) : null,
    quarters,
    source: 'groww',
    asOf: latest.label,
  };
}

async function getShareholding(symbol) {
  const sym = String(symbol || '').toUpperCase().replace(/\.(NS|BO)$/i, '');
  if (!sym) return null;
  const cached = cache.get(sym);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  let data = null;
  try {
    data = await fromGroww(sym);
  } catch (err) {
    if (process.env.FUND_DEBUG === '1') console.warn('[shareholding] groww', sym, err.message);
  }
  if (data) cache.set(sym, { at: Date.now(), data });
  return data;
}

module.exports = { getShareholding };
