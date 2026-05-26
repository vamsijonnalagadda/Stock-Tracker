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
import { buildOptionsRecommendationScorecard } from './engines/optionsRecommendationEngine.js';
import { buildInvestorRecommendationScorecard } from './engines/investorRecommendationEngine.js';
import * as cosmos from './db/cosmosClient.js';

const app = express();
app.use(cors());
// Increase JSON body size to allow posting enriched next-week payloads
app.use(express.json({ limit: '50mb' }));

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
const EARNINGS_NEXT_JSON_PATH = './data/earnings_next.json';
const DEFAULT_FINNHUB_KEY = 'd85p4nhr01qitd933c7gd85p4nhr01qitd933c80';

const EARNINGS_CENTRAL_TZ = 'America/Chicago';
const EARNINGS_FRIDAY_REFRESH_HOUR_CT = Number(process.env.EARNINGS_FRIDAY_REFRESH_HOUR_CT || 19); // 7 PM CST/CDT
const EARNINGS_IMPLIED_REFRESH_HOUR_CT = Number(process.env.EARNINGS_IMPLIED_REFRESH_HOUR_CT || 19); // 7 PM CST/CDT
const SP500_CACHE_TTL_MS = 24 * 60 * 60_000;
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
let nextWeekEarningsCache = { updatedAt: 0, weekStart: null, days: {} };
const NEXT_WEEK_EARNINGS_TTL_MS = 60 * 60_000; // 1 hour
let sp500Cache = { symbols: new Set(), updatedAt: 0 };
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

