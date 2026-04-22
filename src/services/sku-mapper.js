// sku-mapper.js — The core mapping engine that translates Azure Resource Graph
// resource objects into the parameters needed to query the Retail Prices API.
//
// This is the hardest engineering problem in the project. Every Azure resource
// type stores its SKU/tier/capacity info in a different place:
//   - App Service Plans:  sku.name ("S1", "P1v3")
//   - VMs:                properties.hardwareProfile.vmSize ("Standard_D4s_v5")
//   - PostgreSQL:         sku.name ("Standard_D2ds_v4")
//   - Storage:            sku.name ("Standard_LRS") but pricing uses "LRS" not the full SKU
//   - Cosmos DB:          no SKU field at all — pricing is per-RU based on properties
//
// Each mapper function receives a normalised resource object (from resource-graph.js)
// and returns a pricing descriptor that retail-prices.js can use to look up the cost.

const logger = require('../utils/logger');

/**
 * @typedef {object} PricingDescriptor
 * @property {string} serviceName       - The Retail Prices API serviceName (e.g. 'Virtual Machines')
 * @property {object} filters           - Additional OData filter key-value pairs
 * @property {number} [quantity=1]      - Multiplier (e.g. instance count, vCores)
 * @property {string} [unit]            - Expected unit of measure for validation
 * @property {string} [notes]           - Human-readable note about pricing assumptions
 */

// ─── Individual resource type mappers ───────────────────────────────
// Each function takes a normalised resource and returns a PricingDescriptor
// or null if the resource can't be mapped (missing SKU info, etc.)

/**
 * microsoft.web/serverfarms — App Service Plans.
 * SKU lives in resource.sku.name (e.g. "S1", "P1v3", "B1").
 * The sku.capacity field gives the instance count.
 * Linux plans have properties.reserved === true.
 */
function mapAppServicePlan(resource) {
  const skuName = resource.sku && resource.sku.name;
  if (!skuName) return null;

  const isLinux = resource.properties && resource.properties.reserved === true;
  const instances = (resource.sku && resource.sku.capacity) || 1;

  return {
    serviceName: 'Azure App Service',
    filters: {},
    skuMatch: skuName,
    quantity: instances,
    unit: '1 Hour',
    notes: `${instances} instance(s), ${isLinux ? 'Linux' : 'Windows'}`,
    os: isLinux ? 'linux' : 'windows',
  };
}

/**
 * microsoft.compute/virtualmachines — Virtual Machines.
 * SKU is in properties.hardwareProfile.vmSize (e.g. "Standard_D4s_v5").
 * This maps directly to armSkuName in the Retail Prices API.
 */
function mapVirtualMachine(resource) {
  const vmSize = resource.properties
    && resource.properties.hardwareProfile
    && resource.properties.hardwareProfile.vmSize;

  if (!vmSize) return null;

  // Detect OS from properties.storageProfile.osDisk.osType
  const osType = resource.properties.storageProfile
    && resource.properties.storageProfile.osDisk
    && resource.properties.storageProfile.osDisk.osType;
  const isWindows = (osType || '').toLowerCase() === 'windows';

  return {
    serviceName: 'Virtual Machines',
    filters: { armSkuName: vmSize },
    quantity: 1,
    unit: '1 Hour',
    notes: isWindows ? 'Windows' : 'Linux',
    os: isWindows ? 'windows' : 'linux',
  };
}

/**
 * microsoft.dbforpostgresql/flexibleservers — PostgreSQL Flexible Server.
 * SKU is in resource.sku.name (e.g. "Standard_D2ds_v4").
 * Storage size is in properties.storage.storageSizeGB.
 * The sku.tier gives the pricing tier (Burstable, GeneralPurpose, MemoryOptimized).
 */
function mapPostgresqlFlexible(resource) {
  const skuName = resource.sku && resource.sku.name;
  if (!skuName) return null;

  const storageGB = (resource.properties.storage && resource.properties.storage.storageSizeGB) || 32;

  return {
    serviceName: 'Azure Database for PostgreSQL',
    filters: { armSkuName: skuName },
    quantity: 1,
    unit: '1 Hour',
    notes: `${storageGB} GB storage`,
    // Storage is priced separately — we add it as a secondary cost
    storageCost: {
      serviceName: 'Azure Database for PostgreSQL',
      filters: {},
      skuMatch: 'Storage Data Stored',
      quantity: storageGB,
      unit: '1 GB/Month',
    },
  };
}

