const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const {
  runTomorrowConviction,
  getLatestTomorrowConviction,
  morningRecheck,
  resolveTomorrowOutcomes,
  getTomorrowLearningStats,
  activeHoldCoach,
} = require('../tomorrowConviction');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const data = force ? await runTomorrowConviction({ force: true }) : await getLatestTomorrowConviction();
    res.json(data);
  } catch (err) {
    console.error('[tomorrow-conviction]', err.message);
    res.status(500).json({ error: err.message || 'Tomorrow conviction failed' });
  }
});

router.post('/run', async (req, res) => {
  try {
    const data = await runTomorrowConviction({ force: true });
    res.json(data);
  } catch (err) {
    console.error('[tomorrow-conviction run]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/morning-recheck', async (req, res) => {
  try {
    const data = await morningRecheck();
    res.json(data);
  } catch (err) {
    console.error('[tomorrow-conviction morning]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/resolve-outcomes', async (req, res) => {
  try {
    const data = await resolveTomorrowOutcomes();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/hold-coach', async (req, res) => {
  try {
    const data = await activeHoldCoach();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/learning', async (req, res) => {
  try {
    const data = await getTomorrowLearningStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
