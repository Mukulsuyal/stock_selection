const express = require('express');
const router = express.Router();
const { runMorningStormScan } = require('../morningStormScanner');
const { startJob, getJob } = require('../progressStore');
const store = require('../morningStormStore');
const { adviseManagement, buildManagedPlan } = require('../morningStormManage');
const marketData = require('../marketData');
const stormAlerts = require('../morningStormAlerts');

router.get('/scan', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const data = await runMorningStormScan({ force });
    res.json(data);
  } catch (err) {
    console.error('[morning-storm]', err.message);
    res.status(502).json({ error: err.message || 'Morning storm scan failed' });
  }
});

router.get('/latest', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const data = await runMorningStormScan({ force });
    res.json(data);
  } catch (err) {
    console.error('[morning-storm]', err.message);
    res.status(502).json({ error: err.message || 'Morning storm scan failed' });
  }
});

router.get('/board', async (req, res) => {
  try {
    res.json(await store.getTodayBoard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/monitor', async (req, res) => {
  try {
    const board = await store.getMonitorBoard();
    const live = [];
    for (const row of [...(board.today || []), ...(board.carry || [])]) {
      let price = row.lastPrice ?? row.firstPrice;
      try {
        const q = await marketData.getQuote(row.symbol);
        if (q?.lastPrice != null) price = q.lastPrice;
      } catch (_) {}
      const entry = row.firstPrice;
      const management = adviseManagement({
        entryPrice: entry,
        price,
        userStance: row.userStance || 'open',
        t1Hit: row.t1Hit,
        t2Hit: row.t2Hit,
        t3Hit: row.t3Hit,
      });
      live.push({
        symbol: row.symbol,
        tradeDate: row.tradeDate,
        entryPrice: entry,
        price,
        userStance: row.userStance,
        carryToNextDay: row.carryToNextDay,
        status: row.status,
        managedPlan: row.managedPlan || buildManagedPlan(entry),
        management,
      });
    }
    // dedupe by symbol keep first
    const seen = new Set();
    const uniq = [];
    for (const x of live) {
      if (seen.has(x.symbol)) continue;
      seen.add(x.symbol);
      uniq.push(x);
    }
    res.json({ tradeDate: board.tradeDate, items: uniq });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/confirm', async (req, res) => {
  try {
    const { symbol, action, tradeDate } = req.body || {};
    if (!symbol || !action) return res.status(400).json({ error: 'symbol and action required' });
    const result = await store.confirmUserAction(symbol, action, tradeDate);
    // deactivate watches on exit
    if (result.ok && ['exit','book_full','book_loss'].includes(String(action).toLowerCase())) {
      try {
        const watches = await stormAlerts.getActiveWatches();
        for (const w of watches.filter((x) => x.symbol === String(symbol).toUpperCase())) {
          await stormAlerts.markTriggered(w._id, null);
        }
      } catch (_) {}
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/storm-alerts', async (req, res) => {
  try {
    const active = await stormAlerts.getActiveWatches();
    const recent = await stormAlerts.recentTriggers(20);
    res.json({ active, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/track-record', async (req, res) => {
  try {
    res.json(await store.getTrackRecord());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/scan', async (req, res) => {
  try {
    const jobId = `morning-storm-${Date.now()}`;
    try { startJob(jobId, 100, 'Morning storm starting…'); } catch (_) {}
    res.json({ ok: true, jobId });
    setImmediate(() => {
      runMorningStormScan({ jobId, force: Boolean(req.body?.force) }).catch((e) =>
        console.error('[morning-storm] bg', e.message)
      );
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/job/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

module.exports = router;
