// compare.js — `azc compare` command.
// Runs a baseline scan of a subscription, then applies a hypothetical
// SKU/config change and shows the cost delta side-by-side.
//
// Usage:
//   azc compare -s prod --with "App Service:P1v3"
//   azc compare -s prod --with "PostgreSQL:Standard_D4ds_v5" --name prism-db
//   azc compare -s prod    (interactive mode — pick resource and SKU from lists)
//
// The --with flag format is "ServiceAlias:NewSKU[,property=value]".
// If --with is omitted, drops into an interactive flow.

const path = require('path');
const chalk = require('chalk');
const config = require('../config/config');
const logger = require('../utils/logger');
const { validate } = require('../auth/credential');
const { queryResources } = require('../services/resource-graph');
const { mapResource, isSupported } = require('../services/sku-mapper');
const { lookupPrice } = require('../services/retail-prices');
const { renderComparison } = require('../formatters/table');
const { buildCompareJson } = require('../formatters/json');
const { createSpinner } = require('../utils/spinner');
const { formatMoney, hourlyToMonthly } = require('../utils/currency');
const {
  familyPicker,
  enrichChoicesWithPrices,
  lookupSinglePrice,
  NUMBERED_THEME,
} = require('../utils/sku-picker');

// Load service alias mappings for matching the --with service name
const skuMappings = require(path.join(__dirname, '../../data/sku-mappings.json'));

// Map ARM resource type → picker type for interactive SKU selection
const PICKER_MAP = {
  'microsoft.web/serverfarms': 'appservice',
  'microsoft.compute/virtualmachines': 'vm',
  'microsoft.dbforpostgresql/flexibleservers': 'pg',
  'microsoft.cache/redis': 'redis',
  'microsoft.sql/servers/databases': 'sql',
};

// Service name lookup for the pickers
const SERVICE_NAME_MAP = {
  'microsoft.web/serverfarms': 'Azure App Service',
  'microsoft.compute/virtualmachines': 'Virtual Machines',
  'microsoft.dbforpostgresql/flexibleservers': 'Azure Database for PostgreSQL',
  'microsoft.cache/redis': 'Redis Cache',
  'microsoft.sql/servers/databases': 'SQL Database',
};

// SKU choices for static pickers
const SKU_CHOICES = {
  appservice: ['F1', 'B1', 'B2', 'B3', 'S1', 'S2', 'S3', 'P1v3', 'P2v3', 'P3v3'],
  redis: ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', 'P5'],
  sql: ['S0', 'S1', 'S2', 'S3', 'GP_Gen5_2', 'GP_Gen5_4', 'GP_Gen5_8', 'BC_Gen5_2', 'BC_Gen5_4'],
};

/**
 * Parse the --with spec into a service match and proposed SKU.
 * Format: "ServiceAlias:NewSKU[,property=value,...]"
 */
function parseChangeSpec(spec) {
  const colonIdx = spec.indexOf(':');
  if (colonIdx === -1) {
    return null;
  }

  const serviceAlias = spec.substring(0, colonIdx).trim();
  const rest = spec.substring(colonIdx + 1).trim();
  const parts = rest.split(',').map((p) => p.trim());
  const newSku = parts[0];
  const props = {};

  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf('=');
    if (eqIdx > 0) {
      const key = parts[i].substring(0, eqIdx).trim();
      const value = parts[i].substring(eqIdx + 1).trim();
      props[key] = value;
    }
  }

  return { serviceAlias, newSku, props };
}

/**
 * Find the ARM resource type(s) that match a service alias.
 */
function resolveServiceType(alias) {
  const lowerAlias = alias.toLowerCase();

  const aliasToType = {
    'app service': ['microsoft.web/serverfarms'],
    'app service plan': ['microsoft.web/serverfarms'],
    'serverfarm': ['microsoft.web/serverfarms'],
    'vm': ['microsoft.compute/virtualmachines'],
    'virtual machine': ['microsoft.compute/virtualmachines'],
    'postgresql': ['microsoft.dbforpostgresql/flexibleservers'],
    'postgres': ['microsoft.dbforpostgresql/flexibleservers'],
    'pg': ['microsoft.dbforpostgresql/flexibleservers'],
    'storage': ['microsoft.storage/storageaccounts'],
    'cosmos': ['microsoft.documentdb/databaseaccounts'],
    'cosmos db': ['microsoft.documentdb/databaseaccounts'],
    'redis': ['microsoft.cache/redis'],
    'key vault': ['microsoft.keyvault/vaults'],
    'keyvault': ['microsoft.keyvault/vaults'],
    'app insights': ['microsoft.insights/components'],
    'cdn': ['microsoft.cdn/profiles'],
    'app gateway': ['microsoft.network/applicationgateways'],
    'application gateway': ['microsoft.network/applicationgateways'],
    'sql': ['microsoft.sql/servers/databases'],
    'sql database': ['microsoft.sql/servers/databases'],
    'service bus': ['microsoft.servicebus/namespaces'],
    'disk': ['microsoft.compute/disks'],
    'managed disk': ['microsoft.compute/disks'],
    'public ip': ['microsoft.network/publicipaddresses'],
    'acr': ['microsoft.containerregistry/registries'],
    'container registry': ['microsoft.containerregistry/registries'],
  };

  return aliasToType[lowerAlias] || [];
}

