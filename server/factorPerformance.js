// server/factorPerformance.js
// Model Learning — honest feedback loop (not a neural net / black box).
//
// Upgrade: regime-aware (BULL/BEAR/SIDEWAYS/HIGH_VOLATILITY/CRISIS/RECOVERY),
// NORMAL vs CRISIS separation, expectancy metrics, cluster de-correlation,
// walk-forward, min-sample zero influence, max nudge ±0.5.
//
// Existing APIs / exports / score-breakdown contract preserved.
const { isMongoConfigured } = require('./mongo');
const Recommendation = require('./recommendations/Recommendation');
const FactorPerformance = require('./recommendations/FactorPerformance');
const { isCrisisRegime } = require('./learningRegime');

const MIN_SAMPLE_FOR_ADJUSTMENT = 20;
const MAX_ADJUSTMENT = 0.5; // hard cap — never override Technical+R:R+Market
const BASELINE_WIN_RATE = 50;
const MIN_SAMPLE_FOR_COMBO = 15;
const WALK_FORWARD_RECENT_FRACTION = 0.4;
// Below this effective sample, nudge is forced to 0 (anti-overfit 3–5 events)
const HARD_MIN_EFFECTIVE = 12;

let adjustmentCache = new Map();
let comboCache = new Map();
let regimeCache = new Map(); // `${factor}|||${signal}|||${regime}` -> row metrics
let cacheLoadedAt = null;
let lastRecomputeMeta = null;
let currentLearningRegime = 'UNKNOWN'; // set by callers optionally via setCurrentLearningRegime

function cacheKey(factor, signal) {
  return `${factor}|||${signal}`;
}

function comboKey(factors) {
  return factors
    .map((f) => `${f.factor}|||${f.signal}`)
    .sort()
    .join('++');
}

function confidenceFromSample(n) {
  if (n == null || n < 8) return 'none';
  if (n < MIN_SAMPLE_FOR_ADJUSTMENT) return 'low';
  if (n < 50) return 'medium';
  return 'high';
}

function modelConfidenceFrom(effectiveN, learningConf) {
  if (effectiveN == null || effectiveN < HARD_MIN_EFFECTIVE) return 'unknown';
  return learningConf || confidenceFromSample(effectiveN);
}

function sampleScale(n) {
  if (n < MIN_SAMPLE_FOR_ADJUSTMENT) return 0;
  if (n >= 80) return 1;
  return (n - MIN_SAMPLE_FOR_ADJUSTMENT) / (80 - MIN_SAMPLE_FOR_ADJUSTMENT);
}

