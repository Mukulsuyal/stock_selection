// Symbol -> sector/industry mapping, cached from free fundamentals data
// (Yahoo Finance quoteSummary, same source already used elsewhere in the
// app) so repeated lookups don't need a fresh fetch every time.
const mongoose = require('mongoose');

const SectorMapSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true, index: true },
  sector: { type: String, default: null },
  industry: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.SectorMap || mongoose.model('SectorMap', SectorMapSchema);
