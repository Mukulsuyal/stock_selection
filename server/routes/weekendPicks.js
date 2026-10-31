const express = require('express');
const router = express.Router();
const { requireAuth, requireFeature } = require('../auth');
const WeekendPick = require('../recommendations/WeekendPick');
const { runWeekendResearch, nextMondayDateStr } = require('../weekendResearch');

router.use(requireAuth, requireFeature('weekendpicks'));

// GET /api/weekend-picks?monday=YYYY-MM-DD - defaults to the latest batch
// (the upcoming/most recent Monday that actually has picks saved), so the
// page just works without the person needing to know a date.
router.get('/', async (req, res) => {
  try {
    let { monday } = req.query;
    if (!monday) {
      const latest = await WeekendPick.findOne({}).sort({ forMondayDate: -1 }).lean();
      if (!latest) return res.json({ picks: [], forMondayDate: null, weekendRunDate: null });
      monday = latest.forMondayDate;
    }
    const picks = await WeekendPick.find({ forMondayDate: monday }).sort({ rank: 1 }).lean();
    res.json({
      picks,
      forMondayDate: monday,
      weekendRunDate: picks[0]?.weekendRunDate || null,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load weekend picks right now' });
  }
});

// GET /api/weekend-picks/weeks - every Monday that has a saved batch, for
// an archive/history dropdown.
router.get('/weeks', async (req, res) => {
  try {
    const weeks = await WeekendPick.distinct('forMondayDate');
    res.json({ weeks: weeks.sort().reverse() });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load weekend pick history' });
  }
});

// POST /api/weekend-picks/generate - manual trigger (the scheduled cron
// runs this automatically every Saturday morning; this is for "it's
// already Sunday and nothing's generated yet" or just wanting a fresh run
// with the latest data). {"force": true} regenerates even if this
// Monday's batch already exists.
router.post('/generate', async (req, res) => {
  try {
    const result = await runWeekendResearch({ force: Boolean(req.body?.force) });
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Weekend research run failed. Try again shortly.' });
  }
});

module.exports = router;