function median(arr) {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function setCurrentLearningRegime(regime) {
  if (regime) currentLearningRegime = regime;
}

function getCurrentLearningRegime() {
  return currentLearningRegime || 'UNKNOWN';
}

function getFactorAdjustment(factor, signal) {
  const row = adjustmentCache.get(cacheKey(factor, signal));
  return row ? (row.nudge || 0) : 0;
}

/**
 * Regime-aware adaptive adjustment.
 * Returns rich object: { nudge, confidence, modelConfidence, tradeConfidence, why, regime, sampleSize, ... }
 * Legacy callers that only use .nudge keep working.
 */
function getAdaptiveAdjustment(topFactors, opts = {}) {
  if (!topFactors?.length || !adjustmentCache.size) {
    return {
      nudge: 0,
      confidence: 'none',
      modelConfidence: 'unknown',
      tradeConfidence: 'unknown',
      why: 'Insufficient learning data — no adjustment applied.',
      regime: opts.regime || currentLearningRegime,
      sampleSize: 0,
    };
  }

  const regime = opts.regime || currentLearningRegime || 'UNKNOWN';
  let total = 0;
  const parts = [];
  let minConfRank = 3;
  const confRank = { none: 0, low: 1, medium: 2, high: 3, unknown: 0 };
  let totalSamples = 0;
  let usedRegimeSpecific = false;

  for (const f of topFactors) {
    if (!f?.factor || !f?.signal) continue;
    const key = cacheKey(f.factor, f.signal);
    const row = adjustmentCache.get(key);
    if (!row) continue;

    // Prefer same-regime nudge when effective sample is enough
    let nudge = row.nudge || 0;
    let conf = row.confidence || 'none';
    let sampleUsed = row.effectiveSampleSize || row.sampleSize || 0;
    let source = 'overall';

    const rb = row.regimeBreakdown?.[regime];
    if (rb && (rb.effectiveSampleSize || rb.occurrences || 0) >= MIN_SAMPLE_FOR_ADJUSTMENT) {
      // Weight: 60% same-regime + 40% overall (prevent short abnormal period dominating)
      const regimeNudge = rb.nudge != null ? rb.nudge : 0;
      nudge = 0.6 * regimeNudge + 0.4 * (row.nudge || 0);
      // If overall is NORMAL-only when current is CRISIS, prefer crisis bucket
      if (isCrisisRegime(regime) && row.crisisNudge != null && (row.crisisEffective || 0) >= HARD_MIN_EFFECTIVE) {
        nudge = 0.7 * row.crisisNudge + 0.3 * regimeNudge;
        source = 'crisis+regime';
      } else {
        source = `regime:${regime}`;
        usedRegimeSpecific = true;
      }
      sampleUsed = rb.effectiveSampleSize || rb.occurrences || sampleUsed;
      conf = confidenceFromSample(sampleUsed);
    } else if (isCrisisRegime(regime) && row.crisisNudge != null) {
      // In crisis: never apply pure NORMAL nudge strongly
      if ((row.crisisEffective || 0) >= HARD_MIN_EFFECTIVE) {
        nudge = row.crisisNudge;
        source = 'crisis-only';
        sampleUsed = row.crisisEffective;
      } else {
        nudge = 0;
        source = 'crisis-insufficient';
        conf = 'none';
      }
    } else if (!isCrisisRegime(regime) && row.normalNudge != null && (row.normalEffective || 0) >= MIN_SAMPLE_FOR_ADJUSTMENT) {
      // Normal markets: prefer normal bucket so crisis days don't poison
      nudge = 0.7 * row.normalNudge + 0.3 * (row.nudge || 0);
      source = 'normal-weighted';
      sampleUsed = row.normalEffective || sampleUsed;
    }

    // Sector-specific soft blend when enough sector samples exist
    const sector = opts.sector || null;
    if (sector && row.sectorBreakdown?.[sector]) {
      const sb = row.sectorBreakdown[sector];
      const secN = sb.effectiveSampleSize || sb.occurrences || 0;
      if (secN >= MIN_SAMPLE_FOR_ADJUSTMENT && sb.winRate != null) {
        const secNudge = computeNudge(sb.winRate, Math.floor(secN), null);
        nudge = 0.5 * nudge + 0.5 * secNudge;
        source += `+sector:${sector}`;
        sampleUsed = Math.min(sampleUsed, secN);
      }
    }

    // Hard zero if sample too small
    if (sampleUsed < HARD_MIN_EFFECTIVE) {
      nudge = 0;
      conf = 'none';
      source = 'low-sample-zero';
    }

    if (!nudge) continue;
    total += nudge;
    totalSamples += sampleUsed;
    parts.push(`${f.factor} (${f.signal}): ${nudge > 0 ? '+' : ''}${Number(nudge).toFixed(3)} [${source}, n≈${Math.round(sampleUsed)}]`);
    minConfRank = Math.min(minConfRank, confRank[conf] ?? 0);
  }

  // Combination nudge
  if (topFactors.length >= 2) {
    const ck = comboKey(topFactors.filter((f) => f?.factor && f?.signal));
    const combo = comboCache.get(ck);
    if (combo && combo.nudge && (combo.effectiveSampleSize || combo.sampleSize || 0) >= MIN_SAMPLE_FOR_COMBO) {
      total += combo.nudge;
      parts.push(`combo: ${combo.nudge > 0 ? '+' : ''}${combo.nudge}`);
      minConfRank = Math.min(minConfRank, confRank[combo.confidence] ?? 0);
    }
  }

  const capped = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, total));
  const confNames = ['none', 'low', 'medium', 'high'];
  const confidence = confNames[Math.max(0, minConfRank)] || 'none';
  const modelConfidence = modelConfidenceFrom(totalSamples, confidence);
  const tradeConfidence = modelConfidence === 'unknown' || modelConfidence === 'none'
    ? 'unknown'
    : confidence;

  const why = parts.length
    ? `Learning nudge (NOT future profit probability). Regime=${regime}`
      + (usedRegimeSpecific ? ' (regime-weighted)' : '')
      + `: ${parts.join('; ')} → capped ±${MAX_ADJUSTMENT} → ${capped > 0 ? '+' : ''}${Number(capped).toFixed(3)}`
    : `No eligible learning adjustment (regime=${regime}; need n≥${HARD_MIN_EFFECTIVE} effective samples).`;

  return {
    nudge: Number(capped.toFixed(3)),
    confidence,
    modelConfidence,
    tradeConfidence,
    why,
    regime,
    sampleSize: totalSamples,
  };
}

