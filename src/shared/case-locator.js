// Parses a free-form Israeli court case identifier ("מספר תיק") that the user
// pastes into the quick-open field, and normalizes it into the parts Net
// HaMishpat's "איתור תיק" locator expects: a serial number and a month+year.
//
// Accepts flexible separators (-, /, ., \, whitespace) and 2- or 4-digit years,
// with an optional leading case-type prefix, e.g. all of these parse the same:
//   39163-07-22   39163/07/2022   39163 7 22   39163.07.22   ת"א 39163-07-22
// Returns null when the text doesn't contain a serial + month(1-12) + year.
//
// Also carries the closed list of "תיק מקור" (source-case) types that the
// portal's own external-case search screen offers — see EXTERNAL_CASE_TYPES.
(function (root) {
  const SEP = '[\\s./\\\\-]';
  // serial · sep · month(1-2) · sep · year(2 or 4). Anchored so the year isn't
  // followed by a further digit (avoids swallowing 3-digit noise).
  const RE = new RegExp(
    '(\\d{1,7})\\s*' + SEP + '\\s*(\\d{1,2})\\s*' + SEP + '\\s*(\\d{4}|\\d{2})(?!\\d)'
  );

  function parseCaseLocator(raw) {
    if (raw == null) return null;
    const m = String(raw).match(RE);
    if (!m) return null;
    const serial = m[1].replace(/^0+(?=\d)/, ''); // trim accidental leading zeros
    const monthNum = parseInt(m[2], 10);
    if (!(monthNum >= 1 && monthNum <= 12)) return null;
    const month = String(monthNum).padStart(2, '0');
    let year2, year4;
    if (m[3].length === 4) {
      year4 = m[3];
      year2 = m[3].slice(2);
    } else {
      year2 = m[3].padStart(2, '0');
      year4 = '20' + year2; // e-court cases are modern; 2-digit year → 20xx
    }
    return {
      serial: serial,
      month: month,
      year2: year2,
      year4: year4,
      // Canonical Net HaMishpat form: SERIAL-MM-YY.
      canonical: serial + '-' + month + '-' + year2,
    };
  }

  // ── "תיק מקור" (source / external case) types ─────────────────────────────
  // The closed list behind the site's own screen איתור תיקים → "תיקים לפי מס'
  // תיק מקור" (SearchCase/CasesSearchExternalView.aspx). `id` is the site's own
  // option value in #ExternalCaseTypeIDDropDown — captured live from the portal;
  // `label` is the caption, kept as the fallback match in case the site ever
  // renumbers the values. Order mirrors the site's own dropdown.
  const EXTERNAL_CASE_TYPES = Object.freeze([
    { id: '11', label: 'בית דין מנהלי לתעבורה' },
    { id: '7',  label: 'דו"ח עירייה' },
    { id: '1',  label: 'דו"ח תעבורה' },
    { id: '10', label: 'הודעת קנס' },
    { id: '6',  label: 'כונס הנכסים הרשמי' },
    { id: '8',  label: 'עמ"ק ישן' },
    { id: '9',  label: 'עניינים מקומיים' },
    { id: '3',  label: 'תיק הוצל"פ' },
    { id: '2',  label: 'תיק משטרתי (פל"א)' },
  ].map(Object.freeze));

  // Look a type up by its id (or by its exact label). Returns null when unknown —
  // callers treat that as "no source-case type chosen".
  function externalCaseType(idOrLabel) {
    if (idOrLabel == null || idOrLabel === '') return null;
    const key = String(idOrLabel).trim();
    return EXTERNAL_CASE_TYPES.find((t) => t.id === key || t.label === key) || null;
  }

  root.CD = root.CD || {};
  root.CD.parseCaseLocator = parseCaseLocator;
  root.CD.EXTERNAL_CASE_TYPES = EXTERNAL_CASE_TYPES;
  root.CD.externalCaseType = externalCaseType;
})(typeof self !== 'undefined' ? self : globalThis);
