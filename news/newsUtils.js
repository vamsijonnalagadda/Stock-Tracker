import stringSimilarity from "string-similarity";

export const PREFERRED_NEWS_SOURCES = [
  "CNBC", "Reuters", "Yahoo Finance", "Bloomberg",
  "Financial Times", "The Street", "Forbes",
  "Wall Street Journal", "Barrons", "MarketWatch", "NDTV Profit"
];

export function normalizeNewsTitle(title) {
  return String(title || "")
    .replace(/\s+-\s+[A-Za-z0-9 .&'\-]{2,}$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function firstNWordPrefix(text, n = 5) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(0, n)
    .join(" ");
}

export function extractNewsSource(item, title) {
  const sourceFromFeed = item?.source?.title || item?.creator || null;
  if (sourceFromFeed) return String(sourceFromFeed).trim();

  const rawTitle = String(title || "").trim();
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx > 0 && idx < rawTitle.length - 3) {
    return rawTitle.slice(idx + 3).trim();
  }
  return "Unknown";
}

export function normalizeSourceForPreference(sourceName) {
  const normalized = String(sourceName || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.includes("yahoo finance")) {
    return "yahoo finance";
  }
  return normalized;
}

export function canonicalizeSourceName(sourceName) {
  return normalizeSourceForPreference(sourceName) === "yahoo finance"
    ? "Yahoo Finance"
    : String(sourceName || "Unknown").trim();
}

export function isPreferredNewsSource(sourceName) {
  const normalized = normalizeSourceForPreference(sourceName);
  return PREFERRED_NEWS_SOURCES.some((source) => {
    const preferredNormalized = normalizeSourceForPreference(source);
    return normalized.includes(preferredNormalized);
  });
}

export function formatRelativeTime(dateValue) {
  const ts = Date.parse(dateValue || "");
  if (!Number.isFinite(ts)) return "Unknown time";

  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

export function normalizeCompanyNameForNews(companyName) {
  return String(companyName || "")
    .replace(/\b(inc\.?|corp\.?|corporation|company|co\.?|limited|ltd\.?|plc|holdings?)\b/gi, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export { stringSimilarity };