async function loadAdjustmentCacheFromDb() {
  if (!isMongoConfigured()) return;
  try {
    const rows = await FactorPerformance.find({}).lean();
    const next = new Map();
    const nextCombo = new Map();
    rows.forEach((r) => {
      const payload = {
        nudge: r.scoreAdjustment || 0,
        confidence: r.learningConfidence || confidenceFromSample(r.occurrences),
        targetHitPct: r.targetHitPct,
        slHitPct: r.slHitPct,
        noResolutionPct: r.noResolutionPct,
        sampleSize: r.occurrences,
        effectiveSampleSize: r.effectiveSampleSize ?? r.occurrences,
        why: r.why || null,
        expectancy: r.expectancy,
        regimeBreakdown: r.regimeBreakdown || {},
        sectorBreakdown: r.sectorBreakdown || {},
        normalNudge: r.normalScoreAdjustment ?? null,
        normalEffective: r.normalOccurrences || 0,
        crisisNudge: r.crisisScoreAdjustment ?? null,
        crisisEffective: r.crisisOccurrences || 0,
        modelConfidence: r.modelConfidence || null,
      };
      if (r.isCombination) {
        nextCombo.set(r.factor, payload);
      } else {
        next.set(cacheKey(r.factor, r.signal), payload);
      }
    });
    adjustmentCache = next;
    comboCache = nextCombo;
    cacheLoadedAt = new Date();
  } catch (err) {
    console.error('[factorPerformance] failed to load adjustment cache:', err.message);
  }
}

function computeNudge(winRate, occurrences, recentWinRate) {
  if (occurrences < MIN_SAMPLE_FOR_ADJUSTMENT) return 0;
  if (occurrences < HARD_MIN_EFFECTIVE) return 0;
  const scale = sampleScale(occurrences);
  let raw = ((winRate - BASELINE_WIN_RATE) / 100) * 3;
  if (recentWinRate != null && Number.isFinite(recentWinRate)) {
    const disagreement = Math.abs(winRate - recentWinRate);
    if (disagreement > 15) {
      const conservative = Math.abs(recentWinRate - BASELINE_WIN_RATE) < Math.abs(winRate - BASELINE_WIN_RATE)
        ? recentWinRate
        : winRate;
      raw = ((conservative - BASELINE_WIN_RATE) / 100) * 3 * 0.6;
    } else if (recentWinRate < BASELINE_WIN_RATE && winRate > BASELINE_WIN_RATE) {
      raw = Math.min(raw, 0);
    }
  }
  const scaled = raw * scale;
  return Number(Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, scaled)).toFixed(3));
}

function excursionFromHistory(doc) {
  const entry = doc.recommendedPrice;
  if (!entry || !doc.priceHistory?.length) {
    return { mae: doc.maxAdversePct ?? null, mfe: doc.maxFavorablePct ?? null };
  }
  let mae = 0;
  let mfe = 0;
  for (const p of doc.priceHistory) {
    if (p.price == null) continue;
    const ch = ((p.price - entry) / entry) * 100;
    if (ch < mae) mae = ch;
    if (ch > mfe) mfe = ch;
  }
  return { mae: Number(mae.toFixed(2)), mfe: Number(mfe.toFixed(2)) };
}

function holdingDays(doc, isWin) {
  if (doc.holdingDaysToResolve != null) return doc.holdingDaysToResolve;
  if (isWin && doc.daysToHitTarget != null) return doc.daysToHitTarget;
  if (!isWin && doc.daysToHitStopLoss != null) return doc.daysToHitStopLoss;
  return null;
}

/**
 * Cluster weight: same recommendedDate + same outcome direction counted as
 * correlated — one crash day with 50 SL hits must not equal 50 independent samples.
 * Weight = 1 / sqrt(clusterSize) so large clusters still contribute but don't dominate.
 */

