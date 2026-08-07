// Net HaMishpat hearings adapter — reads hearing-list tabs (NOT document
// lists). Two modes:
//
//   • case  → single case's "מועדי דיון" tab
//             (URL: …/Ngcs.Web.Secured/Calendar/CalendarSittingCase.aspx).
//             Grid has hearings for one case only; case number is read from
//             the page header.
//   • user  → "יומן דיונים → הדיונים שלי" cross-case view
//             (URL: …/Calendar/Calendar*.aspx without "Case" in the segment).
//             Grid has every hearing for the logged-in user across cases,
//             with a CaseDisplayIdentifier-like column distinguishing them.
//             The page exposes from/to date inputs we can drive.
//
// Detection strategy:
//   1. URL is the primary, reliable signal — anything under /Calendar/ is
//      hearings. (The docs adapter matches by ArrayStore field names; that
//      doesn't carry over here because hearings tabs use a different field
//      vocabulary — StartHour/EndHour/SittingTypeName instead of
//      DocumentID/DisplayName.)
//   2. With URL confirmed, probe for an ArrayStore hidden input whose first
//      row carries ANY hearing-shaped field (date / hour / sitting type).
//   3. If no ArrayStore is found, fall back to scraping visible AG-Grid
//      rows by their Hebrew column headers — slower and capped at what's
//      rendered, but works when the page uses a server-side data source
//      with no inline JSON.
//
// CSV field set is kept aligned with hearing_scraper.py:42-66 so that the
// extension's CSVs can be merged with server-side scrapes interchangeably.

