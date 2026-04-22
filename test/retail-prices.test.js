// retail-prices.test.js — Integration tests for the Retail Prices API client.
// These hit the real Azure Retail Prices API (it's free and unauthenticated).
// No mocking — we test against the live API as per project testing strategy.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { queryPrices, buildFilter, buildUrl, lookupPrice } = require('../src/services/retail-prices');

describe('buildFilter', () => {
  it('should build a valid OData filter string from key-value pairs', () => {
    const filter = buildFilter({
      serviceName: 'Virtual Machines',
      armRegionName: 'uksouth',
    });
    // Predicates are sorted alphabetically by key
    assert.equal(filter, "armRegionName eq 'uksouth' and serviceName eq 'Virtual Machines'");
  });

  it('should exclude null, undefined, and empty string values', () => {
    const filter = buildFilter({
      serviceName: 'Storage',
      armSkuName: null,
      meterName: undefined,
      skuName: '',
      armRegionName: 'uksouth',
    });
    assert.equal(filter, "armRegionName eq 'uksouth' and serviceName eq 'Storage'");
  });

  it('should sort predicates alphabetically for cache key consistency', () => {
    const filter1 = buildFilter({ serviceName: 'X', armRegionName: 'Y' });
    const filter2 = buildFilter({ armRegionName: 'Y', serviceName: 'X' });
    assert.equal(filter1, filter2);
  });
});

describe('buildUrl', () => {
  it('should build a full URL with filter and currency parameters', () => {
    const url = buildUrl("serviceName eq 'Storage'", 'GBP');
    assert.ok(url.startsWith('https://prices.azure.com/api/retail/prices?'));
    assert.ok(url.includes('currencyCode=GBP'));
    assert.ok(url.includes('%24filter='));
  });
});

describe('queryPrices (live API)', () => {
  it('should return results for a valid service + region query', async () => {
    const items = await queryPrices(
      { serviceName: 'Azure App Service', armRegionName: 'uksouth', priceType: 'Consumption' },
      { currency: 'GBP', skipCache: true }
    );
    assert.ok(Array.isArray(items), 'Expected an array of items');
    assert.ok(items.length > 0, 'Expected at least one pricing item');
    // Every item should have the expected fields
    const item = items[0];
    assert.ok(item.retailPrice !== undefined, 'Expected retailPrice field');
    assert.ok(item.unitOfMeasure, 'Expected unitOfMeasure field');
    assert.ok(item.currencyCode === 'GBP', 'Expected GBP currency');
  });

  it('should return an empty array for a nonsensical service name', async () => {
    const items = await queryPrices(
      { serviceName: 'NonExistentService12345', armRegionName: 'uksouth' },
      { currency: 'GBP', skipCache: true }
    );
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 0);
  });
});

describe('lookupPrice (live API)', () => {
  it('should find VM pricing by armSkuName', async () => {
    const items = await lookupPrice({
      serviceName: 'Virtual Machines',
      armSkuName: 'Standard_D4s_v5',
      armRegionName: 'uksouth',
      priceType: 'Consumption',
      currency: 'GBP',
    });
    assert.ok(items.length > 0, 'Expected VM pricing results');
    const vm = items.find((i) => i.armSkuName === 'Standard_D4s_v5');
    assert.ok(vm, 'Expected to find Standard_D4s_v5 in results');
    assert.ok(vm.retailPrice > 0, 'Expected a positive price');
  });
});
