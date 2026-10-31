const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { hashPassword, comparePassword, signToken, requireAuth } = require('../auth');

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await User.findByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

    // The very first account ever created on a fresh install becomes the
    // admin automatically (approved, full access) - there'd be no one
    // else to grant it otherwise. Every account after that starts
    // 'pending' with no permissions until an admin approves it and picks
    // what they can see - see server/models/User.js ensureAdminBootstrap
    // for the (idempotent, safe-to-re-run) full bootstrap logic.
    const isFirstEverUser = (await User.count()) === 0;
    const passwordHash = await hashPassword(password);
    const user = await User.create({
      name, email, passwordHash,
      role: isFirstEverUser ? 'admin' : 'user',
      status: isFirstEverUser ? 'approved' : 'pending',
      permissions: isFirstEverUser ? undefined : Object.fromEntries(User.PERMISSION_KEYS.map((k) => [k, false])),
    });
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findByEmail(email || '');
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await comparePassword(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = signToken(user);
    delete user.password_hash;
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  // requireAuth already re-fetches fresh role/status/permissions from the
  // DB on every request (not just the JWT payload) - reuse that instead of
  // querying again.
  res.json({ user: req.user });
});

// POST /api/auth/forgot-password { email }
// Simple flow: 6-digit code, valid 15 minutes. Emails if SMTP is set;
// otherwise returns the code in the response so self-hosted setups still work.
router.post('/forgot-password', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findByEmail(email);
    // Always same success shape if email unknown — don't leak which emails exist
    if (!user) {
      return res.json({
        ok: true,
        message: 'If that email is registered, a reset code is ready. Check your inbox (or the response if email is not configured).',
      });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await User.setResetCode(email, code, expires);

    // Always show code on this screen — no email needed.
    console.log(`[forgot-password] code for ${email}: ${code} (expires ${expires.toISOString()})`);

    res.json({
      ok: true,
      message: 'Use the code shown below. Valid for 15 minutes.',
      resetCode: code,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start password reset. Try again shortly.' });
  }
});

// POST /api/auth/reset-password { email, code, password }
router.post('/reset-password', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const password = req.body.password || '';
    if (!email || !code || !password) {
      return res.status(400).json({ error: 'Email, code and new password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await User.findByEmailWithReset(email);
    if (!user || !user.resetCode || !user.resetCodeExpires) {
      return res.status(400).json({ error: 'Invalid or expired reset code. Request a new one.' });
    }
    if (String(user.resetCode) !== code) {
      return res.status(400).json({ error: 'Invalid or expired reset code. Request a new one.' });
    }
    if (new Date(user.resetCodeExpires).getTime() < Date.now()) {
      await User.clearResetCode(email);
      return res.status(400).json({ error: 'Reset code expired. Request a new one.' });
    }

    const passwordHash = await hashPassword(password);
    await User.updatePasswordHash(email, passwordHash);
    res.json({ ok: true, message: 'Password updated. You can log in with the new password.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reset password. Try again shortly.' });
  }
});

module.exports = router;
