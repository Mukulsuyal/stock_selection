// server/routes/upstoxAuth.js
// One-time (well, once-daily) browser authorization flow for Upstox.
// Visit /api/auth/upstox/login, log into Upstox, get redirected back here,
// and the access token gets stored for the aggregator to use as the
// primary data source going forward (until it expires ~3:30 AM IST).
const express = require('express');
const router = express.Router();
const upstox = require('../dataProviders/upstoxProvider');

router.get('/login', (req, res) => {
  if (!process.env.UPSTOX_API_KEY || !process.env.UPSTOX_API_SECRET || !process.env.UPSTOX_REDIRECT_URI) {
    return res.status(400).send('Upstox is not configured - set UPSTOX_API_KEY, UPSTOX_API_SECRET, and UPSTOX_REDIRECT_URI in .env first.');
  }
  res.redirect(upstox.getAuthorizeUrl());
});

router.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Upstox authorization failed: ${error}`);
  if (!code) return res.status(400).send('No authorization code received from Upstox.');
  try {
    await upstox.exchangeCodeForToken(code);
    res.send('<h2>Upstox connected ✅</h2><p>You can close this tab. Live data will now try Upstox first, falling back to Yahoo Finance for anything Upstox doesn\'t have.</p>');
  } catch (err) {
    console.error('[upstoxAuth] token exchange failed:', err.message);
    res.status(500).send(`Could not complete Upstox authorization: ${err.message}`);
  }
});

router.get('/status', async (req, res) => {
  const configured = await upstox.isConfigured();
  res.json({ upstoxConfigured: configured });
});

module.exports = router;
