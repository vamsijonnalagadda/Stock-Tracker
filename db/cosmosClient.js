/**
 * Azure Cosmos DB client for stock-tracker.
 *
 * Free-tier budget:  1,000 RU/s + 25 GB — forever free.
 * This module provisions a SHARED 400 RU/s database so all containers
 * draw from one pool that sits comfortably inside the free limit.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Database: stocktracker   (400 RU/s shared — free tier safe)   │
 * ├─────────────────┬───────────────────────────────────────────────┤
 * │ Container       │ Documents & recommended TTLs                  │
 * ├─────────────────┼───────────────────────────────────────────────┤
 * │ earnings        │ earnings_week   → 8 days                      │
 * │                 │ earnings_next   → 14 days                     │
 * │                 │ earnings_moves  → 45 days (bulk map)          │
 * ├─────────────────┼───────────────────────────────────────────────┤
 * │ cache           │ trending        → 6 hours                     │
 * │                 │ active_options  → 2 days                      │
 * │                 │ active_options_today → 1 day                  │
 * │                 │ ticker_options  → 2 days (bulk map)           │
 * │                 │ stock_historical → 60 days (bulk map)         │
 * │                 │ sector_averages → 30 days                     │
 * │                 │ watchlist       → 1 year                      │
 * └─────────────────┴───────────────────────────────────────────────┘
 *
 * Enable by setting env var:
 *   COSMOS_CONNECTION_STRING=AccountEndpoint=...;AccountKey=...;
 *
 * If the env var is absent the module is a no-op and the app falls
 * back to local JSON files as before.
 */

import { CosmosClient } from '@azure/cosmos';

const DB_NAME       = 'stocktracker';
const DB_THROUGHPUT = 400; // RU/s — shared, well within 1 000 RU/s free tier

// TTL in seconds for each document type.
export const TTL = {
  EARNINGS_WEEK:    8   * 86400,  //  8 days
  EARNINGS_NEXT:    14  * 86400,  // 14 days
  EARNINGS_MOVES:   45  * 86400,  // 45 days
  ACTIVE_OPTIONS:   2   * 86400,  //  2 days
  OPTIONS_TODAY:    1   * 86400,  //  1 day
  TICKER_OPTIONS:   2   * 86400,  //  2 days
  TRENDING:         6   * 3600,   //  6 hours
  STOCK_HISTORICAL: 60  * 86400,  // 60 days
  SECTOR_AVERAGES:  30  * 86400,  // 30 days
  WATCHLIST:        365 * 86400,  //  1 year
};

let _enabled = false;
const _containers = {};

export function isCosmosEnabled() {
  return _enabled;
}

/**
 * Connect to Cosmos and create the database + containers if they don't
 * already exist.  Safe to call multiple times (idempotent).
 * Returns true on success, false if COSMOS_CONNECTION_STRING is not set
 * or connection fails (app continues with local JSON files).
 */
