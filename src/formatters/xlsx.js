// xlsx.js — Excel export using exceljs.
// Generates a workbook that replicates the Azure Pricing Calculator's
// "Export" button output as closely as possible, so the file is
// immediately recognisable to anyone who has used the calculator.

const path = require('path');
const logger = require('../utils/logger');

// Load VM and PG SKU specs so we can enrich descriptions with vCPU/RAM info
const vmSkus = require(path.join(__dirname, '../../data/vm-skus.json'));
const pgSkus = require(path.join(__dirname, '../../data/pg-skus.json'));

// Flatten all SKU specs into a lookup map keyed by lowercase SKU name
const skuSpecs = {};
for (const fam of vmSkus.families) {
  for (const s of fam.skus) {
    skuSpecs[s.sku.toLowerCase()] = s;
  }
}
for (const fam of pgSkus.families) {
  for (const s of fam.skus) {
    skuSpecs[s.sku.toLowerCase()] = s;
  }
}

// Service category labels matching the Azure Pricing Calculator
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

// Service type display names matching the Azure Pricing Calculator
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
  'App Service Plan': 'App Service',
  'Virtual Machine': 'Virtual Machines',
  'PostgreSQL Flexible Server': 'Azure Database for PostgreSQL',
  'Azure SQL Database': 'SQL Database',
  'Redis Cache': 'Azure Cache for Redis',
  'Application Gateway': 'Application Gateway',
  'Service Bus': 'Service Bus',
  'Container Registry': 'Container Registry',
  'Application Insights': 'Application Insights',
  'Managed Disks': 'Managed Disks',
};

// Human-readable region display names
const REGION_DISPLAY = {
  'uksouth': 'UK South',
  'ukwest': 'UK West',
  'westeurope': 'West Europe',
  'northeurope': 'North Europe',
  'eastus': 'East US',
  'eastus2': 'East US 2',
  'westus2': 'West US 2',
  'centralus': 'Central US',
  'southeastasia': 'Southeast Asia',
  'eastasia': 'East Asia',
  'australiaeast': 'Australia East',
};

// Azure brand colour for the header row
const AZURE_BLUE = 'FF0078D4';
const GREY_BG = 'FFD9D9D9';

/**
 * Build a rich description string for the Description column,
 * matching the style of the Azure Pricing Calculator export.
 *
 * Azure format examples:
 *   VM: "1 D4ds v4 (4 vCPUs, 16 GB RAM) x 730 Hours (Pay as you go). Windows (Licence included). OS Only."
 *   App Service: "1 S1 (1 Core(s), 1.75 GB RAM, 50 GB Storage) x 730 Hours"
 *   PG: "1 Standard_D2ds_v5 (2 vCPUs, 8 GB RAM). Pay as you go."
 */
