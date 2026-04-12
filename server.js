import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import stringSimilarity from "string-similarity";
import { fetchGoogleTickerNews } from "./news/tickerNews.js";
import { fetchOverallLatestNews } from "./news/latestNews.js";

const app = express();
app.use(cors());
app.use(express.json());

const WEBHOOK_SECRET = process.env.FINNHUB_WEBHOOK_SECRET || 'd7d3gk1r01qv03eu7vf0';

// In-memory cache for webhook updates
const cache = {};
// Simple in-memory cache for ticker results with request coalescing
const tickerCache = new Map(); // key -> { data, expiresAt, promise }
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 30);

const YAHOO_QUOTE_SUMMARY = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const CNBC_QUOTE_URL = "https://www.cnbc.com/quotes";
const TRADINGVIEW_SCANNER = "https://scanner.tradingview.com/america/scan";
const NASDAQ_API = "https://api.nasdaq.com/api/quote";
const ALPHA_VANTAGE_API = "https://www.alphavantage.co/query";
const FINNHUB_API = "https://finnhub.io/api/v1";
const FMP_API = "https://financialmodelingprep.com/stable";
const EODHD_API = "https://eodhd.com/api/fundamentals";
const GURUFOCUS_API = "https://www.gurufocus.com/api/public/stock";
const GURUFOCUS_URL = "https://www.gurufocus.com/stock";
const YAHOO_FINANCE_URL = "https://finance.yahoo.com/quote";
const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const NEWS_MAX_ITEMS = 5;
const OVERALL_NEWS_MAX_ITEMS = 10;
const OVERALL_NEWS_MAX_PER_SOURCE = 2;
const NEWS_CACHE_TTL_SECONDS = Number(process.env.NEWS_CACHE_TTL_SECONDS || 600);
const PREFERRED_NEWS_SOURCES = [
  "CNBC", "Reuters", "Yahoo Finance", "Bloomberg",
  "Financial Times", "The Street", "Forbes",
  "Wall Street Journal", "Barrons", "MarketWatch", "NDTV Profit"
];

// In-memory cache for RSS news with request coalescing.
const newsCache = new Map(); // key -> { data, expiresAt, promise }
let overallNewsCache = null; // { data, expiresAt, promise }

// News-related helpers and fetchers have been moved to the `news` folder.
// see: ./news/newsUtils.js, ./news/tickerNews.js, ./news/latestNews.js

function safe(value) {
  return value == null ? null : Number(value);
}

function sanitizeCompanyName(value, fallback = null) {
  const cleaned = String(value || "")
    .replace(/\b[A-Z.\-]+\s*[—-]\s*Yahoo Finance\s*/i, '')
    .replace(/\s*[—-]?\s*Yahoo Finance\b/ig, '')
    .replace(/^Yahoo\s*Finance\s*/i, '')
    .replace(/\b(inc\.?|corp\.?|corporation|company|co\.?|limited|ltd\.?|plc|holdings?)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function parseMetricNumber(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/,/g, "").trim();
  if (!cleaned || cleaned === "N/A" || cleaned === "-") return null;

  const multiplier = cleaned.endsWith("T")
    ? 1e12
    : cleaned.endsWith("B")
      ? 1e9
      : cleaned.endsWith("M")
        ? 1e6
        : cleaned.endsWith("K")
          ? 1e3
          : 1;

  const num = parseFloat(cleaned.replace(/[^0-9.-]/g, ""));
  return Number.isNaN(num) ? null : num * multiplier;
}

function extractStatFromTable($, label) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(label);

  let row = $("tr").filter((_, el) => {
    const firstCell = norm($(el).find("th, td").first().text());
    return firstCell === target;
  }).first();

  // Fallback for slightly different text variants
  if (!row || row.length === 0) {
    row = $("tr").filter((_, el) => {
      const firstCell = norm($(el).find("th, td").first().text());
      return firstCell.includes(target);
    }).first();
  }

  if (!row || row.length === 0) return null;
  const valueText = row.find("td").last().text().trim();
  return parseMetricNumber(valueText);
}

function extractYahooJsonMetric(html, metricKey) {
  if (!html) return null;
  const pattern = new RegExp(`"${metricKey}"\\s*:\\s*\\{[^}]*"raw"\\s*:\\s*([0-9.\-]+)`, "i");
  const match = html.match(pattern);
  return match?.[1] != null ? parseMetricNumber(match[1]) : null;
}

async function fetchHtmlWithPuppeteer(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await page.content();
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeYahooFinance(ticker) {
  try {
    const quoteUrl = `${YAHOO_FINANCE_URL}/${encodeURIComponent(ticker)}`;
    const statsUrl = `${YAHOO_FINANCE_URL}/${encodeURIComponent(ticker)}/key-statistics`;

    const [quoteRes, statsRes] = await Promise.all([
      fetch(quoteUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      }),
      fetch(statsUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      })
    ]);

    if (!quoteRes.ok) throw new Error(`Quote HTTP ${quoteRes.status}`);

    let quoteHtml = await quoteRes.text();
    let statsHtml = statsRes.ok ? await statsRes.text() : "";

    const quoteBlocked = quoteRes.status === 403 || /captcha|blocked/i.test(quoteHtml);
    const statsBlocked = !statsRes.ok || statsRes.status === 403 || /captcha|blocked/i.test(statsHtml);

    if (quoteBlocked) {
      quoteHtml = await fetchHtmlWithPuppeteer(quoteUrl);
    }
    if (statsBlocked || !/Forward P\/E|PEG Ratio/i.test(statsHtml)) {
      // key-statistics often renders data client-side; use Puppeteer to get populated table
      statsHtml = await fetchHtmlWithPuppeteer(statsUrl);
    }
    const $quote = cheerio.load(quoteHtml);
    const $stats = cheerio.load(statsHtml || "");

    let price = null;

    // Primary: symbol-scoped fin-streamer market price on Yahoo quote page
    const streamerPriceText = $quote(`fin-streamer[data-symbol="${ticker}"][data-field="regularMarketPrice"]`).first().text();
    price = parseMetricNumber(streamerPriceText);

    // Secondary: visible quote price
    if (price == null) {
      const quotePriceText = $quote('[data-testid="qsp-primary-price"]').first().text();
      price = parseMetricNumber(quotePriceText);
    }

    // Fallback: quote page JSON blob often includes regularMarketPrice
    if (price == null) {
      const scriptBlob = quoteHtml.match(new RegExp(`"symbol"\\s*:\\s*"${ticker}"[\\s\\S]{0,1200}?"regularMarketPrice"\\s*:\\s*\\{[^}]*"raw"\\s*:\\s*([0-9.]+)`));
      if (scriptBlob?.[1]) price = parseMetricNumber(scriptBlob[1]);
    }

    // Guard against malformed scrape values from unrelated page widgets
    if (price != null && price > 10000) {
      price = null;
    }

    const rawName = $quote('[data-symbol-label]')?.attr('data-symbol-label') ||
      $quote('h1')?.text()?.split('(')[0]?.trim() ||
      ticker;
    const name = sanitizeCompanyName(rawName, ticker);

    // Prefer key-statistics page for forward metrics (this is what user sees on Yahoo)
    let forwardPE = extractStatFromTable($stats, 'Forward P/E')
      || extractStatFromTable($stats, 'Forward P/E 1')
      || extractMetricFromHtml($quote, 'Forward P/E');

    let peg = extractStatFromTable($stats, 'PEG Ratio')
      || extractStatFromTable($stats, 'PEG Ratio (5 yr expected) 1')
      || extractMetricFromHtml($quote, 'PEG Ratio');

    // Yahoo embedded JSON is often the most reliable source for these values.
    if (forwardPE == null) {
      forwardPE = extractYahooJsonMetric(quoteHtml, 'forwardPE')
        || extractYahooJsonMetric(statsHtml, 'forwardPE');
    }
    if (peg == null) {
      peg = extractYahooJsonMetric(quoteHtml, 'pegRatio')
        || extractYahooJsonMetric(statsHtml, 'pegRatio');
    }
    const marketCap = extractMetricFromHtml($quote, 'Market Cap');
    const targetPrice = extractMetricFromHtml($quote, '1y Target');

    if (price == null || forwardPE == null) {
      throw new Error('Insufficient metrics extracted from Yahoo Finance page');
    }

    return {
      price: {
        regularMarketPrice: { raw: price },
        marketCap: { raw: marketCap },
        currency: "USD",
        shortName: name || ticker
      },
      financialData: {
        forwardPE: { raw: forwardPE },
        pegRatio: { raw: peg },
        enterpriseValue: { raw: null },
        ebitda: { raw: null },
        freeCashflow: { raw: null },
        operatingCashflow: { raw: null },
        targetMeanPrice: { raw: targetPrice }
      },
      recommendationTrend: null,
      quoteSource: "Yahoo Finance (scraped)"
    };
  } catch (error) {
    throw new Error("Yahoo Finance scrape failed: " + error.message);
  }
}

