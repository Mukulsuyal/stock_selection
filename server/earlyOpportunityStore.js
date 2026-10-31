/**
 * Signal tracking for Early Opportunity scanners — one collection.
 * First detection fixed; re-scans update lastPrice without inflating sample size.
 */
const mongoose = require('mongoose');
const { connectMongo, isMongoConfigured } = require('./mongo');

const SignalSchema = new mongoose.Schema(
  {
    symbol: { type: String, index: true },
    scanner: { type: String, index: true },
    tradeDate: { type: String, index: true },
    detectedAt: Date,
    detectPrice: Number,
    lastPrice: Number,
    score: Number,
    action: String,
    stage: String,
    confidence: String,
    entry: Number,
    stop: Number,
    target1: Number,
    status: { type: String, default: 'active', index: true },
    maxFavorablePct: Number,
    maxAdversePct: Number,
    resolvedAt: Date,
    resolvePrice: Number,
    notes: String,
  },
  { collection: 'early_opportunity_signals', timestamps: true }
);
SignalSchema.index({ tradeDate: 1, scanner: 1, symbol: 1 }, { unique: true });

let Model;
function model() {
  if (!Model) {
    Model = mongoose.models.EarlyOpportunitySignal || mongoose.model('EarlyOpportunitySignal', SignalSchema);
  }
  return Model;
}

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function logDetections(cards = []) {
  if (!isMongoConfigured() || !cards.length) return { saved: 0, updated: 0 };
  await connectMongo();
  const M = model();
  const tradeDate = todayIST();
  let saved = 0;
  let updated = 0;
  for (const c of cards) {
    try {
      const existing = await M.findOne({ tradeDate, scanner: c.scanner, symbol: c.symbol }).lean();
      if (existing) {
        const detect = existing.detectPrice;
        const last = c.price;
        let mfe = existing.maxFavorablePct;
        let mae = existing.maxAdversePct;
        if (detect != null && last != null && detect > 0) {
          const pct = ((last - detect) / detect) * 100;
          if (mfe == null || pct > mfe) mfe = pct;
          if (mae == null || pct < mae) mae = pct;
        }
        await M.updateOne(
          { _id: existing._id },
          {
            $set: {
              lastPrice: c.price,
              action: c.action,
              stage: c.stage,
              confidence: c.confidence,
              score: c.setupScore ?? c.score,
              maxFavorablePct: mfe,
              maxAdversePct: mae,
            },
          }
        );
        updated += 1;
      } else {
        await M.create({
          tradeDate,
          scanner: c.scanner,
          symbol: c.symbol,
          detectedAt: new Date(),
          detectPrice: c.price,
          lastPrice: c.price,
          score: c.setupScore ?? c.score,
          action: c.action,
          stage: c.stage,
          confidence: c.confidence,
          entry: c.entryZone?.low,
          stop: c.stopLoss,
          target1: c.targets?.t1,
          status: 'active',
        });
        saved += 1;
      }
    } catch (_) {}
  }
  return { saved, updated };
}

async function listByStatus(status = 'active', limit = 50) {
  if (!isMongoConfigured()) return [];
  await connectMongo();
  return model().find({ status }).sort({ detectedAt: -1 }).limit(limit).lean();
}

async function accuracySummary() {
  if (!isMongoConfigured()) {
    return { available: false, note: 'Mongo not configured — no stored signal outcomes yet.' };
  }
  await connectMongo();
  const M = model();
  const all = await M.find({ status: { $in: ['hit_t1', 'hit_sl', 'expired', 'invalidated'] } })
    .limit(2000)
    .lean();
  const n = all.length;
  if (!n) {
    return {
      available: true,
      sampleSize: 0,
      note: 'No resolved signals yet. Accuracy appears after outcomes resolve.',
    };
  }
  const hit = all.filter((x) => x.status === 'hit_t1').length;
  const sl = all.filter((x) => x.status === 'hit_sl').length;
  return {
    available: true,
    sampleSize: n,
    targetHitPct: Number(((hit / n) * 100).toFixed(1)),
    stopHitPct: Number(((sl / n) * 100).toFixed(1)),
    note: n < 30 ? `Small resolved sample n=${n} — do not treat as stable accuracy.` : null,
  };
}

module.exports = { logDetections, listByStatus, accuracySummary, todayIST };
