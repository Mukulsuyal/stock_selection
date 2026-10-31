const express = require('express');
const router = express.Router();
const { runCrashRecoveryScan, backtestFallBounce } = require('../crashRecoveryEngine');
const store = require('../crashRecoveryStore');
const { startJob, getJob } = require('../progressStore');

function istMins() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}

async function sessionOk() {
  try {
    const { getTradingDayStatus } = require('../marketCalendar');
    const st = await getTradingDayStatus();
    if (!st.isTradingDay) return { open: false, reason: st.reason || 'Holiday/weekend' };
  } catch (_) {}
  const m = istMins();
  if (m < 9 * 60 + 15 || m >= 15 * 60 + 30) {
    return { open: false, reason: m >= 15 * 60 + 30 ? 'After 15:30 IST' : 'Before 9:15 IST' };
  }
  return { open: true };
}

router.get('/scan', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (!force) {
      const sess = await sessionOk();
      if (!sess.open) {
        return res.json({
          ok: true,
          marketClosed: true,
          skipReason: sess.reason,
          tabs: {
            deep_fall: [],
            strong_fund_temp_fall: [],
            reversal_forming: [],
            bounce_confirmed: [],
            high_downside_risk: [],
          },
          message: 'Crash Recovery pauses outside 9:15–15:30 IST trading days. Research: ?force=1',
        });
      }
    }
    const data = await runCrashRecoveryScan({ forceRefresh: force });
    const all = Object.values(data.tabs || {}).flat();
    store.logCards(all).catch(() => {});
    res.json(data);
  } catch (err) {
    console.error('[crash-recovery]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/failed', async (req, res) => {
  try {
    res.json({ ok: true, signals: await store.listFailed(50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/accuracy', async (req, res) => {
  try {
    res.json(await store.accuracySummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/:symbol', async (req, res) => {
  try {
    res.json(await backtestFallBounce(req.params.symbol));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


// Async scan with live progress (poll /job/:id)
router.post('/scan-async', async (req, res) => {
  try {
    const force = req.body?.force === true || req.query.force === '1';
    if (!force) {
      const sess = await sessionOk();
      if (!sess.open) {
        return res.json({
          ok: true,
          marketClosed: true,
          skipReason: sess.reason,
          message: 'Crash Recovery pauses outside market hours.',
        });
      }
    }
    const jobId = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try { startJob(jobId, 450, 'Starting crash recovery scan…'); } catch (_) {}
    res.json({ ok: true, jobId });
    setImmediate(() => {
      runCrashRecoveryScan({ forceRefresh: force, jobId })
        .then((data) => {
          const all = Object.values(data.tabs || {}).flat();
          store.logCards(all).catch(() => {});
        })
        .catch((e) => {
          console.error('[crash-recovery] async', e.message);
          try {
            const { endJob } = require('../progressStore');
            endJob(jobId, `Failed: ${e.message}`, { ok: false, error: e.message });
          } catch (_) {}
        });
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
