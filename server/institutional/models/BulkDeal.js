// server/institutional/models/BulkDeal.js
// NSE "Bulk Deals" disclosure - any single-day trade(s) in one stock by one
// client crossing 0.5% of that company's total shares get disclosed by
// name. This is the closest free, real, per-stock proxy for "who's buying/
// selling this stock in size" - NOT the same as full FII/DII participation
// (NSE doesn't break the aggregate cash-market figure down by stock for
// free), but a genuine disclosed large-trade record, not a guess.
const mongoose = require('mongoose');

const BulkDealSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true }, // YYYY-MM-DD
  symbol: { type: String, required: true, index: true },
  clientName: { type: String, required: true },
  dealType: { type: String, enum: ['BUY', 'SELL'], required: true },
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },
  fetchedAt: { type: Date, default: Date.now },
});
// Same client can appear more than once a day for the same stock+side with
// different quantities (multiple trades) - quantity is part of the unique
// key so those aren't accidentally deduped into one.
BulkDealSchema.index({ date: 1, symbol: 1, clientName: 1, dealType: 1, quantity: 1 }, { unique: true });

module.exports = mongoose.models.BulkDeal || mongoose.model('BulkDeal', BulkDealSchema);
