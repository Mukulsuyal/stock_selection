const express = require('express');
const router = express.Router();
const { requireAuth, requireFeature } = require('../auth');
const Journal = require('../models/Journal');
const marketData = require('../marketData');
const { analyze } = require('../indicators');
const { getMarketTrend } = require('../marketTrend');
const { estimateMoveProbability, estimateTargetTimeline } = require('../probabilityEstimator');

router.use(requireAuth, requireFeature('journal'));

router.get('/', async (req, res) => {
  try {
    res.json({ entries: await Journal.list(req.user.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load journal right now' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { symbol, side, quantity, price, horizon, reason, stopLoss, target } = req.body;
    if (!symbol || !side || !quantity || !price) {
      return res.status(400).json({ error: 'symbol, side, quantity, price required' });
    }
    const entry = await Journal.create(req.user.id, {
      symbol, side, quantity: Number(quantity), price: Number(price), horizon, reason,
      stopLoss: stopLoss ? Number(stopLoss) : null,
      target: target ? Number(target) : null,
    });
    res.json({ entry });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not log trade right now' });
  }
});

router.post('/:id/close', async (req, res) => {
  try {
    const { exitPrice } = req.body;
    if (!exitPrice) return res.status(400).json({ error: 'exitPrice required' });
    const entry = await Journal.close(req.user.id, req.params.id, { exitPrice: Number(exitPrice) });
    res.json({ entry });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not close trade right now' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Journal.remove(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not remove trade right now' });
  }
});

// ---------- Position Manager: for every OPEN trade, answer "hold or exit?" ----------
// Re-runs the exact same rule engine used for live analysis against each
// open position's symbol right now, plus checks any stop-loss/target you
// set when logging the trade, and gives one clear, reasoned recommendation.
router.get('/manage', async (req, res) => {
  try {
    const open = await Journal.listOpen(req.user.id);
    if (!open.length) return res.json({ positions: [] });

    const marketContext = await getMarketTrend();
    const isToday = (dateStr) => {
      const d = new Date(dateStr);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    };

    const positions = await Promise.all(open.map(async (entry) => {
      try {
        const [quote, candles] = await Promise.all([
          marketData.getQuote(entry.symbol),
          marketData.getHistorical(entry.symbol, 260),
        ]);
        const currentPrice = quote.lastPrice;
        const isBuy = entry.side === 'buy';

        const pnlPct = isBuy
          ? ((currentPrice - entry.price) / entry.price) * 100
          : ((entry.price - currentPrice) / entry.price) * 100;

        const stopHit = entry.stop_loss
          ? (isBuy ? currentPrice <= entry.stop_loss : currentPrice >= entry.stop_loss)
          : false;
        const targetHit = entry.target
          ? (isBuy ? currentPrice >= entry.target : currentPrice <= entry.target)
          : false;

        const analysis = candles.length ? analyze(candles, quote, marketContext) : null;
        const technicalAgainst = analysis
          ? (isBuy ? analysis.verdict.toLowerCase().includes('bear') : analysis.verdict.toLowerCase().includes('bull'))
          : false;

        // Purely informational now - an intraday trade still open past its
        // day is worth a note, but the app doesn't get to decide HOLD vs
        // EXIT on its behalf just because of the clock. Only two things
        // ever force an action automatically: the stop-loss (objective,
        // safety-first) and, separately, flagging that target was hit
        // (also objective) - everything else is "here's the read, you call it".
        const overdueIntraday = entry.horizon === 'intraday' && !isToday(entry.trade_date);
        const overdueNote = overdueIntraday
          ? ` (This was logged as an intraday trade on ${new Date(entry.trade_date).toISOString().slice(0, 10)} and is still open — your call whether to treat it as a swing position now or square it off.)`
          : '';

        // A symmetric "target 2": the same size move again, measured past
        // the original target - matches how target2 is derived elsewhere
        // in the app (see server/recommendations/tracker.js) so the two
        // stay consistent even though a manually-logged journal entry only
        // ever stores a single target.
        const target2 = entry.target ? Number((2 * entry.target - entry.price).toFixed(2)) : null;

        let action, reason;
        if (stopHit) {
          action = 'EXIT';
          reason = `Stop-loss (₹${entry.stop_loss}) has been hit. Discipline matters more than hope here — this is exactly what the stop was for.${overdueNote}`;
        } else if (targetHit) {
          // Information, not a directive: hold for target 2, book it all,
          // or book partial - all three stay on the table. Where history
          // on this exact stock exists, lean on it; otherwise say so plainly.
          action = 'TARGET HIT';
          const prob = candles.length >= 220 ? estimateMoveProbability(candles) : { status: 'insufficient_history' };
          let outlook;
          if (prob.status === 'ok') {
            const p5 = prob.probabilityUp5PctPlus;
            outlook = p5 >= 40
              ? `Historically on this stock, a similar signal kept running another 5%+ in ${p5}% of past cases (n=${prob.sampleSize}) - there's a real case for holding part of the position toward Target 2 (~₹${target2}).`
              : `Historically on this stock, a similar signal rarely (${p5}% of ${prob.sampleSize} past cases) ran another 5%+ from here - booking full or most of the profit is usually the safer play, but that's your call.`;
          } else {
            outlook = `Not enough price history on this stock to estimate the odds of a further move from here - hold for Target 2 (~₹${target2}), book it all, or book partial: your call.`;
          }
          reason = `🎯 Target (₹${entry.target}) hit! ${outlook}${overdueNote}`;
        } else if (technicalAgainst) {
          action = 'CONSIDER EXIT';
          reason = `The technical read has flipped to "${analysis.verdict}" — the setup that justified entry no longer holds. Doesn't mean it will keep falling, but the original reason to hold is gone.${overdueNote}`;
        } else {
          action = 'HOLD';
          reason = (analysis
            ? `No stop-loss/target hit, and the technical read ("${analysis.verdict}") still doesn't contradict this position.`
            : `No stop-loss/target hit. (Could not fetch a fresh technical read right now.)`) + overdueNote;
        }

        // "Day X since entry, predicted to resolve within ~Nd" - reuses the
        // same historical-timeline idea shown on picks before they're ever
        // logged (see server/probabilityEstimator.js estimateTargetTimeline),
        // just re-run here so it keeps updating every day this stays open
        // instead of only ever being a one-time estimate from entry day.
        const daysSinceEntry = Math.max(0, Math.floor((Date.now() - new Date(entry.trade_date).getTime()) / 86400000));
        let predictedWindowDays = null;
        if (entry.target && candles.length >= 250) {
          const targetPct = ((entry.target - entry.price) / entry.price) * 100 * (isBuy ? 1 : -1);
          if (targetPct > 0) {
            const timeline = estimateTargetTimeline(candles, targetPct);
            if (timeline.status === 'ok') {
              predictedWindowDays = { '7d': 7, '15d': 15, '30d': 30, '30d_plus': null }[timeline.suggestedWindow] ?? null;
            }
          }
        }

        return {
          id: entry.id,
          symbol: entry.symbol,
          side: entry.side,
          quantity: entry.quantity,
          entryPrice: entry.price,
          horizon: entry.horizon,
          tradeDate: entry.trade_date,
          stopLoss: entry.stop_loss,
          target: entry.target,
          target2,
          currentPrice,
          pnlPct,
          action,
          reason,
          daysSinceEntry,
          predictedWindowDays,
          topFactors: analysis ? analysis.factors.slice(0, 4) : [],
        };
      } catch (err) {
        return { id: entry.id, symbol: entry.symbol, error: 'Could not fetch live data for this symbol right now' };
      }
    }));

    res.json({ positions, marketContext });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not evaluate open positions right now' });
  }
});

// ---------- Portfolio Overview: totals + sector concentration check ----------
router.get('/portfolio', async (req, res) => {
  try {
    const open = await Journal.listOpen(req.user.id);
    if (!open.length) return res.json({ positions: [], totals: null, sectorBreakdown: [], warnings: [] });

    const positions = await Promise.all(open.map(async (entry) => {
      try {
        const [quote, fundamentals] = await Promise.all([
          marketData.getQuote(entry.symbol),
          marketData.getFundamentals(entry.symbol).catch(() => null),
        ]);
        const currentPrice = quote.lastPrice;
        const investedValue = entry.price * entry.quantity;
        const currentValue = currentPrice * entry.quantity;
        const pnlAmount = entry.side === 'buy' ? currentValue - investedValue : investedValue - currentValue;
        return {
          symbol: entry.symbol,
          quantity: entry.quantity,
          investedValue,
          currentValue,
          pnlAmount,
          pnlPct: investedValue ? (pnlAmount / investedValue) * 100 : 0,
          sector: fundamentals?.sector || 'Unknown',
        };
      } catch (err) {
        return { symbol: entry.symbol, error: 'Could not fetch live data' };
      }
    }));

    const valid = positions.filter((p) => !p.error);
    const totalInvested = valid.reduce((a, p) => a + p.investedValue, 0);
    const totalCurrentValue = valid.reduce((a, p) => a + p.currentValue, 0);
    const totalPnlAmount = valid.reduce((a, p) => a + p.pnlAmount, 0);
    const totalPnlPct = totalInvested ? (totalPnlAmount / totalInvested) * 100 : 0;

    const sectorMap = {};
    valid.forEach((p) => {
      sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.currentValue;
    });
    const sectorBreakdown = Object.entries(sectorMap)
      .map(([sector, value]) => ({ sector, value, pctOfPortfolio: totalCurrentValue ? (value / totalCurrentValue) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);

    const warnings = sectorBreakdown
      .filter((s) => s.pctOfPortfolio > 40 && s.sector !== 'Unknown')
      .map((s) => `${s.pctOfPortfolio.toFixed(0)}% of your portfolio is in ${s.sector} — a downturn in that sector would hit you disproportionately hard. Consider diversifying.`);

    res.json({
      positions,
      totals: { totalInvested, totalCurrentValue, totalPnlAmount, totalPnlPct },
      sectorBreakdown,
      warnings,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not compute portfolio overview right now' });
  }
});

module.exports = router;
