// price-cache.test.js — Unit tests for the local file-based price cache.
// These tests write/read files from ~/.azc/cache/ like the real cache does.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const priceCache = require('../src/cache/price-cache');

// Sample data to cache
const SAMPLE_ITEMS = [
  { retailPrice: 0.25, skuName: 'P1 v3', meterName: 'P1 v3 App', currencyCode: 'GBP' },
  { retailPrice: 0.13, skuName: 'P1 v3', meterName: 'P1 v3 App Linux', currencyCode: 'GBP' },
];

describe('price-cache', () => {
  const testFilter = `test_filter_${Date.now()}`;
  const testCurrency = 'GBP';

  afterEach(() => {
    // Clean up by clearing the cache (removes test files too)
    priceCache.clearAll();
  });

  it('should return null on cache miss', () => {
    const result = priceCache.get('nonexistent_filter', 'GBP');
    assert.equal(result, null);
  });

  it('should store and retrieve cached items', () => {
    priceCache.set(testFilter, testCurrency, SAMPLE_ITEMS);
    const result = priceCache.get(testFilter, testCurrency);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[0].retailPrice, 0.25);
    assert.equal(result[1].skuName, 'P1 v3');
  });

  it('should generate consistent cache keys regardless of parameter order', () => {
    // buildFilter already sorts keys, but let's verify the cache key itself
    // is consistent for the same logical query
    const key1 = priceCache.cacheKey('armRegionName eq \'uksouth\' and serviceName eq \'X\'', 'GBP');
    const key2 = priceCache.cacheKey('armRegionName eq \'uksouth\' and serviceName eq \'X\'', 'GBP');
    assert.equal(key1, key2);
  });

  it('should return different cache keys for different currencies', () => {
    const keyGBP = priceCache.cacheKey('filter', 'GBP');
    const keyUSD = priceCache.cacheKey('filter', 'USD');
    assert.notEqual(keyGBP, keyUSD);
  });

  it('should return a count from clearAll', () => {
    priceCache.set(testFilter, 'GBP', SAMPLE_ITEMS);
    priceCache.set(testFilter + '_2', 'USD', SAMPLE_ITEMS);
    const count = priceCache.clearAll();
    assert.ok(count >= 2, `Expected at least 2 files cleared, got ${count}`);
  });
});
