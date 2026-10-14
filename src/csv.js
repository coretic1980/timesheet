// CSV voor Nederlandse Excel: puntkomma als scheidingsteken, decimale komma, UTF-8 met BOM.
function cell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  // Tekst die met = + - @ begint, zou Excel als formule uitvoeren: neutraliseren.
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, header, rows) {
  const lines = rows.map((r) => r.map(cell).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${header.join(';')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`);
}

module.exports = { cell, sendCsv };
