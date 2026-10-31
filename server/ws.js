// server/ws.js
// WebSocket server: clients subscribe to symbols and receive live price
// pushes at a fixed interval, sourced through the multi-source aggregator
// (Upstox first when configured, Yahoo otherwise).
//
// NOTE on Upstox's own WebSocket feed: Upstox's real-time market-data feed
// uses a binary/protobuf-based streaming protocol with its own connection
// handshake. Implementing that correctly without testing against a live
// account/token in this environment would be high-risk to ship broken and
// silently deliver garbage prices - worse than not having it. Instead,
// this relay polls the REST quote endpoint (via the same aggregator used
// everywhere else) on a short interval and pushes updates over our own
// WebSocket to the browser - functionally "live" for this app's purposes,
// and automatically gets more accurate/faster once Upstox is configured
// (a real broker feed) since the aggregator tries Upstox first. If you
// specifically need Upstox's raw tick-by-tick WebSocket protocol, that's a
// separate, larger addition - flag it and we can scope it properly with
// live testing.
const WebSocket = require('ws');
const { getMultiSourceQuote } = require('./dataProviders/aggregator');

function attachWebSocket(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const subscriptions = new Map(); // symbol -> Set<ws>

  wss.on('connection', (ws) => {
    ws.subscribedSymbols = new Set();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'subscribe' && msg.symbol) {
        const symbol = msg.symbol.toUpperCase();
        ws.subscribedSymbols.add(symbol);
        if (!subscriptions.has(symbol)) subscriptions.set(symbol, new Set());
        subscriptions.get(symbol).add(ws);
      }

      if (msg.type === 'unsubscribe' && msg.symbol) {
        const symbol = msg.symbol.toUpperCase();
        ws.subscribedSymbols.delete(symbol);
        subscriptions.get(symbol)?.delete(ws);
      }
    });

    ws.on('close', () => {
      for (const symbol of ws.subscribedSymbols) {
        subscriptions.get(symbol)?.delete(ws);
      }
    });
  });

  const intervalMs = Number(process.env.QUOTE_POLL_INTERVAL_MS) || 8000;
  setInterval(async () => {
    for (const [symbol, clients] of subscriptions.entries()) {
      if (!clients.size) { subscriptions.delete(symbol); continue; }
      try {
        const msQuote = await getMultiSourceQuote(symbol);
        const last = msQuote.fields.lastPrice?.value ?? null;
        let pChange = msQuote.fields.pChange?.value ?? null;
        const change = msQuote.fields.change?.value ?? null;
        const previousClose = msQuote.fields.previousClose?.value ?? null;
        if ((pChange == null || pChange === 0) && change != null && previousClose > 0) {
          pChange = (Number(change) / Number(previousClose)) * 100;
        }
        if ((pChange == null || pChange === 0) && last != null && previousClose > 0) {
          pChange = ((Number(last) - Number(previousClose)) / Number(previousClose)) * 100;
        }
        const quote = {
          lastPrice: last,
          pChange,
          change,
          previousClose,
          source: msQuote.fields.lastPrice?.source ?? 'unavailable',
          asOf: msQuote.fields.lastPrice?.timestamp ?? msQuote.fetchedAt,
        };
        const payload = JSON.stringify({ type: 'quote', symbol, quote });
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) client.send(payload);
        }
      } catch (err) {
        // silent - next tick will retry
      }
    }
  }, intervalMs);

  console.log(`[ws] websocket server attached at /ws (poll interval ${intervalMs}ms, source: multi-provider aggregator)`);
  return wss;
}

module.exports = { attachWebSocket };
