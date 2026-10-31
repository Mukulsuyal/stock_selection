/**
 * Morning Storm trade management:
 * - SL levels: -2% and -3% from entry
 * - Targets: +4.5%, +9%, +13.5%
 * - After T2 (+9%) if carry → trail SL to +7% (9% - 2%)
 * - Advice only; user confirms via buttons.
 */
function pctFrom(entry, price) {
  if (entry == null || price == null || entry === 0) return null;
  return ((price - entry) / entry) * 100;
}

function buildManagedPlan(entryPrice) {
  if (entryPrice == null || !(entryPrice > 0)) return null;
  const e = Number(entryPrice);
  const p = (pct) => Number((e * (1 + pct / 100)).toFixed(2));
  return {
    entryPrice: Number(e.toFixed(2)),
    stop2: p(-2),
    stop3: p(-3),
    target1: p(4.5),   // 4.5%
    target2: p(9),     // 9%
    target3: p(13.5),  // 13.5%
    trailAfterT2: p(7), // 9% - 2% = 7% lock
    levelsPct: { sl2: -2, sl3: -3, t1: 4.5, t2: 9, t3: 13.5, trail: 7 },
  };
}

/**
 * @param {object} opts
 * @param {number} opts.entryPrice
 * @param {number} opts.price
 * @param {string} [opts.userStance] hold|booked_t1|booked_t2|carry_after_t2|exited
 * @param {boolean} [opts.t1Hit] [opts.t2Hit] [opts.t3Hit]
 * @param {string} [opts.marketTrend]
 * @param {number} [opts.vol]
 * @param {number} [opts.clockMins]
 */
function adviseManagement(opts) {
  const {
    entryPrice,
    price,
    userStance = 'open',
    t1Hit = false,
    t2Hit = false,
    t3Hit = false,
    marketTrend = null,
    clockMins = null,
  } = opts || {};

  const plan = buildManagedPlan(entryPrice);
  if (!plan || price == null) {
    return {
      plan: null,
      pnlPct: null,
      primary: { action: 'WAIT', label: 'Data wait', reason: 'Entry/price missing' },
      buttons: ['exit'],
    };
  }

  const pnl = pctFrom(entryPrice, price);
  const weak = marketTrend === 'bearish' || marketTrend === 'down';
  const strong = marketTrend === 'bullish' || marketTrend === 'up';
  const late = clockMins != null && clockMins >= 14 * 60 + 45;

  // Effective SL: after T2 carry, trail at +7%
  const effectiveSl = (userStance === 'carry_after_t2' || (t2Hit && userStance === 'carry'))
    ? plan.trailAfterT2
    : plan.stop2;

  const steps = [];
  let primary = null;

  // --- Stops ---
  if (price <= plan.stop3) {
    primary = {
      action: 'EXIT',
      label: 'Exit — 3% SL zone',
      reason: '−3% level. Recovery hope se nahi; capital protect.',
      level: 'SL3',
    };
  } else if (price <= plan.stop2 && !(t2Hit && userStance === 'carry_after_t2')) {
    // Between -2 and -3: advise hold to -3 vs book -2
    if (strong && !late) {
      primary = {
        action: 'HOLD_TO_SL3_OR_BOOK',
        label: '−2% touch: ruk sakte ho −3% tak (risk) YA book loss',
        reason: 'Index supportive — thoda room −3% tak de sakte ho; warna −2% pe loss book. Tum confirm karo.',
        level: 'SL2',
        alt: 'Book −2% loss abhi',
      };
    } else {
      primary = {
        action: 'BOOK_LOSS_SL2',
        label: '−2% pe book loss better',
        reason: weak || late
          ? 'Tape soft/late — −3% tak wait risky.'
          : '−2% hit; −3% tak hope kam. Book loss suggest.',
        level: 'SL2',
      };
    }
  } else if (userStance === 'carry_after_t2' && price <= plan.trailAfterT2) {
    primary = {
      action: 'EXIT',
      label: 'Trail SL hit (~+7% lock)',
      reason: 'T2 ke baad trail −2% from 9% (i.e. +7% from entry). Profit lock exit.',
      level: 'TRAIL',
    };
  }

  // --- Targets ---
  if (!primary && price >= plan.target3) {
    primary = {
      action: 'BOOK',
      label: 'T3 (+13.5%) — book profit',
      reason: 'Final stretch target. Carry yahan rare; full/majority book.',
      level: 'T3',
    };
  } else if (!primary && price >= plan.target2) {
    primary = {
      action: 'BOOK_OR_CARRY',
      label: 'T2 (+9%) hit — book YA carry with trail',
      reason: 'Agar carry: naya SL ~+7% (entry se). Partial book 50%+ better, rest trail.',
      level: 'T2',
      trailSl: plan.trailAfterT2,
    };
  } else if (!primary && price >= plan.target1) {
    primary = {
      action: 'BOOK_OR_CARRY',
      label: 'T1 (+4.5%) hit — partial book YA carry',
      reason: 'Partial book suggest (30–50%). Carry only if volume/tape strong; SL abhi bhi −2%/−3%.',
      level: 'T1',
    };
  }

  if (!primary) {
    if (pnl != null && pnl >= 2 && late) {
      primary = {
        action: 'BOOK_OR_EXIT_EOD',
        label: 'Late session — partial book / EOD',
        reason: 'Target nahi, lekin late + green; overnight gap risk.',
        level: 'TIME',
      };
    } else if (pnl != null && pnl < -1 && pnl > -2) {
      primary = {
        action: 'HOLD',
        label: 'Hold — SL2 se upar',
        reason: 'Abhi −2% SL touch nahi. Plan ke saath raho.',
        level: 'OPEN',
      };
    } else {
      primary = {
        action: 'HOLD',
        label: 'Hold — targets wait',
        reason: 'SL2/SL3 se upar, T1 se neeche. Plan follow.',
        level: 'OPEN',
      };
    }
  }

  // Buttons user can confirm
  const buttons = [];
  if (primary.action === 'EXIT' || primary.action === 'BOOK_LOSS_SL2') {
    buttons.push('exit', 'hold_to_sl3');
  } else if (primary.action === 'HOLD_TO_SL3_OR_BOOK') {
    buttons.push('book_loss', 'hold_to_sl3', 'exit');
  } else if (primary.action === 'BOOK_OR_CARRY' && primary.level === 'T1') {
    buttons.push('book_partial', 'carry', 'exit');
  } else if (primary.action === 'BOOK_OR_CARRY' && primary.level === 'T2') {
    buttons.push('book_partial', 'carry_trail', 'exit');
  } else if (primary.action === 'BOOK') {
    buttons.push('book_full', 'exit');
  } else {
    buttons.push('hold', 'exit', 'book_partial');
  }

  steps.push(`Entry ₹${plan.entryPrice}`);
  steps.push(`SL2 ₹${plan.stop2} (−2%) · SL3 ₹${plan.stop3} (−3%)`);
  steps.push(`T1 ₹${plan.target1} (+4.5%) · T2 ₹${plan.target2} (+9%) · T3 ₹${plan.target3} (+13.5%)`);
  steps.push(`T2 ke baad carry → trail SL ₹${plan.trailAfterT2} (~+7%)`);
  if (pnl != null) steps.push(`Abhi P/L entry se: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);

  return {
    plan,
    pnlPct: pnl != null ? Number(pnl.toFixed(2)) : null,
    effectiveSl,
    primary,
    buttons,
    steps,
    nextDayNote: 'Agar carry confirm kiya to next day bhi yahi levels + live P/L se advice update hogi.',
  };
}

module.exports = { buildManagedPlan, adviseManagement, pctFrom };