// Persist the stock historical map to local JSON + Cosmos (fire-and-forget for Cosmos).
async function persistHistoricalMap(map) {
  try {
    await fs.writeFile('./data/stock_historical.json', JSON.stringify(map, null, 2), 'utf8');
  } catch (_) {}
  if (cosmos.isCosmosEnabled()) cosmos.saveStockHistorical(map).catch(() => {});
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
  const apiKey = getFinnhubKey();
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
  const dividendYield = normalizeYieldRatio(
    metric.dividendYieldIndicatedAnnual
    ?? metric.annualizedDividendYield
    ?? metric.currentDividendYieldTTM
  );
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
      dividendYield: { raw: dividendYield },
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

async function fetchFinnhubIndexQuote(symbol) {
  try {
    const key = getFinnhubKey();
    if (!key) throw new Error('missing_finnhub_api_key');
    const url = `${FINNHUB_API}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
    const res = await withTimeout(fetch(url), 5000, 'finnhub quote');
    if (!res.ok) throw new Error(`finnhub_http_${res.status}`);
    const j = await res.json();
    // Finnhub returns {c: current, pc: previous close, t: timestamp}
    const price = Number.isFinite(Number(j?.c)) ? Number(j.c) : null;
    const prevClose = Number.isFinite(Number(j?.pc)) ? Number(j.pc) : null;
    return { price, prevClose, marketSession: null };
  } catch (err) {
    return null;
  }
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
      dividendYield: {
        raw: normalizeYieldRatio(
          data.dividendYield ?? data.trailingAnnualDividendYield ?? data.forwardAnnualDividendYield
        )
      },
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
  const modules = 'price,defaultKeyStatistics,financialData,summaryDetail';
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
  const summaryDetail = result.summaryDetail || {};

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
  const dividendYield = normalizeYieldRatio(
    finData.dividendYield?.raw
    ?? keyStats.trailingAnnualDividendYield?.raw
    ?? keyStats.forwardAnnualDividendYield?.raw
    ?? summaryDetail.dividendYield?.raw
  );

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
      dividendYield: { raw: dividendYield },
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
        modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail']
      }),
      7000,
      'yahoo-finance2 quoteSummary'
    )
  ]);

  const financialData = summary?.financialData || {};
  const keyStats = summary?.defaultKeyStatistics || {};
  const summaryDetail = summary?.summaryDetail || {};

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
  const dividendYield = normalizeYieldRatio(
    financialData?.dividendYield
    ?? keyStats?.trailingAnnualDividendYield
    ?? keyStats?.forwardAnnualDividendYield
    ?? summaryDetail?.dividendYield
  );

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
      dividendYield: { raw: dividendYield },
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

function normalizeYieldRatio(value) {
  const n = safe(value);
  if (n == null) return null;
  // Keep as ratio for frontend percent formatters (e.g. 0.025 -> 2.50%).
  return n > 1 ? n / 100 : n;
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

  baseQuote.financialData.dividendYield = {
    raw: firstNonNull(
      normalizeYieldRatio(baseQuote.financialData?.dividendYield?.raw),
      normalizeYieldRatio(yfinanceQuote?.financialData?.dividendYield?.raw),
      normalizeYieldRatio(yahooApiQuote?.financialData?.dividendYield?.raw),
      normalizeYieldRatio(eodhdQuote?.financialData?.dividendYield?.raw)
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
    dividendYield: normalizeYieldRatio(fin.dividendYield?.raw),
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
  { symbol: "^GSPC",    label: "S&P 500", finnhubSymbols: ["SPY"] },
  { symbol: "^IXIC",    label: "Nasdaq", finnhubSymbols: ["QQQ"] },
  { symbol: "^DJI",     label: "Dow", finnhubSymbols: ["DIA"] },
  { symbol: "GC=F",     label: "Gold"       },
  { symbol: "SI=F",     label: "Silver"     },
  { symbol: "^TNX",     label: "10Y"        },
  { symbol: "DGS2",     label: "2Y", symbols: ["DGS2","^IRX"] },
  { symbol: "CL=F",     label: "WTI"        },
  { symbol: "BZ=F",     label: "Brent", symbols: ["BZ=F","BRT-USD","LCOc1","BNO"] },
  { symbol: "^BSESN",   label: "Sensex"     },
  { symbol: "BTC-USD",  label: "BTC", finnhubSymbols: ["BINANCE:BTCUSDT", "COINBASE:BTCUSD"] },
  { symbol: "ETH-USD",  label: "ETH", finnhubSymbols: ["BINANCE:ETHUSDT", "COINBASE:ETHUSD"] },
  { symbol: "USDINR=X", label: "USD/INR", finnhubSymbols: ["OANDA:USD_INR"] },
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
const MARKET_CACHE_TTL = 5 * 60_000; // 5 minutes

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
        const finnhubCandidates = Array.isArray(idx.finnhubSymbols) && idx.finnhubSymbols.length > 0
          ? idx.finnhubSymbols
          : candidates;
        let chosen = null;
        let q = null;
        let provider = 'yfinance';

        const isPlausibleIndexPrice = (label, numericPrice) => {
          if (numericPrice == null || !Number.isFinite(numericPrice)) return false;
          const labelUpper = String(label || '').toUpperCase();
          if (labelUpper.includes('BRENT') || labelUpper.includes('WTI') || labelUpper.includes('OIL')) {
            return numericPrice > 1;
          }
          return true;
        };

        // Try Finnhub first for low-latency index values (best-effort)
        if (typeof fetchFinnhubIndexQuote === 'function') {
          for (const s of finnhubCandidates) {
            try {
              const fh = await fetchFinnhubIndexQuote(s).catch(() => null);
              if (fh && isPlausibleIndexPrice(idx.label, fh.price)) {
                chosen = s;
                q = { regularMarketPrice: fh.price, regularMarketPreviousClose: fh.prevClose, marketSession: fh.marketSession };
                provider = 'finnhub';
                break;
              }
            } catch (_) {}
          }
        }

        // If Finnhub didn't return a value, try yahoo-finance2 directly.
        if (!q) {
          for (const s of candidates) {
            try {
              const yf2 = await fetchYahooFinance2Quote(s);
              if (isPlausibleIndexPrice(idx.label, yf2?.price)) {
                chosen = s;
                q = {
                  regularMarketPrice: yf2.price,
                  regularMarketPreviousClose: yf2.prevClose,
                  marketSession: yf2.marketSession,
                  regularPrice: yf2.regularPrice,
                  extendedPrice: yf2.extendedPrice,
                  regularChangePct: yf2.regularChangePct,
                  extendedChangePct: yf2.extendedChangePct
                };
                provider = 'yahoo-finance2';
                break;
              }
            } catch (_) {
              // try next candidate
            }
          }
        }

        // If still empty, fall back to yfinance proxy candidates.
        if (!q) {
          for (const s of candidates) {
            try {
              const r = await fetch(`${YFINANCE_SERVICE_URL}/quote/${encodeURIComponent(s)}`, { timeout: 2000 });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const qq = await r.json();
              const price = qq.regularMarketPrice ?? null;
              const numericPrice = (price == null) ? null : (typeof price === 'number' ? price : Number(price));
              if (isPlausibleIndexPrice(idx.label, numericPrice)) {
                chosen = s;
                q = qq;
                provider = 'yfinance';
                break;
              }
            } catch {
              // ignore and try next candidate
            }
          }
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
                provider = 'yfinance';
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
        return { symbol: chosen || idx.symbol, label: cleanLabel, price, change, changePct, source: provider };
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
              await persistHistoricalMap(historicalMap);
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
              await persistHistoricalMap(historicalMap);
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
                  await persistHistoricalMap(historicalMap);
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
      // Thumb always based on 5yr stock historical avg only (not sector avg)
      const baseline = stockHist?.forwardPE ?? null;
      const sent = baseline != null
        ? (metrics.forwardPE < baseline ? 'UP' : metrics.forwardPE > baseline ? 'DOWN' : 'AVERAGE')
        : 'AVERAGE';
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
      // Thumb always based on 5yr stock historical avg only (not sector avg)
      const baseline = stockHist?.evEbitda ?? null;
      const sent = baseline != null
        ? (metrics.evEbitda < baseline ? 'UP' : metrics.evEbitda > baseline ? 'DOWN' : 'AVERAGE')
        : 'AVERAGE';
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
      // Thumb always based on 5yr stock historical avg only (FCF margin: higher is better)
      const baseline = stockHist?.fcfMargin ?? null;
      const sent = baseline != null
        ? (metrics.fcfMargin > baseline ? 'UP' : metrics.fcfMargin < baseline ? 'DOWN' : 'AVERAGE')
        : 'AVERAGE';
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
  // Try Cosmos first, fall back to local JSON file.
  if (cosmos.isCosmosEnabled()) {
    try {
      const doc = await cosmos.loadTrending();
      if (doc && Array.isArray(doc.symbols)) {
        trendingCache = normalizeTrendingSnapshot(doc);
        return trendingCache;
      }
    } catch (_) {}
  }
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
      if (cosmos.isCosmosEnabled()) cosmos.saveTrending(snapshot).catch(() => {});
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

function getTimeInCentral(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EARNINGS_CENTRAL_TZ,
    weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(now);
  const get = (type) => { const p = parts.find(x => x.type === type); return p ? p.value : null; };
  return {
    weekday: get('weekday'),
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute'))
  };
}

function isoDateInCentral(now = new Date()) {
  const ct = getTimeInCentral(now);
  return `${ct.year}-${String(ct.month).padStart(2, '0')}-${String(ct.day).padStart(2, '0')}`;
}

function getTargetWeekStart(now = new Date()) {
  const ct = getTimeInCentral(now);
  const currentWeekMonday = getMondayForDate(now);
  const shouldSwitchToNextWeek =
    ct.weekday === 'Sunday' ||
    ct.weekday === 'Saturday' ||
    (ct.weekday === 'Friday' && ct.hour >= EARNINGS_FRIDAY_REFRESH_HOUR_CT);
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
  // ── earnings_week ──────────────────────────────────────────────────────────
  let loadedWeek = false;
  if (cosmos.isCosmosEnabled()) {
    try {
      const doc = await cosmos.loadEarningsWeek();
      if (doc && typeof doc.days === 'object') {
        weeklyEarningsCache = { updatedAt: Number(doc.updatedAt) || 0, weekStart: doc.weekStart || null, days: doc.days };
        loadedWeek = true;
        console.log('[Cosmos] Loaded earnings_week');
      }
    } catch (_) {}
  }
  if (!loadedWeek) {
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
  }

  // ── earnings_moves ─────────────────────────────────────────────────────────
  let loadedMoves = false;
  if (cosmos.isCosmosEnabled()) {
    try {
      const moves = await cosmos.loadEarningsMoves();
      if (moves && typeof moves === 'object') {
        earningsMovesCache = moves;
        loadedMoves = true;
        console.log('[Cosmos] Loaded earnings_moves');
      }
    } catch (_) {}
  }
  if (!loadedMoves) {
    try {
      const rawMoves = await fs.readFile(EARNINGS_MOVES_JSON_PATH, 'utf8');
      const parsedMoves = JSON.parse(rawMoves);
      earningsMovesCache = parsedMoves && typeof parsedMoves === 'object' ? parsedMoves : {};
    } catch (_) {
      earningsMovesCache = {};
    }
  }

  // ── earnings_next ──────────────────────────────────────────────────────────
  let loadedNext = false;
  if (cosmos.isCosmosEnabled()) {
    try {
      const doc = await cosmos.loadEarningsNext();
      if (doc && typeof doc.days === 'object') {
        nextWeekEarningsCache = doc;
        loadedNext = true;
        console.log('[Cosmos] Loaded earnings_next');
      }
    } catch (_) {}
  }
  if (!loadedNext) {
    try {
      const rawNext = await fs.readFile(EARNINGS_NEXT_JSON_PATH, 'utf8');
      const parsedNext = JSON.parse(rawNext);
      if (parsedNext && typeof parsedNext.days === 'object') nextWeekEarningsCache = parsedNext;
    } catch (_) {
      // ignore
    }
  }
}

async function saveEarningsCachesToDisk() {
  try {
    // If the on-disk weekly file already contains the "next week" payload,
    // avoid overwriting it. This prevents accidental promotion/overwrite when
    // some external job updated the next-week file and the server would
    // otherwise write the same next-week data into the weekly file.
    let skipWrite = false;
    try {
      const rawDisk = await fs.readFile(EARNINGS_WEEK_JSON_PATH, 'utf8');
      const disk = JSON.parse(rawDisk);
      if (disk && disk.weekStart && nextWeekEarningsCache && disk.weekStart === nextWeekEarningsCache.weekStart && weeklyEarningsCache.weekStart !== disk.weekStart) {
        console.warn('[EarningsSync] Skipping overwrite of earnings_week.json because disk already contains next-week payload (weekStart=' + disk.weekStart + ')');
        skipWrite = true;
      }
    } catch (_) {
      // ignore read/parse errors and fall through to write
    }
    if (!skipWrite) {
      await fs.writeFile(EARNINGS_WEEK_JSON_PATH, JSON.stringify(weeklyEarningsCache, null, 2), 'utf8');
    }
    if (cosmos.isCosmosEnabled()) cosmos.saveEarningsWeek(weeklyEarningsCache).catch(() => {});
  } catch (err) {
    console.error('[EarningsSync] Failed writing earnings_week.json:', err?.message || err);
  }
  try {
    await fs.writeFile(EARNINGS_MOVES_JSON_PATH, JSON.stringify(earningsMovesCache, null, 2), 'utf8');
    if (cosmos.isCosmosEnabled()) cosmos.saveEarningsMoves(earningsMovesCache).catch(() => {});
  } catch (err) {
    console.error('[EarningsSync] Failed writing earnings_moves.json:', err?.message || err);
  }
  try {
    await fs.writeFile(EARNINGS_NEXT_JSON_PATH, JSON.stringify(nextWeekEarningsCache, null, 2), 'utf8');
    if (cosmos.isCosmosEnabled()) cosmos.saveEarningsNext(nextWeekEarningsCache).catch(() => {});
  } catch (err) {
    // best effort
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

async function fetchSp500Constituents() {
  const url = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';
  const res = await withTimeout(fetch(url), 12000, 'sp500 list');
  if (!res.ok) throw new Error(`sp500_http_${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const set = new Set();
  $('table.wikitable tbody tr').each((_, tr) => {
    const raw = String($(tr).find('td').first().text() || '').trim().toUpperCase();
    if (!raw) return;
    const normalized = raw.replace(/\./g, '-');
    if (/^[A-Z0-9\-]{1,12}$/.test(normalized)) set.add(normalized);
  });
  if (set.size < 300) throw new Error('sp500_parse_too_small');
  return set;
}

async function getSp500MembershipSet() {
  if (sp500Cache.updatedAt && (Date.now() - sp500Cache.updatedAt) < SP500_CACHE_TTL_MS && sp500Cache.symbols.size > 0) {
    return sp500Cache.symbols;
  }
  try {
    const symbols = await fetchSp500Constituents();
    sp500Cache = { symbols, updatedAt: Date.now() };
    return symbols;
  } catch (err) {
    // Fallback to previously known S&P flags if upstream list fails.
    const seed = buildIsSp500Seed();
    if (seed.size > 0) return seed;
    throw err;
  }
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toUnixSeconds(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Math.floor(d.getTime() / 1000);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function hasFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n);
}

async function fetchFinnhubEarningsHistory(symbol, fromIso, toIso) {
  const key = getFinnhubKey();
  if (!key) throw new Error('missing_finnhub_api_key');
  const url = `${FINNHUB_API}/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&token=${encodeURIComponent(key)}`;
  const res = await withTimeout(fetch(url), 12000, 'finnhub symbol earnings history');
  const data = await res.json();
  if (!res.ok) throw new Error(`finnhub_history_http_${res.status}`);
  const rows = Array.isArray(data?.earningsCalendar)
    ? data.earningsCalendar
    : (Array.isArray(data?.earnings) ? data.earnings : []);
  return rows;
}

async function fetchFinnhubDailyCandles(symbol, fromIso, toIso) {
  const key = getFinnhubKey();
  if (!key) throw new Error('missing_finnhub_api_key');
  const from = toUnixSeconds(fromIso);
  const to = toUnixSeconds(toIso);
  const url = `${FINNHUB_API}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(key)}`;
  const res = await withTimeout(fetch(url), 12000, 'finnhub candles');
  const data = await res.json();
  if (!res.ok) throw new Error(`finnhub_candles_http_${res.status}`);
  if (data?.s !== 'ok' || !Array.isArray(data?.t) || !Array.isArray(data?.c)) return [];
  const points = [];
  for (let i = 0; i < data.t.length; i++) {
    const ts = Number(data.t[i]);
    const close = Number(data.c[i]);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) continue;
    const dateIso = new Date(ts * 1000).toISOString().slice(0, 10);
    points.push({ dateIso, close });
  }
  return points;
}

async function computeMoveHistoryFromYahoo(symbol, maxEvents = 6) {
  const summary = await withTimeout(
    yahooFinanceClient.quoteSummary(symbol, { modules: ['earningsHistory'] }),
    10000,
    'yf earnings history'
  );
  const history = Array.isArray(summary?.earningsHistory?.history)
    ? summary.earningsHistory.history
    : [];

  const events = history
    .map((row) => {
      const rawQuarter = row?.quarter;
      const d = rawQuarter ? new Date(rawQuarter) : null;
      if (!d || Number.isNaN(d.getTime())) return null;
      return {
        dateIso: d.toISOString().slice(0, 10),
        // Quarter timestamp does not include exact release timing; AMC default is safer.
        hour: 'amc'
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.dateIso).localeCompare(String(a.dateIso)))
    .slice(0, maxEvents);

  if (!events.length) return null;

  const oldest = events[events.length - 1].dateIso;
  const newest = events[0].dateIso;
  const chart = await withTimeout(
    yahooFinanceClient.chart(symbol, {
      period1: addDaysIso(oldest, -10),
      period2: addDaysIso(newest, 10),
      interval: '1d'
    }),
    12000,
    'yf chart earnings moves'
  );

  const candles = (Array.isArray(chart?.quotes) ? chart.quotes : [])
    .map((q) => {
      const date = q?.date ? new Date(q.date) : null;
      const close = Number(q?.close);
      if (!date || Number.isNaN(date.getTime()) || !Number.isFinite(close) || close <= 0) return null;
      return {
        dateIso: date.toISOString().slice(0, 10),
        close
      };
    })
    .filter(Boolean);

  if (!candles.length) return null;

  const candleByDate = new Map(candles.map((p) => [p.dateIso, p.close]));
  const sortedDates = Array.from(new Set(candles.map((p) => p.dateIso))).sort();
  const moves = [];
  for (const ev of events) {
    const mv = computeMoveForEarningsEvent(ev.dateIso, ev.hour, candleByDate, sortedDates);
    if (Number.isFinite(mv)) moves.push(mv);
    if (moves.length >= 4) break;
  }

  if (!moves.length) return null;
  return {
    lastMove: moves[0],
    avg4Move: round2(moves.reduce((sum, v) => sum + Math.abs(v), 0) / moves.length),
    moves
  };
}

function computeMoveForEarningsEvent(eventIso, hour, candleByDate, sortedDates) {
  if (!eventIso) return null;
  let idx = sortedDates.indexOf(eventIso);
  if (idx < 0) idx = sortedDates.findIndex((d) => d > eventIso);
  if (idx < 0) return null;
  const h = toHourCode(hour);
  let preIdx = idx;
  let postIdx = idx + 1;
  if (h === 'bmo') {
    preIdx = idx - 1;
    postIdx = idx;
  }
  const preDate = sortedDates[preIdx];
  const postDate = sortedDates[postIdx];
  const preClose = preDate ? candleByDate.get(preDate) : null;
  const postClose = postDate ? candleByDate.get(postDate) : null;
  if (!Number.isFinite(preClose) || !Number.isFinite(postClose) || preClose <= 0) return null;
  return round2(((postClose - preClose) / preClose) * 100);
}

async function syncMoveHistoryForSymbols(symbols, reason = 'job') {
  const list = Array.from(new Set((Array.isArray(symbols) ? symbols : []).map((s) => String(s || '').toUpperCase()).filter(Boolean)));
  if (list.length === 0) return 0;

  const todayIso = isoDateLocal(new Date());
  const fromIso = addDaysIso(todayIso, -540);
  let updated = 0;

  for (const symbol of list) {
    const prev = earningsMovesCache[symbol] || {};
    const hasFresh = Number.isFinite(Number(prev?.updatedAt)) && (Date.now() - Number(prev.updatedAt)) < (7 * 24 * 60 * 60_000)
      && hasFiniteNumber(prev?.avg4Move) && hasFiniteNumber(prev?.lastMove);
    if (hasFresh) continue;

    let nextMoveData = null;

    try {
      const eventsRaw = await fetchFinnhubEarningsHistory(symbol, fromIso, todayIso);
      const events = eventsRaw
        .map((e) => ({ dateIso: String(e?.date || '').slice(0, 10), hour: toHourCode(e?.hour) }))
        .filter((e) => !!e.dateIso)
        .sort((a, b) => String(b.dateIso).localeCompare(String(a.dateIso)))
        .slice(0, 6);
      if (events.length === 0) throw new Error('finnhub_no_events');

      const oldest = events[events.length - 1].dateIso;
      const newest = events[0].dateIso;
      const candles = await fetchFinnhubDailyCandles(symbol, addDaysIso(oldest, -7), addDaysIso(newest, 7));
      if (!candles.length) throw new Error('finnhub_no_candles');

      const candleByDate = new Map(candles.map((p) => [p.dateIso, p.close]));
      const sortedDates = Array.from(new Set(candles.map((p) => p.dateIso))).sort();
      const moves = [];
      for (const ev of events) {
        const mv = computeMoveForEarningsEvent(ev.dateIso, ev.hour, candleByDate, sortedDates);
        if (Number.isFinite(mv)) moves.push(mv);
        if (moves.length >= 4) break;
      }
      if (moves.length) {
        nextMoveData = {
          lastMove: moves[0],
          avg4Move: round2(moves.reduce((sum, v) => sum + Math.abs(v), 0) / moves.length),
          moves
        };
      } else {
        throw new Error('finnhub_no_moves');
      }
    } catch (_) {
      // best effort per symbol; Yahoo fallback below
    }

    if (!nextMoveData) {
      try {
        nextMoveData = await computeMoveHistoryFromYahoo(symbol, 6);
      } catch (_) {
        // best effort fallback
      }
    }

    if (nextMoveData && hasFiniteNumber(nextMoveData.avg4Move) && hasFiniteNumber(nextMoveData.lastMove)) {
      earningsMovesCache[symbol] = {
        ...prev,
        lastMove: nextMoveData.lastMove,
        avg4Move: nextMoveData.avg4Move,
        moves: Array.isArray(nextMoveData.moves) ? nextMoveData.moves : prev?.moves,
        updatedAt: Date.now()
      };
      updated += 1;
    }

    await new Promise((r) => setTimeout(r, 90));
  }

  if (updated > 0) {
    console.log(`[EarningsSync] Move history refreshed (${reason}) for ${updated} symbols`);
  }
  return updated;
}

async function ensureSp500MoveHistoryCoverage(days, reason = 'request') {
  const source = days && typeof days === 'object' ? days : {};
  const missingSymbols = [];
  const seen = new Set();

  Object.values(source).forEach((rows) => {
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const symbol = String(row?.symbol || '').toUpperCase();
      if (!symbol || !row?.isSp500 || seen.has(symbol)) return;
      if (!hasFiniteNumber(row?.avgLast4EarningsMove) || !hasFiniteNumber(row?.lastEarningsMove)) {
        seen.add(symbol);
        missingSymbols.push(symbol);
      }
    });
  });

  if (!missingSymbols.length) return 0;
  // Guardrail so request-time backfill stays responsive.
  const toSync = missingSymbols.slice(0, 120);
  const updated = await syncMoveHistoryForSymbols(toSync, `${reason}-sp500-backfill`);
  if (updated > 0) {
    hydrateEarningsDaysFromMoveCache(source);
  }
  return updated;
}

function mergeMoveData(symbolUpper) {
  const move = earningsMovesCache[symbolUpper] || null;
  return {
    impliedMove: move?.impliedMove ?? null,
    avgLast4EarningsMove: hasFiniteNumber(move?.avg4Move) ? Number(move.avg4Move) : null,
    lastEarningsMove: hasFiniteNumber(move?.lastMove) ? Number(move.lastMove) : null
  };
}

function hydrateEarningsDaysFromMoveCache(days) {
  let updated = 0;
  const source = days && typeof days === 'object' ? days : {};
  Object.keys(source).forEach((dateIso) => {
    const rows = Array.isArray(source[dateIso]) ? source[dateIso] : [];
    source[dateIso] = rows.map((row) => {
      const symbol = String(row?.symbol || '').toUpperCase();
      const moves = mergeMoveData(symbol);
      const nextRow = {
        ...row,
        impliedMove: moves.impliedMove ?? row?.impliedMove ?? null,
        avgLast4EarningsMove: moves.avgLast4EarningsMove ?? row?.avgLast4EarningsMove ?? null,
        lastEarningsMove: moves.lastEarningsMove ?? row?.lastEarningsMove ?? null
      };
      if (
        nextRow.impliedMove !== row?.impliedMove ||
        nextRow.avgLast4EarningsMove !== row?.avgLast4EarningsMove ||
        nextRow.lastEarningsMove !== row?.lastEarningsMove
      ) {
        updated += 1;
      }
      return nextRow;
    });
  });
  return updated;
}

async function enrichCompanyNamesForDays(byDay, options = {}) {
  const maxSymbols = Math.max(0, Number(options.maxSymbols) || 80);
  const maxDurationMs = Math.max(500, Number(options.maxDurationMs) || 6000);
  const started = Date.now();
  const rows = Object.values(byDay || {}).flat().filter(Boolean);
  const sp500Symbols = Array.from(new Set(
    rows
      .filter((r) => !!r?.isSp500)
      .map((r) => String(r?.symbol || '').toUpperCase())
      .filter(Boolean)
  ));
  const nonSpSymbols = Array.from(new Set(
    rows
      .filter((r) => !r?.isSp500)
      .map((r) => String(r?.symbol || '').toUpperCase())
      .filter(Boolean)
  ));

  // Always prioritize S&P symbols first. Remaining budget is used for non-S&P.
  const remainingBudget = Math.max(0, maxSymbols - sp500Symbols.length);
  const allSymbols = [...sp500Symbols, ...nonSpSymbols.slice(0, remainingBudget)];
  const sp500Set = new Set(sp500Symbols);

  const isTickerLike = (name, sym) => {
    const a = String(name || '').trim().toUpperCase();
    const b = String(sym || '').trim().toUpperCase();
    return !!a && !!b && a === b;
  };

  for (const sym of allSymbols) {
    // Keep processing S&P names even when time budget is exceeded.
    if (Date.now() - started > maxDurationMs && !sp500Set.has(sym)) break;
    try {
      const yahooSym = normalizeSymbolForYahoo(sym);
      const q = await withTimeout(yahooFinanceClient.quote(yahooSym), 7000, 'yf-quote-name');
      const name = q?.shortName || q?.longName || null;
      const short = sanitizeCompanyName(name, sym);
      Object.keys(byDay || {}).forEach((d) => {
        (byDay[d] || []).forEach((row) => {
          if (String(row.symbol || '').toUpperCase() !== sym) return;
          // Only overwrite when name is meaningful, or current value is empty/ticker-like.
          const current = String(row.companyName || '').trim();
          if (!current || isTickerLike(current, sym) || (!isTickerLike(short, sym) && short)) {
            row.companyName = short;
          }
        });
      });
      await new Promise((r) => setTimeout(r, 40));
    } catch (_) {
      // ignore per-symbol failures
    }
  }

  // Ensure fallback names exist.
  Object.keys(byDay || {}).forEach((d) => {
    (byDay[d] || []).forEach((row) => {
      if (!row.companyName) row.companyName = sanitizeCompanyName(null, String(row.symbol || '').toUpperCase());
    });
  });
}

function countSp500TickerLikeNames(days) {
  let count = 0;
  Object.keys(days || {}).forEach((d) => {
    (days[d] || []).forEach((row) => {
      if (!row?.isSp500) return;
      const sym = String(row?.symbol || '').trim().toUpperCase();
      const name = String(row?.companyName || '').trim().toUpperCase();
      if (sym && name && sym === name) count += 1;
    });
  });
  return count;
}

async function ensureReadableSp500CompanyNames(days, reason = 'request') {
  const missingTickerLike = countSp500TickerLikeNames(days);
  if (missingTickerLike <= 0) return 0;
  try {
    await enrichCompanyNamesForDays(days, { maxSymbols: 140, maxDurationMs: 12000 });
    return Math.max(0, missingTickerLike - countSp500TickerLikeNames(days));
  } catch (_) {
    return 0;
  }
}

async function buildEarningsDaysFromRows(rawRows, options = {}) {
  const symbolsForWeek = Array.from(new Set(
    (Array.isArray(rawRows) ? rawRows : []).map((r) => String(r?.symbol || '').trim().toUpperCase()).filter(Boolean)
  ));
  if (options.syncMoveHistory) {
    await syncMoveHistoryForSymbols(symbolsForWeek, options.reason || 'job');
  }
  const sp500Set = await getSp500MembershipSet().catch(() => buildIsSp500Seed());
  const byDay = {};
  for (const row of (Array.isArray(rawRows) ? rawRows : [])) {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const dateIso = String(row?.date || '').slice(0, 10);
    if (!symbol || !dateIso) continue;
    if (!byDay[dateIso]) byDay[dateIso] = [];
    const moves = mergeMoveData(symbol);
    // Preserve any existing values from the on-disk cache so we don't clobber backfilled data
    const existingForDate = (weeklyEarningsCache?.days || {})[dateIso] || [];
    const existingRow = existingForDate.find((r) => String(r?.symbol || '').toUpperCase() === symbol) || null;
    byDay[dateIso].push({
      symbol,
      hour: toHourCode(row?.hour),
      epsEst: Number.isFinite(Number(row?.epsEstimate)) ? Number(row.epsEstimate) : null,
      revenueEst: Number.isFinite(Number(row?.revenueEstimate)) ? Number(row.revenueEstimate) : null,
      isSp500: sp500Set.has(symbol),
      impliedMove: moves.impliedMove ?? existingRow?.impliedMove ?? null,
      avgLast4EarningsMove: moves.avgLast4EarningsMove ?? existingRow?.avgLast4EarningsMove ?? null,
      lastEarningsMove: moves.lastEarningsMove ?? existingRow?.lastEarningsMove ?? null,
      companyName: existingRow?.companyName ?? null
    });
  }

  hydrateEarningsDaysFromMoveCache(byDay);

  Object.keys(byDay).forEach((d) => {
    byDay[d] = byDay[d].sort((a, b) => {
      const aSp = a?.isSp500 ? 1 : 0;
      const bSp = b?.isSp500 ? 1 : 0;
      if (aSp !== bSp) return bSp - aSp;
      return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
    });
  });

  await enrichCompanyNamesForDays(byDay, {
    maxSymbols: options.maxNameSymbols || 80,
    maxDurationMs: options.maxNameDurationMs || 6000
  });
  return byDay;
}

async function refreshWeeklyEarningsCalendar(reason = 'job') {
  const now = new Date();
  const targetWeekStart = getTargetWeekStart(now);
  const targetWeekStartIso = isoDateLocal(targetWeekStart);
  const { fromIso, toIso } = getWeekRangeFromStart(targetWeekStart);
  const rawRows = await fetchFinnhubEarningsCalendar(fromIso, toIso);
  const byDay = await buildEarningsDaysFromRows(rawRows, {
    syncMoveHistory: true,
    reason,
    maxNameSymbols: 100,
    maxNameDurationMs: 9000
  });

  weeklyEarningsCache = {
    updatedAt: Date.now(),
    weekStart: targetWeekStartIso,
    days: byDay
  };

  // Pre-warm/cache the week after target week so "Next Week" opens instantly.
  try {
    const twoWeeksMonday = new Date(targetWeekStart);
    twoWeeksMonday.setDate(twoWeeksMonday.getDate() + 7);
    const twoWeeksStartIso = isoDateLocal(twoWeeksMonday);
    if (nextWeekEarningsCache.weekStart !== twoWeeksStartIso) {
      const range2 = getWeekRangeFromStart(twoWeeksMonday);
      const rawRows2 = await fetchFinnhubEarningsCalendar(range2.fromIso, range2.toIso);
      const byDay2 = rawRows2.length > 0
        ? await buildEarningsDaysFromRows(rawRows2, {
            syncMoveHistory: false,
            reason: `${reason}-prewarm-next`,
            maxNameSymbols: 60,
            maxNameDurationMs: 3000
          })
        : {};
      nextWeekEarningsCache = {
        updatedAt: Date.now(),
        weekStart: twoWeeksStartIso,
        days: byDay2
      };
    }
  } catch (_) {
    // best effort prewarm only
  }

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
  const todayIsoCt = isoDateInCentral(now);
  const days = weeklyEarningsCache?.days || {};
  const nextDateIso = Object.keys(days).filter((d) => d > todayIsoCt).sort()[0] || null;
  if (!nextDateIso) {
    earningsRefreshState.lastImpliedRefreshDate = todayIsoCt;
    return;
  }

  // Prefer S&P500 symbols first, then others (deduplicated, preserve order)
  const raw = (Array.isArray(days[nextDateIso]) ? days[nextDateIso] : []).map((r) => ({
    symbol: String(r?.symbol || '').toUpperCase(),
    isSp: !!r?.isSp500
  })).filter(s => s.symbol);
  const seen = new Set();
  const spSymbols = [];
  const otherSymbols = [];
  for (const item of raw) {
    if (seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    if (item.isSp) spSymbols.push(item.symbol); else otherSymbols.push(item.symbol);
  }
  const symbols = [...spSymbols, ...otherSymbols];

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
  earningsRefreshState.lastImpliedRefreshDate = todayIsoCt;
  await saveEarningsCachesToDisk();
  console.log(`[EarningsSync] Implied refresh (${reason}) updated ${updates} symbols for next earnings day ${nextDateIso}`);
}

async function refreshImpliedMovesForNextTwoWeeks(reason = 'job') {
  const daysCombined = {
    ...(weeklyEarningsCache?.days || {}),
    ...(nextWeekEarningsCache?.days || {})
  };
  // Build symbol list preferring S&P500 symbols first
  const rawCombined = Object.values(daysCombined)
    .flatMap((rows) => (Array.isArray(rows) ? rows : []).map((r) => ({ symbol: String(r?.symbol || '').toUpperCase(), isSp: !!r?.isSp500 })))
    .filter(s => s.symbol);
  const seen2 = new Set();
  const spSymbols2 = [];
  const otherSymbols2 = [];
  for (const item of rawCombined) {
    if (seen2.has(item.symbol)) continue;
    seen2.add(item.symbol);
    if (item.isSp) spSymbols2.push(item.symbol); else otherSymbols2.push(item.symbol);
  }
  const symbols = [...spSymbols2, ...otherSymbols2];

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
      // best effort per symbol
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  hydrateEarningsDaysFromMoveCache(weeklyEarningsCache.days || {});
  hydrateEarningsDaysFromMoveCache(nextWeekEarningsCache.days || {});
  weeklyEarningsCache.updatedAt = Date.now();
  nextWeekEarningsCache.updatedAt = Date.now();
  earningsRefreshState.lastImpliedRefreshDate = isoDateInCentral(new Date());
  await saveEarningsCachesToDisk();
  console.log(`[EarningsSync] Implied refresh (${reason}) updated ${updates} symbols for next two weeks`);
}

function isAfterWeeklyRefreshCutoff(now = new Date()) {
  const ct = getTimeInCentral(now);
  if (ct.weekday === 'Saturday' || ct.weekday === 'Sunday') return true;
  if (ct.weekday === 'Friday' && ct.hour >= EARNINGS_FRIDAY_REFRESH_HOUR_CT) return true;
  return false;
}

function isAfterImpliedCutoff(now = new Date()) {
  const ct = getTimeInCentral(now);
  const weekday = ct.weekday;
  const isImpliedRefreshDay = weekday === 'Sunday' || weekday === 'Monday' || weekday === 'Tuesday' || weekday === 'Wednesday' || weekday === 'Thursday';
  if (!isImpliedRefreshDay) return false;
  return ct.hour >= EARNINGS_IMPLIED_REFRESH_HOUR_CT;
}

async function ensureWeeklyCalendarRefreshIfDue(reason = 'job') {
  const now = new Date();
  const targetWeekStartIso = isoDateLocal(getTargetWeekStart(now));
  const shouldRefreshForWeek = isAfterWeeklyRefreshCutoff(now) && earningsRefreshState.lastWeeklyRefreshWeekStart !== targetWeekStartIso;
  if (!shouldRefreshForWeek && weeklyEarningsCache?.weekStart === targetWeekStartIso && Object.keys(weeklyEarningsCache.days || {}).length > 0) {
    return false;
  }
  if (earningsRefreshPromise) {
    await earningsRefreshPromise;
    return true;
  }
  // If the server was down at the Friday cutoff, it's possible we already
  // persisted a "next week" payload on disk. Promote that to the weekly
  // cache on first request after the cutoff so the UI reflects the new week
  // even if external providers are unavailable.
  try {
    const nextIsTarget = nextWeekEarningsCache && nextWeekEarningsCache.weekStart === targetWeekStartIso;
    const hasNextDays = nextWeekEarningsCache && Object.keys(nextWeekEarningsCache.days || {}).length > 0;
    const weeklyNotSet = !weeklyEarningsCache || weeklyEarningsCache.weekStart !== targetWeekStartIso || Object.keys(weeklyEarningsCache.days || {}).length === 0;
    if (nextIsTarget && hasNextDays && weeklyNotSet) {
      weeklyEarningsCache = {
        updatedAt: Date.now(),
        weekStart: nextWeekEarningsCache.weekStart,
        days: nextWeekEarningsCache.days
      };
      earningsRefreshState.lastWeeklyRefreshWeekStart = targetWeekStartIso;
      await saveEarningsCachesToDisk();
      console.log('[EarningsSync] Promoted persisted next-week to weekly cache after cutoff');
      return true;
    }
  } catch (e) {
    // best-effort only; fall through to normal refresh behavior
  }

  // Wrap refresh so we can recover from provider auth failures (e.g. Finnhub 401)
  earningsRefreshPromise = (async () => {
    try {
      await refreshWeeklyEarningsCalendar(reason);
    } catch (err) {
      console.error('[EarningsSync] Weekly refresh failed:', err?.message || err);
      // If Finnhub is unauthorized, advance the cached weekStart anyway so the UI
      // reflects the next week immediately and doesn't stall until the provider is fixed.
      const isFinnhub401 = String(err?.message || '').toLowerCase().includes('finnhub_http_401')
        || (err && err.response && err.response.status === 401);
      if (isFinnhub401) {
        try {
          weeklyEarningsCache.weekStart = targetWeekStartIso;
          weeklyEarningsCache.updatedAt = Date.now();
          // Best-effort: enrich existing cached rows with company short names so the UI can sort by name.
          try {
            const existingSymbols = Array.from(new Set(Object.values(weeklyEarningsCache.days || {}).flat().map(r => String(r.symbol || '').toUpperCase()).filter(Boolean)));
            for (const sym of existingSymbols) {
              try {
                const yahooSym = normalizeSymbolForYahoo(sym);
                const q = await withTimeout(yahooFinanceClient.quote(yahooSym), 7000, 'yf-quote-name-fallback');
                const name = q?.shortName || q?.longName || null;
                const short = sanitizeCompanyName(name, sym);
                Object.keys(weeklyEarningsCache.days || {}).forEach((d) => {
                  (weeklyEarningsCache.days[d] || []).forEach((row) => { if (String(row.symbol || '').toUpperCase() === sym) row.companyName = short; });
                });
                await new Promise(r => setTimeout(r, 60));
              } catch (_) {}
            }
          } catch (ee) {
            // ignore enrichment failures
          }
          await saveEarningsCachesToDisk();
          console.warn('[EarningsSync] Finnhub 401 - advanced weekStart to', targetWeekStartIso);
          return;
        } catch (e) {
          console.error('[EarningsSync] Failed to persist weekStart fallback:', e?.message || e);
          throw err;
        }
      }
      throw err;
    } finally {
      earningsRefreshPromise = null;
    }
  })();

  await earningsRefreshPromise;
  return true;
}

async function ensureImpliedRefreshIfDue(reason = 'job') {
  const now = new Date();
  const todayIso = isoDateInCentral(now);
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
  const hasCachedWeek = !!(weeklyEarningsCache?.weekStart && Object.keys(weeklyEarningsCache?.days || {}).length > 0);
  if (hasCachedWeek) {
    // Keep first paint snappy: serve cache immediately and refresh in background.
    ensureEarningsUpdatesIfDue('request').catch(() => {});
  } else {
    await ensureEarningsUpdatesIfDue('request');
  }
  try {
    hydrateEarningsDaysFromMoveCache(weeklyEarningsCache.days || {});
  } catch (_) {}
  try {
    const updated = await ensureSp500MoveHistoryCoverage(weeklyEarningsCache.days || {}, 'week-request');
    if (updated > 0) {
      weeklyEarningsCache.updatedAt = Date.now();
      await saveEarningsCachesToDisk();
    }
  } catch (_) {}
  try {
    const renamed = await ensureReadableSp500CompanyNames(weeklyEarningsCache.days || {}, 'week-request');
    if (renamed > 0) {
      weeklyEarningsCache.updatedAt = Date.now();
      await saveEarningsCachesToDisk();
    }
  } catch (_) {}
  // Ensure every row has a companyName (best-effort fallback to symbol) so UI sorting works.
  try {
    Object.keys(weeklyEarningsCache.days || {}).forEach((d) => {
      (weeklyEarningsCache.days[d] || []).forEach((row) => {
        if (!row.companyName) row.companyName = sanitizeCompanyName(null, String(row.symbol || '').toUpperCase());
      });
    });
  } catch (_) {}

  return res.json({
    updatedAt: weeklyEarningsCache.updatedAt || 0,
    weekStart: weeklyEarningsCache.weekStart || null,
    days: weeklyEarningsCache.days || {}
  });
});

app.post('/api/earnings/refresh-week', async (req, res) => {
  try {
    const force = String(req.query.force || req.body?.force || '').toLowerCase();
    if (force === '1' || force === 'true' || force === 'yes') {
      await refreshWeeklyEarningsCalendar('manual-force');
    } else {
      await ensureWeeklyCalendarRefreshIfDue('request');
    }
    return res.json({ ok: true, updatedAt: weeklyEarningsCache.updatedAt, weekStart: weeklyEarningsCache.weekStart });
  } catch (err) {
    return res.status(502).json({ error: 'weekly_refresh_failed', details: err?.message || String(err) });
  }
});

app.post('/api/earnings/implied-refresh', async (req, res) => {
  try {
    const force = String(req.query.force || req.body?.force || '').toLowerCase();
    if (force === '1' || force === 'true' || force === 'yes') {
      // Ensure next-week cache exists so force refresh can cover two upcoming weeks.
      try {
        const now = new Date();
        const currentTargetMonday = getTargetWeekStart(now);
        const nextMonday = new Date(currentTargetMonday);
        nextMonday.setDate(nextMonday.getDate() + 7);
        const nextWeekStartIso = isoDateLocal(nextMonday);
        if (nextWeekEarningsCache.weekStart !== nextWeekStartIso) {
          const range = getWeekRangeFromStart(nextMonday);
          const rawRows = await fetchFinnhubEarningsCalendar(range.fromIso, range.toIso);
          const byDay = rawRows.length > 0
            ? await buildEarningsDaysFromRows(rawRows, { syncMoveHistory: false, reason: 'manual-force-preload-next', maxNameSymbols: 40, maxNameDurationMs: 2500 })
            : {};
          nextWeekEarningsCache = { updatedAt: Date.now(), weekStart: nextWeekStartIso, days: byDay };
        }
      } catch (_) {}
      await refreshImpliedMovesForNextTwoWeeks('manual-force');
    } else {
      await ensureImpliedRefreshIfDue('request');
    }
    return res.json({ ok: true, updatedAt: weeklyEarningsCache.updatedAt, day: earningsRefreshState.lastImpliedRefreshDate });
  } catch (err) {
    return res.status(502).json({ error: 'implied_refresh_failed', details: err?.message || String(err) });
  }
});

app.get('/api/earnings/next-week', async (_req, res) => {
  const now = new Date();
  const currentTargetMonday = getTargetWeekStart(now);
  const nextMonday = new Date(currentTargetMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const nextWeekStartIso = isoDateLocal(nextMonday);
  try {

    // If this week is already cached, serve it immediately (do not pull again).
    if (
      nextWeekEarningsCache.weekStart === nextWeekStartIso &&
      nextWeekEarningsCache.updatedAt
    ) {
      try {
        const updated = await ensureSp500MoveHistoryCoverage(nextWeekEarningsCache.days || {}, 'next-week-request-cached');
        if (updated > 0) {
          nextWeekEarningsCache.updatedAt = Date.now();
          await saveEarningsCachesToDisk();
        }
      } catch (_) {}
      try {
        const renamed = await ensureReadableSp500CompanyNames(nextWeekEarningsCache.days || {}, 'next-week-request-cached');
        if (renamed > 0) {
          nextWeekEarningsCache.updatedAt = Date.now();
          await saveEarningsCachesToDisk();
        }
      } catch (_) {}
      return res.json({ updatedAt: nextWeekEarningsCache.updatedAt, weekStart: nextWeekEarningsCache.weekStart, days: nextWeekEarningsCache.days });
    }

    // If in-memory cache is empty, prefer on-disk enriched payload when available.
    if (!nextWeekEarningsCache.updatedAt || Object.keys(nextWeekEarningsCache.days || {}).length === 0) {
      try {
        const rawDisk = await fs.readFile(EARNINGS_NEXT_JSON_PATH, 'utf8');
        const parsedDisk = JSON.parse(rawDisk);
        if (parsedDisk && typeof parsedDisk.days === 'object' && parsedDisk.weekStart === nextWeekStartIso && Object.keys(parsedDisk.days || {}).length > 0) {
          nextWeekEarningsCache = { updatedAt: Date.now(), weekStart: parsedDisk.weekStart, days: parsedDisk.days };
          try {
            const renamed = await ensureReadableSp500CompanyNames(nextWeekEarningsCache.days || {}, 'next-week-request-disk');
            if (renamed > 0) nextWeekEarningsCache.updatedAt = Date.now();
          } catch (_) {}
          return res.json({ updatedAt: nextWeekEarningsCache.updatedAt, weekStart: nextWeekEarningsCache.weekStart, days: nextWeekEarningsCache.days });
        }
      } catch (_) {
        // ignore disk read errors and fall through to live fetch
      }
    }

    const { fromIso, toIso } = getWeekRangeFromStart(nextMonday);
    const rawRows = await fetchFinnhubEarningsCalendar(fromIso, toIso);
    if (!rawRows.length) {
      // If the provider returned no rows, prefer any enriched on-disk payload
      // so the UI doesn't show an empty "Next Week" when we have persisted data.
      try {
        const rawDisk = await fs.readFile(EARNINGS_NEXT_JSON_PATH, 'utf8');
        const parsedDisk = JSON.parse(rawDisk);
        if (parsedDisk && typeof parsedDisk.days === 'object' && parsedDisk.weekStart === nextWeekStartIso && Object.keys(parsedDisk.days || {}).length > 0) {
          nextWeekEarningsCache = { updatedAt: Date.now(), weekStart: parsedDisk.weekStart, days: parsedDisk.days };
          // persist current caches so on-disk and memory stay in sync
          await saveEarningsCachesToDisk();
          return res.json({ updatedAt: nextWeekEarningsCache.updatedAt, weekStart: nextWeekEarningsCache.weekStart, days: nextWeekEarningsCache.days });
        }
      } catch (_) {
        // ignore read/parse errors and fall through to returning an empty payload
      }
      nextWeekEarningsCache = { updatedAt: Date.now(), weekStart: nextWeekStartIso, days: {} };
      return res.json({ updatedAt: nextWeekEarningsCache.updatedAt, weekStart: nextWeekEarningsCache.weekStart, days: nextWeekEarningsCache.days });
    }
    const byDay = await buildEarningsDaysFromRows(rawRows, {
      syncMoveHistory: false,
      reason: 'next-week-request',
      maxNameSymbols: 60,
      maxNameDurationMs: 3000
    });

    nextWeekEarningsCache = { updatedAt: Date.now(), weekStart: nextWeekStartIso, days: byDay };
    try {
      const updated = await ensureSp500MoveHistoryCoverage(nextWeekEarningsCache.days || {}, 'next-week-request-live');
      if (updated > 0) {
        nextWeekEarningsCache.updatedAt = Date.now();
        await saveEarningsCachesToDisk();
      }
    } catch (_) {}
    return res.json({ updatedAt: nextWeekEarningsCache.updatedAt, weekStart: nextWeekEarningsCache.weekStart, days: nextWeekEarningsCache.days });
  } catch (err) {
    console.error('[EarningsSync] next-week fetch error:', err?.message || err);
    return res.json({ updatedAt: nextWeekEarningsCache.updatedAt || 0, weekStart: nextWeekStartIso, days: nextWeekEarningsCache.weekStart === nextWeekStartIso ? (nextWeekEarningsCache.days || {}) : {} });
  }
});

// Background implied-refresh trigger: if the server was down at the daily implied
// refresh cutoff, ensureImpliedRefreshIfDue will run on the first incoming
// request (best-effort, non-blocking) so implied moves are refreshed even when
// the scheduled job was missed.
app.use((req, _res, next) => {
  // Do not block the request; run in background and ignore errors.
  ensureImpliedRefreshIfDue('background-request').catch(() => {});
  next();
});

// Internal: accept an enriched next-week payload and set it in-memory + persist (admin only)
app.post('/internal/set-next-week', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload || typeof payload.days !== 'object') return res.status(400).json({ error: 'invalid_payload' });
    nextWeekEarningsCache = {
      updatedAt: Date.now(),
      weekStart: payload.weekStart || nextWeekEarningsCache.weekStart || null,
      days: payload.days
    };
    await saveEarningsCachesToDisk();
    return res.json({ ok: true, updatedAt: nextWeekEarningsCache.updatedAt, weekStart: nextWeekEarningsCache.weekStart });
  } catch (err) {
    return res.status(500).json({ error: 'set_next_failed', details: err?.message || String(err) });
  }
});


