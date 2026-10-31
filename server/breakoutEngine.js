// server/breakoutEngine.js
// Detects breakout patterns from price/volume action alone - all derived
// from the same daily candles + volSpike already fetched/computed
// elsewhere, no extra API calls. Deliberately requires a closing-price
// break (not just an intraday wick) AND checks for volume confirmation
// before calling something a "confirmed" breakout, specifically to avoid
// flagging false breakouts as real ones.
function detectBreakout(candles, volSpike) {
  if (!candles || candles.length < 25) return null;
  const n = candles.length;
  const last = candles[n - 1];
  const prior = candles.slice(0, n - 1); // everything before today

  const highOverWindow = (window) => {
    const slice = prior.slice(Math.max(0, prior.length - window));
    return slice.length ? Math.max(...slice.map((c) => c.high)) : null;
  };

  const twentyDayHigh = highOverWindow(20);
  const fiftyTwoWeekHigh = highOverWindow(252);

  const volConfirmed = volSpike !== null && volSpike !== undefined && volSpike >= 1.5;
  const closedStrong = last.close > last.open; // closed green, not just wicked up intraday

  // Gap-up detection: today's open sits meaningfully above yesterday's close.
  const yestClose = prior.length ? prior[prior.length - 1].close : null;
  const gapUpPct = yestClose ? ((last.open - yestClose) / yestClose) * 100 : 0;
  const gapUp = gapUpPct > 1;
  const gapFollowThrough = gapUp && closedStrong; // held/added to the gap
  const gapWeakFollowThrough = gapUp && !closedStrong; // gapped up then faded intraday - a warning, not strength

  // Consolidation breakout: the last ~15 sessions traded in a tight range
  // (<6% high-low spread) and today's close breaks above that range.
  const consolWindow = prior.slice(Math.max(0, prior.length - 15));
  let consolidationBreakout = false;
  if (consolWindow.length >= 10) {
    const cHigh = Math.max(...consolWindow.map((c) => c.high));
    const cLow = Math.min(...consolWindow.map((c) => c.low));
    const spreadPct = cLow ? ((cHigh - cLow) / cLow) * 100 : 100;
    if (spreadPct < 6 && last.close > cHigh) consolidationBreakout = true;
  }

  // Breakout retest: broke a 20-day high within the last 5 sessions (not
  // today) and has since pulled back close to that level while holding -
  // a common "second chance" entry rather than chasing the initial move.
  let breakoutRetest = false;
  if (twentyDayHigh) {
    const recentBreakoutBar = prior.slice(-5).find((c) => c.close > twentyDayHigh);
    if (recentBreakoutBar && last.close >= twentyDayHigh * 0.98 && last.close <= twentyDayHigh * 1.03) {
      breakoutRetest = true;
    }
  }

  // Failed breakout: broke a 20-day high within the last 5 sessions but
  // has since closed back below that level - the breakout didn't hold.
  let failedBreakout = false;
  if (twentyDayHigh) {
    const recentBreakoutBar = prior.slice(-6, -1).find((c) => c.close > twentyDayHigh);
    if (recentBreakoutBar && last.close < twentyDayHigh) failedBreakout = true;
  }

  const events = [];
  if (fiftyTwoWeekHigh && last.close > fiftyTwoWeekHigh) {
    events.push({
      type: '52_WEEK_HIGH', confirmed: volConfirmed && closedStrong,
      detail: `Closed ₹${last.close.toFixed(2)} above the prior 52-week high of ₹${fiftyTwoWeekHigh.toFixed(2)}${volConfirmed ? ' with volume confirmation' : ' — but without strong volume behind it, treat cautiously'}.`,
    });
  } else if (twentyDayHigh && last.close > twentyDayHigh) {
    events.push({
      type: '20_DAY_HIGH', confirmed: volConfirmed && closedStrong,
      detail: `Closed ₹${last.close.toFixed(2)} above the prior 20-day high of ₹${twentyDayHigh.toFixed(2)}${volConfirmed ? ' with volume confirmation' : ' — but without strong volume behind it, treat cautiously'}.`,
    });
  }
  if (consolidationBreakout) {
    events.push({ type: 'CONSOLIDATION_BREAKOUT', confirmed: volConfirmed, detail: `Broke out of a tight ~15-day consolidation range${volConfirmed ? ' on above-average volume' : ', though volume was unremarkable'}.` });
  }
  if (breakoutRetest) {
    events.push({ type: 'BREAKOUT_RETEST', confirmed: true, detail: `Recently broke the 20-day high (₹${twentyDayHigh.toFixed(2)}) and has pulled back to retest that level — a common second-chance entry rather than chasing.` });
  }
  if (failedBreakout) {
    events.push({ type: 'FAILED_BREAKOUT', confirmed: false, detail: `Broke the 20-day high (₹${twentyDayHigh.toFixed(2)}) in the last few sessions but has since closed back below it — that breakout didn't hold.` });
  }
  if (gapWeakFollowThrough) {
    events.push({ type: 'GAP_UP_WEAK_FOLLOWTHROUGH', confirmed: false, detail: `Gapped up ${gapUpPct.toFixed(1)}% at open but closed back near/below the open — buyers didn't follow through on the gap.` });
  } else if (gapFollowThrough) {
    events.push({ type: 'GAP_UP_FOLLOWTHROUGH', confirmed: volConfirmed, detail: `Gapped up ${gapUpPct.toFixed(1)}% and closed strong, holding the gap.` });
  }

  if (!events.length) return null;
  return { primary: events[0].type, events }; // events[0] = highest-priority pattern found, per the order checked above
}

module.exports = { detectBreakout };
