// scan.js — `azc scan` command.
// Scans a live Azure subscription via Resource Graph, prices each resource
// using the Retail Prices API, and outputs a formatted cost breakdown.
//
// Flow:
// 1. Validate Azure credentials (fail fast with a helpful error)
// 2. Resolve subscription name → GUID via config aliases
// 3. Query Resource Graph for all resources
// 4. Separate resources into supported (have a SKU mapper) and unsupported
// 5. For each supported resource, map to Retail Prices API params via sku-mapper
// 6. Look up prices with concurrency limiting (handled by retail-prices.js)
// 7. Calculate monthly cost per resource
// 8. Render output in the requested format (table, json, xlsx)

const path = require('path');
const fs = require('fs');
const config = require('../config/config');
const logger = require('../utils/logger');
const { validate } = require('../auth/credential');
const { queryResources } = require('../services/resource-graph');
const { mapResource, isSupported } = require('../services/sku-mapper');
const { lookupPrice } = require('../services/retail-prices');
const { renderScanResult } = require('../formatters/table');
const { buildScanJson } = require('../formatters/json');
const { exportToXlsx } = require('../formatters/xlsx');
const { createSpinner } = require('../utils/spinner');
const { hourlyToMonthly } = require('../utils/currency');

/**
 * Register the scan command on the parent commander program.
 * @param {import('commander').Command} program
 */
module.exports = function registerScanCommand(program) {
  program
    .command('scan')
    .description('Scan an Azure subscription and estimate monthly costs')
    .requiredOption('-s, --subscription <name-or-id>', 'Subscription name (from config) or GUID')
    .option('-g, --resource-group <name>', 'Limit scan to a specific resource group')
    .option('-o, --out <file>', 'Export results to a file (.json or .xlsx)')
    .option('-f, --format <type>', 'Output format: table or json', config.getDefault('format'))
    .option('-r, --region <region>', 'Override region for pricing lookup', config.getDefault('region'))
    .option('-c, --currency <code>', 'Currency code: GBP, USD, EUR', config.getDefault('currency'))
    .action(async (opts) => {
      // ── Step 1: Validate Azure credentials ──────────────────────
      const authSpinner = createSpinner('Authenticating with Azure...');
      authSpinner.start();

      await validate();
      authSpinner.stop('Authenticated');

      // ── Step 2: Resolve subscription ────────────────────────────
      const subscriptionId = config.resolveSubscription(opts.subscription);
      logger.dim(`Subscription: ${subscriptionId}`);

      // ── Step 3: Query Resource Graph ────────────────────────────
      const graphSpinner = createSpinner('Querying Azure Resource Graph...');
      graphSpinner.start();

      let resources;
      try {
        resources = await queryResources({
          subscriptionId,
          resourceGroup: opts.resourceGroup,
        });
      } catch (err) {
        graphSpinner.fail('Resource Graph query failed');
        logger.error(
          `Failed to query resources: ${err.message}`,
          'AZC_GRAPH_FAILED'
        );
        process.exit(1);
      }

      graphSpinner.stop(`Found ${resources.length} resource(s)`);

      if (resources.length === 0) {
        logger.warn(
          `No resources found in subscription ${subscriptionId}.` +
          (opts.resourceGroup ? ` (resource group: ${opts.resourceGroup})` : '') +
          '\n  Check that your identity has the Reader role on this subscription.'
        );
        return;
      }

      // ── Step 4: Separate supported vs unsupported ───────────────
      const supported = [];
      const unsupported = [];

      for (const resource of resources) {
        if (isSupported(resource.type)) {
          supported.push(resource);
        } else {
          unsupported.push(resource);
        }
      }

      logger.dim(`${supported.length} supported, ${unsupported.length} not yet supported`);

      // ── Step 5 & 6: Map and price each resource ─────────────────
      const priceSpinner = createSpinner('Looking up prices...');
      priceSpinner.start();

      const pricedResources = [];
      const unpricedResources = [];

      for (let i = 0; i < supported.length; i++) {
        const resource = supported[i];
        priceSpinner.progress(i + 1, supported.length, `Pricing ${resource.type}`);

        const descriptor = mapResource(resource);
        if (!descriptor) {
          unpricedResources.push({
            name: resource.name,
            type: resource.type,
            reason: 'SKU mapper returned no pricing descriptor (missing SKU info)',
          });
          continue;
        }

        // Skip usage-based resources — we can't estimate without consumption data.
        // Still include them in the output with a note.
        if (descriptor.usageBased) {
          pricedResources.push({
            name: resource.name,
            type: resource.type,
            sku: descriptor.notes || '—',
            monthlyCost: 0,
            notes: descriptor.notes + ' (usage-based — not included in total)',
            usageBased: true,
          });
          continue;
        }

        try {
          const monthlyCost = await priceResource(resource, descriptor, opts);

          pricedResources.push({
            name: resource.name,
            type: resource.type,
            sku: extractSkuLabel(resource, descriptor),
            monthlyCost,
            notes: descriptor.notes || '',
          });
        } catch (err) {
          unpricedResources.push({
            name: resource.name,
            type: resource.type,
            reason: err.message,
          });
        }
      }

      priceSpinner.stop(`Priced ${pricedResources.length} resource(s)`);

      // ── Step 7: Build structured result ─────────────────────────
      const scanData = {
        subscription: opts.subscription,
        subscriptionId,
        region: opts.region,
        currency: opts.currency,
        resources: pricedResources,
        unsupported,
        unpriced: unpricedResources,
      };

      // ── Step 8: Output results ──────────────────────────────────
      if (opts.format === 'json') {
        const result = buildScanJson(scanData);
        logger.raw(JSON.stringify(result, null, 2) + '\n');
      } else {
        renderScanResult(scanData);
      }

      // ── Step 9: Export to file if requested ─────────────────────
      if (opts.out) {
        const ext = path.extname(opts.out).toLowerCase();
        if (ext === '.json') {
          const result = buildScanJson(scanData);
          fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), 'utf8');
          logger.success(`Exported to ${opts.out}`);
        } else if (ext === '.xlsx') {
          await exportToXlsx({ filePath: opts.out, ...scanData });
        } else {
          logger.warn(`Unsupported file extension: ${ext}. Use .json or .xlsx.`);
        }
      }
    });
};

