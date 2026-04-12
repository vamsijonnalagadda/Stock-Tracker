import Parser from "rss-parser";
import { stringSimilarity } from "./newsUtils.js";
import {
  normalizeNewsTitle,
  firstNWordPrefix,
  extractNewsSource,
  canonicalizeSourceName,
  normalizeSourceForPreference,
  isPreferredNewsSource,
  formatRelativeTime,
  normalizeCompanyNameForNews
} from "./newsUtils.js";

const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const NEWS_MAX_ITEMS = Number(process.env.NEWS_MAX_ITEMS || 5);
const NEWS_CACHE_TTL_SECONDS = Number(process.env.NEWS_CACHE_TTL_SECONDS || 600);
const ONE_HOUR_MS = 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const TICKER_NEWS_SOURCES = [
  { name: "CNBC", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", type: "direct" },
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", type: "direct" },
  { name: "CNN Business", url: "http://rss.cnn.com/rss/edition_business.rss", type: "direct" },
  { name: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", type: "direct" },
  { name: "Bloomberg Tech", url: "https://feeds.bloomberg.com/technology/news.rss", type: "direct" },
  { name: "NY Times Business", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", type: "direct" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", type: "direct" },
  { name: "Fox Business", url: "http://feeds.foxnews.com/foxnews/business", type: "direct" },
  { name: "Forbes Business", url: "https://www.forbes.com/business/feed/", type: "direct" },
  { name: "Reuters", url: "reuters.com", type: "google" },
  { name: "NDTV Profit", url: "ndtvprofit.com", type: "google" },
  { name: "Barrons", url: "barrons.com", type: "google" }
];

const rssParser = new Parser({ customFields: { item: ["source"] } });
const newsCache = new Map();

function sourceKeyFromName(sourceName) {
  return normalizeSourceForPreference(sourceName || "Unknown");
}

// Tier: direct+≤1hr (0) > direct+1-2hr (1) > google or direct>2hr (2)
function tickerTier(item, nowTs) {
  if (item.sourceType === "direct") {
    const age = nowTs - (item.publishedTs || 0);
    if (age <= ONE_HOUR_MS) return 0;
    if (age <= TWO_HOURS_MS) return 1;
  }
  return 2;
}

function compareTickerItems(a, b, nowTs) {
  const ta = tickerTier(a, nowTs);
  const tb = tickerTier(b, nowTs);
  if (ta !== tb) return ta - tb;
  if (a.preferredPriority !== b.preferredPriority) return a.preferredPriority - b.preferredPriority;
  return b.publishedTs - a.publishedTs;
}

function buildTickerGoogleSourceUrl(domain, ticker, companyName) {
  const q = companyName
    ? `site:${domain} ("${ticker}" OR "${companyName}") (stock OR market OR earnings OR guidance) when:24h`
    : `site:${domain} "${ticker}" (stock OR market OR earnings OR guidance) when:24h`;
  return `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

export async function fetchGoogleTickerNews(ticker, companyName = "") {
  const normalizedCompanyName = normalizeCompanyNameForNews(companyName);
  const key = `${String(ticker || "").toUpperCase()}::${normalizedCompanyName.toLowerCase()}`;
  const cached = newsCache.get(key);
  const now = Date.now();

  if (cached?.data && cached.expiresAt > now) return cached.data;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const data = await fetchGoogleTickerNewsRaw(ticker, normalizedCompanyName);
    newsCache.set(key, { data, expiresAt: Date.now() + NEWS_CACHE_TTL_SECONDS * 1000 });
    return data;
  })();

  newsCache.set(key, { promise });
  try {
    return await promise;
  } finally {
    const latest = newsCache.get(key);
    if (latest?.promise && !latest?.data) newsCache.delete(key);
  }
}

export async function fetchGoogleTickerNewsRaw(ticker, companyName = "") {
  try {
    const now = Date.now();
    const tickerLower = String(ticker || "").toLowerCase();
    const companyLower = String(companyName || "").toLowerCase();
    const spamTerms = ["newsletter", "subscribe"];

    let allItems = [];
    for (const sourceConfig of TICKER_NEWS_SOURCES) {
      const feedUrl = sourceConfig.type === "direct"
        ? sourceConfig.url
        : buildTickerGoogleSourceUrl(sourceConfig.url, ticker, companyName);
      try {
        const feed = await rssParser.parseURL(feedUrl);
        const items = Array.isArray(feed?.items) ? feed.items : [];
        allItems.push(...items.map((item) => ({ item, sourceConfig })));
      } catch (e) {
        // ignore
      }
    }

    const exactQuery = companyName
      ? `intitle:"${ticker}" OR intitle:"${companyName}" when:24h`
      : `intitle:"${ticker}" when:24h`;

    const fallbackQuery = companyName
      ? `${ticker} ${companyName} stock when:24h`
      : `${ticker} stock when:24h`;

    const genericGoogleUrls = [
      `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(exactQuery)}&hl=en-US&gl=US&ceid=US:en`,
      `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(fallbackQuery)}&hl=en-US&gl=US&ceid=US:en`
    ];

    for (const url of genericGoogleUrls) {
      try {
        const feed = await rssParser.parseURL(url);
        const items = Array.isArray(feed?.items) ? feed.items : [];
        allItems.push(...items.map((item) => ({ item, sourceConfig: { name: "Google Search", type: "google" } })));
      } catch (e) {
        // ignore
      }
    }

    const normalizedItems = allItems
      .map(({ item, sourceConfig }) => {
        const rawTitle = String(item.title || "").trim();
        const extractedSource = canonicalizeSourceName(extractNewsSource(item, rawTitle));
        const source = sourceConfig.name === "Google Search"
          ? extractedSource
          : (sourceConfig.name || extractedSource);
        const sourceConfigKey = sourceConfig.name === "Google Search"
          ? sourceKeyFromName(extractedSource)
          : sourceKeyFromName(sourceConfig.name);
        const cleanedTitle = rawTitle.replace(/\s+-\s+[A-Za-z0-9 .&'\-]{2,}$/g, "").trim();
        const publishedAt = item.isoDate || item.pubDate || null;
        const publishedTs = Date.parse(publishedAt || "") || 0;
        return {
          title: cleanedTitle || rawTitle,
          url: item.link || null,
          source,
          sourceType: sourceConfig.type,
          sourceConfigKey,
          publishedAt,
          publishedTs,
          normalizedTitle: normalizeNewsTitle(cleanedTitle || rawTitle),
          priority: sourceConfig.type === "direct" ? 0 : 1,
          preferredPriority: isPreferredNewsSource(source) ? 0 : 1,
          prefixHash: firstNWordPrefix(cleanedTitle || rawTitle, 5)
        };
      })
      .filter((n) => {
        if (!n.title || !n.url) return false;
        const headline = n.title.toLowerCase();
        const hasTicker = headline.includes(tickerLower);
        const hasCompany = companyLower ? headline.includes(companyLower) : false;
        const isSpam = spamTerms.some((term) => headline.includes(term));
        return (hasTicker || hasCompany) && !isSpam;
      })
      .sort((a, b) => compareTickerItems(a, b, now));

    const latestDirectBySource = new Map();
    for (const item of normalizedItems) {
      if (item.sourceType !== "direct") continue;
      const prevTs = latestDirectBySource.get(item.sourceConfigKey) || 0;
      if (item.publishedTs > prevTs) {
        latestDirectBySource.set(item.sourceConfigKey, item.publishedTs);
      }
    }

    const sourcePriorityItems = normalizedItems.filter((item) => {
      if (item.sourceType !== "google") return true;
      const latestDirectTs = latestDirectBySource.get(item.sourceConfigKey) || 0;
      return latestDirectTs <= 0 || item.publishedTs > latestDirectTs;
    });

    const groups = [];
    for (const article of sourcePriorityItems) {
      let merged = false;
      for (const group of groups) {
        const similarity = stringSimilarity.compareTwoStrings(article.normalizedTitle, group.normalizedTitle);
        if (article.prefixHash === group.prefixHash || similarity > 0.7) {
          const articleBetter = compareTickerItems(article, group, now) < 0;
          if (articleBetter) {
            group.title = article.title;
            group.url = article.url;
            group.publishedAt = article.publishedAt;
            group.publishedTs = article.publishedTs;
            group.priority = article.priority;
            group.preferredPriority = article.preferredPriority;
            group.primarySource = article.source || "Unknown";
          }
          group.sources.add(article.source || "Unknown");
          merged = true;
          break;
        }
      }
      if (!merged) {
        groups.push({
          title: article.title,
          url: article.url,
          publishedAt: article.publishedAt,
          publishedTs: article.publishedTs,
          priority: article.priority,
          preferredPriority: article.preferredPriority,
          normalizedTitle: article.normalizedTitle,
          prefixHash: article.prefixHash,
          primarySource: article.source || "Unknown",
          sources: new Set([article.source || "Unknown"])
        });
      }
    }

    return groups
      .sort((a, b) => compareTickerItems(a, b, now))
      .slice(0, NEWS_MAX_ITEMS)
      .map((g) => ({
        title: g.title,
        url: g.url,
        source: g.primarySource || Array.from(g.sources).join(", "),
        publishedAt: g.publishedAt,
        relativeTime: formatRelativeTime(g.publishedAt)
      }));
  } catch (error) {
    return [];
  }
}