function fundQualityBucket(doc) {
  const f = doc.fundamentalsAtPick;
  if (!f) return 'unknown';
  const roe = f.roe != null ? (f.roe <= 1.5 ? f.roe * 100 : f.roe) : null;
  const pe = f.pe;
  const de = f.debtToEquity;
  let q = 0;
  if (roe != null) {
    if (roe >= 15) q += 2;
    else if (roe >= 8) q += 1;
    else if (roe < 5) q -= 2;
  }
  if (pe != null && pe > 0) {
    if (pe < 25) q += 1;
    else if (pe > 50) q -= 1;
  }
  if (de != null) {
    const d = de > 10 ? de / 100 : de;
    if (d <= 0.5) q += 1;
    else if (d > 2) q -= 1;
  }
  if (q >= 3) return 'strong';
  if (q >= 1) return 'ok';
  if (q <= -2) return 'weak';
  return 'mixed';
}

function buildClusterWeights(resolved) {
  const clusters = new Map(); // date -> count
  for (const doc of resolved) {
    const d = doc.recommendedDate || 'unknown';
    clusters.set(d, (clusters.get(d) || 0) + 1);
  }
  const weights = new Map();
  for (const doc of resolved) {
    const d = doc.recommendedDate || 'unknown';
    const n = clusters.get(d) || 1;
    weights.set(doc._id?.toString(), 1 / Math.sqrt(Math.max(1, n)));
  }
  return weights;
}

function emptyBucket() {
  return {
    occurrences: 0,
    wins: 0,
    losses: 0,
    returnSum: 0,
    returnCount: 0,
    returns: [],
    winReturns: [],
    lossReturns: [],
    holdSum: 0,
    holdCount: 0,
    maeSum: 0,
    mfeSum: 0,
    maeCount: 0,
    mfeCount: 0,
    rrSum: 0,
    rrCount: 0,
    targetDistSum: 0,
    targetDistCount: 0,
    slDistSum: 0,
    slDistCount: 0,
    effectiveSum: 0,
    recentOccurrences: 0,
    recentWins: 0,
  };
}

function bumpBucket(s, { isWin, returnPct, isRecent, weight, hold, mae, mfe, rr, tDist, sDist }) {
  const w = weight == null ? 1 : weight;
  s.occurrences += 1;
  s.effectiveSum += w;
  if (isWin) s.wins += 1;
  else s.losses += 1;
  if (returnPct != null) {
    s.returnSum += returnPct;
    s.returnCount += 1;
    s.returns.push(returnPct);
    if (isWin) s.winReturns.push(returnPct);
    else s.lossReturns.push(returnPct);
  }
  if (isRecent) {
    s.recentOccurrences += 1;
    if (isWin) s.recentWins += 1;
  }
  if (hold != null) {
    s.holdSum += hold;
    s.holdCount += 1;
  }
  if (mae != null) {
    s.maeSum += mae;
    s.maeCount += 1;
  }
  if (mfe != null) {
    s.mfeSum += mfe;
    s.mfeCount += 1;
  }
  if (rr != null) {
    s.rrSum += rr;
    s.rrCount += 1;
  }
  if (tDist != null) {
    s.targetDistSum += tDist;
    s.targetDistCount += 1;
  }
  if (sDist != null) {
    s.slDistSum += sDist;
    s.slDistCount += 1;
  }
}

function summarizeBucket(s) {
  const sampleSize = s.occurrences;
  if (!sampleSize) return null;
  const effective = Number((s.effectiveSum || sampleSize).toFixed(2));
  const winRate = Number(((s.wins / sampleSize) * 100).toFixed(1));
  const avgReturnPct = s.returnCount ? Number((s.returnSum / s.returnCount).toFixed(2)) : null;
  const recentWinRate = s.recentOccurrences >= 5
    ? Number(((s.recentWins / s.recentOccurrences) * 100).toFixed(1))
    : null;
  const avgWinPct = s.winReturns.length
    ? Number((s.winReturns.reduce((a, b) => a + b, 0) / s.winReturns.length).toFixed(2))
    : null;
  const avgLossPct = s.lossReturns.length
    ? Number((s.lossReturns.reduce((a, b) => a + b, 0) / s.lossReturns.length).toFixed(2))
    : null;
  const medianReturnPct = median(s.returns);
  const expectancy = avgReturnPct; // pct expectancy per resolved trade
  const avgHoldingDays = s.holdCount ? Number((s.holdSum / s.holdCount).toFixed(1)) : null;
  const avgMaePct = s.maeCount ? Number((s.maeSum / s.maeCount).toFixed(2)) : null;
  const avgMfePct = s.mfeCount ? Number((s.mfeSum / s.mfeCount).toFixed(2)) : null;
  const avgRiskRewardObserved = s.rrCount ? Number((s.rrSum / s.rrCount).toFixed(2)) : null;
  const avgTargetDistancePct = s.targetDistCount ? Number((s.targetDistSum / s.targetDistCount).toFixed(2)) : null;
  const avgSlDistancePct = s.slDistCount ? Number((s.slDistSum / s.slDistCount).toFixed(2)) : null;

  // Nudge uses effective sample (cluster-adjusted) for scaling
  const nudge = computeNudge(winRate, Math.floor(effective), recentWinRate);

  return {
    sampleSize,
    effectiveSampleSize: effective,
    wins: s.wins,
    losses: s.losses,
    winRate,
    avgReturnPct,
    recentWinRate,
    recentSampleSize: s.recentOccurrences || 0,
    expectancy,
    avgWinPct,
    avgLossPct,
    medianReturnPct,
    avgHoldingDays,
    avgMaePct,
    avgMfePct,
    avgRiskRewardObserved,
    avgTargetDistancePct,
    avgSlDistancePct,
    nudge,
  };
}

