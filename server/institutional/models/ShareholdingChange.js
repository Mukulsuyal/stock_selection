// Quarterly shareholding pattern (Public %, FII %, DII %) per company.
//
// STATUS: schema only, NOT currently populated. This data is published
// quarterly by each listed company as a corporate filing (PDF/XBRL) on
// BSE/NSE - there isn't a simple bulk free API for it, and reliably
// parsing thousands of per-company quarterly filings isn't something
// buildable/verifiable without live testing. Kept as a real schema (not a
// fake one) so a future collector or manually-imported data can populate
// it - API responses honestly return `not_available` until then.
const mongoose = require('mongoose');

const ShareholdingChangeSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  quarter: { type: String, required: true, index: true }, // e.g. "2026-Q2"
  publicPct: { type: Number, default: null },
  fiiPct: { type: Number, default: null },
  diiPct: { type: Number, default: null },
  publicPctChange: { type: Number, default: null },  // vs previous quarter
  fiiPctChange: { type: Number, default: null },
  diiPctChange: { type: Number, default: null },
  source: { type: String, default: 'BSE/NSE filings (not yet wired)' },
  updatedAt: { type: Date, default: Date.now },
});
ShareholdingChangeSchema.index({ symbol: 1, quarter: 1 }, { unique: true });

module.exports = mongoose.models.ShareholdingChange || mongoose.model('ShareholdingChange', ShareholdingChangeSchema);
