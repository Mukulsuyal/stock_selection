const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { buildResultsCalendar, incrementalRefresh } = require('../resultsCalendar');
const { startJob, updateJob, endJob, getJob } = require('../progressStore');

router.use(requireAuth);

router.get('/progress/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.json({ percent: 0, message: 'idle', phase: 'idle' });
  res.json(job);
});

// Instant: memory/mongo cache first
router.get('/', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const data = await buildResultsCalendar({ force });
    res.json(data);
  } catch (err) {
    console.error('[results-calendar]', err.message);
    res.status(500).json({ error: err.message || 'Results calendar failed' });
  }
});

// Full / forced rescan with progress (still incremental upsert)
router.post('/refresh', async (req, res) => {
  const jobId = req.body?.jobId || `rc-${Date.now()}`;
  try {
    startJob(jobId, 100, 'Refreshing earnings calendar…');
    const data = await buildResultsCalendar({
      force: true,
      onProgress: (p) => {
        const pct = p.total ? Math.min(99, Math.round((p.completed / p.total) * 100)) : 1;
        updateJob(jobId, pct, {
          phase: 'scan',
          message: p.message || `${p.completed}/${p.total}`,
          detail: p.symbol,
          log: p.symbol ? `→ ${p.symbol}` : p.message,
        });
      },
    });
    endJob(jobId, `Done — ${data.withDateCount || 0} upcoming, ${data.releasedCount || 0} released`);
    res.json({ ...data, jobId });
  } catch (err) {
    endJob(jobId, err.message);
    res.status(500).json({ error: err.message, jobId });
  }
});

// Soft background nudge
router.post('/nudge', async (req, res) => {
  try {
    incrementalRefresh({ forceAll: false }).catch(() => {});
    res.json({ ok: true, message: 'Background incremental refresh started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
