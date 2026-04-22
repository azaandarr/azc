// json-formatter.test.js — Unit tests for the JSON output formatters.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildScanJson, buildCompareJson, buildPlanJson } = require('../src/formatters/json');

describe('buildScanJson', () => {
  it('should produce valid structured output with correct totals', () => {
    const result = buildScanJson({
      subscription: 'prod',
      subscriptionId: 'xxx-yyy',
      region: 'uksouth',
      currency: 'GBP',
      resources: [
        { name: 'app1', type: 'microsoft.web/serverfarms', sku: 'P1v3', monthlyCost: 95.05, notes: '' },
        { name: 'vm1', type: 'microsoft.compute/virtualmachines', sku: 'D4s_v5', monthlyCost: 121.91, notes: '' },
        { name: 'storage1', type: 'microsoft.storage/storageaccounts', sku: 'Hot', monthlyCost: 0, usageBased: true },
      ],
      unsupported: [{ name: 'vnet1', type: 'microsoft.network/virtualnetworks' }],
      unpriced: [{ name: 'disk1', type: 'microsoft.compute/disks', reason: 'No match' }],
    });

    assert.equal(result.subscription, 'prod');
    assert.equal(result.resources.length, 3);
    // Total should exclude usage-based resources
    assert.equal(result.totalMonthlyCost, 216.96);
    assert.equal(result.totalAnnualCost, 2603.52);
    assert.equal(result.unsupportedResources.length, 1);
    assert.equal(result.unpricedResources.length, 1);
    assert.ok(result.generatedAt);
  });
});

describe('buildCompareJson', () => {
  it('should calculate delta and percentage change', () => {
    const result = buildCompareJson({
      resourceName: 'prism-plan',
      resourceType: 'microsoft.web/serverfarms',
      current: { sku: 'B3', monthlyCost: 38.47 },
      proposed: { sku: 'P1v3', monthlyCost: 95.05 },
      currency: 'GBP',
    });

    assert.equal(result.current.monthlyCost, 38.47);
    assert.equal(result.proposed.monthlyCost, 95.05);
    assert.ok(result.delta.monthly > 0);
    assert.ok(result.delta.percentChange > 0);
    assert.equal(result.delta.monthly, 56.58);
  });
});

describe('buildPlanJson', () => {
  it('should sum all items for the total', () => {
    const result = buildPlanJson({
      region: 'uksouth',
      currency: 'GBP',
      items: [
        { service: 'App Service Plan', sku: 'P1v3', monthlyCost: 95.05, notes: 'linux' },
        { service: 'Redis Cache', sku: 'C1', monthlyCost: 15.33, notes: '' },
      ],
    });

    assert.equal(result.items.length, 2);
    assert.equal(result.totalMonthlyCost, 110.38);
    assert.equal(result.totalAnnualCost, 1324.56);
  });
});
