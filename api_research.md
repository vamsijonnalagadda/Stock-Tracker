# GuruFocus Stock API Research Report

## Executive Summary

GuruFocus provides a comprehensive Data API for accessing stock fundamentals, valuations, and market data. The API is designed for fintech platforms, investment professionals, and developers. **There is NO completely free tier** - all API access requires either a GuruFocus membership or pay-as-you-go credits. However, membership users get monthly free API queries depending on their plan.

---

## 1. FREE API ENDPOINTS & ACCESS REQUIREMENTS

### Authentication Model
- **Required:** Authorization header with API token
- **Format:** `Authorization: Replace with your API token`
- **Header:** `{ 'Authorization': '<your_api_token>' }`

### Free Tier Access
The free API tier is **membership-based**, not unlimited. You must have a GuruFocus account membership:

| Plan | Monthly Free API Queries | Status |
|------|------------------------|--------|
| Free | 100 requests | Limited |
| Premium | 200 requests | Trial available (7 days) |
| Premium Plus | 500 requests | Trial available (7 days) |
| Professional | 2000 requests | Enterprise custom pricing |

### Overage Handling
- **Free Plan:** Upgrade required to continue after monthly limit
- **All Plans:** Can switch to Pay-As-You-Go ($100 initial credit minimum)
- **Enterprise:** Custom terms available (contact sales)

### Available Free Endpoints
The following endpoints are included in all subscription tiers (costs apply per request when using PAYG):

| Endpoint | Cost (PAYG) | Region Coverage |
|----------|-----------|-----------------|
| Stock List | $0.00 | Global (9 regions) |
| Company Profile | $0.10 | Global (60,000+ companies) |
| Fundamentals | $0.10 | Global (60,000+ companies) |
| Valuations | $0.10 | Global (60,000+ companies) |
| Dividends | $0.02 | Global |
| News | $0.02 | USA only |
| Rankings | $0.02 | Global |
| Segment Data | $0.05 | Global |
| Guru List | $0.00 | Global |
| Guru Trades | $0.10 | Global (4,500+ institutional investors) |
| Insider Trades | $0.02 | 2004+ historical data |
| ETF List | $0.00 | Global |
| ETF Data | $0.10 | Add-on ($90/month) |

---

## 2. AVAILABLE METRICS & DATA FIELDS

### A. Company Profile Endpoint Metrics
**Endpoint:** `GET /stocks/{symbol}/profile`

#### Valuation Ratios
- **P/E Ratio** (`pe`) - Current and historical (10-year highs/lows/medians)
- **P/E Without NRI** (`penri`) - Excludes non-recurring items
- **PEG Ratio** (`peg`) - Price/Earnings to Growth
- **Forward P/E** (`forwardPE`) - Forward-looking P/E
- **Forward PEG** (`forward_peg_ratio`)
- **P/B Ratio** (`pb`) - Price-to-Book
- **P/S Ratio** (`ps`) - Price-to-Sales
- **EV/EBITDA** (`ev2ebitda`) - Enterprise Value to EBITDA
- **EV/EBIT** (`ev2ebit`) - Enterprise Value to Operating Income
- **EV/Revenue** (`ev2rev`)
- **EV/OCF** (`ev2ocf`) - Enterprise Value to Operating Cash Flow
- **EV/FCF** (`ev2fcf`) - Enterprise Value to Free Cash Flow
- **Price-to-FCF** (`pfcf`)
- **Price-to-OCF** (`pocf`)

#### Profitability Metrics
- **Gross Margin %** (`grossmargin`)
- **Operating Margin %** (`oprt_margain`)
- **Net Margin %** (`net_margain`)
- **EBITDA Margin %** (`ebitda_margin`)
- **EBIT Margin %** (`ebit_margin`)
- **FCF Margin %** (`FCFmargin`)
- **OCF Margin %** (`ocf_margin`)
- **ROE %** (`roe`) - Return on Equity (10-year coverage with highs/lows/medians)
- **ROA %** (`roa`) - Return on Assets
- **ROIC %** (`roic`) - Return on Invested Capital
- **ROCE %** (`roce`) - Return on Capital Employed
- **WACC %** (`wacc`) - Weighted Average Cost of Capital (10-year coverage)

