// server/visionImport.js
// Optional: extract stock price/candle data from an uploaded screenshot
// (e.g. a broker app's chart or price table) using Claude's vision API, so
// the user can "just screenshot it" instead of typing numbers by hand.
//
// Requires ANTHROPIC_API_KEY in .env. Without it, this feature is disabled
// and the route returns a clear message telling the user how to enable it.
const axios = require('axios');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You extract stock price data from a screenshot (trading app, broker app, or chart).
Return ONLY strict JSON, no prose, no markdown fences, matching this shape:
{
  "symbol": "string or null",
  "currentPrice": number or null,
  "changePercent": number or null,
  "candles": [ { "date": "YYYY-MM-DD or null", "open": number, "high": number, "low": number, "close": number, "volume": number or null } ]
}
Rules:
- "candles" holds any historical/daily rows you can actually read (a table, a list, or points you can estimate from a line/candlestick chart). If you cannot confidently read individual OHLC rows, return an empty array for "candles" - do not invent numbers.
- If only a single current price and % change are visible (e.g. a watchlist row), fill "currentPrice"/"changePercent" and leave "candles" empty.
- Numbers must be plain numbers (no currency symbols, no commas).
- If nothing usable is visible, return all nulls and an empty candles array.`;

function isEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function extractFromImage(base64Data, mediaType) {
  if (!isEnabled()) {
    const err = new Error('Screenshot analysis is not enabled. Add ANTHROPIC_API_KEY to your .env to turn it on.');
    err.code = 'VISION_DISABLED';
    throw err;
  }

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: 'Extract the stock data from this screenshot as the specified JSON.' },
          ],
        },
      ],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const textBlock = (res.data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No response from vision model');

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not parse extracted data — try a clearer screenshot');
  }
  return parsed;
}

module.exports = { extractFromImage, isEnabled };
