const express = require('express');
const router = express.Router();
const { runBestReversalPicks } = require('../bestReversalEngine');
const { startJob, getJob } = require('../progressStore');

async function sessionOk() {
  try {
    const { getTradingDayStatus } = require('../marketCalendar');
    const st = await getTradingDayStatus();
    if (!st.isTradingDay) return { open: false, reason: st.reason || 'Holiday/weekend' };
  } catch (_) {}
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const m = ist.getHours() * 60 + ist.getMinutes();
  if (m < 9 * 60 + 15 || m >= 15 * 60 + 30) {
    return { open: false, reason: m >= 15 * 60 + 30 ? 'After 15:30 IST' : 'Before 9:15 IST' };
  }
  return { open: true };
}

router.get('/today', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (!force) {
      const sess = await sessionOk();
      if (!sess.open) {
        return res.json({
          ok: true,
          marketClosed: true,
          skipReason: sess.reason,
          picks: [],
          noTrade: true,
          message: 'Best Reversal Picks pause outside market hours.',
        });
      }
    }
    const data = await runBestReversalPicks({ forceRefresh: force });
    res.json(data);
  } catch (err) {
    console.error('[best-reversal]', err.message);
    res.status(500).json({ error: err.message });
  }
});


router.post('/scan-async', async (req, res) => {
  try {
    const force = req.body?.force === true || req.query.force === '1';
    if (!force) {
      const sess = await sessionOk();
      if (!sess.open) {
        return res.json({ ok: true, marketClosed: true, skipReason: sess.reason, picks: [], noTrade: true });
      }
    }
    const jobId = `br-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try { startJob(jobId, 450, 'Best reversal starting…'); } catch (_) {}
    res.json({ ok: true, jobId });
    setImmediate(() => {
      runBestReversalPicks({ forceRefresh: force, jobId }).catch((e) => {
        console.error('[best-reversal] async', e.message);
        try { require('../progressStore').endJob(jobId, `Failed: ${e.message}`, { ok: false, error: e.message }); } catch (_) {}
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

module.exports = router;