function extractMetricFromHtml($, metricName) {
  try {
    const rows = $('td, span, div');
    for (let i = 0; i < rows.length; i++) {
      const cell = rows.eq(i);
      const text = cell.text();
      if (text.includes(metricName)) {
        const value = cell.next().text() ||
          cell.parent().find('td').eq(1).text() ||
          cell.siblings().text();
        const num = parseMetricNumber(value);
        if (num != null && num > 0) return num;
      }
    }
  } catch (e) {}
  return null;
}

// Scrapes the GuruFocus forward PE term page which reliably shows the forward PE value
async function scrapeGuruFocusForwardPE(ticker) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    };
    const forwardUrl = `https://www.gurufocus.com/term/forward-pe-ratio/${encodeURIComponent(ticker)}`;
    const pegUrl = `https://www.gurufocus.com/term/peg-ratio/${encodeURIComponent(ticker)}`;

    const [forwardRes, pegRes] = await Promise.all([
      fetch(forwardUrl, { headers, timeout: 10000 }),
      fetch(pegUrl, { headers, timeout: 10000 })
    ]);

    let forwardHtml = await forwardRes.text();
    let pegHtml = pegRes.ok ? await pegRes.text() : "";

    const forwardBlocked = forwardRes.status === 403 || /Sorry, you have been blocked/i.test(forwardHtml);
    const pegBlocked = pegRes.status === 403 || /Sorry, you have been blocked/i.test(pegHtml);

    if (forwardBlocked) {
      forwardHtml = await fetchHtmlWithPuppeteer(forwardUrl);
    }
    if (pegBlocked) {
      pegHtml = await fetchHtmlWithPuppeteer(pegUrl);
    }

    const $forward = cheerio.load(forwardHtml);
    const forwardH1 = $forward('h1').first().text();
    const forwardBodyText = $forward('body').text();
    const forwardMatch = forwardH1.match(/Forward PE Ratio:\s*([\d.]+)/i)
      || forwardBodyText.match(/Forward PE Ratio(?:\s+for\s+today)?\s+(?:is\s+)?([\d.]+)/i)
      || forwardBodyText.match(/Forward PE Ratio:\s*([\d.]+)/i);
    const forwardPE = forwardMatch ? parseFloat(forwardMatch[1]) : null;

    const priceMatch = forwardBodyText.match(/stock price of \$([\d.]+)/i) ||
      forwardBodyText.match(/Price\s+\$([\d.]+)/i);
    const price = priceMatch ? parseFloat(priceMatch[1]) : null;

    let peg = null;
    if (pegHtml) {
      const $peg = cheerio.load(pegHtml);
      const pegH1 = $peg('h1').first().text();
      const pegBodyText = $peg('body').text();
      const pegMatch = pegH1.match(/PEG Ratio:\s*([\d.]+)/i)
        || pegBodyText.match(/PEG Ratio(?:\s+for\s+today)?\s+(?:is\s+)?([\d.]+)/i)
        || pegBodyText.match(/PEG Ratio:\s*([\d.]+)/i);
      peg = pegMatch ? parseFloat(pegMatch[1]) : null;
    }

    if (forwardPE == null) throw new Error('Could not parse forward PE from GuruFocus term page');
    return { forwardPE, peg, price };
  } catch (error) {
    throw new Error('GuruFocus forward PE scrape failed: ' + error.message);
  }
}

// Primary scraper: Yahoo Finance for real-time price + GuruFocus for accurate forward PE
async function scrapePrimaryData(ticker) {
  const [yahooResult, guruResult] = await Promise.allSettled([
    scrapeYahooFinance(ticker),
    scrapeGuruFocusForwardPE(ticker)
  ]);

  if (yahooResult.status === 'rejected' && guruResult.status === 'rejected') {
    throw new Error(`Yahoo: ${yahooResult.reason.message} | GuruFocus: ${guruResult.reason.message}`);
  }

  // --- Build result ---
  let result;
  if (yahooResult.status === 'fulfilled') {
    result = yahooResult.value;
    // Overlay forward PE / PEG from GuruFocus when available
    if (guruResult.status === 'fulfilled' && guruResult.value.forwardPE != null) {
      result.financialData.forwardPE = { raw: guruResult.value.forwardPE };
      result.quoteSource = 'Yahoo Finance + GuruFocus (scraped)';
    }
    if (guruResult.status === 'fulfilled' && guruResult.value.peg != null) {
      result.financialData.pegRatio = { raw: guruResult.value.peg };
      result.quoteSource = 'Yahoo Finance + GuruFocus (scraped)';
    }

    // If scrape values are clearly implausible and GuruFocus fallback is unavailable, fail fast to try next source.
    const suspiciousPrice = (result.price?.regularMarketPrice?.raw ?? 0) > 10000;
    const suspiciousForwardPE = (result.financialData?.forwardPE?.raw ?? 0) > 300;
    const suspiciousPeg = (result.financialData?.pegRatio?.raw ?? 0) > 100;
    if ((suspiciousPrice || suspiciousForwardPE || suspiciousPeg) && guruResult.status === 'rejected') {
      throw new Error('Scraped metrics look invalid and GuruFocus fallback failed');
    }
  } else {
    // Yahoo failed — build minimal result from GuruFocus data
    const gf = guruResult.value;
    result = {
      price: {
        regularMarketPrice: { raw: gf.price },
        marketCap: { raw: null },
        currency: 'USD',
        shortName: ticker
      },
      financialData: {
        forwardPE: { raw: gf.forwardPE },
        pegRatio: { raw: gf.peg },
        enterpriseValue: { raw: null },
        ebitda: { raw: null },
        freeCashflow: { raw: null },
        operatingCashflow: { raw: null },
        targetMeanPrice: { raw: null }
      },
      recommendationTrend: null,
      quoteSource: 'GuruFocus (scraped)',
      computedMetrics: {}
    };
  }

  return result;
}