async function recomputeFactorPerformance() {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };

  const allWithFactors = await Recommendation.find({
    'topFactors.0': { $exists: true },
  }).select(
    'hitTarget hitStopLoss hitTargetPrice hitStopLossPrice recommendedPrice recommendedDate topFactors trackingStopped '
    + 'learningRegime crisisTags sectorAtPick priceHistory maxAdversePct maxFavorablePct '
    + 'daysToHitTarget daysToHitStopLoss holdingDaysToResolve riskRewardRatio target stopLoss entryLow entryHigh'
  ).lean();

  const resolved = allWithFactors.filter((d) => d.hitTarget || d.hitStopLoss);
  const unresolvedCount = allWithFactors.length - resolved.length;

  resolved.sort((a, b) => (a.recommendedDate || '').localeCompare(b.recommendedDate || ''));
  const splitAt = Math.max(0, Math.floor(resolved.length * (1 - WALK_FORWARD_RECENT_FRACTION)));
  const recentSet = new Set(resolved.slice(splitAt).map((d) => d._id?.toString()));
  const clusterWeights = buildClusterWeights(resolved);

  // key -> { overall, normal, crisis, regimes: {BULL: bucket}, sectors: {} }
  const stats = new Map();
  const comboStats = new Map();

  function ensure(map, key, extra) {
    if (!map.has(key)) {
      map.set(key, {
        ...extra,
        overall: emptyBucket(),
        normal: emptyBucket(),
        crisis: emptyBucket(),
        regimes: {},
        sectors: {},
      });
    }
    return map.get(key);
  }

  for (const doc of resolved) {
    const isWin = Boolean(doc.hitTarget);
    const exitPrice = isWin ? doc.hitTargetPrice : doc.hitStopLossPrice;
    const returnPct = exitPrice != null && doc.recommendedPrice
      ? ((exitPrice - doc.recommendedPrice) / doc.recommendedPrice) * 100
      : null;
    const isRecent = recentSet.has(doc._id?.toString());
    const weight = clusterWeights.get(doc._id?.toString()) ?? 1;
    const regime = doc.learningRegime || 'UNKNOWN';
    const sector = doc.sectorAtPick || 'unknown';
    const { mae, mfe } = excursionFromHistory(doc);
    const hold = holdingDays(doc, isWin);
    const entry = doc.recommendedPrice;
    const tDist = entry && doc.target ? ((doc.target - entry) / entry) * 100 : null;
    const sDist = entry && doc.stopLoss ? ((entry - doc.stopLoss) / entry) * 100 : null;
    const rr = doc.riskRewardRatio ?? (tDist != null && sDist ? tDist / Math.max(0.01, sDist) : null);

    const payload = {
      isWin, returnPct, isRecent, weight, hold, mae, mfe, rr, tDist, sDist,
    };

    const factors = (doc.topFactors || []).filter((f) => f?.factor && f?.signal);

    const applyTo = (node) => {
      bumpBucket(node.overall, payload);
      if (isCrisisRegime(regime)) bumpBucket(node.crisis, payload);
      else bumpBucket(node.normal, payload);
      if (!node.regimes[regime]) node.regimes[regime] = emptyBucket();
      bumpBucket(node.regimes[regime], payload);
      if (!node.sectors[sector]) node.sectors[sector] = emptyBucket();
      bumpBucket(node.sectors[sector], payload);
    };

    for (const f of factors) {
      const node = ensure(stats, cacheKey(f.factor, f.signal), { factor: f.factor, signal: f.signal });
      applyTo(node);
    }

    if (factors.length >= 2) {
      const fullKey = comboKey(factors);
      const node = ensure(comboStats, fullKey, {
        factor: fullKey,
        signal: 'combination',
        isCombination: true,
        combinationLabel: factors.map((f) => `${f.factor} (${f.signal})`).join(' + '),
      });
      applyTo(node);
      for (let i = 0; i < factors.length; i++) {
        for (let j = i + 1; j < factors.length; j++) {
          const pair = [factors[i], factors[j]];
          const pk = comboKey(pair);
          if (pk === fullKey) continue;
          const pn = ensure(comboStats, pk, {
            factor: pk,
            signal: 'combination',
            isCombination: true,
            combinationLabel: pair.map((f) => `${f.factor} (${f.signal})`).join(' + '),
          });
          applyTo(pn);
        }
      }
    }
  }

  const unresolvedByKey = new Map();
  for (const doc of allWithFactors) {
    if (doc.hitTarget || doc.hitStopLoss) continue;
    for (const f of doc.topFactors || []) {
      if (!f?.factor || !f?.signal) continue;
      const key = cacheKey(f.factor, f.signal);
      unresolvedByKey.set(key, (unresolvedByKey.get(key) || 0) + 1);
    }
  }

  let tracked = 0;

  async function upsertNode(node, isCombo) {
    const overall = summarizeBucket(node.overall);
    if (!overall) return;
    const normal = summarizeBucket(node.normal);
    const crisis = summarizeBucket(node.crisis);

    const regimeBreakdown = {};
    for (const [reg, bucket] of Object.entries(node.regimes)) {
      const sum = summarizeBucket(bucket);
      if (sum && sum.sampleSize >= 3) {
        regimeBreakdown[reg] = {
          occurrences: sum.sampleSize,
          wins: sum.wins,
          winRate: sum.winRate,
          avgReturnPct: sum.avgReturnPct,
          effectiveSampleSize: sum.effectiveSampleSize,
          nudge: sum.sampleSize >= MIN_SAMPLE_FOR_ADJUSTMENT ? sum.nudge : 0,
          expectancy: sum.expectancy,
        };
      }
    }
    const sectorBreakdown = {};
    for (const [sec, bucket] of Object.entries(node.sectors)) {
      const sum = summarizeBucket(bucket);
      if (sum && sum.sampleSize >= 5) {
        sectorBreakdown[sec] = {
          occurrences: sum.sampleSize,
          wins: sum.wins,
          winRate: sum.winRate,
          avgReturnPct: sum.avgReturnPct,
          effectiveSampleSize: sum.effectiveSampleSize,
        };
      }
    }

    const unresolvedForKey = isCombo ? 0 : (unresolvedByKey.get(cacheKey(node.factor, node.signal)) || 0);
    const totalSeen = overall.sampleSize + unresolvedForKey;
    const targetHitPct = Number(((overall.wins / Math.max(1, totalSeen)) * 100).toFixed(1));
    const slHitPct = Number(((overall.losses / Math.max(1, totalSeen)) * 100).toFixed(1));
    const noResolutionPct = Number(((unresolvedForKey / Math.max(1, totalSeen)) * 100).toFixed(1));

    const minSample = isCombo ? MIN_SAMPLE_FOR_COMBO : MIN_SAMPLE_FOR_ADJUSTMENT;
    // Primary nudge from NORMAL bucket when available (isolates crisis), else overall
    let scoreAdjustment = 0;
    const primary = (normal && normal.effectiveSampleSize >= minSample) ? normal : overall;
    if (primary.effectiveSampleSize >= minSample) {
      scoreAdjustment = primary.nudge;
      if (isCombo) scoreAdjustment = Number((scoreAdjustment * 0.6).toFixed(3));
    }
    // Absolute hard cap
    scoreAdjustment = Number(Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, scoreAdjustment)).toFixed(3));

    const learningConfidence = confidenceFromSample(Math.floor(primary.effectiveSampleSize));
    const modelConfidence = modelConfidenceFrom(primary.effectiveSampleSize, learningConfidence);

    const why = primary.effectiveSampleSize < minSample
      ? `Effective sample ${primary.effectiveSampleSize} < ${minSample} — transparency only, ZERO ranking influence (anti-overfit).`
      : `NORMAL-weighted historical win-rate ${primary.winRate}% (baseline ${BASELINE_WIN_RATE}%). `
        + `Expectancy ${primary.expectancy ?? '—'}%. `
        + (primary.recentWinRate != null ? `Walk-forward recent WR ${primary.recentWinRate}%. ` : '')
        + `Crisis sample isolated (n=${crisis?.sampleSize || 0}). `
        + `Nudge ${scoreAdjustment > 0 ? '+' : ''}${scoreAdjustment} (cap ±${MAX_ADJUSTMENT}). `
        + 'NOT a future profit probability.';

    await FactorPerformance.updateOne(
      isCombo ? { factor: node.factor, signal: 'combination' } : { factor: node.factor, signal: node.signal },
      {
        $set: {
          factor: node.factor,
          signal: node.signal,
          isCombination: Boolean(isCombo),
          combinationLabel: node.combinationLabel || null,
          occurrences: overall.sampleSize,
          wins: overall.wins,
          losses: overall.losses,
          winRate: overall.winRate,
          avgReturnPct: overall.avgReturnPct,
          scoreAdjustment,
          targetHitPct,
          slHitPct,
          noResolutionPct,
          sampleSize: overall.sampleSize,
          recentWinRate: overall.recentWinRate,
          recentSampleSize: overall.recentSampleSize,
          learningConfidence,
          why,
          lastComputedAt: new Date(),
          normalOccurrences: normal?.sampleSize || 0,
          normalWins: normal?.wins || 0,
          normalWinRate: normal?.winRate ?? null,
          normalScoreAdjustment: normal && normal.effectiveSampleSize >= minSample ? normal.nudge : 0,
          crisisOccurrences: crisis?.sampleSize || 0,
          crisisWins: crisis?.wins || 0,
          crisisWinRate: crisis?.winRate ?? null,
          crisisScoreAdjustment: crisis && crisis.effectiveSampleSize >= minSample ? crisis.nudge : 0,
          regimeBreakdown,
          sectorBreakdown,
          expectancy: overall.expectancy,
          avgWinPct: overall.avgWinPct,
          avgLossPct: overall.avgLossPct,
          medianReturnPct: overall.medianReturnPct,
          avgHoldingDays: overall.avgHoldingDays,
          avgMaePct: overall.avgMaePct,
          avgMfePct: overall.avgMfePct,
          avgRiskRewardObserved: overall.avgRiskRewardObserved,
          avgTargetDistancePct: overall.avgTargetDistancePct,
          avgSlDistancePct: overall.avgSlDistancePct,
          effectiveSampleSize: overall.effectiveSampleSize,
          modelConfidence,
          tradeConfidenceNote: modelConfidence === 'unknown'
            ? 'Insufficient effective sample — trade confidence UNKNOWN; learning does not force a prediction.'
            : 'Model confidence reflects sample quality only; trade decision still rests on Technical + R:R + Market.',
        },
      },
      { upsert: true }
    );
    tracked++;
  }

  for (const node of stats.values()) await upsertNode(node, false);
  for (const node of comboStats.values()) {
    if (node.overall.occurrences >= 5) await upsertNode(node, true);
  }

  await loadAdjustmentCacheFromDb();
  lastRecomputeMeta = {
    ok: true,
    factorsTracked: tracked,
    resolvedPicksUsed: resolved.length,
    unresolvedPicksSeen: unresolvedCount,
    walkForwardRecentCount: resolved.length - splitAt,
    note: 'Regime-aware learning: NORMAL vs CRISIS separated; cluster-weighted samples; '
      + 'nudge capped ±0.5; historical rates are NOT future profit probabilities.',
  };
  return lastRecomputeMeta;
}