// ── Active Options / Ticker Options (Alpha Vantage + Yahoo Finance) ─────────
const ACTIVE_OPTIONS_JSON_PATH = './data/active_options.json';
const ACTIVE_OPTIONS_TODAY_JSON_PATH = './data/active_options_today.json';
const TICKER_OPTIONS_JSON_PATH = './data/options_by_ticker.json';
const OPTIONS_CACHE_TTL_MS = 60 * 60 * 1000;
const TICKER_OPTIONS_CACHE_TTL_MS = 30 * 60 * 1000;
const OPTIONS_RECOMMENDATION_CACHE_TTL_MS = Number(process.env.OPTIONS_RECOMMENDATION_CACHE_TTL_MS || (2 * 60 * 1000));
const ACTIVE_OPTIONS_TODAY_TTL_MS = 30 * 60 * 1000;
const CENTRAL_TZ = 'America/Chicago';
const ACTIVE_OPTIONS_REFRESH_START_MIN = 8 * 60 + 30; // 8:30 AM Central
const ACTIVE_OPTIONS_REFRESH_END_MIN = 15 * 60; // 3:00 PM Central
const ACTIVE_OPTIONS_TOP_SYMBOLS = 15;
const ACTIVE_OPTIONS_TOP_CONTRACTS = 15;

