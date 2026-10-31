/**
 * Mobile alerts for Morning Storm + Golden tiers (Diamond/Gold/Silver/Bronze).
 *
 * Env (put in .env):
 *   ALERT_PHONE=+91XXXXXXXXXX          // E.164 with country code
 *   ALERT_CHANNELS=whatsapp,sms         // which to try (comma)
 *
 * Twilio (recommended for WhatsApp + SMS):
 *   TWILIO_ACCOUNT_SID=
 *   TWILIO_AUTH_TOKEN=
 *   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886   // Twilio sandbox or approved sender
 *   TWILIO_WHATSAPP_CONTENT_SID=HXxxxxxxxx       // required on many accounts (template body {{1}})
 *   TWILIO_SMS_FROM=+1XXXXXXXXXX
 *
 * Optional CallMeBot WhatsApp (simple API key from callmebot.com):
 *   CALLMEBOT_APIKEY=
 *   (uses ALERT_PHONE without + for some setups; we strip non-digits)
 *
 * Optional Telegram:
 *   TELEGRAM_BOT_TOKEN=
 *   TELEGRAM_CHAT_ID=
 *
 * Toggle:
 *   ALERT_MOBILE_ENABLED=true   // default false — set true only when you want WhatsApp
 *   ALERT_INCLUDE_BRONZE=true   // testing; set false later
 *   ALERT_COOLDOWN_MIN=30       // same symbol+channel don't re-ping within N min
 */
const axios = require('axios');

const enabled = () => String(process.env.ALERT_MOBILE_ENABLED || 'false').toLowerCase() === 'true';
const phone = () => String(process.env.ALERT_PHONE || process.env.MOBILE_ALERT_PHONE || '').trim();
const includeBronze = () => String(process.env.ALERT_INCLUDE_BRONZE || 'true').toLowerCase() !== 'false';
const cooldownMs = () => Math.max(5, Number(process.env.ALERT_COOLDOWN_MIN || 30)) * 60 * 1000;

/** E.164-ish: strip spaces/dashes; India 10-digit → +91 */
function normalizeE164(raw) {
  if (!raw) return '';
  let s = String(raw).trim().replace(/[\s()-]/g, '');
  if (s.startsWith('whatsapp:')) s = s.slice('whatsapp:'.length);
  if (!s.startsWith('+')) {
    const digits = s.replace(/\D/g, '');
    if (digits.length === 10) s = '+91' + digits;
    else if (digits.length === 12 && digits.startsWith('91')) s = '+' + digits;
    else if (digits.length >= 10) s = '+' + digits;
    else s = '+' + digits;
  }
  // Fix common +910XXXXXXXXX (extra 0 after country code)
  if (/^\+910\d{9}$/.test(s)) s = '+91' + s.slice(4);
  return s;
}

function normalizeWhatsAppAddress(raw) {
  const e164 = normalizeE164(raw);
  if (!e164) return '';
  return e164.startsWith('whatsapp:') ? e164 : 'whatsapp:' + e164;
}

// in-memory dedupe: key -> lastSentAt
const recent = new Map();

