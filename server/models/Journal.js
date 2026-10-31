// server/models/Journal.js — MongoDB (Mongoose), same field shape as before.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const journalSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  symbol: { type: String, required: true },
  side: { type: String, enum: ['buy', 'sell'], required: true },
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },
  horizon: { type: String, default: 'intraday' },
  reason: { type: String, default: null },
  stop_loss: { type: Number, default: null },
  target: { type: Number, default: null },
  trade_date: { type: Date, default: Date.now },
  status: { type: String, default: 'open' },
  exit_price: { type: Number, default: null },
  exit_date: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

const JournalModel = mongoose.models.Journal || mongoose.model('Journal', journalSchema);

function toPublic(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id.toString(), user_id: o.user_id.toString(), symbol: o.symbol, side: o.side,
    quantity: o.quantity, price: o.price, horizon: o.horizon, reason: o.reason ?? null,
    stop_loss: o.stop_loss ?? null, target: o.target ?? null,
    trade_date: o.trade_date, status: o.status, exit_price: o.exit_price ?? null, exit_date: o.exit_date ?? null,
    created_at: o.created_at,
  };
}

const Journal = {
  async create(userId, entry) {
    const doc = await JournalModel.create({
      user_id: userId, symbol: entry.symbol.toUpperCase(), side: entry.side,
      quantity: entry.quantity, price: entry.price, horizon: entry.horizon || 'intraday',
      reason: entry.reason || null, stop_loss: entry.stopLoss ?? null, target: entry.target ?? null,
    });
    return toPublic(doc);
  },
  async list(userId) {
    const docs = await JournalModel.find({ user_id: userId }).sort({ trade_date: -1 });
    return docs.map(toPublic);
  },
  async listOpen(userId) {
    const docs = await JournalModel.find({ user_id: userId, status: 'open' }).sort({ trade_date: -1 });
    return docs.map(toPublic);
  },
  async close(userId, id, { exitPrice }) {
    await JournalModel.updateOne({ user_id: userId, _id: id }, { $set: { status: 'closed', exit_price: exitPrice, exit_date: new Date() } });
    const doc = await JournalModel.findById(id);
    return toPublic(doc);
  },
  async remove(userId, id) {
    return JournalModel.deleteOne({ user_id: userId, _id: id });
  },
};

module.exports = Journal;
