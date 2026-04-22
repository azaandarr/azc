// json.js — Clean JSON output formatter for piping to jq or other tools.
// Produces a structured object with metadata, per-resource costs, and totals.
// Used by both `azc scan --format json` and `azc scan --out report.json`.

const { monthlyToAnnual } = require('../utils/currency');

/**
 * Build a structured JSON result object from scan data.
 *
 * @param {object} params
 * @param {string} params.subscription    - Subscription name or alias
 * @param {string} params.subscriptionId  - Subscription GUID
 * @param {string} params.region          - Azure region
 * @param {string} params.currency        - Currency code
 * @param {Array<object>} params.resources    - Priced resources
 * @param {Array<object>} params.unsupported  - Unsupported resource types
 * @param {Array<object>} params.unpriced     - Resources where pricing failed
 * @returns {object} Structured JSON object
 */
function buildScanJson({ subscription, subscriptionId, region, currency, resources, unsupported, unpriced }) {
  // Only sum non-usage-based resources for the total
  const totalMonthlyCost = resources
    .filter((r) => !r.usageBased)
    .reduce((sum, r) => sum + r.monthlyCost, 0);

  return {
    subscription,
    subscriptionId,
    region,
    currency,
    generatedAt: new Date().toISOString(),
    resources: resources.map((r) => ({
      name: r.name,
      type: r.type,
      sku: r.sku,
      monthlyCost: round2(r.monthlyCost),
      annualCost: round2(monthlyToAnnual(r.monthlyCost)),
      notes: r.notes || undefined,
      usageBased: r.usageBased || undefined,
    })),
    unpricedResources: (unpriced || []).map((r) => ({
      name: r.name,
      type: r.type,
      reason: r.reason,
    })),
    unsupportedResources: (unsupported || []).map((r) => ({
      name: r.name,
      type: r.type,
    })),
    totalMonthlyCost: round2(totalMonthlyCost),
    totalAnnualCost: round2(monthlyToAnnual(totalMonthlyCost)),
  };
}

/**
 * Build a structured JSON result from a compare operation.
 *
 * @param {object} params
 * @param {string} params.resourceName
 * @param {string} params.resourceType
 * @param {object} params.current   - { sku, monthlyCost }
 * @param {object} params.proposed  - { sku, monthlyCost }
 * @param {string} params.currency
 * @returns {object}
 */
function buildCompareJson({ resourceName, resourceType, current, proposed, currency }) {
  const delta = proposed.monthlyCost - current.monthlyCost;
  const pctChange = current.monthlyCost > 0
    ? ((delta / current.monthlyCost) * 100)
    : 0;

  return {
    resourceName,
    resourceType,
    currency,
    generatedAt: new Date().toISOString(),
    current: {
      sku: current.sku,
      monthlyCost: round2(current.monthlyCost),
      annualCost: round2(monthlyToAnnual(current.monthlyCost)),
    },
    proposed: {
      sku: proposed.sku,
      monthlyCost: round2(proposed.monthlyCost),
      annualCost: round2(monthlyToAnnual(proposed.monthlyCost)),
    },
    delta: {
      monthly: round2(delta),
      annual: round2(monthlyToAnnual(delta)),
      percentChange: round1(pctChange),
    },
  };
}

/**
 * Build a structured JSON result from a plan estimate.
 *
 * @param {object} params
 * @param {string} params.region
 * @param {string} params.currency
 * @param {Array<object>} params.items - Array of { service, sku, monthlyCost, notes }
 * @returns {object}
 */
function buildPlanJson({ region, currency, items }) {
  const totalMonthlyCost = items.reduce((sum, i) => sum + i.monthlyCost, 0);

  return {
    region,
    currency,
    generatedAt: new Date().toISOString(),
    items: items.map((i) => ({
      service: i.service,
      sku: i.sku,
      monthlyCost: round2(i.monthlyCost),
      annualCost: round2(monthlyToAnnual(i.monthlyCost)),
      notes: i.notes || undefined,
    })),
    totalMonthlyCost: round2(totalMonthlyCost),
    totalAnnualCost: round2(monthlyToAnnual(totalMonthlyCost)),
  };
}

// Round to 2 decimal places for currency values
function round2(n) { return Math.round(n * 100) / 100; }
// Round to 1 decimal place for percentages
function round1(n) { return Math.round(n * 10) / 10; }

module.exports = {
  buildScanJson,
  buildCompareJson,
  buildPlanJson,
};
