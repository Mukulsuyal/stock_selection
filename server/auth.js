// server/auth.js
// Password hashing + JWT helpers + auth middleware
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

async function hashPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // The JWT itself can be valid (signature + expiry) while pointing at a
  // user that no longer exists in THIS database - e.g. after the DB was
  // reset/replaced but the browser still has an old token saved. Catch
  // that here with a clear message instead of letting it blow up later.
  try {
    const user = await User.findById(payload.id);
    if (!user) {
      return res.status(401).json({ error: 'Your session refers to an account that no longer exists on this server — please log out and sign in (or register) again.' });
    }
    // Always re-derive role/status/permissions from the DB, not the JWT
    // payload - an admin approving someone, changing their permissions, or
    // revoking access must take effect immediately, not only once their
    // token happens to expire and get reissued.
    req.user = { ...payload, role: user.role, status: user.status, permissions: user.permissions };
    // /auth/me is deliberately exempt from the approval gate below - a
    // pending/rejected user still needs to be able to ask "what's my own
    // status" so the frontend can show the right screen, rather than being
    // stuck on a blank error with no way to find out why.
    const isSelfCheck = req.path === '/me' || req.originalUrl.endsWith('/api/auth/me');
    if (!isSelfCheck && user.status !== 'approved') {
      return res.status(403).json({
        error: user.status === 'pending'
          ? 'Your account is waiting for admin approval.'
          : 'Your account access has been revoked. Contact the admin.',
        accountStatus: user.status,
      });
    }
    next();
  } catch (err) {
    console.error('[requireAuth] lookup failed:', err.message);
    res.status(503).json({ error: 'Could not verify session right now — the database may be unreachable. Try again shortly.' });
  }
}

// Layer on top of requireAuth: only lets admins through. Always use AFTER
// requireAuth (needs req.user.role already set).
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Layer on top of requireAuth for a specific tab/feature: lets the request
// through if the user has that permission OR is an admin (admins always
// see everything, regardless of their own permissions grid). Usage:
// router.use(requireAuth, requireFeature('journal')).
function requireFeature(key) {
  return (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    if (req.user?.permissions?.[key]) return next();
    res.status(403).json({ error: `You don't have access to this feature. Ask your admin to enable "${key}".`, feature: key });
  };
}

module.exports = { hashPassword, comparePassword, signToken, requireAuth, requireAdmin, requireFeature };