function isLearningFilterReady() {
  if (!adjustmentCache.size) return false;
  let bestConf = 'none';
  let totalSamples = 0;
  for (const row of adjustmentCache.values()) {
    totalSamples += row.effectiveSampleSize || row.sampleSize || 0;
    const c = row.confidence || 'none';
    if (c === 'high') bestConf = 'high';
    else if (c === 'medium' && bestConf !== 'high') bestConf = 'medium';
  }
  return totalSamples >= 40 && (bestConf === 'medium' || bestConf === 'high');
}

function learningFilterStatus() {
  let totalSamples = 0;
  let mediumPlus = 0;
  for (const row of adjustmentCache.values()) {
    totalSamples += row.effectiveSampleSize || row.sampleSize || 0;
    if (row.confidence === 'medium' || row.confidence === 'high') mediumPlus++;
  }
  const ready = isLearningFilterReady();
  return {
    ready,
    totalSamples,
    signalsWithConfidence: mediumPlus,
    message: ready
      ? 'Model Learning filter ON — regime-aware; weak historical signals demoted when ranking. Nudge still capped small.'
      : `Model Learning filter OFF until more resolved picks (effective samples ${Math.round(totalSamples)}, need ~40+ with medium confidence). Ranking uses Technical + R:R + Market first.`,
  };
}