async function scrapeGuruFocus(ticker) {
  try {
    // Try direct fetch first (faster than Puppeteer)
    const url = `${GURUFOCUS_URL}/${encodeURIComponent(ticker)}/summary`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract data using various selectors
    const name = $('[class*="stock-name"]')?.text()?.trim() ||
                 $('h1')?.text()?.trim() ||
                 ticker;

    // Try to extract metrics from the page
    const data = {
      name,
      price: extractMetricFromHtml($, 'Price'),
      pe: extractMetricFromHtml($, 'P/E') || extractMetricFromHtml($, 'P E'),
      peg: extractMetricFromHtml($, 'PEG'),
      marketCap: extractMetricFromHtml($, 'Market Cap'),
      ebitda: extractMetricFromHtml($, 'EBITDA'),
      evEbitda: extractMetricFromHtml($, 'EV/EBITDA'),
      fcf: extractMetricFromHtml($, 'Free Cash'),
      ocf: extractMetricFromHtml($, 'Operating Cash'),
      targetPrice: extractMetricFromHtml($, 'Target')
    };

    // If we got minimal data, throw to trigger fallback
    const metricsFound = Object.values(data).filter(v => v !== null).length;
    if (metricsFound < 2) {
      throw new Error('Insufficient metrics extracted from GuruFocus');
    }

    return {
      price: {
        regularMarketPrice: { raw: data.price || data.targetPrice },
        marketCap: { raw: data.marketCap },
        currency: "USD",
        shortName: data.name
      },
      financialData: {
        forwardPE: { raw: data.pe },
        pegRatio: { raw: data.peg },
        enterpriseValue: { raw: null },
        ebitda: { raw: data.ebitda },
        freeCashflow: { raw: data.fcf },
        operatingCashflow: { raw: data.ocf },
        targetMeanPrice: { raw: data.targetPrice }
      },
      recommendationTrend: null,
      quoteSource: "GuruFocus (web scraped)",
      computedMetrics: {
        evEbitda: data.evEbitda
      }
    };
  } catch (error) {
    throw new Error("GuruFocus scrape failed: " + error.message);
  }
}

function translateTradingViewConsensus(score) {
  if (score == null) return null;
  // TradingView Recommend.All is in [-1, 1], not [1, 5]
  if (score <= -0.5) return "Strong Sell";
  if (score <= -0.1) return "Sell";
  if (score < 0.1) return "Neutral";
  if (score < 0.5) return "Buy";
  return "Strong Buy";
}

async function fetchTradingViewConsensus(ticker) {
  try {
    const candidateTickers = [
      `NASDAQ:${ticker}`,
      `NYSE:${ticker}`,
      `AMEX:${ticker}`
    ];

    const payload = {
      symbols: { tickers: candidateTickers },
      columns: ["Recommend.All", "RSI"]
    };

    const response = await fetch(TRADINGVIEW_SCANNER, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const body = await response.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    const row = rows.find((r) => Array.isArray(r?.d) && r.d.length >= 2)
      || rows[0]
      || null;
    const values = row?.d;

    if (!row || !values || values.length < 2) {
      return {
        ratingScore: null,
        ratingLabel: null,
        rsi: null,
        source: "TradingView scanner"
      };
    }

    const ratingScore = safe(values[0]);
    const rsi = safe(values[1]);
    const matchedTicker = row?.s || null;

    return {
      ratingScore,
      ratingLabel: translateTradingViewConsensus(ratingScore),
      rsi,
      source: "TradingView scanner",
      matchedTicker
    };
  } catch (error) {
    return {
      ratingScore: null,
      ratingLabel: null,
      rsi: null,
      source: "TradingView scanner",
      error: error.message || "Unable to retrieve TradingView data"
    };
  }
}

async function fetchNasdaqSummary(ticker) {
  const url = `${NASDAQ_API}/${encodeURIComponent(ticker)}/summary?assetclass=stocks`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*"
    }
  });

  const body = await res.json();
  const data = body?.data;
  const summary = data?.summaryData || {};
  const priceText = summary?.PreviousClose?.value || data?.primaryData?.lastSalePrice;
  const price = priceText ? Number(priceText.replace(/[^0-9.-]/g, "")) : null;
  const marketCapText = summary?.MarketCap?.value;
  const marketCap = marketCapText ? Number(marketCapText.replace(/,/g, "")) : null;
  const avgPriceTargetText = summary?.OneYrTarget?.value;
  const avgPriceTarget = avgPriceTargetText ? Number(avgPriceTargetText.replace(/[^0-9.-]/g, "")) : null;

  return {
    price: {
      regularMarketPrice: { raw: price },
      previousClose: { raw: price },
      marketCap: { raw: marketCap },
      currency: "USD",
      shortName: data?.companyName || ticker
    },
    financialData: {
      forwardPE: { raw: null },
      pegRatio: { raw: null },
      enterpriseValue: { raw: null },
      ebitda: { raw: null },
      freeCashflow: { raw: null },
      operatingCashflow: { raw: null },
      targetMeanPrice: { raw: avgPriceTarget }
    },
    recommendationTrend: null,
    quoteSource: "NASDAQ API"
  };
}

async function fetchEODHDFundamentals(ticker) {
  try {
    const apiKey = process.env.EODHD_API_KEY || 'demo';
    const url = `${EODHD_API}/${encodeURIComponent(ticker)}?fmt=json&api_token=${apiKey}`;
    const res = await fetch(url);
    const body = await res.json();

    if (body.error || Object.keys(body).length === 0) {
      throw new Error('EODHD API error or invalid data');
    }

    const highlights = body.Highlights || {};
    const valuation = body.Valuation || {};
    const financials = body.Financials || {};
    const cashFlow = financials.Cash_Flow?.yearly || {};
    const incomeStmt = financials.Income_Statement?.yearly || {};

    // Get latest year cash flows
    const latestYear = Object.keys(cashFlow)[0];
    const cf = latestYear ? cashFlow[latestYear] : {};
    const ocf = safe(cf.totalCashFromOperatingActivities);
    
    // Get latest income statement for capex
    const latestIncomeYear = Object.keys(incomeStmt)[0];
    const inc = latestIncomeYear ? incomeStmt[latestIncomeYear] : {};
    
    // FCF = Operating Cash Flow - Capital Expenditures
    // EODHD doesn't directly provide capex, so we'll use OCF as proxy
    const fcf = ocf; 

    // Note: EODHD provides trailing PE, not forward PE
    const trailingPE = safe(highlights.PERatio);
    const peg = safe(highlights.PEGRatio);
    const marketCap = safe(highlights.MarketCapitalization);
    const ebitda = safe(highlights.EBITDA);
    const totalRevenue = safe(highlights.RevenueTTM) || safe(inc.totalRevenue) || safe(inc.totalRevenueReported);
    const targetPrice = safe(highlights.WallStreetTargetPrice);
    
    // Get actual current price - prioritize market data, never use target price
    let currentPrice = null;
    if (highlights.LastPrice) {
      currentPrice = safe(highlights.LastPrice);
    }
    // If LastPrice not available, use 52-week averages or other market indicators
    if (!currentPrice && highlights.Fifty2WeekOfUSDHigh && highlights.Fifty2WeekOfUSDLow) {
      currentPrice = (safe(highlights.Fifty2WeekOfUSDHigh) + safe(highlights.Fifty2WeekOfUSDLow)) / 2;
    }
    // If still no price, try to fetch from Alpha Vantage as a secondary source
    if (!currentPrice) {
      currentPrice = await fetchCurrentPrice(ticker);
    }
    // If still no price, set to null (never use target price)
    if (!currentPrice) {
      currentPrice = null;
    }

    // EV/EBITDA calculation (EV = Market Cap + Debt - Cash)
    // For simplicity, approximate as Market Cap / EBITDA
    const evEbitda = marketCap && ebitda ? marketCap / ebitda : null;

    return {
      price: {
        regularMarketPrice: { raw: currentPrice },
        marketCap: { raw: marketCap },
        currency: "USD",
        shortName: body.General?.Name || ticker
      },
      financialData: {
        forwardPE: { raw: trailingPE },
        pegRatio: { raw: peg },
        enterpriseValue: { raw: null },
        ebitda: { raw: ebitda },
        totalRevenue: { raw: totalRevenue },
        freeCashflow: { raw: fcf },
        operatingCashflow: { raw: ocf },
        targetMeanPrice: { raw: targetPrice }
      },
      recommendationTrend: null,
      quoteSource: "EOD Historical Data API (trailing PE)",
      computedMetrics: {
        evEbitda: evEbitda
      }
    };
  } catch (error) {
    throw new Error('EODHD API error: ' + error.message);
  }
}

