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
  // Like pickField but skips keys matching `excludeRe` (e.g. party fields).
  function pickFieldExcept(keys, patterns, excludeRe) {
    for (const p of patterns) {
      const found = keys.find((k) => p.test(k) && !(excludeRe && excludeRe.test(k)));
      if (found) return found;
    }
    return null;
  }

  function buildFieldMap(sampleKeys) {
    // Never let a party/side field become the document title. On the תיק נייר
    // (PresentDocument) grid the key "CasePartyDisplayName" holds "עותר 1" /
    // "מבקש 1" and ends in DisplayName — so without this exclusion it would be
    // picked as the title. We want the document's own description/type.
    const NOT_PARTY = /Party|Side|Submitter/i;
    return {
      idField: pickField(sampleKeys, [/^DocumentID$/i]),
      titleField: pickFieldExcept(sampleKeys,
        [/^DocumentDesc$/i, /Desc$/i, /^DocumentName$/i, /Subject$/i, /DisplayName$/i, /Name$/i, /Title$/i, /Description$/i],
        NOT_PARTY),
      // Per-document type ("עתירה", "החלטה", "אישור על הגשת מסמך", …) — used as
      // a title fallback and to default-exclude administrative confirmations.
      typeField: pickField(sampleKeys, [/^DocumentType$/i, /DocumentType$/i, /^Type$/i, /TypeName$/i]),
      dateField: pickField(sampleKeys, [/SignatureDate$/i, /SubmissionDate$/i, /PresentationDate$/i, /CreatedDate$/i, /Date$/i]),
      // The submitting party / signer — kept in the CSV "גורם" column.
      signerField: pickField(sampleKeys, [/SignatureUserName$/i, /SubmittedBy$/i, /UserName$/i, /CreatedBy$/i, /JudgeName$/i, /CasePartyDisplayName$/i, /PartyDisplayName$/i, /Party.*Name$/i]),
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
      // Document name = its description, falling back to its type — never the
      // submitting party (which now lives in submittedBy / the "גורם" column).
      title: String((fields.titleField && raw[fields.titleField]) || (fields.typeField && raw[fields.typeField]) || ''),
      // The per-document type ("עתירה", "אישור על הגשת מסמך", …) for filtering.
      docKind: String((fields.typeField && raw[fields.typeField]) || ''),
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
  // True when a node lives inside the extension's OWN injected UI (its ids/classes
  // are all `cd-…`, or the floating window `#cd-float`). readCaseId MUST skip
  // these: the favorites panel, quick-locate strip and judge chip all render
  // OTHER case numbers into the page, which would otherwise poison the body-text
  // fallback and make us mistake a favorite/recent case for the open one.
  function inExtUI(el) {
    for (let n = el; n; n = n.parentElement) {
      const id = n.id || '';
      const cls = typeof n.className === 'string' ? n.className : ((n.className && n.className.baseVal) || '');
      if (id === 'cd-float' || id.indexOf('cd-') === 0 || /(^|\s)cd-/.test(cls)) return true;
    }
    return false;
  }

  function readCaseId(doc) {
    const RE = /\b(\d{4,8}-\d{2}-\d{2})\b/;
    const wd = doc || document;
    // Walk the TEXT NODES under `root`, skipping the extension's OWN injected UI,
    // and return the first case number. This must exclude cd-* nodes even when
    // they are DESCENDANTS of a matched header container: in inline mode our
    // favorites / quick-locate panels are nested inside the site's header cell,
    // so reading that cell's whole textContent would otherwise leak a FAVORITE's
    // number and pass it off as the open case (adding a 2nd favorite then removed
    // the 1st). Per-text-node filtering is the only correct way to scope this.
    function scan(root) {
      if (!root || inExtUI(root)) return null;
      try {
        const walk = (root.ownerDocument || wd).createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walk.nextNode())) {
          if (inExtUI(node.parentElement)) continue;
          const m = (node.textContent || '').match(RE);
          if (m) return m[1];
        }
      } catch (e) {}
      return null;
    }
    // 1) Prefer the case-locator banner / header — most reliable.
    try {
      const sel = '[id*="CaseLocator"], [id*="CaseHeader"], [id*="lblCase"], [class*="CaseLocator"], .CaseHeader, h1, h2';
      const nodes = wd.querySelectorAll(sel);
      for (const n of nodes) { const hit = scan(n); if (hit) return hit; }
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
    // 3) Fallback: the whole body (still per-node, still skipping our injected UI).
    const hit = scan(wd.body);
    if (hit) return hit;
    return '';
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
    // The site's own checkbox — never our injected .cd-row-cb.
    return rowEl.querySelector('input[type="checkbox"]:not(.cd-row-cb)');
  }

  // ---------- native "הורדת מסמכי Word" (DOC) discovery ----------
  // Normalize a date to dd/mm/yyyy (the format the bulk-Word field expects).
  function normDmy(s) {
    s = String(s == null ? '' : s).trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return ('0' + m[1]).slice(-2) + '/' + ('0' + m[2]).slice(-2) + '/' + m[3];
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3] + '/' + m[2] + '/' + m[1];
    return s;
  }
  // Resolve the real ASP.NET name of a bulk field/button (the _ctl0 prefix can
  // vary), falling back to the documented default.
  function bulkFieldName(doc, suffix, fallback) {
    const inp = doc.querySelector('input[name$="' + suffix + '"], input[id$="' + suffix + '"]');
    return (inp && inp.name) || fallback;
  }
  function wordButtonTarget(doc) {
    const els = doc.querySelectorAll('[id*="btnDownloadWordDocs"], [name*="btnDownloadWordDocs"], [onclick*="btnDownloadWordDocs"], [href*="btnDownloadWordDocs"]');
    for (const el of els) {
      if (el.name && /btnDownloadWordDocs/i.test(el.name)) return el.name;
      const src = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
      const m = src.match(/__doPostBack\(['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
    return '_ctl0:btnDownloadWordDocs';
  }
  // Does this screen offer the native Word download? Decisions / judgments /
  // protocols do (confirmed by the btnDownloadWordDocs control / its hidden
  // field / the folder label).
  function supportsWord(doc) {
    if (doc.querySelector('[id*="btnDownloadWordDocs"], [name*="btnDownloadWordDocs"], input[name$="documentListIDs"], input[id$="documentListIDs"]')) return true;
    const els = doc.querySelectorAll('a,button,input[type="button"],input[type="submit"]');
    for (const b of els) { const t = (b.textContent || b.value || ''); if (/מסמכי\s*Word|הורדת מסמכים שסומנו/i.test(t)) return true; }
    const lbl = folderLabel(doc, (doc.location && doc.location.href) || location.href);
    return ['החלטות', 'פסקי דין', 'פרוטוקולים'].indexOf(lbl) !== -1;
  }

  // ---------- protocols screen (ProtocolFileViewer.aspx) ----------
  // This screen is special: each row carries a פרוטוקול document AND, when it
  // exists, a תמליל (transcript) — each with its OWN download postback embedded
  // in the cell's <img onclick="__doPostBack(target,arg)"> (the ids live in the
  // rendered row, not in the ArrayStore). We surface both as separate items.
  function isProtocolScreen(doc) {
    const href = (doc.location && doc.location.href) || location.href;
    if (/ProtocolFileViewer/i.test(href)) return true;
    if (doc.querySelector('input[type=hidden][name*="CaseProtocolGrid"]')) return true;
    return !!doc.querySelector('[col-id="ProtocolDocument"], [col-id="TranscriptionlDocument"]');
  }
  function cellText(rowEl, colId) {
    const c = rowEl.querySelector('[col-id="' + colId + '"]');
    return c ? (c.textContent || '').trim() : '';
  }
  function imgPostbackIn(cell) {
    const img = cell && cell.querySelector('img[onclick]');
    if (!img) return null;
    const m = (img.getAttribute('onclick') || '').match(/__doPostBack\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    return m ? { target: m[1], arg: m[2] } : null;
  }
  // The native protocol checkbox carries the id the Word bulk field expects —
  // onProtocolDocumentSelectionChanged(checked, DocumentID) /
  // onTranscriptionlDocumentSelectionChanged(checked, TranscriptionOrderDocumentID).
  // That id is DIFFERENT from the viewer postback arg (pb.arg) used for PDF.
  function cbArgIn(cell) {
    const cb = cell && cell.querySelector('input[type="checkbox"]:not(.cd-row-cb)');
    if (!cb) return null;
    const m = (cb.getAttribute('onclick') || '').match(/,\s*(\d+)\s*\)/);
    return m ? m[1] : null;
  }
  function mkProtocolItem(kind, pb, date, pages, wordId) {
    const label = kind === 'transcript' ? 'תמליל' : 'פרוטוקול';
    return {
      docId: (kind === 'transcript' ? 'T_' : 'P_') + (wordId != null && wordId !== '' ? wordId : pb.arg),
      // The native Word field wants DocumentID (protocol) /
      // TranscriptionOrderDocumentID (transcript), formatted as "id&dd/mm/yyyy".
      wordId: wordId || pb.arg,
      wordKind: kind,                 // 'protocol' | 'transcript'
      title: label + ' ' + date + (pages ? ' (עמ׳ ' + pages.replace(/\s+/g, '') + ')' : ''),
      date: date,
      submittedBy: '',
      docType: label,
      pages: null,
      _isIdcPublished: true,          // protocols are IDC-published court docs
      postbackArg: pb.arg,
      postbackTarget: pb.target,
      _raw: {},
    };
  }
  // The protocol grid is CLIENT-side paginated: the full dataset (all rows)
  // lives in the <…CaseProtocolGridArrayStore> hidden input, but only the
  // current page (~15 rows) is rendered. So "select all" must read the STORE
  // (all rows), not just the rendered DOM. The store has each row's DocumentID
  // (the Word-bulk id) but NOT the per-row viewer postback arg the PDF path
  // needs — that lives only in the rendered <img onclick>. We cache the
  // DocumentID↔viewerArg link as rows render, so docIds stay keyed by
  // DocumentID (matching the store) and store items can recover the viewer arg.
  let _protIdByViewerArg = {}; // viewerArg -> DocumentID (string)
  let _protViewerByDocId = {}; // 'P_'/'T_' + id -> { postbackArg, postbackTarget }

  function protocolStoreRows(doc) {
    const inp = doc.querySelector('input[type=hidden][name$="CaseProtocolGridArrayStore"]')
      || doc.querySelector('input[type=hidden][name*="Protocol"][name$="ArrayStore"]');
    if (!inp || !inp.value) return [];
    try { const d = JSON.parse(inp.value); return Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : []); }
    catch (e) { return []; }
  }

  function mkProtocolStoreItem(kind, row) {
    const id = kind === 'transcript' ? row.TranscriptionOrderDocumentID : row.DocumentID;
    const date = row.SittingDateString || '';
    const pages = String(row.Pages || '').replace(/\s+/g, '');
    const label = kind === 'transcript' ? 'תמליל' : 'פרוטוקול';
    return {
      docId: (kind === 'transcript' ? 'T_' : 'P_') + id,
      wordId: id,
      wordKind: kind,
      title: label + ' ' + date + (pages ? ' (עמ׳ ' + pages + ')' : ''),
      date: date,
      submittedBy: '',
      docType: label,
      pages: null,
      _isIdcPublished: true,
      // The viewer postback for a protocol/transcript is __doPostBack(
      // '_ctl0:btnDocument', <DocumentID>) — i.e. the viewer arg IS the
      // DocumentID. Seed it here so the PDF (per-item) path works for EVERY row,
      // not just the rendered ones (whose arg we'd otherwise read from the DOM).
      postbackArg: String(id),
      postbackTarget: '_ctl0:btnDocument',
      _raw: row,
    };
  }

  // Returns [{ el, cell, rowIndex, hideNative, item }] for protocols/transcripts
  // in the CURRENTLY RENDERED rows (used for checkbox injection). Also refreshes
  // the DocumentID↔viewerArg caches so store items can recover the PDF arg.
  function protocolEntries(doc) {
    const grid = findGridRoot(doc);
    if (!grid) return [];
    const out = [];
    for (const el of findRowEls(grid)) {
      const rowIndex = parseInt(el.getAttribute('row-index'), 10);
      const date = cellText(el, 'SittingDateString');
      const pages = cellText(el, 'Pages');
      for (const pair of [['ProtocolDocument', 'protocol'], ['TranscriptionlDocument', 'transcript']]) {
        const cell = el.querySelector('[col-id="' + pair[0] + '"]');
        const pb = imgPostbackIn(cell);
        if (!pb) continue;
        let id = cbArgIn(cell);
        if (id != null && id !== '') _protIdByViewerArg[pb.arg] = String(id);
        else id = _protIdByViewerArg[pb.arg] != null ? _protIdByViewerArg[pb.arg] : null;
        const item = mkProtocolItem(pair[1], pb, date, pages, id);
        _protViewerByDocId[item.docId] = { postbackArg: pb.arg, postbackTarget: pb.target };
        out.push({ el: el, cell: cell, rowIndex: rowIndex, hideNative: true, item: item });
      }
    }
    return out;
  }

  // ---------- public adapter ----------
  const adapter = {
    name: 'net-court',
    isProtocolScreen: function (doc) { return isProtocolScreen(doc || document); },

    matches(location, doc) {
      // Any .aspx page in the NGCS app — on the authenticated portal
      // (securesso.court.gov.il/Ngcs.Web.Secured) OR the PUBLIC portal
      // (www.court.gov.il/ngcs.web.site), so reviewers can test without a login.
      // Refined below via field presence (an ArrayStore + grid must exist).
      if (!/^https:\/\/(secure(sso)?\.court\.gov\.il\/ngcs\.web\.secured|(?:www\.)?court\.gov\.il\/ngcs\.web\.site)\/.*\.aspx/i.test(location.href)) {
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
      if (isProtocolScreen(doc)) {
        protocolEntries(doc); // refresh viewer-arg caches from the rendered page
        const rows = protocolStoreRows(doc);
        if (!rows.length) return protocolEntries(doc).map((e) => e.item); // store missing → DOM only
        const items = [];
        const add = (kind, r) => {
          const it = mkProtocolStoreItem(kind, r);
          const v = _protViewerByDocId[it.docId];
          if (v) { it.postbackArg = v.postbackArg; it.postbackTarget = v.postbackTarget; }
          items.push(it);
        };
        // Only IDC-published rows are downloadable (the site shows a checkbox
        // only for those). A transcript exists only when its id is non-zero.
        for (const r of rows) {
          if (r.IsIDCPublished && r.DocumentID) add('protocol', r);
          if (r.TranscriptionOrderDocumentID && r.IsTranscriptionOrderIDCPublished) add('transcript', r);
        }
        return items;
      }
      const d = this._discover(doc);
      if (!d) return [];
      return d.store.data.map((raw, i) => toItem(raw, i, d.fields, d.label, d.argSpec, d.argTemplate, d.eventTarget));
    },

    // For each visible row return an injection entry:
    //   { el, cell (where to put our checkbox), rowIndex, item, hideNative,
    //     nativeCheckbox }. Protocol screens yield up to TWO entries per row
    //     (protocol + transcript), each targeting its own cell.
    visibleRows(doc) {
      const grid = findGridRoot(doc);
      if (!grid) return [];
      if (isProtocolScreen(doc)) {
        return protocolEntries(doc).map((e) => ({
          el: e.el, cell: e.cell, rowIndex: e.rowIndex, item: e.item,
          hideNative: e.hideNative, nativeCheckbox: nativeCheckboxIn(e.el),
        }));
      }
      const rowEls = findRowEls(grid);
      const items = this.listAllItems(doc);
      const d = this._discover(doc);
      // CRITICAL: AG-Grid's row-index is the SORTED DISPLAY position, while
      // items[] is in ArrayStore order. When the grid is sorted (decisions
      // default to date-descending; the store is ascending) items[rowIndex] is
      // the WRONG document — the user ticks one row and a different file
      // downloads. The displayed cells can't disambiguate same-day rows (they
      // show the day, not the time the store actually sorts by), so REPLICATE the
      // grid's active sort over the store and index by display position.
      const sortVal = (v) => {
        const s = String(v == null ? '' : v).trim();
        const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
        if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
        if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
        return s.toLowerCase();
      };
      let order = null;
      if (d && d.store && d.store.data && d.store.data.length) {
        let h = grid.querySelector('[role="columnheader"][aria-sort="ascending"], [role="columnheader"][aria-sort="descending"]');
        let dir = 0;
        if (h) dir = h.getAttribute('aria-sort') === 'descending' ? -1 : 1;
        else { h = grid.querySelector('.ag-header-cell-sorted-desc, .ag-header-cell-sorted-asc'); if (h) dir = h.classList.contains('ag-header-cell-sorted-desc') ? -1 : 1; }
        const col = h && (h.getAttribute('col-id') || (h.querySelector('[col-id]') && h.querySelector('[col-id]').getAttribute('col-id')));
        const data = d.store.data;
        if (dir && col && Object.prototype.hasOwnProperty.call(data[0], col)) {
          order = data.map((_, i) => i);
          order.sort((a, b) => {
            const va = sortVal(data[a][col]); const vb = sortVal(data[b][col]);
            if (va < vb) return -dir;
            if (va > vb) return dir;
            return 0; // stable (V8) → ties keep store order, matching AG-Grid
          });
        }
      }
      return rowEls.map((el) => {
        const rowIndex = parseInt(el.getAttribute('row-index'), 10);
        const storeIdx = (order && order[rowIndex] != null) ? order[rowIndex] : rowIndex;
        return {
          el: el,
          cell: el.querySelector('[role="gridcell"]'),
          rowIndex: rowIndex,
          item: items[storeIdx] || items[rowIndex] || null,
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

    // True on screens that offer the native Word/DOC download (decisions /
    // judgments / protocols).
    supportsWordDownload(doc) { return supportsWord(doc || document); },

    // Bulk-download via the official "הורדת מסמכי Word" postback. Field/target
    // names are discovered from the page (prefix-agnostic); the date list is
    // included only when the screen actually carries such a hidden field.
    getNativeBulkRequest(items, doc) {
      const target = wordButtonTarget(doc);
      const extra = {};
      if (isProtocolScreen(doc)) {
        // Protocols use TWO selection fields, each a comma-joined list of
        // "id&dd/mm/yyyy" tokens (exactly what the site's own
        // onSelectionChangedSaveLists writes). Protocols → DocumentID;
        // transcripts → TranscriptionOrderDocumentID. The date is the
        // SittingDateString. A bare id (without &date) is NOT accepted.
        const pField = (doc.querySelector('input[name$="protocolDocumentList"]') || {}).name || '_ctl0:protocolDocumentList';
        const tField = (doc.querySelector('input[name$="transcriptionOrderDocumentList"]') || {}).name || '_ctl0:transcriptionOrderDocumentList';
        const tok = (it) => String(it.wordId || it.docId) + '&' + normDmy(it.date);
        extra[pField] = items.filter((it) => it.wordKind !== 'transcript').map(tok).join(',');
        extra[tField] = items.filter((it) => it.wordKind === 'transcript').map(tok).join(',');
      } else {
        const ids = items.map((it) => String(it.wordId || it.docId)).join(',');
        extra[bulkFieldName(doc, 'documentListIDs', '_ctl0:documentListIDs')] = ids;
        const dateInp = doc.querySelector('input[name$="SignatureDateIDs"], input[id$="SignatureDateIDs"], input[name$="DateIDs"], input[id$="DateIDs"]');
        if (dateInp) extra[dateInp.name] = items.map((it) => normDmy(it.date)).join(',');
      }
      const body = buildPostBody(doc, target, '', extra);
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
