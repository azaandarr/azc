// resource-graph.js — Queries the Azure Resource Graph API to enumerate
// all resources in a subscription (or resource group). Returns a normalised
// array of resource objects with consistent field names regardless of the
// underlying ARM response shape.
//
// Requires authentication via DefaultAzureCredential (handled by auth/credential.js).
// The identity needs the Reader role on the target subscription.

const logger = require('../utils/logger');
const { getCredential } = require('../auth/credential');

// Resource Graph paginates at 1000 rows by default. For very large
// subscriptions we follow the $skipToken until we've fetched everything.
const PAGE_SIZE = 1000;

/**
 * Query Azure Resource Graph for all resources in a subscription.
 * Optionally scoped to a single resource group.
 *
 * @param {object} params
 * @param {string} params.subscriptionId  - The subscription GUID
 * @param {string} [params.resourceGroup] - Optional resource group name to filter by
 * @returns {Promise<Array<object>>} Normalised resource objects
 */
async function queryResources({ subscriptionId, resourceGroup }) {
  // Lazy-load the SDK — same pattern as credential.js to keep startup fast
  const { ResourceGraphClient } = require('@azure/arm-resourcegraph');
  const credential = getCredential();
  const client = new ResourceGraphClient(credential);

  // Build the KQL query. We project only the fields we need for pricing.
  // The sku and properties fields are large nested objects — we need them
  // for the SKU mapper but they vary wildly per resource type.
  let kql = `
    Resources
    | where subscriptionId == '${subscriptionId}'
  `;

  // Scope to a specific resource group if requested
  if (resourceGroup) {
    kql += `| where resourceGroup =~ '${resourceGroup}'\n`;
  }

  kql += `| project name, type, location, sku, properties, resourceGroup, kind, tags
    | order by type asc`;

  const allRows = [];
  let skipToken = null;

  // Paginate through all results — Resource Graph returns up to 1000 rows
  // per request and provides a $skipToken for the next page.
  do {
    const requestBody = {
      query: kql,
      subscriptions: [subscriptionId],
      options: {
        resultFormat: 'objectArray',
        '$top': PAGE_SIZE,
      },
    };

    // Add skipToken for subsequent pages
    if (skipToken) {
      requestBody.options['$skipToken'] = skipToken;
    }

    let result;
    try {
      result = await client.resources(requestBody);
    } catch (err) {
      // Surface common errors with helpful messages
      if (err.statusCode === 403 || (err.message && err.message.includes('AuthorizationFailed'))) {
        logger.error(
          `No Reader access on subscription ${subscriptionId}.\n` +
          '  Your identity needs the "Reader" role on this subscription.\n' +
          '  Ask your admin to run: az role assignment create --assignee <your-id> --role Reader --scope /subscriptions/' + subscriptionId,
          'AZC_NO_READER'
        );
        process.exit(1);
      }
      throw err;
    }

    const rows = result.data || [];
    allRows.push(...rows);

    // Resource Graph returns $skipToken in the response when there are more pages
    skipToken = result.$skipToken || null;

    logger.dim(`Fetched ${allRows.length} resources${skipToken ? ' (more pages...)' : ''}`);
  } while (skipToken);

  // Normalise each raw resource into a consistent shape.
  // The raw data has inconsistent casing (type is sometimes lowercase,
  // sometimes mixed case) and nested fields vary per resource type.
  return allRows.map(normaliseResource);
}

/**
 * Normalise a raw Resource Graph row into a consistent shape.
 * Lowercases the type field (ARM types are case-insensitive but returned
 * in varying cases), and extracts top-level fields we always need.
 *
 * @param {object} raw - Raw resource object from Resource Graph
 * @returns {object} Normalised resource
 */
function normaliseResource(raw) {
  return {
    name: raw.name,
    // ARM resource types are case-insensitive; normalise to lowercase
    // so sku-mapper lookups are consistent
    type: (raw.type || '').toLowerCase(),
    location: raw.location,
    resourceGroup: raw.resourceGroup,
    kind: raw.kind || null,
    // Keep the full sku and properties objects for the SKU mapper —
    // different resource types store pricing-relevant info in different places
    sku: raw.sku || null,
    properties: raw.properties || {},
    tags: raw.tags || {},
  };
}

module.exports = {
  queryResources,
  normaliseResource,
};