#### Liquidity & Solvency Ratios
- **Current Ratio** (`current_ratio`)
- **Quick Ratio** (`quick_ratio`)
- **Cash Ratio** (`cash_ratio`)
- **Debt-to-Equity** (`debt2equity`)
- **Debt-to-Assets** (`debt2asset`)
- **Debt-to-Revenue** (`debt2rev`)
- **Debt-to-EBITDA** (`debt2ebitda`)
- **Cash-to-Debt** (`cash2debt`)
- **Equity-to-Assets** (`equity2asset`)
- **Interest Coverage** (`interest_coverage`)

#### Financial Statement Fundamentals
- **Market Cap** (`mktcap`) - In millions: `mktcap_norm`
- **Enterprise Value** (`ev_morn`) - In millions: `ev_morn_norm`
- **Revenue (TTM)** (`ttm_sales`)
- **Revenue Per Share** (TTM)
- **EPS (TTM)** (`ttm_eps`)
- **EPS (Latest Q)** (`eps_latest_q`)
- **EBITDA (TTM)** (`ttm_EBITDA`)
- **EBIT (TTM)** (`ttm_EBIT`)
- **FCF Per Share (TTM)** (`ttm_fcf_per_share`)
- **Gross Profit (TTM)** (`grossprofit`)
- **Operating Income (TTM)**
- **Pretax Income (TTM)** (`ttm_pretaxincome`)

#### Growth Metrics
- **Revenue Growth** (1Y, 3Y, 5Y, 10Y per share)
- **EPS Growth** (1Y, 3Y, 5Y, 10Y) - with future estimates
- **EBITDA Growth** (1Y, 3Y, 5Y, 10Y)
- **FCF Growth** (1Y, 3Y, 5Y, 10Y)
- **Book Value Growth** (per share)
- **Asset Growth**
- **Debt Growth**
- **Quarterly YoY Growth** (EPS, Revenue, EBIT)

#### Quality Scores & Risk Metrics
- **Piotroski F-Score** (`fscore`) - 0-9 scale (higher is better)
- **Beneish M-Score** (`mscore`) - Detects manipulation (lower is better)
- **Altman Z-Score** (`zscore`) - Bankruptcy risk (higher is safer)
- **GF Score** (GuruFocus proprietary quality score)
- **GF Value** (Intrinsic value calculation)

#### Valuation Models
- **Graham Number** (`grahamnumber`)
- **DCF Intrinsic Value** (Earnings, FCF, and Dividend-based)
- **Peter Lynch Fair Value** (`lynchvalue`)
- **Earnings Power Value (EPV)** (`EPV`)
- **Margin of Safety** (DCF-based)

#### Dividend Metrics
- **Dividend Yield %** (`yield`)
- **Forward Dividend Yield %** (`ForwardDividendYield`)
- **Dividend Per Share (TTM)** (`ttm_dividend`)
- **Forward Dividend Per Share** (`ForwardDividend`)
- **Dividend Payout Ratio** (`payout`)
- **Shareholder Yield %** (`shareholder_yield`)
- **Buyback Yield %** (`buyback_yield`)

#### Other Metrics
- **Book Value Per Share** (`book`)
- **Tangible Book Per Share** (`tangible_book`)
- **Insider Ownership %** (`insider_ownership`)
- **Institutional Ownership %** (`inst_ownership`)
- **Beta** (`beta`)
- **Shares Outstanding** (`shares`)
- **Insider Shares Owned**
- **Institution Shares Held**

---

### B. Fundamentals Endpoint
**Endpoint:** `GET /stocks/{symbol}/fundamentals`