export async function initCosmos() {
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) {
    console.log('[Cosmos] COSMOS_CONNECTION_STRING not set — using local JSON files only');
    return false;
  }

  try {
    const client = new CosmosClient(connStr);

    // Create (or open) the database with shared manual throughput.
    // The `throughput` option here sets the OFFER on the database itself;
    // individual containers must NOT have their own throughput, so they
    // all draw from this shared 400 RU/s pool (free-tier safe).
    const { database } = await client.databases.createIfNotExists(
      { id: DB_NAME },
      { throughput: DB_THROUGHPUT }
    );

    // Containers: defaultTtl = -1 means "honour the per-document .ttl field".
    const defs = [
      { id: 'earnings', partitionKey: '/pk', defaultTtl: -1 },
      { id: 'cache',    partitionKey: '/pk', defaultTtl: -1 },
    ];

    for (const def of defs) {
      const { container } = await database.containers.createIfNotExists({
        id: def.id,
        partitionKey: { paths: [def.partitionKey] },
        defaultTtl: def.defaultTtl,
        // No `throughput` → container shares the database-level pool
      });
      _containers[def.id] = container;
    }

    _enabled = true;
    console.log(`[Cosmos] Connected — DB "${DB_NAME}" @ ${DB_THROUGHPUT} RU/s shared (free tier)`);
    return true;
  } catch (err) {
    console.error('[Cosmos] Init failed:', err.message || err, '— falling back to local JSON files');
    _enabled = false;
    return false;
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function _upsert(containerName, id, pk, payload, ttlSeconds) {
  const c = _containers[containerName];
  if (!c) return false;
  try {
    const doc = { id, pk, ...payload, _written: Date.now() };
    if (ttlSeconds > 0) doc.ttl = ttlSeconds;
    await c.items.upsert(doc);
    return true;
  } catch (err) {
    console.error(`[Cosmos] upsert ${containerName}/${id}:`, err.message || err);
    return false;
  }
}

async function _read(containerName, id, pk) {
  const c = _containers[containerName];
  if (!c) return null;
  try {
    const { resource } = await c.item(id, pk).read();
    return resource ?? null;
  } catch (err) {
    if (err.code === 404) return null;
    console.error(`[Cosmos] read ${containerName}/${id}:`, err.message || err);
    return null;
  }
}

// ─── Earnings calendar ─────────────────────────────────────────────────────

export async function saveEarningsWeek(data) {
  return _upsert('earnings', 'earnings_week', 'earnings_week', data, TTL.EARNINGS_WEEK);
}
export async function loadEarningsWeek() {
  return _read('earnings', 'earnings_week', 'earnings_week');
}

export async function saveEarningsNext(data) {
  return _upsert('earnings', 'earnings_next', 'earnings_next', data, TTL.EARNINGS_NEXT);
}
export async function loadEarningsNext() {
  return _read('earnings', 'earnings_next', 'earnings_next');
}

// ─── Earnings moves ────────────────────────────────────────────────────────
// Stored as a single bulk document (cheaper than 500+ individual docs).

export async function saveEarningsMoves(movesMap) {
  return _upsert('earnings', 'earnings_moves', 'earnings_moves', { moves: movesMap }, TTL.EARNINGS_MOVES);
}
export async function loadEarningsMoves() {
  const doc = await _read('earnings', 'earnings_moves', 'earnings_moves');
  return doc?.moves ?? null;
}

// ─── Active options ─────────────────────────────────────────────────────────

export async function saveActiveOptions(data) {
  return _upsert('cache', 'active_options', 'active_options', data, TTL.ACTIVE_OPTIONS);
}
export async function loadActiveOptions() {
  return _read('cache', 'active_options', 'active_options');
}

export async function saveActiveOptionsToday(data) {
  return _upsert('cache', 'active_options_today', 'active_options_today', data, TTL.OPTIONS_TODAY);
}
export async function loadActiveOptionsToday() {
  return _read('cache', 'active_options_today', 'active_options_today');
}

// ─── Ticker options ─────────────────────────────────────────────────────────

export async function saveTickerOptions(optionsMap) {
  return _upsert('cache', 'ticker_options', 'ticker_options', { options: optionsMap }, TTL.TICKER_OPTIONS);
}
export async function loadTickerOptions() {
  const doc = await _read('cache', 'ticker_options', 'ticker_options');
  return doc?.options ?? null;
}

// ─── Trending snapshot ──────────────────────────────────────────────────────

export async function saveTrending(data) {
  return _upsert('cache', 'trending', 'trending', data, TTL.TRENDING);
}
export async function loadTrending() {
  return _read('cache', 'trending', 'trending');
}

// ─── Stock historical (bulk map keyed by symbol) ───────────────────────────

export async function saveStockHistorical(histMap) {
  return _upsert('cache', 'stock_historical', 'stock_historical', { historical: histMap }, TTL.STOCK_HISTORICAL);
}
export async function loadStockHistorical() {
  const doc = await _read('cache', 'stock_historical', 'stock_historical');
  return doc?.historical ?? null;
}

// ─── Watchlist ──────────────────────────────────────────────────────────────

export async function saveWatchlist(symbols) {
  const c = _containers['cache'];
  if (!c) return false;
  try {
    await c.items.upsert({ id: 'watchlist', pk: 'watchlist', symbols, _written: Date.now() });
    return true;
  } catch (err) {
    console.error('[Cosmos] saveWatchlist:', err.message || err);
    return false;
  }
}
export async function loadWatchlist() {
  const doc = await _read('cache', 'watchlist', 'watchlist');
  return doc?.symbols ?? null;
}

// ─── Sector averages ────────────────────────────────────────────────────────

export async function saveSectorAverages(data) {
  return _upsert('cache', 'sector_averages', 'sector_averages', data, TTL.SECTOR_AVERAGES);
}
export async function loadSectorAverages() {
  return _read('cache', 'sector_averages', 'sector_averages');
}
