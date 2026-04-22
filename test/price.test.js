// price.test.js — Unit tests for the azc price command's query parser.
// Tests the parseQuery function that converts free-text input like
// "App Service P1v3" into structured { serviceName, sku, skuField } objects.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery } = require('../src/commands/price');

describe('parseQuery', () => {
  it('should parse "App Service P1v3" into Azure App Service + P1v3', () => {
    const result = parseQuery('App Service P1v3');
    assert.equal(result.serviceName, 'Azure App Service');
    assert.equal(result.sku, 'P1v3');
  });

  it('should parse "VM Standard_D4s_v5" into Virtual Machines + Standard_D4s_v5', () => {
    const result = parseQuery('VM Standard_D4s_v5');
    assert.equal(result.serviceName, 'Virtual Machines');
    assert.equal(result.sku, 'Standard_D4s_v5');
    assert.equal(result.skuField, 'armSkuName');
  });

  it('should parse "PostgreSQL D2ds_v4" into Azure Database for PostgreSQL + D2ds_v4', () => {
    const result = parseQuery('PostgreSQL D2ds_v4');
    assert.equal(result.serviceName, 'Azure Database for PostgreSQL');
    assert.equal(result.sku, 'D2ds_v4');
  });

  it('should be case-insensitive', () => {
    const result = parseQuery('app service S1');
    assert.equal(result.serviceName, 'Azure App Service');
    assert.equal(result.sku, 'S1');
  });

  it('should handle service name without SKU', () => {
    const result = parseQuery('Redis');
    assert.equal(result.serviceName, 'Redis Cache');
    assert.equal(result.sku, '');
  });

  it('should handle aliases like "cosmos" for Cosmos DB', () => {
    const result = parseQuery('cosmos');
    assert.equal(result.serviceName, 'Azure Cosmos DB');
  });

  it('should return null for unrecognized service names', () => {
    const result = parseQuery('nonexistent something');
    assert.equal(result, null);
  });

  it('should handle multi-word SKU values', () => {
    const result = parseQuery('VM Standard_D4s_v5 Low Priority');
    assert.equal(result.serviceName, 'Virtual Machines');
    assert.equal(result.sku, 'Standard_D4s_v5 Low Priority');
  });
});
