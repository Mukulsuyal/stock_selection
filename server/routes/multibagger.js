const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { isMongoConfigured } = require('../mongo');
const {
  runMultibaggerResearch,
  updateMultibaggerPrices,
  getLatestBatch,
  getLastMultibaggerMeta,
} = require('../multibaggerResearch');
const MultibaggerPick = require('../models/MultibaggerPick');
const { getJob } = require('../progressStore');
const { runFallenStrongResearch, getLastFallenStrong } = require('../fallenStrongResearch');

router.use(requireAuth);
router.use((req, res, next) => {
  if (req.user?.role === 'admin') return next();
  if (req.user?.permissions && req.user.permissions.multibagger === false) {
    return res.status(403).json({ error: 'Multi-Bagger Radar is disabled for your account.' });
  }
  next();
});

router.get('/latest', async (req, res) => {
  if (!isMongoConfigured()) return res.json({ batchDate: null, picks: [], note: 'Mongo not configured' });
  try {
    const data = await getLatestBatch();
    const meta = typeof getLastMultibaggerMeta === 'function' ? getLastMultibaggerMeta() : {};
    const picks = data.picks || [];
    res.json({
      ...data,
      nearMisses: meta.nearMisses || [],
      filterReject: meta.filterReject || null,
      note: picks.length
        ? (data.note || 'Quality-gated multi-bagger candidates. Hold 15–30+ days if thesis holds. Not a multi-bag guarantee.')
        : (meta.note || 'No batch yet. Run deep research — near-miss list dikhega agar koi almost clear ho.'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', async (req, res) => {
  if (!isMongoConfigured()) return res.json({ batches: [] });
  try {
    const dates = await MultibaggerPick.distinct('batchDate');
    dates.sort().reverse();
    res.json({ batches: dates.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batch/:date', async (req, res) => {
  if (!isMongoConfigured()) return res.json({ picks: [] });
  try {
    const picks = await MultibaggerPick.find({ batchDate: req.params.date }).sort({ rank: 1 }).lean();
    res.json({ batchDate: req.params.date, picks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual / admin-friendly generate (any approved user can trigger; heavy scan)
router.get('/progress/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.json({ percent: 0, message: 'No active job', phase: 'idle' });
  res.json(job);
});

router.post('/generate', async (req, res) => {
  if (!isMongoConfigured()) return res.status(503).json({ error: 'Mongo required' });
  const jobId = req.body?.jobId || `mb-${Date.now()}`;
  try {
    const result = await runMultibaggerResearch({ force: Boolean(req.body?.force) || req.query.force === '1', jobId });
    res.json({ ...result, jobId });
  } catch (err) {
    console.error('[multibagger/generate]', err.message);
    res.status(500).json({ error: err.message || 'Research failed', jobId });
  }
});

router.post('/refresh-prices', async (req, res) => {
  try {
    const result = await updateMultibaggerPrices();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.get('/fallen-strong', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force) {
      const last = await getLastFallenStrong();
      if (last) return res.json({ ...last, fromCache: true });
    }
    const data = await runFallenStrongResearch({});
    res.json(data);
  } catch (err) {
    console.error('[fallen-strong]', err.message);
    res.status(500).json({ error: err.message || 'fallen-strong failed' });
  }
});

router.post('/fallen-strong/run', async (req, res) => {
  const jobId = `fallen-strong-${Date.now()}`;
  res.json({ ok: true, jobId, message: 'Scan started' });
  runFallenStrongResearch({ jobId }).catch((e) => console.error('[fallen-strong]', e.message));
});

module.exports = router;

