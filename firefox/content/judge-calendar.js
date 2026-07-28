// judge-calendar.js — a floating calendar window for the judge-hearings
// collector. After the panel collects a judge's hearings across a date range
// (state.hearings in hearings-panel.js), this renders them as a calendar with
// day / 4-day / week / month views and per-field toggles.
//
// Exposed as CD.openJudgeCalendar(hearings, meta, settings). The hearings-panel
// "📅 תצוגת יומן" button calls it with the collected set. The window is a
// self-contained overlay; it reads/writes view+field preferences through
// CD.getSettings/saveSettings (settings.judgeCalendar) when available.

(function (root) {
  const CD = root.CD || (root.CD = {});
  const w = root;

  const HE_WEEK = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const HE_WEEK_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const HE_MONTH = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי',
    'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

  // Field order is fixed; labels for the toggle bar.
  const FIELD_DEFS = [
    { key: 'time', label: 'שעה' },
    { key: 'sittingType', label: 'סוג דיון' },
    { key: 'caseType', label: 'סוג תיק' },
    { key: 'caseId', label: 'מספר תיק' },
    { key: 'caseName', label: "שם התיק (X נ' Y)" },
  ];
  const DEFAULT_FIELDS = { time: true, sittingType: true, caseType: true, caseId: true, caseName: true };

  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function parseDMY(s) {
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }
  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) { const x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday
  function sameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Split "ת\"א 12345-06-25" → { abbr: 'ת"א', num: '12345-06-25' }. If no
  // Hebrew prefix, abbr is empty and num is the whole identifier.
  function splitCaseId(id) {
    const s = String(id || '').trim();
    const m = s.match(/^([^\d]+?)\s*(\d[\d/\-.]*)\s*$/);
    if (m) return { abbr: m[1].replace(/\s+/g, ''), num: m[2].trim() };
    return { abbr: '', num: s };
  }
  // Case-type abbreviation: prefer the prefix in the identifier; else look for
  // a raw field that holds a case-type/procedure label and abbreviate it.
  function caseTypeAbbr(h) {
    const fromId = splitCaseId(h.caseId).abbr;
    if (fromId) return fromId;
    const raw = h._raw || {};
    for (const k of Object.keys(raw)) {
      if (/CaseType|ProcedureType|CaseKind|TikType/i.test(k)) {
        const v = String(raw[k] || '').trim();
        if (v) return v;
      }
    }
    return '';
  }

  let elOverlay = null;
  let st = null;

  function getFields(settings) {
    const f = (settings && settings.judgeCalendar && settings.judgeCalendar.fields) || {};
    return Object.assign({}, DEFAULT_FIELDS, f);
  }
  function getView(settings) {
    const v = settings && settings.judgeCalendar && settings.judgeCalendar.view;
    return ['day', '4day', 'week', 'month'].indexOf(v) !== -1 ? v : 'week';
  }
  function persist() {
    if (w.CD && w.CD.saveSettings) {
      try { w.CD.saveSettings({ judgeCalendar: { view: st.view, fields: st.fields } }); } catch (e) {}
    }
  }

  function close() {
    if (elOverlay && elOverlay.parentNode) elOverlay.parentNode.removeChild(elOverlay);
    elOverlay = null;
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  function open(hearings, meta, settings) {
    close();
    hearings = (hearings || []).filter((h) => h && h.date);

    // Group by day key.
    const byDay = {};
    let minD = null, maxD = null;
    for (const h of hearings) {
      const d = parseDMY(h.date);
      if (!d) continue;
      const k = keyOf(d);
      (byDay[k] = byDay[k] || []).push(h);
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    }
    // Sort each day by time (timeless rows last).
    for (const k of Object.keys(byDay)) {
      byDay[k].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let anchor = (minD && maxD && today >= minD && today <= maxD) ? today : (minD || today);

    st = {
      hearings: hearings, meta: meta || {}, byDay: byDay,
      minD: minD, maxD: maxD,
      view: getView(settings), fields: getFields(settings),
      anchor: anchor,
    };

    elOverlay = document.createElement('div');
    elOverlay.className = 'cd-jcal-overlay';
    elOverlay.dir = 'rtl';
    elOverlay.innerHTML = shellHtml();
    elOverlay.addEventListener('mousedown', (e) => { if (e.target === elOverlay) close(); });
    document.body.appendChild(elOverlay);
    bind();
    render();
    document.addEventListener('keydown', onKey, true);
  }

  function shellHtml() {
    const m = st.meta || {};
    const sub = [m.judgeName, m.courtName].filter(Boolean).join(' · ');
    const range = (m.from && m.to) ? (m.from + ' – ' + m.to) : '';
    return '<div class="cd-jcal" role="dialog" aria-label="יומן שופט">' +
      '<div class="cd-jcal__head">' +
        '<div class="cd-jcal__title">📅 יומן השופט' +
          (sub ? ' <span class="cd-jcal__sub">' + esc(sub) + '</span>' : '') +
          (range ? ' <span class="cd-jcal__sub">(' + esc(range) + ')</span>' : '') +
          ' <span class="cd-jcal__sub" data-jc="count"></span>' +
        '</div>' +
        '<button type="button" class="cd-jcal__close" data-jc-act="close" aria-label="סגור">×</button>' +
      '</div>' +
      '<div class="cd-jcal__controls">' +
        '<div class="cd-jcal__views" role="group">' +
          viewBtn('day', 'יום') + viewBtn('4day', '4 ימים') +
          viewBtn('week', 'שבוע') + viewBtn('month', 'חודש') +
        '</div>' +
        '<div class="cd-jcal__nav">' +
          '<button type="button" class="cd-jcal__btn" data-jc-act="prev" title="הקודם">→</button>' +
          '<button type="button" class="cd-jcal__btn" data-jc-act="today">היום</button>' +
          '<button type="button" class="cd-jcal__btn" data-jc-act="next" title="הבא">←</button>' +
          '<span class="cd-jcal__period" data-jc="period"></span>' +
        '</div>' +
        '<div class="cd-jcal__fields" data-jc="fields">' + fieldToggles() + '</div>' +
      '</div>' +
      '<div class="cd-jcal__body" data-jc="body"></div>' +
    '</div>';
  }
  function viewBtn(v, label) {
    return '<button type="button" class="cd-jcal__btn cd-jcal__viewbtn" data-jc-view="' + v + '">' + label + '</button>';
  }
  function fieldToggles() {
    return FIELD_DEFS.map((f) =>
      '<label class="cd-jcal__fld"><input type="checkbox" data-jc-field="' + f.key + '"' +
      (st.fields[f.key] ? ' checked' : '') + '> ' + esc(f.label) + '</label>').join('');
  }

  function bind() {
    elOverlay.addEventListener('click', (e) => {
      const vb = e.target.closest('[data-jc-view]');
      if (vb) { st.view = vb.getAttribute('data-jc-view'); persist(); render(); return; }
      const ab = e.target.closest('[data-jc-act]');
      if (!ab) return;
      const a = ab.getAttribute('data-jc-act');
      if (a === 'close') return close();
      if (a === 'today') { st.anchor = new Date(); st.anchor.setHours(0, 0, 0, 0); render(); return; }
      if (a === 'prev' || a === 'next') { step(a === 'next' ? 1 : -1); render(); return; }
    });
    elOverlay.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-jc-field]');
      if (!cb) return;
      st.fields[cb.getAttribute('data-jc-field')] = cb.checked;
      persist();
      renderBody();
    });
  }

  function step(dir) {
    if (st.view === 'day') st.anchor = addDays(st.anchor, dir);
    else if (st.view === '4day') st.anchor = addDays(st.anchor, 4 * dir);
    else if (st.view === 'week') st.anchor = addDays(st.anchor, 7 * dir);
    else { const x = new Date(st.anchor.getTime()); x.setMonth(x.getMonth() + dir); st.anchor = x; }
  }

  function render() {
    // Active view button.
    elOverlay.querySelectorAll('[data-jc-view]').forEach((b) =>
      b.classList.toggle('is-active', b.getAttribute('data-jc-view') === st.view));
    const cnt = elOverlay.querySelector('[data-jc="count"]');
    if (cnt) cnt.textContent = '· ' + st.hearings.length + ' דיונים';
    renderPeriod();
    renderBody();
  }

  function renderPeriod() {
    const el = elOverlay.querySelector('[data-jc="period"]');
    if (!el) return;
    const a = st.anchor;
    if (st.view === 'day') {
      el.textContent = HE_WEEK[a.getDay()] + ', ' + pad(a.getDate()) + '/' + pad(a.getMonth() + 1) + '/' + a.getFullYear();
    } else if (st.view === 'month') {
      el.textContent = HE_MONTH[a.getMonth()] + ' ' + a.getFullYear();
    } else {
      const days = currentDays();
      const f = days[0], l = days[days.length - 1];
      el.textContent = pad(f.getDate()) + '/' + pad(f.getMonth() + 1) + ' – ' + pad(l.getDate()) + '/' + pad(l.getMonth() + 1) + '/' + l.getFullYear();
    }
  }

  // The list of day Dates the current view spans (columnar views).
  function currentDays() {
    if (st.view === 'day') return [st.anchor];
    if (st.view === '4day') return [0, 1, 2, 3].map((i) => addDays(st.anchor, i));
    if (st.view === 'week') { const s = startOfWeek(st.anchor); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i)); }
    return [];
  }

  function renderBody() {
    const body = elOverlay.querySelector('[data-jc="body"]');
    if (!body) return;
    body.innerHTML = st.view === 'month' ? monthHtml() : columnsHtml();
  }

  // Build the visible field lines for one hearing (respecting toggles + order).
  function eventLinesHtml(h, compact) {
    const parts = [];
    const sp = splitCaseId(h.caseId);
    if (st.fields.time && h.time) parts.push('<span class="cd-jcal__t">' + esc(h.time) + '</span>');
    if (st.fields.sittingType && h.sittingType) parts.push('<span>' + esc(h.sittingType) + '</span>');
    const idbits = [];
    if (st.fields.caseType) { const ab = caseTypeAbbr(h); if (ab) idbits.push('<b>' + esc(ab) + '</b>'); }
    if (st.fields.caseId && sp.num) idbits.push(esc(sp.num));
    if (idbits.length) parts.push('<span>' + idbits.join(' ') + '</span>');
    if (st.fields.caseName && h.caseName) parts.push('<span class="cd-jcal__nm">' + esc(h.caseName) + '</span>');
    if (!parts.length) return '<span class="cd-jcal__muted">דיון</span>';
    if (compact) return parts.join(' · ');
    // Non-compact: time on its own line (bold), the rest stacked.
    const head = (st.fields.time && h.time) ? '<div class="cd-jcal__ev-time">' + esc(h.time) + '</div>' : '';
    const rest = parts.filter((_, i) => !(st.fields.time && h.time && i === 0));
    return head + rest.map((p) => '<div class="cd-jcal__ev-line">' + p + '</div>').join('');
  }

  function columnsHtml() {
    const days = currentDays();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let cols = '';
    for (const d of days) {
      const list = st.byDay[keyOf(d)] || [];
      const isToday = sameDay(d, today);
      let evs = '';
      if (!list.length) evs = '<div class="cd-jcal__empty">אין דיונים</div>';
      else for (const h of list) evs += '<div class="cd-jcal__ev">' + eventLinesHtml(h, false) + '</div>';
      cols += '<div class="cd-jcal__col">' +
        '<div class="cd-jcal__colhead' + (isToday ? ' is-today' : '') + '">' +
          HE_WEEK_SHORT[d.getDay()] + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) +
          (list.length ? ' <span class="cd-jcal__badge">' + list.length + '</span>' : '') +
        '</div>' +
        '<div class="cd-jcal__events">' + evs + '</div>' +
      '</div>';
    }
    return '<div class="cd-jcal__cols" style="grid-template-columns:repeat(' + days.length + ',1fr)">' + cols + '</div>';
  }

  function monthHtml() {
    const a = st.anchor;
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const gridStart = startOfWeek(first);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    // ONE grid for the day-name header AND the day cells, so the 7 columns line
    // up exactly (the header is the first row; cells flow after it).
    let cells = HE_WEEK_SHORT.map((n) => '<div class="cd-jcal__mhead">' + n + '</div>').join('');
    // Render a fixed 6-week (42-cell) grid; out-of-month days are dimmed.
    let cur = new Date(gridStart.getTime());
    for (let i = 0; i < 42; i++) {
      const inMonth = cur.getMonth() === a.getMonth();
      const list = st.byDay[keyOf(cur)] || [];
      const isToday = sameDay(cur, today);
      let chips = '';
      const shown = list.slice(0, 4);
      for (const h of shown) chips += '<div class="cd-jcal__chip">' + eventLinesHtml(h, true) + '</div>';
      if (list.length > shown.length) chips += '<div class="cd-jcal__more">+' + (list.length - shown.length) + ' נוספים</div>';
      cells += '<div class="cd-jcal__cell' + (inMonth ? '' : ' is-out') + (isToday ? ' is-today' : '') + '">' +
        '<div class="cd-jcal__cell-day">' + cur.getDate() + '</div>' + chips + '</div>';
      cur = addDays(cur, 1);
    }
    return '<div class="cd-jcal__month">' + cells + '</div>';
  }

  CD.openJudgeCalendar = open;
  CD.closeJudgeCalendar = close;
})(typeof window !== 'undefined' ? window : self);
