import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import axios from "axios";
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import YahooFinance from "yahoo-finance2";
import Parser from "rss-parser";
import stringSimilarity from "string-similarity";
import { fetchGoogleTickerNews } from "./news/tickerNews.js";
import { fetchOverallLatestNews } from "./news/latestNews.js";
import fs from 'fs/promises';
import { getSentiment, sentimentEmoji, deviationPercent, chooseMasterMetric } from './sector/sentiment.js';

const app = express();
app.use(cors());
app.use(express.json());

const yahooFinanceClient = new YahooFinance({
  suppressNotices: ['yahooSurvey']
});

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
const FMP_API = process.env.FMP_API || 'https://financialmodelingprep.com/api/v3';
const EODHD_API = "https://eodhd.com/api/fundamentals";
const GURUFOCUS_API = "https://www.gurufocus.com/api/public/stock";
const GURUFOCUS_URL = "https://www.gurufocus.com/stock";
const YAHOO_FINANCE_URL = "https://finance.yahoo.com/quote";
const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const STOCKTWITS_GATEWAY_BASE_URL = "https://api-gw-prd.stocktwits.com/api-middleware/external";
const STOCKTWITS_GATEWAY_TIMEOUT_MS = Number(process.env.STOCKTWITS_TIMEOUT_MS || 5000);
const STOCKTWITS_PUBLIC_BASE_URL = "https://api.stocktwits.com/api/2";
const NEWS_MAX_ITEMS = 5;
const OVERALL_NEWS_MAX_ITEMS = 10;
const OVERALL_NEWS_MAX_PER_SOURCE = 2;
const NEWS_CACHE_TTL_SECONDS = Number(process.env.NEWS_CACHE_TTL_SECONDS || 600);
const DEFAULT_TRENDING_POLL_INTERVAL_MS = 5 * 60 * 1000;
const TRENDING_POLL_INTERVAL_MS_RAW = Number(process.env.TRENDING_POLL_INTERVAL_MS || DEFAULT_TRENDING_POLL_INTERVAL_MS);
const TRENDING_POLL_INTERVAL_MS = Number.isFinite(TRENDING_POLL_INTERVAL_MS_RAW) && TRENDING_POLL_INTERVAL_MS_RAW >= 60 * 1000
  ? TRENDING_POLL_INTERVAL_MS_RAW
  : DEFAULT_TRENDING_POLL_INTERVAL_MS;
const TRENDING_JSON_PATH = './data/trending.json';
const EARNINGS_WEEK_JSON_PATH = './data/earnings_week.json';
const EARNINGS_MOVES_JSON_PATH = './data/earnings_moves.json';
const DEFAULT_FINNHUB_KEY = 'd7d3gk1r01qv03eu7vf0';
const EARNINGS_SATURDAY_HOUR_LOCAL = Number(process.env.EARNINGS_SATURDAY_HOUR_LOCAL || 9);
const IMPLIED_REFRESH_HOUR_LOCAL = Number(process.env.IMPLIED_REFRESH_HOUR_LOCAL || 21);
const PREFERRED_NEWS_SOURCES = [
  "CNBC", "Reuters", "Yahoo Finance", "Bloomberg",
  "Financial Times", "The Street", "Forbes",
  "Wall Street Journal", "Barrons", "MarketWatch", "NDTV Profit"
];

// In-memory cache for RSS news with request coalescing.
const newsCache = new Map(); // key -> { data, expiresAt, promise }
let overallNewsCache = null; // { data, expiresAt, promise }
let stocktwitsDefaultAuth = {
  username: '',
  password: '',
  token: '',
  basicHeader: ''
};
let trendingCache = { symbols: [], fetchedAt: null, source: 'bootstrap' };
let trendingUpdatePromise = null;
let trendingPollTimer = null;
let indexHtmlTemplate = null;
let weeklyEarningsCache = { updatedAt: 0, weekStart: null, days: {} };
let earningsMovesCache = {};
let earningsRefreshPromise = null;
let impliedRefreshPromise = null;
let earningsRefreshState = {
  lastWeeklyRefreshWeekStart: null,
  lastImpliedRefreshDate: null
};

// News-related helpers and fetchers have been moved to the `news` folder.
// see: ./news/newsUtils.js, ./news/tickerNews.js, ./news/latestNews.js

function safe(value) {
  return value == null ? null : Number(value);
}

function firstPositiveFinite(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function sanitizeCompanyName(value, fallback = null) {
  const cleaned = String(value || "")
    .replace(/\b[A-Z.\-]+\s*[—-]\s*Yahoo Finance\s*/i, '')
    .replace(/\s*[—-]?\s*Yahoo Finance\b/ig, '')
    .replace(/^Yahoo\s*Finance\s*/i, '')
    .replace(/\b(inc\.?|corp\.?|corporation|company|co\.?|limited|ltd\.?|plc|holdings?)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Remove stray leading/trailing punctuation (e.g., "Apple .", "TESLA, .")
  const trimmedPunct = String(cleaned)
    .replace(/^[\s\.,:;\-\u00B7\u2013\u2014]+/, '')
    .replace(/[\s\.,:;\-\u00B7\u2013\u2014]+$/ , '')
    .replace(/\s+([\.,:;\-\u00B7\u2013\u2014])+$/ , '');
  return (trimmedPunct || fallback);
}

function isTodayOrYesterdayOrTomorrowEpoch(epochSeconds) {
  // Accept: unix epoch seconds (number), unix ms (number >= 1e11), or ISO date string
  let d;
  if (typeof epochSeconds === 'string' && isNaN(Number(epochSeconds))) {
    d = new Date(epochSeconds);
  } else {
    const ts = Number(epochSeconds);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    d = new Date(ts >= 1e11 ? ts : ts * 1000);
  }
  if (isNaN(d.getTime())) return false;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yday = new Date(today);
  yday.setDate(today.getDate() - 1);
  const tmrw = new Date(today);
  tmrw.setDate(today.getDate() + 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return target.getTime() === today.getTime()
    || target.getTime() === yday.getTime()
    || target.getTime() === tmrw.getTime();
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
      timeout: 2500,
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
      postMarketPrice: { raw: data.postMarketPrice },
      preMarketPrice: { raw: data.preMarketPrice },
      postMarketChangePercent: { raw: data.postMarketChangePercent },
      preMarketChangePercent: { raw: data.preMarketChangePercent },
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
    fiftyTwoWeekHigh: data.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: data.fiftyTwoWeekLow,
    earningsDate: data.earningsDate,
    recommendationTrend: null,
    quoteSource: data.quoteSource || 'yfinance (Yahoo Finance)',
    computedMetrics: {}
  };
}

function normalizeSymbolForYahoo(rawSymbol) {
  const upper = String(rawSymbol || '').trim().toUpperCase();
  // Stocktwits crypto symbols are often "ETH.X", while Yahoo expects "ETH-USD".
  if (/^[A-Z0-9]+\.X$/.test(upper)) return upper.replace(/\.X$/, '-USD');
  return upper;
}

function normalizeSymbolForStocktwits(rawSymbol) {
  const upper = String(rawSymbol || '').trim().toUpperCase();
  if (/^[A-Z0-9]+-USD$/.test(upper)) return upper.replace(/-USD$/, '.X');
  return upper;
}

// Try to resolve a user-provided query to a canonical ticker symbol.
// Strategy:
// 1) Try a quick yfinance microservice probe for the uppercased input.
// 2) If that fails, call Yahoo's search API and pick the top quote symbol.
async function resolveTickerSymbol(query) {
  const raw = (query || "").toString().trim();
  const upper = raw.toUpperCase();
  const yahooCandidate = normalizeSymbolForYahoo(upper);
  // Fast probe: if yfinance returns reasonable data for the candidate, accept it.
  try {
    const probe = await fetchYFinance(yahooCandidate).catch(() => null);
    if (probe && (probe.price?.regularMarketPrice != null || probe.financialData?.forwardPE != null)) {
      return yahooCandidate;
    }
  } catch (e) {
    // ignore and fall through to search
  }

  // Use Yahoo Finance search endpoint as a fuzzy resolver
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(raw)}`;
    const res = await fetch(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const j = await res.json();
      if (j && Array.isArray(j.quotes) && j.quotes.length > 0) {
        const pick = j.quotes[0];
        if (pick && pick.symbol) return pick.symbol.toUpperCase();
      }
    }
  } catch (e) {
    // ignore and fall back to raw
  }

  // Fallback: try a local fuzzy match against a small candidate set (watchlist + market indices)
  try {
    const candidates = new Set();
    try {
      const watch = JSON.parse(await fs.readFile('./data/stock_watchlist.json', 'utf8'));
      (watch || []).forEach((s) => candidates.add(String(s).toUpperCase()));
    } catch (e) {
      // ignore missing watchlist
    }
    try {
      MARKET_INDICES.forEach((mi) => {
        if (Array.isArray(mi.symbols) && mi.symbols.length) mi.symbols.forEach((s) => candidates.add(String(s).toUpperCase()));
        else if (mi.symbol) candidates.add(String(mi.symbol).toUpperCase());
      });
    } catch (e) {}

    const inputLower = raw.toLowerCase();
    const candArr = Array.from(candidates);
    if (candArr.length > 0) {
      // Score symbol text first
      let scored = candArr.map((s) => ({ s, score: stringSimilarity.compareTwoStrings(inputLower, s.toLowerCase()) }));
      scored.sort((a, b) => b.score - a.score);
      // Probe top candidates' short names for better match
      const top = scored.slice(0, 10);
      let best = { symbol: top[0]?.s || upper, score: top[0]?.score || 0 };
      for (const item of top) {
        try {
          const q = await fetchYFinance(item.s).catch(() => null);
          const name = q?.price?.shortName || q?.price?.shortName || '';
          if (name) {
            const sscore = stringSimilarity.compareTwoStrings(inputLower, String(name).toLowerCase());
            if (sscore > best.score) {
              best = { symbol: item.s, score: sscore };
            }
          }
        } catch (e) {}
      }
      // If similarity is strong enough, return that symbol
      if (best.score > 0.45) return best.symbol;
    }
  } catch (e) {
    // ignore fallback errors
  }

  return yahooCandidate;
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

async function fetchYahooFinance2TickerData(ticker) {
  const yahooSymbol = normalizeSymbolForYahoo(ticker);
  const [quote, summary] = await Promise.all([
    withTimeout(yahooFinanceClient.quote(yahooSymbol), 7000, 'yahoo-finance2 quote'),
    withTimeout(
      yahooFinanceClient.quoteSummary(yahooSymbol, {
        modules: ['financialData', 'defaultKeyStatistics']
      }),
      7000,
      'yahoo-finance2 quoteSummary'
    )
  ]);

  const financialData = summary?.financialData || {};
  const keyStats = summary?.defaultKeyStatistics || {};

  const currentPrice = safe(quote?.regularMarketPrice ?? quote?.postMarketPrice ?? quote?.preMarketPrice);
  const previousClose = safe(quote?.regularMarketPreviousClose ?? quote?.previousClose);
  const marketCap = safe(quote?.marketCap);
  const forwardPE = safe(keyStats?.forwardPE ?? financialData?.forwardPE);
  const pegRatio = safe(keyStats?.pegRatio ?? financialData?.pegRatio);
  const enterpriseValue = safe(keyStats?.enterpriseValue);
  const evToEbitda = safe(keyStats?.enterpriseToEbitda);
  const ebitda = safe(financialData?.ebitda);
  const totalRevenue = safe(financialData?.totalRevenue);
  const freeCashflow = safe(financialData?.freeCashflow);
  const operatingCashflow = safe(financialData?.operatingCashflow);
  const targetMeanPrice = safe(financialData?.targetMeanPrice);
  const debtToEquity = safe(financialData?.debtToEquity);

  if (currentPrice == null && forwardPE == null && pegRatio == null) {
    throw new Error(`yahoo-finance2: insufficient data for ${ticker}`);
  }

  return {
    price: {
      regularMarketPrice: { raw: currentPrice },
      previousClose: { raw: previousClose },
      postMarketPrice: { raw: safe(quote?.postMarketPrice) },
      preMarketPrice: { raw: safe(quote?.preMarketPrice) },
      postMarketChangePercent: { raw: safe(quote?.postMarketChangePercent) },
      preMarketChangePercent: { raw: safe(quote?.preMarketChangePercent) },
      marketCap: { raw: marketCap },
      currency: quote?.currency || 'USD',
      shortName: quote?.shortName || quote?.longName || ticker,
      marketState: quote?.marketState,
      quoteType: quote?.quoteType
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
    fiftyTwoWeekHigh: safe(quote?.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: safe(quote?.fiftyTwoWeekLow),
    earningsDate: quote?.earningsTimestamp || null,
    recommendationTrend: null,
    quoteSource: 'yahoo-finance2',
    metricSources: {
      regularMarketPrice: currentPrice != null ? 'yahoo-finance2' : null,
      forwardPE: forwardPE != null ? 'yahoo-finance2' : null,
      pegRatio: pegRatio != null ? 'yahoo-finance2' : null
    },
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
  // Fast path: prefer yahoo-finance2 for current quote fields; fall back to the
  // local yfinance microservice if yahoo-finance2 lacks valuation fields.
  try {
    const fast = await fetchYahooFinance2TickerData(ticker);
    const fastPrice = safe(fast?.price?.regularMarketPrice?.raw);
    const fastForward = safe(fast?.financialData?.forwardPE?.raw);
    const fastPeg = safe(fast?.financialData?.pegRatio?.raw);
    if (fastPrice != null && (fastForward != null || fastPeg != null)) {
      fast.quoteSource = fast.quoteSource || 'yahoo-finance2 (fast path)';
      fast.metricSources = {
        ...(fast.metricSources || {}),
        regularMarketPrice: fast.metricSources?.regularMarketPrice || 'yahoo-finance2',
        forwardPE: fast.metricSources?.forwardPE || (fastForward != null ? 'yahoo-finance2' : null),
        pegRatio: fast.metricSources?.pegRatio || (fastPeg != null ? 'yahoo-finance2' : null)
      };
      return fast;
    }
  } catch (_) {
    // continue with python yfinance fast path below
  }

  try {
    const fast = await fetchYFinance(ticker);
    const fastPrice = safe(fast?.price?.regularMarketPrice?.raw);
    const fastForward = safe(fast?.financialData?.forwardPE?.raw);
    const fastPeg = safe(fast?.financialData?.pegRatio?.raw);
    if (fastPrice != null && (fastForward != null || fastPeg != null)) {
      fast.quoteSource = fast.quoteSource || 'yfinance (fast path)';
      fast.metricSources = {
        ...(fast.metricSources || {}),
        regularMarketPrice: fast.metricSources?.regularMarketPrice || 'yfinance',
        forwardPE: fast.metricSources?.forwardPE || (fastForward != null ? 'yfinance' : null),
        pegRatio: fast.metricSources?.pegRatio || (fastPeg != null ? 'yfinance' : null)
      };
      return fast;
    }
  } catch (_) {
    // continue with strict multi-source aggregation below
  }

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
    const requestedQuery = req.params.symbol;
    const ticker = await resolveTickerSymbol(requestedQuery);
    // Return cached value when fresh
    const key = ticker;
    const now = Date.now();
    const cached = tickerCache.get(key);
    if (cached && cached.data && cached.expiresAt > now) {
      const metricsCached = computeMetrics(cached.data);
      const tradingViewCached = await fetchTradingViewConsensus(ticker);
      const sessionCached = await computeTickerSessionFields(ticker, cached.data);
      return res.json({
        symbol: ticker,
        shortName: sanitizeCompanyName(cached.data.price?.shortName, cached.data.price?.shortName),
        currency: cached.data.price?.currency,
        fiftyTwoWeekHigh: cached.data.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: cached.data.fiftyTwoWeekLow,
        earningsDate: cached.data.earningsDate,
        quoteSource: cached.data.quoteSource || "Unknown",
        metricSources: cached.data.metricSources || null,
        regularPrice: sessionCached.regularPrice,
        previousClose: sessionCached.prevClose,
        extendedPrice: sessionCached.extendedPrice,
        regularChangePct: sessionCached.regularChangePct,
        extendedChangePct: sessionCached.extendedChangePct,
        extendedChangePercent: sessionCached.extendedChangePct,
        marketSession: sessionCached.marketSession,
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
        const sessionFinished = await computeTickerSessionFields(ticker, finished.data);
        return res.json({
          symbol: ticker,
          shortName: sanitizeCompanyName(finished.data.price?.shortName, finished.data.price?.shortName),
          currency: finished.data.price?.currency,
          fiftyTwoWeekHigh: finished.data.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: finished.data.fiftyTwoWeekLow,
          earningsDate: finished.data.earningsDate,
          quoteSource: finished.data.quoteSource || "Unknown",
          metricSources: finished.data.metricSources || null,
          regularPrice: sessionFinished.regularPrice,
          previousClose: sessionFinished.prevClose,
          extendedPrice: sessionFinished.extendedPrice,
          regularChangePct: sessionFinished.regularChangePct,
          extendedChangePct: sessionFinished.extendedChangePct,
          extendedChangePercent: sessionFinished.extendedChangePct,
          marketSession: sessionFinished.marketSession,
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
    const session = await computeTickerSessionFields(ticker, quote);

    // evEbitda is already handled inside computeMetrics via computedMetrics, no extra override needed

    res.json({
      symbol: ticker,
      shortName: sanitizeCompanyName(quote.price?.shortName, quote.price?.shortName),
      currency: quote.price?.currency,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      earningsDate: quote.earningsDate,
      quoteSource: quote.quoteSource || "Unknown",
      metricSources: quote.metricSources || null,
      regularPrice: session.regularPrice,
      previousClose: session.prevClose,
      extendedPrice: session.extendedPrice,
      regularChangePct: session.regularChangePct,
      extendedChangePct: session.extendedChangePct,
      extendedChangePercent: session.extendedChangePct,
      marketSession: session.marketSession,
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
  { symbol: "DGS2",     label: "2Y", symbols: ["DGS2","^IRX"] },
  { symbol: "CL=F",     label: "WTI"        },
  { symbol: "BZ=F",     label: "Brent", symbols: ["BZ=F","BRT-USD","LCOc1","BNO"] },
  { symbol: "^BSESN",   label: "Sensex"     },
  { symbol: "BTC-USD",  label: "BTC"        },
  { symbol: "ETH-USD",  label: "ETH"        },
  { symbol: "USDINR=X", label: "USD/INR"    },
  { symbol: "^N225",    label: "Nikkei"     },
  { symbol: "^KS11",    label: "KOSPI"      },
  { symbol: "DX-Y.NYB", label: "Dollar Index" }
];
const STOCKTWITS_INDEX_PROXY = {
  'S&P 500': 'SPY',
  'Nasdaq': 'QQQ',
  'Dow': 'DIA'
};
let _marketCache = {};
let _marketCacheAt = {};
const MARKET_CACHE_TTL = 60_000; // 1 min

app.get("/api/market-indices", async (req, res) => {
  try {
    const group = String(req.query.group || '').toUpperCase();
    const groupLabels = {
      US: new Set(['S&P 500', 'Nasdaq', 'Dow'])
    };
    const selected = groupLabels[group]
      ? MARKET_INDICES.filter((idx) => groupLabels[group].has(String(idx.label || '')))
      : MARKET_INDICES;
    const cacheKey = group || 'ALL';
    const now = Date.now();
    if (_marketCache[cacheKey] && _marketCacheAt[cacheKey] && now - _marketCacheAt[cacheKey] < MARKET_CACHE_TTL) {
      return res.json(_marketCache[cacheKey]);
    }
    const results = await Promise.all(
      selected.map(async (idx) => {
        const cleanLabel = String(idx.label || '').trim().replace(/-+$/,'');

        // Fast path: use Yahoo proxy ETFs for major US indices, including extended-hours.
        const stProxy = STOCKTWITS_INDEX_PROXY[cleanLabel] || null;
        if (stProxy) {
          try {
            const proxy = await fetchYahooProxyQuote(stProxy);
            const { price, change, changePct, regularPrice, extendedPrice, marketSession } = proxy;

            if (price != null) {
              return {
                symbol: stProxy,
                label: cleanLabel,
                price,
                change,
                changePct,
                regularPrice,
                extendedPrice,
                marketSession,
                prevClose: proxy.prevClose,
                regularChangePct: proxy.regularChangePct,
                extendedChangePct: proxy.extendedChangePct,
                source: 'Yahoo Finance proxy ETF'
              };
            }
          } catch (_) {
            // fall through to yfinance candidates
          }
        }

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
        // For Brent specifically, prefer the canonical BZ=F spot quote if available
        try {
          const labelUpper = String(idx.label || '').toUpperCase();
          if (labelUpper.includes('BRENT')) {
            const r2 = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent('BZ=F')}`, { timeout: 8000 });
            if (r2.ok) {
              const qq2 = await r2.json();
              const p2 = qq2.regularMarketPrice ?? null;
              const pn2 = (p2 == null) ? null : (typeof p2 === 'number' ? p2 : Number(p2));
              if (pn2 != null && pn2 > 1) {
                chosen = 'BZ=F';
                q = qq2;
              }
            }
          }
        } catch (e) {
          // ignore and continue with previously chosen candidate
        }
        const price = q?.regularMarketPrice ?? null;
        const prevClose = q?.regularMarketPreviousClose ?? null;
        const change = (price != null && prevClose != null) ? price - prevClose : null;
        const changePct = (change != null && prevClose) ? (change / prevClose) * 100 : null;
        return { symbol: chosen || idx.symbol, label: cleanLabel, price, change, changePct, source: 'yfinance' };
      })
    );
    _marketCache[cacheKey] = { indices: results };
    _marketCacheAt[cacheKey] = now;
    res.json(_marketCache[cacheKey]);
  } catch (error) {
    const group = String(req.query.group || '').toUpperCase();
    const cacheKey = group || 'ALL';
    if (_marketCache[cacheKey]) return res.json(_marketCache[cacheKey]);
    res.status(500).json({ error: error.message || "Unable to fetch market indices." });
  }
});