Returns complete financial statements with annual and quarterly history back to 1978:

#### Income Statement
- Total Revenue
- Cost of Goods Sold (COGS)
- Gross Profit & Gross Margin
- Research & Development (R&D)
- Selling, General & Admin (SG&A)
- Operating Income & Operating Margin
- Interest Income/Expense
- Pretax Income
- Tax Provision & Tax Rate
- Net Income
- EPS (Basic & Diluted)
- Depreciation & Amortization
- EBIT & EBITDA

#### Balance Sheet
- Cash & Cash Equivalents
- Marketable Securities
- Accounts Receivable
- Inventory (with detailed breakdown)
- Total Current Assets
- Property, Plant & Equipment (PP&E)
- Intangible Assets & Goodwill
- Total Assets
- Accounts Payable & Accrued Expenses
- Short-term & Long-term Debt
- Total Current Liabilities
- Total Liabilities
- Common Stock
- Retained Earnings
- Total Stockholders' Equity
- Debt-to-Equity Ratio
- Equity-to-Asset Ratio

#### Cash Flow Statement
- **Operating Activities:**
  - Cash From Operations
  - Depreciation & Amortization
  - Changes in Working Capital
  - Stock-Based Compensation
  
- **Investing Activities:**
  - Capital Expenditures (CapEx)
  - Asset Sales/Purchases
  - Investment Purchases/Sales
  
- **Financing Activities:**
  - Debt Issuance/Repayment
  - Stock Issuance/Buybacks
  - Dividends Paid
  
- **Summary Metrics:**
  - Free Cash Flow (FCF = Operating CF - CapEx)
  - Net Change in Cash
  - Beginning/Ending Cash Position

---

### C. Valuations (Historical Ratios) Endpoint
**Endpoint:** `GET /stocks/{symbol}/valuations`

Returns historical time-series data (back to 1978) for:

#### Per-Share Data
- Revenue Per Share
- EPS (Diluted)
- EPS Without Non-Recurring Items
- Owner Earnings Per Share (TTM)
- Free Cash Flow Per Share
- Operating Cash Flow Per Share
- Cash Per Share
- Book Value Per Share
- Tangible Book Per Share
- Dividends Per Share
- Total Debt Per Share

#### Valuation Multiples (Historical)
- P/E Ratio with 10-year highs/lows/medians
- P/B Ratio
- P/S Ratio
- PEG Ratio
- EV/EBITDA
- EV/EBIT
- EV/Revenue
- EV/OCF
- EV/FCF
- Price-to-FCF
- Price-to-OCF
- Shiller P/E
- Cyclically Adjusted P/B, P/S, and Price-to-FCF

#### Profitability Ratios (Historical)
- Gross Margin
- Operating Margin
- Net Margin
- EBITDA Margin
- FCF Margin
- ROE, ROA, ROIC, ROCE

#### Efficiency Ratios
- Asset Turnover
- Inventory Turnover
- Days Inventory
- Days Sales Outstanding (DSO)
- Days Payable Outstanding (DPO)
- Cash Conversion Cycle

#### Quality Scores (Historical)
- Piotroski F-Score
- Beneish M-Score
- Altman Z-Score

#### Market & Valuation Quality
- Market Cap
- Enterprise Value
- Earnings Yield
- FCF Yield
- OCF Yield
- Dividend Yield
- Shareholder Yield
- Buyback Yield
- Beta
- Interest Coverage
- Current Ratio, Quick Ratio, Cash Ratio

---

## 3. AUTHENTICATION & ACCESS REQUIREMENTS

### Mandatory Requirements
1. **GuruFocus Membership Account** (free/paid tier)
2. **API Token** - Generated from user account dashboard
3. **HTTPS Connection** - All requests must use SSL/TLS
4. **Authorization Header** - Must be included in every request

