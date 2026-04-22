// sku-mapper.test.js — Unit tests for the SKU mapper.
// Uses realistic Resource Graph fixtures to verify that each mapper
// extracts the right pricing parameters from each resource type.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapResource, isSupported, supportedTypes } = require('../src/services/sku-mapper');
const { normaliseResource } = require('../src/services/resource-graph');
const fixtures = require('./fixtures/resource-graph-responses.json');

// Helper: normalise a fixture the same way queryResources would
function norm(fixture) {
  return normaliseResource(fixture);
}

describe('sku-mapper — isSupported', () => {
  it('should recognise all 15 priority resource types', () => {
    const types = supportedTypes();
    assert.equal(types.length, 15);
    assert.ok(types.includes('microsoft.web/serverfarms'));
    assert.ok(types.includes('microsoft.compute/virtualmachines'));
    assert.ok(types.includes('microsoft.containerregistry/registries'));
  });

  it('should return false for unsupported types', () => {
    assert.equal(isSupported('microsoft.network/virtualnetworks'), false);
    assert.equal(isSupported('microsoft.logic/workflows'), false);
  });
});

describe('sku-mapper — App Service Plan', () => {
  it('should extract serviceName, SKU, instance count, and OS', () => {
    const result = mapResource(norm(fixtures.appServicePlan));
    assert.equal(result.serviceName, 'Azure App Service');
    assert.equal(result.skuMatch, 'P1v3');
    assert.equal(result.quantity, 2);
    assert.equal(result.os, 'linux');
    assert.equal(result.unit, '1 Hour');
  });
});

describe('sku-mapper — Virtual Machine', () => {
  it('should extract vmSize from properties.hardwareProfile', () => {
    const result = mapResource(norm(fixtures.virtualMachine));
    assert.equal(result.serviceName, 'Virtual Machines');
    assert.equal(result.filters.armSkuName, 'Standard_D4s_v5');
    assert.equal(result.os, 'linux');
    assert.equal(result.quantity, 1);
  });
});

describe('sku-mapper — PostgreSQL Flexible Server', () => {
  it('should extract SKU name and storage size', () => {
    const result = mapResource(norm(fixtures.postgresqlFlexible));
    assert.equal(result.serviceName, 'Azure Database for PostgreSQL');
    assert.equal(result.filters.armSkuName, 'Standard_D2ds_v5');
    assert.ok(result.notes.includes('128 GB storage'));
    // Should also have a storageCost descriptor for the storage component
    assert.ok(result.storageCost, 'Expected storageCost descriptor');
    assert.equal(result.storageCost.quantity, 128);
  });
});

describe('sku-mapper — Storage Account', () => {
  it('should extract SKU and access tier, flag as usage-based', () => {
    const result = mapResource(norm(fixtures.storageAccount));
    assert.equal(result.serviceName, 'Storage');
    assert.equal(result.skuMatch, 'Hot');
    assert.equal(result.usageBased, true);
    assert.ok(result.notes.includes('Standard_LRS'));
  });
});

describe('sku-mapper — Cosmos DB', () => {
  it('should detect provisioned throughput mode', () => {
    const result = mapResource(norm(fixtures.cosmosDb));
    assert.equal(result.serviceName, 'Azure Cosmos DB');
    assert.ok(result.notes.includes('Provisioned'));
    assert.equal(result.usageBased, true);
  });

  it('should detect serverless mode', () => {
    const result = mapResource(norm(fixtures.cosmosDbServerless));
    assert.equal(result.serviceName, 'Azure Cosmos DB');
    assert.ok(result.notes.includes('Serverless'));
    assert.equal(result.usageBased, true);
  });
});

describe('sku-mapper — Redis Cache', () => {
  it('should extract tier and capacity into SKU name', () => {
    const result = mapResource(norm(fixtures.redisCache));
    assert.equal(result.serviceName, 'Redis Cache');
    assert.equal(result.skuMatch, 'C1');
    assert.equal(result.unit, '1 Hour');
  });

  it('should include productFilter and meterFilter for disambiguation', () => {
    const result = mapResource(norm(fixtures.redisCache));
    assert.equal(result.productFilter, 'standard');
    assert.equal(result.meterFilter, 'C1 Cache');
  });
});

describe('sku-mapper — Key Vault', () => {
  it('should extract tier and flag as usage-based', () => {
    const result = mapResource(norm(fixtures.keyVault));
    assert.equal(result.serviceName, 'Key Vault');
    assert.equal(result.skuMatch, 'Standard');
    assert.equal(result.usageBased, true);
  });
});

describe('sku-mapper — Application Insights', () => {
  it('should flag as usage-based with per-GB pricing', () => {
    const result = mapResource(norm(fixtures.applicationInsights));
    assert.equal(result.serviceName, 'Application Insights');
    assert.equal(result.usageBased, true);
    assert.ok(result.notes.includes('5 GB/month free'));
  });
});

describe('sku-mapper — Application Gateway', () => {
  it('should extract SKU from properties.sku and instance count', () => {
    const result = mapResource(norm(fixtures.applicationGateway));
    assert.equal(result.serviceName, 'Application Gateway');
    assert.equal(result.skuMatch, 'Standard');
    assert.equal(result.quantity, 2);
  });
});

describe('sku-mapper — SQL Database', () => {
  it('should extract SKU name from sku.name', () => {
    const result = mapResource(norm(fixtures.sqlDatabase));
    assert.equal(result.serviceName, 'SQL Database');
    assert.equal(result.skuMatch, 'GP_Gen5_2');
    assert.ok(result.notes.includes('GeneralPurpose'));
  });
});

describe('sku-mapper — Service Bus', () => {
  it('should extract tier from sku.name', () => {
    const result = mapResource(norm(fixtures.serviceBus));
    assert.equal(result.serviceName, 'Service Bus');
    assert.equal(result.skuMatch, 'Standard');
  });
});

describe('sku-mapper — Managed Disk', () => {
  it('should extract tier prefix and disk size', () => {
    const result = mapResource(norm(fixtures.managedDisk));
    assert.equal(result.serviceName, 'Managed Disks');
    assert.equal(result.skuMatch, 'Premium');
    assert.ok(result.notes.includes('128 GB'));
  });
});

describe('sku-mapper — Public IP', () => {
  it('should extract tier and allocation method', () => {
    const result = mapResource(norm(fixtures.publicIp));
    assert.equal(result.serviceName, 'Virtual Network');
    assert.ok(result.notes.includes('Standard'));
    assert.ok(result.notes.includes('Static'));
  });
});

describe('sku-mapper — Container Registry', () => {
  it('should extract tier from sku.name', () => {
    const result = mapResource(norm(fixtures.containerRegistry));
    assert.equal(result.serviceName, 'Container Registry');
    assert.equal(result.skuMatch, 'Basic');
  });
});

describe('sku-mapper — edge cases', () => {
  it('should return null for unsupported resource types', () => {
    const result = mapResource({ type: 'microsoft.network/virtualnetworks', sku: null, properties: {} });
    assert.equal(result, null);
  });

  it('should return null when SKU info is missing from a supported type', () => {
    const result = mapResource(norm({
      name: 'broken-plan',
      type: 'Microsoft.Web/serverFarms',
      location: 'uksouth',
      sku: null,
      properties: {},
    }));
    assert.equal(result, null);
  });
});