let activeOptionsCache = {
  updatedAt: 0,
  expiresAt: 0,
  items: [],
  baseSymbols: [],
  sourceStatus: { alphaVantage: 'degraded', yahooFinance: 'degraded' }
};
let activeOptionsRefreshPromise = null;
let activeOptionsTodayCache = {
  updatedAt: 0,
  expiresAt: 0,
  items: [],
  sourceStatus: { alphaVantage: 'degraded' }
};
let activeOptionsTodayRefreshPromise = null;
let tickerOptionsCache = {};
const tickerOptionsRefreshPromises = new Map();
let optionsRecommendationCache = {};
const optionsRecommendationRefreshPromises = new Map();
let investorRecommendationCache = {};
const investorRecommendationRefreshPromises = new Map();

function computeEma(values, period) {
  const vals = Array.isArray(values) ? values.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0) : [];
  if (vals.length === 0 || !Number.isFinite(period) || period <= 1) return null;
  const k = 2 / (period + 1);
  let ema = vals[0];
  for (let i = 1; i < vals.length; i += 1) ema = vals[i] * k + ema * (1 - k);
  return safe(ema);
}

function computeRsi(values, period = 14) {
  const vals = Array.isArray(values) ? values.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0) : [];
  if (vals.length < period + 1) return null;
  const gains = [];
  const losses = [];
  for (let i = vals.length - period; i < vals.length; i += 1) {
    const prev = vals[i - 1];
    const cur = vals[i];
    const diff = cur - prev;
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const avgGain = gains.reduce((s, v) => s + v, 0) / period;
  const avgLoss = losses.reduce((s, v) => s + v, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return safe(100 - (100 / (1 + rs)));
}

function findPutWallStrike(contracts, spotPrice = null) {
  const puts = Array.isArray(contracts)
    ? contracts.filter((c) => String(c?.type || '').toLowerCase() === 'put')
    : [];
  if (!puts.length) return null;
  const spot = safe(spotPrice);
  let best = null;
  for (const p of puts) {
    const strike = safe(p?.strike);
    const oi = Math.max(0, safe(p?.openInterest) || 0);
    if (!Number.isFinite(strike)) continue;
    if (Number.isFinite(spot) && strike > spot * 1.05) continue;
    if (!best || oi > best.oi) best = { strike, oi };
  }
  if (best) return best.strike;
  const fallback = puts
    .map((p) => ({ strike: safe(p?.strike), oi: Math.max(0, safe(p?.openInterest) || 0) }))
    .filter((x) => Number.isFinite(x.strike))
    .sort((a, b) => b.oi - a.oi)[0];
  return fallback?.strike ?? null;
}

function findCallWallStrike(contracts, spotPrice = null) {
  const calls = Array.isArray(contracts)
    ? contracts.filter((c) => String(c?.type || '').toLowerCase() === 'call')
    : [];
  if (!calls.length) return null;
  const spot = safe(spotPrice);
  let best = null;
  for (const c of calls) {
    const strike = safe(c?.strike);
    const oi = Math.max(0, safe(c?.openInterest) || 0);
    if (!Number.isFinite(strike)) continue;
    if (Number.isFinite(spot) && strike < spot * 0.95) continue;
    if (!best || oi > best.oi) best = { strike, oi };
  }
  if (best) return best.strike;
  const fallback = calls
    .map((c) => ({ strike: safe(c?.strike), oi: Math.max(0, safe(c?.openInterest) || 0) }))
    .filter((x) => Number.isFinite(x.strike))
    .sort((a, b) => b.oi - a.oi)[0];
  return fallback?.strike ?? null;
}

async function buildInvestorRecommendationForSymbol(symbol, options = {}) {
  const normalized = String(symbol || '').toUpperCase();
  const yahooSymbol = normalizeSymbolForYahoo(normalized);
  const horizonRaw = String(options?.horizon || 'all').toLowerCase();
  const horizon = ['short', 'medium', 'long', 'all'].includes(horizonRaw) ? horizonRaw : 'all';

  const [quote, summary, recInputs] = await Promise.all([
    withTimeout(yahooFinanceClient.quote(yahooSymbol), 9000, 'yf quote investor').catch(() => null),
    withTimeout(
      yahooFinanceClient.quoteSummary(yahooSymbol, {
        modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail']
      }),
      11000,
      'yf quoteSummary investor'
    ).catch(() => null),
    fetchRecommendationContractsSnapshot(normalized, { minDte: 7, maxDte: 90, maxExpiries: 8 }).catch(() => ({ contracts: [], quotePrice: null }))
  ]);

  const todayIso = isoDateLocal(new Date());
  const closes = await withTimeout(
    yahooFinanceClient.chart(yahooSymbol, {
      period1: addDaysIso(todayIso, -260),
      period2: todayIso,
      interval: '1d'
    }),
    12000,
    'yf chart investor'
  ).then((chart) => {
    const quotes = Array.isArray(chart?.quotes) ? chart.quotes : [];
    return quotes.map((q) => safe(q?.close)).filter((v) => Number.isFinite(v) && v > 0);
  }).catch(() => []);

  const spot = safe(quote?.regularMarketPrice)
    ?? safe(quote?.postMarketPrice)
    ?? safe(quote?.previousClose)
    ?? safe(recInputs?.quotePrice)
    ?? null;

  const targetPrice = safe(quote?.targetMeanPrice)
    ?? safe(summary?.financialData?.targetMeanPrice)
    ?? safe(summary?.financialData?.targetMeanPrice?.raw)
    ?? null;
  const peRatio = safe(quote?.trailingPE)
    ?? safe(quote?.forwardPE)
    ?? safe(summary?.defaultKeyStatistics?.forwardPE?.raw)
    ?? null;
  const industryPeAvg = safe(summary?.defaultKeyStatistics?.enterpriseToEbitda?.raw)
    ?? (Number.isFinite(peRatio) ? peRatio : null);
  const yoyGrowthRaw = safe(summary?.financialData?.revenueGrowth)
    ?? safe(summary?.financialData?.revenueGrowth?.raw)
    ?? null;
  const yoyRevGrowthPct = Number.isFinite(yoyGrowthRaw)
    ? (Math.abs(yoyGrowthRaw) <= 1 ? yoyGrowthRaw * 100 : yoyGrowthRaw)
    : null;

  const ema8 = computeEma(closes, 8);
  const ema50 = safe(quote?.fiftyDayAverage) ?? computeEma(closes, 50);
  const ema200 = safe(quote?.twoHundredDayAverage) ?? computeEma(closes, 200);
  const rsi14 = computeRsi(closes, 14);

  const contracts = Array.isArray(recInputs?.contracts) ? recInputs.contracts : [];
  const putWall = findPutWallStrike(contracts, spot);
  const callWall = findCallWallStrike(contracts, spot);
  const maxPain = (() => {
    const strikes = contracts
      .map((c) => safe(c?.strike))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (!strikes.length) return null;
    return strikes[Math.floor(strikes.length / 2)];
  })();
  const gammaFlip = (() => {
    if (Number.isFinite(putWall) && Number.isFinite(callWall)) {
      return Math.round(((putWall + callWall) / 2) * 100) / 100;
    }
    return Number.isFinite(maxPain) ? maxPain : null;
  })();

  const investor = buildInvestorRecommendationScorecard({
    horizon,
    spotPrice: spot,
    streetTargetPrice: targetPrice,
    fiftyDayEma: ema50,
    two00DayEma: ema200,
    ema8,
    peRatio,
    industryPeAvg,
    yoyRevGrowth: yoyRevGrowthPct,
    rsi14,
    putWall,
    gammaFlip,
    maxPain
  });

  return {
    symbol: normalized,
    track: 'INVESTOR',
    horizon,
    ...investor,
    asOf: new Date().toISOString(),
    sourceStatus: {
      yahooFinance: quote ? 'ok' : 'degraded',
      fundamentals: summary ? 'ok' : 'degraded',
      optionsStructure: contracts.length ? 'ok' : 'degraded'
    }
  };
}

function getAlphaVantageKey() {
  return String(process.env.ALPHA_VANTAGE_API_KEY || process.env.ALPHA_VANTAGE_KEY || '').trim();
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
   // Filter out unrealistic strikes (penny stocks < $0.10)
   if (!Number.isFinite(strike) || strike < 0.1) return null;
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
    expiresAt: Date.now() + TICKER_OPTIONS_CACHE_TTL_MS,
    sourceStatus,
    calls: normalizedCalls,
    puts: normalizedPuts
  };
}

