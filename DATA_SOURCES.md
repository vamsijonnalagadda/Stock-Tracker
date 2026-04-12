# Data Sources

This project combines **web scraping** (primary) with **free APIs** (fallback) for comprehensive stock data retrieval. No API keys required for basic functionality.

## Primary Data Sources (Web Scraping)

### Yahoo Finance (Scraped)

- **URL**: `https://finance.yahoo.com/quote/{symbol}`
- **Method**: Puppeteer browser automation + DOM parsing
- **Used for**: Primary source of company financials and real-time data
- **Included metrics**:
  - Current stock price
  - P/E ratio
  - PEG ratio  
  - Market capitalization
  - 1-year price target
  - Company name and sector

**Advantages:**
- ✅ No API key needed
- ✅ Data shown directly on webpage
- ✅ No rate limiting
- ✅ Institutional-grade data

**Limitations:**
- ⚠️ Slower than APIs (page load + parsing time)
- ⚠️ Page structure changes may break selectors
- ⚠️ Requires browser automation (Puppeteer/Chromium)

### GuruFocus (Scraped)

- **URL**: `https://www.gurufocus.com/stock/{symbol}/summary`
- **Method**: Puppeteer browser automation + DOM parsing
- **Used for**: Comprehensive fundamental analysis metrics
- **Included metrics**:
  - P/E ratio
  - PEG ratio
  - EV/EBITDA
  - Market cap
  - Free cash flow
  - Operating cash flow
  - Financial scores (Piotroski, Beneish, Altman Z-Score - if displayed)

**Advantages:**
- ✅ Most comprehensive free fundamental metrics
- ✅ No authentication required
- ✅ Professional-quality data

**Limitations:**
- ⚠️ Slower than APIs
- ⚠️ Page dominated by JavaScript rendering
- ⚠️ May show different metrics for different users

## Fallback Data Sources (APIs)

## Fallback Data Sources (APIs)

### EOD Historical Data (EODHD)

- **Endpoint**: `https://eodhd.com/api/fundamentals/{symbol}?api_token=demo`
- **Used for**: Primary fallback with comprehensive financial metrics
- **Optional**: Free account from https://eodhd.com (defaults to demo tier if no key provided)
- **Included metrics**:
  - P/E ratio (trailing)
  - PEG ratio
  - Market capitalization
  - EBITDA
  - Operating Cash Flow (OCF)
  - Free Cash Flow (FCF)
  - Enterprise Value / EBITDA
  - Wall Street target price

**Recommended free alternative** when scrapers are slow or need enhancement.

### Alpha Vantage

- **Endpoint**: `https://www.alphavantage.co/query?function=OVERVIEW`
- **Used for**: Stock fundamentals (optional fallback)
- **Requires**: Free API key from https://www.alphavantage.co
- **Included metrics**:
  - Trailing P/E ratio
  - PEG ratio
  - Market capitalization
  - EPS

### Finnhub

- **Endpoint**: `https://finnhub.io/api/v1/stock/metric`
- **Used for**: Financial metrics (optional fallback)
- **Requires**: Free API key from https://finnhub.io
- **Includes**: Forward P/E, PEG, market cap, EPS, dividends

### Financial Modeling Prep

- **Endpoint**: `https://financialmodelingprep.com/api/v3/profile`
- **Used for**: Company profile (optional fallback)
- **Requires**: Free API key from https://financialmodelingprep.com
- **Includes**: Price, market cap, P/E, PEG, EPS

### Nasdaq API

- **Endpoint**: `https://api.nasdaq.com/api/quote/{symbol}/summary`
- **Used for**: Basic public data (fallback)
- **Includes**: Price, market cap, 1-year price target
- **Advantage**: No API key required

### TradingView Scanner

- **Endpoint**: `https://scanner.tradingview.com/america/scan` (POST)
- **Used for**: Additional consensus ratings and technical indicators
- **Included metrics**:
  - Consensus rating (Buy/Hold/Sell)
  - RSI (Relative Strength Index)
- **Advantage**: Free, no authentication

## Fallback Chain

When a data source fails or is insufficient, the backend tries sources in this order:

1. **Yahoo Finance** (web scraped) — Primary source, direct from website
2. **GuruFocus** (web scraped) — Comprehensive fundamentals from website  
3. **EOD Historical Data** (API) — Recommended free API with good metric coverage
4. **Alpha Vantage** (API) — Additional stock fundamentals
5. **Finnhub** (API) — Financial metrics and quotes
6. **Financial Modeling Prep** (API) — Company profile data
7. **Nasdaq** (API) — Basic public metrics

**Plus:** TradingView consensus ratings (always added if available)

## Comparison Table

| Source | Method | Speed | Metrics | No Setup | Status |
|--------|--------|-------|---------|----------|--------|
| Yahoo | Scrape | ⚠️ Slow | ✅ Good | ✅ Yes | Primary |
| GuruFocus | Scrape | ⚠️ Slow | ✅✅ Best | ✅ Yes | Primary |
| EODHD | API | ✅ Fast | ✅ Good | ✅ Yes (demo) | Fallback |
| Alpha Vantage | API | ✅ Fast | ⚠️ Basic | ❌ Key needed | Fallback |
| Finnhub | API | ✅ Fast | ⚠️ Basic | ❌ Key needed | Fallback |
| FMP | API | ✅ Fast | ⚠️ Basic | ❌ Key needed | Fallback |
| TradingView | API | ✅ Fast | ✅ Ratings | ✅ Yes | Enhancement |

## Notes

- **Web scraping** is the primary approach (no authentication needed)
- **APIs** are used as fallback when scraping is slow, incomplete, or fails
- All free tiers have usage limits; production use should implement caching
- Web scraping performance: ~10-20 seconds per request (includes browser startup)
- API calls: ~2-5 seconds per request
- For production, consider hosted solutions or paid APIs for guaranteed uptime and performance

