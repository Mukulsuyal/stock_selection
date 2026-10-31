const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { requireAuth, requireAdmin } = require('../auth');

router.use(requireAuth, requireAdmin);

// GET /api/admin/users - everyone who's ever registered, newest first.
router.get('/users', async (req, res) => {
  try {
    const users = await User.listAll();
    res.json({ users, permissionKeys: User.PERMISSION_KEYS });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load users' });
  }
});

// POST /api/admin/users/:id/status  { status: 'approved' | 'pending' | 'rejected' }
router.post('/users/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'pending', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved, pending, or rejected' });
    }
    if (req.params.id === req.user.id && status !== 'approved') {
      return res.status(400).json({ error: "You can't revoke your own admin access from here." });
    }
    const user = await User.setStatus(req.params.id, status);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not update status' });
  }
});

// POST /api/admin/users/:id/role  { role: 'admin' | 'user' }
router.post('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be admin or user' });
    if (req.params.id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: "You can't demote yourself - have another admin do it." });
    }
    const user = await User.setRole(req.params.id, role);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not update role' });
  }
});

// POST /api/admin/users/:id/permissions  { journal: true, watchlist: false, ... }
// Partial updates only - unspecified keys keep their current value (see
// User.setPermissions, which merges rather than replaces).
router.post('/users/:id/permissions', async (req, res) => {
  try {
    const updates = {};
    for (const key of User.PERMISSION_KEYS) {
      if (typeof req.body[key] === 'boolean') updates[key] = req.body[key];
    }
    const user = await User.setPermissions(req.params.id, updates);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not update permissions' });
  }
});

module.exports = router;
