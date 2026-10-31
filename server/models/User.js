// server/models/User.js — MongoDB (Mongoose). Exposes the same shape the
// app already used (id, name, email, password_hash, created_at) so routes
// elsewhere don't need to change just because the storage engine did.
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Every tab/section an admin can individually grant or withhold. Kept as a
// flat list (not nested) so it's trivial to render as a checklist in the
// Admin Panel and to spread sensible defaults from.
const PERMISSION_KEYS = [
  'dashboard', 'watchlist', 'alerts', 'journal', 'screener', 'import',
  'institutional', 'trackrecord', 'weekendpicks', 'modellearning', 'markets', 'ipo', 'multibagger', 'settings',
];

function allPermissions(value) {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, value]));
}

const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  // Defaults here are deliberately the PERMISSIVE side ('approved',
  // full permissions) - this field didn't exist before this feature, so
  // every account created before this update must keep working exactly as
  // it did, not suddenly get locked out. Only NEW registrations (see
  // server/routes/auth.js) explicitly set status: 'pending' and
  // permissions: all-false - the restrictive path is opt-in per new
  // signup, never retroactive.
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  permissions: { type: Object, default: () => allPermissions(true) },
  // Optional — only set during forgot-password flow (new fields, existing keys unchanged)
  resetCode: { type: String, default: null },
  resetCodeExpires: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

const UserModel = mongoose.models.User || mongoose.model('User', userSchema);

function toPublic(doc, includeHash = false) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  const out = {
    id: o._id.toString(), name: o.name, email: o.email, created_at: o.created_at,
    role: o.role || 'user', status: o.status || 'approved',
    permissions: { ...allPermissions(true), ...(o.permissions || {}) },
  };
  if (includeHash) out.password_hash = o.passwordHash;
  return out;
}

// Makes sure exactly one admin exists, without needing a manual migration
// script. Cheap (one `exists` check) once an admin is present, so it's
// safe to call on every server start. Picks, in order: whoever matches
// ADMIN_EMAIL in the environment if set, else the oldest existing account
// (the person who's presumably been using this app solo already) - either
// way, promoted with full permissions and approved status.
async function ensureAdminBootstrap() {
  const anyAdmin = await UserModel.exists({ role: 'admin' });
  if (anyAdmin) return;
  let target = null;
  if (process.env.ADMIN_EMAIL) {
    target = await UserModel.findOne({ email: process.env.ADMIN_EMAIL.toLowerCase() });
  }
  if (!target) target = await UserModel.findOne({}).sort({ created_at: 1 });
  if (!target) return; // no users at all yet - nothing to promote
  target.role = 'admin';
  target.status = 'approved';
  target.permissions = allPermissions(true);
  await target.save();
  console.log(`[auth] bootstrapped admin: ${target.email}`);
}

const User = {
  async create({ name, email, passwordHash, role, status, permissions }) {
    const doc = await UserModel.create({
      name, email: email.toLowerCase(), passwordHash,
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      ...(permissions ? { permissions } : {}),
    });
    return toPublic(doc);
  },
  async findByEmail(email) {
    const doc = await UserModel.findOne({ email: email.toLowerCase() });
    return toPublic(doc, true);
  },
  async findById(id) {
    try {
      const doc = await UserModel.findById(id);
      return toPublic(doc);
    } catch {
      return null; // malformed id etc.
    }
  },
  async count() {
    return UserModel.countDocuments({});
  },
  async listAll() {
    const docs = await UserModel.find({}).sort({ created_at: -1 });
    return docs.map((d) => toPublic(d));
  },
  async setStatus(id, status) {
    const doc = await UserModel.findByIdAndUpdate(id, { $set: { status } }, { new: true });
    return toPublic(doc);
  },
  async setRole(id, role) {
    const doc = await UserModel.findByIdAndUpdate(id, { $set: { role } }, { new: true });
    return toPublic(doc);
  },
  async setPermissions(id, permissions) {
    // Merge, don't overwrite - a partial {journal: true} from the Admin
    // Panel shouldn't silently reset every other permission to its default.
    const existing = await UserModel.findById(id);
    if (!existing) return null;
    const merged = { ...(existing.permissions || {}), ...permissions };
    existing.permissions = merged;
    await existing.save();
    return toPublic(existing);
  },
  async setResetCode(email, code, expiresAt) {
    const doc = await UserModel.findOne({ email: email.toLowerCase() });
    if (!doc) return false;
    doc.resetCode = code;
    doc.resetCodeExpires = expiresAt;
    await doc.save();
    return true;
  },
  async clearResetCode(email) {
    await UserModel.updateOne(
      { email: email.toLowerCase() },
      { $set: { resetCode: null, resetCodeExpires: null } }
    );
  },
  async findByEmailWithReset(email) {
    const doc = await UserModel.findOne({ email: email.toLowerCase() });
    if (!doc) return null;
    return {
      ...toPublic(doc, true),
      resetCode: doc.resetCode || null,
      resetCodeExpires: doc.resetCodeExpires || null,
    };
  },
  async updatePasswordHash(email, passwordHash) {
    const doc = await UserModel.findOneAndUpdate(
      { email: email.toLowerCase() },
      { $set: { passwordHash, resetCode: null, resetCodeExpires: null } },
      { new: true }
    );
    return toPublic(doc);
  },
  ensureAdminBootstrap,
  PERMISSION_KEYS,
};

module.exports = User;