(function (root) {
  const CD = root.CD || (root.CD = {});

  const DEBUG_PREFIX = '[net-court-hearings]';
  function dbg() {
    try { console.log.apply(console, [DEBUG_PREFIX].concat(Array.from(arguments))); } catch (e) {}
  }

  // ---------- URL hints (NOT a gate) ----------
  // Used only to choose the initial mode label. Detection itself is
  // content-based — we look for an ArrayStore or AG-Grid that *looks* like
  // hearings data, regardless of URL. This matters because hearings views
  // live under several different paths:
  //   /Ngcs.Web.Secured/Calendar/CalendarSittingCase.aspx (single case)
  //   /Ngcs.Web.Secured/Calendar/CalendarSittingDay.aspx  (user calendar)
  //   /Ngcs.Web.Secured/Office/...                        (firm hearings)
  // — and possibly more we haven't enumerated yet. A URL gate would block
  // the firm-hearings view; a content gate doesn't.
  function urlIsSingleCase(loc) {
    const href = (loc && loc.href) || '';
    return /Case(?:Details)?[^/]*\.aspx/i.test(href) || /\/Calendar\/[^/]*Case[^/]*\.aspx/i.test(href);
  }

  // ---------- field name detection ----------
  // Permissive — different hearing pages use different conventions. We
  // catch StartHour, StartTime, SittingDate, SittingDateTime, etc.
  const FIELD_PATTERNS = {
    startHour:    [/^StartHour$/i, /^StartTime$/i, /^FromHour$/i, /^FromTime$/i],
    endHour:      [/^EndHour$/i, /^EndTime$/i, /^ToHour$/i, /^ToTime$/i],
    sittingDate:  [/^SittingDate$/i, /^HearingDate$/i, /^Date$/i, /^EventDate$/i],
    sittingDateTime: [/^StartTime$/i, /^SittingDateTime$/i, /^SittingDateAndTime$/i, /^StartDateTime$/i],
    caseIdent:    [/^CaseDisplayIdentifier$/i, /^CaseNumber$/i, /^CaseDisplay$/i, /^FileNumber$/i, /^CaseIdentifier$/i],
    proceeding:   [/^ProceedingName$/i, /^ProceedingTypeName$/i, /^ProceedingType$/i],
    caseName:     [/^CaseName$/i, /^FileName$/i, /^CaseTitle$/i],
    sittingType:  [/^SittingTypeName$/i, /^SittingType$/i, /^HearingTypeName$/i, /^SittingKind$/i, /^SittingKindName$/i],
    userList:     [/^UserList$/i, /^JudgesList$/i, /^SittingComposition$/i],
    judge:        [/^JudgeName$/i, /^JudgesNames$/i, /^JudgeFullName$/i, /^MainJudge$/i],
    externalCase: [/^ExternalCaseNumber$/i, /^ExtCaseNumber$/i],
    status:       [/^SittingActivityStatusName$/i, /^SittingStatus$/i, /^StatusName$/i, /^ActivityStatus$/i, /^SittingActivityStatus$/i],
    court:        [/^CourtName$/i, /^Court$/i],
    motion:       [/^MotionName$/i, /^PleadingName$/i, /^MotionTitle$/i, /^MotionPleading$/i, /^MotionOrPleading$/i],
    handler:      [/^HandlingParty$/i, /^HandlingUser$/i, /^HandlerName$/i, /^TreatedBy$/i, /^Handler$/i],
    protocol:     [/^HasProtocol$/i, /^Protocol$/i, /^ProtocolName$/i],
    isVideo:      [/^IsVideoConference$/i, /^IsVideo$/i, /^VideoConference$/i],
  };

  function pickField(keys, patterns) {
    for (const p of patterns) {
      const found = keys.find((k) => p.test(k));
      if (found) return found;
    }
    return null;
  }

  function buildFieldMap(sampleKeys) {
    const map = {};
    for (const role of Object.keys(FIELD_PATTERNS)) {
      map[role] = pickField(sampleKeys, FIELD_PATTERNS[role]);
    }
    return map;
  }

  // A row "looks like a hearing" if it has a time/date column AND a
  // hearing-classification column. This filters out non-hearing ArrayStores
  // that may share the page (e.g. case-list previews).
  function looksLikeHearing(fields) {
    const hasTime = !!(fields.startHour || fields.sittingDate || fields.sittingDateTime);
    const hasKind = !!(fields.sittingType || fields.proceeding || fields.status);
    return hasTime || hasKind;
  }

  // ---------- locate the hearings ArrayStore ----------
  function findHearingStore(doc) {
    const candidates = Array.from(doc.querySelectorAll('input[type="hidden"][value^="["]'));
    let best = null;
    for (const input of candidates) {
      const v = input.value;
      if (!v || v.length < 4) continue;
      try {
        const arr = JSON.parse(v);
        if (!Array.isArray(arr) || !arr.length || typeof arr[0] !== 'object' || !arr[0]) continue;
        const keys = Object.keys(arr[0]);
        const fm = buildFieldMap(keys);
        if (!looksLikeHearing(fm)) continue;
        // Pick the store with the most matched roles (in case more than one
        // qualifies, e.g. a small embedded preview alongside the main grid).
        const score = Object.values(fm).filter(Boolean).length;
        if (!best || score > best.score) {
          best = { name: input.name, data: arr, sampleKeys: keys, fields: fm, score: score };
        }
      } catch (e) {}
    }
    return best;
  }

  // An "empty hearings store" — a hidden input whose value is a JSON array
  // with zero rows ("[]"). findHearingStore skips these (it needs a sample row
  // to shape-match), but the BACKGROUND collector uses their presence to
  // verify that a fetched report page genuinely has no hearings that day
  // (as opposed to a page that never embeds data inline at all).
  function hasEmptyHearingStore(doc) {
    const candidates = Array.from(doc.querySelectorAll('input[type="hidden"][value^="["]'));
    for (const input of candidates) {
      try {
        const arr = JSON.parse(input.value);
        if (Array.isArray(arr) && arr.length === 0) return true;
      } catch (e) {}
    }
    return false;
  }

  // ---------- DOM fallback (no ArrayStore) ----------
  // Map Hebrew column headers → semantic role. The headers visible on the
  // CalendarSittingCase tab match these labels exactly.
  const HEADER_TO_ROLE = {
    'שעת התחלה': 'startHour',
    'שעת סיום': 'endHour',
    'שעת דיון': 'startHour',        // ReportLawyerSittingsQueryView ("הדיונים שלי")
    'תאריך': 'sittingDate',
    'תאריך דיון': 'sittingDate',
    'סוג דיון': 'sittingType',
    'סוג הדיון': 'sittingType',
    'מספר תיק': 'caseIdent',
    'שם התיק': 'caseName',
    'הליך': 'proceeding',
    'גורם שיפוטי': 'userList',
    'גורם מטפל': 'handler',
    'שופט': 'judge',
    'בפני': 'judge',               // lawyer report uses "בפני" for the judge
    'בית משפט': 'court',
    'תיק חיצוני': 'externalCase',
    'סטטוס דיון': 'status',
    'סטטוס הדיון': 'status',
    'בקשה/כתב טענות': 'motion',
    'פרוטוקול': 'protocol',
    'היוועדות חזותית': 'isVideo',
  };

  // AG-Grid appends a sort-order badge to sorted column headers (e.g.
  // "תאריך דיון 1") and may include arrow glyphs / nbsp. Normalize before
  // mapping: collapse whitespace, drop a trailing sort number, strip arrows.
  function normalizeHeader(text) {
    return String(text || '')
      .replace(/ /g, ' ')
      .replace(/[▲▼↑↓]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s+\d+$/, '');
  }
  function headerRole(text) {
    const n = normalizeHeader(text);
    if (HEADER_TO_ROLE[n]) return HEADER_TO_ROLE[n];
    // Fall back to a startsWith match (handles minor label variants).
    for (const key of Object.keys(HEADER_TO_ROLE)) {
      if (n.indexOf(key) === 0) return HEADER_TO_ROLE[key];
    }
    return null;
  }

  // Generic "first grid on the page" — used only as a fallback. Prefer
  // findHearingsGrid() (below), which targets a VISIBLE hearings grid so we
  // never mis-fire on the decisions/documents dashboard modals.
  function firstGrid(doc) {
    return (
      doc.querySelector('[id$="Grid"] .ag-root-wrapper') ||
      doc.querySelector('[id$="Grid"]') ||
      doc.querySelector('.ag-root-wrapper') ||
      doc.querySelector('[role="grid"]') ||
      null
    );
  }
  function findGridRoot(doc) {
    return findHearingsGrid(doc) || firstGrid(doc);
  }

  function isVisibleEl(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }

  // Header labels that ONLY a hearings grid has. The personal-area dashboard
  // also shows a decisions grid ("סוג החלטה", "תאריך חתימה") and a documents
  // grid ("סוג מסמך", "תאריך הצגה") — none of which carry these — so requiring
  // one of these excludes them.
  const HEARING_GRID_HEADERS = ['שעת התחלה', 'שעת סיום', 'שעת דיון', 'סוג דיון', 'סוג הדיון', 'תאריך דיון', 'מועד דיון'];

  // Find the ONE grid on the page that is genuinely a hearings grid AND is
  // visible right now. This is the crux of correct detection: the dashboard
  // keeps a hidden #SittingGrid in the DOM at all times, so a page-wide header
  // scan would falsely flag the decisions/documents modals as hearings. By
  // requiring a VISIBLE grid that carries hearing-only headers we mount only
  // on real hearings views (dedicated pages, and the "דיונים שלי" modal).
  function findHearingsGrid(doc) {
    const grids = Array.from(doc.querySelectorAll('#SittingGrid, [id$="Grid"], .ag-root-wrapper, [role="grid"]'));
    let best = null;
    for (const g of grids) {
      if (!isVisibleEl(g)) continue;
      const heads = Array.from(g.querySelectorAll('.ag-header-cell')).map((h) => normalizeHeader(h.textContent));
      if (!heads.length) continue;
      if (!heads.some((h) => HEARING_GRID_HEADERS.indexOf(h) !== -1)) continue;
      const rows = g.querySelectorAll('.ag-center-cols-container [role="row"][row-index]').length;
      const score = ((g.id === 'SittingGrid') ? 100 : 0) + (rows > 0 ? 10 : 0) + 1;
      if (!best || score > best.score) best = { el: g, score: score };
    }
    return best ? best.el : null;
  }

  function gridHeaders(grid) {
    if (!grid) return [];
    return Array.from(grid.querySelectorAll('.ag-header-cell')).map((h) => normalizeHeader(h.textContent));
  }

  function scrapeGridByHeaders(doc) {
    return scrapeGridRoot(findGridRoot(doc));
  }

  // Scrape a SPECIFIC AG-Grid element by its Hebrew column headers. Used both
  // for the default grid and for a named grid (e.g. #SittingGrid inside the
  // personal-area "דיונים שלי" modal).
  function scrapeGridRoot(grid) {
    if (!grid) return null;
    // AG-Grid puts header cells inside .ag-header-cell with text in
    // .ag-header-cell-text. Build a colIndex → role map by reading headers.
    const headerCells = Array.from(grid.querySelectorAll('.ag-header-cell'));
    const colCount = headerCells.length;
    if (!colCount) return null;
    const colRoles = new Array(colCount).fill(null);
    headerCells.forEach((cell, idx) => {
      const role = headerRole(cell.textContent);
      if (role) colRoles[idx] = role;
    });
    if (!colRoles.some(Boolean)) return null;

    const rowEls = Array.from(grid.querySelectorAll('.ag-center-cols-container [role="row"][row-index]'));
    const rows = [];
    for (const rowEl of rowEls) {
      const cells = Array.from(rowEl.querySelectorAll('[role="gridcell"]'));
      const raw = {};
      cells.forEach((cell, idx) => {
        const role = colRoles[idx];
        if (role) raw[role] = (cell.textContent || '').trim();
      });
      if (Object.keys(raw).length) rows.push(raw);
    }
    if (!rows.length) return null;

    // Promote to the same shape findHearingStore would return — but the
    // "fields" map is identity (role→role), and toHearing() handles that.
    const idFields = {};
    Object.keys(rows[0]).forEach((k) => { idFields[k] = k; });
    return {
      name: '__dom_fallback__',
      data: rows,
      sampleKeys: Object.keys(rows[0]),
      fields: idFields,
      score: Object.keys(idFields).length,
      _fromDom: true,
    };
  }

  // ---------- judge-day report controls ----------
  // The "דיונים לשופט ליום דיונים" report page (ReportJudgeSittingsDay /
  // CalendarSittingJudge) has a court combo + judge combo + a SINGLE date
  // input + a "הצגת דו\"ח" report button (makeReportUIButton). hearing_scraper.py
  // drives the public twin of this page; the secured page uses the same
  // control vocabulary. We auto-discover by id/name fragments so the exact
  // ASP.NET id prefix (_ctl2 / _ctl3 / …) doesn't matter.
  // The report's OWN combo is "…ComboBoxCourt/Judge" (ComboBox BEFORE the noun).
  // Must NOT pick the header case-locator's "…PreviousCourtComboBoxHT" (Court
  // BEFORE ComboBox), which lists old-case courts and breaks the report match —
  // and it sits earlier in the DOM, so a loose querySelector grabbed it.
  function notLocator(s) { return !/CaseLocatorHeader|Previous(Court|CaseType|Numerator)/i.test((s.id || '') + ' ' + (s.name || '')); }
  function findCourtSelect(doc) {
    const sels = Array.prototype.slice.call(doc.querySelectorAll('select')).filter(notLocator);
    return sels.find((s) => /ComboBoxCourt/i.test((s.id || '') + (s.name || '')))
      || sels.find((s) => /Court/i.test((s.id || '') + (s.name || '')) && /ComboBox/i.test((s.id || '') + (s.name || '')))
      || null;
  }
  function findJudgeSelect(doc) {
    const sels = Array.prototype.slice.call(doc.querySelectorAll('select')).filter(notLocator);
    return sels.find((s) => /ComboBoxJudge/i.test((s.id || '') + (s.name || '')))
      || sels.find((s) => /Judge/i.test((s.id || '') + (s.name || '')) && /ComboBox/i.test((s.id || '') + (s.name || '')))
      || null;
  }
  function findReportButton(doc) {
    return doc.querySelector('[id*="makeReportUI"], [name*="makeReport"], [id*="MakeReport"]');
  }
  // The single date field on the judge page. Its id contains "Calendar" and
  // often "FromDate" (NGCSWebCalendarFromDate) even though it's a single day.
  function findSingleDateInput(doc) {
    return (
      doc.querySelector('input[id*="Calendar"][type="text"], input[name*="Calendar"][type="text"]') ||
      doc.querySelector('input[id*="FromDate"], input[name*="FromDate"]') ||
      doc.querySelector('input[id*="Date"][type="text"]')
    );
  }

  function selectedText(sel) {
    if (!sel) return '';
    const o = sel.options && sel.options[sel.selectedIndex];
    return o ? (o.text || '').trim() : '';
  }
  function selectedValue(sel) { return sel ? (sel.value || '') : ''; }

  // True when the page is the judge-DAY report: court/judge selectors + a
  // report button + a SINGLE date field. The lawyer/firm report
  // (ReportLawyerSittingsQueryView) also has a court selector + report button,
  // but it uses a from/TO date RANGE — so the presence of a ToDate field means
  // it is NOT the judge-day report (it's the user/lawyer range report).
  function isJudgeReport(doc) {
    if (!findReportButton(doc)) return false;
    if (!(findCourtSelect(doc) || findJudgeSelect(doc))) return false;
    if (!findSingleDateInput(doc)) return false;
    if (findDateInput(doc, 'to')) return false; // has a "to" date → range report, not judge-day
    return true;
  }

  // ---------- mode detection ----------
  // Returns 'judge' | 'case' | 'user' | null. We mount ONLY when there is a
  // visible hearings grid (or the judge-report controls) — never on the
  // decisions/documents dashboard modals.
  function detectMode(doc, loc) {
    loc = loc || doc.location || (typeof location !== 'undefined' ? location : { href: '' });

    // The protocols screen (ProtocolFileViewer) carries a "תאריך דיון" column
    // but is a DOCUMENTS screen (protocol + transcript downloads) handled by the
    // documents panel — never claim it as hearings.
    if (/ProtocolFileViewer/i.test(loc.href || '')) return null;
    if (doc.querySelector('[col-id="ProtocolDocument"], [col-id="TranscriptionlDocument"]')) return null;

    // Highest priority: the judge-day report page (court+judge+report+single
    // date). Needs the day-by-day range collector.
    if (isJudgeReport(doc)) return 'judge';

    // Otherwise we require a VISIBLE hearings grid. This excludes the
    // dashboard's decisions/documents modals (different headers) and the
    // always-present-but-hidden #SittingGrid.
    const grid = findHearingsGrid(doc);
    if (!grid) return null;

    // case vs user: a "מספר תיק" column means a cross-case view (the firm /
    // personal "דיונים שלי" lists, and the lawyer report) → user mode. A
    // single-case "מועדי דיון" tab has no case column → case mode.
    const heads = gridHeaders(grid);
    if (heads.indexOf('מספר תיק') !== -1 || heads.indexOf('מספר התיק') !== -1) return 'user';
    return 'case';
  }

  // ---------- value extraction ----------
  function pad2(n) {
    n = String(n);
    return n.length < 2 ? '0' + n : n;
  }

  // Parse various hearing-time shapes. Accepts:
  //   ISO        "2026-06-15T10:30:00" / "2026-06-15 10:30"
  //   DD/MM/YYYY "15/06/2026 10:30" / "15/06/2026"
  //   bare time  "10:30" / "10:30:00"
  //   bare date  "15/06/2026" / "2026-06-15"
  function splitDateTime(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { date: '', time: '' };
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
    if (m) return { date: m[3] + '/' + m[2] + '/' + m[1], time: pad2(m[4]) + ':' + m[5] };
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { date: m[3] + '/' + m[2] + '/' + m[1], time: '' };
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (m) return {
      date: pad2(m[1]) + '/' + pad2(m[2]) + '/' + m[3],
      time: pad2(m[4]) + ':' + m[5],
    };
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return { date: pad2(m[1]) + '/' + pad2(m[2]) + '/' + m[3], time: '' };
    m = s.match(/^(\d{1,2}):(\d{2})/);
    if (m) return { date: '', time: pad2(m[1]) + ':' + m[2] };
    return { date: '', time: s };
  }

  // The case number of a single-case hearings page. This used to read only the
  // first 6000 characters of body text — and on the public portal the case
  // banner sits at ~char 12,900, behind the accessibility widget's text and the
  // header's full court/case-type option lists. It therefore returned '' there,
  // which silently cost the calendar sync its per-case scope and made every
  // sync re-add the same hearings. Walk the text nodes instead, skipping the
  // extension's OWN injected UI (favorites and quick-locate render OTHER case
  // numbers into the page, which would otherwise be picked up as this case).
  function readCaseIdFromHeader(doc) {
    const wd = doc || document;
    const RE = /\b(\d{4,8}-\d{2}-\d{2})\b/;
    function inExtUI(el) {
      for (let n = el; n; n = n.parentElement) {
        const id = n.id || '';
        const cls = typeof n.className === 'string' ? n.className : ((n.className && n.className.baseVal) || '');
        if (id === 'cd-float' || id.indexOf('cd-') === 0 || /(^|\s)cd-/.test(cls)) return true;
      }
      return false;
    }
    try {
      const walk = wd.createTreeWalker(wd.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walk.nextNode())) {
        if (inExtUI(node.parentElement)) continue;
        const m = (node.textContent || '').match(RE);
        if (m) return m[1];
      }
    } catch (e) {
      const m = ((wd.body && wd.body.textContent) || '').match(RE);
      if (m) return m[1];
    }
    return '';
  }

  function readCourtFromHeader(doc) {
    // Best-effort — the case header band often includes "בית משפט X".
    const t = ((doc.body && doc.body.textContent) || '').slice(0, 6000);
    const m = t.match(/(בית\s+(?:ה?משפט|הדין|המחוזי|השלום)[֐-׿\s'"-]{0,40})/);
    return m ? m[1].trim() : '';
  }

  // ---------- normalize one raw row into a Hearing item ----------
  function toHearing(raw, fields, fallbackCaseId, fallbackCourt) {
    // Time: prefer combined date+time field; else combine separate date +
    // hour fields; finally fall back to whichever is populated.
    let date = '', time = '';
    if (fields.sittingDateTime && raw[fields.sittingDateTime] != null) {
      const split = splitDateTime(raw[fields.sittingDateTime]);
      date = split.date; time = split.time;
    }
    if (!date && fields.sittingDate && raw[fields.sittingDate] != null) {
      const split = splitDateTime(raw[fields.sittingDate]);
      date = split.date || date;
      if (!time) time = split.time;
    }
    if (!time && fields.startHour && raw[fields.startHour] != null) {
      const split = splitDateTime(raw[fields.startHour]);
      time = split.time || split.date; // bare "10:30" lands in either slot
      if (!date && split.date) date = split.date;
    }

    // End time ("שעת סיום"), when the source provides it — used for the real
    // calendar event duration instead of a fixed +1h.
    let endTime = '';
    if (fields.endHour && raw[fields.endHour] != null) {
      const split = splitDateTime(raw[fields.endHour]);
      endTime = split.time || '';
    }

    return {
      date: date,
      time: time,
      endTime: endTime,
      caseId: fields.caseIdent ? String(raw[fields.caseIdent] || '') : fallbackCaseId,
      court: fields.court ? String(raw[fields.court] || '') : fallbackCourt,
      judge: fields.judge ? String(raw[fields.judge] || '')
             : (fields.userList ? String(raw[fields.userList] || '') : ''),
      caseName: fields.caseName ? String(raw[fields.caseName] || '') : '',
      proceeding: fields.proceeding ? String(raw[fields.proceeding] || '') : '',
      sittingType: fields.sittingType ? String(raw[fields.sittingType] || '') : '',
      userList: fields.userList ? String(raw[fields.userList] || '') : '',
      externalCase: fields.externalCase ? String(raw[fields.externalCase] || '') : '',
      status: fields.status ? String(raw[fields.status] || '') : '',
      motion: fields.motion ? String(raw[fields.motion] || '') : '',
      handler: fields.handler ? String(raw[fields.handler] || '') : '',
      protocol: fields.protocol ? String(raw[fields.protocol] || '') : '',
      isVideo: fields.isVideo ? String(raw[fields.isVideo] || '') : '',
      _raw: raw,
    };
  }

  // Stable per-row id for selection/checkboxes. Derive from caseId+date+time
  // (matches the ICS UID strategy); fall back to row index when those are
  // empty (DOM fallback rows pre-parse).
  function hearingId(h, idx) {
    const key = (h.caseId || '') + '|' + (h.date || '') + '|' + (h.time || '') + '|' + (h.sittingType || '');
    if (key === '|||') return 'row-' + idx;
    return key;
  }

  // ---------- date-range inputs (user mode only) ----------
  function findDateInput(doc, kind /* 'from' | 'to' */) {
    const needle = kind === 'from' ? 'FromDate' : 'ToDate';
    return doc.querySelector('input[id*="' + needle + '"], input[name*="' + needle + '"]');
  }
  // (findReportButton / findSingleDateInput / findCourtSelect / findJudgeSelect
  //  are defined above in the judge-report section.)

  // ---------- judge-report driving (day-by-day range) ----------
  // Resolve the ASP.NET postback target name of the report button so we can
  // submit the form ourselves (content scripts can't call the page's own
  // __doPostBack — it lives in the page world, not ours). We read the name
  // from the element, or parse it out of a __doPostBack(...) href/onclick.
  function reportTargetName(doc) {
    const btn = findReportButton(doc);
    if (!btn) return '';
    if (btn.name) return btn.name;
    const src = (btn.getAttribute('href') || '') + ' ' + (btn.getAttribute('onclick') || '');
    const m = src.match(/__doPostBack\(['"]([^'"]+)['"]/);
    if (m) return m[1];
    return '';
  }

  // Snapshot of the judge-report context (for the panel's readout + naming).
  function judgeContext(doc) {
    return {
      courtName: selectedText(findCourtSelect(doc)),
      courtValue: selectedValue(findCourtSelect(doc)),
      judgeName: selectedText(findJudgeSelect(doc)),
      judgeValue: selectedValue(findJudgeSelect(doc)),
      reportTarget: reportTargetName(doc),
      hasDate: !!findSingleDateInput(doc),
    };
  }

  // Submit the report form via a full ASP.NET postback (identical to clicking
  // "הצגת דו\"ח"). Content scripts can't call the page's own __doPostBack, so
  // we set the form's __EVENTTARGET to the report button and submit. Falls
  // back to clicking the button element when the target can't be resolved.
  function submitReport(doc) {
    const form = doc.forms[0];
    const target = reportTargetName(doc);
    if (form && target) {
      let et = form.querySelector('input[name="__EVENTTARGET"]');
      let ea = form.querySelector('input[name="__EVENTARGUMENT"]');
      if (!et) { et = doc.createElement('input'); et.type = 'hidden'; et.name = '__EVENTTARGET'; form.appendChild(et); }
      if (!ea) { ea = doc.createElement('input'); ea.type = 'hidden'; ea.name = '__EVENTARGUMENT'; form.appendChild(ea); }
      et.value = target; ea.value = '';
      form.submit();
      return true;
    }
    const btn = findReportButton(doc);
    if (btn) { btn.click(); return true; }
    return false;
  }

  // Submit the judge report for ONE date (sets the single date field first).
  function submitJudgeReport(doc, dateStr) {
    const dateEl = findSingleDateInput(doc);
    if (!doc.forms[0] || !dateEl) return false;
    dateEl.value = dateStr;
    dateEl.dispatchEvent(new Event('change', { bubbles: true }));
    return submitReport(doc);
  }

  // ---------- CSV row shape (matches hearing_scraper.py CSV_HEADERS) ----------
  const CSV_HEADERS = [
    'בית משפט',
    'שופט',
    'תאריך',
    'שעה',
    'מספר תיק',
    'הליך',
    'שם התיק',
    'סוג דיון',
    'גורם שיפוטי',
    'תיק חיצוני',
    'סטטוס הדיון',
  ];

  function csvRow(h) {
    return {
      'בית משפט': h.court || '',
      'שופט': h.judge || '',
      'תאריך': h.date || '',
      'שעה': h.time || '',
      'מספר תיק': h.caseId || '',
      'הליך': h.proceeding || '',
      'שם התיק': h.caseName || '',
      'סוג דיון': h.sittingType || '',
      'גורם שיפוטי': h.userList || '',
      'תיק חיצוני': h.externalCase || '',
      'סטטוס הדיון': h.status || '',
    };
  }

  // ---------- public adapter ----------
  const adapter = {
    name: 'net-court-hearings',
    CSV_HEADERS: CSV_HEADERS,
    hearingId: hearingId,

    detectMode: detectMode,
    findGridRoot: findGridRoot,
    findHearingsGrid: findHearingsGrid,

    listAllHearings(doc) {
      // Scrape ONLY the visible hearings grid (never the decisions/documents
      // grids that share the dashboard). Pagination is handled by the caller
      // (the panel / header-sync page through and re-call this).
      const grid = findHearingsGrid(doc);
      if (!grid) { dbg('listAllHearings: no visible hearings grid'); return []; }
      return this.listHearingsInGrid(grid, doc);
    },

    // ArrayStore-ONLY extraction. Works on inert DOMParser documents (fetched
    // report HTML), where AG-Grid never runs so there are no rendered rows to
    // fall back on. Returns null when no populated store exists — the caller
    // distinguishes "verified empty day" via hasEmptyHearingStore.
    listHearingsFromStore(doc) {
      const store = findHearingStore(doc);
      if (!store) return null;
      const fallbackCaseId = store.fields.caseIdent ? '' : readCaseIdFromHeader(doc);
      const fallbackCourt = readCourtFromHeader(doc);
      return store.data.map((raw) => toHearing(raw, store.fields, fallbackCaseId, fallbackCourt));
    },
    hasEmptyHearingStore: hasEmptyHearingStore,

    // Judge-report control finders (all doc-parametrized, so they work on both
    // the live document and fetched/parsed report pages).
    findCourtSelect: findCourtSelect,
    findJudgeSelect: findJudgeSelect,
    findSingleDateInput: findSingleDateInput,
    findReportButton: findReportButton,
    reportTargetName: reportTargetName,
    isJudgeReport: isJudgeReport,

    csvRow: csvRow,

    // Scrape a specific grid element (by its Hebrew headers) → hearings.
    // Used for the private "דיונים שלי" modal grid (#SittingGrid), which sits
    // alongside other dashboard grids so we can't rely on findGridRoot.
    listHearingsInGrid(gridEl, doc) {
      doc = doc || document;
      const store = scrapeGridRoot(gridEl);
      if (!store) return [];
      const fallbackCaseId = store.fields.caseIdent ? '' : readCaseIdFromHeader(doc);
      const fallbackCourt = readCourtFromHeader(doc);
      return store.data.map((raw) => toHearing(raw, store.fields, fallbackCaseId, fallbackCourt));
    },

    setDateRange(doc, from, to) {
      const f = findDateInput(doc, 'from');
      const t = findDateInput(doc, 'to');
      if (f && from) { f.value = from; f.dispatchEvent(new Event('change', { bubbles: true })); }
      if (t && to) { t.value = to; t.dispatchEvent(new Event('change', { bubbles: true })); }
      return { from: !!f, to: !!t };
    },

    triggerReport(doc) {
      const btn = findReportButton(doc);
      if (!btn) return false;
      btn.click();
      return true;
    },

    // Judge-report (day-by-day range) surface.
    judgeContext: judgeContext,
    submitJudgeReport: submitJudgeReport,
    submitReport: submitReport,

    _debug() {
      const mode = detectMode(document);
      const list = this.listAllHearings(document);
      dbg('mode:', mode);
      dbg('url:', location.href);
      dbg('count:', list.length);
      if (mode === 'judge') dbg('judgeContext:', judgeContext(document));
      list.slice(0, 5).forEach((h, i) =>
        dbg(i, h.date || '-', h.time || '-', h.caseId || '-', '|', h.sittingType, '|', (h.caseName || '').slice(0, 30)));
      return { mode, hearings: list, judge: mode === 'judge' ? judgeContext(document) : null };
    },
  };

  CD.adapters = CD.adapters || {};
  CD.adapters['net-court-hearings'] = adapter;
})(typeof window !== 'undefined' ? window : self);
