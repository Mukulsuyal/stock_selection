const express = require('express');
const router = express.Router();
const { runEarlyOpportunityScan, backtestSymbolSetup } = require('../earlyOpportunityEngine');
const store = require('../earlyOpportunityStore');

function istMinutes() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return { hour: ist.getHours(), minute: ist.getMinutes(), mins: ist.getHours() * 60 + ist.getMinutes() };
}

async function sessionOpen() {
  try {
    const { getTradingDayStatus } = require('../marketCalendar');
    const st = await getTradingDayStatus();
    if (!st.isTradingDay) return { open: false, reason: st.reason || 'Holiday/weekend' };
  } catch (_) {}
  const { mins } = istMinutes();
  if (mins < 9 * 60 + 15 || mins >= 15 * 60 + 30) {
    return { open: false, reason: mins >= 15 * 60 + 30 ? 'After 15:30 IST' : 'Before 9:15 IST' };
  }
  return { open: true };
}

// GET /api/early-opportunity/scan
router.get('/scan', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (!force) {
      const sess = await sessionOpen();
      if (!sess.open) {
        return res.json({
          ok: true,
          marketClosed: true,
          skipReason: sess.reason,
          scanners: {
            deep_fall_reversal: [],
            bottom_formation: [],
            pre_breakout: [],
            early_continuation: [],
          },
          counts: {},
          message: 'Early Opportunity scanners pause outside 9:15–15:30 IST trading days. Use ?force=1 only for research.',
        });
      }
    }
    const data = await runEarlyOpportunityScan({ forceRefresh: force });
    // Soft log active cards (non-blocking)
    const all = Object.values(data.scanners || {}).flat();
    store.logDetections(all).catch(() => {});
    res.json(data);
  } catch (err) {
    console.error('[early-opportunity]', err.message);
    res.status(500).json({ error: 'Early opportunity scan failed', detail: err.message });
  }
});

router.get('/active', async (req, res) => {
  try {
    const rows = await store.listByStatus('active', 80);
    res.json({ ok: true, signals: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/failed', async (req, res) => {
  try {
    const rows = await store.listByStatus('hit_sl', 40);
    const inv = await store.listByStatus('invalidated', 40);
    res.json({ ok: true, signals: [...rows, ...inv] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/accuracy', async (req, res) => {
  try {
    const summary = await store.accuracySummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/:symbol', async (req, res) => {
  try {
    const kind = req.query.kind || 'deep_fall_reversal';
    const result = await backtestSymbolSetup(req.params.symbol, kind);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