### Account Requirements by Use Case
- **Personal Use:** Free tier (100 queries/month) or Premium (7-day trial)
- **Commercial/Fintech:** Professional plan or custom enterprise licensing
- **Research:**  Premium Plus (500 queries/month) or higher
- **High-Volume:** Custom enterprise agreement required

### Rate Limits & Quotas
- **Free Plan:** 100 requests/month
- **Premium:** 200 requests/month
- **Premium Plus:** 500 requests/month
- **Professional:** 2,000 requests/month
- **Overage:** Charged at PAYG rates per endpoint (~$0.02-$0.10 per request)
- **No disclosed request/second rate limit** (burst protection likely exists)

---

## 4. API ENDPOINT STRUCTURE & EXAMPLE CALLS

### Base URL
```
https://api.gurufocus.com/data/stocks
```

### Endpoint Patterns

#### Company Profile
```
GET /stocks/{symbol}/profile
```

**Example cURL:**
```bash
curl -X GET 'https://api.gurufocus.com/data/stocks/AAPL/profile' \
  -H 'Authorization: YOUR_API_TOKEN'
```

**JavaScript/Fetch:**
```javascript
fetch('https://api.gurufocus.com/data/stocks/AAPL/profile', {
  method: 'GET',
  headers: {
    'Authorization': 'YOUR_API_TOKEN'
  }
})
```

**Python:**
```python
import requests

headers = {'Authorization': 'YOUR_API_TOKEN'}
response = requests.get(
  'https://api.gurufocus.com/data/stocks/AAPL/profile',
  headers=headers
)
data = response.json()
```

#### Fundamentals (Financial Statements)
```
GET /stocks/{symbol}/fundamentals
```

Returns `annually[]`, `quarterly[]`, and `ttm` (trailing twelve months) data.

#### Historical Valuations
```
GET /stocks/{symbol}/valuations
```

Returns `annually[]`, `quarterly[]`, and `ttm` data with historical metrics.

#### Stock List (by Region)
```
GET /stocks/{region_code}?page=1&per_page=100
```

**Region Codes:**
- `U` - USA
- `C` - Canada
- `E` - Europe (excluding UK/Ireland)
- `UK` - UK/Ireland
- `A` - Asia
- `AU` - Oceania
- `AF` - Africa
- `LA` - Latin America
- `IN` - India/Pakistan

---

## 5. RESPONSE STRUCTURE & DATA TYPES

### Profile Response Structure
```json
{
  "basic_information": {
    "symbol": "AAPL",
    "company": "Apple Inc",
    "company_id": "GF000003JX",
    "exchange": "NAS",
    "stockid": "US01WD"
  },
  "general": {
    "sector": "Technology",
    "industry": "Hardware",
    "country_iso": "USA",
    "currency": "USD",
    "IPO_date": "1980-12-12"
  },
  "fundamental": {
    "mktcap": 3750003.59,
    "mktcap_norm": 3750003.59,
    "pe": 32.29,
    "peg": 2.52,
    "pb": 42.57,
    "ps": 9.18,
    "ev2ebitda": 24.68,
    "roe": 162.99,
    "roa": 33.74,
    "roic": 39.39,
    "ttm_eps": 7.91,
    "ttm_sales": 435617,
    "ttm_EBITDA": 152902,
    "ttm_fcf_per_share": 8.283
    // ... hundreds of additional fields
  },
  "growth": {
    "revenue_growth_3y": 0,
    "earning_growth_3y": 6.9,
    "ebitda_growth_5y": 12.8,
    "fcf_growth_5y": 8.7
    // ... growth metrics
  },
  "price": {
    "price": 255.43,
    "beta": 0.9,
    "volatility": 21.54,
    "price52whigh": 288.62,
    "price52wlow": 169.2101
    // ... price metrics
  },
  "valuation_ratio": {
    "forwardPE": 30.03,
    "forward_peg_ratio": 2.87,
    "ev2ebitda": 24.68
    // ... valuation metrics
  },
  "profitability": {
    "grossmargin": 47.33,
    "oprt_margain": 32.38,
    "net_margain": 27.04,
    "ebitda_margin": 34.64
    // ... profitability metrics
  }
}
```

