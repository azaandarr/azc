// price.js — `azc price` command.
// Quick single-resource price lookup against the public Azure Retail Prices API.
// No Azure subscription or authentication required — great for ad-hoc lookups.
//
// Parses a free-text query like "App Service P1v3" into the correct API filter
// by resolving the service name against sku-mappings.json aliases, then treating
// the remaining words as the SKU identifier.
//
// Also supports fuzzy input: "d4s v5" auto-detects as a VM SKU, and
// "4 vcpu 16gb" searches vm-skus.json for a spec match.

const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');
const { lookupPrice } = require('../services/retail-prices');
const { renderPriceLookup, renderServiceOverview } = require('../formatters/table');
const { createSpinner } = require('../utils/spinner');
const { hourlyToMonthly, formatMoney } = require('../utils/currency');

// Load the static service alias mappings at module load time.
const skuMappings = require(path.join(__dirname, '../../data/sku-mappings.json'));
const vmSkus = require(path.join(__dirname, '../../data/vm-skus.json'));

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
 * Try to resolve an ambiguous/fuzzy query that doesn't match any service alias.
 * Handles cases like:
 *   - "d4s v5" → detects VM SKU pattern, auto-prepends "Standard_"
 *   - "4 vcpu 16gb" → searches vm-skus.json for a spec match
 *
 * @param {string} query - The raw user query that failed parseQuery
 * @returns {{ serviceName: string, sku: string, skuField: string, suggestion: string } | null}
 */
function resolveAmbiguousQuery(query) {
  const lower = query.trim().toLowerCase().replace(/\s+/g, '');

  // Pattern 1: looks like a VM SKU without "Standard_" prefix
  // Matches patterns like "d4sv5", "d4s_v5", "d4s v5", "e8sv5", "b2ms", "f4sv2"
  const vmPattern = /^([debflnc]\d+[a-z]*s?_?v?\d*)$/i;
  const normalized = query.trim().replace(/\s+/g, '').toLowerCase();
  const vmMatch = normalized.match(vmPattern);

  if (vmMatch) {
    // Reconstruct as "Standard_XYZ_vN" format
    const raw = vmMatch[1].replace(/_/g, '');
    const candidate = 'Standard_' + raw.replace(/v(\d+)$/i, '_v$1');
    // Try to find it in vm-skus.json to confirm it's valid
    const allVmSkus = vmSkus.families.flatMap((f) => f.skus);
    const found = allVmSkus.find((s) => s.sku.toLowerCase().replace(/\s+/g, '') === candidate.toLowerCase().replace(/\s+/g, ''));
    if (found) {
      return {
        serviceName: 'Virtual Machines',
        sku: found.sku,
        skuField: 'armSkuName',
        suggestion: `Detected as VM: ${found.sku} (${found.vcpus} vCPU, ${found.ramGB} GB RAM)`,
      };
    }
    // Even if not in our data file, try it — the API might have it
    return {
      serviceName: 'Virtual Machines',
      sku: 'Standard_' + query.trim().replace(/\s+/g, '').replace(/v(\d+)$/i, '_v$1'),
      skuField: 'armSkuName',
      suggestion: `Looks like a VM SKU — trying as Standard_${query.trim().replace(/\s+/g, '')}`,
    };
  }

  // Pattern 2: spec-based lookup — "4 vcpu 16gb" or "4vcpu 16gb"
  const specMatch = lower.match(/(\d+)\s*v?cpus?\s*(\d+)\s*g(?:b|igabytes?)?/);
  if (specMatch) {
    const targetCpus = parseInt(specMatch[1], 10);
    const targetRam = parseInt(specMatch[2], 10);
    const allVmSkus = vmSkus.families.flatMap((f) => f.skus);
    const found = allVmSkus.find((s) => s.vcpus === targetCpus && s.ramGB === targetRam);
    if (found) {
      return {
        serviceName: 'Virtual Machines',
        sku: found.sku,
        skuField: 'armSkuName',
        suggestion: `Matched: ${found.sku} (${found.vcpus} vCPU, ${found.ramGB} GB RAM)`,
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
      let parsed = parseQuery(query);

      // If standard parsing fails, try fuzzy resolution
      if (!parsed) {
        const fuzzy = resolveAmbiguousQuery(query);
        if (fuzzy) {
          logger.dim(fuzzy.suggestion);
          parsed = fuzzy;
        }
      }

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

          // If exact match returned nothing, fetch all prices and fuzzy-match
          if (items.length === 0) {
            spinner.update(`Broadening search for ${parsed.serviceName}...`);
            const allItems = await lookupPrice(params);
            const skuLower = parsed.sku.toLowerCase().replace(/\s+/g, '');

            items = allItems.filter((item) => {
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

        // Post-filter for OS
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

        // If no specific SKU was given, show a service overview table instead
        if (!parsed.sku && filtered.length > 0) {
          renderServiceOverview({
            serviceName: parsed.serviceName,
            region: opts.region,
            currency: opts.currency,
            os: opts.os,
            items: filtered,
          });
        } else {
          // Render the results as a formatted table
          renderPriceLookup({
            query: `${parsed.serviceName} ${parsed.sku}`.trim(),
            region: opts.region,
            currency: opts.currency,
            items: filtered,
          });
        }

        // Contextual tip at the end
        logger.spacer();
        if (parsed.sku) {
          logger.dim('Tip: azc compare --subscription <sub> --with "' + parsed.serviceName.split(' ')[0] + ':' + parsed.sku + '" to see the cost impact');
        } else {
          logger.dim('Tip: azc price "' + parsed.serviceName.split(' ').slice(0, 2).join(' ').toLowerCase() + ' <sku>" for detailed pricing on a specific SKU');
        }
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
module.exports.resolveAmbiguousQuery = resolveAmbiguousQuery;
