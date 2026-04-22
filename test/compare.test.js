// compare.test.js — Unit tests for the compare command's spec parser.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseChangeSpec } = require('../src/commands/compare');

describe('parseChangeSpec', () => {
  it('should parse "App Service:P1v3" into service alias and SKU', () => {
    const result = parseChangeSpec('App Service:P1v3');
    assert.equal(result.serviceAlias, 'App Service');
    assert.equal(result.newSku, 'P1v3');
    assert.deepEqual(result.props, {});
  });

  it('should parse "PostgreSQL:Standard_D4ds_v5,storage=256GB"', () => {
    const result = parseChangeSpec('PostgreSQL:Standard_D4ds_v5,storage=256GB');
    assert.equal(result.serviceAlias, 'PostgreSQL');
    assert.equal(result.newSku, 'Standard_D4ds_v5');
    assert.equal(result.props.storage, '256GB');
  });

  it('should handle multiple properties', () => {
    const result = parseChangeSpec('App Service:P1v3,instances=3,os=linux');
    assert.equal(result.newSku, 'P1v3');
    assert.equal(result.props.instances, '3');
    assert.equal(result.props.os, 'linux');
  });

  it('should return null when no colon separator is present', () => {
    const result = parseChangeSpec('App Service P1v3');
    assert.equal(result, null);
  });

  it('should handle whitespace around values', () => {
    const result = parseChangeSpec('  Redis : C3 , capacity = 2 ');
    assert.equal(result.serviceAlias, 'Redis');
    assert.equal(result.newSku, 'C3');
    assert.equal(result.props.capacity, '2');
  });
});
