// xlsx.js — Excel export using exceljs.
// Generates a workbook that matches the Azure Pricing Calculator export format
// so the output is immediately familiar to anyone who's used the calculator.
//
// Layout mirrors the official Azure export:
//   Row 1: "Microsoft Azure Estimate" (bold, merged A1:C1)
//   Row 2: "Your Estimate"
//   Row 3: Column headers (blue background): Service category | Service type | Custom name | Region | Description | Estimated monthly cost | Estimated upfront cost
//   Rows 4+: One row per resource
//   Support row: Support category with £0.00
//   Licensing/Billing rows: Licensing Program, Billing Account, Billing Profile
//   Total row: bold totals
//   Blank row
//   Disclaimer row (grey background)
//   Currency + timestamp note (grey background)
//   Created-at timestamp (grey background)

const { monthlyToAnnual } = require('../utils/currency');
const logger = require('../utils/logger');

// Map our internal service names to Azure Pricing Calculator categories
const SERVICE_CATEGORIES = {
  'microsoft.web/serverfarms': 'Compute',
  'microsoft.compute/virtualmachines': 'Compute',
  'microsoft.dbforpostgresql/flexibleservers': 'Databases',
  'microsoft.sql/servers/databases': 'Databases',
  'microsoft.documentdb/databaseaccounts': 'Databases',
  'microsoft.cache/redis': 'Databases',
  'microsoft.storage/storageaccounts': 'Storage',
  'microsoft.compute/disks': 'Storage',
  'microsoft.network/applicationgateways': 'Networking',
  'microsoft.network/publicipaddresses': 'Networking',
  'microsoft.cdn/profiles': 'Networking',
  'microsoft.servicebus/namespaces': 'Integration',
  'microsoft.keyvault/vaults': 'Security',
  'microsoft.insights/components': 'Management and Governance',
  'microsoft.containerregistry/registries': 'Containers',
  // Plan builder items use the service name directly
  'App Service Plan': 'Compute',
  'Virtual Machine': 'Compute',
  'PostgreSQL Flexible Server': 'Databases',
  'Azure SQL Database': 'Databases',
  'Redis Cache': 'Databases',
  'Application Gateway': 'Networking',
  'Service Bus': 'Integration',
  'Container Registry': 'Containers',
  'Application Insights': 'Management and Governance',
  'Managed Disks': 'Storage',
};

// Map our internal type names to Azure Pricing Calculator service type labels
const SERVICE_TYPE_LABELS = {
  'microsoft.web/serverfarms': 'App Service',
  'microsoft.compute/virtualmachines': 'Virtual Machines',
  'microsoft.dbforpostgresql/flexibleservers': 'Azure Database for PostgreSQL',
  'microsoft.sql/servers/databases': 'SQL Database',
  'microsoft.documentdb/databaseaccounts': 'Azure Cosmos DB',
  'microsoft.cache/redis': 'Azure Cache for Redis',
  'microsoft.storage/storageaccounts': 'Storage Accounts',
  'microsoft.compute/disks': 'Managed Disks',
  'microsoft.network/applicationgateways': 'Application Gateway',
  'microsoft.network/publicipaddresses': 'Public IP Addresses',
  'microsoft.cdn/profiles': 'Content Delivery Network',
  'microsoft.servicebus/namespaces': 'Service Bus',
  'microsoft.keyvault/vaults': 'Key Vault',
  'microsoft.insights/components': 'Application Insights',
  'microsoft.containerregistry/registries': 'Container Registry',
};

// Azure header blue colour (matching the pricing calculator)
const AZURE_HEADER_BLUE = 'FF0078D4';
const DISCLAIMER_GREY = 'FFD9D9D9';

/**
 * Build a human-readable description string for a resource,
 * mimicking the Azure Pricing Calculator's description column.
 */
function buildDescription(resource, region, currency) {
  const parts = [];

  // Resource count (always 1 for our purposes, but matching the format)
  const sku = resource.sku || '';
  const name = resource.name || '';

  if (resource.type && resource.type.includes('virtualmachine')) {
    // VM format: "1 D4ds v4 (4 vCPUs, 16 GB RAM) x 730 Hours (Pay as you go)..."
    parts.push(`1 ${sku} x 730 Hours (Pay as you go).`);
    if (resource.notes) parts.push(resource.notes);
  } else if (resource.type && resource.type.includes('serverfarm')) {
    parts.push(`1 ${sku} x 730 Hours (Pay as you go).`);
    if (resource.notes) parts.push(resource.notes);
  } else {
    if (sku) parts.push(`${sku}.`);
    if (resource.notes) parts.push(resource.notes);
  }

  return parts.join(' ') || sku || '—';
}

/**
 * Export scan/plan results to an Excel workbook matching the Azure Pricing Calculator format.
 *
 * @param {object} params
 * @param {string} params.filePath       - Output file path
 * @param {string} params.subscription   - Subscription name or "Estimate"
 * @param {string} params.region         - Azure region
 * @param {string} params.currency       - Currency code
 * @param {Array<object>} params.resources    - Priced resources
 * @param {Array<object>} params.unsupported  - Unsupported resources
 * @param {Array<object>} params.unpriced     - Unpriced resources
 */