/**
 * Lookup resolved picks under similar macro/regime conditions (no look-ahead:
 * only uses fields stored at pick time + already-resolved outcomes).
 */
async function findSimilarHistoricalConditions({ regime, crisisTags = [], limit = 20 } = {}) {
  if (!isMongoConfigured()) return { matches: [], note: 'mongo not configured' };
  const q = {
    $or: [{ hitTarget: true }, { hitStopLoss: true }],
    'topFactors.0': { $exists: true },
  };
  if (regime && regime !== 'UNKNOWN') q.learningRegime = regime;
  if (crisisTags?.length) q.crisisTags = { $in: crisisTags };

  const rows = await Recommendation.find(q)
    .sort({ recommendedDate: -1 })
    .limit(Math.min(100, limit * 3))
    .select('symbol recommendedDate hitTarget hitStopLoss learningRegime crisisTags sectorAtPick recommendedPrice hitTargetPrice hitStopLossPrice topFactors')
    .lean();

  const matches = rows.slice(0, limit).map((d) => {
    const exit = d.hitTarget ? d.hitTargetPrice : d.hitStopLossPrice;
    const ret = exit != null && d.recommendedPrice
      ? Number((((exit - d.recommendedPrice) / d.recommendedPrice) * 100).toFixed(2))
      : null;
    return {
      symbol: d.symbol,
      date: d.recommendedDate,
      outcome: d.hitTarget ? 'target' : 'sl',
      returnPct: ret,
      regime: d.learningRegime,
      crisisTags: d.crisisTags || [],
      sector: d.sectorAtPick,
      signals: (d.topFactors || []).slice(0, 4).map((f) => f.factor),
      fundQuality: fundQualityBucket(d),
    };
  });
  return {
    matches,
    count: matches.length,
    note: 'Similar past resolved conditions only — not a prediction of future results.',
  };
}

