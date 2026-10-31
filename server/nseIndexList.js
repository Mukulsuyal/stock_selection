// server/nseIndexList.js
// Refreshes INDEXES (server/indexConstituents.js) with the OFFICIAL, FULL
// constituent lists from NSE's public archive CSVs - Nifty 50 (50 stocks) +
// Nifty Midcap 150 (150) + Nifty Smallcap 250 (250) = ~450 total, instead
// of the smaller hand-curated fallback lists that used to live permanently
// in indexConstituents.js.
//
// These CSVs are on nsearchives.nseindia.com - a static file archive, NOT
// the bot-protected interactive API (nseSession.js's domain) - so they're
// usually reachable even when the interactive API/FII-DII endpoints are
// blocked. If this fetch ever fails (NSE unreachable from this host, CSV
// format changed, etc.), INDEXES simply keeps whatever it already has - the
// original hand-curated lists in indexConstituents.js, or whatever was
// fetched on a previous successful run - so a failure here degrades
// quietly rather than crashing anything.
const axios = require('axios');
const { INDEXES } = require('./indexConstituents');

const CSV_URLS = {
  nifty50: 'https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv',
  midcap: 'https://nsearchives.nseindia.com/content/indices/ind_niftymidcap150list.csv',
  smallcap: 'https://nsearchives.nseindia.com/content/indices/ind_niftysmallcap250list.csv',
};

// A minimum sane count per index, so a garbled/truncated/HTML-error-page
// response (e.g. a login redirect) can never wipe out a working list with
// an empty or tiny one.
const MIN_EXPECTED = { nifty50: 40, midcap: 100, smallcap: 150 };

function parseSymbolsFromCsv(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().replace(/"/g, '').toLowerCase());
  const symbolIdx = header.indexOf('symbol');
  if (symbolIdx === -1) return [];
  return lines.slice(1)
    .map((line) => (line.split(',')[symbolIdx] || '').trim().replace(/"/g, ''))
    .filter(Boolean);
}

async function refreshIndexLists() {
  for (const [key, url] of Object.entries(CSV_URLS)) {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/csv,*/*',
        },
      });
      const symbols = parseSymbolsFromCsv(String(res.data));
      const minExpected = MIN_EXPECTED[key] || 20;
      if (symbols.length >= minExpected) {
        const before = INDEXES[key].symbols.length;
        INDEXES[key].symbols = symbols;
        console.log(`[nseIndexList] refreshed ${key}: ${symbols.length} symbols from official NSE list (was ${before}).`);
      } else {
        console.warn(`[nseIndexList] ${key} CSV only parsed ${symbols.length} symbol(s) (expected >=${minExpected}) - keeping existing ${INDEXES[key].symbols.length}-symbol list rather than risk a bad/partial response.`);
      }
    } catch (err) {
      console.warn(`[nseIndexList] could not refresh ${key} from NSE archives (${err.message}) - keeping existing ${INDEXES[key].symbols.length}-symbol list.`);
    }
  }
}

module.exports = { refreshIndexLists };
