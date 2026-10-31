// User-tracked IPOs for listing-day analysis (separate from stock picks).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ipoWatchSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true },
  companyName: { type: String, default: null },
  issuePrice: { type: Number, required: true },
  listingDate: { type: String, default: null }, // YYYY-MM-DD
  listingOpen: { type: Number, default: null },
  notes: { type: String, default: null },
  lastSignal: { type: String, default: null }, // BUY | WAIT | AVOID
  lastConfidence: { type: Number, default: null },
  lastAnalyzedAt: { type: Date, default: null },
  alertOnBuy: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

ipoWatchSchema.index({ user_id: 1, symbol: 1 }, { unique: true });

const IpoWatchModel = mongoose.models.IpoWatch || mongoose.model('IpoWatch', ipoWatchSchema);

function toPublic(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: o._id.toString(),
    symbol: o.symbol,
    companyName: o.companyName,
    issuePrice: o.issuePrice,
    listingDate: o.listingDate,
    listingOpen: o.listingOpen,
    notes: o.notes,
    lastSignal: o.lastSignal,
    lastConfidence: o.lastConfidence,
    lastAnalyzedAt: o.lastAnalyzedAt,
    alertOnBuy: o.alertOnBuy !== false,
    created_at: o.created_at,
  };
}

const IpoWatch = {
  async list(userId) {
    const docs = await IpoWatchModel.find({ user_id: userId }).sort({ updated_at: -1 });
    return docs.map(toPublic);
  },
  async upsert(userId, data) {
    const symbol = String(data.symbol).toUpperCase().replace(/\.(NS|BO)$/i, '');
    const doc = await IpoWatchModel.findOneAndUpdate(
      { user_id: userId, symbol },
      {
        $set: {
          companyName: data.companyName || null,
          issuePrice: Number(data.issuePrice),
          listingDate: data.listingDate || null,
          listingOpen: data.listingOpen != null ? Number(data.listingOpen) : null,
          notes: data.notes || null,
          alertOnBuy: data.alertOnBuy !== false,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return toPublic(doc);
  },
  async remove(userId, id) {
    return IpoWatchModel.deleteOne({ user_id: userId, _id: id });
  },
  async updateSignal(userId, symbol, { signal, confidence }) {
    await IpoWatchModel.updateOne(
      { user_id: userId, symbol: String(symbol).toUpperCase() },
      { $set: { lastSignal: signal, lastConfidence: confidence, lastAnalyzedAt: new Date() } }
    );
  },
  async listAllAlertable() {
    return IpoWatchModel.find({ alertOnBuy: true }).lean();
  },
};

module.exports = IpoWatch;