/**
 * microsoft.storage/storageaccounts — Storage Accounts.
 * SKU is in resource.sku.name (e.g. "Standard_LRS", "Premium_LRS").
 * The kind field distinguishes BlobStorage, StorageV2, etc.
 * Pricing depends on access tier (Hot, Cool, Archive) from properties.accessTier.
 */
function mapStorageAccount(resource) {
  const skuName = resource.sku && resource.sku.name;
  if (!skuName) return null;

  const accessTier = (resource.properties && resource.properties.accessTier) || 'Hot';
  const kind = resource.kind || 'StorageV2';

  // The API uses specific meter names for storage tiers.
  // We can't estimate cost without knowing actual usage (GB stored),
  // so we return a per-GB rate and note that it's usage-dependent.
  return {
    serviceName: 'Storage',
    filters: {},
    skuMatch: accessTier,
    quantity: 1,
    unit: '1 GB/Month',
    notes: `${skuName}, ${accessTier} tier, ${kind} — cost depends on usage (GB stored)`,
    usageBased: true,
  };
}

/**
 * microsoft.documentdb/databaseaccounts — Cosmos DB.
 * Cosmos DB pricing is complex — it depends on throughput model (provisioned RU/s
 * vs serverless), consistency level, multi-region writes, etc.
 * The SKU is not in resource.sku — it's derived from properties.
 */
function mapCosmosDb(resource) {
  const capabilities = resource.properties && resource.properties.capabilities;
  const isServerless = capabilities && capabilities.some(
    (c) => c.name === 'EnableServerless'
  );

  // Detect the API type (SQL, MongoDB, Cassandra, etc.)
  const kind = resource.kind || 'GlobalDocumentDB';

  return {
    serviceName: 'Azure Cosmos DB',
    filters: {},
    skuMatch: isServerless ? 'Serverless' : 'Provisioned Throughput',
    quantity: 1,
    unit: isServerless ? '1M RUs' : '100 RU/s/Hour',
    notes: `${kind}, ${isServerless ? 'Serverless' : 'Provisioned'} — cost depends on RU/s usage`,
    usageBased: true,
  };
}

/**
 * microsoft.cache/redis — Azure Cache for Redis.
 * SKU info is in resource.sku.name (e.g. "C1"), resource.sku.family (e.g. "C"),
 * and resource.sku.capacity (e.g. 1 for 1GB).
 */
function mapRedisCache(resource) {
  const skuName = resource.sku && resource.sku.name;
  const skuFamily = resource.sku && resource.sku.family;
  const capacity = resource.sku && resource.sku.capacity;

  if (!skuName) return null;

  const tierName = skuFamily && capacity != null ? `${skuFamily}${capacity}` : skuName;
  const tier = (resource.sku.tier || 'Standard').toLowerCase();

  return {
    serviceName: 'Redis Cache',
    filters: {},
    skuMatch: tierName,
    // productFilter narrows by productName to disambiguate tiers that share
    // the same SKU name (e.g. C1 exists in both Basic and Standard)
    productFilter: tier,
    // meterFilter picks the right meter — "C1 Cache" is the primary compute
    // cost, "C1 Cache Instance" is a secondary HA charge on Standard+
    meterFilter: `${tierName} Cache`,
    quantity: 1,
    unit: '1 Hour',
    notes: `${resource.sku.tier || 'Standard'} ${tierName}`,
  };
}

/**
 * microsoft.keyvault/vaults — Key Vault.
 * Key Vault pricing is operation-based (per 10K operations) plus
 * per-key/secret charges. The SKU tier is in resource.sku.name ("standard" or "premium").
 */
function mapKeyVault(resource) {
  const tier = (resource.sku && resource.sku.name) || 'standard';

  return {
    serviceName: 'Key Vault',
    filters: {},
    skuMatch: tier.charAt(0).toUpperCase() + tier.slice(1),
    quantity: 1,
    unit: '10K Transactions',
    notes: `${tier} tier — cost depends on operation count`,
    usageBased: true,
  };
}

