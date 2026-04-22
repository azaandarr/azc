// xlsx.js — Excel export using exceljs.
// Generates a workbook with a summary sheet containing per-resource costs
// and a totals row at the bottom. Styled with branded colours matching
// the CLI table output.

const { monthlyToAnnual } = require('../utils/currency');
const logger = require('../utils/logger');

/**
 * Export scan results to an Excel workbook.
 *
 * @param {object} params
 * @param {string} params.filePath       - Output file path
 * @param {string} params.subscription   - Subscription name
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
  workbook.creator = 'azc — Azure Costing CLI';
  workbook.created = new Date();

  // ─── Cost Estimate sheet ────────────────────────────────────────
  const sheet = workbook.addWorksheet('Cost Estimate');

  // Header metadata rows
  sheet.addRow(['Azure Cost Estimate']);
  sheet.addRow(['Subscription', subscription]);
  sheet.addRow(['Region', region]);
  sheet.addRow(['Currency', currency]);
  sheet.addRow(['Generated', new Date().toISOString().split('T')[0]]);
  sheet.addRow([]); // spacer

  // Style the title row
  const titleRow = sheet.getRow(1);
  titleRow.font = { bold: true, size: 14 };

  // Column headers for the data table
  const headerRow = sheet.addRow(['Resource', 'Type', 'SKU', 'Notes', `Monthly (${currency})`, `Annual (${currency})`]);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D2D2D' } };

  // Set column widths for readability
  sheet.columns = [
    { width: 30 }, // Resource
    { width: 45 }, // Type
    { width: 20 }, // SKU
    { width: 40 }, // Notes
    { width: 18 }, // Monthly
    { width: 18 }, // Annual
  ];

  // Data rows — one per priced resource
  let totalMonthly = 0;
  for (const r of resources) {
    const monthly = Math.round(r.monthlyCost * 100) / 100;
    const annual = Math.round(monthlyToAnnual(r.monthlyCost) * 100) / 100;

    if (!r.usageBased) totalMonthly += r.monthlyCost;

    const row = sheet.addRow([
      r.name,
      r.type,
      r.sku || '—',
      r.notes || '',
      monthly,
      annual,
    ]);

    // Format currency columns
    row.getCell(5).numFmt = '#,##0.00';
    row.getCell(6).numFmt = '#,##0.00';

    // Colour usage-based resources in grey to indicate they're estimates
    if (r.usageBased) {
      row.font = { italic: true, color: { argb: 'FF888888' } };
    }
  }

  // Total row
  sheet.addRow([]); // spacer
  const totalRow = sheet.addRow([
    'TOTAL',
    '',
    '',
    '',
    Math.round(totalMonthly * 100) / 100,
    Math.round(monthlyToAnnual(totalMonthly) * 100) / 100,
  ]);
  totalRow.font = { bold: true };
  totalRow.getCell(5).numFmt = '#,##0.00';
  totalRow.getCell(6).numFmt = '#,##0.00';

  // ─── Unpriced resources section ─────────────────────────────────
  if (unpriced && unpriced.length > 0) {
    sheet.addRow([]);
    const unpricedHeader = sheet.addRow(['Unpriced Resources', '', '', 'Reason']);
    unpricedHeader.font = { bold: true, color: { argb: 'FFFF7043' } };

    for (const r of unpriced) {
      sheet.addRow([r.name, r.type, '', r.reason || 'Price not found']);
    }
  }

  // ─── Unsupported resources section ──────────────────────────────
  if (unsupported && unsupported.length > 0) {
    sheet.addRow([]);
    const unsupportedHeader = sheet.addRow(['Unsupported Resources (not yet mapped)']);
    unsupportedHeader.font = { bold: true, color: { argb: 'FF888888' } };

    for (const r of unsupported) {
      sheet.addRow([r.name, r.type]);
    }
  }

  // Write the workbook to disk
  await workbook.xlsx.writeFile(filePath);
  logger.success(`Exported to ${filePath}`);
}

module.exports = { exportToXlsx };
