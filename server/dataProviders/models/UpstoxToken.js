// Stores the current Upstox access token (Upstox tokens expire daily
// around 3:30 AM IST - this needs re-authorizing once a day via the OAuth
// flow at /api/auth/upstox/login).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const upstoxTokenSchema = new Schema({
  accessToken: { type: String, required: true },
  obtainedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.UpstoxToken || mongoose.model('UpstoxToken', upstoxTokenSchema);
