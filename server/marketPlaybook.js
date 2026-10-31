// Translates Nifty / regime context into practical stock-picking rules.
// Educational only — not order advice.

function buildMarketPlaybook(deepDive, regime) {
  const dayPct = deepDive?.dayPct ?? regime?.nifty?.oneDayChangePct ?? null;
  const learningRegime = deepDive?.context?.learningRegime || regime?.learningRegime || 'UNKNOWN';
  const healthy = deepDive?.todayMove?.healthyPullback;
  const downLean = deepDive?.scenarios?.biasWeights?.continuation_down ?? 50;
  const bounceLean = deepDive?.scenarios?.biasWeights?.bounce ?? 30;
  const nearestSupport = deepDive?.supportLevels?.[0] || null;
  const bounceZone = deepDive?.scenarios?.bounceZone || null;
  const vix = deepDive?.context?.vix ?? regime?.indiaVix?.level ?? null;

  let posture = 'normal'; // normal | cautious | defensive | opportunity_reversal
  const rules = [];
  const avoid = [];
  const prefer = [];
  const checklist = [];

  if (learningRegime === 'CRISIS' || (healthy === false && dayPct != null && dayPct <= -1.2)) {
    posture = 'defensive';
    rules.push('Index stress din: naya heavy long portfolio mat bharo.');
    rules.push('Agar trade ho to size chhota, SL tight discipline, R:R ≥ 1:2 mandatory.');
    avoid.push('Momentum chase (stock jo sirf upar bhaag raha ho bina support ke)');
    avoid.push('Overleveraged / high-beta names jab VIX/stress high ho');
    prefer.push('Quality names near own support with clear SL below swing low');
    prefer.push('Wait for Nifty stabilisation near marked support before adding size');
  } else if (downLean >= 55 || (dayPct != null && dayPct <= -0.8) || learningRegime === 'BEAR') {
    posture = 'cautious';
    rules.push('Market pressure phase: fewer new longs, prefer pullback-to-support entries.');
    avoid.push('Buying breakouts that are extended far from support');
    prefer.push('Reversal/bounce setups near stock support when index not making new day lows');
    prefer.push('Stocks holding relative strength (falling less than Nifty)');
  } else if (bounceLean >= 50 && healthy === true) {
    posture = 'opportunity_reversal';
    rules.push('Healthy pullback read: selective bounce buys allowed near supports.');
    prefer.push('Stocks at support with volume dry-up then reclaim');
    avoid.push('Catching every falling knife — only with level + SL');
  } else {
    posture = 'normal';
    rules.push('Normal regime: Technical + R:R + volume rules as usual.');
    prefer.push('Best of Today / Golden only when R:R and volume pass gates');
  }

  checklist.push('1) Pehle Nifty Support & Pulse dekho — aaj stress hai ya healthy dip?');
  checklist.push('2) Stress din: position size kaato ya skip; calm din: normal process.');
  if (nearestSupport) {
    checklist.push(`3) Nifty nearest floor ~${nearestSupport.level} — index uske neeche band ho to naya long size aur kam.`);
  } else {
    checklist.push('3) Nifty support list dekho — index floor clear nahi to extra careful.');
  }
  checklist.push('4) Stock khud apne support pe ho + R:R ≥ 1:2 + volume OK — tabhi entry socho.');
  checklist.push('5) SL hamesha pehle fix; hope pe mat badhao.');

  if (bounceZone) {
    rules.push(`Nifty bounce watch zone ~${bounceZone.from}–${bounceZone.to} (index yahan hold kare to stock bounce trades thode safer context).`);
  }

  // Ranking soft multipliers for scanners (optional consumers)
  let bullishMomentumHaircut = 0; // subtract from rank score
  let reversalBoost = 0;
  if (posture === 'defensive') {
    bullishMomentumHaircut = 6;
    reversalBoost = 2;
  } else if (posture === 'cautious') {
    bullishMomentumHaircut = 3;
    reversalBoost = 1;
  } else if (posture === 'opportunity_reversal') {
    reversalBoost = 2;
  }

  const oneLiner =
    posture === 'defensive'
      ? 'Aaj / is phase me defensive: kam trades, chhota size, support + SL ke bina long mat lo.'
      : posture === 'cautious'
        ? 'Cautious phase: momentum chase mat karo; support-based / relative-strength picks better.'
        : posture === 'opportunity_reversal'
          ? 'Selective bounce phase: support pe quality names, full FOMO nahi.'
          : 'Normal: apna Technical + R:R process follow karo.';

  return {
    posture,
    oneLiner,
    rules,
    prefer,
    avoid,
    checklist,
    rankingHints: { bullishMomentumHaircut, reversalBoost },
    niftySnapshot: {
      price: deepDive?.price ?? null,
      dayPct,
      learningRegime,
      nearestSupport: nearestSupport?.level ?? null,
      bounceZone,
      vix,
    },
    disclaimer: 'Playbook is a risk filter for YOUR process — not buy/sell orders.',
  };
}

module.exports = { buildMarketPlaybook };