/**
 * Register the compare command on the parent commander program.
 */
module.exports = function registerCompareCommand(program) {
  program
    .command('compare')
    .description('Compare current costs against a hypothetical SKU change')
    .requiredOption('-s, --subscription <name-or-id>', 'Subscription name (from config) or GUID')
    .option('-w, --with <spec>', 'Change spec, e.g. "App Service:P1v3" or "PostgreSQL:Standard_D4ds_v5"')
    .option('--name <resource-name>', 'Disambiguate when multiple resources of the same type exist')
    .option('-r, --region <region>', 'Override region for pricing lookup', config.getDefault('region'))
    .option('-c, --currency <code>', 'Currency code: GBP, USD, EUR', config.getDefault('currency'))
    .option('-f, --format <type>', 'Output format: table or json', config.getDefault('format'))
    .action(async (opts) => {
      const authSpinner = createSpinner('Authenticating...');
      authSpinner.start();
      await validate();
      authSpinner.stop('Authenticated');

      const subscriptionId = config.resolveSubscription(opts.subscription);

      const scanSpinner = createSpinner('Scanning subscription...');
      scanSpinner.start();

      let resources;
      try {
        resources = await queryResources({ subscriptionId });
      } catch (err) {
        scanSpinner.fail('Scan failed');
        logger.error(`Failed to query resources: ${err.message}`, 'AZC_GRAPH_FAILED');
        process.exit(1);
      }
      scanSpinner.stop(`Found ${resources.length} resource(s)`);

      // ── Interactive mode (no --with flag) ───────────────────────
      if (!opts.with) {
        await interactiveCompare(resources, opts, subscriptionId);
        return;
      }

      // ── CLI mode (--with flag provided) ─────────────────────────
      const change = parseChangeSpec(opts.with);
      if (!change) {
        logger.error(
          'Invalid --with format. Expected "ServiceAlias:NewSKU[,property=value]"\n' +
          '  Examples:\n' +
          '    --with "App Service:P1v3"\n' +
          '    --with "PostgreSQL:Standard_D4ds_v5,storage=256GB"',
          'AZC_PARSE_FAILED'
        );
        process.exit(1);
      }

      const targetTypes = resolveServiceType(change.serviceAlias);
      if (targetTypes.length === 0) {
        logger.error(
          `Unknown service: "${change.serviceAlias}"\n` +
          '  Supported: App Service, VM, PostgreSQL, Storage, Cosmos, Redis, Key Vault,\n' +
          '  App Insights, CDN, App Gateway, SQL, Service Bus, Disk, Public IP, ACR',
          'AZC_UNKNOWN_SERVICE'
        );
        process.exit(1);
      }

      const candidates = resources.filter((r) => targetTypes.includes(r.type));

      if (candidates.length === 0) {
        logger.error(
          `No ${change.serviceAlias} resources found in subscription ${subscriptionId}.`,
          'AZC_NO_MATCH'
        );
        process.exit(1);
      }

      let target;
      if (candidates.length === 1) {
        target = candidates[0];
      } else if (opts.name) {
        target = candidates.find((r) => r.name.toLowerCase() === opts.name.toLowerCase());
        if (!target) {
          logger.error(
            `No ${change.serviceAlias} resource named "${opts.name}" found.\n` +
            '  Available: ' + candidates.map((r) => r.name).join(', '),
            'AZC_NAME_NOT_FOUND'
          );
          process.exit(1);
        }
      } else {
        logger.error(
          `Found ${candidates.length} ${change.serviceAlias} resources. Use --name to pick one:\n` +
          candidates.map((r) => `  • ${r.name}`).join('\n'),
          'AZC_AMBIGUOUS'
        );
        process.exit(1);
      }

      logger.dim(`Comparing: ${target.name} (${target.type})`);
      await runComparison(target, change.newSku, change.props, opts);
    });
};

/**
 * Interactive compare mode — user picks a resource, then picks a new SKU
 * using the appropriate picker (family picker for VMs/PG, enriched choices
 * for App Service/Redis/SQL, free text for everything else).
 */
