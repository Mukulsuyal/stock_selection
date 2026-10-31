const express = require('express');
const router = express.Router();
const { requireAuth, requireFeature } = require('../auth');
const Alert = require('../models/Alert');

router.use(requireAuth, requireFeature('alerts'));

router.get('/', async (req, res) => {
  try {
    res.json({ alerts: await Alert.list(req.user.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load alerts right now' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { symbol, condition, targetPrice } = req.body;
    if (!symbol || !condition || !targetPrice) {
      return res.status(400).json({ error: 'symbol, condition (above|below), targetPrice required' });
    }
    if (!['above', 'below'].includes(condition)) {
      return res.status(400).json({ error: "condition must be 'above' or 'below'" });
    }
    const alert = await Alert.create(req.user.id, { symbol, condition, targetPrice: Number(targetPrice) });
    res.json({ alert });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not create alert right now' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Alert.remove(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not remove alert right now' });
  }
});

module.exports = router;