// Serve cached sector averages (seeded JSON)
app.get('/api/sector-averages', async (_req, res) => {
  try {
    // Merge cached values over seed so defaults are always present.
    let seedData = {};
    let cachedData = {};
    try {
      const seed = await fs.readFile('./data/sector_averages_2026.json', 'utf8');
      seedData = JSON.parse(seed || '{}');
    } catch (_) {}
    try {
      const raw = await fs.readFile('./data/sector_averages.json', 'utf8');
      cachedData = JSON.parse(raw || '{}');
    } catch (_) {}
    return res.json({ ...seedData, ...cachedData });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load sector averages' });
  }
});

// Compare a stock's key metrics to sector and historical averages.
// Query params:
//  - sector=SectorName (optional but recommended)
// If no sector param is provided, this endpoint will still attempt to return metric comparisons
// using the seeded S&P averages when sector mapping is unavailable.
app.get('/api/compare/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toString().toUpperCase();
  const sectorName = req.query.sector || null;
  try {
    // Try to infer sector if not explicitly provided
    async function getSectorForTicker(ticker) {
      try {
        // Try FinancialModelingPrep profile if API key is configured
        const apiKey = process.env.FMP_API_KEY;
        if (apiKey) {
          const url = `${FMP_API}/profile/${encodeURIComponent(ticker)}?apikey=${apiKey}`;
          const r = await fetch(url, { timeout: 10000 });
          if (r.ok) {
            const body = await r.json();
            if (Array.isArray(body) && body[0]) {
              if (body[0].sector) return body[0].sector;
              if (body[0].industry) return body[0].industry;
            } else if (body && body.sector) return body.sector;
          }
        }
      } catch (e) {}
      try {
        // Try yfinance microservice response (may include sector/industry)
        const r2 = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent(ticker)}`, { timeout: 1500 });
        if (r2.ok) {
          const j = await r2.json();
          if (j.sector) return j.sector;
          if (j.industry) return j.industry;
        }
      } catch (e) {}
      // Quick local mapping fallback for common tickers
      const map = {
        AAPL: 'Technology',
        MSFT: 'Technology',
        GOOGL: 'Technology',
        NVDA: 'Technology',
        META: 'Technology',
        TSLA: 'Consumer Cyclical',
        AMZN: 'Consumer Cyclical',
        XOM: 'Energy',
        CVX: 'Energy',
        JPM: 'Financials',
        GS: 'Financials'
      };
      return map[ticker] || null;
    }

    // Fast path: reuse `/api/ticker` cache so compare renders quickly after search.
    // Fallback to strict fetch only when cache is empty/stale.
    const key = symbol;
    const now = Date.now();
    let data = null;
    const cached = tickerCache.get(key);
    if (cached && cached.data && cached.expiresAt > now) {
      data = cached.data;
    } else if (cached && cached.promise) {
      try {
        data = await cached.promise;
      } catch (_) {
        data = null;
      }
    }
    if (!data) {
      data = await fetchStrictTickerData(symbol);
      tickerCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
    }
    const metrics = computeMetrics(data);

    // Helper: compute sentiment using available references (prefer both, else single)
    function computeSentimentFlexible(current, sectorRef, histRef, type = 'valuation') {
      if (sectorRef == null && histRef == null) return 'AVERAGE';
      if (sectorRef != null && histRef != null) return getSentiment(current, sectorRef, histRef, type);
      const isHigherBetter = (type === 'efficiency');
      const ref = histRef != null ? histRef : sectorRef;
      if (ref == null) return 'AVERAGE';
      if (isHigherBetter) return current > ref ? 'UP' : current < ref ? 'DOWN' : 'AVERAGE';
      return current < ref ? 'UP' : current > ref ? 'DOWN' : 'AVERAGE';
    }

    // Thumbs from both references: sector average + stock historical average.
    function dualBaselineSentiment(current, sectorRef, stockRef, type = 'valuation') {
      if (sectorRef == null && stockRef == null) return 'AVERAGE';
      const isHigherBetter = (type === 'efficiency');
      const better = (ref) => {
        if (ref == null) return null;
        if (isHigherBetter) return current > ref;
        return current < ref;
      };
      const betterSector = better(sectorRef);
      const betterStock = better(stockRef);

      if (betterSector == null) return betterStock ? 'UP' : (betterStock === false ? 'DOWN' : 'AVERAGE');
      if (betterStock == null) return betterSector ? 'UP' : (betterSector === false ? 'DOWN' : 'AVERAGE');
      if (betterSector && betterStock) return 'UP';
      if (!betterSector && !betterStock) return 'DOWN';
      return 'AVERAGE';
    }

    // Infer sector quickly: prefer values already present in fetched data.
    const inferredSector =
      sectorName
      || data?.sector
      || data?.industry
      || data?.assetProfile?.sector
      || (await getSectorForTicker(symbol))
      || 'S&P500';

    // Load sector averages: cached values override seed, but seed guarantees defaults.
    let sectorData = {};
    try {
      const seed = await fs.readFile('./data/sector_averages_2026.json', 'utf8');
      sectorData = { ...sectorData, ...(JSON.parse(seed || '{}')) };
    } catch (_) {}
    try {
      const raw = await fs.readFile('./data/sector_averages.json', 'utf8');
      sectorData = { ...sectorData, ...(JSON.parse(raw || '{}')) };
    } catch (_) {}

    // Choose which sector averages to compare against
    // Priority: explicit query sector -> inferred sector -> S&P500 fallback
    const sectorKey = sectorName || inferredSector || 'S&P500';
    const sectorAvg = sectorData && (
      sectorData[sectorKey]
      || sectorData[String(sectorKey).replace(/\s+/g,'')]
      || sectorData['S&P500']
      || sectorData['SP500']
    );
    // Historical averages: prefer explicit historical sector values if present
    const histAvg = sectorData && (sectorData[sectorKey]?.histForwardPE ? sectorData[sectorKey] : sectorAvg);

    // Prefer cached stock historical averages written by the periodic aggregator
    // Treat entries with an expiresAt in the past as expired and fall back to live fetch
    let stockHist = {};
    let historicalMap = {};
    try {
      const raw = await fs.readFile('./data/stock_historical.json', 'utf8');
      historicalMap = JSON.parse(raw || '{}');
      const entry = historicalMap[symbol];
      if (entry) {
        const now = Date.now();
        const expiresAt = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
        if (!expiresAt || expiresAt > now) {
          // Prefer 5-year averages when available; fall back to 3-year.
          stockHist = {
            forwardPE: entry.avg5 ?? entry.avg3 ?? null,
            fcfMargin: entry.avg5_fcfMargin ?? entry.avg3_fcfMargin ?? null,
            evEbitda: entry.avg5_evEbitda ?? entry.avg3_evEbitda ?? null,
            stockHistWindow: {
              forwardPE: entry.avg5 != null ? '5yr' : (entry.avg3 != null ? '3yr' : null),
              fcfMargin: entry.avg5_fcfMargin != null ? '5yr' : (entry.avg3_fcfMargin != null ? '3yr' : null),
              evEbitda: entry.avg5_evEbitda != null ? '5yr' : (entry.avg3_evEbitda != null ? '3yr' : null)
            },
            _source: 'cache'
          };
        } else {
          // expired — drop to allow fallback fetch
          stockHist = { forwardPE: null, fcfMargin: null, evEbitda: null };
        }
      }
    } catch (e) {
      // ignore — will attempt FMP below if API key available
      historicalMap = {};
    }

    // Fallback 1: if cached stock historicals are missing, use local yfinance trailing service and persist
    if (stockHist.forwardPE == null || stockHist.evEbitda == null || stockHist.fcfMargin == null) {
      try {
        const yr = await fetch(`${YFINANCE_SERVICE_URL}/trailing/${encodeURIComponent(symbol)}?years=5`, { timeout: 10000 });
        if (yr.ok) {
          const yj = await yr.json();
          const avg3 = Number(yj.avg3_pe);
          const avg5 = Number(yj.avg5_pe);
          const avg3FcfMargin = Number(yj.avg3_fcfMargin);
          const avg3Ev = Number(yj.avg3_evEbitda);
          const avg5FcfMargin = Number(yj.avg5_fcfMargin);
          const avg5Ev = Number(yj.avg5_evEbitda);

          if (Number.isFinite(avg5)) {
            stockHist.forwardPE = avg5;
            stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), forwardPE: '5yr' };
          } else if (Number.isFinite(avg3)) {
            stockHist.forwardPE = avg3;
            stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), forwardPE: '3yr' };
          }

          if (Number.isFinite(avg5FcfMargin)) {
            stockHist.fcfMargin = avg5FcfMargin;
            stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), fcfMargin: '5yr' };
          } else if (Number.isFinite(avg3FcfMargin)) {
            stockHist.fcfMargin = avg3FcfMargin;
            stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), fcfMargin: '3yr' };
          }

          if (Number.isFinite(avg5Ev)) {
            stockHist.evEbitda = avg5Ev;
            stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), evEbitda: '5yr' };
          } else if (Number.isFinite(avg3Ev)) {
            stockHist.evEbitda = avg3Ev;
            stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), evEbitda: '3yr' };
          }

          if (
            Number.isFinite(avg3) ||
            Number.isFinite(avg5) ||
            Number.isFinite(avg3FcfMargin) ||
            Number.isFinite(avg5FcfMargin) ||
            Number.isFinite(avg3Ev) ||
            Number.isFinite(avg5Ev)
          ) {
            const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
            historicalMap[symbol] = {
              ...(historicalMap[symbol] || {}),
              ...(Number.isFinite(avg3) ? { avg3 } : {}),
              ...(Number.isFinite(avg5) ? { avg5 } : {}),
              ...(Number.isFinite(avg3FcfMargin) ? { avg3_fcfMargin: avg3FcfMargin } : {}),
              ...(Number.isFinite(avg5FcfMargin) ? { avg5_fcfMargin: avg5FcfMargin } : {}),
              ...(Number.isFinite(avg3Ev) ? { avg3_evEbitda: avg3Ev } : {}),
              ...(Number.isFinite(avg5Ev) ? { avg5_evEbitda: avg5Ev } : {}),
              fetchedAt: new Date().toISOString(),
              expiresAt
            };
            try {
              await fs.writeFile('./data/stock_historical.json', JSON.stringify(historicalMap, null, 2), 'utf8');
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // Fallback 2: derive missing 3y baselines from FMP raw statements (free stable endpoints)
    if ((stockHist.forwardPE == null || stockHist.evEbitda == null || stockHist.fcfMargin == null) && process.env.FMP_API_KEY) {
      try {
        const apiKey = process.env.FMP_API_KEY;
        const [incRes, balRes, cfRes] = await Promise.all([
          fetch(`${FMP_API}/income-statement/${encodeURIComponent(symbol)}?limit=5&apikey=${apiKey}`, { timeout: 10000 }),
          fetch(`${FMP_API}/balance-sheet-statement/${encodeURIComponent(symbol)}?limit=5&apikey=${apiKey}`, { timeout: 10000 }),
          fetch(`${FMP_API}/cash-flow-statement/${encodeURIComponent(symbol)}?limit=5&apikey=${apiKey}`, { timeout: 10000 })
        ]);
        if (incRes.ok && balRes.ok && cfRes.ok) {
          const [incArrRaw, balArrRaw, cfArrRaw] = await Promise.all([incRes.json(), balRes.json(), cfRes.json()]);
          const incArr = Array.isArray(incArrRaw) ? incArrRaw : [];
          const balArr = Array.isArray(balArrRaw) ? balArrRaw : [];
          const cfArr = Array.isArray(cfArrRaw) ? cfArrRaw : [];

          const toNum = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const avg3 = (arr) => {
            const vals = (arr || []).filter((v) => v != null && Number.isFinite(v));
            if (!vals.length) return null;
            const s = vals.slice(0, 3);
            return s.reduce((a, b) => a + b, 0) / s.length;
          };
          const avg5 = (arr) => {
            const vals = (arr || []).filter((v) => v != null && Number.isFinite(v));
            if (!vals.length) return null;
            const s = vals.slice(0, 5);
            return s.reduce((a, b) => a + b, 0) / s.length;
          };

          const marketCapNow = toNum(data?.marketCap);
          const priceNow = toNum(data?.regularMarketPrice);
          const evFromData = toNum(data?.enterpriseValue);
          const latestBal = balArr[0] || {};
          const debtNow = toNum(latestBal.totalDebt ?? latestBal.shortLongTermDebtTotal ?? latestBal.totalLiabilities) || 0;
          const cashNow = toNum(latestBal.cashAndCashEquivalents ?? latestBal.cashAndShortTermInvestments) || 0;
          const evNow = evFromData != null ? evFromData : (marketCapNow != null ? (marketCapNow + debtNow - cashNow) : null);

          const peVals = incArr.map((row) => {
            const netIncome = toNum(row?.netIncome);
            const shares = toNum(row?.weightedAverageShsOutDil ?? row?.weightedAverageShsOut ?? row?.commonStockSharesOutstanding);
            if (priceNow == null || netIncome == null || shares == null || shares <= 0) return null;
            const eps = netIncome / shares;
            if (!Number.isFinite(eps) || eps <= 0) return null;
            return priceNow / eps;
          });

          const evEbitdaVals = incArr.map((row) => {
            const ebitda = toNum(row?.ebitda);
            if (evNow == null || ebitda == null || ebitda <= 0) return null;
            return evNow / ebitda;
          });

          const fcfMarginVals = cfArr.map((row, idx) => {
            const fcf = toNum(row?.freeCashFlow);
            const incRow = incArr[idx] || {};
            const revenue = toNum(incRow?.revenue ?? incRow?.totalRevenue);
            if (revenue == null || revenue === 0 || fcf == null) return null;
            return fcf / revenue;
          });

          const peAvg3 = avg3(peVals);
          const peAvg5 = avg5(peVals);
          const evAvg3 = avg3(evEbitdaVals);
          const evAvg5 = avg5(evEbitdaVals);
          const fcfMarginAvg3 = avg3(fcfMarginVals);
          const fcfMarginAvg5 = avg5(fcfMarginVals);

          if (stockHist.forwardPE == null) {
            if (peAvg5 != null) {
              stockHist.forwardPE = peAvg5;
              stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), forwardPE: '5yr' };
            } else if (peAvg3 != null) {
              stockHist.forwardPE = peAvg3;
              stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), forwardPE: '3yr' };
            }
          }
          if (stockHist.evEbitda == null) {
            if (evAvg5 != null) {
              stockHist.evEbitda = evAvg5;
              stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), evEbitda: '5yr' };
            } else if (evAvg3 != null) {
              stockHist.evEbitda = evAvg3;
              stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), evEbitda: '3yr' };
            }
          }
          if (stockHist.fcfMargin == null) {
            if (fcfMarginAvg5 != null) {
              stockHist.fcfMargin = fcfMarginAvg5;
              stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), fcfMargin: '5yr' };
            } else if (fcfMarginAvg3 != null) {
              stockHist.fcfMargin = fcfMarginAvg3;
              stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), fcfMargin: '3yr' };
            }
          }

          if (
            peAvg3 != null || peAvg5 != null ||
            evAvg3 != null || evAvg5 != null ||
            fcfMarginAvg3 != null || fcfMarginAvg5 != null
          ) {
            const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
            historicalMap[symbol] = {
              ...(historicalMap[symbol] || {}),
              ...(peAvg3 != null ? { avg3: Number(peAvg3) } : {}),
              ...(peAvg5 != null ? { avg5: Number(peAvg5) } : {}),
              ...(evAvg3 != null ? { avg3_evEbitda: Number(evAvg3) } : {}),
              ...(evAvg5 != null ? { avg5_evEbitda: Number(evAvg5) } : {}),
              ...(fcfMarginAvg3 != null ? { avg3_fcfMargin: Number(fcfMarginAvg3) } : {}),
              ...(fcfMarginAvg5 != null ? { avg5_fcfMargin: Number(fcfMarginAvg5) } : {}),
              fetchedAt: new Date().toISOString(),
              expiresAt
            };
            try {
              await fs.writeFile('./data/stock_historical.json', JSON.stringify(historicalMap, null, 2), 'utf8');
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // Fallback 3: if still missing forwardPE and FMP key exists, try FMP ratios and persist
    if ((stockHist.forwardPE == null) && process.env.FMP_API_KEY) {
      try {
        const apiKey = process.env.FMP_API_KEY;
        const url = `${FMP_API}/ratios/${encodeURIComponent(symbol)}?period=annual&limit=10&apikey=${apiKey}`;
        const r = await fetch(url, { timeout: 10000 });
        if (!r.ok) {
          let txt = null;
          try { txt = await r.text(); } catch (e) { txt = String(e.message || e); }
          console.warn('FMP ratios fallback failed for', symbol, 'status', r.status, 'body:', txt);
        } else {
          try {
            const arr = await r.json();
            if (Array.isArray(arr) && arr.length > 0) {
              const peVals = arr.map(o => (o.forwardPE ?? o.pe ?? o.priceEarningsRatio ?? o.peTTM)).filter(v => v != null).map(Number);
              if (peVals.length > 0) {
                // avg3: mean of most recent 3 annual values (prefer recent 3)
                const last3 = peVals.slice(0,3);
                const last5 = peVals.slice(0,5);
                const avg3 = last3.length > 0 ? (last3.reduce((a,b)=>a+b,0)/last3.length) : (peVals.reduce((a,b)=>a+b,0)/peVals.length);
                const avg5 = last5.length > 0 ? (last5.reduce((a,b)=>a+b,0)/last5.length) : avg3;
                stockHist.forwardPE = avg5;
                stockHist.stockHistWindow = { ...(stockHist.stockHistWindow || {}), forwardPE: '5yr' };

                // Persist into historicalMap with an expiration 2 months from now (approx 60 days)
                const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
                historicalMap[symbol] = {
                  ...(Number.isFinite(avg3) ? { avg3: Number(avg3) } : {}),
                  ...(Number.isFinite(avg5) ? { avg5: Number(avg5) } : {}),
                  fetchedAt: new Date().toISOString(),
                  expiresAt
                };
                try {
                  await fs.writeFile('./data/stock_historical.json', JSON.stringify(historicalMap, null, 2), 'utf8');
                } catch (writeErr) {
                  // ignore write failures (best-effort)
                }
              }
            }
          } catch (e) {
            let txt = null;
            try { txt = await r.text(); } catch (_) { txt = null; }
            console.warn('FMP ratios JSON parse failed for', symbol, e.message || e, 'body:', txt);
          }
        }
      } catch (e) {
        // ignore failures
      }
    }

    const comparisons = {};
    if (metrics.forwardPE != null) {
      const master = chooseMasterMetric(metrics.forwardPE, metrics.peg);
      const histForward = histAvg?.histForwardPE ?? histAvg?.forwardPE ?? null;
      const sectorForward = sectorAvg?.forwardPE ?? null;
      const sent = dualBaselineSentiment(metrics.forwardPE, sectorForward, stockHist?.forwardPE ?? null, 'valuation');
      const baseline = stockHist?.forwardPE ?? null;
      comparisons.forwardPE = {
        value: metrics.forwardPE,
        sectorAvg: sectorForward,
        histSectorAvg: histForward,
        stockHistAvg: stockHist?.forwardPE ?? null,
        stockHistWindow: stockHist?.stockHistWindow?.forwardPE || null,
        sentiment: sent,
        emoji: sentimentEmoji(sent),
        masterMetric: master,
        deviationPct: (baseline != null && baseline !== 0) ? deviationPercent(metrics.forwardPE, baseline) : null,
        deviationFromStockHistPct: (stockHist?.forwardPE != null && stockHist.forwardPE !== 0) ? deviationPercent(metrics.forwardPE, stockHist.forwardPE) : null
      };
    }
    if (metrics.peg != null) {
      const histPeg = histAvg?.peg ?? null;
      const sectorPeg = sectorAvg?.peg ?? null;
      const sent = computeSentimentFlexible(metrics.peg, sectorPeg, histPeg, 'valuation');
      const baseline = histPeg ?? sectorPeg ?? null;
      comparisons.peg = {
        value: metrics.peg,
        sectorAvg: sectorPeg,
        histAvg: histPeg,
        sentiment: sent,
        emoji: sentimentEmoji(sent),
        deviationPct: (baseline != null && baseline !== 0) ? deviationPercent(metrics.peg, baseline) : null
      };
    }
    if (metrics.evEbitda != null) {
      const histVal = histAvg?.evEbitda ?? null;
      const sectorVal = sectorAvg?.evEbitda ?? null;
      const sent = dualBaselineSentiment(metrics.evEbitda, sectorVal, stockHist?.evEbitda ?? null, 'valuation');
      const baseline = stockHist?.evEbitda ?? null;
      comparisons.evEbitda = {
        value: metrics.evEbitda,
        sectorAvg: sectorVal,
        histAvg: histVal,
        sentiment: sent,
        emoji: sentimentEmoji(sent),
        deviationPct: (baseline != null && baseline !== 0) ? deviationPercent(metrics.evEbitda, baseline) : null,
        stockHistAvg: stockHist?.evEbitda ?? null,
        stockHistWindow: stockHist?.stockHistWindow?.evEbitda || null,
        deviationFromStockHistPct: (stockHist?.evEbitda != null && stockHist.evEbitda !== 0) ? deviationPercent(metrics.evEbitda, stockHist.evEbitda) : null
      };
    }
    if (metrics.fcfMargin != null) {
      const histVal = histAvg?.fcfMargin ?? null;
      const sectorVal = sectorAvg?.fcfMargin ?? null;
      const sent = dualBaselineSentiment(metrics.fcfMargin, sectorVal, stockHist?.fcfMargin ?? null, 'efficiency');
      const baseline = stockHist?.fcfMargin ?? null;
      comparisons.fcfMargin = {
        value: metrics.fcfMargin,
        sectorAvg: sectorVal,
        histAvg: histVal,
        sentiment: sent,
        emoji: sentimentEmoji(sent),
        deviationPct: (baseline != null && baseline !== 0) ? deviationPercent(metrics.fcfMargin, baseline) : null,
        stockHistAvg: stockHist?.fcfMargin ?? null,
        stockHistWindow: stockHist?.stockHistWindow?.fcfMargin || null,
        deviationFromStockHistPct: (stockHist?.fcfMargin != null && stockHist.fcfMargin !== 0) ? deviationPercent(metrics.fcfMargin, stockHist.fcfMargin) : null
      };
    }

    // Ensure expected comparison keys exist so client UI can render consistently
    const ensureKey = (key, def) => { if (!Object.prototype.hasOwnProperty.call(comparisons, key)) comparisons[key] = def; };
    ensureKey('forwardPE', {
      value: metrics.forwardPE ?? null,
      sectorAvg: sectorAvg?.forwardPE ?? null,
      histSectorAvg: histAvg?.histForwardPE ?? histAvg?.forwardPE ?? null,
      stockHistAvg: stockHist?.forwardPE ?? null,
      sentiment: 'AVERAGE',
      emoji: sentimentEmoji('AVERAGE'),
      masterMetric: chooseMasterMetric(metrics.forwardPE, metrics.peg),
      deviationPct: null,
      deviationFromStockHistPct: null
    });
    ensureKey('peg', {
      value: metrics.peg ?? null,
      sectorAvg: sectorAvg?.peg ?? null,
      histAvg: histAvg?.peg ?? null,
      sentiment: 'AVERAGE',
      emoji: sentimentEmoji('AVERAGE'),
      deviationPct: null
    });
    ensureKey('evEbitda', {
      value: metrics.evEbitda ?? null,
      sectorAvg: sectorAvg?.evEbitda ?? null,
      histAvg: histAvg?.evEbitda ?? null,
      stockHistAvg: stockHist?.evEbitda ?? null,
      sentiment: 'AVERAGE',
      emoji: sentimentEmoji('AVERAGE'),
      deviationPct: null,
      deviationFromStockHistPct: null
    });
    ensureKey('fcfMargin', {
      value: metrics.fcfMargin ?? null,
      sectorAvg: sectorAvg?.fcfMargin ?? null,
      histAvg: histAvg?.fcfMargin ?? null,
      stockHistAvg: stockHist?.fcfMargin ?? null,
      sentiment: 'AVERAGE',
      emoji: sentimentEmoji('AVERAGE'),
      deviationPct: null,
      deviationFromStockHistPct: null
    });

    res.json({ symbol, sector: sectorKey, comparisons });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to compare metrics' });
  }
});

// ----- Social / Stocktwits proxy endpoints -----
function getStocktwitsAuth(req) {
  const token = String(process.env.STOCKTWITS_TOKEN || stocktwitsDefaultAuth.token || req.query.token || '').trim();
  if (token) {
    return {
      querySuffix: `access_token=${encodeURIComponent(token)}`,
      headers: {}
    };
  }

  const basicFromHeader = String(req.get('authorization') || '').trim();
  const basicB64 = String(process.env.STOCKTWITS_BASIC_B64 || req.query.basic || '').trim();
  const defaultBasic = String(stocktwitsDefaultAuth.basicHeader || '').trim();
  const user = String(process.env.STOCKTWITS_USERNAME || stocktwitsDefaultAuth.username || '').trim();
  const pass = String(process.env.STOCKTWITS_PASSWORD || stocktwitsDefaultAuth.password || '').trim();

  if (basicFromHeader.toLowerCase().startsWith('basic ')) {
    return { querySuffix: '', headers: { Authorization: basicFromHeader } };
  }
  if (defaultBasic.toLowerCase().startsWith('basic ')) {
    return { querySuffix: '', headers: { Authorization: defaultBasic } };
  }
  if (basicB64) {
    return { querySuffix: '', headers: { Authorization: `Basic ${basicB64}` } };
  }
  if (user && pass) {
    const b64 = Buffer.from(`${user}:${pass}`).toString('base64');
    return { querySuffix: '', headers: { Authorization: `Basic ${b64}` } };
  }
  return null;
}

function getStocktwitsBasicHeader(req) {
  const headerAuth = String(req.get('authorization') || '').trim();
  if (headerAuth.toLowerCase().startsWith('basic ')) return headerAuth;

  const defaultBasic = String(stocktwitsDefaultAuth.basicHeader || '').trim();
  if (defaultBasic.toLowerCase().startsWith('basic ')) return defaultBasic;

  const username = String(process.env.STOCKTWITS_USERNAME || stocktwitsDefaultAuth.username || req.query.username || '').trim();
  const password = String(process.env.STOCKTWITS_PASSWORD || stocktwitsDefaultAuth.password || req.query.password || '').trim();
  if (!username || !password) return null;

  const authHeader = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${authHeader}`;
}

function getStocktwitsGatewayClient(req) {
  const authorization = getStocktwitsBasicHeader(req);
  if (!authorization) return null;
  return axios.create({
    baseURL: STOCKTWITS_GATEWAY_BASE_URL,
    timeout: STOCKTWITS_GATEWAY_TIMEOUT_MS,
    headers: {
      Authorization: authorization,
      'User-Agent': process.env.STOCKTWITS_USER_AGENT || 'MyStockTracker/1.0'
    }
  });
}

function getGatewayErrorMessage(error) {
  if (error?.response?.data?.error) return String(error.response.data.error);
  if (error?.response?.statusText) return String(error.response.statusText);
  return String(error?.message || error);
}

function firstFinite(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeYahooMarketState(state) {
  return String(state || '').trim().toUpperCase();
}

function normalizeYahooQuoteType(type) {
  return String(type || '').trim().toUpperCase();
}

function resolveYahooMarketSession({ marketState, quoteType, extendedPrice }) {
  const normalizedState = normalizeYahooMarketState(marketState);
  const normalizedType = normalizeYahooQuoteType(quoteType);

  if (normalizedType === 'CRYPTOCURRENCY') return 'regular';
  if (normalizedState === 'REGULAR') return 'regular';
  if (extendedPrice == null) return 'regular';
  if (['PRE', 'PREPRE', 'POST', 'POSTPOST', 'CLOSED'].includes(normalizedState)) return 'extended';
  return 'extended';
}

function getQuoteSessionLabel({ marketSession, quoteType }) {
  const normalizedType = normalizeYahooQuoteType(quoteType);
  if (marketSession === 'extended') return 'After Hours';
  if (normalizedType === 'CRYPTOCURRENCY') return 'Live';
  return 'Market';
}

function findFirstUrl(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/url|image/i.test(k)) {
        const found = findFirstUrl(v);
        if (found) return found;
      }
    }
    for (const v of Object.values(value)) {
      const found = findFirstUrl(v);
      if (found) return found;
    }
  }
  return null;
}

