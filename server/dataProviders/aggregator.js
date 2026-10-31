// server/dataProviders/aggregator.js
// The multi-source orchestrator: for each field/dataset, try providers in
// priority order (Upstox -> Yahoo) and record exactly which provider it
// came from, when, and how reliable that provider generally is. If NO
// provider has something, it's explicitly marked unavailable - never
// fabricated or guessed.
//
// Adding another provider later: implement the same shape (isConfigured,
// getQuote, getHistorical, getIntradayCandles) as yahooProvider.js/
// upstoxProvider.js, then add it to PROVIDERS in priority order. Nothing
// else needs to change.
const yahooProvider = require('./yahooProvider');
const upstoxProvider = require('./upstoxProvider');

const PROVIDERS = [upstoxProvider, yahooProvider]; // priority order
const QUOTE_FIELDS = ['lastPrice', 'change', 'pChange', 'open', 'previousClose', 'dayHigh', 'dayLow', 'weekHigh52', 'weekLow52', 'volume', 'marketState'];

async function isAvailable(provider) {
  try {
    const result = provider.isConfigured();
    return result instanceof Promise ? await result : result;
  } catch {
    return false;
  }
}

// Fetches a quote by trying providers in order, merging field-by-field -
// e.g. Upstox might have price/volume but not 52-week high, so that one
// field falls through to Yahoo instead of the whole quote being rejected.
async function getMultiSourceQuote(symbol) {
  const fields = {};
  const attempts = [];

  for (const provider of PROVIDERS) {
    const remaining = QUOTE_FIELDS.filter((f) => !(f in fields));
    if (!remaining.length) break;

    const available = await isAvailable(provider);
    if (!available) { attempts.push({ provider: provider.name, status: 'not_configured' }); continue; }

    try {
      const getFn = symbol.startsWith('^') && provider.getIndexQuote ? provider.getIndexQuote : provider.getQuote;
      const q = await getFn(symbol);
      const timestamp = q.asOf || new Date().toISOString();
      let filled = 0;
      for (const field of remaining) {
        if (q[field] !== null && q[field] !== undefined) {
          fields[field] = { value: q[field], source: provider.name, reliability: provider.reliability, timestamp };
          filled++;
        }
      }
      attempts.push({ provider: provider.name, status: 'ok', fieldsFilled: filled });
    } catch (err) {
      attempts.push({ provider: provider.name, status: 'error', error: err.message });
    }
  }

  for (const field of QUOTE_FIELDS) {
    if (!(field in fields)) {
      fields[field] = { value: null, source: 'unavailable', reliability: null, timestamp: null };
    }
  }

  const availableCount = Object.values(fields).filter((f) => f.source !== 'unavailable').length;
  const dataConfidence = Math.round((availableCount / QUOTE_FIELDS.length) * 100);

  return { symbol: symbol.toUpperCase(), fields, dataConfidence, providerAttempts: attempts, fetchedAt: new Date().toISOString() };
}

// Historical daily candles: try Upstox first (if configured), fall back to
// Yahoo. Unlike the quote, historical is all-or-nothing per provider (a
// partial candle series isn't useful), but which provider supplied it is
// still tracked.
async function getMultiSourceHistorical(symbol, days = 1260) {
  const attempts = [];
  for (const provider of PROVIDERS) {
    const available = await isAvailable(provider);
    if (!available) { attempts.push({ provider: provider.name, status: 'not_configured' }); continue; }
    try {
      const candles = await provider.getHistorical(symbol, days);
      if (candles && candles.length) {
        return { candles, source: provider.name, reliability: provider.reliability, fetchedAt: new Date().toISOString(), providerAttempts: [...attempts, { provider: provider.name, status: 'ok', candleCount: candles.length }] };
      }
      attempts.push({ provider: provider.name, status: 'empty' });
    } catch (err) {
      attempts.push({ provider: provider.name, status: 'error', error: err.message });
    }
  }
  return { candles: [], source: 'unavailable', reliability: null, fetchedAt: new Date().toISOString(), providerAttempts: attempts };
}

// Intraday candles: Upstox only covers the current session; Yahoo covers a
// longer (but still limited) intraday window. Both are tried, Upstox first.
async function getMultiSourceIntraday(symbol, { range = '5d', interval = '5m' } = {}) {
  const attempts = [];
  for (const provider of PROVIDERS) {
    const available = await isAvailable(provider);
    if (!available) { attempts.push({ provider: provider.name, status: 'not_configured' }); continue; }
    try {
      const candles = provider.name === 'upstox'
        ? await provider.getIntradayCandles(symbol, interval === '5m' || interval === '1m' ? '1minute' : '30minute')
        : await provider.getIntradayCandles(symbol, range, interval);
      if (candles && candles.length) {
        return { candles, source: provider.name, reliability: provider.reliability, fetchedAt: new Date().toISOString() };
      }
      attempts.push({ provider: provider.name, status: 'empty' });
    } catch (err) {
      attempts.push({ provider: provider.name, status: 'error', error: err.message });
    }
  }
  return { candles: [], source: 'unavailable', reliability: null, fetchedAt: new Date().toISOString(), providerAttempts: attempts };
}

module.exports = { getMultiSourceQuote, getMultiSourceHistorical, getMultiSourceIntraday, PROVIDERS };
