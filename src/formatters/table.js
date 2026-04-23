// table.js — Renders cost data as a coloured CLI table using cli-table3.
// Colour scheme from the spec:
//   Resource types → coral/orange (hex #FF7043)
//   SKUs           → blue
//   Prices         → green
//   Totals         → white bold
//   Separators     → dim grey

const Table = require('cli-table3');
const chalk = require('chalk');
const { formatMoney, monthlyToAnnual } = require('../utils/currency');
const logger = require('../utils/logger');

// Custom coral colour for resource types — close to Material Design deep orange 400.
// chalk.hex works in most modern terminals; falls back gracefully on older ones.
const coral = chalk.hex('#FF7043');

/**
 * Render a price lookup result (from `azc price`) as a formatted table.
 * Shows consumption, 1-year reserved, and 3-year reserved prices with
 * savings percentages calculated against the consumption (pay-as-you-go) rate.
 *
 * @param {object} params
 * @param {string} params.query        - The original user query (e.g. "App Service P1v3")
 * @param {string} params.region       - Azure region
 * @param {string} params.currency     - Currency code
 * @param {Array<object>} params.items - Price items from the Retail Prices API
 */
function renderPriceLookup({ query, region, currency, items }) {
  logger.spacer();
  logger.header(`Pricing: ${coral(query)}`);
  logger.dim(`Region: ${region} | Currency: ${currency}`);
  logger.spacer();

  if (items.length === 0) {
    logger.warn('No pricing data found for this query. Check the service name and SKU.');
    return;
  }

  // Group items by pricing type — we want to show consumption alongside reservations
  const consumption = items.filter((i) => i.type === 'Consumption');
  const reserved1yr = items.filter((i) => i.type === 'Reservation' && i.reservationTerm === '1 Year');
  const reserved3yr = items.filter((i) => i.type === 'Reservation' && i.reservationTerm === '3 Years');

  // Build the table — one row per distinct meter/SKU combination
  const table = new Table({
    head: [
      chalk.dim('SKU'),
      chalk.dim('Meter'),
      chalk.dim('Unit'),
      chalk.dim('Pay-as-you-go'),
      chalk.dim('Monthly est.'),
      chalk.dim('1yr Reserved'),
      chalk.dim('3yr Reserved'),
    ],
    style: { head: [], border: ['dim'] },
    colAligns: ['left', 'left', 'left', 'right', 'right', 'right', 'right'],
  });

  // For each consumption item, try to find matching reservation prices
  // by matching on the meterName or skuName
  for (const item of consumption) {
    const unitRate = item.retailPrice;
    const unit = item.unitOfMeasure || '';

    // Calculate monthly estimate — depends on the unit of measure
    const monthlyEst = estimateMonthly(unitRate, unit);

    // Find matching reserved prices by looking for the same product/meter
    const match1yr = reserved1yr.find((r) => matchesReservation(item, r));
    const match3yr = reserved3yr.find((r) => matchesReservation(item, r));

    // Format reservation prices with savings percentage.
    // Reservation prices are total-term costs (e.g. £1,641 for 1 year),
    // so we convert to monthly before comparing against the PAYG monthly rate.
    const monthlyPayg = monthlyEst;
    const res1yr = match1yr
      ? formatReservedMonthly(match1yr.retailPrice / 12, monthlyPayg, currency)
      : chalk.dim('—');
    const res3yr = match3yr
      ? formatReservedMonthly(match3yr.retailPrice / 36, monthlyPayg, currency)
      : chalk.dim('—');

    table.push([
      chalk.blue(item.skuName || item.armSkuName || ''),
      chalk.white(item.meterName || ''),
      chalk.dim(unit),
      chalk.green(formatMoney(unitRate, currency)),
      chalk.green(monthlyEst !== null ? formatMoney(monthlyEst, currency) : '—'),
      res1yr,
      res3yr,
    ]);
  }

  // If there were no consumption items but there were reservation items,
  // show those instead (some services only have reservation pricing)
  if (consumption.length === 0 && (reserved1yr.length > 0 || reserved3yr.length > 0)) {
    const allReserved = [...reserved1yr, ...reserved3yr];
    for (const item of allReserved) {
      table.push([
        chalk.blue(item.skuName || item.armSkuName || ''),
        chalk.white(item.meterName || ''),
        chalk.dim(item.unitOfMeasure || ''),
        chalk.dim('—'),
        chalk.dim('—'),
        item.reservationTerm === '1 Year' ? chalk.green(formatMoney(item.retailPrice, currency)) : chalk.dim('—'),
        item.reservationTerm === '3 Years' ? chalk.green(formatMoney(item.retailPrice, currency)) : chalk.dim('—'),
      ]);
    }
  }

  logger.raw(table.toString() + '\n');
  logger.spacer();
  logger.dim(`${items.length} price entries found`);
}