function sentimentThumbLabel(score) {
  if (!Number.isFinite(score)) return '➡️ Neutral';
  if (score > 60) return '👍 Bullish Crowd';
  if (score < 40) return '👎 Bearish Crowd';
  return '➡️ Neutral';
}

const quoteProviderStats = {
  yf2: { totalMs: 0, count: 0 },
  py: { totalMs: 0, count: 0 }
};

function getProviderAvgMs(provider) {
  const s = quoteProviderStats[provider];
  if (!s || s.count <= 0) return Number.POSITIVE_INFINITY;
  return s.totalMs / s.count;
}

function trackProviderMs(provider, elapsedMs) {
  const s = quoteProviderStats[provider];
  if (!s || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  s.totalMs += elapsedMs;
  s.count += 1;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function fetchYahooFinance2Quote(symbol) {
  const yahooSymbol = normalizeSymbolForYahoo(symbol);
  const quote = await withTimeout(yahooFinanceClient.quote(yahooSymbol), 7000, 'yahoo-finance2 quote');

  const regular = firstPositiveFinite(quote.regularMarketPrice, quote.regularMarketOpen);
  const extended = firstPositiveFinite(quote.postMarketPrice, quote.preMarketPrice);
  const extendedPct = firstFinite(quote.postMarketChangePercent, quote.preMarketChangePercent);
  const prevClose = firstPositiveFinite(quote.regularMarketPreviousClose, quote.previousClose);
  const marketState = normalizeYahooMarketState(quote.marketState);
  const quoteType = normalizeYahooQuoteType(quote.quoteType);
  const marketSession = resolveYahooMarketSession({ marketState, quoteType, extendedPrice: extended });

  const price = marketSession === 'extended' && extended != null ? extended : regular;
  const change = (price != null && prevClose != null) ? price - prevClose : null;
  const changePct = (change != null && prevClose != null) ? (change / prevClose) * 100 : null;
  const regularChange = (regular != null && prevClose != null) ? regular - prevClose : null;
  const regularChangePct = (regularChange != null && prevClose != null) ? (regularChange / prevClose) * 100 : null;
  const extendedChangePct = (extended != null && regular != null && regular !== 0)
    ? ((extended - regular) / regular) * 100
    : (extendedPct != null ? extendedPct : null);

  return {
    price,
    regularPrice: regular,
    extendedPrice: extended,
    marketState,
    quoteType,
    marketSession,
    change,
    changePct,
    prevClose,
    regularChangePct,
    extendedChangePct,
    source: 'yahoo-finance2'
  };
}

async function fetchPythonYFinanceProxyQuote(symbol) {
  const yahooSymbol = normalizeSymbolForYahoo(symbol);
  const r = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent(yahooSymbol)}`, { timeout: 8000 });
  if (!r.ok) throw new Error(`yfinance proxy quote HTTP ${r.status}`);
  const quote = await r.json();

  const regular = firstPositiveFinite(quote.regularMarketPrice);
  const extended = firstPositiveFinite(quote.postMarketPrice, quote.preMarketPrice);
  const extendedPct = firstFinite(quote.postMarketChangePercent, quote.preMarketChangePercent);
  const prevClose = firstPositiveFinite(quote.regularMarketPreviousClose);
  const marketState = normalizeYahooMarketState(quote.marketState);
  const quoteType = normalizeYahooQuoteType(quote.quoteType);
  const marketSession = resolveYahooMarketSession({ marketState, quoteType, extendedPrice: extended });

  const price = marketSession === 'extended' && extended != null ? extended : regular;
  const change = (price != null && prevClose != null) ? price - prevClose : null;
  const changePct = (change != null && prevClose != null) ? (change / prevClose) * 100 : null;
  const regularChange = (regular != null && prevClose != null) ? regular - prevClose : null;
  const regularChangePct = (regularChange != null && prevClose != null) ? (regularChange / prevClose) * 100 : null;
  const extendedChangePct = (extended != null && regular != null && regular !== 0)
    ? ((extended - regular) / regular) * 100
    : (extendedPct != null ? extendedPct : null);

  return {
    price,
    regularPrice: regular,
    extendedPrice: extended,
    marketState,
    quoteType,
    marketSession,
    change,
    changePct,
    prevClose,
    regularChangePct,
    extendedChangePct,
    source: 'yfinance-proxy'
  };
}

async function fetchYahooProxyQuote(symbol) {
  const providers = [
    { key: 'yf2', fn: fetchYahooFinance2Quote },
    { key: 'py', fn: fetchPythonYFinanceProxyQuote }
  ];
  providers.sort((a, b) => getProviderAvgMs(a.key) - getProviderAvgMs(b.key));

  let lastErr = null;
  for (const p of providers) {
    const started = Date.now();
    try {
      const out = await p.fn(symbol);
      trackProviderMs(p.key, Date.now() - started);
      return out;
    } catch (err) {
      trackProviderMs(p.key, Date.now() - started);
      lastErr = err;
    }
  }
  throw lastErr || new Error('Quote providers unavailable');
}

async function computeTickerSessionFields(ticker, quoteData) {
  const localRegular = firstPositiveFinite(quoteData?.price?.regularMarketPrice?.raw);
  const localPrevClose = firstPositiveFinite(quoteData?.price?.previousClose?.raw);
  const localExtended = firstPositiveFinite(
    quoteData?.price?.postMarketPrice?.raw,
    quoteData?.price?.preMarketPrice?.raw,
    quoteData?.price?.extendedPrice?.raw
  );
  let marketState = normalizeYahooMarketState(quoteData?.price?.marketState?.raw || quoteData?.price?.marketState);
  let quoteType = normalizeYahooQuoteType(quoteData?.price?.quoteType?.raw || quoteData?.price?.quoteType);

  let regularPrice = localRegular;
  let prevClose = localPrevClose;
  let extendedPrice = localExtended;

  // Enrich with proxy quote so searched tickers can consistently show after-hours.
  try {
    const proxy = await fetchYahooProxyQuote(ticker);
    regularPrice = firstPositiveFinite(regularPrice, proxy.regularPrice);
    prevClose = firstPositiveFinite(prevClose, proxy.prevClose);
    extendedPrice = firstPositiveFinite(extendedPrice, proxy.extendedPrice);
    marketState = normalizeYahooMarketState(marketState || proxy.marketState);
    quoteType = normalizeYahooQuoteType(quoteType || proxy.quoteType);
  } catch (_) {
    // Best effort only.
  }

  const regularChangePct = (regularPrice != null && prevClose != null && prevClose !== 0)
    ? ((regularPrice - prevClose) / prevClose) * 100
    : null;
  const extendedChangePct = (extendedPrice != null && regularPrice != null && regularPrice !== 0)
    ? ((extendedPrice - regularPrice) / regularPrice) * 100
    : null;

  const marketSession = resolveYahooMarketSession({ marketState, quoteType, extendedPrice });

  return {
    regularPrice,
    prevClose,
    extendedPrice,
    regularChangePct,
    extendedChangePct,
    marketState,
    quoteType,
    marketSession
  };
}

const stocktwitsPublicApi = axios.create({
  baseURL: STOCKTWITS_PUBLIC_BASE_URL,
  timeout: 5000,
  headers: {
    'User-Agent': process.env.STOCKTWITS_USER_AGENT || 'MyStockTracker/1.0'
  }
});

async function fetchStocktwitsPublicJson(path, req) {
  const token = String(process.env.STOCKTWITS_TOKEN || stocktwitsDefaultAuth.token || req?.query?.token || '').trim();
  const params = token ? { access_token: token } : undefined;
  try {
    const response = await stocktwitsPublicApi.get(path, { params });
    return { ok: true, status: response.status, body: response.data, raw: null };
  } catch (error) {
    return {
      ok: false,
      status: error?.response?.status || 502,
      body: error?.response?.data || null,
      raw: String(error?.message || error)
    };
  }
}

function normalizeTrendingSnapshot(snapshot) {
  const symbols = Array.isArray(snapshot?.symbols) ? snapshot.symbols.slice(0, 10) : [];
  return {
    symbols,
    fetchedAt: snapshot?.fetchedAt || null,
    source: snapshot?.source || 'cache'
  };
}

async function loadTrendingSnapshotFromDisk() {
  try {
    const raw = await fs.readFile(TRENDING_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    trendingCache = normalizeTrendingSnapshot(parsed);
  } catch (_) {
    // No persisted snapshot yet, keep bootstrap cache.
  }
  return trendingCache;
}

async function buildTrendingSnapshot() {
  const out = await fetchStocktwitsPublicJson('/trending/symbols.json');
  if (!out.ok) {
    const details = String(out.raw || out.body?.error || 'Stocktwits trending fetch failed').slice(0, 240);
    throw new Error(`Trending fetch failed (${out.status}): ${details}`);
  }

  const symbols = Array.isArray(out.body?.symbols) ? out.body.symbols : [];
  const topTrending = symbols.slice(0, 10);
  const quoteResults = await Promise.all(
    topTrending.map((s) => fetchYahooProxyQuote(s.symbol).catch(() => null))
  );

  const enhancedSymbols = topTrending.map((s, idx) => {
    const quote = quoteResults[idx];
    const regularChangePct = firstFinite(quote?.regularChangePct, quote?.changePct);
    const extendedChangePct = firstFinite(quote?.extendedChangePct);
    const isAfterHours = quote?.marketSession === 'extended' && quote?.extendedPrice != null;
    const displayChangePct = isAfterHours ? extendedChangePct : regularChangePct;
    let direction = 'neutral';
    let arrow = '●';

    if (displayChangePct != null) {
      if (displayChangePct > 0) {
        direction = 'bullish';
        arrow = '▲';
      } else if (displayChangePct < 0) {
        direction = 'bearish';
        arrow = '▼';
      }
    }

    const displayPrice = isAfterHours ? quote?.extendedPrice : firstFinite(quote?.regularPrice, quote?.price);

    return {
      ...s,
      direction,
      arrow,
      quoteType: quote?.quoteType || null,
      marketState: quote?.marketState || null,
      regularPrice: firstFinite(quote?.regularPrice),
      extendedPrice: firstFinite(quote?.extendedPrice),
      displayPrice,
      displaySession: getQuoteSessionLabel({ marketSession: quote?.marketSession, quoteType: quote?.quoteType }),
      regularChangePct,
      extendedChangePct,
      displayChangePct,
      lastUpdated: new Date().toISOString()
    };
  });

  return normalizeTrendingSnapshot({
    symbols: enhancedSymbols,
    fetchedAt: new Date().toISOString(),
    source: 'stocktwits+yfinance-proxy'
  });
}

async function updateTrendingCache() {
  if (trendingUpdatePromise) return trendingUpdatePromise;

  trendingUpdatePromise = (async () => {
    try {
      const snapshot = await buildTrendingSnapshot();
      await fs.writeFile(TRENDING_JSON_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
      trendingCache = snapshot;
      console.log(`Trending snapshot updated (${snapshot.symbols.length} symbols) at ${snapshot.fetchedAt}`);
      return snapshot;
    } catch (error) {
      console.error(`Trending snapshot update failed: ${error?.message || error}`);
      return trendingCache;
    } finally {
      trendingUpdatePromise = null;
    }
  })();

  return trendingUpdatePromise;
}

function startTrendingPoller() {
  if (trendingPollTimer) clearInterval(trendingPollTimer);
  trendingPollTimer = setInterval(() => {
    updateTrendingCache().catch(() => {});
  }, TRENDING_POLL_INTERVAL_MS);
}

function getTrendingSnapshot() {
  return normalizeTrendingSnapshot(trendingCache);
}

function serializeForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function summarizeStocktwitsMessages(messages, sampleSize = 8) {
  const rows = Array.isArray(messages) ? messages : [];
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  const sample = [];

  for (const m of rows) {
    const basic = m?.entities?.sentiment?.basic ? String(m.entities.sentiment.basic) : null;
    const sentiment = basic ? basic.toLowerCase() : null;
    if (sentiment === 'bullish') bullish += 1;
    else if (sentiment === 'bearish') bearish += 1;
    else neutral += 1;
    if (sample.length < sampleSize) {
      sample.push({
        id: m?.id,
        user: m?.user?.username || null,
        body: m?.body || '',
        created_at: m?.created_at || null,
        sentiment: basic || null
      });
    }
  }

  const labeled = bullish + bearish;
  const ratio = labeled > 0 ? (bullish / labeled) * 100 : null;
  return {
    bullish,
    bearish,
    neutral,
    totalMessages: rows.length,
    ratio,
    sample
  };
}

async function fetchStocktwitsJson(path, auth) {
  const joiner = auth.querySuffix ? '?' : '';
  const url = `https://api.stocktwits.com/api/2/${path}${joiner}${auth.querySuffix || ''}`;
  const r = await fetch(url, { timeout: 10000, headers: auth.headers || {} });
  const text = await r.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = null;
  }
  return { ok: r.ok, status: r.status, body: parsed, raw: text };
}

