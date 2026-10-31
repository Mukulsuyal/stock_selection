// server/models/Alert.js — MongoDB (Mongoose), same field shape as before.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const alertSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  symbol: { type: String, required: true },
  condition: { type: String, enum: ['above', 'below'], required: true },
  target_price: { type: Number, required: true },
  is_active: { type: Boolean, default: true },
  triggered_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

const AlertModel = mongoose.models.Alert || mongoose.model('Alert', alertSchema);

function toPublic(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id.toString(), user_id: o.user_id.toString(), symbol: o.symbol, condition: o.condition,
    target_price: o.target_price, is_active: o.is_active, triggered_at: o.triggered_at ?? null, created_at: o.created_at,
  };
}

const Alert = {
  async create(userId, { symbol, condition, targetPrice }) {
    const doc = await AlertModel.create({ user_id: userId, symbol: symbol.toUpperCase(), condition, target_price: targetPrice });
    return toPublic(doc);
  },
  async list(userId) {
    const docs = await AlertModel.find({ user_id: userId }).sort({ created_at: -1 });
    return docs.map(toPublic);
  },
  async remove(userId, id) {
    return AlertModel.deleteOne({ user_id: userId, _id: id });
  },
  async allActive() {
    const docs = await AlertModel.find({ is_active: true });
    return docs.map(toPublic);
  },
  async markTriggered(id) {
    await AlertModel.updateOne({ _id: id }, { $set: { is_active: false, triggered_at: new Date() } });
  },
};

module.exports = Alert;
