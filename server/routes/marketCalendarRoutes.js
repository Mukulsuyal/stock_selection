const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { getTradingDayStatus } = require('../marketCalendar');
const MarketHoliday = require('../models/MarketHoliday');

// Public - no login needed, the frontend checks this to decide whether to
// show "market holiday today" instead of attempting live auto-refresh.
router.get('/status', async (req, res) => {
  try {
    const status = await getTradingDayStatus();
    res.json({ status });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Could not check market calendar right now' });
  }
});

router.get('/holidays', requireAuth, async (req, res) => {
  try {
    const year = req.query.year;
    const filter = year ? { date: { $regex: `^${year}` } } : {};
    const holidays = await MarketHoliday.find(filter).sort({ date: 1 }).lean();
    res.json({ holidays });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load holiday list' });
  }
});

router.post('/holidays', requireAuth, async (req, res) => {
  try {
    const { date, name } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'date (YYYY-MM-DD) and name required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const holiday = await MarketHoliday.findOneAndUpdate(
      { date }, { $set: { date, name } }, { upsert: true, new: true }
    ).lean();
    res.json({ holiday });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not save holiday' });
  }
});

router.delete('/holidays/:date', requireAuth, async (req, res) => {
  try {
    await MarketHoliday.deleteOne({ date: req.params.date });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not remove holiday' });
  }
});

module.exports = router;