/**
 * microsoft.insights/components — Application Insights.
 * Pricing is based on data ingestion volume (GB/month).
 * The first 5GB/month is free. No meaningful SKU to extract.
 */
function mapApplicationInsights(resource) {
  return {
    serviceName: 'Application Insights',
    filters: {},
    skuMatch: 'Enterprise Overage Data',
    quantity: 1,
    unit: '1 GB',
    notes: 'Pay-per-GB ingestion — first 5 GB/month free',
    usageBased: true,
  };
}

/**
 * microsoft.cdn/profiles — Azure CDN.
 * The SKU tier is in resource.sku.name (e.g. "Standard_Microsoft", "Standard_Akamai",
 * "Standard_Verizon", "Premium_Verizon", "Premium_AzureFrontDoor").
 */
function mapCdnProfile(resource) {
  const skuName = resource.sku && resource.sku.name;
  if (!skuName) return null;

  return {
    serviceName: 'Content Delivery Network',
    filters: {},
    skuMatch: skuName.replace('_', ' '),
    quantity: 1,
    unit: '1 GB',
    notes: `${skuName} — cost depends on data transfer volume`,
    usageBased: true,
  };
}

/**
 * microsoft.network/applicationgateways — Application Gateway.
 * The SKU is in properties.sku.name (e.g. "Standard_v2", "WAF_v2", "Standard_Small").
 * V2 gateways use a fixed cost + capacity unit model; v1 uses instance-based pricing.
 * The Retail Prices API uses plain names like "Standard", "Basic", "Medium", "Large".
 */
function mapApplicationGateway(resource) {
  const gwSku = resource.properties && resource.properties.sku;
  if (!gwSku || !gwSku.name) return null;

  const capacity = gwSku.capacity || 1;

  // The API skuName is just the base tier without version suffixes.
  // "Standard_v2" → "Standard", "WAF_v2" → "Standard" (WAF is priced under Standard),
  // "Standard_Small" → "Small"
  let skuMatch = gwSku.name;
  if (skuMatch.includes('_v2')) {
    skuMatch = skuMatch.replace('_v2', '');
    if (skuMatch === 'WAF') skuMatch = 'Standard';
  } else if (skuMatch.includes('_')) {
    // "Standard_Small" → take the size part
    skuMatch = skuMatch.split('_').pop();
  }

  return {
    serviceName: 'Application Gateway',
    filters: {},
    skuMatch,
    quantity: capacity,
    unit: '1 Hour',
    notes: `${gwSku.name}, ${capacity} instance(s)`,
  };
}

/**
 * microsoft.sql/servers/databases — Azure SQL Database.
 * The SKU is in resource.sku.name (e.g. "GP_Gen5_2", "S0", "BC_Gen5_4").
 * The tier is in resource.sku.tier (e.g. "GeneralPurpose", "Standard", "BusinessCritical").
 */
function mapSqlDatabase(resource) {
  const skuName = resource.sku && resource.sku.name;
  if (!skuName) return null;

  return {
    serviceName: 'SQL Database',
    filters: {},
    skuMatch: skuName,
    quantity: 1,
    unit: '1 Hour',
    notes: `${resource.sku.tier || ''} ${skuName}`.trim(),
  };
}

/**
 * microsoft.servicebus/namespaces — Service Bus.
 * The SKU tier is in resource.sku.name ("Basic", "Standard", "Premium").
 * Premium tier also has resource.sku.capacity for messaging units.
 */
function mapServiceBus(resource) {
  const tier = resource.sku && resource.sku.name;
  if (!tier) return null;

  const messagingUnits = (resource.sku && resource.sku.capacity) || 1;

  return {
    serviceName: 'Service Bus',
    filters: {},
    skuMatch: tier,
    quantity: tier.toLowerCase() === 'premium' ? messagingUnits : 1,
    unit: '1 Hour',
    notes: tier.toLowerCase() === 'premium' ? `Premium, ${messagingUnits} messaging unit(s)` : `${tier} tier`,
  };
}

/**
 * microsoft.compute/disks — Managed Disks.
 * The SKU is in resource.sku.name (e.g. "Premium_LRS", "StandardSSD_LRS").
 * Disk size is in properties.diskSizeGB.
 */
