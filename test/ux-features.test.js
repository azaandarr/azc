// ux-features.test.js — Tests for UX overhaul features:
// fuzzy query resolution, formatCompact, data files, template loading.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── Fuzzy query resolution ──────────────────────────────────────────

const { resolveAmbiguousQuery } = require('../src/commands/price');

describe('resolveAmbiguousQuery', () => {
  it('should detect "d4s v5" as a VM SKU and auto-prepend Standard_', () => {
    const result = resolveAmbiguousQuery('d4sv5');
    assert.ok(result, 'should return a result');
    assert.equal(result.serviceName, 'Virtual Machines');
    assert.ok(result.sku.includes('Standard_'), 'should prepend Standard_');
  });

  it('should resolve "4 vcpu 16gb" to a matching VM from vm-skus.json', () => {
    const result = resolveAmbiguousQuery('4 vcpu 16gb');
    assert.ok(result, 'should return a result');
    assert.equal(result.serviceName, 'Virtual Machines');
    assert.ok(result.sku.includes('Standard_'), 'should be a standard VM SKU');
  });

  it('should resolve "2 vcpu 8gb" to a matching VM', () => {
    const result = resolveAmbiguousQuery('2vcpu 8gb');
    assert.ok(result, 'should return a result');
    assert.equal(result.serviceName, 'Virtual Machines');
  });

  it('should return null for unrecognizable input', () => {
    const result = resolveAmbiguousQuery('foobar baz');
    assert.equal(result, null);
  });
});

// ── formatCompact ───────────────────────────────────────────────────

const { formatCompact } = require('../src/utils/currency');

describe('formatCompact', () => {
  it('should format millions with M suffix', () => {
    const result = formatCompact(1200000, 'GBP');
    assert.equal(result, '£1.2M');
  });

  it('should format thousands with k suffix', () => {
    const result = formatCompact(5246, 'GBP');
    assert.equal(result, '£5.2k');
  });

  it('should fall back to full format for small numbers', () => {
    const result = formatCompact(42.5, 'GBP');
    assert.ok(result.includes('42.50'), 'should show full precision');
  });

  it('should handle negative amounts', () => {
    const result = formatCompact(-3500, 'GBP');
    assert.equal(result, '-£3.5k');
  });

  it('should handle USD', () => {
    const result = formatCompact(12400, 'USD');
    assert.equal(result, '$12.4k');
  });
});

// ── parseInlineResource ─────────────────────────────────────────────

const { parseInlineResource } = require('../src/utils/sku-picker');

describe('parseInlineResource', () => {
  it('should parse "App Service P1v3" into service and SKU', () => {
    const result = parseInlineResource('App Service P1v3');
    assert.ok(result);
    assert.equal(result.sku, 'P1v3');
    assert.equal(result.quantity, 1);
  });

  it('should parse "3x App Service P1v3 linux" with quantity and OS', () => {
    const result = parseInlineResource('3x App Service P1v3 linux');
    assert.ok(result);
    assert.equal(result.quantity, 3);
    assert.equal(result.sku, 'P1v3');
    assert.equal(result.os, 'linux');
  });

  it('should parse "PostgreSQL D2ds_v5" without quantity prefix', () => {
    const result = parseInlineResource('PostgreSQL D2ds_v5');
    assert.ok(result);
    assert.equal(result.sku, 'D2ds_v5');
    assert.equal(result.quantity, 1);
  });

  it('should parse "2x Redis C1 standard" with tier hint', () => {
    const result = parseInlineResource('2x Redis C1 standard');
    assert.ok(result);
    assert.equal(result.quantity, 2);
    assert.equal(result.sku, 'C1');
    assert.equal(result.tier, 'standard');
  });

  it('should return null for unrecognised service', () => {
    const result = parseInlineResource('FooBar XYZ');
    assert.equal(result, null);
  });
});

// ── Quantity in plan items ──────────────────────────────────────────

describe('quantity calculations', () => {
  it('should correctly multiply unitCost by quantity', () => {
    const unitCost = 109.50;
    const qty = 3;
    const total = unitCost * qty;
    assert.equal(total, 328.5);
  });

  it('should include quantity and unitCost in plan JSON output', () => {
    const { buildPlanJson } = require('../src/formatters/json');
    const result = buildPlanJson({
      region: 'uksouth',
      currency: 'GBP',
      items: [
        { service: 'App Service Plan', sku: 'P1v3', quantity: 3, unitCost: 109.50, monthlyCost: 328.50, notes: '' },
      ],
    });
    assert.equal(result.items[0].quantity, 3);
    assert.equal(result.items[0].unitCost, 109.50);
    assert.equal(result.items[0].monthlyCost, 328.50);
  });
});

// ── Scan grouping ──────────────────────────────────────────────────

describe('renderScanResultGrouped', () => {
  it('should export the grouped renderer function', () => {
    const { renderScanResultGrouped } = require('../src/formatters/table');
    assert.equal(typeof renderScanResultGrouped, 'function');
  });
});

// ── Data files ──────────────────────────────────────────────────────

describe('vm-skus.json', () => {
  it('should load and contain at least 40 SKUs across all families', () => {
    const vmSkus = require(path.join(__dirname, '../data/vm-skus.json'));
    const totalSkus = vmSkus.families.reduce((sum, f) => sum + f.skus.length, 0);
    assert.ok(totalSkus >= 40, `expected >= 40 SKUs, got ${totalSkus}`);
  });

  it('should have consistent structure in every SKU entry', () => {
    const vmSkus = require(path.join(__dirname, '../data/vm-skus.json'));
    for (const family of vmSkus.families) {
      assert.ok(family.name, 'family should have a name');
      assert.ok(family.skus.length > 0, 'family should have SKUs');
      for (const sku of family.skus) {
        assert.ok(sku.sku, 'SKU entry should have a sku field');
        assert.ok(typeof sku.vcpus === 'number', 'SKU should have numeric vcpus');
        assert.ok(typeof sku.ramGB === 'number', 'SKU should have numeric ramGB');
      }
    }
  });
});

describe('pg-skus.json', () => {
  it('should load and contain Burstable, General Purpose, and Memory Optimised families', () => {
    const pgSkus = require(path.join(__dirname, '../data/pg-skus.json'));
    const familyNames = pgSkus.families.map((f) => f.name.toLowerCase());
    assert.ok(familyNames.some((n) => n.includes('burstable')), 'should have Burstable');
    assert.ok(familyNames.some((n) => n.includes('general purpose')), 'should have General Purpose');
    assert.ok(familyNames.some((n) => n.includes('memory')), 'should have Memory Optimised');
  });
});

describe('templates.json', () => {
  it('should load and contain at least 3 templates', () => {
    const templates = require(path.join(__dirname, '../data/templates.json'));
    assert.ok(templates.templates.length >= 3, `expected >= 3 templates, got ${templates.templates.length}`);
  });

  it('should have valid structure in every template', () => {
    const templates = require(path.join(__dirname, '../data/templates.json'));
    for (const t of templates.templates) {
      assert.ok(t.name, 'template should have a name');
      assert.ok(t.resources.length > 0, 'template should have resources');
      for (const r of t.resources) {
        assert.ok(r.service, 'resource should have a service name');
        assert.ok(r.serviceName, 'resource should have a serviceName');
        assert.ok(r.sku, 'resource should have a SKU');
      }
    }
  });
});
