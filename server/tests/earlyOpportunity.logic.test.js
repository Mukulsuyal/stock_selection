/**
 * Pure-logic regression tests (no Mongo / market deps).
 * Mirrors rules in earlyOpportunityEngine.js
 */
const assert = require('assert');

const MIN_SAMPLE = 20;
const MIN_SAMPLE_HIGH = 40;

function deriveConfidence({ setupScore, sampleSize, reversalConfirm, alreadyMoved, rrNet }) {
  const n = sampleSize;
  const insufficient = n == null || n < MIN_SAMPLE;
  if (alreadyMoved) return { label: 'LOW' };
  if (rrNet != null && rrNet < 1.5) return { label: 'LOW' };
  if (!reversalConfirm && setupScore < 70) return { label: 'LOW' };
  if (insufficient) return { label: 'INSUFFICIENT' };
  if (
    setupScore >= 72 &&
    n >= MIN_SAMPLE_HIGH &&
    (reversalConfirm === 'confirmed' || reversalConfirm === 'failed_breakdown') &&
    rrNet != null &&
    rrNet >= 2
  ) {
    return { label: 'HIGH' };
  }
  if (setupScore >= 58 && n >= MIN_SAMPLE) return { label: 'MED' };
  return { label: 'LOW' };
}

function deriveEntryReadiness({ setupScore, confidence, reversalConfirm, alreadyMoved, rrNet, vol, rsi, scanner }) {
  if (alreadyMoved) return { action: 'WATCHLIST' };
  if (rrNet == null || rrNet < 1.5) return { action: 'NO TRADE' };
  if (setupScore < 50) return { action: 'NO TRADE' };
  const onlyOversold = rsi != null && rsi < 32 && !reversalConfirm && (vol == null || vol < 1.3);
  if (onlyOversold) return { action: 'WATCHLIST', note: 'Oversold alone' };
  if (scanner === 'deep_fall_reversal') {
    if (reversalConfirm === 'confirmed' && confidence.label === 'HIGH' && rrNet >= 2 && vol != null && vol >= 1.3) {
      return { action: 'BUY NOW' };
    }
    if (reversalConfirm === 'confirmed' || (reversalConfirm === 'possible' && vol != null && vol >= 1.5)) {
      return { action: 'WAIT' };
    }
    return { action: 'WATCHLIST' };
  }
  return { action: 'WATCHLIST' };
}

assert.strictEqual(
  deriveConfidence({ setupScore: 77, sampleSize: 5, reversalConfirm: 'confirmed', alreadyMoved: false, rrNet: 2.2 }).label,
  'INSUFFICIENT'
);
assert.strictEqual(
  deriveConfidence({ setupScore: 90, sampleSize: null, reversalConfirm: 'confirmed', alreadyMoved: false, rrNet: 2.5 }).label,
  'INSUFFICIENT'
);
assert.strictEqual(
  deriveEntryReadiness({
    setupScore: 70, confidence: { label: 'MED' }, reversalConfirm: null,
    alreadyMoved: false, rrNet: 2.1, vol: 1.0, rsi: 28, scanner: 'deep_fall_reversal',
  }).action,
  'WATCHLIST'
);
assert.strictEqual(
  deriveEntryReadiness({
    setupScore: 80, confidence: { label: 'HIGH' }, reversalConfirm: 'confirmed',
    alreadyMoved: false, rrNet: 2.2, vol: 1.8, rsi: 32, scanner: 'deep_fall_reversal',
  }).action,
  'BUY NOW'
);
assert.strictEqual(
  deriveConfidence({
    setupScore: 75, sampleSize: MIN_SAMPLE_HIGH, reversalConfirm: 'confirmed', alreadyMoved: false, rrNet: 2.1,
  }).label,
  'HIGH'
);
// Score 77 + HIGH was the bug: null sample must not HIGH
assert.notStrictEqual(
  deriveConfidence({ setupScore: 77, sampleSize: null, reversalConfirm: null, alreadyMoved: false, rrNet: 2 }).label,
  'HIGH'
);
console.log('earlyOpportunity.logic.test.js: ALL PASSED');
