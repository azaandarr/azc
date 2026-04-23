// ri-advisor.js — Reserved Instance recommendations.
// After a scan or plan produces a cost estimate, this module looks up
// 1-year and 3-year reserved pricing for eligible resources and calculates
// the potential savings compared to pay-as-you-go.
//
// Reservation prices from the API are total-term costs (e.g. £1,051.20
// for 1 year). We divide by 12 or 36 to get monthly equivalents.

const { lookupPrice } = require('./retail-prices');
const { hourlyToMonthly } = require('../utils/currency');
const logger = require('../utils/logger');

// Services that commonly have reserved pricing.
// Map from service display name (used in plan items) to the API serviceName.
const RI_ELIGIBLE_SERVICES = {
  'Virtual Machines': 'Virtual Machines',
  'Virtual Machine': 'Virtual Machines',
  'App Service Plan': 'Azure App Service',
  'Azure App Service': 'Azure App Service',
  'Azure Database for PostgreSQL': 'Azure Database for PostgreSQL',
  'PostgreSQL Flexible Server': 'Azure Database for PostgreSQL',
  'SQL Database': 'SQL Database',
  'Azure SQL Database': 'SQL Database',
  'Azure Cosmos DB': 'Azure Cosmos DB',
  'Redis Cache': 'Redis Cache',
};

// ARM resource types that are RI-eligible (for scan results)
const RI_ELIGIBLE_TYPES = {
  'microsoft.compute/virtualmachines': 'Virtual Machines',
  'microsoft.web/serverfarms': 'Azure App Service',
  'microsoft.dbforpostgresql/flexibleservers': 'Azure Database for PostgreSQL',
  'microsoft.sql/servers/databases': 'SQL Database',
  'microsoft.documentdb/databaseaccounts': 'Azure Cosmos DB',
  'microsoft.cache/redis': 'Redis Cache',
};

/**
 * Look up RI pricing for a set of priced resources.
 * Returns only resources where at least one RI price was found.
 *
 * @param {Array<object>} resources - Priced resources (from scan or plan)
 * @param {object} options
 * @param {string} options.region
 * @param {string} options.currency
 * @returns {Promise<Array<object>>} RI recommendations
 */
async function getRecommendations(resources, { region, currency }) {
  const eligible = resources.filter((r) => {
    if (r.usageBased || r.monthlyCost <= 0) return false;
    // Check by type (scan results) or by service name (plan items)
    const type = (r.type || '').toLowerCase();
    const service = r.service || r.name || '';
    return RI_ELIGIBLE_TYPES[type] || RI_ELIGIBLE_SERVICES[service];
  });

  if (eligible.length === 0) return [];

  // Build lookup promises for all eligible resources in parallel.
  // The concurrency limiter in retail-prices.js handles throttling.
  const promises = eligible.map(async (r) => {
    const type = (r.type || '').toLowerCase();
    const serviceName = RI_ELIGIBLE_TYPES[type] || RI_ELIGIBLE_SERVICES[r.service || r.name || ''];
    if (!serviceName) return null;

    try {
      // Fetch ALL pricing (no priceType filter) so we get both Consumption and Reservation
      const items = await lookupPrice({
        serviceName,
        armRegionName: region,
        currency,
      });

      const sku = r.sku || '';
      const skuLower = sku.toLowerCase().replace(/\s+/g, '');

      // Find reservation items matching this SKU
      const reservations = items.filter((item) => {
        if (item.type !== 'Reservation') return false;
        const armSku = (item.armSkuName || '').toLowerCase().replace(/\s+/g, '');
        const skuName = (item.skuName || '').toLowerCase().replace(/\s+/g, '');
        const meter = (item.meterName || '').toLowerCase().replace(/\s+/g, '');

        // Filter out Spot/Low Priority
        if (meter.includes('spot') || meter.includes('low priority')) return false;
        if (skuName.includes('spot') || skuName.includes('low priority')) return false;

        return armSku.includes(skuLower) || skuName.includes(skuLower) || meter.includes(skuLower);
      });

      if (reservations.length === 0) return null;

      const ri1yr = reservations.find((i) => i.reservationTerm === '1 Year');
      const ri3yr = reservations.find((i) => i.reservationTerm === '3 Years');

      if (!ri1yr && !ri3yr) return null;

      // Reservation prices are total-term costs. Divide by 12 or 36 for monthly.
      const ri1yrMonthly = ri1yr ? ri1yr.retailPrice / 12 : null;
      const ri3yrMonthly = ri3yr ? ri3yr.retailPrice / 36 : null;

      return {
        name: r.name || r.service || '',
        sku,
        currentMonthly: r.monthlyCost,
        ri1yrMonthly,
        ri3yrMonthly,
      };
    } catch (err) {
      logger.debug(`RI lookup failed for ${r.name || r.service}: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.all(promises);
  return results.filter((r) => r !== null);
}

module.exports = { getRecommendations };
