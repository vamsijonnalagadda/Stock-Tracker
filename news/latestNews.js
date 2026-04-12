import Parser from "rss-parser";
import stringSimilarity from "string-similarity";
import {
  normalizeSourceForPreference,
  normalizeNewsTitle,
  firstNWordPrefix,
  formatRelativeTime,
  extractNewsSource,
  canonicalizeSourceName
} from "./newsUtils.js";
import { getKeywordWeight } from "./newsWeight.js";

const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const OVERALL_NEWS_MAX_ITEMS = Number(process.env.OVERALL_NEWS_MAX_ITEMS || 5);
const OVERALL_NEWS_MAX_PER_SOURCE = Number(process.env.OVERALL_NEWS_MAX_PER_SOURCE || 1);
const NEWS_CACHE_TTL_SECONDS = Number(process.env.NEWS_CACHE_TTL_SECONDS || 600);
const HIGH_PRIORITY_WEIGHT_THRESHOLD = Number(process.env.HIGH_PRIORITY_WEIGHT_THRESHOLD || 50);

const CONFIG = {
  SOURCES: [
    { name: "CNBC", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", type: "direct" },
    { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", type: "direct" },
    { name: "CNN Business", url: "http://rss.cnn.com/rss/edition_business.rss", type: "direct" },
    { name: "CNN Top Stories", url: "http://rss.cnn.com/rss/edition.rss", type: "direct" },
    { name: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", type: "direct" },
    { name: "Bloomberg Tech", url: "https://feeds.bloomberg.com/technology/news.rss", type: "direct" },
    { name: "NY Times Business", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", type: "direct" },
    { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", type: "direct" },
    { name: "Fox Business", url: "http://feeds.foxnews.com/foxnews/business", type: "direct" },
    { name: "Forbes Business", url: "https://www.forbes.com/business/feed/", type: "direct" },
    { name: "Reuters", url: "reuters.com", type: "google" },
    { name: "NDTV Profit", url: "ndtvprofit.com", type: "google" },
    { name: "Barrons", url: "barrons.com", type: "google" }
  ]
};

const rssParser = new Parser({ customFields: { item: ["source"] } });
let overallNewsCache = null;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

function sourceKeyFromName(sourceName) {
  return normalizeSourceForPreference(sourceName || "Unknown");
}

function buildGoogleSourceUrl(domain) {
  const query = `site:${domain} (stock OR market OR economy OR fed OR inflation OR earnings) when:24h`;
  return `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function compareLatestItems(a, b, nowTs) {
  if (a.priority !== b.priority) return a.priority - b.priority;

  const aInLast3h = (nowTs - (a.publishedTs || 0)) <= THREE_HOURS_MS;
  const bInLast3h = (nowTs - (b.publishedTs || 0)) <= THREE_HOURS_MS;
  if (aInLast3h !== bInLast3h) return aInLast3h ? -1 : 1;

  if (aInLast3h && bInLast3h) {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.publishedTs - a.publishedTs;
  }

  if (b.publishedTs !== a.publishedTs) return b.publishedTs - a.publishedTs;
  return b.weight - a.weight;
}

function isInLast3Hours(item, nowTs) {
  return (nowTs - (item?.publishedTs || 0)) <= THREE_HOURS_MS;
}

export async function fetchOverallLatestNews() {
  const now = Date.now();
  if (overallNewsCache?.data && overallNewsCache.expiresAt > now) return overallNewsCache.data;
  if (overallNewsCache?.promise) return overallNewsCache.promise;

  const promise = (async () => {
    let allItems = [];

    for (const sourceConfig of CONFIG.SOURCES) {
      const feedUrl = sourceConfig.type === "direct"
        ? sourceConfig.url
        : buildGoogleSourceUrl(sourceConfig.url);

      try {
        const feed = await rssParser.parseURL(feedUrl);
        const items = Array.isArray(feed?.items) ? feed.items : [];
        allItems.push(...items.map((item) => ({ item, sourceConfig })));
      } catch {
        // Continue with remaining sources.
      }
    }

    const normalizedItems = allItems
      .map(({ item, sourceConfig }) => {
        const rawTitle = String(item.title || '').trim();
        const extractedSource = canonicalizeSourceName(extractNewsSource(item, rawTitle));
        const source = sourceConfig.name || extractedSource;
        const cleanedTitle = rawTitle.replace(/\s+-\s+[A-Za-z0-9 .&'\-]{2,}$/g, '').trim();
        const publishedAt = item.isoDate || item.pubDate || null;
        const publishedTs = Date.parse(publishedAt || '') || 0;
        const normalizedTitle = normalizeNewsTitle(cleanedTitle || rawTitle);
        const prefixHash = firstNWordPrefix(cleanedTitle || rawTitle, 5);
        const priority = sourceConfig.type === "direct" ? 0 : 1;
        const weight = getKeywordWeight(cleanedTitle || rawTitle, source);
        return {
          title: cleanedTitle || rawTitle,
          url: item.link || null,
          source,
          sourceConfigKey: sourceKeyFromName(sourceConfig.name),
          sourceType: sourceConfig.type,
          publishedAt,
          publishedTs,
          normalizedTitle,
          prefixHash,
          priority,
          weight
        };
      })
      .filter((n) => n.title && n.url)
      .sort((a, b) => compareLatestItems(a, b, now));

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

    const unique = [];
    const uniqueSourceCounts = new Map();
    for (const item of sourcePriorityItems) {
      let merged = false;
      for (const existing of unique) {
        const duplicate = existing.prefixHash === item.prefixHash
          || stringSimilarity.compareTwoStrings(existing.normalizedTitle, item.normalizedTitle) > 0.72;
        if (!duplicate) continue;

        const itemBetter = compareLatestItems(item, existing, now) < 0;

        if (itemBetter) {
          const oldKey = existing.sourceConfigKey || sourceKeyFromName(existing.source);
          const newKey = item.sourceConfigKey || sourceKeyFromName(item.source);
          if (oldKey !== newKey) {
            uniqueSourceCounts.set(oldKey, Math.max(0, (uniqueSourceCounts.get(oldKey) || 0) - 1));
            uniqueSourceCounts.set(newKey, (uniqueSourceCounts.get(newKey) || 0) + 1);
          }
          existing.title = item.title;
          existing.url = item.url;
          existing.source = item.source;
          existing.sourceConfigKey = item.sourceConfigKey;
          existing.sourceType = item.sourceType;
          existing.publishedAt = item.publishedAt;
          existing.publishedTs = item.publishedTs;
          existing.priority = item.priority;
          existing.weight = item.weight;
        }
        merged = true;
        break;
      }
      if (!merged) {
        const sourceKey = item.sourceConfigKey || sourceKeyFromName(item.source);
        const count = uniqueSourceCounts.get(sourceKey) || 0;
        if (count < OVERALL_NEWS_MAX_PER_SOURCE) {
          uniqueSourceCounts.set(sourceKey, count + 1);
          unique.push(item);
        }
      }
      if (unique.length >= OVERALL_NEWS_MAX_ITEMS) break;
    }

    const hasRecentHighPriority = unique.some(
      (item) => isInLast3Hours(item, now) && item.weight >= HIGH_PRIORITY_WEIGHT_THRESHOLD
    );

    const gatedItems = hasRecentHighPriority
      ? unique.filter((item) => !isInLast3Hours(item, now) || item.weight >= HIGH_PRIORITY_WEIGHT_THRESHOLD)
      : unique;

    const selected = [];
    const sourceCounts = new Map();

    for (const item of gatedItems.sort((a, b) => compareLatestItems(a, b, now))) {
      const sourceKey = item.sourceConfigKey || sourceKeyFromName(item.source);
      const count = sourceCounts.get(sourceKey) || 0;
      if (count >= OVERALL_NEWS_MAX_PER_SOURCE) continue;
      sourceCounts.set(sourceKey, count + 1);
      selected.push(item);
      if (selected.length >= OVERALL_NEWS_MAX_ITEMS) break;
    }

    return selected
      .map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source,
        publishedAt: n.publishedAt,
        relativeTime: formatRelativeTime(n.publishedAt)
      }));
  })();

  overallNewsCache = { promise };
  try {
    const data = await promise;
    overallNewsCache = { data, expiresAt: Date.now() + NEWS_CACHE_TTL_SECONDS * 1000 };
    return data;
  } catch (error) {
    overallNewsCache = null;
    return [];
  }
}