function channels() {
  const raw = process.env.ALERT_CHANNELS || 'whatsapp,sms,telegram';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function shouldSend(dedupeKey) {
  const last = recent.get(dedupeKey) || 0;
  if (Date.now() - last < cooldownMs()) return false;
  recent.set(dedupeKey, Date.now());
  // prune
  if (recent.size > 500) {
    const cut = Date.now() - cooldownMs() * 2;
    for (const [k, t] of recent) if (t < cut) recent.delete(k);
  }
  return true;
}

async function sendTwilioWhatsApp(text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = normalizeWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM || '');
  const to = normalizeWhatsAppAddress(phone());
  if (!sid || !token || !from || !to) {
    return { ok: false, skip: true, reason: 'twilio whatsapp env incomplete', from, to };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const contentSid = (process.env.TWILIO_WHATSAPP_CONTENT_SID || '').trim();

  // Twilio WhatsApp often requires a pre-approved Content Template (ContentSid).
  // Free-form Body only works in an open customer-care session (user messaged you first).
  const params = new URLSearchParams({ From: from, To: to });
  if (contentSid) {
    params.set('ContentSid', contentSid);
    // Map full alert into variable {{1}} — template must have one body variable
    const short = String(text || '').slice(0, 900);
    params.set('ContentVariables', JSON.stringify({ '1': short }));
  } else {
    params.set('Body', text);
  }

  try {
    const res = await axios.post(url, params.toString(), {
      auth: { username: sid, password: token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    return { ok: true, sid: res.data?.sid, channel: 'twilio-whatsapp', to, from, usedContentSid: Boolean(contentSid) };
  } catch (err) {
    const data = err.response?.data;
    const msg = data?.message || data?.error_message || err.message;
    const code = data?.code || err.response?.status;
    console.error('[mobileNotify] twilio whatsapp fail', code, msg);
    let hint = null;
    if (code === 21654 || /ContentSid/i.test(String(msg))) {
      hint = 'Twilio needs ContentSid. Create a WhatsApp Content Template in Twilio Console → Content Template Builder, then set TWILIO_WHATSAPP_CONTENT_SID=HXxxxx. Or use CALLMEBOT_APIKEY for freeform WhatsApp.';
    }
    if (code === 63016 || /24 hour/i.test(String(msg))) {
      hint = 'Outside 24h window: user must message the Twilio WhatsApp number first, or use a template (ContentSid).';
    }
    return { ok: false, error: msg, code, channel: 'twilio-whatsapp', to, from, hint };
  }
}

async function sendTwilioSms(text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = normalizeE164(process.env.TWILIO_SMS_FROM || '');
  const to = normalizeE164(phone());
  if (!sid || !token || !from || !to) return { ok: false, skip: true, reason: 'twilio sms env incomplete' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({ From: from, To: to, Body: text });
  const res = await axios.post(url, body.toString(), {
    auth: { username: sid, password: token },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return { ok: true, sid: res.data?.sid, channel: 'twilio-sms' };
}

async function sendCallMeBot(text) {
  const apikey = process.env.CALLMEBOT_APIKEY;
  const toPhone = phone().replace(/\D/g, '');
  if (!apikey || !toPhone) return { ok: false, skip: true, reason: 'callmebot env incomplete' };
  const url = 'https://api.callmebot.com/whatsapp.php';
  await axios.get(url, {
    params: { phone: toPhone, text, apikey },
    timeout: 15000,
  });
  return { ok: true, channel: 'callmebot-whatsapp' };
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { ok: false, skip: true, reason: 'telegram env incomplete' };
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chat,
    text,
    disable_web_page_preview: true,
  }, { timeout: 15000 });
  return { ok: true, channel: 'telegram' };
}

async function dispatch(text, dedupeKey) {
  console.log('[mobileNotify] dispatch start', {
    enabled: enabled(),
    channels: channels(),
    phoneRaw: phone() ? (phone().slice(0, 4) + '***' + phone().slice(-2)) : '(empty)',
    phoneNorm: phone() ? normalizeE164(phone()) : '',
    hasTwilioSid: Boolean(process.env.TWILIO_ACCOUNT_SID),
    hasTwilioToken: Boolean(process.env.TWILIO_AUTH_TOKEN),
    whatsappFromRaw: process.env.TWILIO_WHATSAPP_FROM || '(empty)',
    whatsappFromNorm: normalizeWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM || ''),
    textLen: (text || '').length,
    dedupeKey: dedupeKey || null,
  });

  if (!enabled()) {
    // Silent when off (default) — no terminal spam
    return { ok: false, reason: 'ALERT_MOBILE_ENABLED=false' };
  }
  if (!phone() && !process.env.TELEGRAM_CHAT_ID) {
    console.warn('[mobileNotify] no ALERT_PHONE');
    return { ok: false, reason: 'ALERT_PHONE / TELEGRAM_CHAT_ID not set' };
  }
  if (dedupeKey && !shouldSend(dedupeKey)) {
    console.log('[mobileNotify] cooldown skip', dedupeKey);
    return { ok: false, reason: 'cooldown', dedupeKey };
  }

  const results = [];
  const ch = channels();
  for (const c of ch) {
    try {
      if (c === 'whatsapp') {
        let r = await sendTwilioWhatsApp(text);
        console.log('[mobileNotify] twilio-whatsapp result', {
          ok: r.ok, skip: r.skip, error: r.error, code: r.code, to: r.to, from: r.from, sid: r.sid, hint: r.hint,
        });
        if (!r.ok) {
          // Always try CallMeBot on Twilio failure if configured (freeform WhatsApp)
          if (process.env.CALLMEBOT_APIKEY) {
            const r2 = await sendCallMeBot(text).catch((e) => ({ ok: false, error: e.message, channel: 'callmebot-whatsapp' }));
            console.log('[mobileNotify] callmebot fallback', r2);
            results.push(r);
            results.push(r2);
            continue;
          }
          if (r.hint) console.warn('[mobileNotify] hint:', r.hint);
        }
        results.push(r);
      } else if (c === 'sms') {
        const r = await sendTwilioSms(text).catch((e) => ({ ok: false, error: e.message, channel: 'sms' }));
        console.log('[mobileNotify] sms result', r);
        results.push(r);
      } else if (c === 'telegram') {
        const r = await sendTelegram(text).catch((e) => ({ ok: false, error: e.message, channel: 'telegram' }));
        console.log('[mobileNotify] telegram result', r);
        results.push(r);
      }
    } catch (err) {
      console.error('[mobileNotify] channel exception', c, err.message);
      results.push({ ok: false, error: err.message, channel: c });
    }
  }
  const any = results.some((r) => r.ok);
  if (any) console.log('[mobileNotify] SENT OK via', results.filter((r) => r.ok).map((r) => r.channel).join(','));
  else console.warn('[mobileNotify] ALL FAILED', JSON.stringify(results));
  return {
    ok: any,
    results,
    debug: {
      phoneNorm: phone() ? normalizeE164(phone()) : '',
      whatsappTo: phone() ? normalizeWhatsAppAddress(phone()) : '',
      whatsappFrom: normalizeWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM || ''),
      channels: ch,
    },
  };
}

function formatStormMessage(picks = []) {
  if (!picks.length) return null;
  const lines = picks.slice(0, 5).map((p) => {
    const px = p.price != null ? `₹${p.price}` : '';
    return `• ${p.symbol} ${px}`;
  });
  return `⚡ StockLens Morning Storm\n${lines.join('\n')}\nPage open nahi bhi ho to scan naya pick. App me check karo.`;
}

function formatGoldenMessage(tierRows = []) {
  // tierRows: [{ tier, symbol, price }]
  if (!tierRows.length) return null;
  const icon = { diamond: '💎', gold: '🥇', silver: '🥈', bronze: '🥉' };
  const lines = tierRows.slice(0, 8).map((r) => {
    const ic = icon[r.tier] || '⭐';
    const px = r.price != null ? ` ₹${r.price}` : '';
    return `${ic} ${String(r.tier).toUpperCase()} ${r.symbol}${px}`;
  });
  return `StockLens Golden Setup\n${lines.join('\n')}\nApp me Golden / Analysis check karo.`;
}

/**
 * Notify new Morning Storm picks (only symbols not in previous set if provided).
 */
async function notifyMorningStorm(picks, { previousSymbols = [] } = {}) {
  try {
    const prev = new Set((previousSymbols || []).map((s) => String(s).toUpperCase()));
    const fresh = (picks || []).filter((p) => p?.symbol && !prev.has(String(p.symbol).toUpperCase()));
    const list = fresh.length ? fresh : (picks || []);
    // Only alert on truly new if we had a previous board
    if (previousSymbols?.length && !fresh.length) {
      return { ok: false, reason: 'no_new_storm_symbols' };
    }
    if (!list.length) return { ok: false, reason: 'empty' };
    const text = formatStormMessage(list);
    const key = `storm:${list.map((p) => p.symbol).sort().join(',')}`;
    return await dispatch(text, key);
  } catch (err) {
    console.warn('[mobileNotify] storm failed', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Notify golden tiers. Bronze included while ALERT_INCLUDE_BRONZE=true.
 */
async function notifyGoldenTiers(tiers = {}) {
  try {
    const rows = [];
    const order = ['diamond', 'gold', 'silver', 'bronze'];
    for (const tier of order) {
      if (tier === 'bronze' && !includeBronze()) continue;
      for (const r of tiers[tier] || []) {
        if (!r?.symbol) continue;
        rows.push({ tier, symbol: r.symbol, price: r.price });
      }
    }
    if (!rows.length) return { ok: false, reason: 'no_golden_rows' };
    const text = formatGoldenMessage(rows);
    const key = `golden:${rows.map((r) => r.tier + r.symbol).sort().join(',')}`;
    return await dispatch(text, key);
  } catch (err) {
    console.warn('[mobileNotify] golden failed', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  dispatch,
  notifyMorningStorm,
  notifyGoldenTiers,
  formatStormMessage,
  formatGoldenMessage,
};
