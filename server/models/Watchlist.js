// server/models/Watchlist.js — MongoDB (Mongoose), same field shape as before.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const watchlistSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  symbol: { type: String, required: true },
  horizon: { type: String, default: 'short_term' },
  note: { type: String, default: null },
  last_verdict: { type: String, default: null },
  last_score: { type: Number, default: null },
  last_checked_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });
watchlistSchema.index({ user_id: 1, symbol: 1 }, { unique: true });

const WatchlistModel = mongoose.models.Watchlist || mongoose.model('Watchlist', watchlistSchema);

function toPublic(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id.toString(), user_id: o.user_id.toString(), symbol: o.symbol, horizon: o.horizon,
    note: o.note ?? null, last_verdict: o.last_verdict ?? null, last_score: o.last_score ?? null,
    last_checked_at: o.last_checked_at ?? null, created_at: o.created_at,
  };
}

const Watchlist = {
  async add(userId, symbol, horizon, note) {
    const sym = symbol.toUpperCase();
    const doc = await WatchlistModel.findOneAndUpdate(
      { user_id: userId, symbol: sym },
      { $set: { horizon: horizon || 'short_term', note: note || null }, $setOnInsert: { user_id: userId, symbol: sym } },
      { upsert: true, new: true }
    );
    return toPublic(doc);
  },
  async list(userId) {
    const docs = await WatchlistModel.find({ user_id: userId }).sort({ created_at: -1 });
    return docs.map(toPublic);
  },
  async remove(userId, symbol) {
    return WatchlistModel.deleteOne({ user_id: userId, symbol: symbol.toUpperCase() });
  },
  // Every watchlist row across every user, with their email attached - used
  // by the hourly watchlistChecker to send digest emails.
  async allWithUsers() {
    const docs = await WatchlistModel.find({}).populate('user_id', 'email');
    return docs
      .filter((d) => d.user_id) // skip rows whose user got deleted
      .map((d) => ({
        id: d._id.toString(), user_id: d.user_id._id.toString(), user_email: d.user_id.email,
        symbol: d.symbol, last_verdict: d.last_verdict,
      }));
  },
  async updateVerdict(id, verdict, score) {
    await WatchlistModel.updateOne({ _id: id }, { $set: { last_verdict: verdict, last_score: score, last_checked_at: new Date() } });
  },
};

module.exports = Watchlist;