/**
 * Render a scan result (from `azc scan`) as a formatted cost breakdown table.
 *
 * @param {object} params
 * @param {string} params.subscription - Subscription name or ID
 * @param {string} params.region       - Azure region
 * @param {string} params.currency     - Currency code
 * @param {Array<object>} params.resources      - Priced resources
 * @param {Array<object>} params.unsupported    - Resources with no SKU mapper
 * @param {Array<object>} params.unpriced       - Resources where price lookup failed
 */
function renderScanResult({ subscription, region, currency, resources, unsupported, unpriced }) {
  // Split resources into priced (fixed-cost) and usage-based
  const fixedCost = resources.filter((r) => !r.usageBased);
  const usageBased = resources.filter((r) => r.usageBased);

  const totalMonthly = fixedCost.reduce((sum, r) => sum + r.monthlyCost, 0);
  const totalResources = resources.length + (unsupported || []).length + (unpriced || []).length;

  logger.spacer();
  logger.header(`Cost estimate: ${chalk.bold(subscription)}`);
  logger.dim(`Region: ${region} | Currency: ${currency} | ${new Date().toISOString().split('T')[0]}`);

  // Summary line — quick glance at the scan result
  if (totalResources > 0) {
    const parts = [];
    parts.push(`${totalResources} resources scanned`);
    if (fixedCost.length > 0) parts.push(`${fixedCost.length} priced`);
    if (usageBased.length > 0) parts.push(`${usageBased.length} usage-based`);
    if (unsupported && unsupported.length > 0) parts.push(`${unsupported.length} unsupported`);
    if (unpriced && unpriced.length > 0) parts.push(`${unpriced.length} unpriced`);
    logger.dim(parts.join(', '));
  }

  logger.spacer();

  if (resources.length === 0 && (unsupported || []).length === 0) {
    logger.warn('No resources found in this subscription.');
    return;
  }

  // ── Fixed-cost resources table ──────────────────────────────────
  if (fixedCost.length > 0) {
    const table = new Table({
      head: [
        chalk.dim('Resource'),
        chalk.dim('Type'),
        chalk.dim('SKU'),
        chalk.dim('Monthly'),
        chalk.dim('Annual'),
      ],
      style: { head: [], border: ['dim'] },
      colAligns: ['left', 'left', 'left', 'right', 'right'],
    });

    for (const r of fixedCost) {
      table.push([
        chalk.white(r.name),
        coral(r.type),
        chalk.blue(r.sku || '—'),
        chalk.green(formatMoney(r.monthlyCost, currency)),
        chalk.green(formatMoney(monthlyToAnnual(r.monthlyCost), currency)),
      ]);
    }

    // Total row
    table.push([
      { content: chalk.bold.white('TOTAL'), colSpan: 3 },
      chalk.bold.white(formatMoney(totalMonthly, currency)),
      chalk.bold.white(formatMoney(monthlyToAnnual(totalMonthly), currency)),
    ]);

    logger.raw(table.toString() + '\n');
  }

  // ── Usage-based resources (separate section) ────────────────────
  if (usageBased.length > 0) {
    logger.spacer();
    logger.dim(`${usageBased.length} usage-based resource(s) (cost depends on consumption):`);
    for (const r of usageBased) {
      const skuInfo = r.sku && r.sku !== '—' ? chalk.blue(r.sku) : '';
      logger.dim(`  • ${chalk.white(r.name)} ${coral(r.type)} ${skuInfo}`);
    }
  }

  // ── Unpriced resources ──────────────────────────────────────────
  if (unpriced && unpriced.length > 0) {
    logger.spacer();
    logger.warn(`${unpriced.length} resource(s) could not be priced:`);
    for (const r of unpriced) {
      logger.dim(`  • ${r.name} (${r.type}) — ${r.reason || 'price not found'}`);
    }
  }

  // ── Unsupported resource types ──────────────────────────────────
  if (unsupported && unsupported.length > 0) {
    logger.spacer();
    logger.dim(`${unsupported.length} resource(s) not yet supported:`);
    for (const r of unsupported) {
      logger.dim(`  • ${r.name} (${r.type})`);
    }
  }

  logger.spacer();
}

