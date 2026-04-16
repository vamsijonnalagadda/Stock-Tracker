# Market Talk

A lightweight market web app that scrapes financial data directly from Yahoo Finance and GuruFocus webpages, eliminating the need for API keys.

## What it includes

- `server.js` — Express backend that scrapes financial data from websites using Puppeteer
- `index.html` — frontend with a search box and comprehensive metric display
- `package.json` — project manifest with required dependencies
- `DATA_SOURCES.md` — documentation for the data sources used by the app

## Current Status

✅ **Web Scraping Implementation:**
- Scrapes Yahoo Finance and GuruFocus pages directly (no API keys needed)
- Falls back to API sources (EODHD, Alpha Vantage, Finnhub, FMP) if scraping fails
- TradingView consensus ratings and RSI values (API-based, free/lightweight)
- **Note**: Web scraping may be slower (15-20 seconds per request) due to browser automation

## Data Metrics Available

✅ **Available from Web Scraping:**
- P/E ratio
- PEG ratio
- Market cap
- Price target (analyst consensus)
- Company name and exchange

✅ **Available from Fallback APIs:**
- EBITDA, FCF, OCF, EV/EBITDA (from EODHD)
- Additional financial metrics from multiple sources

✅ **Available from TradingView:**
- Buy/Hold/Sell Consensus Rating
- RSI (Relative Strength Index)

## Benefits of Web Scraping Approach

✅ **No API keys required** — Everything works out of the box
✅ **No rate limiting** — Use any ticker without worrying about quotas
✅ **Direct data source** — Scrapes what users see on the page
✅ **Graceful fallbacks** — Falls back to APIs if scraping fails
✅ **Comprehensive** — Combines multiple sources automatically

⚠️ **Trade-offs:**
- Slower than APIs (website load + data extraction time)
- May break if website layouts change
- Heavier resource usage (browser automation)

## Local setup

### Prerequisites
- Node.js v20.20.2+ and npm (locally installed at `~/local/node/bin/` if system Node unavailable)
- No API keys needed for web scraping (optional for enhanced fallbacks)

### Quick Start

```bash
cd ~/market-talk
npm install
npm start
```

No environment variables needed for basic functionality! Web scraping works out of the box.

For optional fallback APIs, set these (but scrapers will be tried first):

```bash
export ALPHA_VANTAGE_API_KEY=your_key_here
export FINNHUB_API_KEY=your_key_here
export FINNHUB_WEBHOOK_SECRET=your_secret_here
export FMP_API_KEY=your_key_here
export EODHD_API_KEY=your_key_here
npm start
```

Or run server directly:

```bash
PATH=~/local/node/bin:$PATH \
~/local/node/bin/node server.js
```

Then open a separate terminal and serve the frontend:

```bash
cd ~/stock-tracker
python3 -m http.server 8000
```

Open `http://localhost:8000/index.html` in your browser. The backend API runs on `http://localhost:4000`.

### Usage

Enter any ticker symbol like `AAPL`, `MSFT`, or `TSLA` and click Search. The app will:
1. Scrape Yahoo Finance and GuruFocus webpages for primary metrics  
2. Enhance with TradingView consensus data
3. Fall back to APIs if scraping needs enhancement

Displayed metrics include:
- Forward P/E Ratio
- PEG Ratio
- EV / EBITDA (if available from fallback sources)
- FCF Yield (if available)
- OCF Yield (if available)
- Market Cap
- Average Price Target
- TradingView Consensus Rating (Strong Buy / Buy / Hold / Sell / Strong Sell)
- TradingView RSI value

## Data Sources

### Primary (Web Scraping)
1. **Yahoo Finance** — Direct webpage scraping using Puppeteer
2. **GuruFocus** — Direct webpage scraping using Puppeteer

### Fallback (APIs - used if scraping insufficient or fails)
3. **EOD Historical Data** — Free API with comprehensive metrics
4. **Alpha Vantage** — Stock fundamentals API
5. **Finnhub** — Financial metrics API
6. **Financial Modeling Prep** — Company profile API
7. **Nasdaq API** — Public data (basic metrics)