/**
 * Run recompute if never done this process OR last DB compute is older than
 * maxAgeMs. Designed for servers that are only ON when the user starts them
 * (Sat/Mon/etc.) — does not depend on Sunday cron being alive.
 */
async function maybeRecomputeIfStale(maxAgeMs = 20 * 60 * 60 * 1000) {
  if (!isMongoConfigured()) return { ok: false, reason: 'mongo_not_configured' };
  try {
    // Prefer DB timestamp so restart within same day does not always recompute
    const latest = await FactorPerformance.findOne({})
      .sort({ lastComputedAt: -1 })
      .select('lastComputedAt')
      .lean();
    const lastAt = latest?.lastComputedAt ? new Date(latest.lastComputedAt).getTime() : 0;
    const age = Date.now() - lastAt;
    if (lastAt && age < maxAgeMs) {
      await loadAdjustmentCacheFromDb();
      return {
        ok: true,
        skipped: true,
        reason: 'fresh',
        ageHours: Number((age / 3600000).toFixed(1)),
        lastComputedAt: latest.lastComputedAt,
      };
    }
    console.log('[factorPerformance] startup/stale recompute — lastComputedAt:', latest?.lastComputedAt || 'never');
    const result = await recomputeFactorPerformance();
    return { ...result, skipped: false };
  } catch (err) {
    console.error('[factorPerformance] maybeRecomputeIfStale failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  recomputeFactorPerformance,
  maybeRecomputeIfStale,
  isLearningFilterReady,
  learningFilterStatus,
  loadAdjustmentCacheFromDb,
  getFactorAdjustment,
  getAdaptiveAdjustment,
  findSimilarHistoricalConditions,
  setCurrentLearningRegime,
  getCurrentLearningRegime,
  MIN_SAMPLE_FOR_ADJUSTMENT,
  MAX_ADJUSTMENT,
  BASELINE_WIN_RATE,
  HARD_MIN_EFFECTIVE,
  getCacheInfo: () => ({
    size: adjustmentCache.size,
    comboSize: comboCache.size,
    loadedAt: cacheLoadedAt,
    lastRecompute: lastRecomputeMeta,
    currentLearningRegime,
  }),
};
