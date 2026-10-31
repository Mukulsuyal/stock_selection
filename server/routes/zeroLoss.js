const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { evaluateSymbol, defendPosition, scanUniverseTop } = require('../zeroLossEngine');
const marketData = require('../marketData');
const { analyze } = require('../indicators');
const { getMarketTrend } = require('../marketTrend');
const { estimatePathProbabilities } = require('../probabilityEstimator');

router.use(requireAuth);

router.get('/scan', async (req, res) => {
  try {
    const data = await scanUniverseTop({ limit: Number(req.query.limit) || 5 });
    res.json(data);
  } catch (err) {
    console.error('[zero-loss]', err.message);
    res.status(500).json({ error: err.message || 'Zero-loss scan failed' });
  }
});

router.get('/:symbol', async (req, res) => {
  try {
    const includeBacktest = req.query.backtest === '1';
    const data = await evaluateSymbol(req.params.symbol, { includeBacktest });
    res.json(data);
  } catch (err) {
    console.error('[zero-loss]', err.message);
    res.status(502).json({ error: err.message || 'Evaluate failed' });
  }
});

router.post('/defend', async (req, res) => {
  try {
    const { symbol, entryPrice, userStance } = req.body || {};
    if (!symbol || entryPrice == null) {
      return res.status(400).json({ error: 'symbol and entryPrice required' });
    }
    const sym = String(symbol).toUpperCase();
    const [candles, quote, marketContext] = await Promise.all([
      marketData.getHistorical(sym, 400),
      marketData.getQuote(sym),
      getMarketTrend().catch(() => ({})),
    ]);
    const analysis = analyze(candles, quote, marketContext);
    const path = estimatePathProbabilities(candles, { lookAheadDays: 10 });
    const defense = defendPosition({
      entryPrice: Number(entryPrice),
      price: quote.lastPrice ?? analysis.price,
      path,
      analysis,
      marketTrend: marketContext?.trend || marketContext?.todayDirection,
      userStance,
    });
    res.json({
      symbol: sym,
      price: quote.lastPrice ?? analysis.price,
      entryPrice: Number(entryPrice),
      defense,
      pathSummary: {
        sampleSize: path.sampleSize,
        p5Before2: path.p5Before2,
        avgMaePct: path.avgMaePct,
        status: path.status,
      },
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
