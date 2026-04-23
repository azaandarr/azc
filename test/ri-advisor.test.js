const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getRecommendations } = require('../src/services/ri-advisor');

describe('ri-advisor', () => {
  it('exports getRecommendations function', () => {
    assert.equal(typeof getRecommendations, 'function');
  });

  it('returns empty array for empty input', async () => {
    const result = await getRecommendations([], { region: 'uksouth', currency: 'GBP' });
    assert.deepEqual(result, []);
  });

  it('returns empty array for usage-based resources', async () => {
    const resources = [
      { name: 'storage1', type: 'microsoft.storage/storageaccounts', sku: 'Standard', monthlyCost: 0, usageBased: true },
    ];
    const result = await getRecommendations(resources, { region: 'uksouth', currency: 'GBP' });
    assert.deepEqual(result, []);
  });

  it('skips resources with zero cost', async () => {
    const resources = [
      { name: 'free-vm', type: 'microsoft.compute/virtualmachines', sku: 'Standard_B1s', monthlyCost: 0 },
    ];
    const result = await getRecommendations(resources, { region: 'uksouth', currency: 'GBP' });
    assert.deepEqual(result, []);
  });
});
