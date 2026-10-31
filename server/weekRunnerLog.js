/**
 * Forward-test log: every pick is frozen on the day it is shown, then graded later with the SAME
 * gap-aware simulator. This is the only proof that matters (live, out-of-sample).
 * Also powers the drawdown kill-switch: after a bad run, system says PAUSE.
 */
const fs = require('fs');
const path = require('path');
const E = require('./weekRunnerEngine');
const FILE = process.env.WR_LOG_PATH || path.join(__dirname, '..', 'data', 'week_runner_log.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { entries: [] }; } }
function save(db) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.warn('[weekRunnerLog] save failed', e.message); } }

function logPicks(picks, paper, regime) {
  const db = load(); const have = new Set(db.entries.map((e) => `${e.symbol}|${e.setup}|${e.signalDate}`));
  let added = 0;
  const add = (p, kind) => {
    const key = `${p.symbol}|${p.setup}|${p.signalDate}`; if (have.has(key)) return;
    db.entries.push({ symbol: p.symbol, setup: p.setup, signalDate: p.signalDate, kind, grade: p.grade, signalClose: p.price, stopDist: p.stopDist, exitKey: p.exit?.key || 'W7', regime: regime.state, status: 'open', loggedAt: new Date().toISOString() });
    have.add(key); added++;
  };
  (picks || []).forEach((p) => add(p, 'pick')); (paper || []).slice(0, 6).forEach((p) => add(p, 'paper'));
  if (added) save(db);
  return added;
}

/** candlesBySymbol: cleaned candle arrays. Grades every open entry whose 7-day window is complete. */
/** Log the daily best pick (kind 'best', with its honesty tier) and a few backups (kind 'paper'). */
function logBest(hero, backups, regime) {
  const db = load(); const have = new Set(db.entries.map((e) => `${e.symbol}|${e.setup}|${e.signalDate}`)); let added = 0;
  const add = (p, kind, tier) => {
    const setup = p.setupKey || 'RANK'; const key = `${p.symbol}|${setup}|${p.signalDate}`; if (have.has(key)) return;
    db.entries.push({ symbol: p.symbol, setup, signalDate: p.signalDate, kind, tier, grade: tier, signalClose: p.price, stopDist: p.stopDist, exitKey: p.exit?.key || 'W7', regime: regime.state, status: 'open', loggedAt: new Date().toISOString() });
    have.add(key); added++;
  };
  if (hero) add(hero, 'best', hero.tier); (backups || []).slice(0, 3).forEach((b) => add(b, 'paper', 'BACKUP'));
  if (added) save(db);
  return added;
}

function refreshOutcomes(candlesBySymbol) {
  const db = load(); let changed = 0;
  for (const e of db.entries) {
    if (e.status !== 'open') continue;
    const c = candlesBySymbol[e.symbol]; if (!c) continue;
    const S = E.buildSeries(c, null); const i = S.date.indexOf(e.signalDate); if (i < 0) continue;
    const atr = S.atr[i] || S.close[i] * 0.02;
    const o = E.simulate(S, i, e.stopDist, atr, E.EXITS[e.exitKey] || E.EXITS.W7);
    if (o === null) continue;
    if (o.skipped) { e.status = 'skipped'; e.skipReason = o.skipped; changed++; continue; }
    Object.assign(e, { status: 'closed', net: Number(o.net.toFixed(2)), R: Number(o.R.toFixed(2)), took1: o.took1, stopped: o.stopped, gapExit: o.gapExit, entryDate: o.entryDate, exitDate: o.exitDate });
    changed++;
  }
  if (changed) save(db);
}

function forwardStats() {
  const db = load();
  const closed = db.entries.filter((e) => e.status === 'closed').sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1));
  const bestAll = closed.filter((e) => e.kind === 'best');
  const picks = closed.filter((e) => e.kind === 'pick' || (e.kind === 'best' && (e.tier === 'PROVEN' || e.tier === 'LEAN'))), paper = closed.filter((e) => e.kind === 'paper');
  const last4 = picks.slice(-4); const last3 = picks.slice(-3);
  const sumR4 = last4.reduce((s, x) => s + x.R, 0);
  let pause = false, pauseReason = null;
  if (last4.length >= 4 && sumR4 <= -2.5) { pause = true; pauseReason = `Pichle 4 forward trade me ${sumR4.toFixed(1)}R loss`; }
  if (last3.length >= 3 && last3.every((x) => x.net <= 0)) { pause = true; pauseReason = 'Lagatar 3 forward loss'; }
  const mk = (a) => ({ n: a.length, winRate: a.length ? Math.round((a.filter((x) => x.net > 0).length / a.length) * 100) : null, avgNet: a.length ? Number((a.reduce((s, x) => s + x.net, 0) / a.length).toFixed(2)) : null, sumR: Number(a.reduce((s, x) => s + x.R, 0).toFixed(1)) });
  return {
    pause, pauseReason, picks: mk(picks), paperOnly: mk(paper), best: mk(bestAll),
    open: db.entries.filter((e) => e.status === 'open').length,
    sufficient: picks.length >= 10,
    note: picks.length < 10 ? `Forward proof abhi chhota (${picks.length}/10 trades) — pehle chhota size ya paper.` : null,
    recent: picks.slice(-8).reverse().map((x) => ({ symbol: x.symbol, signalDate: x.signalDate, net: x.net, R: x.R })),
  };
}
/** How long has each stock been on the list and how has it moved since first seen? (lastClose: {SYM: price}) */
function watchAges(items, lastClose) {
  const db = load(); const out = {};
  for (const it of items) {
    const rows = db.entries.filter((e) => e.symbol === it.symbol && e.setup === it.setup).sort((a, b) => (a.signalDate < b.signalDate ? -1 : 1));
    if (!rows.length) continue;
    const recent = rows.filter((r) => (new Date(it.signalDate) - new Date(r.signalDate)) / 86400000 <= 14);
    if (!recent.length) continue;
    const first = recent[0]; const lc = lastClose?.[it.symbol];
    out[it.symbol] = { firstSeen: first.signalDate, daysOnList: new Set(recent.map((r) => r.signalDate)).size, sinceFirstPct: lc && first.signalClose ? Number(((lc / first.signalClose - 1) * 100).toFixed(1)) : null };
  }
  return out;
}
module.exports = { logPicks, logBest, refreshOutcomes, forwardStats, watchAges };
