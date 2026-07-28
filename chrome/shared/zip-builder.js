(function (root) {
  const FILENAME_SANITIZE_RE = root.CD.FILENAME_SANITIZE_RE;

  function sanitizeFilename(name, maxLen) {
    if (maxLen == null) maxLen = 80;
    return String(name == null ? '' : name)
      .replace(FILENAME_SANITIZE_RE, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  function buildPdfFilename(opts) {
    const pad = String(opts.ordinal).padStart(3, '0');
    const short = sanitizeFilename(opts.title || '', 60);
    const t = sanitizeFilename(opts.docType || 'מסמך', 20);
    const d = sanitizeFilename(opts.date || '', 12);
    return pad + '_' + t + '_' + d + '_' + short + '.pdf';
  }

  async function assembleZip(JSZip, opts) {
    const zip = new JSZip();
    zip.file('index.csv', opts.indexCsv);
    for (const item of opts.pdfs) {
      if (item.bytes) zip.file(item.filename, item.bytes);
    }
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    return { blob: blob, filename: sanitizeFilename(opts.zipBaseName, 120) + '.zip' };
  }

  root.CD = root.CD || {};
  root.CD.sanitizeFilename = sanitizeFilename;
  root.CD.buildPdfFilename = buildPdfFilename;
  root.CD.assembleZip = assembleZip;
})(typeof self !== 'undefined' ? self : globalThis);