### Fundamentals Response Structure
```json
{
  "basic_information": {
    "symbol": "AAPL",
    "company": "Apple Inc"
  },
  "annually": [
    {
      "date": "2025-09",
      "income_statement": {
        "revenue": 435617,
        "cost_of_goods_sold": 220960,
        "gross_profit": 195201,
        "operating_income": 133050,
        "net_income": 112010,
        "ebit": 141070,
        "ebitda": 152902,
        "eps_basic": 7.49,
        "eps_diluated": 7.46
      },
      "balance_sheet": {
        "cash_and_cash_equivalents": 45317,
        "total_assets": 379297,
        "total_liabilities": 291107,
        "total_equity": 88190,
        "total_debt": 90509,
        "inventory": 5875
      },
      "cashflow_statement": {
        "cash_flow_from_operations": 135472,
        "purchase_of_ppe": -12148,
        "total_free_cash_flow": 123324,
        "dividends_paid_direct": -15486,
        "stock_based_compensation": 13171
      }
    }
  ],
  "quarterly": [ /* Similar structure */ ],
  "ttm": { /* Trailing twelve months data */ }
}
```

### HTTP Response Codes
- **200** - Success: Standard response with data
- **401** - Unauthorized: Invalid or missing API token
- **403** - Forbidden: Token valid but insufficient permissions
- **404** - Not Found: Stock symbol doesn't exist or invalid endpoint
- **429** - Rate Limited: Monthly query limit exceeded (for subscription tier)
- **500** - Server Error: GuruFocus API issue

---

## 6. DATA COVERAGE & AVAILABILITY

### Geographic Coverage (9 Regions)
| Region | Companies | Annual Periods | Quarterly Periods | Coverage Start |
|--------|-----------|----------------|------------------|-----------------|
| USA | 12,000+ | 35,000+ | - | 1978 |
| Asia | 27,000+ | 32,000+ | - | 1978 |
| Europe (ex UK) | 10,000+ | 47,000+ | - | 1979 |
| UK/Ireland | 2,600+ | 12,000+ | - | 1979 |
| Canada | 3,500+ | 4,700+ | - | 1978 |
| Oceania | 2,400+ | 4,700+ | - | 1987 |
| Africa | 1,300+ | 1,500+ | - | 1982 |
| Latin America | 2,000+ | 6,500+ | - | 1979 |
| India/Pakistan | 5,900+ | 8,100+ | - | 1983 |

### Historical Data Availability
- **Annual Data:** Back to 1978 for most regions
- **Quarterly Data:** Available since 2019 in most cases, with Q4 2021 normalized for all
- **Valuation History:** Back to 1978 for covered companies
- **Dividend History:** Full historical records
- **Growth Metrics:** Calculate with 1, 3, 5, 10-year periods

### Data Update Frequency
- **Daily Updates:** Stock prices, market data
- **Quarterly:** Financial statements after SEC/regulatory filings
- **Real-time** rankings and scores when fundamentals change

---

## 7. RATE LIMITS & BEST PRACTICES

### Recommended Practices
1. **Batch Requests:** Combine multiple stocks in single queries where possible
2. **Cache Data:** Store frequently accessed data locally (update quarterly for fundamentals)
3. **Monitor Quota:** Track API usage to avoid surprise overage charges
4. **Error Handling:** Implement retry logic with exponential backoff
5. **Pagination:** Use `page` and `per_page` parameters for Stock List endpoint
6. **Timezone:** Timestamps use UTC; adjust for local timezone as needed

### Quota Management
```
Monthly Queries Allowed = Subscription Tier Limit
Overage Cost = $0.02 - $0.10 per request (varies by endpoint)
Billing Cycle = Calendar month (resets on 1st)
```

