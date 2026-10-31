# StockLens — Poora Feature List

Ye document batata hai **abhi tak kya-kya bana hai**, **kaise use karna hai**, aur **kya limitations hain** (honestly, koi fake promise nahi). Har section mein ✅ (kaam karta hai) aur ⚠️ (limitation/not available) clearly marked hai.

---

## 1. Login & Account
| Feature | Status |
|---|---|
| Register/Login | ✅ MongoDB pe (tumhara khud ka DB) |
| Session/JWT auth | ✅ |

**Tab:** koi nahi (login screen sabse pehle aata hai)

---

## 2. Stock Analysis Engine (core dimaag)
| Feature | Status |
|---|---|
| Live price, OHLC, volume | ✅ Upstox (agar connect ho) → Yahoo Finance (fallback) |
| Technical indicators (SMA20/50/200, EMA9/21, RSI14, MACD, ATR14) | ✅ |
| Volume spike detection | ✅ |
| Weekly-chart confirmation (daily+weekly dono agree karein to bonus) | ✅ |
| Nifty 50 market-trend factor (trade with the market) | ✅ |
| Rule-based verdict (Bullish lean / Neutral / Bearish lean etc.) + score | ✅ |
| Support/Resistance levels (swing highs/lows) | ✅ |
| Candlestick patterns (Doji, Hammer, Engulfing, etc.) | ✅ |
| Consecutive up/down day streak detection | ✅ |
| Returns by period (1D/1W/15D/1M/2M/3M/1Y/5Y) | ✅ |

**Tab:** "Analysis" → koi bhi stock search karo ya list se click karo

---

## 3. Browse & Screening (bina search kiye dekhna)
| Feature | Status |
|---|---|
| Nifty50 / Midcap / Smallcap full-list browser | ✅ |
| Bulk Screener (apne symbols paste karo) | ✅ |
| Sortable, multi-column comparison table (sab periods ek saath) | ✅ |
| Falling/Rising N+ days streak filter | ✅ |
| **Top Picks** — auto "Best for Intraday/Short-term/Long-term" | ✅ |
| **Swing Setups** — Momentum (trending) + Reversal/Bounce (gira, ab upar) | ✅ |
| **Golden Setups** — bahut rare, "once in a lifetime" high-conviction alert | ✅ (jaanbujh kar rare, zyada tar din khaali) |
| Buy-zone indicator (✅ in zone / ⏳ neeche / ⏫ upar nikal gaya) | ✅ |
| "Recently removed" list + reason kyun hata | ✅ |
| "First flagged ₹X → now ₹Y" price history on every pick | ✅ |

**Tab:** "Analysis" (Nifty50/Midcap/Smallcap buttons) ya "Bulk Screener"

---

## 4. Individual Stock Page (kisi ek stock pe click karne ke baad)
| Feature | Status |
|---|---|
| Price chart (apna khud ka SVG chart, koi external library nahi) | ✅ |
| Fundamentals (P/E, EPS, ROE, Debt/Equity, Dividend Yield, etc.) | ✅ Yahoo se |
| News headlines + earnings-date warning | ✅ |
| Multi-Timeframe Analysis (5m/15m/1h/4h/Daily/Weekly alignment) | ✅ on-demand button |
| Suggested Trade Plan (entry range, stop-loss, target, risk:reward) | ✅ |
| Risk & Position Size Calculator | ✅ |
| **Final Decision Card** (BUY NOW/WAIT/NO TRADE + WHY/WHY NOT) | ✅ on-demand button, login required |
| Backtest engine (win-rate, costs, benchmark, Monte Carlo, walk-forward) | ✅ on-demand button |
| Live price ticker (auto-updates during market hours) | ✅ |

**Tab:** "Analysis" → search/click any stock

---

## 5. Portfolio Tools
| Feature | Status |
|---|---|
| Watchlist | ✅ |
| Watchlist auto-check (hourly) + email jab verdict change ho | ✅ |
| Price Alerts (above/below) | ✅ |
| Trade Journal (entry/exit/stop-loss/target) | ✅ |
| **Position Manager** — "Hold ya Exit?" live decision for open trades | ✅ |
| Portfolio Overview (total P&L, sector concentration warning) | ✅ |

**Tabs:** "Watchlist", "Alerts", "Trade Journal"

---

## 6. Risk Management / Trading Discipline
| Feature | Status |
|---|---|
| Configurable: capital, risk %, min R:R, daily loss limit, max trades/day | ✅ |
| Cooldown after a loss | ✅ |
| Sector/stock exposure limits | ✅ |
| No-Trade Engine (high score bhi override nahi karta poor R:R/daily-limit ko) | ✅ |

**Tab:** "Settings"

---

## 7. Institutional Money Flow
| Feature | Status |
|---|---|
| FII/DII daily cash-market flow (1D/1W/1M/3M/6M/YTD/1Y) | ✅ NSE se (free) |
| Sector mapping | ✅ |
| Mutual Fund holdings-change | ⚠️ **not_available** — koi free bulk source nahi (40+ AMC alag PDF format mein) |
| Quarterly shareholding % change | ⚠️ **not_available** — company filings PDF/XBRL mein hain, free bulk API nahi |
| Sector/stock-level FII/DII positioning | ⚠️ **not_available** — sirf market-wide data free milta hai |

**Tab:** "Institutional Flow"

---

## 8. Recommendation Track Record (system khud apna homework check karta hai)
| Feature | Status |
|---|---|
| Daily log of every pick (price frozen usi din) | ✅ |
| Daily EOD price update on all past picks | ✅ |
| Win-rate + avg change % scorecard (1W/15D/1M/3M/6M/All) per category | ✅ |
| Full history table (kaunsa stock kab pick hua, kya hua) | ✅ |