async function loadActiveOptionsFromDisk() {
  let loaded = false;
  if (cosmos.isCosmosEnabled()) {
    try {
      const doc = await cosmos.loadActiveOptions();
      if (doc && Array.isArray(doc.items)) {
        activeOptionsCache = {
          updatedAt: Number(doc.updatedAt) || 0,
          expiresAt: Number(doc.expiresAt) || 0,
          items: doc.items,
          baseSymbols: Array.isArray(doc.baseSymbols) ? doc.baseSymbols : [],
          sourceStatus: doc.sourceStatus || { alphaVantage: 'degraded', yahooFinance: 'degraded' }
        };
        loaded = true;
      }
    } catch (_) {}
  }
  if (!loaded) {
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
}

async function saveActiveOptionsToDisk() {
  try {
    await fs.writeFile(ACTIVE_OPTIONS_JSON_PATH, JSON.stringify(activeOptionsCache, null, 2), 'utf8');
    if (cosmos.isCosmosEnabled()) cosmos.saveActiveOptions(activeOptionsCache).catch(() => {});
  } catch (err) {
    console.error('[OptionsActive] Save error:', err.message || err);
  }
}

async function loadActiveOptionsTodayFromDisk() {
  let loaded = false;
  if (cosmos.isCosmosEnabled()) {
    try {
      const doc = await cosmos.loadActiveOptionsToday();
      if (doc && Array.isArray(doc.items)) {
        activeOptionsTodayCache = {
          updatedAt: Number(doc.updatedAt) || 0,
          expiresAt: Number(doc.expiresAt) || 0,
          items: doc.items,
          sourceStatus: doc.sourceStatus || { alphaVantage: 'degraded' }
        };
        loaded = true;
      }
    } catch (_) {}
  }
  if (!loaded) {
    try {
      const raw = await fs.readFile(ACTIVE_OPTIONS_TODAY_JSON_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        activeOptionsTodayCache = {
          updatedAt: Number(parsed.updatedAt) || 0,
          expiresAt: Number(parsed.expiresAt) || 0,
          items: parsed.items,
          sourceStatus: parsed.sourceStatus || { alphaVantage: 'degraded' }
        };
      }
    } catch (_) {
      activeOptionsTodayCache = {
        updatedAt: 0,
        expiresAt: 0,
        items: [],
        sourceStatus: { alphaVantage: 'degraded' }
      };
    }
  }
}

async function saveActiveOptionsTodayToDisk() {
  try {
    await fs.writeFile(ACTIVE_OPTIONS_TODAY_JSON_PATH, JSON.stringify(activeOptionsTodayCache, null, 2), 'utf8');
    if (cosmos.isCosmosEnabled()) cosmos.saveActiveOptionsToday(activeOptionsTodayCache).catch(() => {});
  } catch (err) {
    console.error('[OptionsActiveToday] Save error:', err.message || err);
  }
}

function normalizeMostActiveStockRow(row) {
  const ticker = normalizeActiveTicker(row?.ticker);
  if (!ticker) return null;
  const parseNum = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return {
    ticker,
    price: parseNum(row?.price),
    changeAmount: parseNum(row?.change_amount),
    changePercentage: row?.change_percentage == null ? null : String(row.change_percentage),
    volume: parseNum(row?.volume)
  };
}

function extractTopOptionContractFromChain(symbol, chain) {
  const expirationDate = chain?.expirationDate ? isoDateOnly(chain.expirationDate) : null;
  const calls = Array.isArray(chain?.calls) ? chain.calls : [];
  const puts = Array.isArray(chain?.puts) ? chain.puts : [];
  const contracts = [
    ...calls.map((c) => normalizeOptionContract(c, symbol, 'CALL', expirationDate)).filter(Boolean),
    ...puts.map((p) => normalizeOptionContract(p, symbol, 'PUT', expirationDate)).filter(Boolean)
  ].sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));

  return contracts.length > 0 ? contracts[0] : null;
}

function getActiveOptionsTodaySnapshot() {
  return {
    updatedAt: activeOptionsTodayCache.updatedAt || 0,
    expiresAt: activeOptionsTodayCache.expiresAt || 0,
    sourceStatus: activeOptionsTodayCache.sourceStatus || { alphaVantage: 'degraded' },
    items: Array.isArray(activeOptionsTodayCache.items) ? activeOptionsTodayCache.items : []
  };
}

function getCentralClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    weekday: String(map.weekday || ''),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function isActiveOptionsRefreshWindowCST(now = new Date()) {
  const { weekday, hour, minute } = getCentralClockParts(now);
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const mins = hour * 60 + minute;
  return mins >= ACTIVE_OPTIONS_REFRESH_START_MIN && mins < ACTIVE_OPTIONS_REFRESH_END_MIN;
}

async function maybeRefreshActiveOptionsToday(reason = 'job') {
  const inWindow = isActiveOptionsRefreshWindowCST();
  const cached = getActiveOptionsTodaySnapshot();
  const hasCache = Array.isArray(cached.items) && cached.items.length > 0;

  // Off-hours: keep cached data as-is.
  if (!inWindow && hasCache) return cached;

  // If no cache exists (e.g., fresh startup), attempt one refresh even off-hours.
  if (activeOptionsTodayRefreshPromise) {
    await activeOptionsTodayRefreshPromise.catch(() => {});
    return getActiveOptionsTodaySnapshot();
  }

  activeOptionsTodayRefreshPromise = refreshActiveOptionsToday()
    .catch((err) => {
      console.error(`[OptionsActiveToday] refresh (${reason}) failed:`, err?.message || err);
    })
    .finally(() => {
      activeOptionsTodayRefreshPromise = null;
    });

  await activeOptionsTodayRefreshPromise;
  return getActiveOptionsTodaySnapshot();
}

async function refreshActiveOptionsToday() {
  const apiKey = getAlphaVantageKey();
  if (!apiKey) throw new Error('missing_alpha_vantage_key');

  const url = `${ALPHA_VANTAGE_API}?function=TOP_GAINERS_LOSERS&apikey=${encodeURIComponent(apiKey)}`;
  const res = await withTimeout(fetch(url), 10000, 'alpha-vantage top-gainers-losers active-today');
  const body = await res.json();
  if (!res.ok) throw new Error(`alpha_vantage_http_${res.status}`);
  if (body?.['Error Message'] || body?.Information || body?.Note) {
    throw new Error(body?.Information || body?.Note || body?.['Error Message'] || 'alpha_vantage_api_error');
  }

  const rawItems = Array.isArray(body?.most_actively_traded)
    ? body.most_actively_traded.map(normalizeMostActiveStockRow).filter(Boolean)
    : [];

  if (rawItems.length === 0) throw new Error('alpha_vantage_empty_most_actively_traded');

  // Enrich each active ticker with one highest-volume option contract (CALL/PUT + expiration).
  const sourceStatus = { alphaVantage: 'ok', yahooFinance: 'degraded' };
  const candidates = rawItems.slice(0, 25);
  const enrichedSettled = await Promise.allSettled(candidates.map(async (row) => {
    try {
      const { chain } = await fetchNearestOptionsSnapshot(row.ticker);
      const top = extractTopOptionContractFromChain(row.ticker, chain);
      if (!top) return null;
      return {
        ...row,
        type: top.type || null,
        expirationDate: top.expirationDate || null,
        strike: top.strike ?? null,
        optionVolume: top.volume ?? null,
        openInterest: top.openInterest ?? null,
        optionContract: top.contract || null
      };
    } catch (_) {
      return null;
    }
  }));

  const enriched = enrichedSettled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean);

  if (enriched.length > 0) {
    sourceStatus.yahooFinance = 'ok';
  } else {
    sourceStatus.yahooFinance = 'degraded';
  }

  // Keep option detail columns stable by reusing prior cached option fields per ticker.
  const prevByTicker = new Map(
    (Array.isArray(activeOptionsTodayCache?.items) ? activeOptionsTodayCache.items : [])
      .filter((x) => x && x.ticker)
      .map((x) => [String(x.ticker).toUpperCase(), x])
  );
  const enrichedByTicker = new Map(
    enriched
      .filter((x) => x && x.ticker)
      .map((x) => [String(x.ticker).toUpperCase(), x])
  );

  const merged = rawItems.map((row) => {
    const key = String(row.ticker || '').toUpperCase();
    const live = enrichedByTicker.get(key);
    if (live) return live;
    const prev = prevByTicker.get(key);
    if (!prev) return row;
    return {
      ...row,
      type: prev.type ?? null,
      expirationDate: prev.expirationDate ?? null,
      strike: prev.strike ?? null,
      optionVolume: prev.optionVolume ?? null,
      openInterest: prev.openInterest ?? null,
      optionContract: prev.optionContract ?? null
    };
  });

  const items = merged
    .sort((a, b) => {
      const av = Number(a?.optionVolume);
      const bv = Number(b?.optionVolume);
      const aHas = Number.isFinite(av);
      const bHas = Number.isFinite(bv);
      if (aHas && bHas && av !== bv) return bv - av;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return (Number(b?.volume) || 0) - (Number(a?.volume) || 0);
    })
    .slice(0, 20);

  activeOptionsTodayCache = {
    updatedAt: Date.now(),
    expiresAt: Date.now() + ACTIVE_OPTIONS_TODAY_TTL_MS,
    sourceStatus,
    items
  };
  await saveActiveOptionsTodayToDisk();
  return getActiveOptionsTodaySnapshot();
}

async function loadTickerOptionsFromDisk() {
  let loaded = false;
  if (cosmos.isCosmosEnabled()) {
    try {
      const map = await cosmos.loadTickerOptions();
      if (map && typeof map === 'object') {
        tickerOptionsCache = map;
        loaded = true;
      }
    } catch (_) {}
  }
  if (!loaded) {
    try {
      const raw = await fs.readFile(TICKER_OPTIONS_JSON_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      tickerOptionsCache = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
      tickerOptionsCache = {};
    }
  }
}

async function saveTickerOptionsToDisk() {
  try {
    await fs.writeFile(TICKER_OPTIONS_JSON_PATH, JSON.stringify(tickerOptionsCache, null, 2), 'utf8');
    if (cosmos.isCosmosEnabled()) cosmos.saveTickerOptions(tickerOptionsCache).catch(() => {});
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

async function fetchRecommendationContractsSnapshot(symbol, options = {}) {
  const normalized = String(symbol || '').toUpperCase();
  const yahooSymbol = normalizeSymbolForYahoo(normalized);
  const minDte = Number.isFinite(Number(options.minDte)) ? Number(options.minDte) : 7;
  const maxDte = Number.isFinite(Number(options.maxDte)) ? Number(options.maxDte) : 90;
  const maxExpiries = Number.isFinite(Number(options.maxExpiries)) ? Number(options.maxExpiries) : 10;

  const [optMeta, yq] = await Promise.all([
    withTimeout(yahooFinanceClient.options(yahooSymbol), 12000, 'yahoo-fin options meta'),
    withTimeout(yahooFinanceClient.quote(yahooSymbol), 7000, 'yahoo-fin quote').catch(() => null)
  ]);

  const quotePrice = safe(yq?.regularMarketPrice) ?? safe(yq?.previousClose) ?? null;
  const allExpirDates = Array.isArray(optMeta?.expirationDates) ? optMeta.expirationDates : [];
  const nowSec = Date.now() / 1000;

  const toEpochSec = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e11 ? v / 1000 : v) : null;
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isFinite(t) ? t / 1000 : null;
    }
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n > 1e11 ? n / 1000 : n;
      const d = new Date(v);
      const t = d.getTime();
      return Number.isFinite(t) ? t / 1000 : null;
    }
    return null;
  };

  const inWindow = (tsLike) => {
    const ts = toEpochSec(tsLike);
    if (!Number.isFinite(ts)) return false;
    const dte = (ts - nowSec) / (60 * 60 * 24);
    return Number.isFinite(dte) && dte >= minDte && dte <= maxDte;
  };

  const datesToFetch = allExpirDates
    .map((d) => toEpochSec(d))
    .filter((d) => Number.isFinite(d) && inWindow(d))
    .slice(0, maxExpiries);

  const contracts = [];
  const seen = new Set();

  const appendChainContracts = (chain, expTs) => {
    if (!chain) return;
    const expirationDate = isoDateOnly(new Date(Number(expTs) * 1000));
    const calls = Array.isArray(chain.calls) ? chain.calls : [];
    const puts = Array.isArray(chain.puts) ? chain.puts : [];

    for (const c of calls) {
      const base = normalizeOptionContract(c, normalized, 'CALL', expirationDate);
      if (!base) continue;
       // Filter out strikes that are unreasonably far from quote price (e.g., >500% away)
       if (Number.isFinite(quotePrice) && Number.isFinite(base.strike)) {
         const distPct = Math.abs(base.strike - quotePrice) / quotePrice * 100;
         if (distPct > 500) continue; // Skip strikes that are >500% away (likely corrupted data)
       }
      const key = String(base.contract || `call_${expirationDate}_${base.strike}`);
      if (seen.has(key)) continue;
      seen.add(key);
      contracts.push({ ...base, type: 'call', expiration: expirationDate, delta: safe(c?.delta), gamma: safe(c?.gamma) });
    }

    for (const p of puts) {
      const base = normalizeOptionContract(p, normalized, 'PUT', expirationDate);
      if (!base) continue;
       // Filter out strikes that are unreasonably far from quote price (e.g., >500% away)
       if (Number.isFinite(quotePrice) && Number.isFinite(base.strike)) {
         const distPct = Math.abs(base.strike - quotePrice) / quotePrice * 100;
         if (distPct > 500) continue; // Skip strikes that are >500% away (likely corrupted data)
       }
      const key = String(base.contract || `put_${expirationDate}_${base.strike}`);
      if (seen.has(key)) continue;
      seen.add(key);
      contracts.push({ ...base, type: 'put', expiration: expirationDate, delta: safe(p?.delta), gamma: safe(p?.gamma) });
    }
  };

  const nearestChain = Array.isArray(optMeta?.options) ? optMeta.options[0] : null;
  const nearestTs = toEpochSec(nearestChain?.expirationDate);
  if (nearestChain && Number.isFinite(nearestTs) && inWindow(nearestTs)) {
    appendChainContracts(nearestChain, nearestTs);
  }

  for (const expTs of datesToFetch) {
    try {
      if (Number.isFinite(nearestTs) && Math.abs(expTs - nearestTs) < 1) continue;
      const expIso = new Date(Number(expTs) * 1000).toISOString().slice(0, 10);
      const chainData = await withTimeout(
        yahooFinanceClient.options(yahooSymbol, { date: expIso }),
        10000,
        'yahoo-fin options exp'
      );
      const chain = Array.isArray(chainData?.options) ? chainData.options[0] : null;
      appendChainContracts(chain, expTs);
      await new Promise((r) => setTimeout(r, 80));
    } catch (_) {
      // best effort
    }
  }

  // Safety fallback if no contracts found in target DTE window.
  if (contracts.length === 0 && nearestChain) {
    const fallbackTs = Number.isFinite(nearestTs) ? nearestTs : nowSec;
    appendChainContracts(nearestChain, fallbackTs);
  }

  return { contracts, quotePrice };
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

