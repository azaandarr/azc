// sku-picker.js — Shared SKU picker utilities used by plan.js and compare.js.
// Provides the two-step family → size picker for VMs and PostgreSQL,
// inline price enrichment for static-choice prompts, single-SKU price
// lookup, and inline resource string parsing for CLI shorthand.

const path = require('path');
const chalk = require('chalk');
const { lookupPrice } = require('../services/retail-prices');
const { createSpinner } = require('./spinner');
const { formatMoney, hourlyToMonthly } = require('./currency');

// Show numbered indices on all select prompts so users can type a number
// to jump directly to an option (works alongside arrow key navigation)
const NUMBERED_THEME = { indexMode: 'number' };

// Load VM and PostgreSQL SKU data files for the family → size picker
const vmSkus = require(path.join(__dirname, '../../data/vm-skus.json'));
const pgSkus = require(path.join(__dirname, '../../data/pg-skus.json'));

// Load service alias mappings for parseInlineResource
const skuMappings = require(path.join(__dirname, '../../data/sku-mappings.json'));

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
 * @param {object} [priceOpts] - { region, currency, serviceName } for inline price preview
 * @returns {string} The selected SKU string (e.g. "Standard_D4s_v5")
 */
async function familyPicker(type, select, input, mru, priceOpts) {
  const data = type === 'vm' ? vmSkus : pgSkus;
  const mruKey = type === 'vm' ? 'lastVmSku' : 'lastPgSku';
  const lastSku = mru[mruKey] || '';

  // Build family choices with spec ranges shown inline
  const familyChoices = data.families.map((fam, idx) => {
    const minCpu = Math.min(...fam.skus.map((s) => s.vcpus));
    const maxCpu = Math.max(...fam.skus.map((s) => s.vcpus));
    const minRam = Math.min(...fam.skus.map((s) => s.ramGB));
    const maxRam = Math.max(...fam.skus.map((s) => s.ramGB));
    const specRange = `${minCpu}-${maxCpu} vCPU, ${minRam}-${maxRam} GB`;
    return {
      name: `${fam.name.split('(')[0].trim().padEnd(22)} ${specRange.padEnd(24)} ${chalk.dim(fam.description)}`,
      value: idx,
    };
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
    message: type === 'vm' ? 'VM family:' : 'PostgreSQL tier:',
    choices: familyChoices,
    default: defaultFamily,
    theme: NUMBERED_THEME,
  });

  // Escape hatch — free-text input for custom SKUs
  if (familyIdx === -1) {
    return await input({
      message: type === 'vm' ? 'VM size' : 'Compute SKU',
      default: lastSku || '',
    });
  }

  const family = data.families[familyIdx];

  // Fetch prices for all SKUs in this family if priceOpts provided
  let skuPrices = {};
  if (priceOpts) {
    try {
      const priceItems = await lookupPrice({
        serviceName: priceOpts.serviceName,
        armRegionName: priceOpts.region,
        priceType: 'Consumption',
        currency: priceOpts.currency,
      });

      // Filter out Spot/Low Priority
      const pool = priceItems.filter((item) => {
        const meter = (item.meterName || '').toLowerCase();
        const skuN = (item.skuName || '').toLowerCase();
        return !meter.includes('spot') && !meter.includes('low priority') &&
               !skuN.includes('spot') && !skuN.includes('low priority');
      });

      // Apply OS filter if present
      let filtered = pool;
      if (priceOpts.os) {
        const osF = pool.filter((item) => {
          const prod = (item.productName || '').toLowerCase();
          if (priceOpts.os === 'linux') return prod.includes('linux');
          return !prod.includes('linux');
        });
        if (osF.length > 0) filtered = osF;
      }

      // Match each SKU in the family to a price
      for (const s of family.skus) {
        const skuLower = s.sku.toLowerCase().replace(/\s+/g, '');
        const match = filtered.find((item) => {
          const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
          return armSku === skuLower;
        });
        if (match) {
          const unit = (match.unitOfMeasure || '').toLowerCase();
          if (unit.includes('hour')) skuPrices[s.sku] = hourlyToMonthly(match.retailPrice);
          else if (unit.includes('month')) skuPrices[s.sku] = match.retailPrice;
          else skuPrices[s.sku] = match.retailPrice;
        }
      }
    } catch (_) {
      // Price preview failed — show sizes without prices
    }
  }

  // Build size choices with vCPU/RAM inline (and prices if available)
  const sizeChoices = family.skus.map((s) => {
    const cpuStr = String(s.vcpus).padStart(2);
    const ramStr = String(s.ramGB).padStart(4);
    const priceStr = skuPrices[s.sku]
      ? chalk.dim(` ~${formatMoney(skuPrices[s.sku], priceOpts?.currency || 'GBP')}/mo`)
      : '';
    return {
      name: `${s.sku.padEnd(22)} ${cpuStr} vCPU  ${ramStr} GB RAM${priceStr}`,
      value: s.sku,
    };
  });

  const selectedSku = await select({
    message: 'Size:',
    choices: sizeChoices,
    default: lastSku && family.skus.some((s) => s.sku === lastSku) ? lastSku : undefined,
    theme: NUMBERED_THEME,
  });

  return selectedSku;
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

  if (os) {
    const osFiltered = matched.filter((item) => {
      const prod = (item.productName || '').toLowerCase();
      if (os === 'linux') return prod.includes('linux');
      return !prod.includes('linux');
    });
    if (osFiltered.length > 0) matched = osFiltered;
  }

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

      if (os) {
        const osF = matched.filter((item) => {
          const prod = (item.productName || '').toLowerCase();
          if (os === 'linux') return prod.includes('linux');
          return !prod.includes('linux');
        });
        if (osF.length > 0) matched = osF;
      }

      if (tier) {
        const tf = tier.toLowerCase();
        const tF = matched.filter((item) => (item.productName || '').toLowerCase().includes(tf));
        if (tF.length > 0) matched = tF;
      }

      // Meter filter for Redis
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
    return choices.map((c) => ({ name: c, value: c, monthly: null }));
  }
}