**Tab:** "Track Record"

---

## 9. Market Context
| Feature | Status |
|---|---|
| Market Regime banner (Nifty/BankNifty trend + India VIX volatility) | ✅ |
| Market breadth (advance/decline) | ⚠️ **not_available** — free exchange-wide data nahi milta |

---

## 10. Data Sources (kahan se data aata hai)
| Source | Kis liye use hota hai | Status |
|---|---|---|
| **Upstox** | Live quotes, historical, intraday, Nifty/BankNifty/VIX (agar connect ho) | ⚠️ Optional — tumhara khud ka Upstox account chahiye, roz OAuth login karna padta hai (~3:30 AM IST token expire) |
| **Yahoo Finance** | Sab kuch (fallback jab Upstox na ho), fundamentals, news | ✅ Always available, free |
| **NSE** | FII/DII data | ⚠️ Kabhi-kabhi 403 block ho sakta hai (server IP block) — retry hota hai automatically |

**Settings tab** mein Upstox connect kar sakte ho.

---

## 11. Live Updates (bina refresh kiye)
| Feature | Status |
|---|---|
| WebSocket live price ticker | ✅ |
| Auto-refresh (60s) during market hours (9:00–3:40 IST) | ✅ current stock + positions + portfolio |
| Watchlist auto-refresh (5 min, market hours) | ✅ |

---

## ⚠️ Cheezein jo NAHI ban sakti (free mein, honestly)
- **Delivery %** — NSE-only data, free API nahi
- **Corporate actions** (board meetings, bonus/split announce, promoter pledge, bulk/block deal details, credit rating change) — bikhre hue PDF filings, koi bulk free source nahi
- **Mutual Fund kis stock mein kitna badhaya/ghataya** — AMFI centrally publish nahi karta
- **Quarterly shareholding %** — company-wise PDF filings
- **True market breadth** — exchange-wide advance/decline data free nahi
- **Upstox ka real tick-by-tick WebSocket** — binary protocol hai, bina live account test kiye risky, isliye reliable polling use kar rahe hain

---


---

## 12. Market Holiday Awareness
| Feature | Status |
|---|---|
| Weekend auto-detect (Sat/Sun) | ✅ automatic |
| NSE holiday calendar (manageable in Settings) | ✅ pre-loaded with fixed + confirmed 2026 festival dates |
| All daily picks/snapshots/alerts/emails skip on holiday | ✅ |
| Browsing still works (read-only, last available data) | ✅ |
| Holiday banner on Analysis tab | ✅ |

**Tab:** Banner shows on "Analysis"; manage list in "Settings"

## Kaise chalu karo
```bash
unzip stock-analyzer.zip && cd stock-analyzer
npm install
npm run dev
```
Browser mein `http://localhost:5000` kholo, register karo, aur explore karo.

---

## 🚀 Week Runner v2 (naya)
Capital-protection first weekly swing scanner. Tab: **Week Runner**.
- Signal sirf COMPLETED daily bar pe; entry NEXT DAY OPEN (gap-up >2% = skip).
- Gates: already-ran (1D/3D/5D/extension), liquidity (₹5cr/din), operator/pump/gap-prone, price ≥ ₹30.
- Market regime (Nifty vs SMA50/200, 5D fall, India VIX) → GREEN/AMBER/RED (RED = no trade).
- 3 setups (Squeeze, Pullback, RS Tight Base) — har ek universe walk-forward backtest (costs + gap-aware exits).
  Setup tabhi **LICENSED** jab out-of-sample expectancy/profit-factor/saal-wise consistency pass ho. Warna PAPER.
- Result-date blackout, sector cap, risk-based position size (gap buffer), live-price MISSED/INVALID check.
- Forward-test log (`data/week_runner_log.json`) + drawdown kill-switch.

### Week Runner v3 (Setup Lab)
- 5 setups: Squeeze, Pullback, RS Tight Base, Fresh Breakout, Oversold Bounce.
- **Setup Lab**: har setup × 3 exit style (7/10/15 din) × 2 stop width — chunav sirf TRAIN (pehla 60%) se; judge untouched TEST (aakhri 40%) se. Test expectancy ka lower-bound bhi >0 hona chahiye.
- Market regime GREEN/AMBER/BEAR/CRASH — kaun sa mausam allowed hai wo bhi TRAIN data se seekha jata hai (CRASH hamesha band).
- Har stock ke liye ✅ kyu lena / ❌ kyu nahi scorecard; paper list me "kitne din se list me" + tab se bhav-change.
- Near-miss sirf licensed + mausam-fit setups ke liye (have vs need ke saath).

### Week Runner v5 — roz ka Best Stock (ranking)
- Roz poore universe ko rank karta hai: stock strength (RS20/RS60), **sector strength** (sector ka median RS + breadth), coil, 20d/52w high se doori, dip depth, accumulation volume.
- 4 ranking variants × conviction threshold × stop × exit = 108 mixes; chunav sirf TRAIN (60%) se, judge untouched TEST se. Random-stock baseline se compare.
- Tier: PROVEN / LEAN (halka sanket, size 0.4×) / UNPROVEN (size 0.25× ya paper). Kamzor din (score < threshold), CRASH, result-date, MISSED => "Aaj koi nahi".
- UI: hero card + price-ladder diagram + funnel + sector bars + "bhaag chuke (chase mat karo)" + saboot (collapsed). Styles: public/weekrunner.css.
- Forward log: har #1 'best' kind me grade hota hai.
- Zaroori: Admin me sector sync chalao (SectorMap) warna sector factor neutral rehta hai.