async function interactiveCompare(resources, opts, subscriptionId) {
  const { select, input } = require('@inquirer/prompts');

  const pricedResources = [];
  const priceSpinner = createSpinner('Pricing resources...');
  priceSpinner.start();

  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    if (!isSupported(r.type)) continue;

    const descriptor = mapResource(r);
    if (!descriptor || descriptor.usageBased) continue;

    priceSpinner.progress(i + 1, resources.length, r.name);

    try {
      const cost = await priceFromDescriptor(descriptor, r.location || opts.region, opts.currency);
      const skuLabel = (r.sku && r.sku.name)
        || (r.properties && r.properties.hardwareProfile && r.properties.hardwareProfile.vmSize)
        || descriptor.skuMatch || '—';

      pricedResources.push({
        resource: r,
        descriptor,
        skuLabel,
        monthlyCost: cost,
      });
    } catch (_) {}
  }

  priceSpinner.stop(`${pricedResources.length} priced resource(s)`);

  if (pricedResources.length === 0) {
    logger.warn('No priced resources found to compare.');
    return;
  }

  const resourceChoices = pricedResources.map((pr, i) => ({
    name: `${pr.resource.name.padEnd(24)} ${chalk.dim(pr.resource.type.split('/').pop().padEnd(20))} ${chalk.blue(String(pr.skuLabel).padEnd(16))} ${chalk.green(formatMoney(pr.monthlyCost, opts.currency) + '/mo')}`,
    value: i,
  }));

  const selectedIdx = await select({
    message: 'Which resource do you want to re-spec?',
    choices: resourceChoices,
    theme: NUMBERED_THEME,
  });

  const selected = pricedResources[selectedIdx];
  const pickerType = PICKER_MAP[selected.resource.type];
  let newSku;

  // Use the appropriate picker based on resource type
  if (pickerType === 'vm' || pickerType === 'pg') {
    newSku = await familyPicker(pickerType, select, input, {}, {
      region: opts.region,
      currency: opts.currency,
      serviceName: SERVICE_NAME_MAP[selected.resource.type],
      os: selected.descriptor.os,
    });
  } else if (pickerType && SKU_CHOICES[pickerType]) {
    // Static picker with inline prices and cost deltas
    const serviceName = SERVICE_NAME_MAP[selected.resource.type];
    const enriched = await enrichChoicesWithPrices({
      serviceName,
      choices: SKU_CHOICES[pickerType],
      os: selected.descriptor.os,
      tier: selected.descriptor.productFilter,
      region: opts.region,
      currency: opts.currency,
    });

    // Annotate with cost deltas and mark current SKU
    const annotated = enriched.map((c) => {
      const isCurrent = c.value.toLowerCase() === (selected.skuLabel || '').toLowerCase();
      let label = c.name;
      if (isCurrent) {
        label += chalk.yellow(' ← current');
      } else if (c.monthly != null) {
        const delta = c.monthly - selected.monthlyCost;
        if (delta > 0) label += chalk.red(` ↑ ${formatMoney(delta, opts.currency)}/mo more`);
        else if (delta < 0) label += chalk.green(` ↓ ${formatMoney(Math.abs(delta), opts.currency)}/mo cheaper`);
      }
      return { ...c, name: label };
    });

    newSku = await select({
      message: `New SKU for ${selected.resource.name} (currently ${selected.skuLabel}):`,
      choices: annotated,
      theme: NUMBERED_THEME,
    });
  } else {
    // Fallback: free text input
    newSku = await input({
      message: `New SKU for ${selected.resource.name} (currently ${selected.skuLabel}):`,
    });
  }

  await runComparison(selected.resource, newSku, {}, opts);

  logger.spacer();
  logger.dim(`Tip: azc compare -s ${subscriptionId.substring(0, 8)}... --with "${selected.resource.type.split('/').pop()}:${newSku}" for non-interactive use`);
}

/**
 * Run the comparison between current and proposed config and output results.
 */
