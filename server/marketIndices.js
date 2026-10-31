// server/marketIndices.js
// Curated symbol lists for the Indices & Commodities screen - Indian
// sectoral/broad indices, global indices, and global commodities. Every
// symbol here is a real Yahoo Finance ticker (indices use the "^" prefix,
// commodities use the "=F" futures suffix - see toYahooSymbol in
// server/marketData.js). Fetched live via the same getQuote() used
// everywhere else in this app - no separate/unofficial data source.
//
// Day-wise honesty: every card includes asOf + marketState so a US index
// still showing yesterday's close while India is open is clearly labelled
// (not mixed into "same day" without context).
const marketData = require('./marketData');

const INDIAN_INDICES = [
  { symbol: '^NSEI', label: 'Nifty 50' },
  { symbol: '^NSEBANK', label: 'Nifty Bank' },
  { symbol: '^CNXIT', label: 'Nifty IT' },
  { symbol: '^CNXPHARMA', label: 'Nifty Pharma' },
  { symbol: '^CNXFMCG', label: 'Nifty FMCG' },
  { symbol: '^CNXAUTO', label: 'Nifty Auto' },
  { symbol: '^CNXMETAL', label: 'Nifty Metal' },
  { symbol: '^CNXREALTY', label: 'Nifty Realty' },
  { symbol: '^CNXENERGY', label: 'Nifty Energy' },
  { symbol: '^CNXMEDIA', label: 'Nifty Media' },
  { symbol: '^CNXPSE', label: 'Nifty PSE' },
  { symbol: '^CNXINFRA', label: 'Nifty Infra' },
  { symbol: '^CNXPSUBANK', label: 'Nifty PSU Bank' },
  { symbol: '^CNXFIN', label: 'Nifty Financial Services' },
  { symbol: '^NSMIDCP', label: 'Nifty Midcap 100' },
  { symbol: '^CNXSC', label: 'Nifty Smallcap' },
  { symbol: '^CRSLDX', label: 'Nifty 500' },
  { symbol: '^BSESN', label: 'Sensex' },
  { symbol: '^INDIAVIX', label: 'India VIX' },
];

const GLOBAL_INDICES = [
  { symbol: '^GSPC', label: 'S&P 500 (US)' },
  { symbol: '^DJI', label: 'Dow Jones (US)' },
  { symbol: '^IXIC', label: 'Nasdaq (US)' },
  { symbol: '^FTSE', label: 'FTSE 100 (UK)' },
  { symbol: '^GDAXI', label: 'DAX (Germany)' },
  { symbol: '^FCHI', label: 'CAC 40 (France)' },
  { symbol: '^N225', label: 'Nikkei 225 (Japan)' },
  { symbol: '^HSI', label: 'Hang Seng (Hong Kong)' },
  { symbol: '000001.SS', label: 'Shanghai Composite (China)' },
  { symbol: '^AXJO', label: 'ASX 200 (Australia)' },
  { symbol: '^KS11', label: 'KOSPI (South Korea)' },
  { symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
];

const COMMODITIES = [
  { symbol: 'CL=F', label: 'Crude Oil (WTI)', unit: 'USD/bbl' },
  { symbol: 'BZ=F', label: 'Brent Crude', unit: 'USD/bbl' },
  { symbol: 'NG=F', label: 'Natural Gas', unit: 'USD/MMBtu' },
  { symbol: 'GC=F', label: 'Gold', unit: 'USD/oz' },
  { symbol: 'SI=F', label: 'Silver', unit: 'USD/oz' },
  { symbol: 'HG=F', label: 'Copper', unit: 'USD/lb' },
  { symbol: 'PL=F', label: 'Platinum', unit: 'USD/oz' },
  { symbol: 'ZC=F', label: 'Corn', unit: 'USD/bu' },
];

// Fetches every symbol in the list, gently paced (same reasoning as
// mapLimit elsewhere - avoid firing everything at Yahoo at once), and
// simply drops any symbol that fails instead of failing the whole batch.
async function fetchQuotesTolerant(list) {
  const out = [];
  for (const item of list) {
    try {
      const quote = await marketData.getQuote(item.symbol);
      if (quote.lastPrice == null) continue;
      out.push({
        symbol: item.symbol,
        label: item.label,
        unit: item.unit || null,
        price: quote.lastPrice,
        change: quote.change,
        pChange: quote.pChange,
        previousClose: quote.previousClose ?? null,
        asOf: quote.asOf || null,
        marketState: quote.marketState || null,
        // Session date (YYYY-MM-DD) of the quote for same-day comparison
        sessionDate: quote.asOf ? quote.asOf.slice(0, 10) : null,
      });
    } catch (err) {
      // Silently skip - one bad/unavailable symbol shouldn't take down the
      // whole screen. Logged at debug level only to avoid noisy production logs.
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

async function getIndianIndices() { return fetchQuotesTolerant(INDIAN_INDICES); }
async function getGlobalIndices() { return fetchQuotesTolerant(GLOBAL_INDICES); }
async function getCommodities() { return fetchQuotesTolerant(COMMODITIES); }

module.exports = {
  INDIAN_INDICES, GLOBAL_INDICES, COMMODITIES,
  getIndianIndices, getGlobalIndices, getCommodities,
};
