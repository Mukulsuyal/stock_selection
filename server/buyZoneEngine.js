// server/buyZoneEngine.js
// Buy-zone STATE MACHINE - turns "is the price near my entry" into one of
// a fixed set of explicit states instead of a plain yes/no in-zone check.
// The important behavioural rule this enforces: once a pick has actually
// hit its logged target or stop loss (per the persisted Recommendation
// doc, not just today's live price), we never show a fresh BUY signal for
// that same call again - the trade is done, whether it worked or not.
const ZONE_STATES = {
  BUY_ZONE: 'BUY_ZONE',
  BELOW_ZONE: 'BELOW_ZONE',
  ABOVE_ZONE: 'ABOVE_ZONE',
  WAIT_FOR_RETEST: 'WAIT_FOR_RETEST',
  TARGET_HIT: 'TARGET_HIT',
  STOP_LOSS_HIT: 'STOP_LOSS_HIT',
  EXPIRED: 'EXPIRED',
  INVALIDATED: 'INVALIDATED',
};

const ZONE_STATE_LABELS = {
  BUY_ZONE: '✅ In buy zone',
  BELOW_ZONE: '⏳ Below buy zone',
  ABOVE_ZONE: '⏫ Ran past buy zone',
  WAIT_FOR_RETEST: '🔁 Wait for retest',
  TARGET_HIT: '🎯 Target already hit',
  STOP_LOSS_HIT: '🛑 Stop loss already hit',
  EXPIRED: '⌛ Setup expired',
  INVALIDATED: '⚠️ Invalidated',
};

// How many TRADING days (weekends and NSE holidays excluded - see
// countTradingDaysBetween in server/marketCalendar.js) an original pick is
// still considered "live" (i.e. its entry/SL/target plan is still the one
// to trust) if it hasn't hit target or SL yet. Past this, treat it as
// stale rather than pretend the old plan still applies.
const EXPIRY_DAYS = { intraday: 1, short_term: 10, long_term: 45, momentum: 10, reversal: 10, golden_diamond: 15, golden_gold: 15, golden_silver: 12, golden_bronze: 10 };

const { countTradingDaysBetween } = require('./marketCalendar');

// `priorRec` = the most recent logged Recommendation doc for this symbol
// (any category), or null if this is an ad-hoc/unlogged read (e.g. a
// direct search that was never in Top Picks). `horizon` = the analysis's
// suggestedHorizon, used to size the expiry window. Async because expiry
// is measured in TRADING days, which needs the holiday calendar (Mongo).
async function computeZoneState({ analysis, priorRec = null, horizon = 'short_term' }) {
  const p = analysis.tradePlan;
  if (!p || p.entryLow == null || p.stopLoss == null || p.target == null) {
    return { state: ZONE_STATES.INVALIDATED, label: ZONE_STATE_LABELS.INVALIDATED, reason: 'No valid trade plan (missing entry/SL/target) for this read.' };
  }

  // Logical-consistency check (item 3 in the spec: entry/SL/target must
  // make sense together) - for a long setup, SL must sit below the entry
  // zone and target must sit above it. If not, don't present it as a plan.
  if (!(p.stopLoss < p.entryLow && p.target > p.entryHigh)) {
    return {
      state: ZONE_STATES.INVALIDATED,
      label: ZONE_STATE_LABELS.INVALIDATED,
      reason: `Entry/SL/Target aren't logically consistent (SL ₹${p.stopLoss}, entry ₹${p.entryLow}–₹${p.entryHigh}, target ₹${p.target}).`,
    };
  }

  // A persisted outcome always wins over a fresh live read - a symbol
  // whose original call already hit target or SL is not a new buy today.
  if (priorRec) {
    if (priorRec.hitTarget) {
      return {
        state: ZONE_STATES.TARGET_HIT,
        label: ZONE_STATE_LABELS.TARGET_HIT,
        reason: `Target ₹${priorRec.target} was already hit (originally flagged ₹${priorRec.recommendedPrice} on ${priorRec.recommendedDate}). Not a fresh buy on this call.`,
      };
    }
    if (priorRec.hitStopLoss) {
      return {
        state: ZONE_STATES.STOP_LOSS_HIT,
        label: ZONE_STATE_LABELS.STOP_LOSS_HIT,
        reason: `Stop loss ₹${priorRec.stopLoss} was already hit (originally flagged ₹${priorRec.recommendedPrice} on ${priorRec.recommendedDate}). That call is closed - re-evaluate fresh rather than re-entering on the same plan.`,
      };
    }
    const today = new Date().toISOString().slice(0, 10);
    const ageDays = await countTradingDaysBetween(priorRec.recommendedDate, today);
    const maxAge = EXPIRY_DAYS[horizon] ?? EXPIRY_DAYS.short_term;
    if (ageDays > maxAge) {
      return {
        state: ZONE_STATES.EXPIRED,
        label: ZONE_STATE_LABELS.EXPIRED,
        reason: `Originally flagged ${ageDays} trading day(s) ago — ${horizon.replace('_', ' ')} setups are treated as stale after ${maxAge} trading days without hitting target or SL. Treat this as a fresh read, not the old plan.`,
      };
    }
  }

  const price = analysis.price;
  if (price >= p.entryLow && price <= p.entryHigh) {
    return { state: ZONE_STATES.BUY_ZONE, label: ZONE_STATE_LABELS.BUY_ZONE, reason: `Price ₹${price} is inside the suggested entry ₹${p.entryLow}–₹${p.entryHigh}.` };
  }
  if (price < p.entryLow) {
    return {
      state: ZONE_STATES.BELOW_ZONE,
      label: ZONE_STATE_LABELS.BELOW_ZONE,
      reason: `Price ₹${price} is below the entry zone (₹${p.entryLow}–₹${p.entryHigh}) — could fall further before it's a valid entry.`,
    };
  }
  // Above the zone - distinguish "just barely poked through, wait for a
  // retest" from "ran away, this call is missed" by how far past it is.
  const overrunPct = ((price - p.entryHigh) / p.entryHigh) * 100;
  if (overrunPct <= 1.5) {
    return {
      state: ZONE_STATES.WAIT_FOR_RETEST,
      label: ZONE_STATE_LABELS.WAIT_FOR_RETEST,
      reason: `Price ₹${price} is only marginally above the entry zone (₹${p.entryLow}–₹${p.entryHigh}) — wait for a pullback/retest into the zone rather than chasing.`,
    };
  }
  return {
    state: ZONE_STATES.ABOVE_ZONE,
    label: ZONE_STATE_LABELS.ABOVE_ZONE,
    reason: `Price ₹${price} has run well past the entry zone (₹${p.entryLow}–₹${p.entryHigh}) — this specific entry is missed, don't chase it.`,
  };
}

module.exports = { ZONE_STATES, ZONE_STATE_LABELS, computeZoneState };