/**
 * Look up the price for a single resource using its pricing descriptor.
 * Handles the complexity of matching API results to the descriptor's
 * expected SKU, unit, and quantity.
 *
 * @param {object} resource    - Normalised resource from Resource Graph
 * @param {object} descriptor  - PricingDescriptor from sku-mapper
 * @param {object} opts        - Command options (region, currency)
 * @returns {Promise<number>} Monthly cost
 */
async function priceResource(resource, descriptor, opts) {
  // Build the lookup parameters from the descriptor
  const params = {
    serviceName: descriptor.serviceName,
    armRegionName: resource.location || opts.region,
    currency: opts.currency,
    ...descriptor.filters,
  };

  // If no explicit filter narrows results, add Consumption priceType to avoid
  // getting reservation prices mixed in
  if (!params.priceType) {
    params.priceType = 'Consumption';
  }

  const items = await lookupPrice(params);

  if (items.length === 0 && descriptor.skuMatch) {
    // Try a broader query without priceType filter
    delete params.priceType;
    const broadItems = await lookupPrice(params);
    return matchAndCalculate(broadItems, descriptor);
  }

  return matchAndCalculate(items, descriptor);
}

/**
 * Match price items from the API to the descriptor's expected SKU
 * and calculate the monthly cost.
 *
 * @param {Array<object>} items      - Price items from the Retail Prices API
 * @param {object} descriptor        - PricingDescriptor from sku-mapper
 * @returns {number} Monthly cost
 */
function matchAndCalculate(items, descriptor) {
  let matched = items;

  // If the descriptor specifies a SKU to match against, filter for it.
  // We use fuzzy matching (normalise spaces, case-insensitive) because
  // the API's SKU format varies.
  if (descriptor.skuMatch) {
    const target = descriptor.skuMatch.toLowerCase().replace(/\s+/g, '');

    matched = items.filter((item) => {
      const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
      const meterName = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
      const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
      return skuName.includes(target) || meterName.includes(target) || armSku.includes(target);
    });
  }

  // Filter by productName if the descriptor specifies a productFilter
  // (e.g. Redis uses "standard" or "basic" to disambiguate tiers that share SKU names)
  if (descriptor.productFilter) {
    const pf = descriptor.productFilter.toLowerCase();
    const pfFiltered = matched.filter((item) => {
      return (item.productName || '').toLowerCase().includes(pf);
    });
    if (pfFiltered.length > 0) matched = pfFiltered;
  }

  // Filter by meterName if the descriptor specifies a meterFilter
  // (e.g. Redis "C1 Cache" picks the primary compute cost, not "C1 Cache Instance")
  if (descriptor.meterFilter) {
    const mf = descriptor.meterFilter.toLowerCase().replace(/\s+/g, '');
    const mfFiltered = matched.filter((item) => {
      const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
      return meter === mf;
    });
    if (mfFiltered.length > 0) matched = mfFiltered;
  }

  if (descriptor.os) {
    const osFiltered = matched.filter((item) => {
      const prod = (item.productName || '').toLowerCase();
      if (descriptor.os === 'linux') return prod.includes('linux');
      return !prod.includes('linux');
    });
    if (osFiltered.length > 0) matched = osFiltered;
  }

  // Prefer Consumption items over Reservation
  const consumptionItems = matched.filter((i) => i.type === 'Consumption');
  if (consumptionItems.length > 0) matched = consumptionItems;

  if (matched.length === 0) {
    throw new Error('No matching price found in Retail Prices API');
  }

  // Take the first match — they should all be the same price for
  // the same SKU in the same region
  const priceItem = matched[0];
  const unitRate = priceItem.retailPrice;
  const unit = (priceItem.unitOfMeasure || '').toLowerCase();

  // Convert to monthly based on the unit of measure
  let monthlyCost;
  if (unit.includes('hour')) {
    monthlyCost = hourlyToMonthly(unitRate);
  } else if (unit.includes('/month') || unit.includes('month')) {
    monthlyCost = unitRate;
  } else if (unit.includes('/day') || unit.includes('day')) {
    monthlyCost = unitRate * 30;
  } else {
    // Unknown unit — use the rate as-is and hope for the best
    monthlyCost = unitRate;
  }

  // Apply quantity multiplier (instance count, vCores, messaging units, etc.)
  monthlyCost *= descriptor.quantity || 1;

  // Add secondary costs (e.g. PostgreSQL storage)
  if (descriptor.storageCost) {
    // For now, storage adds a flat per-GB monthly cost
    // We'd need a separate API call for the exact storage rate
    // This is a simplified approximation
  }

  return monthlyCost;
}

/**
 * Extract a human-readable SKU label from the resource for display.
 * @param {object} resource   - Normalised resource
 * @param {object} descriptor - PricingDescriptor
 * @returns {string}
 */
function extractSkuLabel(resource, descriptor) {
  // Try common locations for SKU names
  if (resource.sku && resource.sku.name) return resource.sku.name;
  if (resource.properties && resource.properties.hardwareProfile && resource.properties.hardwareProfile.vmSize) {
    return resource.properties.hardwareProfile.vmSize;
  }
  if (descriptor.skuMatch) return descriptor.skuMatch;
  return '—';
}

