// price-cache.js — Local file cache for Azure Retail Prices API responses.
// Pricing data changes infrequently (roughly monthly), so we cache aggressively
// with a 24-hour TTL to avoid hitting the API repeatedly for the same query.
//
// Cache keys are SHA-256 hashes of the normalized OData filter + currency code.
// Since buildFilter() sorts predicates alphabetically, logically identical
// queries always produce the same hash regardless of parameter ordering.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CACHE_DIR } = require('../config/config');

// 24 hours in milliseconds — how long a cached price entry stays valid.
// Azure pricing updates are infrequent, so this is comfortably safe.
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Generate a deterministic cache key from the filter string and currency.
 * We hash the concatenation so filenames stay short and filesystem-safe.
 * @param {string} filter   - The OData filter string (already normalized/sorted)
 * @param {string} currency - Currency code (e.g. 'GBP')
 * @returns {string} Hex SHA-256 hash to use as the cache filename
 */
function cacheKey(filter, currency) {
  const raw = `${filter}||${currency.toUpperCase()}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Get the full filesystem path for a cache entry.
 * @param {string} key - The hashed cache key
 * @returns {string} Absolute path to the cache JSON file
 */
function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
}

/**
 * Read a cached price response if it exists and hasn't expired.
 * Returns null on cache miss, expired entry, or any read error.
 *
 * @param {string} filter   - The OData filter string
 * @param {string} currency - Currency code
 * @returns {Array<object>|null} Cached price items, or null if miss/expired
 */
function get(filter, currency) {
  const key = cacheKey(filter, currency);
  const filePath = cachePath(key);

  try {
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    const entry = JSON.parse(raw);

    // Check if the entry has expired
    const age = Date.now() - entry.timestamp;
    if (age > TTL_MS) {
      // Expired — delete the stale file and return a miss.
      // We delete rather than leave it because stale files accumulate
      // and the cache dir has no automatic cleanup.
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore cleanup errors */ }
      return null;
    }

    return entry.items;
  } catch (_) {
    // Corrupted or unreadable cache file — treat as a miss
    return null;
  }
}

/**
 * Write a price response to the cache.
 * Stores the items alongside a timestamp for TTL checking.
 *
 * @param {string} filter          - The OData filter string
 * @param {string} currency        - Currency code
 * @param {Array<object>} items    - The price items to cache
 */
function set(filter, currency, items) {
  const key = cacheKey(filter, currency);
  const filePath = cachePath(key);

  // Ensure the cache directory exists — it should from config init,
  // but we're defensive here in case it was manually deleted.
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const entry = {
    filter,
    currency: currency.toUpperCase(),
    timestamp: Date.now(),
    itemCount: items.length,
    items,
  };

  // Write atomically-ish: write to a temp file then rename.
  // This prevents the SIGINT handler from catching a half-written file.
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(entry), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Clear all cached price data. Useful for debugging or when the user
 * suspects pricing data is stale.
 * @returns {number} Number of cache files deleted
 */
function clearAll() {
  if (!fs.existsSync(CACHE_DIR)) return 0;

  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try { fs.unlinkSync(path.join(CACHE_DIR, file)); } catch (_) { /* ignore */ }
  }
  return files.length;
}

module.exports = {
  get,
  set,
  clearAll,
  cacheKey,
  TTL_MS,
};