async function exportToXlsx({ filePath, subscription, region, currency, resources, unsupported, unpriced }) {
  // Lazy-load exceljs — it's a heavy dependency and only needed for export
  const ExcelJS = require('exceljs');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'azc';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Estimate');

  // Set column widths to match the Azure export proportions
  sheet.columns = [
    { width: 22 }, // A: Service category
    { width: 26 }, // B: Service type
    { width: 18 }, // C: Custom name
    { width: 14 }, // D: Region
    { width: 60 }, // E: Description
    { width: 24 }, // F: Estimated monthly cost
    { width: 24 }, // G: Estimated upfront cost
  ];

  // ── Row 1: Title ───────────────────────────────────────────────
  const titleRow = sheet.addRow(['Microsoft Azure Estimate']);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  sheet.mergeCells('A1:C1');

  // ── Row 2: "Your Estimate" ─────────────────────────────────────
  const subtitleRow = sheet.addRow(['Your Estimate']);
  subtitleRow.getCell(1).font = { bold: true, size: 11 };

  // ── Row 3: Column headers (blue background, white text) ────────
  const headers = ['Service category', 'Service type', 'Custom name', 'Region', 'Description', 'Estimated monthly cost', 'Estimated upfront cost'];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  for (let col = 1; col <= 7; col++) {
    headerRow.getCell(col).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: AZURE_HEADER_BLUE },
    };
    headerRow.getCell(col).border = {
      bottom: { style: 'thin', color: { argb: 'FF005A9E' } },
    };
  }

  // ── Resource rows ──────────────────────────────────────────────
  let totalMonthly = 0;
  const currencySymbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  const numFmt = `${currencySymbol}#,##0.00`;

  for (const r of resources) {
    const monthly = Math.round(r.monthlyCost * 100) / 100;
    if (!r.usageBased) totalMonthly += r.monthlyCost;

    const category = SERVICE_CATEGORIES[r.type] || SERVICE_CATEGORIES[r.name] || 'General';
    const serviceType = SERVICE_TYPE_LABELS[r.type] || r.type || r.name || '';
    const description = buildDescription(r, region, currency);

    const row = sheet.addRow([
      category,
      serviceType,
      r.name || '',
      region,
      description,
      monthly,
      0, // Upfront cost — always £0.00 for pay-as-you-go
    ]);

    row.getCell(6).numFmt = numFmt;
    row.getCell(7).numFmt = numFmt;

    if (r.usageBased) {
      row.font = { italic: true, color: { argb: 'FF888888' } };
    }
  }

  // ── Support row ────────────────────────────────────────────────
  const supportRow = sheet.addRow(['Support', '', '', 'Support', '', 0, 0]);
  supportRow.getCell(6).numFmt = numFmt;
  supportRow.getCell(7).numFmt = numFmt;

  // ── Licensing info rows ────────────────────────────────────────
  sheet.addRow(['', '', '', 'Licensing Program', 'Microsoft Customer Agreement (MCA)']);
  sheet.addRow(['', '', '', 'Billing Account', '']);
  sheet.addRow(['', '', '', 'Billing Profile', '']);

  // ── Total row ──────────────────────────────────────────────────
  const totalRounded = Math.round(totalMonthly * 100) / 100;
  const totalRow = sheet.addRow([
    '',
    '',
    '',
    'Total',
    '',
    totalRounded,
    0,
  ]);
  totalRow.font = { bold: true };
  totalRow.getCell(6).numFmt = numFmt;
  totalRow.getCell(7).numFmt = numFmt;

  // ── Blank row ──────────────────────────────────────────────────
  sheet.addRow([]);

  // ── Disclaimer section (grey background) ───────────────────────
  const disclaimerHeaderRow = sheet.addRow(['Disclaimer']);
  disclaimerHeaderRow.getCell(1).font = { bold: true };
  applyGreyBackground(disclaimerHeaderRow, 7);

  sheet.addRow([]);

  const now = new Date();
  const currencyNote = `All prices shown are in ${getCurrencyLabel(currency)}. This is a summary estimate, not a quote. For up to date pricing information please visit https://azure.microsoft.com/pricing/calculator/`;
  const noteRow = sheet.addRow([currencyNote]);
  noteRow.getCell(1).font = { italic: true, size: 9 };
  sheet.mergeCells(`A${noteRow.number}:G${noteRow.number}`);
  applyGreyBackground(noteRow, 7);

  const timestampStr = `This estimate was created at ${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB')} UTC.`;
  const tsRow = sheet.addRow([timestampStr]);
  tsRow.getCell(1).font = { italic: true, size: 9 };
  sheet.mergeCells(`A${tsRow.number}:G${tsRow.number}`);
  applyGreyBackground(tsRow, 7);

  // Write the workbook to disk
  await workbook.xlsx.writeFile(filePath);
  logger.success(`Exported to ${filePath}`);
}

/**
 * Apply grey background fill to all cells in a row.
 */
function applyGreyBackground(row, colCount) {
  for (let col = 1; col <= colCount; col++) {
    row.getCell(col).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: DISCLAIMER_GREY },
    };
  }
}

/**
 * Get a human-readable currency label for the disclaimer.
 */
function getCurrencyLabel(currency) {
  const labels = {
    GBP: 'United Kingdom – Pound (£) GBP',
    USD: 'United States – Dollar ($) USD',
    EUR: 'European Union – Euro (€) EUR',
  };
  return labels[currency] || currency;
}

module.exports = { exportToXlsx };
