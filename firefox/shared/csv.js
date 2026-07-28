(function (root) {
  const BOM = '﻿';

  function escapeField(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\r\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function buildCsv(headers, rows) {
    const lines = [headers.map(escapeField).join(',')];
    for (const row of rows) {
      lines.push(headers.map((h) => escapeField(row[h])).join(','));
    }
    return BOM + lines.join('\r\n') + '\r\n';
  }

  const INDEX_HEADERS = [
    'מס׳ סידורי',
    'שם קובץ',
    'סוג מסמך',
    'תאריך',
    'מגיש',
    'כותרת מלאה',
    'מספר עמודים',
    'URL מקור',
    'סטטוס הורדה',
    'שגיאה',
  ];

  root.CD = root.CD || {};
  root.CD.buildCsv = buildCsv;
  root.CD.INDEX_HEADERS = INDEX_HEADERS;
})(typeof self !== 'undefined' ? self : globalThis);
