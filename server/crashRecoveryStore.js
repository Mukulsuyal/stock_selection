/**
 * Crash Recovery signal tracking — one collection, no sample inflation.
 */
const mongoose = require('mongoose');
const { connectMongo, isMongoConfigured } = require('./mongo');

const Schema = new mongoose.Schema(
  {
    symbol: { type: String, index: true },
    tradeDate: { type: String, index: true },
    tab: String,
    firstSeenAt: Date,
    firstPrice: Number,
    lastPrice: Number,
    fallPct: Number,
    status: { type: String, default: 'active' },
    planStatus: String,
    techScore: Number,
    fundLabel: String,
    bounceProb3: Number,
    downProb3: Number,
    sampleSizeAtPick: Number,
    outcome: { type: String, default: 'pending' },
    maxFavorablePct: Number,
    maxAdversePct: Number,
    resolvedAt: Date,
    plan: mongoose.Schema.Types.Mixed,
  },
  { collection: 'crash_recovery_signals', timestamps: true }
);
Schema.index({ tradeDate: 1, symbol: 1 }, { unique: true });

let Model;
function model() {
  if (!Model) {
    Model = mongoose.models.CrashRecoverySignal || mongoose.model('CrashRecoverySignal', Schema);
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

async function logCards(cards = []) {
  if (!isMongoConfigured() || !cards.length) return { saved: 0 };
  await connectMongo();
  const M = model();
  const tradeDate = todayIST();
  let saved = 0;
  for (const c of cards) {
    try {
      const existing = await M.findOne({ tradeDate, symbol: c.symbol }).lean();
      if (existing) {
        await M.updateOne(
          { _id: existing._id },
          {
            $set: {
              lastPrice: c.price,
              tab: c.tab,
              planStatus: c.plan?.status,
              techScore: c.tech?.score,
              // firstPrice / firstSeenAt never overwritten
            },
          }
        );
      } else {
        await M.create({
          tradeDate,
          symbol: c.symbol,
          tab: c.tab,
          firstSeenAt: new Date(),
          firstPrice: c.price,
          lastPrice: c.price,
          fallPct: c.fallPct,
          status: 'active',
          planStatus: c.plan?.status,
          techScore: c.tech?.score,
          fundLabel: c.fund?.label,
          bounceProb3: c.probs?.bounce?.['3pct'],
          downProb3: c.probs?.furtherDown?.['3pct'],
          sampleSizeAtPick: c.probs?.sampleSize,
          plan: c.plan,
          outcome: 'pending',
        });
        saved += 1;
      }
    } catch (_) {}
  }
  return { saved };
}

async function listFailed(limit = 40) {
  if (!isMongoConfigured()) return [];
  await connectMongo();
  return model().find({ outcome: { $in: ['stopped', 'failed', 'invalidated'] } }).sort({ updatedAt: -1 }).limit(limit).lean();
}

async function accuracySummary() {
  if (!isMongoConfigured()) {
    return { available: false, note: 'Mongo not configured' };
  }
  await connectMongo();
  const rows = await model().find({ outcome: { $nin: ['pending', null] } }).limit(2000).lean();
  const n = rows.length;
  if (!n) {
    return { available: true, sampleSize: 0, note: 'No resolved crash-recovery outcomes yet.' };
  }
  const win = rows.filter((r) => ['t1_hit', 't2_hit', 'bounced'].includes(r.outcome)).length;
  const loss = rows.filter((r) => ['stopped', 'failed'].includes(r.outcome)).length;
  return {
    available: true,
    sampleSize: n,
    bounceHitPct: Number(((win / n) * 100).toFixed(1)),
    failedPct: Number(((loss / n) * 100).toFixed(1)),
    note: n < 30 ? `Small sample n=${n} — not stable accuracy.` : null,
  };
}

module.exports = { logCards, listFailed, accuracySummary, todayIST };
