// currency.js — Locale-aware money formatting for supported currencies.
// All monetary values in azc flow through these helpers so we get consistent
// formatting across table output, JSON exports, and comparison diffs.

// Supported currencies and their Intl.NumberFormat locale + symbol pairs.
// We use Intl.NumberFormat because it handles thousands separators,
// decimal places, and symbol placement correctly for each locale.
const CURRENCY_CONFIG = {
  GBP: { locale: 'en-GB', symbol: '£' },
  USD: { locale: 'en-US', symbol: '$' },
  EUR: { locale: 'de-DE', symbol: '€' },
};

// Pre-built formatters — one per currency. We cache these because
// creating Intl.NumberFormat instances is surprisingly expensive
// and we call format() hundreds of times during a scan.
const formatters = {};
for (const [code, config] of Object.entries(CURRENCY_CONFIG)) {
  formatters[code] = new Intl.NumberFormat(config.locale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a number as a currency string (e.g. "£1,234.56").
 * @param {number} amount       - The raw numeric amount
 * @param {string} [currency]   - Currency code: 'GBP', 'USD', or 'EUR'. Defaults to 'GBP'.
 * @returns {string} Formatted currency string
 */
function formatMoney(amount, currency = 'GBP') {
  const code = currency.toUpperCase();
  const formatter = formatters[code];

  // Fall back to a simple fixed-decimal format if the currency isn't in our list
  if (!formatter) {
    return `${amount.toFixed(2)} ${code}`;
  }

  return formatter.format(amount);
}

/**
 * Calculate the monthly cost from an hourly rate.
 * Azure uses 730 hours/month (365 days * 24 hours / 12 months) as the
 * standard billing conversion — this matches the Azure Pricing Calculator.
 * @param {number} hourlyRate - Price per hour
 * @returns {number} Monthly cost
 */
const HOURS_PER_MONTH = 730;

function hourlyToMonthly(hourlyRate) {
  return hourlyRate * HOURS_PER_MONTH;
}

/**
 * Calculate the annual cost from a monthly cost.
 * @param {number} monthlyCost - Monthly cost
 * @returns {number} Annual cost
 */
function monthlyToAnnual(monthlyCost) {
  return monthlyCost * 12;
}

/**
 * Format a percentage delta for cost comparisons (e.g. "+23.5%" or "-12.0%").
 * Positive deltas get a "+" prefix, negative ones already have "-".
 * @param {number} oldValue - Original cost
 * @param {number} newValue - New cost
 * @returns {string} Formatted percentage string
 */
function formatDelta(oldValue, newValue) {
  if (oldValue === 0) return newValue === 0 ? '0.0%' : '+∞%';
  const pct = ((newValue - oldValue) / oldValue) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

module.exports = {
  formatMoney,
  hourlyToMonthly,
  monthlyToAnnual,
  formatDelta,
  HOURS_PER_MONTH,
  CURRENCY_CONFIG,
};
