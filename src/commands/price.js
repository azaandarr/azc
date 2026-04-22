// price.js — `azc price` command.
// Quick single-resource price lookup against the public Azure Retail Prices API.
// No Azure subscription or authentication required — great for ad-hoc lookups.
//
// Parses a free-text query like "App Service P1v3" into the correct API filter
// by resolving the service name against sku-mappings.json aliases, then treating
// the remaining words as the SKU identifier.

const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');
const { lookupPrice } = require('../services/retail-prices');
const { renderPriceLookup } = require('../formatters/table');
const { createSpinner } = require('../utils/spinner');

// Load the static service alias mappings at module load time.
// This is a small JSON file so the cost is negligible.
const skuMappings = require(path.join(__dirname, '../../data/sku-mappings.json'));

/**
 * Parse a free-text price query into a service name and SKU.
 * The user types something like "App Service P1v3" or "VM Standard_D4s_v5".
 * We need to figure out which part is the service name and which is the SKU.
 *
 * Strategy:
 * 1. Try progressively shorter prefixes of the query against our alias list
 * 2. The longest matching prefix is the service name
 * 3. Everything after the match is the SKU
 *
 * Example: "App Service P1v3"
 *   - Try "app service p1v3" → no match
 *   - Try "app service" → matches alias for Azure App Service
 *   - Remaining: "P1v3" → that's the SKU
 *
 * @param {string} query - The raw user query
 * @returns {{ serviceName: string, sku: string, skuField: string } | null}
 */
function parseQuery(query) {
  const words = query.trim().split(/\s+/);

  // Build a flat lookup map: lowercase alias → service entry
  const aliasMap = {};
  for (const [, entry] of Object.entries(skuMappings.services)) {
    for (const alias of entry.aliases) {
      aliasMap[alias.toLowerCase()] = entry;
    }
    // Also index by the full serviceName for direct matches
    aliasMap[entry.serviceName.toLowerCase()] = entry;
  }

  // Try progressively shorter prefixes to find the service name.
  // Start with the most words and work down — greedy matching ensures
  // "App Service" beats "App" when the user types "App Service P1v3".
  for (let i = words.length; i >= 1; i--) {
    const prefix = words.slice(0, i).join(' ').toLowerCase();
    const match = aliasMap[prefix];
    if (match) {
      const sku = words.slice(i).join(' ') || '';
      return {
        serviceName: match.serviceName,
        sku: sku,
        skuField: match.skuField,
        defaultPriceType: match.defaultPriceType,
      };
    }
  }

  return null;
}

/**
 * Register the price command on the parent commander program.
 * @param {import('commander').Command} program
 */
module.exports = function registerPriceCommand(program) {
  program
    .command('price')
    .description('Look up pricing for a single Azure resource (no auth required)')
    .argument('<query>', 'Service and SKU, e.g. "App Service P1v3" or "VM Standard_D4s_v5"')
    .option('-r, --region <region>', 'Azure region', config.getDefault('region'))
    .option('--os <type>', 'OS type: linux or windows', config.getDefault('os'))
    .option('-c, --currency <code>', 'Currency code: GBP, USD, EUR', config.getDefault('currency'))
    .action(async (query, opts) => {
      // Parse the free-text query into service name + SKU
      const parsed = parseQuery(query);

      if (!parsed) {
        logger.error(
          `Could not identify an Azure service in "${query}".\n` +
          '  Try a format like: "App Service P1v3", "VM Standard_D4s_v5", "PostgreSQL D2ds_v4"\n' +
          '  Supported services: ' + Object.values(skuMappings.services).map((s) => s.aliases[0]).join(', '),
          'AZC_PARSE_FAILED'
        );
        process.exit(1);
      }

      // Build the API filter parameters.
      // The Retail Prices API is inconsistent about which field holds the SKU —
      // some services use armSkuName, others use skuName, and the format often
      // differs from what users type (e.g. "P1v3" vs "P1 v3"). So we:
      // 1. First try the service's preferred skuField
      // 2. If that returns nothing, try a broader query without the SKU filter
      //    and post-filter by matching skuName/armSkuName/meterName client-side
      const params = {
        serviceName: parsed.serviceName,
        armRegionName: opts.region,
        currency: opts.currency,
      };

      const spinner = createSpinner(`Fetching pricing for ${parsed.serviceName}...`);
      spinner.start();

      try {
        let items;

        if (parsed.sku) {
          // Try the exact SKU first with the preferred field
          const exactParams = { ...params, [parsed.skuField]: parsed.sku };
          items = await lookupPrice(exactParams);

          // If exact match returned nothing, fetch all prices for this service
          // in this region and do a fuzzy client-side match on the SKU
          if (items.length === 0) {
            spinner.update(`Broadening search for ${parsed.serviceName}...`);
            const allItems = await lookupPrice(params);
            const skuLower = parsed.sku.toLowerCase().replace(/\s+/g, '');

            items = allItems.filter((item) => {
              // Normalize both sides: strip spaces so "P1 v3" matches "P1v3"
              const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
              const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
              const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
              return skuName.includes(skuLower) || armSku.includes(skuLower) || meter.includes(skuLower);
            });
          }
        } else {
          // No SKU provided — fetch all prices for this service in this region
          items = await lookupPrice(params);
        }

        // Post-filter for OS — applies to VMs and App Service.
        // Match on "linux" in productName explicitly (not absence of "windows")
        // because some Windows products omit "Windows" from their productName.
        let filtered = items;
        if (opts.os) {
          const osLower = opts.os.toLowerCase();
          const osFiltered = items.filter((item) => {
            const prod = (item.productName || '').toLowerCase();
            if (osLower === 'linux') return prod.includes('linux');
            return !prod.includes('linux');
          });
          if (osFiltered.length > 0) filtered = osFiltered;
        }

        spinner.stop(`Found ${filtered.length} price entries`);

        // Render the results as a formatted table
        renderPriceLookup({
          query: `${parsed.serviceName} ${parsed.sku}`.trim(),
          region: opts.region,
          currency: opts.currency,
          items: filtered,
        });
      } catch (err) {
        spinner.fail('Price lookup failed');
        logger.error(
          `Failed to fetch pricing: ${err.message}`,
          'AZC_PRICE_FETCH_FAILED'
        );
        process.exit(1);
      }
    });
};

// Export parseQuery for testing
module.exports.parseQuery = parseQuery;
