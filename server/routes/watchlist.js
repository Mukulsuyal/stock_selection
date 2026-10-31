const express = require('express');
const router = express.Router();
const { requireAuth, requireFeature } = require('../auth');
const Watchlist = require('../models/Watchlist');
const marketData = require('../marketData');
const { analyze } = require('../indicators');
const { getMarketTrend } = require('../marketTrend');

router.use(requireAuth, requireFeature('watchlist'));

router.get('/', async (req, res) => {
  try {
    res.json({ watchlist: await Watchlist.list(req.user.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load watchlist right now' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { symbol, horizon, note } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const item = await Watchlist.add(req.user.id, symbol, horizon, note);
    res.json({ item });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not add to watchlist right now' });
  }
});

router.delete('/:symbol', async (req, res) => {
  try {
    await Watchlist.remove(req.user.id, req.params.symbol);
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not remove from watchlist right now' });
  }
});

// Recompute verdicts for this user's watchlist RIGHT NOW (doesn't wait for
// the hourly cron, doesn't send email - just updates what's shown in the UI).
router.post('/refresh', async (req, res) => {
  try {
    const items = await Watchlist.list(req.user.id);
    if (!items.length) return res.json({ watchlist: [] });
    const marketContext = await getMarketTrend();
    await Promise.all(items.map(async (item) => {
      try {
        const [quote, candles] = await Promise.all([
          marketData.getQuote(item.symbol),
          marketData.getHistorical(item.symbol, 300),
        ]);
        if (!candles.length) return;
        const result = analyze(candles, quote, marketContext);
        await Watchlist.updateVerdict(item.id, result.verdict, result.score);
      } catch (err) { /* skip this symbol, keep going */ }
    }));
    res.json({ watchlist: await Watchlist.list(req.user.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not refresh watchlist right now' });
  }
});

module.exports = router;
