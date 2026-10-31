// Daily FII/DII cash-market trading activity (buy/sell/net), one document
// per (date, category). Source: NSE India's free provisional daily figures.
const mongoose = require('mongoose');

const FiiDiiFlowSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true }, // YYYY-MM-DD
  category: { type: String, enum: ['FII', 'DII'], required: true, index: true },
  buyValueCr: { type: Number, required: true },   // ₹ crore
  sellValueCr: { type: Number, required: true },  // ₹ crore
  netValueCr: { type: Number, required: true },   // ₹ crore (buy - sell)
  source: { type: String, default: 'NSE' },
  fetchedAt: { type: Date, default: Date.now },
});
FiiDiiFlowSchema.index({ date: 1, category: 1 }, { unique: true }); // prevent duplicate inserts

module.exports = mongoose.models.FiiDiiFlow || mongoose.model('FiiDiiFlow', FiiDiiFlowSchema);
