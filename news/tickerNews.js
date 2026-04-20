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
const DIRECT_FEED_PREFERRED_WINDOW_MS = 6 * 60 * 60 * 1000; // prefer direct-feed articles up to 6 hours
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

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
  { name: "FT Global Economy", url: "https://www.ft.com/global-economy?format=rss", type: "direct" },
  { name: "FT Companies", url: "https://www.ft.com/companies?format=rss", type: "direct" },
  { name: "FT Markets", url: "https://www.ft.com/markets?format=rss", type: "direct" },
  { name: "FT Technology", url: "https://www.ft.com/technology?format=rss", type: "direct" },
  { name: "WSJ US Business", url: "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness", type: "direct" },
  { name: "WSJ Markets (DJ)", url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", type: "direct" },
  { name: "WSJ - WSJD", url: "https://feeds.content.dowjones.io/public/rss/RSSWSJD", type: "direct" },
  { name: "MarketWatch Top Stories", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", type: "direct" },
  { name: "MarketWatch Realtime", url: "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines", type: "direct" },
  { name: "MarketWatch Bulletins", url: "https://feeds.content.dowjones.io/public/rss/mw_bulletins", type: "direct" },
  { name: "MarketWatch MarketPulse", url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse", type: "direct" },
  { name: "Dow Jones - Social Economy", url: "https://feeds.content.dowjones.io/public/rss/socialeconomyfeed", type: "direct" },
  { name: "Thomson Reuters IR", url: "https://ir.thomsonreuters.com/rss/news-releases.xml?items=15", type: "direct" },
  { name: "Reuters Business", url: "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best", type: "direct" },
  { name: "Reuters", url: "reuters.com", type: "google" },
  { name: "NDTV Profit", url: "ndtvprofit.com", type: "google" },
  { name: "Barrons", url: "barrons.com", type: "google" }
];

const rssParser = new Parser({ customFields: { item: ["source"] } });
const SPOOFED_USER_AGENT = process.env.SPOOFED_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
const SPOOFED_ACCEPT = "application/rss+xml,application/xml;q=0.9,*/*;q=0.8";
const newsCache = new Map();
const GENERIC_COMPANY_TOKENS = new Set([
  "bank",
  "group",
  "holding",
  "holdings",
  "capital",
  "financial",
  "financials",
  "technology",
  "technologies",
  "international",
  "global",
  "energy",
  "resources",
  "pharmaceuticals",
  "therapeutics",
  "company",
  "companies",
  "corporation"
]);

function needsHeaderSpoof(url) {
  if (!url) return false;
  return url.includes("thomsonreuters.com") || url.includes("feeds.content.dowjones.io") || url.includes("feeds.a.dj.com") || url.includes("a.dj.com");
}

async function fetchFeedWithOptionalHeaders(url) {
  if (needsHeaderSpoof(url) && typeof fetch === "function") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": SPOOFED_USER_AGENT, Accept: SPOOFED_ACCEPT },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const text = await res.text();
      return await rssParser.parseString(text);
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }
  return await rssParser.parseURL(url);
}

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
  const aTs = Number(a.publishedTs || 0);
  const bTs = Number(b.publishedTs || 0);
  if (aTs !== bTs) return bTs - aTs;
  if (a.preferredPriority !== b.preferredPriority) return a.preferredPriority - b.preferredPriority;
  return 0;
}

function getPrimaryCompanyAlias(companyName) {
  return String(companyName || "")
    .split(/\s+/)
    .map((token) => token.trim())
    .find((token) => token.length >= 4 && !GENERIC_COMPANY_TOKENS.has(token.toLowerCase())) || "";
}

