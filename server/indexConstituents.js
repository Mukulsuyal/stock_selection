// server/indexConstituents.js
// FALLBACK-ONLY curated symbol lists. On startup (and weekly thereafter),
// server/nseIndexList.js fetches the OFFICIAL, full constituent lists
// (Nifty 50 = 50 stocks, Nifty Midcap 150 = 150, Nifty Smallcap 250 = 250 -
// ~450 total) from NSE's public CSV archives and overwrites the `symbols`
// arrays below in place. These hand-curated ~50/65/49 lists only remain in
// use if that fetch ever fails (NSE archives unreachable from this host) -
// a safety net, not the primary source of truth anymore.

const NIFTY50 = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'HINDUNILVR', 'ITC', 'SBIN',
  'BHARTIARTL', 'BAJFINANCE', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI',
  'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'WIPRO', 'NESTLEIND', 'TATAMOTORS', 'TATASTEEL',
  'POWERGRID', 'NTPC', 'HCLTECH', 'BAJAJFINSV', 'ADANIENT', 'ADANIPORTS', 'ONGC', 'M&M',
  'JSWSTEEL', 'TECHM', 'INDUSINDBK', 'GRASIM', 'CIPLA', 'DRREDDY', 'EICHERMOT',
  'BRITANNIA', 'DIVISLAB', 'HEROMOTOCO', 'BPCL', 'COALINDIA', 'HINDALCO', 'SBILIFE',
  'HDFCLIFE', 'APOLLOHOSP', 'BAJAJ-AUTO', 'TATACONSUM', 'UPL', 'LTIM', 'SHRIRAMFIN',
];

const NIFTY_MIDCAP = [
  'PERSISTENT', 'INDHOTEL', 'MFSL', 'GODREJPROP', 'ASHOKLEY', 'LUPIN', 'TVSMOTOR', 'MRF',
  'CUMMINSIND', 'BHARATFORG', 'FEDERALBNK', 'IDFCFIRSTB', 'PAGEIND', 'PIIND', 'POLYCAB',
  'AUROPHARMA', 'CONCOR', 'BALKRISIND', 'ABCAPITAL', 'ALKEM', 'APLAPOLLO', 'ASTRAL',
  'AUBANK', 'BANDHANBNK', 'BATAINDIA', 'BERGEPAINT', 'CANFINHOME', 'COFORGE', 'COLPAL',
  'CROMPTON', 'DALBHARAT', 'DEEPAKNTR', 'DIXON', 'EXIDEIND', 'GMRINFRA', 'GODREJCP',
  'GODREJIND', 'GUJGASLTD', 'HAL', 'HINDPETRO', 'IEX', 'IGL', 'INDIANB', 'IPCALAB',
  'JINDALSTEL', 'JUBLFOOD', 'LICHSGFIN', 'LTTS', 'MANAPPURAM', 'MPHASIS', 'NAVINFLUOR',
  'OBEROIRLTY', 'OFSS', 'PETRONET', 'PFC', 'RECLTD', 'SAIL', 'SRF', 'SUNTV', 'SUPREMEIND',
  'TATACHEM', 'TATAPOWER', 'TORNTPHARM', 'TRENT', 'VOLTAS',
];

const NIFTY_SMALLCAP = [
  'SUZLON', 'YESBANK', 'IDEA', 'RVNL', 'IRFC', 'IREDA', 'MAZDOCK', 'HUDCO', 'RAILTEL',
  'NBCC', 'CDSL', 'CAMS', 'ANGELONE', 'KFINTECH', 'CGPOWER', 'KPITTECH', 'TATATECH',
  'TTML', 'RATNAMANI', 'JBCHEPHARM', 'GRANULES', 'LAURUSLABS', 'GALAXYSURF', 'FINEORG',
  'CLEAN', 'ROUTE', 'HAPPSTMNDS', 'LATENTVIEW', 'MAPMYINDIA', 'DEVYANI', 'SAPPHIRE',
  'SONACOMS', 'UNOMINDA', 'KAYNES', 'AMBER', 'CENTURYPLY', 'GREENPANEL', 'HEIDELBERG',
  'JKCEMENT', 'ORIENTCEM', 'WELCORP', 'WELSPUNLIV', 'ZOMATO', 'PAYTM', 'NYKAA',
  'POLICYBZR', 'PVRINOX', 'METROPOLIS', 'GLAND', 'JUBLPHARMA',
];

const INDEXES = {
  nifty50: { label: 'Nifty 50', symbols: NIFTY50 },
  midcap: { label: 'Midcap', symbols: NIFTY_MIDCAP },
  smallcap: { label: 'Smallcap', symbols: NIFTY_SMALLCAP },
};

module.exports = { INDEXES };
