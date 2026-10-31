const assert = require('assert');
const {
  deriveConfidence,
  deriveEntryReadiness,
  deepFallScore,
  MIN_SAMPLE,
  MIN_SAMPLE_HIGH,
} = require('../earlyOpportunityEngine');

// 1) Tiny sample never HIGH
{
  const c = deriveConfidence({
    setupScore: 77,
    sampleSize: 5,
    reversalConfirm: 'confirmed',
    alreadyMoved: false,
    rrNet: 2.2,
  });
  assert.strictEqual(c.label, 'INSUFFICIENT', 'tiny sample must not be HIGH/MED');
}

// 2) Score high + null sample → INSUFFICIENT
{
  const c = deriveConfidence({
    setupScore: 90,
    sampleSize: null,
    reversalConfirm: 'confirmed',
    alreadyMoved: false,
    rrNet: 2.5,
  });
  assert.strictEqual(c.label, 'INSUFFICIENT');
}

// 3) Oversold alone → WATCHLIST not BUY
{
  const r = deriveEntryReadiness({
    setupScore: 70,
    confidence: { label: 'MED' },
    reversalConfirm: null,
    alreadyMoved: false,
    rrNet: 2.1,
    vol: 1.0,
    rsi: 28,
    scanner: 'deep_fall_reversal',
  });
  assert.strictEqual(r.action, 'WATCHLIST');
  assert.ok(/Oversold alone/i.test(r.note));
}

// 4) Confirmed + volume + HIGH + RR → BUY NOW
{
  const r = deriveEntryReadiness({
    setupScore: 80,
    confidence: { label: 'HIGH' },
    reversalConfirm: 'confirmed',
    alreadyMoved: false,
    rrNet: 2.2,
    vol: 1.8,
    rsi: 32,
    scanner: 'deep_fall_reversal',
  });
  assert.strictEqual(r.action, 'BUY NOW');
}

// 5) deepFall: oversold without structure does not score as ready buy path
{
  const row = {
    price: 100,
    periodReturns: { oneDay: -9, oneWeek: -12 },
    pChange: -9,
    rsi14: 25,
    volSpike: 1.0,
    setup: { type: 'momentum', quality: null },
    tradePlan: { riskRewardRatio: 2.5, stopLoss: 95, target: 110 },
  };
  const m = deepFallScore(row);
  assert.ok(m, 'should still surface as deep fall candidate');
  assert.ok(m.setupScore <= 70, 'without structure score should be capped-ish');
  assert.ok(!m.reversalConfirm, 'no reversal confirm');
  assert.ok((m.risks || []).some((x) => /oversold alone|No structural/i.test(x)));
}

// 6) HIGH only with large sample + confirmed
{
  const c = deriveConfidence({
    setupScore: 75,
    sampleSize: MIN_SAMPLE_HIGH,
    reversalConfirm: 'confirmed',
    alreadyMoved: false,
    rrNet: 2.1,
  });
  assert.strictEqual(c.label, 'HIGH');
}

console.log('earlyOpportunity tests: ALL PASSED');
console.log({ MIN_SAMPLE, MIN_SAMPLE_HIGH });