function mapManagedDisk(resource) {
  const skuName = resource.sku && resource.sku.name;
  if (!skuName) return null;

  const diskSizeGB = (resource.properties && resource.properties.diskSizeGB) || 0;

  // Managed Disks pricing uses specific disk tier names (P10, P20, S10, etc.)
  // based on the size. We match on the tier prefix from the SKU.
  const tierPrefix = skuName.split('_')[0];

  return {
    serviceName: 'Managed Disks',
    filters: {},
    skuMatch: tierPrefix,
    quantity: 1,
    unit: '1/Month',
    notes: `${skuName}, ${diskSizeGB} GB`,
  };
}

/**
 * microsoft.network/publicipaddresses — Public IP Addresses.
 * The SKU is in resource.sku.name ("Basic" or "Standard").
 * Basic dynamic IPs are free when not associated; Standard IPs always cost.
 */
function mapPublicIp(resource) {
  const tier = (resource.sku && resource.sku.name) || 'Basic';
  const allocationMethod = (resource.properties && resource.properties.publicIPAllocationMethod) || 'Dynamic';

  return {
    serviceName: 'Virtual Network',
    filters: {},
    skuMatch: 'IP Address',
    quantity: 1,
    unit: '1 Hour',
    notes: `${tier} ${allocationMethod} Public IP`,
  };
}

/**
 * microsoft.containerregistry/registries — Container Registry.
 * The SKU tier is in resource.sku.name ("Basic", "Standard", "Premium").
 */
function mapContainerRegistry(resource) {
  const tier = (resource.sku && resource.sku.name) || 'Basic';

  return {
    serviceName: 'Container Registry',
    filters: {},
    skuMatch: tier,
    quantity: 1,
    unit: '1/Day',
    notes: `${tier} tier`,
  };
}

// ─── Mapper registry ────────────────────────────────────────────────
// Maps lowercase ARM resource type → mapper function.
// When adding a new resource type, just add an entry here and write
// the corresponding mapper function above.
const MAPPERS = {
  'microsoft.web/serverfarms':                    mapAppServicePlan,
  'microsoft.compute/virtualmachines':            mapVirtualMachine,
  'microsoft.dbforpostgresql/flexibleservers':    mapPostgresqlFlexible,
  'microsoft.storage/storageaccounts':            mapStorageAccount,
  'microsoft.documentdb/databaseaccounts':        mapCosmosDb,
  'microsoft.cache/redis':                        mapRedisCache,
  'microsoft.keyvault/vaults':                    mapKeyVault,
  'microsoft.insights/components':                mapApplicationInsights,
  'microsoft.cdn/profiles':                       mapCdnProfile,
  'microsoft.network/applicationgateways':        mapApplicationGateway,
  'microsoft.sql/servers/databases':              mapSqlDatabase,
  'microsoft.servicebus/namespaces':              mapServiceBus,
  'microsoft.compute/disks':                      mapManagedDisk,
  'microsoft.network/publicipaddresses':          mapPublicIp,
  'microsoft.containerregistry/registries':       mapContainerRegistry,
};

/**
 * Check if a resource type is supported by the SKU mapper.
 * @param {string} resourceType - Lowercase ARM resource type
 * @returns {boolean}
 */
function isSupported(resourceType) {
  return resourceType in MAPPERS;
}

/**
 * Map a normalised resource to a PricingDescriptor.
 * Returns null if the resource type is not supported or if the
 * mapper can't extract enough info to look up a price.
 *
 * @param {object} resource - Normalised resource from resource-graph.js
 * @returns {PricingDescriptor|null}
 */
function mapResource(resource) {
  const mapper = MAPPERS[resource.type];
  if (!mapper) return null;

  try {
    return mapper(resource);
  } catch (err) {
    // Don't crash on a single resource — log and continue
    logger.dim(`SKU mapper error for ${resource.name} (${resource.type}): ${err.message}`);
    return null;
  }
}

/**
 * Get the list of all supported resource types.
 * @returns {string[]}
 */
function supportedTypes() {
  return Object.keys(MAPPERS);
}

module.exports = {
  mapResource,
  isSupported,
  supportedTypes,
  // Export individual mappers for testing
  _mappers: MAPPERS,
};
