const express = require('express');
const router = express.Router();
const { requireAuth, requireFeature } = require('../auth');
const UserSettings = require('../models/UserSettings');
const { getTradingStatus } = require('../riskGuardrails');

router.use(requireAuth, requireFeature('settings'));

router.get('/', async (req, res) => {
  try {
    res.json({ settings: await UserSettings.getFor(req.user.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

router.put('/', async (req, res) => {
  try {
    res.json({ settings: await UserSettings.update(req.user.id, req.body) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not update settings' });
  }
});

// GET /api/settings/trading-status — today's daily-loss/max-trades/cooldown state
router.get('/trading-status', async (req, res) => {
  try {
    res.json({ status: await getTradingStatus(req.user.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load trading status' });
  }
});

module.exports = router;