function buildDescription(resource, region) {
  const sku = resource.sku || '';
  const type = (resource.type || resource.name || '').toLowerCase();
  const notes = resource.notes || '';

  // Try to look up vCPU/RAM specs from our data files
  const spec = skuSpecs[(sku || '').toLowerCase()] || skuSpecs[('standard_' + sku).toLowerCase()];

  // ── Virtual Machines ───────────────────────────────────────────
  if (type.includes('virtualmachine') || type === 'virtual machine') {
    const skuDisplay = sku.replace('Standard_', '').replace(/_/g, ' ');
    const specStr = spec ? ` (${spec.vcpus} vCPUs, ${spec.ramGB} GB RAM)` : '';
    const os = notes.includes('windows') ? 'Windows (Licence included)' : notes.includes('linux') ? 'Linux' : '';
    let desc = `1 ${skuDisplay}${specStr} x 730 Hours (Pay as you go).`;
    if (os) desc += ` ${os}. OS Only.`;
    return desc;
  }

  // ── App Service ────────────────────────────────────────────────
  if (type.includes('serverfarm') || type === 'app service plan') {
    const os = notes.includes('linux') ? 'Linux' : notes.includes('windows') ? 'Windows' : '';
    let desc = `1 ${sku} x 730 Hours (Pay as you go).`;
    if (os) desc += ` ${os}.`;
    const instanceMatch = notes.match(/(\d+)\s*instance/i);
    if (instanceMatch && parseInt(instanceMatch[1]) > 1) {
      desc = `${instanceMatch[1]} ${sku} x 730 Hours (Pay as you go).`;
      if (os) desc += ` ${os}.`;
    }
    return desc;
  }

  // ── PostgreSQL Flexible Server ─────────────────────────────────
  if (type.includes('postgresql') || type === 'postgresql flexible server') {
    const specStr = spec ? ` (${spec.vcpus} vCPUs, ${spec.ramGB} GB RAM)` : '';
    return `1 ${sku}${specStr}. Flexible Server, Pay as you go.`;
  }

  // ── Azure SQL ──────────────────────────────────────────────────
  if (type.includes('sql') || type === 'azure sql database') {
    return `1 ${sku}. Pay as you go.`;
  }

  // ── Redis Cache ────────────────────────────────────────────────
  if (type.includes('redis') || type === 'redis cache') {
    const tier = notes.match(/(Basic|Standard|Premium)/i);
    const tierStr = tier ? `${tier[1]} ` : '';
    return `${tierStr}${sku} Cache Instance. Pay as you go.`;
  }

  // ── Application Gateway ────────────────────────────────────────
  if (type.includes('applicationgateway') || type === 'application gateway') {
    return `${sku} Gateway. Pay as you go.`;
  }

  // ── Service Bus ────────────────────────────────────────────────
  if (type.includes('servicebus') || type === 'service bus') {
    return `${sku} tier. Pay as you go.`;
  }

  // ── Container Registry ─────────────────────────────────────────
  if (type.includes('containerregistry') || type === 'container registry') {
    return `${sku} tier. Pay as you go.`;
  }

  // ── Managed Disks ──────────────────────────────────────────────
  if (type.includes('disk') || type === 'managed disks') {
    return `${sku} Managed Disk. Pay as you go.`;
  }

  // ── Usage-based / generic fallback ─────────────────────────────
  if (resource.usageBased) {
    return `${sku}. Usage-based pricing — cost depends on consumption.`;
  }

  const desc = sku ? `${sku}. Pay as you go.` : '';
  return notes ? `${desc} ${notes}`.trim() : desc;
}

/**
 * Export scan/plan results to an Excel workbook matching the
 * Azure Pricing Calculator's export format.
 */