async function buildOptionsRecommendationForSymbol(symbol, options = {}) {
  const normalized = String(symbol || '').toUpperCase();
  const yahooSymbol = normalizeSymbolForYahoo(normalized);
  const riskModeRaw = String(options.riskMode || 'balanced').toLowerCase();
  const riskMode = ['conservative', 'balanced', 'aggressive'].includes(riskModeRaw)
    ? riskModeRaw
    : 'balanced';
  const { contracts, quotePrice } = await fetchRecommendationContractsSnapshot(normalized, {
    minDte: 7,
    maxDte: 90,
    maxExpiries: 10
  });

  const [quoteSnap, quoteSummary] = await Promise.all([
    withTimeout(yahooFinanceClient.quote(yahooSymbol), 7000, 'yf quote recommendation').catch(() => null),
    withTimeout(
      yahooFinanceClient.quoteSummary(yahooSymbol, { modules: ['calendarEvents'] }),
      9000,
      'yf quoteSummary recommendation'
    ).catch(() => null)
  ]);

  if (!Array.isArray(contracts) || contracts.length === 0) {
    throw new Error(`Unable to build recommendation inputs for ${normalized}`);
  }

  // Best-effort volatility context using 4 months of daily closes.
  const todayIso = isoDateLocal(new Date());
  const closes = await withTimeout(
    yahooFinanceClient.chart(yahooSymbol, {
      period1: addDaysIso(todayIso, -120),
      period2: todayIso,
      interval: '1d'
    }),
    12000,
    'yf chart recommendation'
  ).then((chart) => {
    const quotes = Array.isArray(chart?.quotes) ? chart.quotes : [];
    return quotes
      .map((q) => safe(q?.close))
      .filter((v) => Number.isFinite(v) && v > 0);
  }).catch(() => []);

  const scorecard = buildOptionsRecommendationScorecard({
    symbol: normalized,
    spotPrice: quotePrice,
    contracts,
    historicalCloses: closes,
    riskMode,
    marketContext: {
      low52W: safe(quoteSnap?.fiftyTwoWeekLow),
      earningsDate: quoteSummary?.calendarEvents?.earnings?.earningsDate?.[0] || null,
      averageInsiderPrice: null
    }
  });

  return {
    ...scorecard,
    asOf: new Date().toISOString(),
    sourceStatus: {
      yahooFinance: 'ok',
      historicalVolatility: closes.length > 0 ? 'ok' : 'degraded'
    }
  };
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
  const sortedByVolume = contracts
    .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));

  // Keep one highest-volume option contract per ticker symbol.
  const bySymbol = new Map();
  for (const c of sortedByVolume) {
    const sym = String(c?.symbol || '').toUpperCase();
    if (!sym || bySymbol.has(sym)) continue;
    bySymbol.set(sym, c);
  }
  const sorted = Array.from(bySymbol.values())
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

