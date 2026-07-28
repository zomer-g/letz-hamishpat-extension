// Net HaMishpat (securesso.court.gov.il/Ngcs.Web.Secured/*) adapter.
//
// Confirmed by live inspection (case 80819-05-26, 2026-06-02):
//
//   • Each folder list page (DecisionList.aspx / PleadingList.aspx /
//     MotionList.aspx / ProtocolList.aspx / JudgmentList.aspx / …) uses
//     AG-Grid + an ASP.NET hidden input named <GridId>ArrayStore that holds
//     the FULL JSON array of items in that folder (across all "pages" — the
//     grid pages client-side).
//
//   • Every row has a native checkbox in the rightmost "הורדה" column. The
//     site uses it for its own per-page "הורדת מסמכי Word" button.
//
//   • Bulk download path:
//        __EVENTTARGET = _ctl0:btnDownloadWordDocs
//        _ctl0:documentListIDs            = "id1,id2,…"
//        _ctl0:decisionSignatureDateIDs   = "dd/mm/yyyy,dd/mm/yyyy,…"
//     Server streams back a Word/ZIP file via Content-Disposition: attachment.
//
// Strategy: auto-discover the store + auto-discover field names, so this
// adapter works on every folder type without per-folder hardcoding.

(function (root) {
  const CD = root.CD || (root.CD = {});
  try { document.documentElement.setAttribute('data-cd-adapter', '1'); } catch (e) {}
  const DEBUG_PREFIX = '[net-court-adapter]';
  function dbg() {
    try { console.log.apply(console, [DEBUG_PREFIX].concat(Array.from(arguments))); } catch (e) {}
  }

  // ---------- folder-type label inferred from URL path ----------
  // The folder name appears as the path segment before the *List.aspx file.
  const URL_LABEL = {
    decision: 'החלטות',
    decisions: 'החלטות',
    judgment: 'פסקי דין',
    judgments: 'פסקי דין',
    verdict: 'פסקי דין',
    verdicts: 'פסקי דין',
    pleading: 'כתבי טענות',
    pleadings: 'כתבי טענות',
    motion: 'בקשות',
    motions: 'בקשות',
    request: 'בקשות',
    requests: 'בקשות',
    protocol: 'פרוטוקולים',
    protocols: 'פרוטוקולים',
    decree: 'תזכירים',
    decrees: 'תזכירים',
    affidavit: 'תצהירים',
    affidavits: 'תצהירים',
    opinion: 'חוות דעת',
    opinions: 'חוות דעת',
    exhibit: 'מוצגים',
    exhibits: 'מוצגים',
    summary: 'סיכומים',
    summaries: 'סיכומים',
  };

  // Prefer the page's own folder heading (document.title) — it reflects the
  // real folder name and distinguishes pages that share a URL (e.g. תצהירים
  // and תיק נייר both live on PresentDocument.aspx). Fall back to the URL map.
  function folderLabel(doc, href) {
    let t = (doc && doc.title ? doc.title : '').trim();
    t = t.replace(/^תיקית\s+/, '').replace(/\s*[-–|]\s*נט המשפט.*$/, '').trim();
    if (t && /[֐-׿]/.test(t) && t.length <= 40) return t;
    const m = (href || '').match(/\/Ngcs\.Web\.Secured\/([^/]+)\/[A-Za-z]+\.aspx/i);
    if (!m) return 'מסמכים';
    const seg = m[1].toLowerCase().replace(/^folder/, '');
    return URL_LABEL[seg] || URL_LABEL[seg.replace(/s$/, '')] || 'מסמכים';
  }

  // ---------- auto-discover the ArrayStore hidden input ----------
  // Looks for hidden inputs whose name ends in "ArrayStore" and whose value
  // parses to a JSON array containing a DocumentID-like field.
  function findArrayStore(doc) {
    const candidates = Array.from(doc.querySelectorAll('input[type="hidden"][name$="ArrayStore"], input[type="hidden"][name*="Grid"]'));
    for (const input of candidates) {
      if (!input.value) continue;
      try {
        const arr = JSON.parse(input.value);
        if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object' && arr[0]) {
          const keys = Object.keys(arr[0]);
          if (keys.some((k) => /^DocumentID$/i.test(k))) {
            return { name: input.name, data: arr, sampleKeys: keys };
          }
        }
      } catch (e) {}
    }
    return null;
  }

  // ---------- auto-pick fields from the first row's keys ----------
  function pickField(keys, patterns) {
    for (const p of patterns) {
      const found = keys.find((k) => p.test(k));
      if (found) return found;
    }
    return null;
  }

  function buildFieldMap(sampleKeys) {
    return {
      idField: pickField(sampleKeys, [/^DocumentID$/i]),
      titleField: pickField(sampleKeys, [/DisplayName$/i, /Name$/i, /Title$/i, /Description$/i]),
      dateField: pickField(sampleKeys, [/SignatureDate$/i, /SubmissionDate$/i, /CreatedDate$/i, /Date$/i]),
      signerField: pickField(sampleKeys, [/SignatureUserName$/i, /SubmittedBy$/i, /UserName$/i, /CreatedBy$/i, /JudgeName$/i]),
      idcField: pickField(sampleKeys, [/IsIDCPublished$/i, /IsIDC/i]),
    };
  }

  // ---------- find the AG-Grid container for this list ----------
  function findGridRoot(doc) {
    // Prefer the grid whose id matches *Grid (the page convention).
    const named = doc.querySelector('[id$="Grid"].ag-root-wrapper, [id$="Grid"] .ag-root-wrapper, .ag-root-wrapper');
    if (named) return named.closest('[id$="Grid"]') || named.parentElement || named;
    return doc.querySelector('[role="grid"]') || null;
  }

  function findRowEls(gridRoot) {
    if (!gridRoot) return [];
    return Array.from(gridRoot.querySelectorAll('.ag-center-cols-container [role="row"][row-index]'));
  }

  // ---------- discover the btnDocument argument formula ----------
  // Each folder page builds the document-open postback differently inside its
  // AG-Grid cell renderer, e.g.:
  //   Decisions:  __doPostBack("_ctl0:btnDocument", params.data.DocumentID + "&1")
  //   Motions:    __doPostBack("_ctl0:btnDocument", params.data.EntityID)
  // We read the page's own renderer source so the argument adapts to ANY
  // folder: capture the first data field referenced after the btnDocument
  // target, plus an optional trailing string literal ("&1").
  function extractArgSpec(doc) {
    try {
      const html = doc.documentElement.innerHTML;
      // Renderer shapes seen:
      //   Decisions: __doPostBack("_ctl0:btnDocument","' + params.data.DocumentID + '&1")
      //   Motions:   __doPostBack("_ctl0:btnDocument","' + params.data.EntityID + '")
      // Capture the data field, plus an optional trailing "&…" literal (the
      // ")" that closes the call is NOT part of the argument, so the literal
      // is constrained to start with "&").
      const re = /btnDocument[\\"']+\s*,\s*[\\"']*\s*\+\s*(?:params\.)?data\.(\w+)(?:\s*\+\s*[\\"']+(&[^"'\\)]*))?/i;
      const m = html.match(re);
      if (m) return { field: m[1], literal: m[2] || '' };
    } catch (e) {}
    return null;
  }

  function computePostbackArg(raw, argSpec, fields) {
    if (argSpec && argSpec.field && raw[argSpec.field] != null) {
      return String(raw[argSpec.field]) + (argSpec.literal || '');
    }
    // Fallback: the original Decisions shape.
    const id = raw[fields.idField] || raw.DocumentID || '';
    return String(id) + '&' + (raw.IsIDCPublished ? '1' : '0');
  }

  // ---------- derive the postback-argument template from rendered anchors ----------
  // The browser already built the correct __doPostBack argument inside each
  // visible row's <a href>. We sample several of them and, column by column,
  // map each token to the store field whose value-set covers it (a token that
  // is constant across samples AND matches no field is a literal, e.g. "1").
  // This adapts to ANY folder's argument shape:
  //   Decisions {DocumentID}&1 · Motions {EntityID} · Plea {CaseID}&{DocumentID}
  // Read the browser-rendered document anchors: both the postback TARGET and
  // the ARGUMENT (the browser already concatenated the argument correctly).
  function renderedPostbacks(doc) {
    const grid = findGridRoot(doc);
    if (!grid) return { target: '', args: [] };
    const out = [];
    let target = '';
    grid.querySelectorAll('.ag-center-cols-container a[href*="btnDocument"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/__doPostBack\(['"]([^'"]+)['"]\s*,\s*['"]([^'")]+)['"]/);
      if (m) { target = m[1]; out.push(m[2]); }
    });
    return { target: target, args: out };
  }

  function deriveArgTemplate(doc, rows) {
    const args = renderedPostbacks(doc).args;
    if (!args.length || !rows || !rows.length) return null;
    const toks = args.map((a) => a.split(/([^0-9A-Za-z]+)/).filter((s) => s !== ''));
    const n = toks[0].length;
    if (!toks.every((t) => t.length === n)) return null;
    const keys = Object.keys(rows[0]);
    const tmpl = [];
    for (let j = 0; j < n; j++) {
      const col = toks.map((t) => t[j]);
      if (col.every((c) => /^[^0-9A-Za-z]+$/.test(c))) { tmpl.push({ sep: col[0] }); continue; }
      const vals = new Set(col);
      const field = keys.find((k) => {
        const fs = new Set(rows.map((r) => String(r[k])));
        for (const v of vals) if (!fs.has(v)) return false;
        return true;
      });
      if (field) tmpl.push({ field: field });
      else tmpl.push({ lit: col[0] });
    }
    return tmpl;
  }

  function applyArgTemplate(tmpl, raw) {
    return tmpl.map((t) => (t.sep !== undefined ? t.sep : (t.field !== undefined ? String(raw[t.field]) : t.lit))).join('');
  }

  // ---------- map a raw JSON row to our normalized item ----------
  function toItem(raw, idx, fields, label, argSpec, argTemplate, eventTarget) {
    const postbackArg = argTemplate
      ? applyArgTemplate(argTemplate, raw)
      : computePostbackArg(raw, argSpec, fields);
    return {
      ordinal: idx + 1,
      docId: String(raw[fields.idField] || raw.DocumentID || ''),
      title: String(raw[fields.titleField] || ''),
      date: String(raw[fields.dateField] || ''),
      submittedBy: String(raw[fields.signerField] || ''),
      docType: label,
      pages: null,
      _isIdcPublished: fields.idcField ? !!raw[fields.idcField] : false,
      postbackArg: postbackArg,
      postbackTarget: eventTarget || '_ctl0:btnDocument',
      _raw: raw,
    };
  }

  // ---------- pull caseId from the case-locator header (best-effort) ----------
  function readCaseId(doc) {
    const RE = /\b(\d{4,8}-\d{2}-\d{2})\b/;
    // 1) Prefer the case-locator banner / header — most reliable.
    const sel = '[id*="CaseLocator"], [id*="CaseHeader"], [id*="lblCase"], [class*="CaseLocator"], .CaseHeader, h1, h2';
    try {
      const nodes = doc.querySelectorAll(sel);
      for (const n of nodes) {
        const m = (n.textContent || '').match(RE);
        if (m) return m[1];
      }
    } catch (e) {}
    // 2) Pull from the store rows if they carry a display identifier.
    try {
      const store = findArrayStore(doc);
      if (store && store.data && store.data[0]) {
        for (const k of Object.keys(store.data[0])) {
          if (/CaseDisplay|CaseNumber|TikNumber|Identifier/i.test(k)) {
            const m = String(store.data[0][k] || '').match(RE);
            if (m) return m[1];
          }
        }
      }
    } catch (e) {}
    // 3) Fallback: full body text (NOT capped — the page starts with a long
    //    accessibility preamble that would otherwise push the banner past a cap).
    const t = (doc.body && doc.body.textContent) || '';
    const m = t.match(RE);
    return m ? m[1] : '';
  }

  // ---------- post body assembly ----------
  function buildPostBody(doc, eventTarget, eventArgument, extra) {
    const form = doc.forms[0];
    const body = new URLSearchParams();
    if (form) {
      form.querySelectorAll('input[type=hidden]').forEach((inp) => {
        body.append(inp.name, inp.value || '');
      });
    }
    body.set('__EVENTTARGET', eventTarget);
    body.set('__EVENTARGUMENT', eventArgument || '');
    if (extra) {
      for (const k of Object.keys(extra)) body.set(k, extra[k]);
    }
    return body.toString();
  }

  // ---------- find the native הורדה checkbox for a given row ----------
  // The native checkbox is rendered by AG-Grid in the rightmost data column.
  // We locate it by finding the only checkbox input inside the row.
  function nativeCheckboxIn(rowEl) {
    return rowEl.querySelector('input[type="checkbox"]');
  }

  // ---------- public adapter ----------
  const adapter = {
    name: 'net-court',

    matches(location, doc) {
      // Any aspx page inside the Secured area — refine via field presence.
      if (!/^https:\/\/securesso\.court\.gov\.il\/Ngcs\.Web\.Secured\/.*\.aspx/i.test(location.href)) {
        return false;
      }
      // Skip obvious non-list pages.
      if (/(LawyerHomePage|CaseDetails|HomePage)\.aspx/i.test(location.href)) return false;
      const store = findArrayStore(doc);
      const grid = findGridRoot(doc);
      const ok = !!(store && grid);
      if (!ok) dbg('matches: store?', !!store, 'grid?', !!grid);
      return ok;
    },

    // Cached on first read so DOM-mutation re-runs don't re-discover.
    _discover(doc) {
      const store = findArrayStore(doc);
      if (!store) return null;
      const fields = buildFieldMap(store.sampleKeys);
      const label = folderLabel(doc, doc.location ? doc.location.href : location.href);
      const eventTarget = renderedPostbacks(doc).target || '_ctl0:btnDocument';
      const argTemplate = deriveArgTemplate(doc, store.data);
      const argSpec = argTemplate ? null : extractArgSpec(doc);
      return { store: store, fields: fields, label: label, argSpec: argSpec, argTemplate: argTemplate, eventTarget: eventTarget };
    },

    listAllItems(doc) {
      const d = this._discover(doc);
      if (!d) return [];
      return d.store.data.map((raw, i) => toItem(raw, i, d.fields, d.label, d.argSpec, d.argTemplate, d.eventTarget));
    },

    // For each visible AG-Grid row, return:
    //   - the row element
    //   - the native הורדה checkbox inside it (or null)
    //   - the matching item by rowIndex
    visibleRows(doc) {
      const grid = findGridRoot(doc);
      if (!grid) return [];
      const rowEls = findRowEls(grid);
      const items = this.listAllItems(doc);
      return rowEls.map((el) => {
        const rowIndex = parseInt(el.getAttribute('row-index'), 10);
        return {
          el: el,
          rowIndex: rowIndex,
          item: items[rowIndex] || null,
          nativeCheckbox: nativeCheckboxIn(el),
        };
      });
    },

    // Per-document postback (used when no native bulk button exists, e.g.
    // Motions/Pleadings). Server may return a file (for user-uploaded docs)
    // or an HTML wrapper for the Olive viewer (for IDC-published court docs).
    // The SW classifies the response.
    getDownloadRequest(item, doc) {
      const flag = item._isIdcPublished ? '1' : '0';
      const argument = String(item.docId) + '&' + flag;
      const body = buildPostBody(doc, '_ctl0:btnDocument', argument);
      return {
        method: 'POST',
        url: doc.forms[0] ? doc.forms[0].action : doc.location.href,
        body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      };
    },

    // Bulk-download via the official "הורדת מסמכי Word" postback.
    getNativeBulkRequest(items, doc) {
      const ids = items.map((it) => String(it.docId)).join(',');
      const dates = items.map((it) => String(it.date || '')).join(',');
      const body = buildPostBody(doc, '_ctl0:btnDownloadWordDocs', '', {
        '_ctl0:documentListIDs': ids,
        '_ctl0:decisionSignatureDateIDs': dates,
      });
      return {
        method: 'POST',
        url: doc.forms[0] ? doc.forms[0].action : doc.location.href,
        body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        isBulk: true,
      };
    },

    readCaseId: readCaseId,

    // dev helper — call from page console: window.CD.adapters['net-court']._debug()
    _debug() {
      const d = this._discover(document);
      const items = this.listAllItems(document);
      dbg('=== DEBUG ===');
      dbg('store name:', d && d.store.name);
      dbg('fields:', d && d.fields);
      dbg('label:', d && d.label);
      dbg('total items:', items.length);
      items.slice(0, 5).forEach((it, i) => dbg(i, it.docId, it.date, it.title.slice(0, 40), '| signer:', it.submittedBy));
      dbg('visible rows:', this.visibleRows(document).length);
      return { discovered: d, items: items };
    },
  };

  CD.adapters = CD.adapters || {};
  CD.adapters['net-court'] = adapter;
})(typeof window !== 'undefined' ? window : self);
