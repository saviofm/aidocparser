'use strict';
const ExcelJS = require('exceljs');

/**
 * Parse Excel: cada aba vira uma seção markdown com tabela.
 */
async function parseExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sections = [];

  workbook.eachSheet(sheet => {
    const rows = [];
    let headers = null;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values.slice(1).map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && v.result !== undefined) return String(v.result); // fórmula → valor calculado
        if (typeof v === 'object' && v.text) return v.text; // rich text
        return String(v);
      });

      if (rowNumber === 1) {
        headers = values;
      } else {
        rows.push(values);
      }
    });

    if (!headers) return;

    const sep = headers.map(() => '---');
    const mdRows = [
      `| ${headers.join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...rows.map(r => `| ${r.join(' | ')} |`),
    ];

    sections.push(`## Aba: ${sheet.name}\n\n${mdRows.join('\n')}`);
  });

  return {
    parsedText: sections.join('\n\n---\n\n'),
    pageCount: workbook.worksheets.length,
    type: 'excel',
    hasOcr: false,
    tokensUsed: 0,
  };
}

module.exports = { parseExcel };