### Additional
- **TradingView Scanner** — Consensus ratings and RSI (API-based)

## Data Sources & Fallback Chain

The backend tries sources in this order:

1. **Yahoo Finance** (web scraped) — Try to get metrics directly from Yahoo pages
2. **GuruFocus** (web scraped) — Try to get metrics directly from GuruFocus pages
3. **EOD Historical Data** (API) — Comprehensive financial metrics if scraping insufficient
4. **Alpha Vantage** (API) — Stock fundamentals and technical data
5. **Finnhub** (API) — Financial metrics and company data
6. **Financial Modeling Prep** (API) — Company profile data
7. **Nasdaq API** (API) — Public data (most basic metrics)

## Technical Architecture

- **Backend**: Express.js with Puppeteer for web scraping
- **Browser Automation**: Puppeteer (headless Chromium) for parsing JavaScript-heavy pages
- **Frontend**: Vanilla HTML/CSS/JavaScript with client-side API calls
- **API Endpoints**:
  - `GET /api/ticker/:symbol` — Fetch all metrics for a ticker (uses scraping + fallback APIs)
  - `GET /api/trending` — Fast cached top-10 trending symbols with live price enrichment
  - `GET /api/options/active` — Alpha Vantage most-active base symbols + Yahoo nearest expiry contract activity
  - `GET /api/options/:symbol` — Yahoo nearest expiry options chain snapshot for one ticker
  - `POST /webhook/finnhub` — Receive real-time updates from Finnhub
  - `GET /api/cache/:symbol` — View cached Finnhub trade data

## Trending Poller

The server now runs a background trending refresh loop:

- Polls StockTwits trending symbols every 5 minutes
- Enriches top 10 with live quote/session data
- Persists latest snapshot to `data/trending.json`
- Serves cached data from `GET /api/trending`

### Environment variable

- `TRENDING_POLL_INTERVAL_MS` (optional): polling interval in milliseconds, default `300000`

## Instant Trending Hydration

The root HTML response injects `window.INITIAL_TRENDING_DATA` so social trending chips can render immediately before the first fetch completes.

## Active Options Cache

- Active options strip cache TTL: 1 hour
- Per-ticker options cache TTL: 1 hour
- Persisted files:
  - `data/active_options.json`
  - `data/options_by_ticker.json`

## Performance Notes

- **First request**: ~15-20 seconds (browser startup + page load + parsing)
- **Subsequent requests**: ~10-15 seconds each (browser reuse optimizations)
- **If scraping fails**: Falls back to APIs (~2-5 seconds)
- **TradingView data**: ~1-2 seconds (lightweight API call)

## Advantages Over API-Only Approach

| Feature | Web Scraping | API Keys |
|---------|-------------|----------|
| Setup complexity | ✅ Zero | ❌ Multiple keys needed |
| Rate limiting | ✅ None | ⚠️ Varies by provider |
| Data availability | ✅ What users see | ⚠️ Limited by free tier |
| Reliability | ✅ Matches website | ⚠️ API changes/deprecation |
| Performance | ⚠️ Slower | ✅ Fast |
| Maintenance | ⚠️ Page changes | ✅ Stable |

## Troubleshooting

**"Connection timeout" error?**
- Puppeteer might need more resources or the website is slow
- Server falls back to APIs automatically

**Some metrics show "N/A"?**
- Scraping may miss some metrics; fallback APIs provide additional data
- Different sources track different metrics

**Want to speed things up?**
- Add API keys in environment variables to enable faster fallback paths
- Or configure Puppeteer pool for parallel requests (advanced)

## Notes

- This app uses web scraping (primary) and free/official APIs (fallback)
- For production use, add proper caching, rate limiting, and error monitoring
- See `DATA_SOURCES.md` for detailed source documentation and limitations


