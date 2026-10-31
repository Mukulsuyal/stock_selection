const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { dispatch } = require('../mobileNotify');

router.use(requireAuth);

// POST /api/mobile-alert/test  { message?: string }
router.post('/test', async (req, res) => {
  try {
    const text = req.body?.message || 'StockLens test alert OK — agar ye dikhe to WhatsApp connect hai.';
    // unique key so cooldown never blocks manual test
    const r = await dispatch(text, `test:${Date.now()}`);
    console.log('[mobile-alert/test]', JSON.stringify(r));
    res.json({
      ...r,
      hint: !r.ok
        ? 'Terminal me [mobileNotify] lines dekho. Common: (1) ALERT_PHONE=+91 + 10 digits (2) TWILIO_WHATSAPP_FROM=whatsapp:+1... no spaces (3) WhatsApp sandbox join from same number'
        : 'Check WhatsApp inbox',
    });
  } catch (err) {
    console.error('[mobile-alert/test] exception', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// GET status (no secrets)
router.get('/status', (req, res) => {
  const phone = process.env.ALERT_PHONE || '';
  res.json({
    enabled: String(process.env.ALERT_MOBILE_ENABLED || 'true').toLowerCase() !== 'false',
    channels: (process.env.ALERT_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean),
    phoneSet: Boolean(phone),
    phonePreview: phone ? phone.slice(0, 4) + '***' + phone.slice(-2) : null,
    twilioSidSet: Boolean(process.env.TWILIO_ACCOUNT_SID),
    twilioTokenSet: Boolean(process.env.TWILIO_AUTH_TOKEN),
    whatsappFromSet: Boolean(process.env.TWILIO_WHATSAPP_FROM),
    whatsappFromPreview: process.env.TWILIO_WHATSAPP_FROM
      ? String(process.env.TWILIO_WHATSAPP_FROM).replace(/\s/g, '')
      : null,
  });
});

module.exports = router;