async function runComparison(target, newSku, props, opts) {
  const priceSpinner = createSpinner('Looking up current and proposed prices...');
  priceSpinner.start();

  const currentDescriptor = mapResource(target);
  if (!currentDescriptor) {
    priceSpinner.fail('Could not map current resource');
    logger.error(`Could not extract pricing info from ${target.name}`, 'AZC_MAP_FAILED');
    process.exit(1);
  }

  let currentMonthlyCost;
  try {
    currentMonthlyCost = await priceFromDescriptor(currentDescriptor, target.location || opts.region, opts.currency);
  } catch (err) {
    priceSpinner.fail('Current price lookup failed');
    logger.error(`Could not price current config: ${err.message}`, 'AZC_PRICE_FAILED');
    process.exit(1);
  }

  let proposedMonthlyCost;
  try {
    const proposedItems = await lookupPrice({
      serviceName: currentDescriptor.serviceName,
      armRegionName: target.location || opts.region,
      priceType: 'Consumption',
      currency: opts.currency,
    });

    const skuLower = newSku.toLowerCase().replace(/\s+/g, '');
    let matched = proposedItems.filter((item) => {
      const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
      const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
      const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
      return skuName.includes(skuLower) || armSku.includes(skuLower) || meter.includes(skuLower);
    });

    if (currentDescriptor.os) {
      const osFiltered = matched.filter((item) => {
        const prod = (item.productName || '').toLowerCase();
        if (currentDescriptor.os === 'linux') return prod.includes('linux');
        return !prod.includes('linux');
      });
      if (osFiltered.length > 0) matched = osFiltered;
    }

    matched = matched.filter((item) => {
      const meter = (item.meterName || '').toLowerCase();
      const sku = (item.skuName || '').toLowerCase();
      return !meter.includes('spot') && !meter.includes('low priority') &&
             !sku.includes('spot') && !sku.includes('low priority');
    });

    if (matched.length === 0) {
      throw new Error(`No price found for SKU "${newSku}" in ${currentDescriptor.serviceName}`);
    }

    const priceItem = matched[0];
    const unit = (priceItem.unitOfMeasure || '').toLowerCase();
    let rate = priceItem.retailPrice;

    if (unit.includes('hour')) {
      proposedMonthlyCost = hourlyToMonthly(rate);
    } else if (unit.includes('month')) {
      proposedMonthlyCost = rate;
    } else if (unit.includes('day')) {
      proposedMonthlyCost = rate * 30;
    } else {
      proposedMonthlyCost = rate;
    }

    const instances = props.instances
      ? parseInt(props.instances, 10)
      : (currentDescriptor.quantity || 1);
    proposedMonthlyCost *= instances;

  } catch (err) {
    priceSpinner.fail('Proposed price lookup failed');
    logger.error(`Could not price proposed config: ${err.message}`, 'AZC_PRICE_FAILED');
    process.exit(1);
  }

  priceSpinner.stop('Prices fetched');

  const currentSkuLabel = (target.sku && target.sku.name)
    || (target.properties && target.properties.hardwareProfile && target.properties.hardwareProfile.vmSize)
    || currentDescriptor.skuMatch || '—';

  const compareData = {
    resourceName: target.name,
    resourceType: target.type,
    current: { sku: currentSkuLabel, monthlyCost: currentMonthlyCost },
    proposed: { sku: newSku, monthlyCost: proposedMonthlyCost },
    currency: opts.currency,
  };

  if (opts.format === 'json') {
    const result = buildCompareJson(compareData);
    logger.raw(JSON.stringify(result, null, 2) + '\n');
  } else {
    renderComparison(compareData);
  }
}

/**
 * Calculate monthly cost from a SKU mapper descriptor.
 */
async function priceFromDescriptor(descriptor, region, currency) {
  if (descriptor.usageBased) return 0;

  const params = {
    serviceName: descriptor.serviceName,
    armRegionName: region,
    priceType: 'Consumption',
    currency,
    ...descriptor.filters,
  };

  const items = await lookupPrice(params);

  let matched = items;
  if (descriptor.skuMatch) {
    const target = descriptor.skuMatch.toLowerCase().replace(/\s+/g, '');
    matched = items.filter((item) => {
      const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
      const meterName = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
      const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
      return skuName.includes(target) || meterName.includes(target) || armSku.includes(target);
    });
  }

  if (descriptor.productFilter) {
    const pf = descriptor.productFilter.toLowerCase();
    const pfFiltered = matched.filter((item) => {
      return (item.productName || '').toLowerCase().includes(pf);
    });
    if (pfFiltered.length > 0) matched = pfFiltered;
  }

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

  matched = matched.filter((item) => {
    const meter = (item.meterName || '').toLowerCase();
    const sku = (item.skuName || '').toLowerCase();
    return !meter.includes('spot') && !meter.includes('low priority') &&
           !sku.includes('spot') && !sku.includes('low priority');
  });

  if (matched.length === 0) {
    throw new Error('No matching price found');
  }

  const priceItem = matched[0];
  const unit = (priceItem.unitOfMeasure || '').toLowerCase();
  let monthlyCost;

  if (unit.includes('hour')) {
    monthlyCost = hourlyToMonthly(priceItem.retailPrice);
  } else if (unit.includes('month')) {
    monthlyCost = priceItem.retailPrice;
  } else if (unit.includes('day')) {
    monthlyCost = priceItem.retailPrice * 30;
  } else {
    monthlyCost = priceItem.retailPrice;
  }

  monthlyCost *= descriptor.quantity || 1;
  return monthlyCost;
}

module.exports.parseChangeSpec = parseChangeSpec;