async function fetchCurrentPrice(ticker) {
  try {
    // Try Alpha Vantage TIME_SERIES_INTRADAY for current price
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${ticker}&interval=1min&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`;
    const res = await fetch(url);
    const body = await res.json();
    const timeSeries = body['Time Series (1min)'] || {};
    const times = Object.keys(timeSeries);
    if (times.length > 0) {
      const latestTime = times[0];
      const price = safe(timeSeries[latestTime]['4. close']);
      return price;
    }
  } catch (error) {
    console.error("Error fetching current price:", error.message);
  }
  return null;
}

async function fetchAlphaVantageOverview(ticker) {
  // Note: Requires a free API key from https://www.alphavantage.co/support/#api-key
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY || 'demo';
  const url = `${ALPHA_VANTAGE_API}?function=OVERVIEW&symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
  const res = await fetch(url);
  const body = await res.json();

  if (body['Error Message'] || body['Information']) {
    throw new Error('Alpha Vantage API key required or invalid');
  }

  const trailingPE = safe(body.PERatio);
  const peg = safe(body.PEGRatio);
  const marketCap = safe(body.MarketCapitalization);
  const eps = safe(body.EPS);
  const price = await fetchCurrentPrice(ticker); // Get real-time price

  return {
    price: {
      regularMarketPrice: { raw: price },
      marketCap: { raw: marketCap },
      currency: "USD",
      shortName: body.Name || ticker
    },
    financialData: {
      forwardPE: { raw: trailingPE },
      pegRatio: { raw: peg },
      enterpriseValue: { raw: null },
      ebitda: { raw: null },
      freeCashflow: { raw: null },
      operatingCashflow: { raw: null },
      targetMeanPrice: { raw: null }
    },
    recommendationTrend: null,
    quoteSource: "Alpha Vantage API (trailing PE)"
  };
}

async function fetchFinnhubMetrics(ticker) {
  // Note: Free API key available from https://finnhub.io
  const apiKey = process.env.FINNHUB_API_KEY || 'demo'; // Replace 'demo' with your actual key
  const url = `${FINNHUB_API}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${apiKey}`;
  const res = await fetch(url);
  const body = await res.json();

  if (body.error) {
    throw new Error('Finnhub API key required or invalid');
  }

  const metric = body.metric || {};
  const peForward = safe(metric.peForward);
  const peg = safe(metric.pegRatio?.['5yr']);
  const marketCap = safe(metric.marketCapitalization);
  const eps = safe(metric.epsNormalizedAnnual?.ttm);

  return {
    price: {
      regularMarketPrice: { raw: null },
      marketCap: { raw: marketCap },
      currency: "USD",
      shortName: ticker // Finnhub doesn't provide name in metric
    },
    financialData: {
      forwardPE: { raw: peForward },
      pegRatio: { raw: peg },
      enterpriseValue: { raw: null },
      ebitda: { raw: null },
      freeCashflow: { raw: null },
      operatingCashflow: { raw: null },
      targetMeanPrice: { raw: null }
    },
    recommendationTrend: null,
    quoteSource: "Finnhub API"
  };
}

async function fetchFMPProfile(ticker) {
  // Note: Free API key available from https://financialmodelingprep.com
  const apiKey = process.env.FMP_API_KEY || 'demo';
  const url = `${FMP_API}/profile/${encodeURIComponent(ticker)}?apikey=${apiKey}`;
  const res = await fetch(url);
  const body = await res.json();

  if (Array.isArray(body) && body.length > 0) {
    const data = body[0];
    const price = safe(data.price);
    const marketCap = safe(data.mktCap);
    const pe = safe(data.pe);
    const peg = safe(data.pegRatio);

    return {
      price: {
        regularMarketPrice: { raw: price },
        marketCap: { raw: marketCap },
        currency: "USD",
        shortName: data.companyName || ticker
      },
      financialData: {
        forwardPE: { raw: pe },
        pegRatio: { raw: peg },
        enterpriseValue: { raw: null },
        ebitda: { raw: null },
        freeCashflow: { raw: null },
        operatingCashflow: { raw: null },
        targetMeanPrice: { raw: null }
      },
      recommendationTrend: null,
      quoteSource: "Financial Modeling Prep API"
    };
  } else {
    throw new Error('FMP API key required or invalid');
  }
}

async function fetchFMPKeyMetrics(ticker) {
  try {
    const apiKey = process.env.FMP_API_KEY || 'demo';
    const url = `${FMP_API}/key-metrics/${encodeURIComponent(ticker)}?period=annual&limit=1&apikey=${apiKey}`;
    const res = await fetch(url);
    const body = await res.json();
    if (!Array.isArray(body) || body.length === 0) throw new Error('FMP key-metrics: no data');
    const d = body[0];
    return {
      enterpriseValue: safe(d.enterpriseValue),
      evEbitda:        safe(d.evToEbitda),
      ebitda:          safe(d.enterpriseValue) && safe(d.evToEbitda) ? safe(d.enterpriseValue) / safe(d.evToEbitda) : null,
      debtToEquity:    safe(d.debtToEquity)
    };
  } catch (e) {
    return { enterpriseValue: null, evEbitda: null, ebitda: null, debtToEquity: null };
  }
}

const YFINANCE_SERVICE_URL = 'http://127.0.0.1:4001';

async function fetchYFinance(ticker) {
  const res = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent(ticker)}`, { timeout: 12000 });
  if (!res.ok) throw new Error(`yfinance service HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`yfinance: ${data.error}`);
  if (data.regularMarketPrice == null && data.forwardPE == null) {
    throw new Error(`yfinance: no data for ${ticker}`);
  }

  return {
    price: {
      regularMarketPrice: { raw: data.regularMarketPrice },
      previousClose: { raw: data.regularMarketPreviousClose },
      marketCap: { raw: data.marketCap },
      currency: data.currency || 'USD',
      shortName: data.shortName || ticker
    },
    financialData: {
      forwardPE: { raw: data.forwardPE },
      pegRatio: { raw: data.pegRatio },
      enterpriseValue: { raw: data.enterpriseValue },
      ebitda: { raw: data.ebitda },
      totalRevenue: { raw: data.totalRevenue },
      freeCashflow: { raw: data.freeCashflow },
      operatingCashflow: { raw: data.operatingCashflow },
      targetMeanPrice: { raw: data.targetMeanPrice },
      debtToEquity: { raw: data.debtToEquity }
    },
    recommendationTrend: null,
    quoteSource: data.quoteSource || 'yfinance (Yahoo Finance)',
    computedMetrics: {}
  };
}

