// plan.js — `azc plan` command.
// Interactive guided cost estimate builder using inquirer prompts.
// Walks the user through selecting a region, adding resources one by one,
// choosing SKUs, and viewing a running total. Saves estimates to
// ~/.azc/estimates/ for reloading and modification later.

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('../config/config');
const logger = require('../utils/logger');
const { lookupPrice } = require('../services/retail-prices');
const { renderScanResult } = require('../formatters/table');
const { buildPlanJson } = require('../formatters/json');
const { exportToXlsx } = require('../formatters/xlsx');
const { createSpinner } = require('../utils/spinner');
const { formatMoney, formatCompact, hourlyToMonthly, monthlyToAnnual } = require('../utils/currency');
const { ESTIMATES_DIR, AZC_HOME } = require('../config/config');

// Load VM and PostgreSQL SKU data files for the family → size picker
const vmSkus = require(path.join(__dirname, '../../data/vm-skus.json'));
const pgSkus = require(path.join(__dirname, '../../data/pg-skus.json'));

// MRU (most recently used) file path — lightweight memory of last choices
const MRU_PATH = path.join(AZC_HOME, 'mru.json');

// Supported service types for the interactive builder.
// Each entry defines the prompts needed to configure that resource,
// plus a category for grouped display in the picker.
const SERVICE_CATALOG = [
  {
    name: 'App Service Plan',
    serviceName: 'Azure App Service',
    category: 'compute',
    prompts: [
      { key: 'sku', message: 'SKU tier', choices: ['F1', 'B1', 'B2', 'B3', 'S1', 'S2', 'S3', 'P1v3', 'P2v3', 'P3v3'] },
      { key: 'os', message: 'Operating system', choices: ['linux', 'windows'] },
      { key: 'instances', message: 'Number of instances', type: 'number', default: 1 },
    ],
    // Companion suggestion shown after adding this resource
    companion: { message: 'Add an Application Insights instance for monitoring?', service: 'Application Insights', defaults: { sku: 'Enterprise', usageBased: true } },
  },
  {
    name: 'Virtual Machine',
    serviceName: 'Virtual Machines',
    category: 'compute',
    // VM uses the two-step family → size picker instead of prompts
    useFamilyPicker: 'vm',
    prompts: [
      { key: 'os', message: 'Operating system', choices: ['linux', 'windows'] },
    ],
    // Companion suggestion: managed disk
    companion: { message: 'Add a Managed Disk?', service: 'Managed Disks', defaults: { sku: 'P10', notes: '128 GB Premium SSD' } },
  },
  {
    name: 'PostgreSQL Flexible Server',
    serviceName: 'Azure Database for PostgreSQL',
    category: 'database',
    // PostgreSQL uses the two-step family → size picker
    useFamilyPicker: 'pg',
    prompts: [],
  },
  {
    name: 'Azure SQL Database',
    serviceName: 'SQL Database',
    category: 'database',
    prompts: [
      { key: 'sku', message: 'SKU name', choices: ['S0', 'S1', 'S2', 'S3', 'GP_Gen5_2', 'GP_Gen5_4', 'GP_Gen5_8', 'BC_Gen5_2', 'BC_Gen5_4'] },
    ],
  },
  {
    name: 'Redis Cache',
    serviceName: 'Redis Cache',
    category: 'database',
    prompts: [
      { key: 'tier', message: 'Pricing tier', choices: ['Basic', 'Standard', 'Premium'] },
      { key: 'sku', message: 'Cache size', choices: ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', 'P5'] },
    ],
  },
  {
    name: 'Application Gateway',
    serviceName: 'Application Gateway',
    category: 'networking',
    prompts: [
      { key: 'sku', message: 'SKU', choices: ['Basic', 'Small', 'Medium', 'Large', 'Standard'] },
      { key: 'instances', message: 'Capacity units', type: 'number', default: 1 },
    ],
  },
  {
    name: 'Service Bus',
    serviceName: 'Service Bus',
    category: 'networking',
    prompts: [
      { key: 'sku', message: 'Tier', choices: ['Basic', 'Standard', 'Premium'] },
      { key: 'instances', message: 'Messaging units (Premium only)', type: 'number', default: 1 },
    ],
  },
  {
    name: 'Container Registry',
    serviceName: 'Container Registry',
    category: 'other',
    prompts: [
      { key: 'sku', message: 'Tier', choices: ['Basic', 'Standard', 'Premium'] },
    ],
  },
];

// Category display order and labels for the grouped service picker
const CATEGORY_ORDER = ['compute', 'database', 'networking', 'other'];
const CATEGORY_LABELS = {
  compute: 'COMPUTE',
  database: 'DATABASE',
  networking: 'NETWORKING',
  other: 'OTHER',
};
const CATEGORY_ICONS = {
  compute: '⚡',
  database: '◆',
  networking: '◇',
  other: '▣',
};

// Common Azure regions for the region picker
const COMMON_REGIONS = [
  'uksouth', 'ukwest',
  'westeurope', 'northeurope',
  'eastus', 'eastus2', 'westus2', 'centralus',
  'southeastasia', 'eastasia',
  'australiaeast',
];

// Quick-start templates for --quick mode
let templates = null;
function loadTemplates() {
  if (!templates) {
    templates = require(path.join(__dirname, '../../data/templates.json'));
  }
  return templates;
}

/**
 * Load the MRU (most recently used) data from ~/.azc/mru.json.
 * Returns an empty object if the file doesn't exist or is corrupt.
 */
function loadMru() {
  try {
    if (fs.existsSync(MRU_PATH)) {
      return JSON.parse(fs.readFileSync(MRU_PATH, 'utf8'));
    }
  } catch (_) {
    // Corrupt MRU file — ignore and start fresh
  }
  return {};
}

/**
 * Save MRU data to disk. Creates the directory if needed.
 */
function saveMru(mru) {
  try {
    const dir = path.dirname(MRU_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MRU_PATH, JSON.stringify(mru, null, 2), 'utf8');
  } catch (_) {
    // Non-critical — don't crash if we can't save MRU
  }
}

/**
 * Two-step family → size picker for VMs and PostgreSQL.
 * Step 1: pick a family (with spec ranges shown inline).
 * Step 2: pick a specific size from that family (with vCPU/RAM inline).
 * Escape hatch: "Type a custom SKU..." for edge cases.
 *
 * @param {string} type - 'vm' or 'pg'
 * @param {Function} select - inquirer select function
 * @param {Function} input  - inquirer input function
 * @param {object} mru      - MRU data for default selection
 * @returns {string} The selected SKU string (e.g. "Standard_D4s_v5")
 */
async function familyPicker(type, select, input, mru) {
  const data = type === 'vm' ? vmSkus : pgSkus;
  const mruKey = type === 'vm' ? 'lastVmSku' : 'lastPgSku';
  const lastSku = mru[mruKey] || '';

  // Build family choices with spec ranges shown inline
  const familyChoices = data.families.map((fam, idx) => {
    const minCpu = Math.min(...fam.skus.map((s) => s.vcpus));
    const maxCpu = Math.max(...fam.skus.map((s) => s.vcpus));
    const minRam = Math.min(...fam.skus.map((s) => s.ramGB));
    const maxRam = Math.max(...fam.skus.map((s) => s.ramGB));
    const specRange = `(${minCpu}-${maxCpu} vCPU, ${minRam}-${maxRam} GB)`;
    const label = `${fam.description}  ${chalk.dim(specRange)}`;
    return { name: `${fam.name.split('(')[0].trim().padEnd(22)} ${label}`, value: idx };
  });

  // Escape hatch as the last option
  familyChoices.push({ name: chalk.dim('↳ Type a custom SKU...'), value: -1 });

  // Pre-select the family that contains the last-used SKU
  let defaultFamily;
  if (lastSku) {
    defaultFamily = data.families.findIndex((fam) =>
      fam.skus.some((s) => s.sku === lastSku)
    );
    if (defaultFamily === -1) defaultFamily = undefined;
  }

  const familyIdx = await select({
    message: type === 'vm' ? 'Pick a VM family:' : 'Pick a PostgreSQL tier:',
    choices: familyChoices,
    default: defaultFamily,
  });

  // Escape hatch — free-text input for custom SKUs
  if (familyIdx === -1) {
    return await input({
      message: type === 'vm' ? 'VM size' : 'Compute SKU',
      default: lastSku || '',
    });
  }

  const family = data.families[familyIdx];

  // Build size choices with vCPU/RAM inline
  const sizeChoices = family.skus.map((s) => {
    const cpuStr = String(s.vcpus).padStart(2);
    const ramStr = String(s.ramGB).padStart(4);
    return {
      name: `${s.sku.padEnd(22)} ${cpuStr} vCPU  ${ramStr} GB RAM`,
      value: s.sku,
    };
  });

  const selectedSku = await select({
    message: 'Pick a size:',
    choices: sizeChoices,
    default: lastSku && family.skus.some((s) => s.sku === lastSku) ? lastSku : undefined,
  });

  return selectedSku;
}

/**
 * Build the grouped, categorised service catalog choices for the select prompt.
 * Groups services by category with dim headers, and marks recently-used services.
 *
 * @param {object} mru - MRU data for highlighting recently used services
 * @returns {Array<object>} Choices array for inquirer select
 */
function buildServiceChoices(mru) {
  const lastServices = mru.lastServices || [];
  const choices = [];

  for (const cat of CATEGORY_ORDER) {
    const icon = CATEGORY_ICONS[cat];
    const label = CATEGORY_LABELS[cat];
    // Category header as a disabled separator
    choices.push({ name: chalk.dim(`  ${icon} ${label}`), value: -1, disabled: '' });

    const servicesInCat = SERVICE_CATALOG
      .map((s, i) => ({ ...s, originalIndex: i }))
      .filter((s) => s.category === cat);

    for (const svc of servicesInCat) {
      const recent = lastServices.includes(svc.name) ? chalk.yellow(' ★') : '';
      choices.push({ name: `    ${svc.name}${recent}`, value: svc.originalIndex });
    }
  }

  return choices;
}

/**
 * Look up a price for a single SKU and return the monthly cost.
 * Filters out Spot and Low Priority entries. Returns null if no price found.
 */
async function lookupSinglePrice({ serviceName, sku, os, tier, region, currency }) {
  const priceItems = await lookupPrice({
    serviceName,
    armRegionName: region,
    priceType: 'Consumption',
    currency,
  });

  const skuLower = (sku || '').toLowerCase().replace(/\s+/g, '');
  let matched = priceItems.filter((item) => {
    const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
    const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
    const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
    return skuName.includes(skuLower) || armSku.includes(skuLower) || meter.includes(skuLower);
  });

  // Filter by OS if applicable
  if (os) {
    const osFiltered = matched.filter((item) => {
      const prod = (item.productName || '').toLowerCase();
      if (os === 'linux') return prod.includes('linux');
      return !prod.includes('linux');
    });
    if (osFiltered.length > 0) matched = osFiltered;
  }

  // Filter by tier/product if provided (e.g. Redis Basic vs Standard)
  if (tier) {
    const tf = tier.toLowerCase();
    const tierFiltered = matched.filter((item) => {
      return (item.productName || '').toLowerCase().includes(tf);
    });
    if (tierFiltered.length > 0) matched = tierFiltered;
  }

  // Meter filter for Redis disambiguation
  if (sku && serviceName === 'Redis Cache') {
    const mf = `${sku} Cache`.toLowerCase().replace(/\s+/g, '');
    const mfFiltered = matched.filter((item) => {
      const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
      return meter === mf;
    });
    if (mfFiltered.length > 0) matched = mfFiltered;
  }

  // Filter out Spot and Low Priority SKUs
  matched = matched.filter((item) => {
    const meter = (item.meterName || '').toLowerCase();
    const skuN = (item.skuName || '').toLowerCase();
    return !meter.includes('spot') && !meter.includes('low priority') &&
           !skuN.includes('spot') && !skuN.includes('low priority');
  });

  if (matched.length === 0) return null;

  const priceItem = matched[0];
  const unit = (priceItem.unitOfMeasure || '').toLowerCase();

  if (unit.includes('hour')) return hourlyToMonthly(priceItem.retailPrice);
  if (unit.includes('month')) return priceItem.retailPrice;
  if (unit.includes('day')) return priceItem.retailPrice * 30;
  return priceItem.retailPrice;
}

/**
 * Pre-fetch prices for all choices in a static-choice prompt and return
 * enriched choice labels with prices appended. Falls back to plain labels
 * if the fetch fails or times out.
 */
async function enrichChoicesWithPrices({ serviceName, choices, os, tier, region, currency }) {
  const spinner = createSpinner(`Fetching prices for ${serviceName}...`);
  spinner.start();

  try {
    const priceItems = await lookupPrice({
      serviceName,
      armRegionName: region,
      priceType: 'Consumption',
      currency,
    });

    // Filter out Spot/Low Priority from the pool
    const pool = priceItems.filter((item) => {
      const meter = (item.meterName || '').toLowerCase();
      const skuN = (item.skuName || '').toLowerCase();
      return !meter.includes('spot') && !meter.includes('low priority') &&
             !skuN.includes('spot') && !skuN.includes('low priority');
    });

    const enriched = choices.map((choice) => {
      const skuLower = choice.toLowerCase().replace(/\s+/g, '');
      let matched = pool.filter((item) => {
        const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
        const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
        const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
        return skuName.includes(skuLower) || armSku.includes(skuLower) || meter.includes(skuLower);
      });

      // Apply OS filter
      if (os) {
        const osF = matched.filter((item) => {
          const prod = (item.productName || '').toLowerCase();
          if (os === 'linux') return prod.includes('linux');
          return !prod.includes('linux');
        });
        if (osF.length > 0) matched = osF;
      }

      // Apply tier filter
      if (tier) {
        const tf = tier.toLowerCase();
        const tF = matched.filter((item) => (item.productName || '').toLowerCase().includes(tf));
        if (tF.length > 0) matched = tF;
      }

      // Apply meter filter for Redis
      if (serviceName === 'Redis Cache') {
        const mf = `${choice} Cache`.toLowerCase().replace(/\s+/g, '');
        const mF = matched.filter((item) => {
          const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
          return meter === mf;
        });
        if (mF.length > 0) matched = mF;
      }

      if (matched.length > 0) {
        const priceItem = matched[0];
        const unit = (priceItem.unitOfMeasure || '').toLowerCase();
        let monthly;
        if (unit.includes('hour')) monthly = hourlyToMonthly(priceItem.retailPrice);
        else if (unit.includes('month')) monthly = priceItem.retailPrice;
        else if (unit.includes('day')) monthly = priceItem.retailPrice * 30;
        else monthly = priceItem.retailPrice;

        const priceLabel = chalk.dim(` ~${formatMoney(monthly, currency)}/mo`);
        return { name: `${choice.padEnd(12)}${priceLabel}`, value: choice, monthly };
      }

      return { name: choice, value: choice, monthly: null };
    });

    spinner.stop('Prices loaded');
    return enriched;
  } catch (_) {
    spinner.fail('Price preview unavailable');
    // Fall back to plain choices
    return choices.map((c) => ({ name: c, value: c, monthly: null }));
  }
}

/**
 * Check if a cheaper AMD variant exists for a given VM or PG SKU and offer it.
 * Looks for _Ds_ → _Das_ and _Es_ → _Eas_ patterns.
 */
async function offerCheaperAlternative({ sku, currentPrice, os, region, currency, serviceName, confirm }) {
  // Check if the SKU has an AMD equivalent: _Ds_ → _Das_, _Es_ → _Eas_
  let amdSku = null;
  if (sku.match(/_D\d+s_v/)) {
    amdSku = sku.replace(/_D(\d+)s_v/, '_D$1as_v');
  } else if (sku.match(/_D\d+ds_v/)) {
    amdSku = sku.replace(/_D(\d+)ds_v/, '_D$1as_v');
  } else if (sku.match(/_E\d+s_v/)) {
    amdSku = sku.replace(/_E(\d+)s_v/, '_E$1as_v');
  } else if (sku.match(/_E\d+ds_v/)) {
    amdSku = sku.replace(/_E(\d+)ds_v/, '_E$1as_v');
  }

  if (!amdSku || amdSku === sku) return null;

  // Look up the AMD variant's price
  try {
    const amdPrice = await lookupSinglePrice({ serviceName, sku: amdSku, os, region, currency });
    if (amdPrice && amdPrice < currentPrice) {
      const savings = ((currentPrice - amdPrice) / currentPrice * 100).toFixed(0);
      const shouldSwitch = await confirm({
        message: `${amdSku} (AMD) is ~${formatMoney(amdPrice, currency)}/mo — ${savings}% cheaper. Switch?`,
        default: false,
      });
      if (shouldSwitch) return { sku: amdSku, monthlyCost: amdPrice };
    }
  } catch (_) {
    // AMD variant price lookup failed — silently skip the suggestion
  }

  return null;
}

/**
 * Register the plan command on the parent commander program.
 * @param {import('commander').Command} program
 */
module.exports = function registerPlanCommand(program) {
  program
    .command('plan')
    .description('Build a cost estimate interactively')
    .option('-i, --interactive', 'Launch the interactive guided builder')
    .option('-l, --load <file>', 'Load a previously saved estimate to modify')
    .option('-r, --region <region>', 'Pre-set region (skip the region prompt)')
    .option('-c, --currency <code>', 'Currency code', config.getDefault('currency'))
    .option('-f, --format <type>', 'Output format: table or json', config.getDefault('format'))
    .option('-o, --out <file>', 'Export to file (.json or .xlsx)')
    .option('-q, --quick', 'Start from a pre-built template')
    .action(async (opts) => {
      // Lazy-load inquirer — heavy dependency, only needed for interactive mode
      const { select, input, confirm, number } = require('@inquirer/prompts');

      let items = [];
      let region = opts.region || config.getDefault('region');
      const currency = opts.currency;
      const mru = loadMru();

      // ── Load a saved estimate if --load was provided ────────────
      if (opts.load) {
        try {
          const raw = fs.readFileSync(opts.load, 'utf8');
          const saved = JSON.parse(raw);
          items = saved.items || [];
          region = saved.region || region;
          logger.success(`Loaded ${items.length} item(s) from ${opts.load}`);
          logger.dim(`Region: ${region}, Currency: ${currency}`);
        } catch (err) {
          logger.error(`Could not load estimate: ${err.message}`, 'AZC_LOAD_FAILED');
          process.exit(1);
        }
      }

      // ── Region selection (unless pre-set or loaded) ─────────────
      if (!opts.load && !opts.region) {
        const defaultRegion = mru.lastRegion || config.getDefault('region');
        const regionChoices = COMMON_REGIONS.map((r) => {
          const isDefault = r === defaultRegion;
          return { name: isDefault ? `${r} ${chalk.yellow('★')}` : r, value: r };
        });

        region = await select({
          message: 'Select Azure region:',
          choices: regionChoices,
          default: defaultRegion,
        });
      }

      logger.spacer();
      logger.header('Azure Cost Estimate Builder');
      logger.dim(`Region: ${region} | Currency: ${currency}`);
      logger.spacer();

      // Print existing items if we loaded from a file
      if (items.length > 0) {
        printRunningTotal(items, currency);
      }

      // ── Quick-start templates ──────────────────────────────────
      if (opts.quick) {
        const tmpl = loadTemplates();
        const templateChoices = tmpl.templates.map((t, i) => ({
          name: `${t.name.padEnd(24)} ${chalk.dim(t.description)}  ${chalk.green(`~${t.priceHint}`)}`,
          value: i,
        }));
        templateChoices.push({ name: chalk.dim('↳ Start from scratch'), value: -1 });

        const templateIdx = await select({
          message: 'Quick start template:',
          choices: templateChoices,
        });

        if (templateIdx >= 0) {
          const template = tmpl.templates[templateIdx];
          const spinner = createSpinner('Looking up template prices...');
          spinner.start();

          for (const res of template.resources) {
            try {
              const price = await lookupSinglePrice({
                serviceName: res.serviceName,
                sku: res.sku,
                os: res.os,
                tier: res.tier,
                region,
                currency,
              });

              const qty = res.instances || 1;
              const monthlyCost = price ? price * qty : 0;
              const noteParts = [];
              if (res.tier) noteParts.push(res.tier);
              if (res.os) noteParts.push(res.os);
              if (res.instances && res.instances > 1) noteParts.push(`${res.instances} instance(s)`);

              items.push({
                service: res.service,
                sku: res.sku,
                monthlyCost,
                notes: noteParts.join(', '),
              });
            } catch (_) {
              items.push({ service: res.service, sku: res.sku, monthlyCost: 0, notes: 'price lookup failed' });
            }
          }

          spinner.stop(`Loaded ${template.name} template`);
          printRunningTotal(items, currency);
        }
      }

      // ── Price cache for inline preview — avoids re-fetching for the same service
      const priceCache = {};

      // ── Main loop: add resources until user is done ─────────────
      let addMore = true;
      while (addMore) {
        // Pick a service type with grouped, categorised display
        const serviceChoices = buildServiceChoices(mru);
        const serviceIdx = await select({
          message: 'Add a resource:',
          choices: serviceChoices,
        });

        const service = SERVICE_CATALOG[serviceIdx];

        // Collect configuration for this resource
        const answers = {};

        // ── Two-step family picker for VMs and PostgreSQL ──────
        if (service.useFamilyPicker) {
          answers.sku = await familyPicker(service.useFamilyPicker, select, input, mru);
        }

        // ── Standard prompts (OS, instances, etc.) ─────────────
        // For services with static choices and inline prices, we pre-fetch
        // prices and enrich the choice labels before showing them.
        for (const prompt of service.prompts) {
          if (prompt.choices) {
            let choices;
            // Try to enrich with inline prices for the SKU prompt
            if (prompt.key === 'sku' && !service.useFamilyPicker) {
              const cacheKey = `${service.serviceName}|${region}|${answers.os || ''}|${answers.tier || ''}`;
              if (priceCache[cacheKey]) {
                choices = priceCache[cacheKey];
              } else {
                choices = await enrichChoicesWithPrices({
                  serviceName: service.serviceName,
                  choices: prompt.choices,
                  os: answers.os,
                  tier: answers.tier,
                  region,
                  currency,
                });
                priceCache[cacheKey] = choices;
              }
            } else {
              choices = prompt.choices.map((c) => ({ name: c, value: c }));
            }

            answers[prompt.key] = await select({
              message: prompt.message,
              choices,
              default: prompt.default,
            });
          } else if (prompt.type === 'number') {
            answers[prompt.key] = await number({
              message: prompt.message,
              default: prompt.default || 1,
              min: 1,
            });
          } else if (!service.useFamilyPicker || prompt.key !== 'sku') {
            answers[prompt.key] = await input({
              message: prompt.message,
              default: prompt.default || '',
            });
          }
        }

        // Look up the price for this configuration
        const spinner = createSpinner(`Fetching price for ${service.name} ${answers.sku}...`);
        spinner.start();

        try {
          const monthlyCost = await lookupSinglePrice({
            serviceName: service.serviceName,
            sku: answers.sku,
            os: answers.os,
            tier: answers.tier,
            region,
            currency,
          });

          if (monthlyCost === null) {
            spinner.fail(`No price found for ${service.name} ${answers.sku}`);
          } else {
            // Apply instance/quantity multiplier
            const qty = answers.instances || 1;
            const totalCost = monthlyCost * qty;

            const noteParts = [];
            if (answers.tier) noteParts.push(answers.tier);
            if (answers.os) noteParts.push(answers.os);
            if (answers.instances && answers.instances > 1) noteParts.push(`${answers.instances} instance(s)`);

            items.push({
              service: service.name,
              sku: answers.sku,
              monthlyCost: totalCost,
              notes: noteParts.join(', '),
            });

            spinner.stop(`${service.name} ${answers.sku}: ${formatMoney(totalCost, currency)}/month`);

            // ── Cheaper AMD alternative nudge for VMs and PostgreSQL ──
            if (service.useFamilyPicker && answers.sku.startsWith('Standard_')) {
              const cheaper = await offerCheaperAlternative({
                sku: answers.sku,
                currentPrice: totalCost,
                os: answers.os,
                region,
                currency,
                serviceName: service.serviceName,
                confirm,
              });
              if (cheaper) {
                // Replace the last item with the cheaper alternative
                items[items.length - 1].sku = cheaper.sku;
                items[items.length - 1].monthlyCost = cheaper.monthlyCost;
                logger.success(`Switched to ${cheaper.sku}: ${formatMoney(cheaper.monthlyCost, currency)}/month`);
              }
            }

            // ── "You might also need" companion prompt ────────────
            if (service.companion) {
              const addCompanion = await confirm({
                message: service.companion.message,
                default: false,
              });
              if (addCompanion) {
                const comp = service.companion;
                if (comp.defaults.usageBased) {
                  items.push({
                    service: comp.service,
                    sku: comp.defaults.sku,
                    monthlyCost: 0,
                    notes: 'usage-based',
                  });
                  logger.success(`Added ${comp.service} (usage-based)`);
                } else {
                  // Look up the companion's price
                  try {
                    const compPrice = await lookupSinglePrice({
                      serviceName: comp.service === 'Managed Disks' ? 'Managed Disks' : comp.service,
                      sku: comp.defaults.sku,
                      region,
                      currency,
                    });
                    items.push({
                      service: comp.service,
                      sku: comp.defaults.sku,
                      monthlyCost: compPrice || 0,
                      notes: comp.defaults.notes || '',
                    });
                    logger.success(`Added ${comp.service} ${comp.defaults.sku}: ${formatMoney(compPrice || 0, currency)}/month`);
                  } catch (_) {
                    items.push({
                      service: comp.service,
                      sku: comp.defaults.sku,
                      monthlyCost: 0,
                      notes: 'price not found',
                    });
                  }
                }
              }
            }
          }
        } catch (err) {
          spinner.fail(`Price lookup failed: ${err.message}`);
        }

        // Show running total
        if (items.length > 0) {
          printRunningTotal(items, currency);
        }

        // Ask to continue
        addMore = await confirm({ message: 'Add another resource?', default: true });
      }

      // ── Final output ────────────────────────────────────────────
      if (items.length === 0) {
        logger.warn('No resources added. Estimate is empty.');
        return;
      }

      logger.spacer();
      logger.header('Final Estimate');

      // Build the output as priced resources for the table renderer
      const pricedResources = items.map((item) => ({
        name: item.service,
        type: item.service,
        sku: item.sku,
        monthlyCost: item.monthlyCost,
        notes: item.notes,
      }));

      if (opts.format === 'json') {
        const result = buildPlanJson({ region, currency, items });
        logger.raw(JSON.stringify(result, null, 2) + '\n');
      } else {
        renderScanResult({
          subscription: 'Estimate',
          region,
          currency,
          resources: pricedResources,
          unsupported: [],
          unpriced: [],
        });
      }

      // ── Save estimate ───────────────────────────────────────────
      const dateStr = new Date().toISOString().split('T')[0];
      const estimateFile = path.join(ESTIMATES_DIR, `estimate-${dateStr}-${Date.now()}.json`);

      if (!fs.existsSync(ESTIMATES_DIR)) {
        fs.mkdirSync(ESTIMATES_DIR, { recursive: true });
      }

      const estimateData = buildPlanJson({ region, currency, items });
      fs.writeFileSync(estimateFile, JSON.stringify(estimateData, null, 2), 'utf8');
      logger.success(`Estimate saved to ${estimateFile}`);

      // ── Save MRU data ───────────────────────────────────────────
      mru.lastRegion = region;
      mru.lastServices = [...new Set(items.map((i) => i.service))];
      // Remember last VM and PG SKUs if used
      const lastVm = items.find((i) => i.service === 'Virtual Machine');
      if (lastVm) mru.lastVmSku = lastVm.sku;
      const lastPg = items.find((i) => i.service === 'PostgreSQL Flexible Server');
      if (lastPg) mru.lastPgSku = lastPg.sku;
      saveMru(mru);

      // ── Contextual tip for large estimates ──────────────────────
      if (items.length > 3) {
        logger.spacer();
        logger.dim(`Tip: azc plan --load ${estimateFile} to reload and modify this estimate`);
      }

      // ── File export if requested ────────────────────────────────
      if (opts.out) {
        const ext = path.extname(opts.out).toLowerCase();
        if (ext === '.json') {
          fs.writeFileSync(opts.out, JSON.stringify(estimateData, null, 2), 'utf8');
          logger.success(`Exported to ${opts.out}`);
        } else if (ext === '.xlsx') {
          await exportToXlsx({
            filePath: opts.out,
            subscription: 'Estimate',
            region,
            currency,
            resources: pricedResources,
            unsupported: [],
            unpriced: [],
          });
        } else {
          logger.warn(`Unsupported file extension: ${ext}. Use .json or .xlsx.`);
        }
      }
    });
};

/**
 * Print a compact running total: resource count + monthly + annual on one line.
 */
function printRunningTotal(items, currency) {
  const total = items.reduce((sum, i) => sum + i.monthlyCost, 0);
  const count = items.length;
  logger.spacer();
  logger.dim('─'.repeat(45));
  logger.info(`${count} resource${count !== 1 ? 's' : ''} | ${formatMoney(total, currency)}/mo | ${formatMoney(monthlyToAnnual(total), currency)}/yr`);
  logger.dim('─'.repeat(45));
  logger.spacer();
}
