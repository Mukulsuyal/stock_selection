// server/models/MarketHoliday.js — NSE trading-holiday calendar.
//
// HONEST NOTE: exact festival dates (Diwali, Holi, Eid, etc.) shift every
// year and depend on the lunar calendar - this seed list is a best-effort
// starting point, not a verified-current official NSE calendar (this app
// was built without live internet access to check the exact current
// year's dates against NSE's published circular). Please verify against
// nseindia.com's holiday list and correct/add dates in the Settings tab -
// takes 30 seconds and then every automated feature respects it.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const marketHolidaySchema = new Schema({
  date: { type: String, required: true, unique: true }, // YYYY-MM-DD
  name: { type: String, required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

module.exports = mongoose.models.MarketHoliday || mongoose.model('MarketHoliday', marketHolidaySchema);