async function fetchYahooFinanceAPI(ticker) {
  const modules = 'price,defaultKeyStatistics,financialData';
  const url = `${YAHOO_QUOTE_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&corsDomain=finance.yahoo.com`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/'
    }
  });

  if (!res.ok) throw new Error(`Yahoo Finance API HTTP ${res.status}`);

  const body = await res.json();
  const error = body?.quoteSummary?.error;
  if (error) throw new Error(`Yahoo Finance API error: ${error.description || error}`);

  const result = body?.quoteSummary?.result?.[0];
  if (!result) throw new Error('Yahoo Finance API: no data returned');

  const priceModule = result.price || {};
  const keyStats = result.defaultKeyStatistics || {};
  const finData = result.financialData || {};

  // Real-time price: prefer financialData.currentPrice, fallback to price module
  const currentPrice = safe(finData.currentPrice?.raw) ?? safe(priceModule.regularMarketPrice?.raw);
  const previousClose = safe(priceModule.regularMarketPreviousClose?.raw) ?? safe(priceModule.previousClose?.raw);
  const forwardPE = safe(keyStats.forwardPE?.raw);
  const pegRatio = safe(keyStats.pegRatio?.raw);
  const enterpriseValue = safe(keyStats.enterpriseValue?.raw);
  const evToEbitda = safe(keyStats.enterpriseToEbitda?.raw);
  const ebitda = safe(finData.ebitda?.raw);
  const totalRevenue = safe(finData.totalRevenue?.raw);
  const freeCashflow = safe(finData.freeCashflow?.raw);
  const operatingCashflow = safe(finData.operatingCashflow?.raw);
  const targetMeanPrice = safe(finData.targetMeanPrice?.raw);
  const marketCap = safe(priceModule.marketCap?.raw);
  const debtToEquity = safe(finData.debtToEquity?.raw);

  if (currentPrice == null && forwardPE == null) {
    throw new Error('Yahoo Finance API: insufficient data (likely rate-limited)');
  }

  return {
    price: {
      regularMarketPrice: { raw: currentPrice },
      previousClose: { raw: previousClose },
      marketCap: { raw: marketCap },
      currency: priceModule.currency || 'USD',
      shortName: priceModule.shortName || ticker
    },
    financialData: {
      forwardPE: { raw: forwardPE },
      pegRatio: { raw: pegRatio },
      enterpriseValue: { raw: enterpriseValue },
      ebitda: { raw: ebitda },
      totalRevenue: { raw: totalRevenue },
      freeCashflow: { raw: freeCashflow },
      operatingCashflow: { raw: operatingCashflow },
      targetMeanPrice: { raw: targetMeanPrice },
      debtToEquity: { raw: debtToEquity }
    },
    recommendationTrend: null,
    quoteSource: 'Yahoo Finance API',
    computedMetrics: {
      evEbitda: evToEbitda
    }
  };
}

