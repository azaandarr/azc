// plan.js — `azc plan` command.
// Interactive guided cost estimate builder using inquirer prompts.
// Walks the user through selecting a region, adding resources one by one,
// choosing SKUs, and viewing a running total. Saves estimates to
// ~/.azc/estimates/ for reloading and modification later.

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');
const { lookupPrice } = require('../services/retail-prices');
const { renderScanResult } = require('../formatters/table');
const { buildPlanJson } = require('../formatters/json');
const { exportToXlsx } = require('../formatters/xlsx');
const { createSpinner } = require('../utils/spinner');
const { formatMoney, hourlyToMonthly, monthlyToAnnual } = require('../utils/currency');
const { ESTIMATES_DIR } = require('../config/config');

// Supported service types for the interactive builder.
// Each entry defines the prompts needed to configure that resource.
const SERVICE_CATALOG = [
  {
    name: 'App Service Plan',
    serviceName: 'Azure App Service',
    prompts: [
      { key: 'sku', message: 'SKU tier', choices: ['F1', 'B1', 'B2', 'B3', 'S1', 'S2', 'S3', 'P1v3', 'P2v3', 'P3v3'] },
      { key: 'os', message: 'Operating system', choices: ['linux', 'windows'] },
      { key: 'instances', message: 'Number of instances', type: 'number', default: 1 },
    ],
  },
  {
    name: 'Virtual Machine',
    serviceName: 'Virtual Machines',
    prompts: [
      { key: 'sku', message: 'VM size', placeholder: 'e.g. Standard_D4s_v5' },
      { key: 'os', message: 'Operating system', choices: ['linux', 'windows'] },
    ],
  },
  {
    name: 'PostgreSQL Flexible Server',
    serviceName: 'Azure Database for PostgreSQL',
    prompts: [
      { key: 'sku', message: 'Compute SKU', placeholder: 'e.g. Standard_D2ds_v5' },
    ],
  },
  {
    name: 'Azure SQL Database',
    serviceName: 'SQL Database',
    prompts: [
      { key: 'sku', message: 'SKU name', choices: ['S0', 'S1', 'S2', 'S3', 'GP_Gen5_2', 'GP_Gen5_4', 'GP_Gen5_8', 'BC_Gen5_2', 'BC_Gen5_4'] },
    ],
  },
  {
    name: 'Redis Cache',
    serviceName: 'Redis Cache',
    prompts: [
      { key: 'tier', message: 'Pricing tier', choices: ['Basic', 'Standard', 'Premium'] },
      { key: 'sku', message: 'Cache size', choices: ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', 'P5'] },
    ],
  },
  {
    name: 'Application Gateway',
    serviceName: 'Application Gateway',
    prompts: [
      { key: 'sku', message: 'SKU', choices: ['Basic', 'Small', 'Medium', 'Large', 'Standard'] },
      { key: 'instances', message: 'Capacity units', type: 'number', default: 1 },
    ],
  },
  {
    name: 'Service Bus',
    serviceName: 'Service Bus',
    prompts: [
      { key: 'sku', message: 'Tier', choices: ['Basic', 'Standard', 'Premium'] },
      { key: 'instances', message: 'Messaging units (Premium only)', type: 'number', default: 1 },
    ],
  },
  {
    name: 'Container Registry',
    serviceName: 'Container Registry',
    prompts: [
      { key: 'sku', message: 'Tier', choices: ['Basic', 'Standard', 'Premium'] },
    ],
  },
];

// Common Azure regions for the region picker
const COMMON_REGIONS = [
  'uksouth', 'ukwest',
  'westeurope', 'northeurope',
  'eastus', 'eastus2', 'westus2', 'centralus',
  'southeastasia', 'eastasia',
  'australiaeast',
];

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
    .action(async (opts) => {
      // Lazy-load inquirer — heavy dependency, only needed for interactive mode
      const { select, input, confirm, number } = require('@inquirer/prompts');

      let items = [];
      let region = opts.region || config.getDefault('region');
      const currency = opts.currency;

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
        region = await select({
          message: 'Select Azure region:',
          choices: COMMON_REGIONS.map((r) => ({ name: r, value: r })),
          default: config.getDefault('region'),
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

      // ── Main loop: add resources until user is done ─────────────
      let addMore = true;
      while (addMore) {
        // Pick a service type
        const serviceIdx = await select({
          message: 'Add a resource:',
          choices: SERVICE_CATALOG.map((s, i) => ({ name: s.name, value: i })),
        });

        const service = SERVICE_CATALOG[serviceIdx];

        // Collect configuration for this resource via prompts
        const answers = {};
        for (const prompt of service.prompts) {
          if (prompt.choices) {
            answers[prompt.key] = await select({
              message: prompt.message,
              choices: prompt.choices.map((c) => ({ name: c, value: c })),
              default: prompt.default,
            });
          } else if (prompt.type === 'number') {
            answers[prompt.key] = await number({
              message: prompt.message,
              default: prompt.default || 1,
              min: 1,
            });
          } else {
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
          const priceItems = await lookupPrice({
            serviceName: service.serviceName,
            armRegionName: region,
            priceType: 'Consumption',
            currency,
          });

          // Fuzzy-match the selected SKU
          const skuLower = (answers.sku || '').toLowerCase().replace(/\s+/g, '');
          let matched = priceItems.filter((item) => {
            const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
            const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
            const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
            return skuName.includes(skuLower) || armSku.includes(skuLower) || meter.includes(skuLower);
          });

          // Apply OS filter if applicable
          if (answers.os) {
            const osFiltered = matched.filter((item) => {
              const prod = (item.productName || '').toLowerCase();
              if (answers.os === 'linux') return prod.includes('linux');
              return !prod.includes('linux');
            });
            if (osFiltered.length > 0) matched = osFiltered;
          }

          // Apply tier/product filter (e.g. Redis Basic vs Standard vs Premium)
          if (answers.tier) {
            const tf = answers.tier.toLowerCase();
            const tierFiltered = matched.filter((item) => {
              return (item.productName || '').toLowerCase().includes(tf);
            });
            if (tierFiltered.length > 0) matched = tierFiltered;
          }

          // Apply meter filter for SKUs that share names across tiers
          // (e.g. Redis C1 exists in Basic, Standard, and Premium)
          if (answers.sku && service.serviceName === 'Redis Cache') {
            const mf = `${answers.sku} Cache`.toLowerCase().replace(/\s+/g, '');
            const mfFiltered = matched.filter((item) => {
              const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');
              return meter === mf;
            });
            if (mfFiltered.length > 0) matched = mfFiltered;
          }

          // Filter out Spot and Low Priority SKUs — we want regular consumption pricing
          matched = matched.filter((item) => {
            const meter = (item.meterName || '').toLowerCase();
            const sku = (item.skuName || '').toLowerCase();
            return !meter.includes('spot') && !meter.includes('low priority') &&
                   !sku.includes('spot') && !sku.includes('low priority');
          });

          if (matched.length === 0) {
            spinner.fail(`No price found for ${service.name} ${answers.sku}`);
          } else {
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

            // Apply instance/quantity multiplier
            const qty = answers.instances || 1;
            monthlyCost *= qty;

            const noteParts = [];
            if (answers.tier) noteParts.push(answers.tier);
            if (answers.os) noteParts.push(answers.os);
            if (answers.instances && answers.instances > 1) noteParts.push(`${answers.instances} instance(s)`);

            items.push({
              service: service.name,
              sku: answers.sku,
              monthlyCost,
              notes: noteParts.join(', '),
            });

            spinner.stop(`${service.name} ${answers.sku}: ${formatMoney(monthlyCost, currency)}/month`);
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
 * Print a running total of all items added so far.
 */
function printRunningTotal(items, currency) {
  const total = items.reduce((sum, i) => sum + i.monthlyCost, 0);
  logger.spacer();
  logger.dim('─'.repeat(40));
  logger.info(`Running total: ${formatMoney(total, currency)}/month (${formatMoney(monthlyToAnnual(total), currency)}/year)`);
  logger.dim('─'.repeat(40));
  logger.spacer();
}
