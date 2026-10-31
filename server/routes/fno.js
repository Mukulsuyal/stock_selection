/**
 * F&O routes — scan only on demand (no background cron).
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { runFnoIntelligence } = require('../fno/analyzer');
const riskState = require('../fno/riskState');
const marketData = require('../marketData');
const { INDEXES } = require('../fno/instruments');

router.use(requireAuth);

router.get('/intelligence', async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.email || 'global';
    const data = await runFnoIntelligence(String(userId));
    res.json(data);
  } catch (err) {
    console.error('[fno/intelligence]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Intraday candles for F&O index chart — lazy, only when UI asks */
router.get('/chart', async (req, res) => {
  try {
    const key = String(req.query.index || 'NIFTY').toUpperCase();
    const interval = String(req.query.interval || '5m');
    const allowed = ['1m', '5m', '15m', '1h', '1d'];
    if (!allowed.includes(interval)) {
      return res.status(400).json({ error: 'interval must be 1m|5m|15m|1h|1d' });
    }
    const cfg = INDEXES.find((i) => i.key === key);
    if (!cfg) return res.status(400).json({ error: 'index must be NIFTY|BANKNIFTY|SENSEX' });

    const range = interval === '1m' ? '1d' : interval === '5m' ? '5d' : interval === '15m' ? '5d' : interval === '1h' ? '1mo' : '3mo';
    let candles = [];
    try {
      if (interval === '1d') {
        const daily = await marketData.getHistorical(cfg.yahoo, 90);
        candles = (daily || []).map((c) => ({
          t: c.date || c.time,
          o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
        }));
      } else {
        const raw = await marketData.getIntradayCandles(cfg.yahoo, range, interval);
        candles = (raw || []).map((c) => ({
          t: c.time || c.date,
          o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
        }));
      }
    } catch (err) {
      return res.status(502).json({ error: err.message, index: key, interval });
    }
    res.json({
      index: key,
      yahoo: cfg.yahoo,
      interval,
      count: candles.length,
      candles: candles.filter((x) => Number.isFinite(Number(x.c))),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/risk-state', async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.email || 'global';
    const state = await riskState.getState(String(userId));
    const gate = riskState.canTrade(state);
    res.json({ state, canTrade: gate.ok, reason: gate.reason || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/outcome', async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.email || 'global';
    const pnl = Number(req.body?.pnl);
    if (!Number.isFinite(pnl)) return res.status(400).json({ error: 'pnl number required (₹)' });
    const r = await riskState.recordOutcome(String(userId), { pnl });
    const state = await riskState.getState(String(userId));
    res.json({ ok: true, recorded: r, state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    module: 'fno-intelligence',
    indexes: ['NIFTY', 'BANKNIFTY', 'SENSEX'],
    lazy: true,
    note: 'Scan + chart only on user request',
  });
});

module.exports = router;
