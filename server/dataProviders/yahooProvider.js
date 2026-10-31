// server/dataProviders/yahooProvider.js
// Thin wrapper around the existing Yahoo-based server/marketData.js so it
// can act as a uniform "provider" in the multi-source aggregator - same
// functions, just tagged with provider metadata for source tracking.
const marketData = require('../marketData');

const NAME = 'yahoo';
const RELIABILITY = 'medium'; // free, unauthenticated, occasionally rate-limited

function isConfigured() { return true; } // no credentials needed, always available

async function getQuote(symbol) {
  const q = await marketData.getQuote(symbol);
  return {
    lastPrice: q.lastPrice, change: q.change, pChange: q.pChange, open: q.open,
    previousClose: q.previousClose, dayHigh: q.dayHigh, dayLow: q.dayLow,
    weekHigh52: q.weekHigh52, weekLow52: q.weekLow52, volume: q.totalTradedVolume,
    marketState: q.marketState, asOf: q.asOf || q.fetchedAt,
  };
}

async function getHistorical(symbol, days) { return marketData.getHistorical(symbol, days); }
async function getIntradayCandles(symbol, range, interval) { return marketData.getIntradayCandles(symbol, range, interval); }

module.exports = { name: NAME, reliability: RELIABILITY, isConfigured, getQuote, getHistorical, getIntradayCandles };