const OPPORTUNITIES_CACHE_TTL_MS = Number(process.env.OPPORTUNITIES_CACHE_TTL_MS || (5 * 60 * 1000));
const OPPORTUNITIES_MIN_STOCK_MARKET_CAP = 2_000_000_000;
const OPPORTUNITIES_STOCK_FALLBACK = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA'];
// Keep broad market/style ETFs in the ETF tab.
// Sector SPDRs are intentionally reserved for the Sectors tab.
const OPPORTUNITIES_ETF_POOL = ['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'VEA', 'EFA', 'EEM', 'TLT'];
const OPPORTUNITIES_SECTOR_POOL = [
  { symbol: 'XLK', name: 'Technology' },
  { symbol: 'XLF', name: 'Financials' },
  { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLV', name: 'Health Care' },
  { symbol: 'XLI', name: 'Industrials' },
  { symbol: 'XLP', name: 'Consumer Staples' },
  { symbol: 'XLY', name: 'Consumer Discretionary' },
  { symbol: 'XLU', name: 'Utilities' },
  { symbol: 'XLB', name: 'Materials' },
  { symbol: 'XLRE', name: 'Real Estate' },
  { symbol: 'XLC', name: 'Communication Services' }
];
const OPPORTUNITIES_LEVERAGED_OR_INVERSE_ETFS = new Set([
  'TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'SOXL', 'SOXS', 'TECL', 'TECS',
  'LABU', 'LABD', 'FAS', 'FAZ', 'TNA', 'TZA', 'UDOW', 'SDOW',
  'SPXL', 'SPXS', 'TMF', 'TMV', 'NUGT', 'DUST', 'BOIL', 'KOLD',
  'TSLL', 'TSLQ', 'NVDL', 'NVDQ', 'QID', 'SDS', 'SSO', 'DXD'
]);
const OPPORTUNITIES_NON_COMMON_PRODUCTS = new Set([
  'BITO', 'GBTC', 'ETHE', 'SLV', 'GLD', 'USO', 'UNG', 'UUP', 'FXI'
]);
const OPPORTUNITIES_NON_EQUITY_QUOTE_TYPES = new Set([
  'ETF', 'ETN', 'MUTUALFUND', 'MONEYMARKET', 'INDEX', 'FUTURE',
  'CRYPTOCURRENCY', 'CURRENCY', 'OPTION'
]);

const opportunitiesCache = {
  stocks: { updatedAt: 0, expiresAt: 0, items: [] },
  etfs: { updatedAt: 0, expiresAt: 0, items: [] },
  sectors: { updatedAt: 0, expiresAt: 0, items: [] }
};

function normalizeOpportunityAssetType(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'stocks' || v === 'stock') return 'stocks';
  if (v === 'etfs' || v === 'etf') return 'etfs';
  if (v === 'sectors' || v === 'sector') return 'sectors';
  return 'stocks';
}

function average(values) {
  const vals = Array.isArray(values) ? values.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [];
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function clampNumber(n, min, max) {
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function getOpportunityStockPool() {
  const out = [];
  const seen = new Set();

  const etfAndSectorUniverse = new Set([
    ...OPPORTUNITIES_ETF_POOL,
    ...OPPORTUNITIES_SECTOR_POOL.map((x) => x.symbol)
  ]);

  const isEligibleStockSymbol = (sym) => {
    if (!sym) return false;
    if (etfAndSectorUniverse.has(sym)) return false;
    if (OPPORTUNITIES_LEVERAGED_OR_INVERSE_ETFS.has(sym)) return false;
    if (OPPORTUNITIES_NON_COMMON_PRODUCTS.has(sym)) return false;
    return true;
  };

  const pushSym = (s) => {
    const sym = normalizeActiveTicker(s);
    if (!sym || seen.has(sym) || !isEligibleStockSymbol(sym)) return;
    seen.add(sym);
    out.push(sym);
  };

  (Array.isArray(activeOptionsTodayCache?.items) ? activeOptionsTodayCache.items : [])
    .forEach((r) => pushSym(r?.ticker || r?.symbol));
  (Array.isArray(trendingCache?.symbols) ? trendingCache.symbols : [])
    .forEach((r) => pushSym(r?.symbol));
  OPPORTUNITIES_STOCK_FALLBACK.forEach((s) => pushSym(s));

  return out.slice(0, 12);
}

function getOpportunityUniverse(assetType) {
  if (assetType === 'stocks') {
    return getOpportunityStockPool().map((symbol) => ({ symbol, assetType: 'Stock', companyName: symbol }));
  }
  if (assetType === 'etfs') {
    return OPPORTUNITIES_ETF_POOL.map((symbol) => ({ symbol, assetType: 'ETF', companyName: symbol }));
  }
  return OPPORTUNITIES_SECTOR_POOL.map((s) => ({ symbol: s.symbol, assetType: 'Sector', companyName: s.name }));
}

function buildIvRankFromChain(chain, spotPrice) {
  const calls = Array.isArray(chain?.calls) ? chain.calls : [];
  const puts = Array.isArray(chain?.puts) ? chain.puts : [];
  const contracts = [...calls, ...puts];
  const ivVals = contracts
    .map((c) => safe(c?.impliedVolatility))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!ivVals.length) return { ivRank: null, impliedVolatilityPct: null, ivDataQuality: 'missing' };

  const minIv = Math.min(...ivVals);
  const maxIv = Math.max(...ivVals);
  const spot = safe(spotPrice);
  let atmIv = average(ivVals);

  if (Number.isFinite(spot)) {
    const ranked = contracts
      .map((c) => ({ strike: safe(c?.strike), iv: safe(c?.impliedVolatility) }))
      .filter((x) => Number.isFinite(x.strike) && Number.isFinite(x.iv) && x.iv > 0)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    if (ranked.length) {
      atmIv = ranked[0].iv;
    }
  }

  if (!Number.isFinite(atmIv) || !Number.isFinite(minIv) || !Number.isFinite(maxIv)) {
    return { ivRank: null, impliedVolatilityPct: null, ivDataQuality: 'missing' };
  }

  const impliedVolatilityPct = atmIv * 100;
  // Treat extremely small absolute IV as invalid feed artifact for scanner logic.
  // This prevents "IV 0.0%" rows from generating options strategy guidance.
  if (impliedVolatilityPct <= 0.5) {
    return { ivRank: null, impliedVolatilityPct: null, ivDataQuality: 'invalid_zero_like' };
  }

  const ivRange = maxIv - minIv;
  if (ivRange < 0.02) {
    return {
      ivRank: null,
      impliedVolatilityPct,
      ivDataQuality: 'compressed_range'
    };
  }

  return {
    ivRank: clampNumber(((atmIv - minIv) / ivRange) * 100, 0, 100),
    impliedVolatilityPct,
    ivDataQuality: 'ok'
  };
}

async function buildOpportunityMetrics(asset, spyReturn20) {
  const symbol = String(asset?.symbol || '').toUpperCase();
  const yahooSymbol = normalizeSymbolForYahoo(symbol);
  const [quote, chartPayload, optionsSnap] = await Promise.all([
    withTimeout(yahooFinanceClient.quote(yahooSymbol), 8000, 'opportunities quote').catch(() => null),
    withTimeout(
      yahooFinanceClient.chart(yahooSymbol, {
        period1: addDaysIso(isoDateLocal(new Date()), -300),
        period2: isoDateLocal(new Date()),
        interval: '1d'
      }),
      12000,
      'opportunities chart'
    ).catch(() => null),
    fetchNearestOptionsSnapshot(symbol).catch(() => null)
  ]);

  const closes = Array.isArray(chartPayload?.quotes)
    ? chartPayload.quotes.map((q) => safe(q?.close)).filter((v) => Number.isFinite(v) && v > 0)
    : [];

  const price = safe(quote?.regularMarketPrice)
    ?? safe(quote?.postMarketPrice)
    ?? safe(quote?.previousClose)
    ?? safe(optionsSnap?.quotePrice)
    ?? null;

  const sma50 = average(closes.slice(-50));
  const sma200 = average(closes.slice(-200));
  const rsi = computeRsi(closes, 14);
  const low20 = closes.length >= 20 ? Math.min(...closes.slice(-20)) : null;
  const high20 = closes.length >= 20 ? Math.max(...closes.slice(-20)) : null;
  const return20 = closes.length >= 21
    ? (((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100)
    : null;
  const relStrength20 = Number.isFinite(return20) && Number.isFinite(spyReturn20)
    ? (return20 - spyReturn20)
    : null;

  const isNearSupport = Number.isFinite(price) && Number.isFinite(low20) ? price <= low20 * 1.03 : false;
  const isNearResistance = Number.isFinite(price) && Number.isFinite(high20) ? price >= high20 * 0.97 : false;
  const m200Trend = Number.isFinite(price) && Number.isFinite(sma200) && price >= sma200 ? 'Bullish' : 'Bearish';
  const ivSnapshot = buildIvRankFromChain(optionsSnap?.chain, price);
  const ivRank = ivSnapshot?.ivRank;
  const optionsDataReliable = ivSnapshot?.ivDataQuality === 'ok' && Number.isFinite(ivSnapshot?.impliedVolatilityPct);
  const executionVehicle = optionsDataReliable
    ? 'Options + Equity'
    : 'Pure Equity Only (No Options Data Available)';

  if (asset?.assetType === 'Stock' && !optionsDataReliable) {
    console.warn(`[Opportunities] ${symbol}: options IV data unavailable (${ivSnapshot?.ivDataQuality || 'missing'})`);
  }

  return {
    ticker: symbol,
    companyName: sanitizeCompanyName(quote?.shortName, asset?.companyName || symbol) || symbol,
    assetType: asset?.assetType || 'Stock',
    quoteType: String(quote?.quoteType || '').toUpperCase(),
    marketCap: safe(quote?.marketCap),
    currentPrice: price,
    ivRank,
    impliedVolatilityPct: ivSnapshot?.impliedVolatilityPct ?? null,
    ivDataQuality: ivSnapshot?.ivDataQuality || 'missing',
    executionVehicle,
    rsi,
    volume: safe(quote?.regularMarketVolume),
    isNearSupport,
    isNearResistance,
    m200Trend,
    sma50,
    sma200,
    return20,
    relativeStrength20: relStrength20
  };
}

function buildOpportunityFromMetrics(m) {
  const ivRankTxt = Number.isFinite(m.ivRank) ? `${m.ivRank.toFixed(1)}%` : 'N/A';
  const ivAbsTxt = Number.isFinite(m.impliedVolatilityPct) ? `${m.impliedVolatilityPct.toFixed(1)}%` : 'N/A';
  const rsiTxt = Number.isFinite(m.rsi) ? m.rsi.toFixed(1) : 'N/A';
  const relTxt = Number.isFinite(m.relativeStrength20) ? `${m.relativeStrength20 >= 0 ? '+' : ''}${m.relativeStrength20.toFixed(1)}%` : 'N/A';
  const noOptionsData = String(m.executionVehicle || '').startsWith('Pure Equity Only');
  const lowIvForPremiumSell = Number.isFinite(m.ivRank) && m.ivRank < 15;
  const highIvForPremiumSell = Number.isFinite(m.ivRank) && m.ivRank >= 50;
  const sellStructureText = noOptionsData
    ? 'Use equity-only risk actions (trim, hedge, or directional shares) because options data is unavailable.'
    : (lowIvForPremiumSell
      ? 'Favor short-delta debit structures (for example Bear Put Spreads) or equity trim/short instead of short-premium trades while volatility is compressed.'
      : (highIvForPremiumSell
        ? 'Favor credit-based, short-vega structures (for example credit spreads) while volatility is rich.'
        : 'Use directional, defined-risk structures; avoid aggressive short-premium sizing when volatility is not elevated.'));

  const ivDataNote = m.ivDataQuality && m.ivDataQuality !== 'ok'
    ? ' Option-IV data quality is degraded; treat volatility-dependent setups cautiously.'
    : '';

  // Sector-first rotation rules.
  if (m.assetType === 'Sector' && Number.isFinite(m.relativeStrength20)) {
    if (m.relativeStrength20 >= 2 && Number.isFinite(m.rsi) && m.rsi < 72) {
      return {
        ...m,
        action: 'Buy',
        primaryReason: 'Relative strength rotation in favor of this sector',
        technicalDetails: `20D relative strength vs SPY is ${relTxt} with RSI ${rsiTxt}. Rotation and trend structure support long exposure.`
      };
    }
    if (m.relativeStrength20 <= -2 && Number.isFinite(m.rsi) && m.rsi <= 45) {
      return {
        ...m,
        action: 'Sell',
        primaryReason: 'Capital rotation away from this sector',
        technicalDetails: `20D relative strength vs SPY is ${relTxt} and RSI is ${rsiTxt}. IVR ${ivRankTxt}, ATM IV ${ivAbsTxt}. Risk of continued underperformance is elevated. ${sellStructureText}${ivDataNote}`
      };
    }
  }

  if (Number.isFinite(m.ivRank) && m.ivRank >= 70 && m.isNearResistance) {
    const label = m.assetType === 'Stock'
      ? 'Elevated IV at overhead resistance'
      : (m.assetType === 'ETF' ? 'High IV with macro resistance overhead' : 'High IV at sector ceiling');
    return {
      ...m,
      action: 'Sell',
      primaryReason: label,
      technicalDetails: `IV Rank is ${ivRankTxt} and ATM IV is ${ivAbsTxt}; price is pressing resistance. ${sellStructureText}${ivDataNote}`
    };
  }

  if (Number.isFinite(m.ivRank) && m.ivRank < 20 && m.isNearSupport && m.m200Trend === 'Bullish') {
    const label = m.assetType === 'Stock'
      ? 'Bullish support test with cheap option premiums'
      : (m.assetType === 'ETF' ? 'Institutional support with compressed volatility' : 'Sector support with low volatility regime');
    return {
      ...m,
      action: 'Buy',
      primaryReason: label,
      technicalDetails: noOptionsData
        ? `Trend is ${m.m200Trend} and price is near support, but options IV data is unavailable. Prefer pure-equity accumulation with defined stop risk.${ivDataNote}`
        : `IV Rank is ${ivRankTxt}, ATM IV is ${ivAbsTxt}, trend is ${m.m200Trend}, and price is near support. Favor debit-based/long-vega bullish entries while volatility is compressed.${ivDataNote}`
    };
  }

  if (Number.isFinite(m.rsi) && m.rsi >= 75) {
    return {
      ...m,
      action: 'Sell',
      primaryReason: 'Extreme overbought momentum extension',
      technicalDetails: `RSI is ${rsiTxt}, suggesting stretched momentum. IVR ${ivRankTxt}, ATM IV ${ivAbsTxt}. Mean-reversion probability is elevated. ${sellStructureText}${ivDataNote}`
    };
  }

  if (Number.isFinite(m.rsi) && m.rsi <= 30 && m.m200Trend === 'Bullish') {
    return {
      ...m,
      action: 'Buy',
      primaryReason: 'Oversold pullback inside bullish trend',
      technicalDetails: noOptionsData
        ? `RSI is ${rsiTxt} while the 200D trend remains ${m.m200Trend}. Options data is unavailable; use pure-equity re-entry with defined stop risk.${ivDataNote}`
        : `RSI is ${rsiTxt} while the 200D trend remains ${m.m200Trend}. Pullback offers risk-defined re-entry opportunity.`
    };
  }

  return {
    ...m,
    action: 'Hold',
    primaryReason: 'No high-conviction trigger',
    technicalDetails: 'Current metrics do not meet strict buy/sell rule thresholds.'
  };
}

function buildStockFallbackOpportunity(m) {
  if (!m || m.assetType !== 'Stock') return null;
  const rsi = Number(m.rsi);
  const rel = Number(m.relativeStrength20);
  const iv = Number(m.ivRank);
  const ivAbs = Number(m.impliedVolatilityPct);
  const noOptionsData = String(m.executionVehicle || '').startsWith('Pure Equity Only');
  const trendBull = String(m.m200Trend || '') === 'Bullish';
  const trendBear = String(m.m200Trend || '') === 'Bearish';

  const buyBias =
    (Number.isFinite(rsi) ? (50 - rsi) : 0) +
    (trendBull ? 8 : 0) +
    (Number.isFinite(rel) ? (Math.max(-6, Math.min(6, rel)) * 1.5) : 0);

  const sellBias =
    (Number.isFinite(rsi) ? (rsi - 50) : 0) +
    (trendBear ? 8 : 0) +
    (Number.isFinite(rel) ? (Math.max(-6, Math.min(6, -rel)) * 1.5) : 0);

  const isBuy = buyBias >= sellBias;
  const action = isBuy ? 'Buy' : 'Sell';
  const ivTxt = Number.isFinite(iv) ? `${iv.toFixed(1)}%` : 'N/A';
  const ivAbsTxt = Number.isFinite(ivAbs) ? `${ivAbs.toFixed(1)}%` : 'N/A';
  const rsiTxt = Number.isFinite(rsi) ? rsi.toFixed(1) : 'N/A';
  const relTxt = Number.isFinite(rel) ? `${rel >= 0 ? '+' : ''}${rel.toFixed(1)}%` : 'N/A';

  if (isBuy) {
    return {
      ...m,
      action,
      primaryReason: 'Momentum/trend composite buy setup',
      technicalDetails: noOptionsData
        ? `Fallback signal: RSI ${rsiTxt}, 20D relative strength vs SPY ${relTxt}, trend ${m.m200Trend || 'N/A'}. Options data unavailable; use pure-equity, defined-risk entries.`
        : `Fallback signal: RSI ${rsiTxt}, 20D relative strength vs SPY ${relTxt}, trend ${m.m200Trend || 'N/A'}, IV Rank ${ivTxt}, ATM IV ${ivAbsTxt}. Favor debit-based, defined-risk entries.`,
      _fallbackScore: buyBias
    };
  }

  const lowIv = Number.isFinite(iv) && iv < 15;
  const sellGuidance = lowIv
    ? 'Prefer short-delta debit structures or equity trim/short over short-premium when volatility is compressed.'
    : 'Premium-selling setups can be considered when volatility is sufficiently rich.';

  return {
    ...m,
    action,
    primaryReason: 'Momentum/trend composite sell setup',
    technicalDetails: noOptionsData
      ? `Fallback signal: RSI ${rsiTxt}, 20D relative strength vs SPY ${relTxt}, trend ${m.m200Trend || 'N/A'}. Options data unavailable; use pure-equity trim/hedge logic.`
      : `Fallback signal: RSI ${rsiTxt}, 20D relative strength vs SPY ${relTxt}, trend ${m.m200Trend || 'N/A'}, IV Rank ${ivTxt}, ATM IV ${ivAbsTxt}. ${sellGuidance}`,
    _fallbackScore: sellBias
  };
}

app.get('/api/opportunities', async (req, res) => {
  const assetType = normalizeOpportunityAssetType(req.query.assetType || req.query.type || 'stocks');
  const limit = Math.max(5, Math.min(60, Number(req.query.limit) || 30));

  const cached = opportunitiesCache[assetType];
  if (cached && cached.expiresAt > Date.now() && Array.isArray(cached.items) && cached.items.length > 0) {
    return res.json({
      assetType,
      updatedAt: cached.updatedAt,
      fromCache: true,
      items: cached.items.slice(0, limit)
    });
  }

  try {
    const universe = getOpportunityUniverse(assetType);
    if (!universe.length) {
      return res.json({ assetType, updatedAt: Date.now(), fromCache: false, items: [] });
    }

    const spyBase = await buildOpportunityMetrics({ symbol: 'SPY', companyName: 'SPY', assetType: 'ETF' }, null)
      .catch(() => null);
    const spyReturn20 = Number.isFinite(spyBase?.return20) ? spyBase.return20 : null;

    const settled = await Promise.allSettled(
      universe.map((asset) => buildOpportunityMetrics(asset, spyReturn20))
    );

    let allMetrics = settled
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter(Boolean);

    if (assetType === 'stocks') {
      allMetrics = allMetrics.filter((m) => {
        const sym = String(m?.ticker || '').toUpperCase();
        const qt = String(m?.quoteType || '').toUpperCase();
        const marketCap = Number(m?.marketCap);
        if (OPPORTUNITIES_NON_COMMON_PRODUCTS.has(sym)) return false;
        if (qt && OPPORTUNITIES_NON_EQUITY_QUOTE_TYPES.has(qt)) return false;
        if (!Number.isFinite(marketCap) || marketCap < OPPORTUNITIES_MIN_STOCK_MARKET_CAP) return false;
        return true;
      });
    }

    const evaluated = allMetrics
      .map((m) => buildOpportunityFromMetrics(m))
      .filter((x) => x && (x.action === 'Buy' || x.action === 'Sell'))
      .sort((a, b) => {
        const aIv = Number.isFinite(a.ivRank) ? a.ivRank : -1;
        const bIv = Number.isFinite(b.ivRank) ? b.ivRank : -1;
        if (bIv !== aIv) return bIv - aIv;
        return (Number(b.volume) || 0) - (Number(a.volume) || 0);
      });

    // Stocks can be sparse with strict triggers; backfill with top composite signals.
    if (assetType === 'stocks' && evaluated.length < 5) {
      const seen = new Set(evaluated.map((x) => String(x.ticker || '').toUpperCase()));
      const coreStocks = new Set(OPPORTUNITIES_STOCK_FALLBACK.map((s) => String(s).toUpperCase()));
      const fallback = allMetrics
        .filter((m) => !seen.has(String(m.ticker || '').toUpperCase()))
        .map((m) => buildStockFallbackOpportunity(m))
        .filter(Boolean)
        .sort((a, b) => {
          const aBase = Number(a._fallbackScore) || 0;
          const bBase = Number(b._fallbackScore) || 0;
          const aBoost = coreStocks.has(String(a.ticker || '').toUpperCase()) ? 4 : 0;
          const bBoost = coreStocks.has(String(b.ticker || '').toUpperCase()) ? 4 : 0;
          return (bBase + bBoost) - (aBase + aBoost);
        })
        .slice(0, 5 - evaluated.length)
        .map((x) => {
          const out = { ...x };
          delete out._fallbackScore;
          return out;
        });
      evaluated.push(...fallback);
    }

    const items = evaluated.slice(0, limit).map((o) => ({
      ticker: o.ticker,
      companyName: o.companyName,
      action: o.action,
      primaryReason: o.primaryReason,
      technicalDetails: o.technicalDetails,
      currentPrice: o.currentPrice,
      marketCap: o.marketCap,
      ivRank: o.ivRank,
      impliedVolatilityPct: o.impliedVolatilityPct,
      ivDataQuality: o.ivDataQuality,
      executionVehicle: o.executionVehicle,
      rsi: o.rsi,
      assetType: o.assetType,
      m200Trend: o.m200Trend,
      relativeStrength20: o.relativeStrength20
    }));

    opportunitiesCache[assetType] = {
      updatedAt: Date.now(),
      expiresAt: Date.now() + OPPORTUNITIES_CACHE_TTL_MS,
      items
    };

    return res.json({
      assetType,
      updatedAt: opportunitiesCache[assetType].updatedAt,
      fromCache: false,
      items
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Unable to build opportunities',
      assetType,
      details: err?.message || String(err)
    });
  }
});

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

// Alpha Vantage "today most active" list (stocks as proxy for options interest)
app.get('/api/active-options', async (_req, res) => {
  const cached = getActiveOptionsTodaySnapshot();
  const inRefreshWindow = isActiveOptionsRefreshWindowCST();

  // Off-hours (after 3:00 PM to before 8:30 AM Central): always use cached data.
  if (!inRefreshWindow && cached.items.length > 0) {
    return res.json({
      ...cached,
      fromCache: true,
      stale: !isEntryFresh(cached),
      offHoursCache: true
    });
  }

  if (isEntryFresh(cached) && cached.items.length > 0) {
    return res.json({ ...cached, fromCache: true, stale: false });
  }
  try {
    if (activeOptionsTodayRefreshPromise) {
      await activeOptionsTodayRefreshPromise;
    } else {
      activeOptionsTodayRefreshPromise = refreshActiveOptionsToday();
      await activeOptionsTodayRefreshPromise;
    }
    const fresh = getActiveOptionsTodaySnapshot();
    return res.json({ ...fresh, fromCache: false, stale: false });
  } catch (err) {
    if (cached.items.length > 0) {
      return res.json({
        ...cached,
        stale: true,
        fromCache: true,
        sourceStatus: { alphaVantage: 'degraded' },
        warning: err.message || 'active_options_today_refresh_failed'
      });
    }
    return res.status(502).json({
      error: 'Failed to fetch market data',
      sourceStatus: { alphaVantage: 'degraded' },
      details: err.message || 'active_options_today_refresh_failed'
    });
  } finally {
    activeOptionsTodayRefreshPromise = null;
  }
});

app.get('/api/options/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  const limit = Math.max(5, Math.min(100, Number(req.query.limit) || 20));
  const cached = tickerOptionsCache[symbol];
  const inRefreshWindow = isActiveOptionsRefreshWindowCST();
  const hasCached = !!(cached && ((cached.calls && cached.calls.length) || (cached.puts && cached.puts.length)));

  // Off-hours CST: serve cached ticker options and avoid refresh.
  if (!inRefreshWindow && hasCached) {
    return res.json({ ...cached, fromCache: true, stale: !isEntryFresh(cached), offHoursCache: true });
  }

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

app.get('/api/options/:symbol/recommendation', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const trackRaw = String(req.query.track || 'trading').toLowerCase();
  const track = ['trading', 'investor'].includes(trackRaw) ? trackRaw : 'trading';
  const horizonRaw = String(req.query.horizon || 'all').toLowerCase();
  const horizon = ['short', 'medium', 'long', 'all'].includes(horizonRaw) ? horizonRaw : 'all';

  const riskModeRaw = String(req.query.riskMode || 'balanced').toLowerCase();
  const riskMode = ['conservative', 'balanced', 'aggressive'].includes(riskModeRaw)
    ? riskModeRaw
    : 'balanced';
  const recommendationKey = `${track}:${symbol}:${riskMode}:${horizon}`;

  const cacheBucket = track === 'investor' ? investorRecommendationCache : optionsRecommendationCache;
  const inFlightBucket = track === 'investor' ? investorRecommendationRefreshPromises : optionsRecommendationRefreshPromises;

  const cached = cacheBucket[recommendationKey];
  if (isEntryFresh(cached) && cached?.payload) {
    return res.json({ ...cached.payload, fromCache: true, stale: false });
  }

  try {
    if (inFlightBucket.has(recommendationKey)) {
      await inFlightBucket.get(recommendationKey);
    } else {
      const promise = (async () => {
        const payload = track === 'investor'
          ? await buildInvestorRecommendationForSymbol(symbol, { horizon })
          : await buildOptionsRecommendationForSymbol(symbol, { riskMode });
        cacheBucket[recommendationKey] = {
          payload,
          updatedAt: Date.now(),
          expiresAt: Date.now() + OPTIONS_RECOMMENDATION_CACHE_TTL_MS
        };
      })();
      inFlightBucket.set(recommendationKey, promise);
      await promise;
    }

    const fresh = cacheBucket[recommendationKey];
    if (!fresh?.payload) {
      throw new Error(`Unable to build ${track} recommendation inputs for ${symbol}`);
    }
    return res.json({ ...fresh.payload, fromCache: false, stale: false });
  } catch (err) {
    if (cached?.payload) {
      return res.json({
        ...cached.payload,
        fromCache: true,
        stale: true,
        warning: err.message || 'recommendation_refresh_failed'
      });
    }
    return res.status(502).json({
      error: `Unable to build recommendation for ${symbol}`,
      details: err.message || 'recommendation_failed'
    });
  } finally {
    inFlightBucket.delete(recommendationKey);
  }
});

// ── Options chain by time horizon (months=3|6|9|12) ────────────────────────
const horizonOptionsCache = {};
const HORIZON_OPTIONS_TTL_MS = 30 * 60 * 1000; // 30 minutes

app.get('/api/options/:symbol/chain', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  const sortBy = String(req.query.sortBy || 'volume');
  const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 20));
  const inRefreshWindow = isActiveOptionsRefreshWindowCST();

  // Buckets: 0-3, 3-6, 6-9, 9-12, 12+
  const bucketRaw = String(req.query.bucket || '').trim();
  const monthsRaw = Number(req.query.months);
  let bucket = bucketRaw;
  if (!bucket) {
    // Backward-compat for old months query parameter.
    if (monthsRaw <= 3 || !Number.isFinite(monthsRaw)) bucket = '0-3';
    else if (monthsRaw <= 6) bucket = '3-6';
    else if (monthsRaw <= 9) bucket = '6-9';
    else if (monthsRaw <= 12) bucket = '9-12';
    else bucket = '12+';
  }

  const bucketRanges = {
    '0-3': { min: 0, max: 3 },
    '3-6': { min: 3, max: 6 },
    '6-9': { min: 6, max: 9 },
    '9-12': { min: 9, max: 12 },
    '12+': { min: 12, max: null }
  };
  const range = bucketRanges[bucket] || bucketRanges['0-3'];
  const cacheKey = `${symbol}_${bucket}`;

  const cached = horizonOptionsCache[cacheKey];

  // Off-hours CST: serve cached chain bucket and avoid refresh.
  if (!inRefreshWindow && cached && Array.isArray(cached.data) && cached.data.length > 0) {
    const result = sortBy === 'openInterest'
      ? [...cached.data].sort((a, b) => (Number(b.openInterest) || 0) - (Number(a.openInterest) || 0)).slice(0, limit)
      : cached.data.slice(0, limit);
    return res.json({
      symbol,
      bucket,
      rangeMonths: range,
      sortBy,
      fromCache: true,
      stale: !(cached.expiresAt > Date.now()),
      offHoursCache: true,
      contracts: result,
      updatedAt: cached.updatedAt
    });
  }

  if (cached && cached.expiresAt > Date.now()) {
    const result = sortBy === 'openInterest'
      ? [...cached.data].sort((a, b) => (Number(b.openInterest) || 0) - (Number(a.openInterest) || 0)).slice(0, limit)
      : cached.data.slice(0, limit);
    return res.json({ symbol, bucket, rangeMonths: range, sortBy, fromCache: true, contracts: result, updatedAt: cached.updatedAt });
  }

  try {
    const yahooSymbol = normalizeSymbolForYahoo(symbol);
    const optMeta = await withTimeout(yahooFinanceClient.options(yahooSymbol), 12000, 'yf-options-meta');
    const allExpirDates = Array.isArray(optMeta?.expirationDates) ? optMeta.expirationDates : [];
    const quoteResult = await withTimeout(yahooFinanceClient.quote(yahooSymbol), 7000, 'yf-quote').catch(() => null);
    const underlyingPrice = safe(quoteResult?.regularMarketPrice) ?? null;

    const nowSec = Date.now() / 1000;
    const toEpochSec = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        return v > 1e11 ? v / 1000 : v;
      }
      if (v instanceof Date) {
        const t = v.getTime();
        return Number.isFinite(t) ? t / 1000 : null;
      }
      if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n > 1e11 ? n / 1000 : n;
        const d = new Date(v);
        const t = d.getTime();
        return Number.isFinite(t) ? t / 1000 : null;
      }
      return null;
    };

    const inBucket = (tsLike) => {
      const ts = toEpochSec(tsLike);
      if (!Number.isFinite(ts)) return false;
      const monthsAhead = (ts - nowSec) / (60 * 60 * 24 * 30.4375);
      if (!Number.isFinite(monthsAhead) || monthsAhead < 0) return false;
      if (range.max == null) return monthsAhead >= range.min;
      return monthsAhead >= range.min && monthsAhead < range.max;
    };

    // expirationDates are Unix timestamps in seconds
    const validDates = allExpirDates
      .map((d) => toEpochSec(d))
      .filter((d) => Number.isFinite(d) && inBucket(d));
    const datesToFetch = validDates.slice(0, 16);
    const allContracts = [];
    const seenContracts = new Set();

    // Always include nearest chain already loaded in initial meta call (no extra request)
    const nearestChain = Array.isArray(optMeta?.options) ? optMeta.options[0] : null;
    if (nearestChain) {
      const nearestTs = toEpochSec(nearestChain.expirationDate);
      const includeNearest = nearestTs != null ? inBucket(nearestTs) : false;
      if (includeNearest) {
      const expDate0 = nearestChain.expirationDate
        ? isoDateOnly(typeof nearestChain.expirationDate === 'number'
            ? new Date(nearestChain.expirationDate * 1000)
            : new Date(nearestChain.expirationDate))
        : null;
      const calls0 = (nearestChain.calls || []).map((c) => normalizeOptionContract(c, symbol, 'CALL', expDate0)).filter(Boolean);
      const puts0 = (nearestChain.puts || []).map((p) => normalizeOptionContract(p, symbol, 'PUT', expDate0)).filter(Boolean);
      for (const c of [...calls0, ...puts0]) {
        const key = String(c.contract || `${c.type}_${c.expirationDate}_${c.strike}`);
        if (!seenContracts.has(key)) {
          seenContracts.add(key);
          allContracts.push(c);
        }
      }
      }
    }

    for (const expTs of datesToFetch) {
      try {
        const expIso = new Date(Number(expTs) * 1000).toISOString().slice(0, 10);
        const chainData = await withTimeout(
          yahooFinanceClient.options(yahooSymbol, { date: expIso }),
          10000,
          'yf-options-exp'
        );
        const chain = Array.isArray(chainData?.options) ? chainData.options[0] : null;
        if (!chain) continue;
        const expirationDate = isoDateOnly(new Date(expTs * 1000));
        const calls = (chain.calls || []).map((c) => normalizeOptionContract(c, symbol, 'CALL', expirationDate)).filter(Boolean);
        const puts = (chain.puts || []).map((p) => normalizeOptionContract(p, symbol, 'PUT', expirationDate)).filter(Boolean);
        for (const c of [...calls, ...puts]) {
          const key = String(c.contract || `${c.type}_${c.expirationDate}_${c.strike}`);
          if (!seenContracts.has(key)) {
            seenContracts.add(key);
            allContracts.push(c);
          }
        }
      } catch (_) {}
    }

    const sorted = allContracts
      .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
      .slice(0, 50);

    horizonOptionsCache[cacheKey] = { data: sorted, expiresAt: Date.now() + HORIZON_OPTIONS_TTL_MS, updatedAt: Date.now() };

    const result = sortBy === 'openInterest'
      ? [...sorted].sort((a, b) => (Number(b.openInterest) || 0) - (Number(a.openInterest) || 0)).slice(0, limit)
      : sorted.slice(0, limit);

    return res.json({ symbol, bucket, rangeMonths: range, sortBy, underlyingPrice, fromCache: false, contracts: result, updatedAt: Date.now() });
  } catch (err) {
    const c2 = horizonOptionsCache[cacheKey];
    if (c2 && c2.data && c2.data.length > 0) {
      return res.json({ symbol, bucket, rangeMonths: range, sortBy, fromCache: true, stale: true, contracts: c2.data.slice(0, limit), warning: err.message });
    }
    return res.status(502).json({ error: `Unable to load options chain for ${symbol}`, details: err.message });
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
    const inlineScript = `<script>window.INITIAL_TRENDING_DATA=${serializeForInlineScript(getTrendingSnapshot())};window.INITIAL_ACTIVE_OPTIONS_DATA=${serializeForInlineScript(getActiveOptionsTodaySnapshot())};</script>`;
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
      await cosmos.initCosmos();
      await loadEarningsCachesFromDisk();
      await ensureEarningsUpdatesIfDue('startup');
      setInterval(() => ensureEarningsUpdatesIfDue('job').catch(() => {}), 15 * 60 * 1000);
      await loadActiveOptionsFromDisk();
      await loadActiveOptionsTodayFromDisk();
      await loadTickerOptionsFromDisk();
      setInterval(() => refreshActiveOptions().catch(() => {}), 60 * 60 * 1000);
      await maybeRefreshActiveOptionsToday('startup');
      setInterval(() => {
        maybeRefreshActiveOptionsToday('job').catch(() => {});
      }, 30 * 60 * 1000);
    } catch (err) {
      console.error('[Options] Startup initialization failed:', err.message || err);
    }
  })().catch(() => {});
  loadTrendingSnapshotFromDisk()
    .then(() => updateTrendingCache())
    .then(() => {
      startTrendingPoller();
      console.log(`Trending poller started (interval ${TRENDING_POLL_INTERVAL_MS}ms)`);
      // Warm market indices cache periodically (every 5 minutes)
      try {
        const warmUrl = `http://localhost:${PORT}/api/market-indices`;
        setInterval(() => {
          fetch(warmUrl).catch(() => {});
        }, 5 * 60 * 1000);

        // Schedule: run a Sunday 7pm Central job to ensure `nextWeekEarningsCache` is populated
        // Runs once per Sunday after the configured hour (default 19 = 7pm Central)
        try {
          let sunday7LastRun = null;
          setInterval(async () => {
            try {
              const now = new Date();
              const ct = getTimeInCentral(now);
              const ctIso = isoDateInCentral(now);
              const refreshHour = EARNINGS_IMPLIED_REFRESH_HOUR_CT || 19;
              if (ct.weekday === 'Sunday' && ct.hour >= refreshHour && sunday7LastRun !== ctIso) {
                sunday7LastRun = ctIso;
                try {
                  const raw = await fs.readFile(EARNINGS_NEXT_JSON_PATH, 'utf8');
                  const parsed = JSON.parse(raw || '{}');
                  if (parsed && typeof parsed.days === 'object' && Object.keys(parsed.days || {}).length > 0) {
                    // Load into next-week cache
                    nextWeekEarningsCache = { updatedAt: Date.now(), weekStart: parsed.weekStart || null, days: parsed.days };
                    console.log('[EarningsSync] Sunday 7pm job: loaded next-week from disk');

                    // If weekly cache is not yet advanced, promote next-week -> weekly
                    try {
                      if (!weeklyEarningsCache.weekStart || weeklyEarningsCache.weekStart !== nextWeekEarningsCache.weekStart) {
                        weeklyEarningsCache = {
                          updatedAt: Date.now(),
                          weekStart: nextWeekEarningsCache.weekStart,
                          days: nextWeekEarningsCache.days
                        };
                        earningsRefreshState.lastWeeklyRefreshWeekStart = nextWeekEarningsCache.weekStart;
                        console.log('[EarningsSync] Sunday 7pm job: promoted next-week to weekly cache (weekStart=' + nextWeekEarningsCache.weekStart + ')');
                      }
                    } catch (e) {
                      console.error('[EarningsSync] Sunday 7pm promotion failed:', e?.message || e);
                    }

                    // Persist caches before attempting prewarm
                    try { await saveEarningsCachesToDisk(); } catch (_) {}

                    // Prewarm the week after the promoted week (so Next Week is ready)
                    try {
                      const promotedMonday = new Date(nextWeekEarningsCache.weekStart ? new Date(nextWeekEarningsCache.weekStart) : new Date());
                      promotedMonday.setDate(promotedMonday.getDate() + 7);
                      const twoWeeksStartIso = isoDateLocal(promotedMonday);
                      const range2 = getWeekRangeFromStart(promotedMonday);
                      const rawRows2 = await fetchFinnhubEarningsCalendar(range2.fromIso, range2.toIso).catch(() => []);
                      const byDay2 = rawRows2.length > 0
                        ? await buildEarningsDaysFromRows(rawRows2, { syncMoveHistory: false, reason: 'sunday-scheduled-prewarm-next', maxNameSymbols: 60, maxNameDurationMs: 3000 })
                        : {};
                      nextWeekEarningsCache = { updatedAt: Date.now(), weekStart: twoWeeksStartIso, days: byDay2 };
                      await saveEarningsCachesToDisk();
                      console.log('[EarningsSync] Sunday 7pm job: prewarmed next-week for', twoWeeksStartIso);
                    } catch (e) {
                      console.error('[EarningsSync] Sunday 7pm prewarm failed:', e?.message || e);
                    }
                  }
                } catch (e) {
                  console.error('[EarningsSync] Sunday 7pm job failed loading next-week from disk:', e?.message || e);
                }
                try {
                  await refreshImpliedMovesForNextTwoWeeks('sunday-scheduled');
                  console.log('[EarningsSync] Sunday 7pm job: implied moves refreshed for next two weeks');
                } catch (e) {
                  console.error('[EarningsSync] Sunday 7pm job implied-refresh failed:', e?.message || e);
                }
              }
            } catch (e) {
              // swallow
            }
          }, 5 * 60 * 1000);
        } catch (e) {
          console.error('[EarningsSync] Failed to start Sunday scheduler:', e?.message || e);
        }
        // Do an initial warm after startup
        fetch(warmUrl).catch(() => {});
      } catch (e) {}
    })
    .catch((error) => {
      startTrendingPoller();
      console.error(`Trending poller started with stale cache: ${error?.message || error}`);
    });
});
