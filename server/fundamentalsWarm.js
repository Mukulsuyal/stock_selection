// Background fill of fundamentals_cache (one-by-one).
// On server start: warm full index universe; skip symbols already fresh in DB.
const marketData = require('./marketData');
const fundamentalsStore = require('./fundamentalsStore');
const { startJob, updateJob, endJob, getJob } = require('./progressStore');

let runningJobId = null;

/** IST windows when we may hit external APIs + write fundamentals_cache:
 *  - 09:45–10:15 morning
 *  - after 15:30 (post market)
 * Outside these: only read existing cache, no bulk warm / force save.
 */
function isFundamentalsRefreshWindow(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const weekday = get('weekday');
    if (weekday === 'Sat' || weekday === 'Sun') {
      // weekends: allow post-style refresh any time (optional) — keep false to avoid spam
      return process.env.FUND_WARM_WEEKEND === '1';
    }
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    const mins = hour * 60 + minute;
    const morning = mins >= 9 * 60 + 45 && mins < 10 * 60 + 15; // 09:45–10:15
    const afterClose = mins >= 15 * 60 + 30; // 15:30+
    return morning || afterClose;
  } catch (_) {
    return false;
  }
}


async function warmFundamentals(symbols, { jobId = null, delayMs = 450, forceAll = false, ignoreWindow = false } = {}) {
  const list = [...new Set((symbols || []).map((s) => String(s).replace(/\.(NS|BO)$/i, '').toUpperCase()).filter(Boolean))];
  const jid = jobId || `fund-warm-${Date.now()}`;
  if (!ignoreWindow && !forceAll && !isFundamentalsRefreshWindow()) {
    console.log('[fund-warm] skipped — outside window (only 09:45–10:15 IST or after 15:30 IST)');
    return { ok: true, skipped: true, reason: 'outside_fund_window', saved: 0, skippedCache: 0, failed: 0, total: list.length };
  }
  if (runningJobId) {
    return { ok: false, skipped: true, message: 'Warm already running', jobId: runningJobId };
  }
  runningJobId = jid;
  startJob(jid, list.length, `Fundamentals warm 0/${list.length}`);
  if (process.env.FUND_DEBUG === '1') console.log(`[fund-warm] start job=${jid} symbols=${list.length} forceAll=${!!forceAll}`);

  let saved = 0;
  let skipped = 0;
  let fail = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const sym = list[i];
      updateJob(jid, i + 1, {
        total: list.length,
        phase: 'warm',
        percent: Math.round(((i + 1) / list.length) * 100),
        message: `Fundamentals ${i + 1}/${list.length}: ${sym}`,
        detail: sym,
        log: sym,
      });

      if (!forceAll) {
        try {
          const c = await fundamentalsStore.readCache(sym, { maxAgeDays: 7 });
          if (c.hit && !c.stale && c.data) {
            skipped += 1;
            if ((i + 1) % 25 === 0) {
              if ((i + 1) % 50 === 0 || process.env.FUND_DEBUG === '1') console.log(`[fund-warm] ${i + 1}/${list.length} progress (cache skips ok)`);
            }
            continue;
          }
        } catch (_) {}
      }

      try {
        const data = await marketData.getFundamentals(sym, {
          forceRefresh: !!forceAll,
          maxAgeDays: forceAll ? 0 : 7,
        });
        if (data && (data.peTrailing != null || data.roe != null || data.marketCap != null || data.bookValue != null)) {
          saved += 1;
          if (process.env.FUND_DEBUG === '1') console.log(`[fund-warm] saved ${sym} source=${data.source || '?'} pe=${data.peTrailing ?? '-'} roe=${data.roe ?? '-'}`);
        } else if (data) {
          saved += 1;
          if (process.env.FUND_DEBUG === '1') console.log(`[fund-warm] saved ${sym} (partial)`);
        } else {
          fail += 1;
          if (process.env.FUND_DEBUG === '1') console.warn(`[fund-warm] empty ${sym}`);
        }
      } catch (err) {
        fail += 1;
        if (process.env.FUND_DEBUG === '1') console.warn(`[fund-warm] fail ${sym}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const msg = `Done — saved ${saved}, skipped ${skipped}, failed ${fail} / ${list.length}`;
    endJob(jid, msg);
    console.log(`[fund-warm] ${msg}`);
    return { ok: true, jobId: jid, saved, skipped, failed: fail, total: list.length };
  } finally {
    runningJobId = null;
  }
}

function warmStatus(jobId) {
  return getJob(jobId);
}

function isWarmRunning() {
  return !!runningJobId;
}

module.exports = { warmFundamentals, warmStatus, isFundamentalsRefreshWindow, isWarmRunning };