### Example Budget Calculation
```
Premium Plan (200 free queries/month):
- 50 Profile requests × $0.10 = $5.00
- 100 Fundamentals × $0.10 = $10.00
- 200 Valuation × $0.10 = $20.00
- Total PAYG Cost = $35.00 + $9/month subscription = $44
```

---

## 8. PROS & CONS

### Advantages ✅
- **Comprehensive Data:** 60,000+ companies across 9 regions
- **Long History:** Data back to 1978
- **Institutional Grade:** Used by professional investors
- **Clean API:** RESTful design, consistent schema
- **Multiple Metrics:** 500+ financial metrics and ratios
- **Quality Scores:** Piotroski, Beneish, Altman Z-Score built-in
- **Intrinsic Value Models:** DCF, Graham Number, Lynch Fair Value pre-calculated
- **Global Coverage:** Not just USA data
- **Regular Updates:** Daily price, quarterly fundamentals

### Disadvantages ❌
- **NOT Truly Free:** Requires paid membership or PAYG credits
- **Higher Cost:** $0.10 per request adds up quickly ($3+ per stock profile)
- **No Public API:** Requires authentication token (can't use in frontend)
- **Limited Trial:** 7-day Premium trial (not enough for serious evaluation)
- **No Bulk Export:** Must query individually or via API
- **Subscription Required:** Even 100-query free tier requires membership signup
- **Data Lag:** Fundamentals update quarterly, not real-time
- **Limited Company News:** Only USA news available

---

## 9. ALTERNATIVE & COMPARISON

### When GuruFocus Makes Sense
- Building professional investment platforms
- Need institutional-grade quality scores (Piotroski, Beneish)
- Want pre-calculated intrinsic values
- Analysis across 9 global regions
- Long-term fundamental research (1978+ data)

### When to Use Alternatives
- **Need Real Free API:** Use Alpha Vantage, Finnhub, or IEX Cloud free tiers
- **Quick Stock Checks:** Yahoo Finance or Google Finance (no API, web scraping)
- **Simple Chart Data:** Finnhub, EOD Historical Data
- **Brazilian/Emerging Markets:** Use local exchanges (not covered by GuruFocus)
- **Cryptocurrency:** GuruFocus doesn't support crypto

---

## 10. QUICK START GUIDE

### Step 1: Get an API Token
1. Create free account at https://www.gurufocus.com/register
2. Navigate to Settings → API Token
3. Copy your token (keep it secret!)

### Step 2: Make First Request
```python
import requests
import json

API_TOKEN = "YOUR_TOKEN_HERE"
headers = {"Authorization": API_TOKEN}

# Get Apple profile
response = requests.get(
    "https://api.gurufocus.com/data/stocks/AAPL/profile",
    headers=headers
)

if response.status_code == 200:
    data = response.json()
    print(f"P/E: {data['fundamental']['pe']}")
    print(f"PEG: {data['fundamental']['peg']}")
    print(f"ROE: {data['fundamental']['roe']}")
else:
    print(f"Error: {response.status_code}")
```

### Step 3: Monitor Your Quota
- Check remaining queries in GuruFocus dashboard
- Set spending alerts if using PAYG

---

## Summary Table

| Feature | Details |
|---------|---------|
| **API Type** | REST, JSON |
| **Authentication** | Token-based (Authorization header) |
| **Free Tier** | 100 queries/month (membership required) |
| **Cost** | $9/month (Premium) or $0.02-$0.10 per PAYG request |
| **Companies** | 60,000+ across 9 regions |
| **Historical Data** | 1978+ (depending on region) |
| **Update Frequency** | Daily (prices), Quarterly (fundamentals) |
| **Key Metrics** | P/E, PEG, EV/EBITDA, ROE, FCF, Growth rates, Quality scores |
| **Special Features** | Built-in fair value calculations, Piotroski/Beneish scores |
| **Best For** | Professional investors, fintech platforms, research |
| **Documentation** | Good - API Explorer with examples |
| **Support** | Email support, knowledge base |