/**
 * Render a comparison result (from `azc compare`) as a side-by-side diff.
 *
 * @param {object} params
 * @param {string} params.resourceName  - Name of the resource being changed
 * @param {string} params.resourceType  - Type of the resource
 * @param {object} params.current       - Current config { sku, monthlyCost }
 * @param {object} params.proposed      - Proposed config { sku, monthlyCost }
 * @param {string} params.currency      - Currency code
 */
function renderComparison({ resourceName, resourceType, current, proposed, currency }) {
  const { formatDelta } = require('../utils/currency');

  logger.spacer();
  logger.header(`Comparison: ${chalk.bold(resourceName)}`);
  logger.dim(resourceType);
  logger.spacer();

  const delta = proposed.monthlyCost - current.monthlyCost;
  const deltaColor = delta > 0 ? chalk.red : delta < 0 ? chalk.green : chalk.white;

  const table = new Table({
    head: [chalk.dim(''), chalk.dim('Current'), chalk.dim('Proposed'), chalk.dim('Delta')],
    style: { head: [], border: ['dim'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });

  table.push(
    ['SKU', chalk.blue(current.sku), chalk.blue(proposed.sku), ''],
    [
      'Monthly',
      chalk.green(formatMoney(current.monthlyCost, currency)),
      chalk.green(formatMoney(proposed.monthlyCost, currency)),
      deltaColor(`${delta >= 0 ? '+' : ''}${formatMoney(delta, currency)} (${formatDelta(current.monthlyCost, proposed.monthlyCost)})`),
    ],
    [
      'Annual',
      chalk.green(formatMoney(monthlyToAnnual(current.monthlyCost), currency)),
      chalk.green(formatMoney(monthlyToAnnual(proposed.monthlyCost), currency)),
      deltaColor(`${delta >= 0 ? '+' : ''}${formatMoney(monthlyToAnnual(delta), currency)}`),
    ]
  );

  logger.raw(table.toString() + '\n');
  logger.spacer();
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Estimate monthly cost from a unit rate and unit of measure.
 * Azure pricing uses different units for different resources:
 *   "1 Hour"          → multiply by 730 (hours/month)
 *   "1 GB/Month"      → the rate IS the monthly cost
 *   "1/Month"         → the rate IS the monthly cost
 *   "10K Transactions" → can't estimate without usage data, return null
 *
 * @param {number} unitRate - Price per unit
 * @param {string} unit     - Unit of measure from the API
 * @returns {number|null} Estimated monthly cost, or null if we can't estimate
 */
function estimateMonthly(unitRate, unit) {
  const lower = (unit || '').toLowerCase();

  if (lower.includes('hour')) return unitRate * 730;
  if (lower.includes('/month') || lower.includes('month')) return unitRate;
  if (lower.includes('/day') || lower.includes('day')) return unitRate * 30;

  // Usage-based units (transactions, requests, GB transferred) — we can't
  // estimate without actual usage data, so return null.
  return null;
}

/**
 * Check if a reservation price item matches a consumption price item.
 * We match on productName since that's consistent across pricing types
 * for the same resource.
 *
 * @param {object} consumption - Consumption price item
 * @param {object} reservation - Reservation price item
 * @returns {boolean}
 */
function matchesReservation(consumption, reservation) {
  if (consumption.productName && reservation.productName) {
    return consumption.productName === reservation.productName;
  }
  // Fallback: match on armSkuName
  return consumption.armSkuName === reservation.armSkuName;
}

/**
 * Format a reserved monthly price with savings percentage relative to PAYG monthly.
 * Both values must already be normalised to monthly before calling this.
 * @param {number} reservedMonthly - Reserved price per month
 * @param {number|null} paygMonthly - PAYG monthly price for comparison
 * @param {string} currency         - Currency code
 * @returns {string} Formatted string like "£92.34 (-25.3%)"
 */
function formatReservedMonthly(reservedMonthly, paygMonthly, currency) {
  const formatted = formatMoney(reservedMonthly, currency);
  if (paygMonthly && paygMonthly > 0) {
    const savings = ((reservedMonthly - paygMonthly) / paygMonthly) * 100;
    const savingsStr = savings < 0 ? chalk.green(`${savings.toFixed(1)}%`) : `+${savings.toFixed(1)}%`;
    return `${chalk.green(formatted)} ${chalk.dim(`(${savingsStr})`)}`;
  }
  return chalk.green(formatted);
}

/**
 * Render a service overview table when `azc price` is called without a specific SKU.
 * Groups results by distinct skuName, shows one row per SKU with monthly estimate
 * and % difference from the cheapest option.
 *
 * @param {object} params
 * @param {string} params.serviceName - Azure service name
 * @param {string} params.region      - Azure region
 * @param {string} params.currency    - Currency code
 * @param {string} params.os          - OS filter (linux/windows)
 * @param {Array<object>} params.items - Price items from the Retail Prices API
 */
function renderServiceOverview({ serviceName, region, currency, os, items }) {
  logger.spacer();
  logger.header(`${coral(serviceName)} — ${region}, ${os || 'all'}, ${currency}`);
  logger.spacer();

  // Only show Consumption items for the overview
  const consumption = items.filter((i) => i.type === 'Consumption');

  // Filter out Spot and Low Priority
  const filtered = consumption.filter((item) => {
    const meter = (item.meterName || '').toLowerCase();
    const sku = (item.skuName || '').toLowerCase();
    return !meter.includes('spot') && !meter.includes('low priority') &&
           !sku.includes('spot') && !sku.includes('low priority');
  });

  if (filtered.length === 0) {
    logger.warn('No consumption pricing data found for this service.');
    return;
  }

  // Group by skuName, taking the first item per group
  const skuMap = new Map();
  for (const item of filtered) {
    const key = item.skuName || item.armSkuName || item.meterName || '';
    if (!skuMap.has(key)) {
      skuMap.set(key, item);
    }
  }

  // Calculate monthly estimates and sort by price
  const rows = [];
  for (const [skuName, item] of skuMap) {
    const monthly = estimateMonthly(item.retailPrice, item.unitOfMeasure);
    if (monthly !== null && monthly > 0) {
      rows.push({ skuName, monthly, item });
    }
  }
  rows.sort((a, b) => a.monthly - b.monthly);

  // Limit to the top 15 most common SKUs to keep the table readable
  const displayRows = rows.slice(0, 15);
  const cheapest = displayRows.length > 0 ? displayRows[0].monthly : 0;

  // Find matching reservations
  const reserved1yr = items.filter((i) => i.type === 'Reservation' && i.reservationTerm === '1 Year');
  const reserved3yr = items.filter((i) => i.type === 'Reservation' && i.reservationTerm === '3 Years');

  const table = new Table({
    head: [
      chalk.dim('SKU'),
      chalk.dim('Monthly'),
      chalk.dim('vs cheapest'),
      chalk.dim('Annual'),
      chalk.dim('1yr RI'),
      chalk.dim('3yr RI'),
    ],
    style: { head: [], border: ['dim'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
  });

  for (const row of displayRows) {
    const pctDiff = cheapest > 0 && row.monthly > cheapest
      ? chalk.dim(`+${(((row.monthly - cheapest) / cheapest) * 100).toFixed(0)}%`)
      : chalk.dim('—');

    // Find matching RI prices
    const match1yr = reserved1yr.find((r) => matchesReservation(row.item, r));
    const match3yr = reserved3yr.find((r) => matchesReservation(row.item, r));
    const ri1 = match1yr ? chalk.green(formatMoney(match1yr.retailPrice / 12, currency)) : chalk.dim('—');
    const ri3 = match3yr ? chalk.green(formatMoney(match3yr.retailPrice / 36, currency)) : chalk.dim('—');

    table.push([
      chalk.blue(row.skuName),
      chalk.green(formatMoney(row.monthly, currency)),
      pctDiff,
      chalk.green(formatMoney(monthlyToAnnual(row.monthly), currency)),
      ri1,
      ri3,
    ]);
  }

  logger.raw(table.toString() + '\n');

  if (rows.length > displayRows.length) {
    logger.dim(`  Showing top ${displayRows.length} of ${rows.length} SKUs`);
  }

  logger.spacer();
}

module.exports = {
  renderPriceLookup,
  renderScanResult,
  renderComparison,
  renderServiceOverview,
  estimateMonthly,
};