app.post('/api/social/auth', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const token = String(req.body?.token || '').trim();

  stocktwitsDefaultAuth = {
    username,
    password,
    token,
    basicHeader: username && password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      : ''
  };

  return res.json({
    ok: true,
    hasBasicAuth: Boolean(stocktwitsDefaultAuth.basicHeader),
    hasToken: Boolean(stocktwitsDefaultAuth.token)
  });
});

app.delete('/api/social/auth', (_req, res) => {
  stocktwitsDefaultAuth = { username: '', password: '', token: '', basicHeader: '' };
  return res.json({ ok: true });
});

app.get('/api/social/auth/status', (_req, res) => {
  return res.json({
    hasEnvBasicAuth: Boolean(process.env.STOCKTWITS_USERNAME && process.env.STOCKTWITS_PASSWORD),
    hasEnvToken: Boolean(process.env.STOCKTWITS_TOKEN),
    hasDefaultBasicAuth: Boolean(stocktwitsDefaultAuth.basicHeader),
    hasDefaultToken: Boolean(stocktwitsDefaultAuth.token)
  });
});

app.get('/api/trending', async (req, res) => {
  if (req.query.refresh === '1') {
    await updateTrendingCache();
  }
  return res.json(getTrendingSnapshot());
});

app.get('/api/social/trending', async (req, res) => {
  try {
    // Fetch trending symbols from Stocktwits (conversation volume).
    const out = await fetchStocktwitsPublicJson('/trending/symbols.json', req);
    if (!out.ok) {
      return res.status(out.status).json({
        error: out?.body?.error || 'Stocktwits trending fetch failed',
        details: String(out.raw || '').slice(0, 300)
      });
    }

    const symbols = Array.isArray(out.body?.symbols) ? out.body.symbols : [];

    // Enrich top symbols with market pricing so chip color is based on price move,
    // not social sentiment.
    const topTrending = symbols.slice(0, 10);
    const quotePromises = topTrending.map((s) =>
      fetchYahooProxyQuote(s.symbol).catch(() => null)
    );

    const quoteResults = await Promise.all(quotePromises);

    const enhancedSymbols = topTrending.map((s, idx) => {
      const quote = quoteResults[idx];
      const regularChangePct = firstFinite(quote?.regularChangePct, quote?.changePct);
      const extendedChangePct = firstFinite(quote?.extendedChangePct);
      const isAfterHours = quote?.marketSession === 'extended' && quote?.extendedPrice != null;
      const displayChangePct = isAfterHours ? extendedChangePct : regularChangePct;
      let direction = 'neutral';
      let arrow = '●';

      // Color/direction should match the same session shown in the chip.
      if (displayChangePct != null) {
        if (displayChangePct > 0) {
          direction = 'bullish';
          arrow = '▲';
        } else if (displayChangePct < 0) {
          direction = 'bearish';
          arrow = '▼';
        }
      }

      const displayPrice = isAfterHours ? quote.extendedPrice : firstFinite(quote?.regularPrice, quote?.price);

      return {
        ...s,
        direction,
        arrow,
        quoteType: quote?.quoteType || null,
        marketState: quote?.marketState || null,
        regularPrice: firstFinite(quote?.regularPrice),
        extendedPrice: firstFinite(quote?.extendedPrice),
        displayPrice,
        displaySession: getQuoteSessionLabel({ marketSession: quote?.marketSession, quoteType: quote?.quoteType }),
        regularChangePct,
        extendedChangePct,
        displayChangePct
      };
    });

    const remaining = symbols.slice(10).map(s => ({
      ...s,
      direction: 'neutral',
      arrow: '●'
    }));

    return res.json({
      ...out.body,
      symbols: [...enhancedSymbols, ...remaining]
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

app.get('/api/social/sentiment/:symbol', async (req, res) => {
  const symbol = normalizeSymbolForStocktwits((req.params.symbol || '').toString().toUpperCase());
  try {
    const out = await fetchStocktwitsPublicJson(`/streams/symbol/${encodeURIComponent(symbol)}.json`, req);
    if (!out.ok) {
      return res.status(out.status).json({
        error: out?.body?.error || 'Stocktwits stream fetch failed',
        details: String(out.raw || '').slice(0, 300)
      });
    }
    const messages = Array.isArray(out.body?.messages) ? out.body.messages : [];
    const summary = summarizeStocktwitsMessages(messages, 8);
    return res.json({
      symbol,
      bullish: summary.bullish,
      bearish: summary.bearish,
      neutral: summary.neutral,
      totalMessages: summary.totalMessages,
      score: summary.ratio == null ? null : summary.ratio / 100,
      ratio: summary.ratio,
      sample: summary.sample,
      source: 'Stocktwits Public API'
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

app.get('/api/social/sentiment-detail/:symbol', async (req, res) => {
  const symbol = normalizeSymbolForStocktwits((req.params.symbol || '').toString().toUpperCase());
  try {
    const out = await fetchStocktwitsPublicJson(`/streams/symbol/${encodeURIComponent(symbol)}.json`, req);
    if (!out.ok) {
      return res.status(out.status).json({
        error: out?.body?.error || 'Stocktwits sentiment detail fetch failed',
        details: String(out.raw || '').slice(0, 300)
      });
    }

    const messages = Array.isArray(out.body?.messages) ? out.body.messages : [];
    const summary = summarizeStocktwitsMessages(messages, 5);
    const sentimentNormalized = summary.ratio;
    const messageVolume = summary.totalMessages;
    const averageVolume = null;

    return res.json({
      symbol,
      sentimentNormalized,
      messageVolume,
      averageVolume,
      relativeVolume: (messageVolume != null && averageVolume) ? (messageVolume / averageVolume) : null,
      thumb: sentimentThumbLabel(sentimentNormalized),
      bullishCount: summary.bullish,
      bearishCount: summary.bearish,
      ratio: summary.ratio,
      sample: summary.sample,
      source: 'Stocktwits Public API',
      raw: out.body
    });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      error: 'Stocktwits sentiment detail fetch failed',
      details: getGatewayErrorMessage(error)
    });
  }
});

// Global Market "Suggested" Symbols - curated list of trending/high-interest tickers
// Uses trending symbols as they represent community-suggested high-interest picks
app.get('/api/social/suggested-symbols', async (req, res) => {
  try {
    const out = await fetchStocktwitsPublicJson('/trending/symbols.json', req);
    if (!out.ok) {
      return res.status(out.status).json({
        error: out?.body?.error || 'Stocktwits suggested symbols fetch failed',
        details: String(out.raw || '').slice(0, 300)
      });
    }
    
    const symbols = Array.isArray(out.body?.symbols) ? out.body.symbols : [];
    // Return top 10 trending symbols as "suggested"
    const result = symbols.slice(0, 10).map(s => ({
      symbol: s.symbol || '',
      name: s.title || '',
      watchlistCount: s.watchlist_count || 0,
      trendingScore: s.trending_score || 0
    }));
    
    return res.json({
      symbols: result,
      count: result.length,
      source: 'Stocktwits Public API (Trending)',
      note: 'Top trending symbols showing community-suggested picks'
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Sector Heat - Compare trending crypto vs equities
app.get('/api/social/sector-heat', async (req, res) => {
  try {
    // Fetch both crypto and equities trending symbols in parallel
    const [cryptoRes, equitiesRes] = await Promise.all([
      fetchStocktwitsPublicJson('/trending/symbols.json?class=crypto', req),
      fetchStocktwitsPublicJson('/trending/symbols.json?class=equities', req)
    ]);
    
    const getCryptoSymbols = () => {
      if (!cryptoRes.ok) return [];
      const symbols = Array.isArray(cryptoRes.body?.symbols) ? cryptoRes.body.symbols : [];
      return symbols.slice(0, 5).map(s => ({
        symbol: s.symbol || '',
        title: s.title || '',
        watchlistCount: s.watchlist_count || 0
      }));
    };
    
    const getEquitiesSymbols = () => {
      if (!equitiesRes.ok) return [];
      const symbols = Array.isArray(equitiesRes.body?.symbols) ? equitiesRes.body.symbols : [];
      return symbols.slice(0, 5).map(s => ({
        symbol: s.symbol || '',
        title: s.title || '',
        watchlistCount: s.watchlist_count || 0
      }));
    };
    
    const cryptoHeat = getCryptoSymbols();
    const stockHeat = getEquitiesSymbols();
    
    return res.json({
      cryptoHeat,
      stockHeat,
      source: 'Stocktwits Public API',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

app.get('/api/social/quote/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toString().toUpperCase();
  const stGateway = getStocktwitsGatewayClient(req);
  if (!stGateway) {
    return res.status(401).json({
      error: 'Stocktwits Basic auth missing. Set STOCKTWITS_USERNAME and STOCKTWITS_PASSWORD.'
    });
  }

  try {
    const { data } = await stGateway.get(`/symbols/${encodeURIComponent(symbol)}/quote`);
    const payload = data?.data || data || {};
    const price = firstFinite(payload.price, payload.last, payload.lastPrice, payload.regularMarketPrice);
    const extendedPrice = firstFinite(payload.extendedPrice, payload.postMarketPrice, payload.preMarketPrice);
    const extendedChangePercent = firstFinite(payload.extendedChangePercent, payload.postMarketChangePercent, payload.preMarketChangePercent);

    return res.json({
      symbol,
      price,
      extendedPrice,
      extendedChangePercent,
      source: 'Stocktwits Firestream Gateway',
      raw: data
    });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      error: 'Stocktwits quote fetch failed',
      details: getGatewayErrorMessage(error)
    });
  }
});

app.get('/api/social/analyst-ratings/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toString().toUpperCase();
  const stGateway = getStocktwitsGatewayClient(req);
  if (!stGateway) {
    return res.status(401).json({
      error: 'Stocktwits Basic auth missing. Set STOCKTWITS_USERNAME and STOCKTWITS_PASSWORD.'
    });
  }

  try {
    const { data } = await stGateway.get(`/symbols/${encodeURIComponent(symbol)}/analyst-ratings`);
    const payload = data?.data || data || {};
    const averageTarget = firstFinite(payload.averageTarget, payload.avgTarget, data?.averageTarget);

    return res.json({
      symbol,
      averageTarget,
      source: 'Stocktwits Middleware Gateway',
      raw: data
    });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      error: 'Stocktwits analyst ratings fetch failed',
      details: getGatewayErrorMessage(error)
    });
  }
});

app.get('/api/social/sentiment-chart/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toString().toUpperCase();
  const zoom = String(req.query.zoom || '1M');
  const stGateway = getStocktwitsGatewayClient(req);
  if (!stGateway) {
    return res.status(401).json({
      error: 'Stocktwits Basic auth missing. Set STOCKTWITS_USERNAME and STOCKTWITS_PASSWORD.'
    });
  }

  try {
    const { data } = await stGateway.get(`/sentiment/v2/${encodeURIComponent(symbol)}/chart`, { params: { zoom } });
    return res.json({
      symbol,
      zoom,
      staticImageUrl: findFirstUrl(data),
      source: 'Stocktwits Firestream Gateway',
      raw: data
    });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      error: 'Stocktwits sentiment chart fetch failed',
      details: getGatewayErrorMessage(error)
    });
  }
});

app.get('/api/social/sell-signal/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toString().toUpperCase();
  const stGateway = getStocktwitsGatewayClient(req);
  if (!stGateway) {
    return res.status(401).json({
      error: 'Stocktwits Basic auth missing. Set STOCKTWITS_USERNAME and STOCKTWITS_PASSWORD.'
    });
  }

  try {
    const [ratingsRes, sentimentRes, quoteRes] = await Promise.all([
      stGateway.get(`/symbols/${encodeURIComponent(symbol)}/analyst-ratings`),
      stGateway.get(`/sentiment/v2/${encodeURIComponent(symbol)}/detail`),
      stGateway.get(`/symbols/${encodeURIComponent(symbol)}/quote`)
    ]);

    const ratings = ratingsRes?.data?.data || ratingsRes?.data || {};
    const sentiment = sentimentRes?.data?.data || sentimentRes?.data || {};
    const quote = quoteRes?.data?.data || quoteRes?.data || {};

    const averageTarget = firstFinite(ratings.averageTarget, ratings.avgTarget);
    const sentimentNormalized = firstFinite(sentiment.sentimentNormalized, sentiment.sentiment);
    const currentPrice = firstFinite(
      req.query.currentPrice,
      quote.price,
      quote.last,
      quote.lastPrice,
      quote.regularMarketPrice,
      quote.extendedPrice
    );

    const strongSell = Number.isFinite(currentPrice)
      && Number.isFinite(averageTarget)
      && Number.isFinite(sentimentNormalized)
      && currentPrice > averageTarget
      && sentimentNormalized < 40;

    return res.json({
      symbol,
      currentPrice,
      averageTarget,
      sentimentNormalized,
      thumb: sentimentThumbLabel(sentimentNormalized),
      signal: strongSell ? '🚨 STRONG SELL: Overpriced + Social Fear' : 'No strong sell signal',
      strongSell,
      source: 'Stocktwits Middleware + Firestream Gateway',
      raw: {
        ratings: ratingsRes.data,
        sentiment: sentimentRes.data,
        quote: quoteRes.data
      }
    });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      error: 'Stocktwits sell signal fetch failed',
      details: getGatewayErrorMessage(error)
    });
  }
});

app.get('/api/social/premarket-overview', async (req, res) => {
  const stGateway = getStocktwitsGatewayClient(req);
  if (!stGateway) {
    return res.status(401).json({
      error: 'Stocktwits Basic auth missing. Set STOCKTWITS_USERNAME and STOCKTWITS_PASSWORD.'
    });
  }

  const symbols = String(req.query.symbols || 'SPY,QQQ,DIA')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  try {
    const rows = await Promise.all(symbols.map(async (symbol) => {
      const { data } = await stGateway.get(`/symbols/${encodeURIComponent(symbol)}/quote`);
      const payload = data?.data || data || {};
      return {
        symbol,
        price: firstFinite(payload.price, payload.last, payload.regularMarketPrice),
        extendedPrice: firstFinite(payload.extendedPrice, payload.postMarketPrice, payload.preMarketPrice),
        extendedChangePercent: firstFinite(payload.extendedChangePercent, payload.postMarketChangePercent, payload.preMarketChangePercent)
      };
    }));

    return res.json({
      symbols,
      items: rows,
      source: 'Stocktwits Firestream Gateway'
    });
  } catch (error) {
    return res.status(error?.response?.status || 502).json({
      error: 'Stocktwits premarket overview fetch failed',
      details: getGatewayErrorMessage(error)
    });
  }
});

// ── Earnings Calendar + Implied Refresh Orchestration ──────────────────────
function getFinnhubKey() {
  return String(process.env.FINNHUB_API_KEY || DEFAULT_FINNHUB_KEY).trim();
}

function toLocalMidnight(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isoDateLocal(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getMondayForDate(dateObj) {
  const d = toLocalMidnight(dateObj);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d;
}

function getTargetWeekStart(now = new Date()) {
  const saturdayCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), EARNINGS_SATURDAY_HOUR_LOCAL, 0, 0, 0);
  const day = now.getDay();
  const currentWeekMonday = getMondayForDate(now);
  const shouldSwitchToNextWeek = day === 0 || (day === 6 && now >= saturdayCutoff);
  if (!shouldSwitchToNextWeek) return currentWeekMonday;
  const nextWeekMonday = new Date(currentWeekMonday);
  nextWeekMonday.setDate(nextWeekMonday.getDate() + 7);
  return nextWeekMonday;
}

function getWeekRangeFromStart(mondayDate) {
  const from = new Date(mondayDate);
  const to = new Date(mondayDate);
  to.setDate(to.getDate() + 4);
  return { fromIso: isoDateLocal(from), toIso: isoDateLocal(to) };
}

function toHourCode(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'bmo' || v === 'amc') return v;
  return 'tbd';
}

async function loadEarningsCachesFromDisk() {
  try {
    const rawWeek = await fs.readFile(EARNINGS_WEEK_JSON_PATH, 'utf8');
    const parsedWeek = JSON.parse(rawWeek);
    if (parsedWeek && typeof parsedWeek.days === 'object') {
      weeklyEarningsCache = {
        updatedAt: Number(parsedWeek.updatedAt) || 0,
        weekStart: parsedWeek.weekStart || null,
        days: parsedWeek.days || {}
      };
    }
  } catch (_) {
    weeklyEarningsCache = { updatedAt: 0, weekStart: null, days: {} };
  }

  try {
    const rawMoves = await fs.readFile(EARNINGS_MOVES_JSON_PATH, 'utf8');
    const parsedMoves = JSON.parse(rawMoves);
    earningsMovesCache = parsedMoves && typeof parsedMoves === 'object' ? parsedMoves : {};
  } catch (_) {
    earningsMovesCache = {};
  }
}

async function saveEarningsCachesToDisk() {
  try {
    await fs.writeFile(EARNINGS_WEEK_JSON_PATH, JSON.stringify(weeklyEarningsCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[EarningsSync] Failed writing earnings_week.json:', err?.message || err);
  }
  try {
    await fs.writeFile(EARNINGS_MOVES_JSON_PATH, JSON.stringify(earningsMovesCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[EarningsSync] Failed writing earnings_moves.json:', err?.message || err);
  }
}

async function fetchFinnhubEarningsCalendar(fromIso, toIso) {
  const key = getFinnhubKey();
  if (!key) throw new Error('missing_finnhub_api_key');
  const url = `${FINNHUB_API}/calendar/earnings?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&token=${encodeURIComponent(key)}`;
  const res = await withTimeout(fetch(url), 12000, 'finnhub earnings calendar');
  const data = await res.json();
  if (!res.ok) throw new Error(`finnhub_http_${res.status}`);
  const rows = Array.isArray(data?.earningsCalendar)
    ? data.earningsCalendar
    : (Array.isArray(data?.earnings) ? data.earnings : []);
  return rows;
}

function buildIsSp500Seed() {
  const seed = new Set();
  try {
    const days = weeklyEarningsCache?.days || {};
    Object.values(days).forEach((rows) => {
      (Array.isArray(rows) ? rows : []).forEach((r) => {
        if (r?.isSp500 && r?.symbol) seed.add(String(r.symbol).toUpperCase());
      });
    });
  } catch (_) {}
  return seed;
}

function mergeMoveData(symbolUpper) {
  const move = earningsMovesCache[symbolUpper] || null;
  return {
    impliedMove: move?.impliedMove ?? null,
    avgLast4EarningsMove: Number.isFinite(Number(move?.avg4Move)) ? Number(move.avg4Move) : null,
    lastEarningsMove: Number.isFinite(Number(move?.lastMove)) ? Number(move.lastMove) : null
  };
}

async function refreshWeeklyEarningsCalendar(reason = 'job') {
  const now = new Date();
  const targetWeekStart = getTargetWeekStart(now);
  const targetWeekStartIso = isoDateLocal(targetWeekStart);
  const { fromIso, toIso } = getWeekRangeFromStart(targetWeekStart);
  const rawRows = await fetchFinnhubEarningsCalendar(fromIso, toIso);

  const priorSp500Set = buildIsSp500Seed();
  const byDay = {};
  for (const row of rawRows) {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const dateIso = String(row?.date || '').slice(0, 10);
    if (!symbol || !dateIso) continue;
    if (!byDay[dateIso]) byDay[dateIso] = [];
    const moves = mergeMoveData(symbol);
    byDay[dateIso].push({
      symbol,
      hour: toHourCode(row?.hour),
      epsEst: Number.isFinite(Number(row?.epsEstimate)) ? Number(row.epsEstimate) : null,
      revenueEst: Number.isFinite(Number(row?.revenueEstimate)) ? Number(row.revenueEstimate) : null,
      isSp500: priorSp500Set.has(symbol),
      impliedMove: moves.impliedMove,
      avgLast4EarningsMove: moves.avgLast4EarningsMove,
      lastEarningsMove: moves.lastEarningsMove
    });
  }

  Object.keys(byDay).forEach((d) => {
    byDay[d] = byDay[d].sort((a, b) => {
      const aSp = a?.isSp500 ? 1 : 0;
      const bSp = b?.isSp500 ? 1 : 0;
      if (aSp !== bSp) return bSp - aSp;
      return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
    });
  });

  weeklyEarningsCache = {
    updatedAt: Date.now(),
    weekStart: targetWeekStartIso,
    days: byDay
  };
  earningsRefreshState.lastWeeklyRefreshWeekStart = targetWeekStartIso;
  await saveEarningsCachesToDisk();
  console.log(`[EarningsSync] Weekly calendar refreshed (${reason}) for week ${targetWeekStartIso}`);
}

function findNearestByStrike(contracts, targetPrice) {
  const arr = Array.isArray(contracts) ? contracts : [];
  let best = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const c of arr) {
    const strike = Number(c?.strike);
    if (!Number.isFinite(strike)) continue;
    const diff = Math.abs(strike - targetPrice);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

function optionContractPrice(contract) {
  if (!contract) return null;
  const last = Number(contract?.lastPrice);
  if (Number.isFinite(last) && last > 0) return last;
  const bid = Number(contract?.bid);
  const ask = Number(contract?.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask >= 0) return (bid + ask) / 2;
  return null;
}

async function computeImpliedMoveForSymbol(symbol) {
  const q = await withTimeout(yahooFinanceClient.quote(symbol), 9000, 'yf quote implied');
  const currentPrice = firstPositiveFinite(q?.regularMarketPrice, q?.postMarketPrice, q?.preMarketPrice, q?.previousClose);
  if (!currentPrice) throw new Error('missing_current_price');

  const opts = await withTimeout(yahooFinanceClient.options(symbol), 12000, 'yf options implied');
  const chain = Array.isArray(opts?.options) && opts.options.length > 0 ? opts.options[0] : null;
  if (!chain) throw new Error('missing_options_chain');
  const call = findNearestByStrike(chain.calls, currentPrice);
  const put = findNearestByStrike(chain.puts, currentPrice);
  const callPrice = optionContractPrice(call);
  const putPrice = optionContractPrice(put);
  if (!Number.isFinite(callPrice) || !Number.isFinite(putPrice)) throw new Error('missing_atm_prices');

  const impliedPct = ((callPrice + putPrice) / currentPrice) * 0.85 * 100;
  if (!Number.isFinite(impliedPct) || impliedPct <= 0) throw new Error('invalid_implied_pct');
  return `±${impliedPct.toFixed(2)}%`;
}

async function refreshImpliedMovesForRemainingWeek(reason = 'job') {
  const now = new Date();
  const todayIso = isoDateLocal(now);
  const days = weeklyEarningsCache?.days || {};
  const symbols = Array.from(new Set(
    Object.keys(days)
      .filter((dateIso) => dateIso >= todayIso)
      .flatMap((dateIso) => (Array.isArray(days[dateIso]) ? days[dateIso] : []).map((r) => String(r?.symbol || '').toUpperCase()).filter(Boolean))
  ));

  let updates = 0;
  for (const symbol of symbols) {
    try {
      const impliedMove = await computeImpliedMoveForSymbol(symbol);
      const prev = earningsMovesCache[symbol] || {};
      earningsMovesCache[symbol] = {
        ...prev,
        impliedMove,
        impliedUpdatedAt: Date.now()
      };
      updates += 1;
    } catch (_) {
      // best effort for each symbol
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  Object.keys(days).forEach((dateIso) => {
    const rows = Array.isArray(days[dateIso]) ? days[dateIso] : [];
    days[dateIso] = rows.map((row) => {
      const symbol = String(row?.symbol || '').toUpperCase();
      const impliedMove = earningsMovesCache[symbol]?.impliedMove ?? row?.impliedMove ?? null;
      return { ...row, impliedMove };
    });
  });

  weeklyEarningsCache.updatedAt = Date.now();
  earningsRefreshState.lastImpliedRefreshDate = todayIso;
  await saveEarningsCachesToDisk();
  console.log(`[EarningsSync] Implied refresh (${reason}) updated ${updates} symbols for ${todayIso}`);
}

function isAfterSaturdayCutoff(now = new Date()) {
  if (now.getDay() !== 6) return now.getDay() === 0;
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), EARNINGS_SATURDAY_HOUR_LOCAL, 0, 0, 0);
  return now >= cutoff;
}

function isAfterImpliedCutoff(now = new Date()) {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), IMPLIED_REFRESH_HOUR_LOCAL, 0, 0, 0);
  return now >= cutoff;
}

async function ensureWeeklyCalendarRefreshIfDue(reason = 'job') {
  const now = new Date();
  const targetWeekStartIso = isoDateLocal(getTargetWeekStart(now));
  const shouldRefreshForWeek = isAfterSaturdayCutoff(now) && earningsRefreshState.lastWeeklyRefreshWeekStart !== targetWeekStartIso;
  if (!shouldRefreshForWeek && weeklyEarningsCache?.weekStart === targetWeekStartIso && Object.keys(weeklyEarningsCache.days || {}).length > 0) {
    return false;
  }
  if (earningsRefreshPromise) {
    await earningsRefreshPromise;
    return true;
  }
  earningsRefreshPromise = refreshWeeklyEarningsCalendar(reason)
    .catch((err) => {
      console.error('[EarningsSync] Weekly refresh failed:', err?.message || err);
      throw err;
    })
    .finally(() => {
      earningsRefreshPromise = null;
    });
  await earningsRefreshPromise;
  return true;
}

async function ensureImpliedRefreshIfDue(reason = 'job') {
  const now = new Date();
  const todayIso = isoDateLocal(now);
  if (!isAfterImpliedCutoff(now)) return false;
  if (earningsRefreshState.lastImpliedRefreshDate === todayIso) return false;
  if (impliedRefreshPromise) {
    await impliedRefreshPromise;
    return true;
  }
  impliedRefreshPromise = refreshImpliedMovesForRemainingWeek(reason)
    .catch((err) => {
      console.error('[EarningsSync] Implied refresh failed:', err?.message || err);
      throw err;
    })
    .finally(() => {
      impliedRefreshPromise = null;
    });
  await impliedRefreshPromise;
  return true;
}

async function ensureEarningsUpdatesIfDue(reason = 'job') {
  try {
    await ensureWeeklyCalendarRefreshIfDue(reason);
  } catch (_) {
    // keep serving last cache if refresh fails
  }
  try {
    await ensureImpliedRefreshIfDue(reason);
  } catch (_) {
    // implied update is best effort
  }
}

app.get('/api/earnings/week', async (_req, res) => {
  await ensureEarningsUpdatesIfDue('request');
  return res.json({
    updatedAt: weeklyEarningsCache.updatedAt || 0,
    weekStart: weeklyEarningsCache.weekStart || null,
    days: weeklyEarningsCache.days || {}
  });
});

app.post('/api/earnings/refresh-week', async (_req, res) => {
  try {
    await ensureWeeklyCalendarRefreshIfDue('request');
    return res.json({ ok: true, updatedAt: weeklyEarningsCache.updatedAt, weekStart: weeklyEarningsCache.weekStart });
  } catch (err) {
    return res.status(502).json({ error: 'weekly_refresh_failed', details: err?.message || String(err) });
  }
});

app.post('/api/earnings/implied-refresh', async (_req, res) => {
  try {
    await ensureImpliedRefreshIfDue('request');
    return res.json({ ok: true, updatedAt: weeklyEarningsCache.updatedAt, day: earningsRefreshState.lastImpliedRefreshDate });
  } catch (err) {
    return res.status(502).json({ error: 'implied_refresh_failed', details: err?.message || String(err) });
  }
});

// ── Active Options / Ticker Options (Alpha Vantage + Yahoo Finance) ─────────
const ACTIVE_OPTIONS_JSON_PATH = './data/active_options.json';
const TICKER_OPTIONS_JSON_PATH = './data/options_by_ticker.json';
const OPTIONS_CACHE_TTL_MS = 60 * 60 * 1000;
const ACTIVE_OPTIONS_TOP_SYMBOLS = 5;
const ACTIVE_OPTIONS_TOP_CONTRACTS = 15;

let activeOptionsCache = {
  updatedAt: 0,
  expiresAt: 0,
  items: [],
  baseSymbols: [],
  sourceStatus: { alphaVantage: 'degraded', yahooFinance: 'degraded' }
};
let activeOptionsRefreshPromise = null;
let tickerOptionsCache = {};
const tickerOptionsRefreshPromises = new Map();

function getAlphaVantageKey() {
  return String(process.env.ALPHA_VANTAGE_API_KEY || '').trim();
}

function isEntryFresh(entry) {
  return !!entry && Number.isFinite(Number(entry.expiresAt)) && Number(entry.expiresAt) > Date.now();
}

function normalizeActiveTicker(raw) {
  const ticker = String(raw || '').trim().toUpperCase();
  if (!ticker) return null;
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) return null;
  return ticker;
}

function isoDateOnly(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeOptionContract(contract, symbol, type, expirationDate) {
  if (!contract) return null;
  const strike = safe(contract.strike);
  const volume = safe(contract.volume);
  const lastPrice = safe(contract.lastPrice ?? contract.last ?? contract.price);
  const openInterest = safe(contract.openInterest);
  const bid = safe(contract.bid);
  const ask = safe(contract.ask);
  const impliedVolatility = safe(contract.impliedVolatility);
  return {
    symbol,
    contract: contract.contractSymbol || null,
    expirationDate,
    type,
    strike,
    lastPrice,
    bid,
    ask,
    volume,
    openInterest,
    impliedVolatility
  };
}

function formatOptionsPayload(symbol, chain, quotePrice, sourceStatus, options = {}) {
  const limit = Math.max(5, Math.min(100, Number(options.limit) || 20));
  const expirationDateRaw = chain?.expirationDate || chain?.expiration || null;
  const expirationDate = expirationDateRaw ? isoDateOnly(expirationDateRaw) : null;
  const calls = Array.isArray(chain?.calls) ? chain.calls : [];
  const puts = Array.isArray(chain?.puts) ? chain.puts : [];

  const normalizedCalls = calls
    .map((c) => normalizeOptionContract(c, symbol, 'CALL', expirationDate))
    .filter(Boolean)
    .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
    .slice(0, limit);

  const normalizedPuts = puts
    .map((p) => normalizeOptionContract(p, symbol, 'PUT', expirationDate))
    .filter(Boolean)
    .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
    .slice(0, limit);

  return {
    symbol,
    expirationDate,
    underlyingPrice: quotePrice,
    updatedAt: Date.now(),
    expiresAt: Date.now() + OPTIONS_CACHE_TTL_MS,
    sourceStatus,
    calls: normalizedCalls,
    puts: normalizedPuts
  };
}

async function loadActiveOptionsFromDisk() {
  try {
    const raw = await fs.readFile(ACTIVE_OPTIONS_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) {
      activeOptionsCache = {
        updatedAt: Number(parsed.updatedAt) || 0,
        expiresAt: Number(parsed.expiresAt) || 0,
        items: parsed.items,
        baseSymbols: Array.isArray(parsed.baseSymbols) ? parsed.baseSymbols : [],
        sourceStatus: parsed.sourceStatus || { alphaVantage: 'degraded', yahooFinance: 'degraded' }
      };
    }
  } catch (_) {
    activeOptionsCache = {
      updatedAt: 0,
      expiresAt: 0,
      items: [],
      baseSymbols: [],
      sourceStatus: { alphaVantage: 'degraded', yahooFinance: 'degraded' }
    };
  }
}

async function saveActiveOptionsToDisk() {
  try {
    await fs.writeFile(ACTIVE_OPTIONS_JSON_PATH, JSON.stringify(activeOptionsCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[OptionsActive] Save error:', err.message || err);
  }
}

async function loadTickerOptionsFromDisk() {
  try {
    const raw = await fs.readFile(TICKER_OPTIONS_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    tickerOptionsCache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    tickerOptionsCache = {};
  }
}

async function saveTickerOptionsToDisk() {
  try {
    await fs.writeFile(TICKER_OPTIONS_JSON_PATH, JSON.stringify(tickerOptionsCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[OptionsTicker] Save error:', err.message || err);
  }
}

async function fetchAlphaVantageMostActiveTickers(limit = ACTIVE_OPTIONS_TOP_SYMBOLS) {
  const apiKey = getAlphaVantageKey();
  if (!apiKey) {
    return { symbols: [], status: 'degraded', reason: 'missing_api_key' };
  }

  const url = `${ALPHA_VANTAGE_API}?function=TOP_GAINERS_LOSERS&apikey=${encodeURIComponent(apiKey)}`;
  const res = await withTimeout(fetch(url), 10000, 'alpha-vantage top-gainers-losers');
  const body = await res.json();
  if (!res.ok) return { symbols: [], status: 'degraded', reason: `http_${res.status}` };
  if (body?.['Error Message'] || body?.Information || body?.Note) {
    return { symbols: [], status: 'degraded', reason: body?.Information || body?.Note || 'api_error' };
  }

  const rawSymbols = Array.isArray(body?.most_actively_traded)
    ? body.most_actively_traded.map((row) => normalizeActiveTicker(row?.ticker)).filter(Boolean)
    : [];
  const symbols = Array.from(new Set(rawSymbols)).slice(0, limit);
  return {
    symbols,
    status: symbols.length > 0 ? 'ok' : 'degraded',
    reason: symbols.length > 0 ? null : 'empty_most_actively_traded'
  };
}

async function fetchNearestOptionsSnapshot(symbol) {
  const yahooSymbol = normalizeSymbolForYahoo(symbol);
  const [opt, yq] = await Promise.all([
    withTimeout(yahooFinanceClient.options(yahooSymbol), 10000, 'yahoo-fin options'),
    withTimeout(yahooFinanceClient.quote(yahooSymbol), 7000, 'yahoo-fin quote').catch(() => null)
  ]);

  const chain = Array.isArray(opt?.options) ? opt.options[0] : null;
  if (!chain) throw new Error('no_options_chain');
  const quotePrice = safe(yq?.regularMarketPrice) ?? safe(yq?.previousClose) ?? null;
  return { chain, quotePrice };
}

async function refreshTickerOptionsForSymbol(symbol, options = {}) {
  const normalized = String(symbol || '').toUpperCase();
  const sourceStatus = { yahooFinance: 'degraded' };
  const { chain, quotePrice } = await fetchNearestOptionsSnapshot(normalized);
  sourceStatus.yahooFinance = 'ok';
  const payload = formatOptionsPayload(normalized, chain, quotePrice, sourceStatus, options);
  tickerOptionsCache[normalized] = payload;
  await saveTickerOptionsToDisk();
  return payload;
}

function getActiveOptionsSnapshot() {
  return {
    updatedAt: activeOptionsCache.updatedAt || 0,
    expiresAt: activeOptionsCache.expiresAt || 0,
    baseSymbols: Array.isArray(activeOptionsCache.baseSymbols) ? activeOptionsCache.baseSymbols : [],
    sourceStatus: activeOptionsCache.sourceStatus || { alphaVantage: 'degraded', yahooFinance: 'degraded' },
    items: Array.isArray(activeOptionsCache.items) ? activeOptionsCache.items : []
  };
}

async function refreshActiveOptions() {
  const sourceStatus = { alphaVantage: 'degraded', yahooFinance: 'degraded' };
  const topSymbols = await fetchAlphaVantageMostActiveTickers(ACTIVE_OPTIONS_TOP_SYMBOLS);
  sourceStatus.alphaVantage = topSymbols.status;

  const symbols = topSymbols.symbols || [];
  let yahooSuccess = 0;
  const contracts = [];
  for (const symbol of symbols) {
    try {
      const { chain } = await fetchNearestOptionsSnapshot(symbol);
      const expirationDate = chain?.expirationDate ? isoDateOnly(chain.expirationDate) : null;
      const calls = Array.isArray(chain?.calls) ? chain.calls : [];
      const puts = Array.isArray(chain?.puts) ? chain.puts : [];
      const normalizedCalls = calls.map((c) => normalizeOptionContract(c, symbol, 'CALL', expirationDate)).filter(Boolean);
      const normalizedPuts = puts.map((p) => normalizeOptionContract(p, symbol, 'PUT', expirationDate)).filter(Boolean);
      if (normalizedCalls.length > 0 || normalizedPuts.length > 0) yahooSuccess += 1;
      contracts.push(...normalizedCalls, ...normalizedPuts);
    } catch (_) {
      // best effort
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  sourceStatus.yahooFinance = yahooSuccess > 0 ? 'ok' : 'degraded';
  const sorted = contracts
    .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
    .slice(0, ACTIVE_OPTIONS_TOP_CONTRACTS);

  if (!symbols.length || !sorted.length) throw new Error('active_options_sources_incomplete');

  activeOptionsCache = {
    updatedAt: Date.now(),
    expiresAt: Date.now() + OPTIONS_CACHE_TTL_MS,
    baseSymbols: symbols,
    sourceStatus,
    items: sorted
  };
  await saveActiveOptionsToDisk();
  return getActiveOptionsSnapshot();
}

app.get('/api/options/active', async (_req, res) => {
  const cached = getActiveOptionsSnapshot();
  if (isEntryFresh(cached) && cached.items.length > 0) {
    return res.json({ ...cached, fromCache: true, stale: false });
  }
  try {
    if (activeOptionsRefreshPromise) {
      await activeOptionsRefreshPromise;
    } else {
      activeOptionsRefreshPromise = refreshActiveOptions();
      await activeOptionsRefreshPromise;
    }
    const fresh = getActiveOptionsSnapshot();
    return res.json({ ...fresh, fromCache: false, stale: false });
  } catch (err) {
    if (cached.items.length > 0) {
      return res.json({
        ...cached,
        stale: true,
        fromCache: true,
        sourceStatus: { alphaVantage: 'degraded', yahooFinance: 'degraded' },
        warning: err.message || 'active_options_refresh_failed'
      });
    }
    return res.status(502).json({
      error: 'Unable to load active options',
      sourceStatus: { alphaVantage: 'degraded', yahooFinance: 'degraded' },
      details: err.message || 'active_options_refresh_failed'
    });
  } finally {
    activeOptionsRefreshPromise = null;
  }
});

app.get('/api/options/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  const limit = Math.max(5, Math.min(100, Number(req.query.limit) || 20));
  const cached = tickerOptionsCache[symbol];
  if (isEntryFresh(cached) && ((cached.calls && cached.calls.length) || (cached.puts && cached.puts.length))) {
    return res.json({ ...cached, fromCache: true, stale: false });
  }
  try {
    if (tickerOptionsRefreshPromises.has(symbol)) {
      await tickerOptionsRefreshPromises.get(symbol);
    } else {
      const promise = refreshTickerOptionsForSymbol(symbol, { limit });
      tickerOptionsRefreshPromises.set(symbol, promise);
      await promise;
    }
    const fresh = tickerOptionsCache[symbol] || null;
    if (!fresh) throw new Error('no_ticker_options_payload');
    return res.json({ ...fresh, fromCache: false, stale: false });
  } catch (err) {
    if (cached && ((cached.calls && cached.calls.length) || (cached.puts && cached.puts.length))) {
      return res.json({
        ...cached,
        stale: true,
        fromCache: true,
        sourceStatus: { yahooFinance: 'degraded' },
        warning: err.message || 'ticker_options_refresh_failed'
      });
    }
    return res.status(502).json({
      error: `Unable to load options for ${symbol}`,
      sourceStatus: { yahooFinance: 'degraded' },
      details: err.message || 'ticker_options_refresh_failed'
    });
  } finally {
    tickerOptionsRefreshPromises.delete(symbol);
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
    const earningsDate = req.query.earningsDate || null;
    const maxItems = isTodayOrYesterdayOrTomorrowEpoch(earningsDate) ? 10 : 5;
    const news = await fetchGoogleTickerNews(ticker, companyName, { maxItems });
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
app.use(express.static(__dirname, { index: false }));
app.get('/', async (_req, res) => {
  try {
    if (!indexHtmlTemplate) {
      indexHtmlTemplate = await fs.readFile(`${__dirname}/index.html`, 'utf8');
    }
    const inlineScript = `<script>window.INITIAL_TRENDING_DATA=${serializeForInlineScript(getTrendingSnapshot())};window.INITIAL_ACTIVE_OPTIONS_DATA=${serializeForInlineScript(getActiveOptionsSnapshot())};</script>`;
    const html = indexHtmlTemplate.includes('</head>')
      ? indexHtmlTemplate.replace('</head>', `${inlineScript}\n</head>`)
      : `${inlineScript}\n${indexHtmlTemplate}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (_) {
    return res.sendFile(`${__dirname}/index.html`);
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Stock tracker API listening on http://localhost:${PORT}`);
  (async () => {
    try {
      await loadEarningsCachesFromDisk();
      await ensureEarningsUpdatesIfDue('startup');
      setInterval(() => ensureEarningsUpdatesIfDue('job').catch(() => {}), 15 * 60 * 1000);
      await loadActiveOptionsFromDisk();
      await loadTickerOptionsFromDisk();
      setInterval(() => refreshActiveOptions().catch(() => {}), 60 * 60 * 1000);
    } catch (err) {
      console.error('[Options] Startup initialization failed:', err.message || err);
    }
  })().catch(() => {});
  loadTrendingSnapshotFromDisk()
    .then(() => updateTrendingCache())
    .then(() => {
      startTrendingPoller();
      console.log(`Trending poller started (interval ${TRENDING_POLL_INTERVAL_MS}ms)`);
    })
    .catch((error) => {
      startTrendingPoller();
      console.error(`Trending poller started with stale cache: ${error?.message || error}`);
    });
});