/**
 * Parse an inline resource string like "3x App Service P1v3 linux" into
 * a structured object for the plan command's CLI shorthand mode.
 *
 * Format: [Nx] <ServiceAlias> <SKU> [os] [tier]
 *
 * @param {string} str - The raw inline resource string
 * @returns {{ quantity: number, serviceName: string, apiServiceName: string, sku: string, os: string|null, tier: string|null } | null}
 */
function parseInlineResource(str) {
  let remaining = str.trim();
  let quantity = 1;

  // Check for leading quantity: "3x " or "3X " or "3x" (case-insensitive)
  const qtyMatch = remaining.match(/^(\d+)\s*x\s+/i);
  if (qtyMatch) {
    quantity = parseInt(qtyMatch[1], 10);
    remaining = remaining.substring(qtyMatch[0].length);
  }

  // Use the same greedy alias matching as price.js parseQuery
  const words = remaining.split(/\s+/);

  // Build alias lookup from sku-mappings.json
  const aliasMap = {};
  for (const [, entry] of Object.entries(skuMappings.services)) {
    for (const alias of entry.aliases) {
      aliasMap[alias.toLowerCase()] = entry;
    }
    aliasMap[entry.serviceName.toLowerCase()] = entry;
  }

  // Try progressively shorter prefixes (greedy match)
  let matched = null;
  let skuStartIdx = 0;

  for (let i = words.length; i >= 1; i--) {
    const prefix = words.slice(0, i).join(' ').toLowerCase();
    if (aliasMap[prefix]) {
      matched = aliasMap[prefix];
      skuStartIdx = i;
      break;
    }
  }

  if (!matched) return null;

  // Everything after the service name
  const afterService = words.slice(skuStartIdx);
  if (afterService.length === 0) return null;

  // First token after service is the SKU
  const sku = afterService[0];

  // Remaining tokens are os or tier hints
  const extras = afterService.slice(1).map((w) => w.toLowerCase());
  let os = null;
  let tier = null;

  for (const e of extras) {
    if (e === 'linux' || e === 'windows') os = e;
    else if (['basic', 'standard', 'premium'].includes(e)) tier = e;
  }

  return {
    quantity,
    serviceName: matched.serviceName,
    apiServiceName: matched.serviceName,
    sku,
    os,
    tier,
  };
}

module.exports = {
  familyPicker,
  lookupSinglePrice,
  enrichChoicesWithPrices,
  parseInlineResource,
  NUMBERED_THEME,
  vmSkus,
  pgSkus,
};
