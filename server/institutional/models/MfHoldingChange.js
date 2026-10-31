// Mutual fund scheme-level stock holdings, month over month.
//
// STATUS: schema only, NOT currently populated by any automated collector.
// AMFI does not centrally publish machine-readable portfolio disclosures -
// each of ~40 AMCs discloses monthly holdings separately, in inconsistent
// PDF/Excel formats on their own websites. Building a reliable scraper for
// all of them isn't something that could be verified working in this
// environment (no live network access to test against), and shipping a
// fragile/guessed scraper would violate the "no fake data" requirement.
//
// This schema exists so a real collector can be plugged in later (or
// holdings CSVs manually exported from an AMC/data vendor can be imported)
// without changing the API contract - until then, all API responses that
// depend on this data honestly report `not_available`.
const mongoose = require('mongoose');

const MfHoldingChangeSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  month: { type: String, required: true, index: true }, // YYYY-MM
  schemeCount: { type: Number, default: null },          // how many schemes hold it
  totalQuantity: { type: Number, default: null },
  previousMonthQuantity: { type: Number, default: null },
  quantityChange: { type: Number, default: null },        // positive = accumulation, negative = reduction
  changeType: { type: String, enum: ['accumulation', 'reduction', 'unchanged', null], default: null },
  source: { type: String, default: 'AMFI (not yet wired)' },
  updatedAt: { type: Date, default: Date.now },
});
MfHoldingChangeSchema.index({ symbol: 1, month: 1 }, { unique: true });

module.exports = mongoose.models.MfHoldingChange || mongoose.model('MfHoldingChange', MfHoldingChangeSchema);