async function exportToXlsx({ filePath, subscription, region, currency, resources, unsupported, unpriced }) {
  const ExcelJS = require('exceljs');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'azc';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Estimate');

  // Column widths matching the Azure export proportions
  sheet.columns = [
    { width: 24 }, // A: Service category
    { width: 30 }, // B: Service type
    { width: 20 }, // C: Custom name
    { width: 16 }, // D: Region
    { width: 70 }, // E: Description
    { width: 26 }, // F: Estimated monthly cost
    { width: 26 }, // G: Estimated upfront cost
  ];

  const regionDisplay = REGION_DISPLAY[region] || region;
  const currencySymbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  const numFmt = `${currencySymbol}#,##0.00`;

  // ── Row 1: "Microsoft Azure Estimate" (bold, merged A:C) ──────
  const row1 = sheet.addRow(['Microsoft Azure Estimate']);
  row1.getCell(1).font = { bold: true, size: 14 };
  sheet.mergeCells('A1:C1');

  // ── Row 2: "Your Estimate" ────────────────────────────────────
  const row2 = sheet.addRow(['Your Estimate']);
  row2.getCell(1).font = { bold: true, size: 11 };

  // ── Row 3: Column headers (Azure blue background, white text) ─
  const headers = [
    'Service category',
    'Service type',
    'Custom name',
    'Region',
    'Description',
    'Estimated monthly cost',
    'Estimated upfront cost',
  ];
  const headerRow = sheet.addRow(headers);
  for (let col = 1; col <= 7; col++) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZURE_BLUE } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  }

  // ── Resource data rows ────────────────────────────────────────
  let totalMonthly = 0;

  for (const r of resources) {
    const monthly = Math.round(r.monthlyCost * 100) / 100;
    if (!r.usageBased) totalMonthly += r.monthlyCost;

    const category = SERVICE_CATEGORIES[r.type] || SERVICE_CATEGORIES[r.name] || 'General';
    const serviceType = SERVICE_TYPE_LABELS[r.type] || SERVICE_TYPE_LABELS[r.name] || r.type || r.name || '';
    const description = buildDescription(r, region);

    const row = sheet.addRow([
      category,
      serviceType,
      r.name || '',
      regionDisplay,
      description,
      monthly,
      0,
    ]);

    row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(6).numFmt = numFmt;
    row.getCell(7).numFmt = numFmt;

    if (r.usageBased) {
      row.font = { italic: true, color: { argb: 'FF888888' } };
    }
  }

  // ── Empty separator row ───────────────────────────────────────
  sheet.addRow([]);

  // ── Support row ───────────────────────────────────────────────
  const supportRow = sheet.addRow(['Support', '', '', 'Support', '', 0, 0]);
  supportRow.getCell(6).numFmt = numFmt;
  supportRow.getCell(7).numFmt = numFmt;

  // ── Licensing / Billing rows ──────────────────────────────────
  sheet.addRow(['', '', '', 'Licensing Program', 'Microsoft Customer Agreement (MCA)']);
  sheet.addRow(['', '', '', 'Billing Account', '']);
  sheet.addRow(['', '', '', 'Billing Profile', '']);

  // ── Total row (bold) ──────────────────────────────────────────
  const totalRounded = Math.round(totalMonthly * 100) / 100;
  const totalRow = sheet.addRow(['', '', '', 'Total', '', totalRounded, 0]);
  totalRow.font = { bold: true };
  totalRow.getCell(6).numFmt = numFmt;
  totalRow.getCell(7).numFmt = numFmt;

  // ── Blank row before disclaimer ───────────────────────────────
  sheet.addRow([]);

  // ── Disclaimer header (grey background) ───────────────────────
  const disclaimerRow = sheet.addRow(['Disclaimer']);
  disclaimerRow.getCell(1).font = { bold: true };
  fillRow(disclaimerRow, 7, GREY_BG);

  // ── Blank row ─────────────────────────────────────────────────
  const blankDisclaimer = sheet.addRow([]);
  fillRow(blankDisclaimer, 7, GREY_BG);

  // ── Currency / pricing note (grey background, italic) ─────────
  const currencyLabel = getCurrencyLabel(currency);
  const noteText = `All prices shown are in ${currencyLabel}. This is a summary estimate, not a quote. For up to date pricing information please visit https://azure.microsoft.com/pricing/calculator/`;
  const noteRow = sheet.addRow([noteText]);
  noteRow.getCell(1).font = { italic: true, size: 9 };
  noteRow.getCell(1).alignment = { wrapText: true };
  sheet.mergeCells(`A${noteRow.number}:G${noteRow.number}`);
  fillRow(noteRow, 7, GREY_BG);

  // ── Timestamp row (grey background, italic) ───────────────────
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const tsText = `This estimate was created at ${dateStr} ${timeStr} UTC.`;
  const tsRow = sheet.addRow([tsText]);
  tsRow.getCell(1).font = { italic: true, size: 9 };
  sheet.mergeCells(`A${tsRow.number}:G${tsRow.number}`);
  fillRow(tsRow, 7, GREY_BG);

  await workbook.xlsx.writeFile(filePath);
  logger.success(`Exported to ${filePath}`);
}

/**
 * Fill every cell in a row with a solid background colour.
 */
function fillRow(row, colCount, argb) {
  for (let col = 1; col <= colCount; col++) {
    row.getCell(col).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb },
    };
  }
}

/**
 * Human-readable currency label for the disclaimer note.
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
