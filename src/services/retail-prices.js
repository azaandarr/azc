// retail-prices.js — Client for the Azure Retail Prices API.
// This is a public, unauthenticated API that returns pricing for all Azure services.
// Base URL: https://prices.azure.com/api/retail/prices
//
// Key design decisions:
// - Concurrency limiter (max 5 in-flight requests) to avoid hammering the API during large scans
// - Automatic pagination — the API returns 100 items per page, we follow NextPageLink
// - Pagination safety cap at 10 pages to bail out of overly broad filters
// - Single retry with 2s delay on network errors before giving up

const logger = require('../utils/logger');
const priceCache = require('../cache/price-cache');

const BASE_URL = 'https://prices.azure.com/api/retail/prices';

// Maximum number of pages to fetch before stopping — if we hit this,
// the OData filter is probably too broad and we should refine it.
const MAX_PAGES = 10;

// Retry config for transient network errors
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 1;

// ─── Concurrency limiter ────────────────────────────────────────────
// Simple semaphore to cap concurrent HTTP requests. During a scan with
// 50+ resources, we'd otherwise fire all requests at once and risk
// getting throttled or timing out.
const MAX_CONCURRENT = 5;
let activeRequests = 0;
const waitQueue = [];

/**
 * Acquire a slot in the concurrency limiter.
 * If all slots are taken, the caller awaits until one frees up.
 * @returns {Promise<void>}
 */
function acquireSlot() {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
  });
}

/**
 * Release a slot back to the concurrency limiter.
 * If anyone is waiting in the queue, wake them up.
 */
function releaseSlot() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next();
  } else {
    activeRequests--;
  }
}

/**
 * Build an OData $filter string from a set of key-value pairs.
 * Sorts predicates alphabetically so the same logical query always
 * produces the same string — this is critical for cache key normalization.
 *
 * @param {object} filters - Key-value pairs, e.g. { serviceName: 'Virtual Machines', armRegionName: 'uksouth' }
 * @returns {string} OData filter string, e.g. "armRegionName eq 'uksouth' and serviceName eq 'Virtual Machines'"
 */
function buildFilter(filters) {
  return Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} eq '${value}'`)
    .join(' and ');
}

/**
 * Build the full URL for a Retail Prices API query.
 * @param {string} filter    - OData $filter string
 * @param {string} currency  - Currency code (GBP, USD, EUR)
 * @returns {string} Full URL with query parameters
 */
function buildUrl(filter, currency = 'GBP') {
  const params = new URLSearchParams();
  params.set('$filter', filter);
  params.set('currencyCode', currency.toUpperCase());
  return `${BASE_URL}?${params.toString()}`;
}

/**
 * Fetch a single URL with retry logic.
 * Retries once after a 2-second delay on network errors.
 * Non-2xx HTTP responses are treated as errors (no retry — they're usually bad filters).
 *
 * @param {string} url - The full URL to fetch
 * @returns {Promise<object>} Parsed JSON response body
 */
async function fetchWithRetry(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText} — ${url}`);
      }

      return await response.json();
    } catch (err) {
      // Only retry on network-level errors (ECONNRESET, ETIMEDOUT, etc.)
      // HTTP errors (4xx, 5xx) are not retried because they indicate a bad query.
      const isNetworkError = !err.message.startsWith('HTTP ');
      const canRetry = attempt < MAX_RETRIES && isNetworkError;

      if (canRetry) {
        logger.dim(`Network error, retrying in ${RETRY_DELAY_MS / 1000}s... (${err.message})`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Query the Azure Retail Prices API with pagination.
 * Returns all matching price items across all pages (up to MAX_PAGES).
 *
 * @param {object} filters   - Key-value filter pairs (see buildFilter)
 * @param {object} [options]
 * @param {string} [options.currency='GBP'] - Currency code
 * @param {boolean} [options.skipCache=false] - Bypass the local file cache
 * @returns {Promise<Array<object>>} Array of price item objects from the API
 */
async function queryPrices(filters, options = {}) {
  const currency = options.currency || 'GBP';
  const skipCache = options.skipCache || false;

  const filterString = buildFilter(filters);

  // Check cache first — returns null on miss or expired entries
  if (!skipCache) {
    const cached = priceCache.get(filterString, currency);
    if (cached) {
      logger.debug(`Cache hit: ${filterString} (${cached.length} items)`);
      logger.dim('Using cached pricing data');
      return cached;
    }
    logger.debug(`Cache miss: ${filterString}`);
  }

  const url = buildUrl(filterString, currency);
  logger.debug(`API request: ${url}`);
  const items = [];
  let nextUrl = url;
  let page = 0;

  // Acquire a concurrency slot before starting the request chain
  await acquireSlot();

  try {
    while (nextUrl && page < MAX_PAGES) {
      const data = await fetchWithRetry(nextUrl);
      const pageItems = data.Items || [];
      items.push(...pageItems);

      // The API returns NextPageLink as a full URL when there are more results
      nextUrl = data.NextPageLink || null;
      page++;
      logger.debug(`Page ${page}: ${pageItems.length} items (${items.length} total)`);
    }

    if (page >= MAX_PAGES) {
      logger.warn(
        `Pricing query returned ${MAX_PAGES}+ pages — filter may be too broad. Using first ${items.length} results.`
      );
    }
  } finally {
    releaseSlot();
  }

  // Cache the results for 24 hours
  if (!skipCache && items.length > 0) {
    priceCache.set(filterString, currency, items);
  }

  return items;
}

/**
 * Query prices for a specific Azure service and SKU combination.
 * This is a convenience wrapper around queryPrices that builds the
 * most common filter pattern.
 *
 * @param {object} params
 * @param {string} params.serviceName    - Azure service name (e.g. 'Virtual Machines')
 * @param {string} [params.armSkuName]   - ARM SKU name (e.g. 'Standard_D4s_v5')
 * @param {string} [params.armRegionName] - Azure region (e.g. 'uksouth')
 * @param {string} [params.priceType]    - 'Consumption', 'Reservation', or 'DevTestConsumption'
 * @param {string} [params.meterName]    - Meter name for disambiguation
 * @param {string} [params.skuName]      - Human-readable SKU name
 * @param {string} [params.currency]     - Currency code
 * @returns {Promise<Array<object>>} Matching price items
 */
async function lookupPrice(params) {
  const {
    serviceName,
    armSkuName,
    armRegionName,
    priceType,
    meterName,
    skuName,
    currency,
  } = params;

  // Build the filter from all provided parameters
  const filters = {};
  if (serviceName) filters.serviceName = serviceName;
  if (armSkuName) filters.armSkuName = armSkuName;
  if (armRegionName) filters.armRegionName = armRegionName;
  if (priceType) filters.priceType = priceType;
  if (meterName) filters.meterName = meterName;
  if (skuName) filters.skuName = skuName;

  return queryPrices(filters, { currency });
}

module.exports = {
  queryPrices,
  lookupPrice,
  buildFilter,
  buildUrl,
  BASE_URL,
};
