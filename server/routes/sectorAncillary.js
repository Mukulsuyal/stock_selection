const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const {
  runSectorAncillaryResearch,
  getSectorAncillaryLatest,
} = require('../sectorAncillaryInvest');
const { getJob } = require('../progressStore');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const data = force
      ? await runSectorAncillaryResearch({ force: true })
      : await getSectorAncillaryLatest();
    res.json(data);
  } catch (err) {
    console.error('[sector-ancillary]', err.message);
    res.status(500).json({ error: err.message || 'Sector ancillary research failed' });
  }
});

router.post('/run', async (req, res) => {
  try {
    const jobId = `sector-ancillary-${Date.now()}`;
    // Start async-ish: client can poll progress; we still await full result for simplicity
    // but stream progress via job id returned first if they poll
    res.setHeader('X-Job-Id', jobId);
    const data = await runSectorAncillaryResearch({ force: true, jobId });
    res.json(data);
  } catch (err) {
    console.error('[sector-ancillary run]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fire-and-forget run + poll
router.post('/run-async', async (req, res) => {
  const jobId = `sector-ancillary-${Date.now()}`;
  res.json({ ok: true, jobId, message: 'Scan started — poll /progress/:jobId' });
  runSectorAncillaryResearch({ force: true, jobId }).catch((err) => {
    console.error('[sector-ancillary async]', err.message);
  });
});

router.get('/progress/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.json({ ok: false, status: 'unknown' });
  res.json({ ok: true, ...job });
});

module.exports = router;