function buildTickerGoogleSourceUrl(domain, ticker, companyName, companyAlias = "") {
  const searchTerms = [`"${ticker}"`];
  if (companyName) searchTerms.push(`"${companyName}"`);
  if (companyAlias && companyAlias.toLowerCase() !== String(companyName || "").toLowerCase()) {
    searchTerms.push(`"${companyAlias}"`);
  }
  const q = `site:${domain} (${searchTerms.join(" OR ")}) (stock OR market OR earnings OR guidance) when:24h`;
  return `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

export async function fetchGoogleTickerNews(ticker, companyName = "", options = {}) {
  const normalizedCompanyName = normalizeCompanyNameForNews(companyName);
  const maxItems = Math.max(1, Math.min(20, Number(options.maxItems) || NEWS_MAX_ITEMS));
  const key = `${String(ticker || "").toUpperCase()}::${normalizedCompanyName.toLowerCase()}::${maxItems}`;
  const cached = newsCache.get(key);
  const now = Date.now();

  if (cached?.data && cached.expiresAt > now) return cached.data;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const data = await fetchGoogleTickerNewsRaw(ticker, normalizedCompanyName, { maxItems });
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

export async function fetchGoogleTickerNewsRaw(ticker, companyName = "", options = {}) {
  try {
    const now = Date.now();
    const maxItems = Math.max(1, Math.min(20, Number(options.maxItems) || NEWS_MAX_ITEMS));
    const tickerLower = String(ticker || "").toLowerCase();
    const companyLower = String(companyName || "").toLowerCase();
    const companyAlias = getPrimaryCompanyAlias(companyName);
    const companyAliasLower = companyAlias.toLowerCase();
    const companyTokens = companyLower.split(/\s+/).filter(Boolean);
    function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    const tickerWordRe = new RegExp('\\b' + escapeRegExp(tickerLower) + '\\b', 'i');
    const spamTerms = ["newsletter", "subscribe"];
    const analystActionTerms = [
      " keeps ",
      " maintains ",
      " raises ",
      " lowers ",
      " cuts ",
      " trims ",
      " retains ",
      " initiates ",
      " upgrades ",
      " downgrades ",
      " price target",
      " rating on ",
      " rating for ",
      " coverage on ",
      " coverage of "
    ];

    let allItems = [];
    const feedPromises = TICKER_NEWS_SOURCES.map(async (sourceConfig) => {
      const feedUrl = sourceConfig.type === "direct"
        ? sourceConfig.url
        : buildTickerGoogleSourceUrl(sourceConfig.url, ticker, companyName, companyAlias);
      try {
        const feed = await fetchFeedWithOptionalHeaders(feedUrl);
        const items = Array.isArray(feed?.items) ? feed.items : [];
        return items.map((item) => ({ item, sourceConfig }));
      } catch (e) {
        return [];
      }
    });

    const feedResults = await Promise.all(feedPromises);
    for (const items of feedResults) allItems.push(...items);

    const exactTerms = [`intitle:"${ticker}"`];
    if (companyName) exactTerms.push(`intitle:"${companyName}"`);
    if (companyAlias && companyAlias.toLowerCase() !== companyLower) {
      exactTerms.push(`intitle:"${companyAlias}"`);
    }

    const broadTerms = [`"${ticker}"`];
    if (companyName) broadTerms.push(`"${companyName}"`);
    if (companyAlias && companyAlias.toLowerCase() !== companyLower) {
      broadTerms.push(`"${companyAlias}"`);
    }

    const genericQueries = [
      `${exactTerms.join(" OR ")} when:24h`,
      `(${broadTerms.join(" OR ")}) (stock OR market OR earnings OR guidance) when:24h`,
      companyName ? `"${companyName}" (stock OR market OR earnings OR guidance) when:24h` : null,
      companyAlias ? `"${companyAlias}" ${ticker} (stock OR market OR earnings OR guidance) when:24h` : null
    ].filter(Boolean);

    const genericGoogleUrls = [...new Set(genericQueries)].map((query) => (
      `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
    ));

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
        // Match ticker as a whole word (avoids partial matches like 'gas' when searching 'gs')
        const hasTicker = tickerLower ? tickerWordRe.test(headline) : false;
        // Allow company name variants: match any token (e.g., 'goldman' from 'Goldman Sachs')
        const hasCompany = companyTokens.length ? companyTokens.some(tok => headline.includes(tok)) : false;
        const isSpam = spamTerms.some((term) => headline.includes(term));
        const startsWithCompany = (companyLower && headline.startsWith(companyLower))
          || (companyAliasLower && headline.startsWith(companyAliasLower));
        const looksLikeAnalystNote = !hasTicker
          && startsWithCompany
          && analystActionTerms.some((term) => headline.includes(term));
        const tooOld = n.publishedTs > 0 ? (now - n.publishedTs) > THREE_DAYS_MS : false;
        return (hasTicker || hasCompany) && !isSpam && !looksLikeAnalystNote && !tooOld;
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

    // First 6 hours: prefer specific direct sources only.
    // If none are available, fall back to Google sources.
    const preferredDirectInWindow = sourcePriorityItems.filter((item) => {
      if (item.sourceType !== "direct") return false;
      if (!isPreferredNewsSource(item.source)) return false;
      const ageMs = now - (item.publishedTs || 0);
      return ageMs >= 0 && ageMs <= DIRECT_FEED_PREFERRED_WINDOW_MS;
    });

    let effectiveItems;
    if (preferredDirectInWindow.length > 0) {
      // Keep preferred direct items at the front but allow other sourcePriorityItems
      // (including other direct and google) to fill remaining slots so we can reach maxItems.
      const prefKeys = new Set(preferredDirectInWindow.map(i => (i.url || '') + '::' + (i.publishedTs || 0)));
      effectiveItems = [
        ...sourcePriorityItems.filter(i => prefKeys.has((i.url || '') + '::' + (i.publishedTs || 0))),
        ...sourcePriorityItems.filter(i => !prefKeys.has((i.url || '') + '::' + (i.publishedTs || 0)))
      ];
    } else {
      // No preferred direct items — use all source-priority items (includes direct and google)
      effectiveItems = sourcePriorityItems;
    }

    const groups = [];
    for (const article of effectiveItems) {
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
          sourceType: article.sourceType,
          normalizedTitle: article.normalizedTitle,
          prefixHash: article.prefixHash,
          primarySource: article.source || "Unknown",
          sources: new Set([article.source || "Unknown"])
        });
      }
    }

    const sortedGroups = groups
      .sort((a, b) => compareTickerItems(a, b, now))

    // Strong preference: keep direct-feed articles from the first 90 minutes at the top,
    // then fill remaining slots from other sources.
    const directPreferredGroups = sortedGroups.filter((g) => (
      g.sourceType === "direct"
      && g.publishedTs > 0
      && (now - g.publishedTs) <= DIRECT_FEED_PREFERRED_WINDOW_MS
    ));
    if (directPreferredGroups.length > 0) {
      const directSet = new Set(directPreferredGroups.map((g) => `${g.url}::${g.publishedTs}`));
      const others = sortedGroups.filter((g) => !directSet.has(`${g.url}::${g.publishedTs}`));
      const selected = [...directPreferredGroups, ...others].slice(0, maxItems);
      return selected.map((g) => ({
          title: g.title,
          url: g.url,
          source: g.primarySource || Array.from(g.sources).join(", "),
          publishedAt: g.publishedAt,
          relativeTime: formatRelativeTime(g.publishedAt)
        }));
    }

    const recentGroups = sortedGroups.filter((g) => g.publishedTs > 0 && (now - g.publishedTs) <= TWO_HOURS_MS);
    const selectedGroups = recentGroups.length >= maxItems
      ? recentGroups.slice(0, maxItems)
      : sortedGroups.slice(0, maxItems);

    return selectedGroups
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
