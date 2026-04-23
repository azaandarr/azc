// plan.js — `azc plan` command.
// Interactive guided cost estimate builder using inquirer prompts.
// Walks the user through selecting a region, adding resources one by one,
// choosing SKUs, and viewing a running total. Saves estimates to
// ~/.azc/estimates/ for reloading and modification later.
//
// Supports CLI shorthand: azc plan "3x App Service P1v3 linux" "PostgreSQL D2ds_v5"
// to skip interactive prompts entirely.

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('../config/config');
const logger = require('../utils/logger');
const { renderScanResult } = require('../formatters/table');
const { buildPlanJson } = require('../formatters/json');
const { exportToXlsx } = require('../formatters/xlsx');
const { createSpinner } = require('../utils/spinner');
const { formatMoney, formatCompact, hourlyToMonthly, monthlyToAnnual } = require('../utils/currency');
const { ESTIMATES_DIR, AZC_HOME } = require('../config/config');
const {
  familyPicker,
  lookupSinglePrice,
  enrichChoicesWithPrices,
  parseInlineResource,
  NUMBERED_THEME,
} = require('../utils/sku-picker');

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
    companion: { message: 'Add Application Insights?', service: 'Application Insights', defaults: { sku: 'Enterprise', usageBased: true } },
  },
  {
    name: 'Virtual Machine',
    serviceName: 'Virtual Machines',
    category: 'compute',
    useFamilyPicker: 'vm',
    prompts: [
      { key: 'os', message: 'Operating system', choices: ['linux', 'windows'] },
    ],
    companion: { message: 'Add a Managed Disk?', service: 'Managed Disks', defaults: { sku: 'P10', notes: '128 GB Premium SSD' } },
  },
  {
    name: 'PostgreSQL Flexible Server',
    serviceName: 'Azure Database for PostgreSQL',
    category: 'database',
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
 */
function loadMru() {
  try {
    if (fs.existsSync(MRU_PATH)) {
      return JSON.parse(fs.readFileSync(MRU_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

/**
 * Save MRU data to disk.
 */
function saveMru(mru) {
  try {
    const dir = path.dirname(MRU_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MRU_PATH, JSON.stringify(mru, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Build the grouped, categorised service catalog choices for the select prompt.
 * Includes "Done" and "Edit" options at the top when items exist.
 *
 * @param {object} mru - MRU data for highlighting recently used services
 * @param {Array<object>} items - Current estimate items (for Done/Edit labels)
 * @param {string} currency - Currency code for the running total display
 * @returns {Array<object>} Choices array for inquirer select
 */
function buildServiceChoices(mru, items, currency) {
  const lastServices = mru.lastServices || [];
  const choices = [];

  // "Done" option — only show when there are items
  if (items.length > 0) {
    const total = items.reduce((sum, i) => sum + i.monthlyCost, 0);
    choices.push({
      name: chalk.green(`  ✓ Done — show estimate (${items.length} resource${items.length !== 1 ? 's' : ''}, ~${formatCompact(total, currency)})`),
      value: -2,
    });
  }

  // "Edit" option — only show when there are items
  if (items.length > 0) {
    choices.push({
      name: chalk.yellow(`  ✎ Edit estimate...`),
      value: -3,
    });
  }

  for (const cat of CATEGORY_ORDER) {
    const label = CATEGORY_LABELS[cat];
    choices.push({ name: chalk.dim(` ── ${label}`), value: -1, disabled: '' });

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
 * Show the edit sub-flow: list current items with remove/change-quantity actions.
 */
async function editEstimate(items, currency, select, number) {
  while (true) {
    const editChoices = items.map((item, idx) => {
      const qtyStr = item.quantity > 1 ? `${item.quantity}×  ` : '    ';
      return {
        name: `${qtyStr}${item.service.padEnd(24)} ${chalk.blue(String(item.sku).padEnd(14))} ${chalk.green(formatMoney(item.monthlyCost, currency) + '/mo')}`,
        value: idx,
      };
    });

    const total = items.reduce((sum, i) => sum + i.monthlyCost, 0);
    editChoices.push({ name: chalk.dim(`    ${'─'.repeat(50)}`), value: -1, disabled: '' });
    editChoices.push({ name: chalk.bold(`    Total: ${formatMoney(total, currency)}/mo`), value: -1, disabled: '' });
    editChoices.push({ name: chalk.dim('    ↩ Back to adding resources'), value: -4 });

    const picked = await select({
      message: 'Your estimate:',
      choices: editChoices,
      theme: NUMBERED_THEME,
    });

    if (picked === -4) return;

    const item = items[picked];

    const actionChoices = [
      { name: 'Change quantity', value: 'qty' },
      { name: chalk.red('Remove'), value: 'remove' },
      { name: chalk.dim('Back'), value: 'back' },
    ];

    const action = await select({
      message: `${item.service} ${item.sku} (${item.quantity}×, ${formatMoney(item.monthlyCost, currency)}/mo):`,
      choices: actionChoices,
      theme: NUMBERED_THEME,
    });

    if (action === 'qty') {
      const newQty = await number({
        message: 'New quantity:',
        default: item.quantity,
        min: 1,
        max: 100,
      });
      item.quantity = newQty;
      item.monthlyCost = item.unitCost * newQty;
      logger.success(`Updated: ${newQty}× ${item.service} ${item.sku} — ${formatMoney(item.monthlyCost, currency)}/mo`);
    } else if (action === 'remove') {
      const removed = items.splice(picked, 1)[0];
      logger.success(`Removed: ${removed.service} ${removed.sku}`);
    }
  }
}

/**
 * Check if a cheaper AMD variant exists for a given VM or PG SKU and offer it.
 */
async function offerCheaperAlternative({ sku, currentPrice, os, region, currency, serviceName, confirm }) {
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
  } catch (_) {}

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
    .argument('[resources...]', 'Inline resources, e.g. "3x App Service P1v3 linux"')
    .option('-i, --interactive', 'Launch the interactive guided builder')
    .option('-l, --load <file>', 'Load a previously saved estimate to modify')
    .option('--last', 'Reload the most recent saved estimate')
    .option('-r, --region <region>', 'Pre-set region (skip the region prompt)')
    .option('-c, --currency <code>', 'Currency code', config.getDefault('currency'))
    .option('-f, --format <type>', 'Output format: table or json', config.getDefault('format'))
    .option('-o, --out <file>', 'Export to file (.json or .xlsx)')
    .option('-q, --quick', 'Start from a pre-built template')
    .action(async (inlineResources, opts) => {
      // Lazy-load inquirer — heavy dependency, only needed for interactive mode
      const { select, input, confirm, number } = require('@inquirer/prompts');

      let items = [];
      let region = opts.region || config.getDefault('region');
      const currency = opts.currency;
      const mru = loadMru();

      // ── --last flag: find most recent estimate file ────────────
      if (opts.last) {
        if (fs.existsSync(ESTIMATES_DIR)) {
          const files = fs.readdirSync(ESTIMATES_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => ({ name: f, mtime: fs.statSync(path.join(ESTIMATES_DIR, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

          if (files.length > 0) {
            opts.load = path.join(ESTIMATES_DIR, files[0].name);
            logger.dim(`Loading most recent: ${files[0].name}`);
          } else {
            logger.warn('No saved estimates found in ' + ESTIMATES_DIR);
            return;
          }
        } else {
          logger.warn('No estimates directory found. Run azc plan first to create one.');
          return;
        }
      }

      // ── Load a saved estimate if --load was provided ────────────
      if (opts.load) {
        try {
          const raw = fs.readFileSync(opts.load, 'utf8');
          const saved = JSON.parse(raw);
          items = (saved.items || []).map((i) => ({
            ...i,
            quantity: i.quantity || 1,
            unitCost: i.unitCost || i.monthlyCost,
          }));
          region = saved.region || region;
          logger.success(`Loaded ${items.length} item(s) from ${opts.load}`);
          logger.dim(`Region: ${region}, Currency: ${currency}`);

          // If --format json and no interactive, just output and exit
          if (opts.format === 'json' && !opts.interactive && inlineResources.length === 0) {
            const result = buildPlanJson({ region, currency, items });
            logger.raw(JSON.stringify(result, null, 2) + '\n');
            return;
          }
        } catch (err) {
          logger.error(`Could not load estimate: ${err.message}`, 'AZC_LOAD_FAILED');
          process.exit(1);
        }
      }

      // ── Inline resource arguments (CLI shorthand) ───────────────
      if (inlineResources.length > 0) {
        const spinner = createSpinner('Looking up prices...');
        spinner.start();

        for (const resStr of inlineResources) {
          const parsed = parseInlineResource(resStr);
          if (!parsed) {
            spinner.fail(`Could not parse: "${resStr}"`);
            logger.error(
              `Invalid resource format. Expected: [Nx] <Service> <SKU> [os] [tier]\n` +
              '  Examples: "3x App Service P1v3 linux", "PostgreSQL D2ds_v5", "Redis C1 standard"',
              'AZC_PARSE_FAILED'
            );
            process.exit(1);
          }

          try {
            const price = await lookupSinglePrice({
              serviceName: parsed.serviceName,
              sku: parsed.sku,
              os: parsed.os,
              tier: parsed.tier,
              region,
              currency,
            });

            const unitCost = price || 0;
            const totalCost = unitCost * parsed.quantity;
            const noteParts = [];
            if (parsed.os) noteParts.push(parsed.os);
            if (parsed.tier) noteParts.push(parsed.tier);

            items.push({
              service: parsed.serviceName,
              sku: parsed.sku,
              quantity: parsed.quantity,
              unitCost,
              monthlyCost: totalCost,
              notes: noteParts.join(', '),
            });
          } catch (_) {
            items.push({
              service: parsed.serviceName,
              sku: parsed.sku,
              quantity: parsed.quantity,
              unitCost: 0,
              monthlyCost: 0,
              notes: 'price lookup failed',
            });
          }
        }

        spinner.stop(`Priced ${items.length} resource(s)`);

        // Show result
        outputEstimate(items, region, currency, opts);

        // Offer to continue interactively
        const goInteractive = await confirm({
          message: 'Add more resources interactively?',
          default: false,
        });
        if (!goInteractive) {
          await saveAndExport(items, region, currency, opts, mru);
          return;
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
          theme: NUMBERED_THEME,
        });
      }

      logger.spacer();
      logger.header('Azure Cost Estimate Builder');
      logger.dim(`Region: ${region} | Currency: ${currency}`);
      logger.spacer();

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
          theme: NUMBERED_THEME,
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
              const unitCost = price || 0;
              const monthlyCost = unitCost * qty;
              const noteParts = [];
              if (res.tier) noteParts.push(res.tier);
              if (res.os) noteParts.push(res.os);
              if (res.instances && res.instances > 1) noteParts.push(`${res.instances} instance(s)`);

              items.push({
                service: res.service,
                sku: res.sku,
                quantity: qty,
                unitCost,
                monthlyCost,
                notes: noteParts.join(', '),
              });
            } catch (_) {
              items.push({
                service: res.service,
                sku: res.sku,
                quantity: 1,
                unitCost: 0,
                monthlyCost: 0,
                notes: 'price lookup failed',
              });
            }
          }

          spinner.stop(`Loaded ${template.name} template`);
        }
      }

      // ── Price cache for inline preview
      const priceCache = {};

      // ── Main loop: continuous flow with Done/Edit at top ────────
      while (true) {
        const serviceChoices = buildServiceChoices(mru, items, currency);
        const serviceIdx = await select({
          message: 'Add a resource:',
          choices: serviceChoices,
          theme: NUMBERED_THEME,
        });

        // "Done" selected
        if (serviceIdx === -2) break;

        // "Edit" selected
        if (serviceIdx === -3) {
          await editEstimate(items, currency, select, number);
          continue;
        }

        const service = SERVICE_CATALOG[serviceIdx];
        const answers = {};

        // ── Two-step family picker for VMs and PostgreSQL ──────
        if (service.useFamilyPicker) {
          answers.sku = await familyPicker(service.useFamilyPicker, select, input, mru, {
            region,
            currency,
            serviceName: service.serviceName,
            os: undefined, // OS not known yet for VMs
          });
        }

        // ── Standard prompts (OS, instances, etc.) ─────────────
        for (const prompt of service.prompts) {
          if (prompt.choices) {
            let choices;
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
              theme: NUMBERED_THEME,
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

        // Look up the price
        const spinner = createSpinner(`Fetching price for ${service.name} ${answers.sku}...`);
        spinner.start();

        try {
          const unitCost = await lookupSinglePrice({
            serviceName: service.serviceName,
            sku: answers.sku,
            os: answers.os,
            tier: answers.tier,
            region,
            currency,
          });

          if (unitCost === null) {
            spinner.fail(`No price found for ${service.name} ${answers.sku}`);
          } else {
            // Apply instance multiplier (scaling within a single resource)
            const instances = answers.instances || 1;
            const perUnit = unitCost * instances;

            spinner.stop(`${service.name} ${answers.sku} — ${formatMoney(perUnit, currency)}/mo each`);

            // Quantity prompt: how many of this resource?
            const qty = await number({
              message: 'How many of this resource?',
              default: 1,
              min: 1,
              max: 100,
            });

            const totalCost = perUnit * qty;
            const noteParts = [];
            if (answers.tier) noteParts.push(answers.tier);
            if (answers.os) noteParts.push(answers.os);
            if (answers.instances && answers.instances > 1) noteParts.push(`${answers.instances} instance(s)`);

            items.push({
              service: service.name,
              sku: answers.sku,
              quantity: qty,
              unitCost: perUnit,
              monthlyCost: totalCost,
              notes: noteParts.join(', '),
            });

            if (qty > 1) {
              logger.success(`Added ${qty}× ${service.name} ${answers.sku} — ${formatMoney(totalCost, currency)}/mo (${formatMoney(perUnit, currency)} each)`);
            } else {
              logger.success(`Added: ${service.name} ${answers.sku} — ${formatMoney(totalCost, currency)}/mo`);
            }

            // ── Cheaper AMD alternative nudge for VMs and PostgreSQL ──
            if (service.useFamilyPicker && answers.sku.startsWith('Standard_')) {
              const cheaper = await offerCheaperAlternative({
                sku: answers.sku,
                currentPrice: perUnit,
                os: answers.os,
                region,
                currency,
                serviceName: service.serviceName,
                confirm,
              });
              if (cheaper) {
                const last = items[items.length - 1];
                last.sku = cheaper.sku;
                last.unitCost = cheaper.monthlyCost;
                last.monthlyCost = cheaper.monthlyCost * qty;
                logger.success(`Switched to ${cheaper.sku} — ${formatMoney(last.monthlyCost, currency)}/mo`);
              }
            }

            // ── Companion prompt ────────────
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
                    quantity: 1,
                    unitCost: 0,
                    monthlyCost: 0,
                    notes: 'usage-based',
                  });
                  logger.success(`Added ${comp.service} (usage-based)`);
                } else {
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
                      quantity: 1,
                      unitCost: compPrice || 0,
                      monthlyCost: compPrice || 0,
                      notes: comp.defaults.notes || '',
                    });
                    logger.success(`Added ${comp.service} ${comp.defaults.sku} — ${formatMoney(compPrice || 0, currency)}/mo`);
                  } catch (_) {
                    items.push({
                      service: comp.service,
                      sku: comp.defaults.sku,
                      quantity: 1,
                      unitCost: 0,
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
      }

      // ── Final output ────────────────────────────────────────────
      if (items.length === 0) {
        logger.warn('No resources added. Estimate is empty.');
        return;
      }

      outputEstimate(items, region, currency, opts);
      await saveAndExport(items, region, currency, opts, mru);
    });
};

/**
 * Display the final estimate table or JSON output.
 */
function outputEstimate(items, region, currency, opts) {
  logger.spacer();
  logger.header('Final Estimate');

  const pricedResources = items.map((item) => ({
    name: item.quantity > 1 ? `${item.quantity}× ${item.service}` : item.service,
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
}

/**
 * Save the estimate to disk, update MRU, and export if requested.
 */
async function saveAndExport(items, region, currency, opts, mru) {
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
  const lastVm = items.find((i) => i.service === 'Virtual Machine');
  if (lastVm) mru.lastVmSku = lastVm.sku;
  const lastPg = items.find((i) => i.service === 'PostgreSQL Flexible Server');
  if (lastPg) mru.lastPgSku = lastPg.sku;
  saveMru(mru);

  // ── Contextual tip ──────────────────────────────────────────
  if (items.length > 1) {
    logger.spacer();
    logger.dim(`Tip: azc plan --load ${estimateFile} to reload and modify`);
  }

  // ── File export if requested ────────────────────────────────
  if (opts.out) {
    const pricedResources = items.map((item) => ({
      name: item.quantity > 1 ? `${item.quantity}× ${item.service}` : item.service,
      type: item.service,
      sku: item.sku,
      monthlyCost: item.monthlyCost,
      notes: item.notes,
    }));

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
}