async function fetchCNBCMetrics(ticker) {
  const url = `${CNBC_QUOTE_URL}/${encodeURIComponent(ticker)}?qsearchterm=${encodeURIComponent(ticker.toLowerCase())}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 12000
  });
  if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);

  const html = await res.text();
  const text = cheerio.load(html)("body").text().replace(/\s+/g, " ");

  const forwardMatch = text.match(/Fwd\s*P\/E\s*\(NTM\)\s*([0-9.]+)/i);
  const pegMatch = text.match(/PEG\s*Ratio(?:\s*\([^)]*\))?\s*([0-9.]+)/i);
  const closeMatch = text.match(/Close\s*([0-9]+(?:\.[0-9]+)?)/i);
  const marketCapMatch = text.match(/Market\s*Cap\s*([0-9.,]+\s*[TBM]?)/i);

  const forwardPE = forwardMatch ? parseFloat(forwardMatch[1]) : null;
  const peg = pegMatch ? parseFloat(pegMatch[1]) : null;
  const currentPrice = closeMatch ? parseFloat(closeMatch[1]) : null;
  const marketCap = marketCapMatch ? parseMetricNumber(marketCapMatch[1]) : null;

  if (forwardPE == null && peg == null && currentPrice == null && marketCap == null) {
    throw new Error("CNBC: unable to parse metrics");
  }

  return { currentPrice, forwardPE, peg, marketCap, source: "CNBC quote page" };
}

function pickMetric(candidates) {
  for (const c of candidates) {
    if (c?.value != null) return c;
  }
  return { value: null, source: null };
}

async function fetchStrictTickerData(ticker) {
  // Launch the most important upstream calls in parallel to avoid serial latency.
  // We'll still fall back to fetchStockSummary(ticker) if none of the primary sources succeed.
  let yahooQuote = null;
  let yfinanceQuote = null;
  let yahooApiQuote = null;
  let eodhdQuote = null;
  let guruMetrics = null;
  let cnbcMetrics = null;
  let fmpKeyMetrics = null;

  const pYahoo = scrapeYahooFinance(ticker).catch((e) => ({ __error: e }));
  const pYFinance = fetchYFinance(ticker).catch((e) => ({ __error: e }));
  const pYahooApi = fetchYahooFinanceAPI(ticker).catch((e) => ({ __error: e }));
  const pEodhd = fetchEODHDFundamentals(ticker).catch((e) => ({ __error: e }));
  const pGuru = scrapeGuruFocusForwardPE(ticker).catch((e) => ({ __error: e }));
  const pCnbc = fetchCNBCMetrics(ticker).catch((e) => ({ __error: e }));
  const pFmpKey = fetchFMPKeyMetrics(ticker).catch((e) => ({ __error: e }));

  const [rYahoo, rYFinance, rYahooApi, rEodhd, rGuru, rCnbc, rFmpKey] = await Promise.all([
    pYahoo,
    pYFinance,
    pYahooApi,
    pEodhd,
    pGuru,
    pCnbc,
    pFmpKey
  ]);

  const unwrap = (r) => (r && r.__error ? null : r);
  yahooQuote = unwrap(rYahoo);
  yfinanceQuote = unwrap(rYFinance);
  yahooApiQuote = unwrap(rYahooApi);
  eodhdQuote = unwrap(rEodhd);
  guruMetrics = unwrap(rGuru);
  cnbcMetrics = unwrap(rCnbc);
  fmpKeyMetrics = unwrap(rFmpKey);

  const baseQuote = yahooQuote || yfinanceQuote || yahooApiQuote || eodhdQuote || (await fetchStockSummary(ticker));
  baseQuote.price = baseQuote.price || {};
  baseQuote.financialData = baseQuote.financialData || {};

  const firstNonNull = (...values) => {
    for (const v of values) {
      const n = safe(v);
      if (n != null) return n;
    }
    return null;
  };

  const pickReasonableTarget = (currentPrice, ...values) => {
    for (const v of values) {
      const n = safe(v);
      if (n == null) continue;
      // Reject obvious scrape mistakes (e.g., 2001 target for a ~$200 stock).
      if (currentPrice != null && (n < currentPrice * 0.2 || n > currentPrice * 5)) continue;
      return n;
    }
    return null;
  };

  const currentPick = pickMetric([
    { value: safe(yahooQuote?.price?.regularMarketPrice?.raw), source: "Yahoo Finance quote page" },
    { value: safe(yfinanceQuote?.price?.regularMarketPrice?.raw), source: "yfinance (Yahoo Finance)" },
    { value: safe(guruMetrics?.price), source: "GuruFocus term page" },
    { value: safe(cnbcMetrics?.currentPrice), source: "CNBC quote page" }
  ]);

  const forwardPick = pickMetric([
    { value: safe(yahooQuote?.financialData?.forwardPE?.raw), source: "Yahoo Finance key-statistics page" },
    { value: safe(yfinanceQuote?.financialData?.forwardPE?.raw), source: "yfinance (Yahoo Finance)" },
    { value: safe(cnbcMetrics?.forwardPE), source: "CNBC quote page" },
    { value: safe(guruMetrics?.forwardPE), source: "GuruFocus term page" }
  ]);

  // yfinance forward P/E can lag in some cases. If both CNBC and GuruFocus are present
  // and yfinance deviates materially from their midpoint, prefer CNBC/GuruFocus.
  if (
    forwardPick.source === "yfinance (Yahoo Finance)" &&
    safe(cnbcMetrics?.forwardPE) != null &&
    safe(guruMetrics?.forwardPE) != null
  ) {
    const yVal = safe(yfinanceQuote?.financialData?.forwardPE?.raw);
    const cVal = safe(cnbcMetrics?.forwardPE);
    const gVal = safe(guruMetrics?.forwardPE);
    const midpoint = (cVal + gVal) / 2;
    const deviation = midpoint ? Math.abs(yVal - midpoint) / midpoint : 0;

    if (deviation >= 0.05) {
      forwardPick.value = cVal;
      forwardPick.source = "CNBC quote page (yfinance outlier filtered)";
    }
  }

  const pegPick = pickMetric([
    { value: safe(yahooQuote?.financialData?.pegRatio?.raw), source: "Yahoo Finance key-statistics page" },
    { value: safe(yfinanceQuote?.financialData?.pegRatio?.raw), source: "yfinance (Yahoo Finance)" },
    { value: safe(cnbcMetrics?.peg), source: "CNBC quote page" },
    { value: safe(guruMetrics?.peg), source: "GuruFocus term page" }
  ]);

  baseQuote.price.regularMarketPrice = { raw: currentPick.value };
  baseQuote.price.previousClose = {
    raw: firstNonNull(
      baseQuote.price?.previousClose?.raw,
      yfinanceQuote?.price?.previousClose?.raw,
      yahooApiQuote?.price?.previousClose?.raw,
      cnbcMetrics?.currentPrice
    )
  };
  baseQuote.financialData.forwardPE = { raw: forwardPick.value };
  baseQuote.financialData.pegRatio = { raw: pegPick.value };

  // Preserve strict sourcing for price/forwardPE/peg, but enrich other fundamentals
  // from richer fallbacks so derived metrics (EV/EBITDA, yields, target) don't become N/A.
  baseQuote.price.marketCap = {
    raw: firstNonNull(
      yfinanceQuote?.price?.marketCap?.raw,
      yahooApiQuote?.price?.marketCap?.raw,
      eodhdQuote?.price?.marketCap?.raw,
      cnbcMetrics?.marketCap,
      baseQuote.price?.marketCap?.raw
    )
  };

  // Handle sources that return market cap in billions without a unit suffix.
  if (safe(baseQuote.price.marketCap?.raw) != null && safe(baseQuote.price.marketCap?.raw) < 100000) {
    baseQuote.price.marketCap = { raw: safe(baseQuote.price.marketCap?.raw) * 1e9 };
  }

  baseQuote.financialData.enterpriseValue = {
    raw: firstNonNull(
      baseQuote.financialData?.enterpriseValue?.raw,
      yfinanceQuote?.financialData?.enterpriseValue?.raw,
      yahooApiQuote?.financialData?.enterpriseValue?.raw,
      eodhdQuote?.financialData?.enterpriseValue?.raw,
      fmpKeyMetrics?.enterpriseValue
    )
  };

  // Also store fmpKeyMetrics evEbitda for the override below
  if (fmpKeyMetrics?.evEbitda != null && baseQuote.computedMetrics == null) {
    baseQuote.computedMetrics = {};
  }
  if (fmpKeyMetrics?.evEbitda != null && baseQuote.computedMetrics?.evEbitda == null) {
    baseQuote.computedMetrics = { ...baseQuote.computedMetrics, evEbitda: fmpKeyMetrics.evEbitda };
  }

  baseQuote.financialData.ebitda = {
    raw: firstNonNull(
      baseQuote.financialData?.ebitda?.raw,
      yfinanceQuote?.financialData?.ebitda?.raw,
      yahooApiQuote?.financialData?.ebitda?.raw,
      eodhdQuote?.financialData?.ebitda?.raw
    )
  };

  baseQuote.financialData.totalRevenue = {
    raw: firstNonNull(
      baseQuote.financialData?.totalRevenue?.raw,
      yfinanceQuote?.financialData?.totalRevenue?.raw,
      yahooApiQuote?.financialData?.totalRevenue?.raw,
      eodhdQuote?.financialData?.totalRevenue?.raw
    )
  };

  baseQuote.financialData.freeCashflow = {
    raw: firstNonNull(
      baseQuote.financialData?.freeCashflow?.raw,
      yfinanceQuote?.financialData?.freeCashflow?.raw,
      yahooApiQuote?.financialData?.freeCashflow?.raw,
      eodhdQuote?.financialData?.freeCashflow?.raw
    )
  };

  baseQuote.financialData.operatingCashflow = {
    raw: firstNonNull(
      baseQuote.financialData?.operatingCashflow?.raw,
      yfinanceQuote?.financialData?.operatingCashflow?.raw,
      yahooApiQuote?.financialData?.operatingCashflow?.raw,
      eodhdQuote?.financialData?.operatingCashflow?.raw
    )
  };

  baseQuote.financialData.targetMeanPrice = {
    raw: pickReasonableTarget(
      currentPick.value,
      yfinanceQuote?.financialData?.targetMeanPrice?.raw,
      yahooApiQuote?.financialData?.targetMeanPrice?.raw,
      eodhdQuote?.financialData?.targetMeanPrice?.raw,
      baseQuote.financialData?.targetMeanPrice?.raw
    )
  };

  baseQuote.financialData.debtToEquity = {
    raw: firstNonNull(
      yfinanceQuote?.financialData?.debtToEquity?.raw,
      yahooApiQuote?.financialData?.debtToEquity?.raw,
      fmpKeyMetrics?.debtToEquity
    )
  };

  baseQuote.quoteSource = "Strict source policy";
  baseQuote.metricSources = {
    currentPrice: currentPick.source,
    forwardPE: forwardPick.source,
    peg: pegPick.source
  };

  if (currentPick.value == null) {
    throw new Error("Unable to resolve current price from configured sources");
  }

  return baseQuote;
}

async function fetchStockSummary(ticker) {
  try {
    // 1st: Yahoo Finance quote + key-statistics page scrape
    return await scrapeYahooFinance(ticker);
  } catch (error) {
    try {
      // 2nd: yfinance microservice fallback
      return await fetchYFinance(ticker);
    } catch (error2) {
      try {
        // 3rd: Yahoo + GuruFocus blended scrape fallback
        return await scrapePrimaryData(ticker);
      } catch (error3) {
        try {
          // 4th: full GuruFocus summary page scrape
          return await scrapeGuruFocus(ticker);
        } catch (error4) {
          try {
            // 5th: Yahoo Finance JSON API
            return await fetchYahooFinanceAPI(ticker);
          } catch (error5) {
            try {
              return await fetchEODHDFundamentals(ticker);
            } catch (error6) {
              try {
                return await fetchFMPProfile(ticker);
              } catch (error7) {
                try {
                  return await fetchFinnhubMetrics(ticker);
                } catch (error8) {
                  try {
                    return await fetchAlphaVantageOverview(ticker);
                  } catch (error9) {
                    try {
                      return await fetchNasdaqSummary(ticker);
                    } catch (error10) {
                      throw new Error('All sources failed: Yahoo page scrape (' + error.message + '), yfinance (' + error2.message + '), Yahoo+GuruFocus scrape (' + error3.message + '), GuruFocus summary (' + error4.message + '), Yahoo API (' + error5.message + '), EODHD (' + error6.message + '), FMP (' + error7.message + '), Finnhub (' + error8.message + '), AlphaVantage (' + error9.message + '), Nasdaq (' + error10.message + ')');
                    }
                  }
                }
              }
            }
          }
        }
        // Extra safety: if this index is Brent, explicitly try the canonical BZ=F symbol
        try {
          const isBrent = String(idx.label || '').toUpperCase().includes('BRENT');
          if (isBrent) {
            const r = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent('BZ=F')}`, { timeout: 8000 });
            if (r.ok) {
              const qq = await r.json();
              const p = qq.regularMarketPrice ?? null;
              const pn = (p == null) ? null : (typeof p === 'number' ? p : Number(p));
              if (pn != null && pn > 1) {
                chosen = 'BZ=F';
                q = qq;
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

function computeMetrics(data, tradingView = {}) {
  const fin = data.financialData || {};
  const price = safe(data.price?.regularMarketPrice?.raw);
  const previousClose = safe(data.price?.previousClose?.raw);
  const marketCap = safe(data.price?.marketCap?.raw);
  const ebitda = safe(fin.ebitda?.raw);
  const totalRevenue = safe(fin.totalRevenue?.raw);
  const freeCashflow = safe(fin.freeCashflow?.raw);
  const operatingCashflow = safe(fin.operatingCashflow?.raw);
  const debtToEquity = safe(fin.debtToEquity?.raw);

  // Use explicit EV when available; otherwise reverse-compute from evEbitda × ebitda
  const computedEvEbitda = safe(data.computedMetrics?.evEbitda);
  let enterpriseValue = safe(fin.enterpriseValue?.raw);
  if (enterpriseValue == null && computedEvEbitda != null && ebitda != null) {
    enterpriseValue = computedEvEbitda * ebitda;
  }

  // Prefer explicit EV/EBITDA from source; fallback to computing from EV and EBITDA
  let evEbitda = computedEvEbitda;
  if (evEbitda == null && enterpriseValue != null && ebitda != null) {
    evEbitda = enterpriseValue / ebitda;
  }

  return {
    forwardPE: safe(fin.forwardPE?.raw),
    peg: safe(fin.pegRatio?.raw),
    evEbitda,
    fcfYield: marketCap && freeCashflow ? freeCashflow / marketCap : null,
    ocfYield: marketCap && operatingCashflow ? operatingCashflow / marketCap : null,
    fcfMargin: totalRevenue && freeCashflow ? freeCashflow / totalRevenue : null,
    ocfMargin: totalRevenue && operatingCashflow ? operatingCashflow / totalRevenue : null,
    freeCashflow,
    operatingCashflow,
    debtToEquity,
    avgPriceTarget: safe(fin.targetMeanPrice?.raw),
    recommendationTrend: data.recommendationTrend || null,
    regularMarketPrice: price,
    previousClose,
    marketCap,
    enterpriseValue,
    ebitda,
    totalRevenue,
    raw: data
  };
}

app.post("/webhook/finnhub", (req, res) => {
  // Verify webhook secret
  const secret = req.headers["x-finnhub-secret"];
  if (secret !== WEBHOOK_SECRET) {
    console.error("Invalid webhook secret received");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Acknowledge receipt immediately with 2xx status
    res.status(200).json({ success: true });

    // Process the webhook data asynchronously
    const data = req.body;
    if (data && data.type) {
      console.log("Webhook received:", data.type, data);

      // Cache trade data for later retrieval
      if (data.type === "trade" && data.data) {
        data.data.forEach((trade) => {
          const symbol = trade.s;
          if (!cache[symbol]) {
            cache[symbol] = [];
          }
          cache[symbol].push({
            price: trade.p,
            volume: trade.v,
            timestamp: trade.t,
            timestamp_ms: trade.ms
          });
          // Keep only last 100 trades per symbol
          if (cache[symbol].length > 100) {
            cache[symbol].shift();
          }
        });
      }

      // Handle other event types as needed
      if (data.type === "quote" && data.data) {
        console.log(
          `Quote update for ${data.data.s}: price=${data.data.p}, bid=${data.data.b}, ask=${data.data.a}`
        );
      }
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(500).json({ error: "Processing failed" });
  }
});

app.get("/api/cache/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const trades = cache[symbol] || [];
  res.json({
    symbol,
    tradeCount: trades.length,
    trades: trades.slice(-10) // Return last 10 trades
  });
});

app.get("/api/ticker/:symbol", async (req, res) => {
  try {
    const ticker = req.params.symbol.toUpperCase();
    // Return cached value when fresh
    const key = ticker;
    const now = Date.now();
    const cached = tickerCache.get(key);
    if (cached && cached.data && cached.expiresAt > now) {
      const metricsCached = computeMetrics(cached.data);
      const tradingViewCached = await fetchTradingViewConsensus(ticker);
      return res.json({
        symbol: ticker,
        shortName: sanitizeCompanyName(cached.data.price?.shortName, cached.data.price?.shortName),
        currency: cached.data.price?.currency,
        quoteSource: cached.data.quoteSource || "Unknown",
        metricSources: cached.data.metricSources || null,
        ...metricsCached,
        tradingView: tradingViewCached
      });
    }

    // If a fetch is already in-flight for this ticker, await it (request coalescing)
    if (cached && cached.promise) {
      await cached.promise;
      const finished = tickerCache.get(key);
      if (finished && finished.data) {
        const metricsFinished = computeMetrics(finished.data);
        const tradingViewFinished = await fetchTradingViewConsensus(ticker);
        return res.json({
          symbol: ticker,
          shortName: sanitizeCompanyName(finished.data.price?.shortName, finished.data.price?.shortName),
          currency: finished.data.price?.currency,
          quoteSource: finished.data.quoteSource || "Unknown",
          metricSources: finished.data.metricSources || null,
          ...metricsFinished,
          tradingView: tradingViewFinished
        });
      }
    }

    // Otherwise start a new fetch and store the promise so concurrent requests can await it
    const fetchPromise = (async () => {
      const q = await fetchStrictTickerData(ticker);
      // store final data with TTL
      tickerCache.set(key, { data: q, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
      return q;
    })();
    tickerCache.set(key, { promise: fetchPromise });

    const quote = await fetchPromise;
    const metrics = computeMetrics(quote);
    // Fetch trading view in parallel where possible
    const tradingView = await fetchTradingViewConsensus(ticker);

    // evEbitda is already handled inside computeMetrics via computedMetrics, no extra override needed

    res.json({
      symbol: ticker,
      shortName: sanitizeCompanyName(quote.price?.shortName, quote.price?.shortName),
      currency: quote.price?.currency,
      quoteSource: quote.quoteSource || "Unknown",
      metricSources: quote.metricSources || null,
      ...metrics,
      tradingView
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unable to fetch ticker data." });
  }
});

// ── Market Indices ──────────────────────────────────────────────────────────
const MARKET_INDICES = [
  { symbol: "^GSPC",    label: "S&P 500"    },
  { symbol: "^IXIC",    label: "Nasdaq"     },
  { symbol: "^DJI",     label: "Dow"        },
  { symbol: "GC=F",     label: "Gold"       },
  { symbol: "SI=F",     label: "Silver"     },
  { symbol: "^TNX",     label: "10Y"        },
  { symbol: "CL=F",     label: "WTI"        },
  { symbol: "BZ=F",     label: "Brent", symbols: ["BZ=F","BRT-USD","LCOc1","BNO"] },
  { symbol: "^BSESN",   label: "Sensex"     },
  { symbol: "USDINR=X", label: "USD/INR"    },
  { symbol: "^N225",    label: "Nikkei"     },
  { symbol: "^KS11",    label: "KOSPI"      },
  { symbol: "DX-Y.NYB", label: "Dollar Index" }
];
let _marketCache = null;
let _marketCacheAt = 0;
const MARKET_CACHE_TTL = 60_000; // 1 min

app.get("/api/market-indices", async (_req, res) => {
  try {
    const now = Date.now();
    if (_marketCache && now - _marketCacheAt < MARKET_CACHE_TTL) {
      return res.json(_marketCache);
    }
    const results = await Promise.all(
      MARKET_INDICES.map(async (idx) => {
        const candidates = Array.isArray(idx.symbols) && idx.symbols.length > 0 ? idx.symbols : [idx.symbol];
        let chosen = null;
        let q = null;
        for (const s of candidates) {
          try {
            const r = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent(s)}`, { timeout: 8000 });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const qq = await r.json();
            const price = qq.regularMarketPrice ?? null;
            // Reject implausible tiny values for commodities like Brent/WTI
            const numericPrice = (price == null) ? null : (typeof price === 'number' ? price : Number(price));
            let plausible = true;
            const labelUpper = String(idx.label || '').toUpperCase();
            if (numericPrice != null && (labelUpper.includes('BRENT') || labelUpper.includes('WTI') || labelUpper.includes('OIL'))) {
              plausible = numericPrice > 1; // oil prices below $1 are implausible
            }
            if (numericPrice != null && plausible) {
              chosen = s;
              q = qq;
              break;
            }
            // if price is null, keep trying next candidate
          } catch {
            // ignore and try next candidate
          }
        }
        if (!chosen && candidates.length > 0) {
          // final attempt using primary symbol (may return null fields)
          try {
            const r = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent(candidates[0])}`, { timeout: 8000 });
            if (r.ok) q = await r.json();
          } catch {}
        }
        const price = q?.regularMarketPrice ?? null;
        const prevClose = q?.regularMarketPreviousClose ?? null;
        const change = (price != null && prevClose != null) ? price - prevClose : null;
        const changePct = (change != null && prevClose) ? (change / prevClose) * 100 : null;
        // Ensure label is clean (trim and remove trailing hyphens) to avoid UI artifacts like "SSE-"
        const cleanLabel = String(idx.label || '').trim().replace(/-+$/,'');
        return { symbol: chosen || idx.symbol, label: cleanLabel, price, change, changePct };
      })
    );
    _marketCache = { indices: results };
    _marketCacheAt = now;
    res.json(_marketCache);
  } catch (error) {
    if (_marketCache) return res.json(_marketCache);
    res.status(500).json({ error: error.message || "Unable to fetch market indices." });
  }
});

app.get("/api/news/latest", async (_req, res) => {
  try {
    const news = await fetchOverallLatestNews();
    res.json({ count: news.length, news });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unable to fetch latest news." });
  }
});

app.get("/api/news/:symbol", async (req, res) => {
  try {
    const ticker = req.params.symbol.toUpperCase();
    const companyName = sanitizeCompanyName(req.query.companyName, req.query.companyName || "");
    const news = await fetchGoogleTickerNews(ticker, companyName);
    res.json({ symbol: ticker, news });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unable to fetch news." });
  }
});

app.get("/api/health", async (req, res) => {
  const symbol = (req.query.symbol || "AAPL").toString().toUpperCase();

  async function timed(label, fn) {
    const start = Date.now();
    try {
      const value = await fn();
      return {
        name: label,
        ok: true,
        ms: Date.now() - start,
        sample: value
      };
    } catch (error) {
      return {
        name: label,
        ok: false,
        ms: Date.now() - start,
        error: error.message || String(error)
      };
    }
  }

  const checks = await Promise.all([
    timed("yahooPage", async () => {
      const q = await scrapeYahooFinance(symbol);
      return {
        currentPrice: safe(q?.price?.regularMarketPrice?.raw),
        forwardPE: safe(q?.financialData?.forwardPE?.raw),
        peg: safe(q?.financialData?.pegRatio?.raw)
      };
    }),
    timed("yfinance", async () => {
      const q = await fetchYFinance(symbol);
      return {
        currentPrice: safe(q?.price?.regularMarketPrice?.raw),
        forwardPE: safe(q?.financialData?.forwardPE?.raw),
        peg: safe(q?.financialData?.pegRatio?.raw)
      };
    }),
    timed("cnbc", async () => {
      const q = await fetchCNBCMetrics(symbol);
      return {
        currentPrice: safe(q?.currentPrice),
        forwardPE: safe(q?.forwardPE),
        peg: safe(q?.peg)
      };
    }),
    timed("guruFocus", async () => {
      const q = await scrapeGuruFocusForwardPE(symbol);
      return {
        currentPrice: safe(q?.price),
        forwardPE: safe(q?.forwardPE),
        peg: safe(q?.peg)
      };
    }),
    timed("tradingView", async () => {
      const q = await fetchTradingViewConsensus(symbol);
      return {
        ratingScore: safe(q?.ratingScore),
        ratingLabel: q?.ratingLabel || null,
        rsi: safe(q?.rsi)
      };
    }),
    timed("strictSelection", async () => {
      const q = await fetchStrictTickerData(symbol);
      return {
        metricSources: q?.metricSources || null,
        currentPrice: safe(q?.price?.regularMarketPrice?.raw),
        forwardPE: safe(q?.financialData?.forwardPE?.raw),
        peg: safe(q?.financialData?.pegRatio?.raw)
      };
    })
  ]);

  const okCount = checks.filter((c) => c.ok).length;

  res.json({
    status: okCount >= 2 ? "ok" : "degraded",
    symbol,
    checkedAt: new Date().toISOString(),
    okCount,
    totalChecks: checks.length,
    checks
  });
});

// Serve frontend
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(`${__dirname}/index.html`));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Stock tracker API listening on http://localhost:${PORT}`);
});
