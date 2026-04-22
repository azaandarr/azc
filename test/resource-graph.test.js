// resource-graph.test.js — Unit tests for the resource normalisation logic.
// We don't test the actual API call (that requires Azure auth),
// but we test that normaliseResource handles various response shapes correctly.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normaliseResource } = require('../src/services/resource-graph');

describe('normaliseResource', () => {
  it('should lowercase the resource type', () => {
    const result = normaliseResource({
      name: 'my-vm',
      type: 'Microsoft.Compute/virtualMachines',
      location: 'uksouth',
    });
    assert.equal(result.type, 'microsoft.compute/virtualmachines');
  });

  it('should handle missing sku gracefully', () => {
    const result = normaliseResource({
      name: 'my-resource',
      type: 'Microsoft.Something/resource',
      location: 'uksouth',
    });
    assert.equal(result.sku, null);
    assert.deepEqual(result.properties, {});
  });

  it('should preserve the full sku object', () => {
    const result = normaliseResource({
      name: 'my-plan',
      type: 'Microsoft.Web/serverFarms',
      location: 'uksouth',
      sku: { name: 'P1v3', tier: 'PremiumV3', capacity: 2 },
      properties: { reserved: true },
    });
    assert.equal(result.sku.name, 'P1v3');
    assert.equal(result.sku.capacity, 2);
    assert.equal(result.properties.reserved, true);
  });

  it('should default tags and kind to empty values', () => {
    const result = normaliseResource({
      name: 'x',
      type: 'Microsoft.X/y',
      location: 'uksouth',
    });
    assert.equal(result.kind, null);
    assert.deepEqual(result.tags, {});
  });

  it('should preserve resourceGroup field', () => {
    const result = normaliseResource({
      name: 'x',
      type: 'Microsoft.X/y',
      location: 'uksouth',
      resourceGroup: 'my-rg',
    });
    assert.equal(result.resourceGroup, 'my-rg');
  });
});
