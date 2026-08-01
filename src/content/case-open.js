// content/case-open.js — "quick open a case" convenience.
//
// Net HaMishpat's own "איתור תיק" bar splits a case number across two fields:
// a serial ("39163") and a month-year ("07-22", MM-YY). This lets the user
// paste the whole thing into ONE field in any format (39163-07-22, 39163/07/2022,
// ת"א 39163-07-22, …); we parse it (CD.parseCaseLocator), fill the site's real
// fields, and click "אתר" — which the page turns into a normal postback that
// opens the case.
//
// A second mode searches by "תיק מקור" (source case) instead: pick one of the
// portal's own source-case types from the closed list and give its number — we
// drive the site's dedicated screen for that (see submitExternal below).
//
// The quick-open field is offered two ways (per the user's request):
//   • in the toolbar popup (always), which messages the active court tab, and
//   • embedded on the page — inside the floating window (floating mode) or right
//     under the site's own locator bar (inline mode).
(function (w) {
  const CD = w.CD || (w.CD = {});

  // Any Net HaMishpat domain (public www, secure, securesso — regardless of how
  // the user authenticated: smart card, government identity, or none) where the
  // site's own case-locator bar is present. Gating on the bar (not a URL) is
  // what makes quick-open work across every domain.
  function onCourtPage() {
    return /(^|\.)court\.gov\.il$/i.test(location.hostname) && !!locateButton();
  }

  // A locator field, matched across BOTH of Net HaMishpat's locator controls:
  //   • secured header bar  → …CaseLocatorHeaderUC2_…BamaCaseNumberTextBox**HT**
  //   • public main locator → CaseLocatorUC1_…BamaCaseNumberTextBox**VT**
  // `base` is the field name WITHOUT the HT/VT variant suffix. Prefer the visible
  // instance if a page carries more than one.
  function pick(base) {
    const els = Array.prototype.slice.call(
      document.querySelectorAll('[id$="_' + base + 'HT"], [id$="_' + base + 'VT"]'));
    return els.find((e) => e.offsetParent) || els[0] || null;
  }

  // The locate/submit button. Its caption and id differ across the two locators:
  //   • secured header → caption "אתר" (id …Search / …SearchHeaderCaseButton)
  //   • public locator → caption "איתור" (id ButtonsGroup1_btnLocate)
  // Match by control family + either caption so both work.
  function locateButton() {
    const cands = Array.prototype.slice.call(
      document.querySelectorAll('[id*="CaseLocator"], [id*="btnLocate"], [id*="SearchHeaderCase"]'))
      .filter((e) => e.tagName === 'BUTTON' || e.tagName === 'A' || (e.tagName === 'INPUT' && /^(submit|button)$/i.test(e.type)));
    const vis = cands.filter((e) => e.offsetParent);
    const pool = vis.length ? vis : cands; // offsetParent is null under jsdom
    const cap = (e) => (e.value || e.textContent || '').trim();
    return pool.find((e) => /^(אתר|איתור)$/.test(cap(e)))
      || pool.find((e) => /btnLocate|SearchHeaderCase/i.test(e.id || ''))
      || pool[0] || null;
  }

  // The "סדרה" (numerator series) combo. When present, the site REJECTS the
  // locate with "חובה להזין ערך בשדה סדרה" if it's left on its empty placeholder,
  // so we must always land it on a real option. A full case number
  // (SERIAL-MM-YY) is a court file → prefer "תיק בית משפט"; fall back to value
  // "1", then the first selectable (non-placeholder) option.
  function setSeries(combo) {
    if (!combo || !combo.options || !combo.options.length) return;
    const real = Array.prototype.filter.call(combo.options, (o) => {
      const v = (o.value || '').trim(); return v && v !== '-1' && v !== '0';
    });
    if (!real.length) return;
    const opt = real.find((o) => /תיק\s*בית\s*משפט/.test(o.text || '')) ||
                real.find((o) => o.value === '1') || real[0];
    combo.value = opt.value;
    try { combo.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  }

  // Fill the site's locator fields for `parts` and submit. Returns {ok} / {ok:false,error}.
  function locate(parts) {
    const serial = pick('BamaCaseNumberTextBox');
    const monthYear = pick('BamaMonthYearTextBox');
    const btn = locateButton();
    if (!serial || !monthYear || !btn) {
      return { ok: false, error: 'שורת "איתור תיק" לא נמצאה בעמוד זה — נסה/י מעמוד אחר בנט המשפט.' };
    }
    const radio = pick('BamaCaseIdentifierOptionBox');   // "תיק חדש" (by number)
    const combo = pick('NumeratorGroupTypeComboBox');    // the "סדרה" field
    if (radio) { radio.checked = true; try { radio.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
    setSeries(combo);
    serial.value = parts.serial;
    monthYear.value = parts.month + '-' + parts.year2;      // the field is MM-YY (maxlen 5)
    [serial, monthYear].forEach((el) => {
      try { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    });
    btn.click(); // native submit → the page's own postback opens the case
    return { ok: true };
  }

  // Parse free-form text then locate. Exposed for the popup message handler + UI.
  function submitText(text) {
    const parts = CD.parseCaseLocator ? CD.parseCaseLocator(text) : null;
    if (!parts) return { ok: false, error: 'מספר תיק לא תקין. דוגמה: 39163-07-22' };
    return locate(parts);
  }
  CD.caseOpenSubmit = submitText;

  // ── search by "תיק מקור" (source / external case number) ─────────────────
  // The portal has a dedicated screen for it — איתור תיקים → "תיקים לפי מס' תיק
  // מקור" (SearchCase/CasesSearchExternalView.aspx): a closed "סוג תיק מקור"
  // list (#ExternalCaseTypeIDDropDown), a number field (#ExternalCaseNumber) and
  // an "אישור" postback link (#buttonsGroup_searchButton). Quick-locate drives
  // that screen: when we're already on it we fill and submit directly; from any
  // other page we stash the query in sessionStorage, walk the site's own menu
  // link there (an ASP.NET postback, so the session is preserved), and replay
  // the query once the new page boots this script again.
  const EXT_PAGE_RE = /CasesSearchExternalView\.aspx/i;
  const EXT_PENDING = 'cd_extsearch';   // a query waiting for the screen to load
  const EXT_DONE = 'cd_extdone';        // a query we just submitted, for feedback
  let extNote = null;                   // what to tell the user in the panel

  function fire(el, type) {
    try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) {}
  }

  // ASP.NET postback, run the way the page itself would. We CAN'T just .click()
  // these controls: unlike the locator's "אתר" (a real <input type=submit>),
  // both "אישור" on the source-case screen and the menu link are <a> elements
  // whose href is a `javascript:` URL. A click from a content script runs that
  // URL in OUR isolated world, where the page's __doPostBack /
  // WebForm_DoPostBackWithOptions simply don't exist — the click appears to work
  // and silently does nothing (fields filled, no search). Setting the two hidden
  // fields and submitting the real form produces the identical request.
  // Bonus: it skips the form's onsubmit client validation, which the server
  // re-runs anyway.
  // The value ASP.NET expects in __EVENTTARGET for `el`, read out of the very
  // attribute the site itself uses: href/onclick on the buttons, onchange on the
  // AutoPostBack fields (where the call is nested in a setTimeout string, hence
  // the escaped quotes). Form fields fall back to their own control name, which
  // is exactly what __doPostBack would have been handed.
  function postbackTarget(el, fieldFallback) {
    const src = ['href', 'onclick', 'onchange'].map((a) => el.getAttribute(a) || '').join(';');
    const m = src.match(/__doPostBack\(\s*\\?['"]([^'"\\]+)/) ||
              src.match(/WebForm_PostBackOptions\(\s*\\?['"]([^'"\\]+)/);
    if (m) return m[1];
    return fieldFallback ? (el.name || el.id || null) : null;
  }
  // Last resort: hand the postback to the page's OWN __doPostBack by running it
  // in the main world. Only used if submitting the form didn't navigate.
  function mainWorldPostback(target) {
    try {
      const s = document.createElement('script');
      s.textContent = '__doPostBack(' + JSON.stringify(target) + ',"")';
      (document.body || document.documentElement).appendChild(s);
      s.remove();
      return true;
    } catch (e) { return false; }
  }
  // Submit `el`'s postback. Falls back to a plain click for real submit buttons
  // (and for anything we can't parse a target out of).
  function pressPostback(el, fieldFallback) {
    if (!el) return false;
    const target = postbackTarget(el, fieldFallback);
    const evTarget = document.querySelector('input[name="__EVENTTARGET"]');
    const evArg = document.querySelector('input[name="__EVENTARGUMENT"]');
    const form = (evTarget && evTarget.form) || document.forms[0];
    if (target && evTarget && form) {
      evTarget.value = target;
      if (evArg) evArg.value = '';
      try {
        form.submit();
        // If this document is still alive later, the submit never navigated.
        setTimeout(() => mainWorldPostback(target), 3000);
        return true;
      } catch (e) {}
    }
    try { el.click(); return true; } catch (e) {}
    return false;
  }
  function extTypeSelect() {
    return document.getElementById('ExternalCaseTypeIDDropDown') ||
           document.querySelector('select[id$="ExternalCaseTypeIDDropDown"]');
  }
  function extNumberField() {
    return document.getElementById('ExternalCaseNumber') ||
           document.querySelector('input[id$="ExternalCaseNumber"]');
  }
  // The screen's "אישור" trigger — an <a> running a WebForm postback.
  function extSearchButton() {
    const byId = document.querySelector('#buttonsGroup_searchButton, [id$="_searchButton"]');
    if (byId) return byId;
    const cands = Array.prototype.slice.call(
      document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
    return cands.find((e) => /^אישור$/.test((e.value || e.textContent || '').trim())) || null;
  }

  // Which option of the "סוג תיק מקור" combo `typeId` means. Match on the site's
  // own option value first; fall back to the caption so a renumbering on their
  // side doesn't break us (quotes/spaces are normalized away — דו"ח vs דו״ח).
  function extTypeOptionValue(sel, typeId) {
    const t = CD.externalCaseType ? CD.externalCaseType(typeId) : null;
    const opts = Array.prototype.slice.call(sel.options || []);
    const norm = (s) => String(s || '').replace(/["'״׳\s()]/g, '');
    const opt = opts.find((o) => (o.value || '').trim() === String(typeId)) ||
                (t && opts.find((o) => norm(o.text) === norm(t.label))) || null;
    return opt ? opt.value : null;
  }

  function readPending() {
    try { return JSON.parse(sessionStorage.getItem(EXT_PENDING) || 'null'); } catch (e) { return null; }
  }
  function writePending(q) {
    try { sessionStorage.setItem(EXT_PENDING, JSON.stringify(q)); return true; } catch (e) { return false; }
  }
  function clearPending() {
    try { sessionStorage.removeItem(EXT_PENDING); } catch (e) {}
    if (CD.extVeilHide) CD.extVeilHide();   // nothing in flight → uncover the page
  }

  // Move the stashed query ONE step forward, then let the page reload.
  //
  // Both criteria fields are AutoPostBack controls —
  //   onchange="…__doPostBack('ExternalCaseTypeIDDropDown','')"
  //   onchange="…__doPostBack('ExternalCaseNumber','')"
  // — and the server builds the query from those round-trips, not from whatever
  // rides along with the final "אישור". Filling both fields and pressing אישור
  // in one shot posts perfectly valid data and comes back with 0 results even
  // for a case that exists (verified against a real פל"א). So we reproduce the
  // site's own sequence: type → postback, number → postback, then אישור. Each
  // step is a full page load, so the step is chosen from what's already on the
  // screen rather than from a counter — restarts and stray reloads can't
  // desynchronize it.
  function advanceExternal() {
    const q = readPending();
    if (!q) return { ok: false, error: 'לא נמצאה בקשת חיפוש.' };
    const sel = extTypeSelect();
    const num = extNumberField();
    const btn = extSearchButton();
    if (!sel || !num || !btn) {
      return { ok: false, error: 'מסך "תיקים לפי מס\' תיק מקור" עדיין לא נטען — נסה/י שוב.' };
    }
    const want = extTypeOptionValue(sel, q.type);
    if (!want) { clearPending(); return { ok: false, error: 'סוג תיק המקור אינו קיים ברשימת האתר.' }; }
    q.at = Date.now();
    // Each field gets at most two attempts: if a value still doesn't read back
    // (the site may normalize what we typed) we move on rather than loop.
    if (sel.value !== want && (q.typeTries || 0) < 2) {          // step 1 — the type
      sel.value = want;
      q.typeTries = (q.typeTries || 0) + 1;
      writePending(q);
      return pressPostback(sel, true) ? { ok: true } : { ok: false, error: 'לא ניתן לעדכן את סוג תיק המקור.' };
    }
    if (String(num.value).trim() !== q.num && (q.numTries || 0) < 2) {  // step 2 — the number
      num.value = q.num;
      q.numTries = (q.numTries || 0) + 1;
      writePending(q);
      return pressPostback(num, true) ? { ok: true } : { ok: false, error: 'לא ניתן לעדכן את מספר תיק המקור.' };
    }
    // step 3 — both criteria are registered with the site: run the search.
    clearPending();
    // An empty result grid looks exactly like a screen that was merely filled
    // in, so record what ran and report the count after the reload.
    try { sessionStorage.setItem(EXT_DONE, JSON.stringify({ type: q.type, num: q.num, at: Date.now() })); } catch (e) {}
    if (!pressPostback(btn)) {
      try { sessionStorage.removeItem(EXT_DONE); } catch (e) {}
      return { ok: false, error: 'לא ניתן להפעיל את החיפוש במסך זה.' };
    }
    return { ok: true };
  }

  // How many rows the site says it found — its pager reads "0 עד 0 מתוך 12".
  function extResultCount() {
    const body = document.body || null;
    const text = (body && (body.innerText || body.textContent)) || '';
    const m = text.replace(/\s+/g, ' ').match(/\d+\s+עד\s+\d+\s+מתוך\s+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  // Read back the query we submitted before this page load and phrase the result.
  function reportExternalResult() {
    if (!EXT_PAGE_RE.test(location.pathname)) return;
    let done = null;
    try { done = JSON.parse(sessionStorage.getItem(EXT_DONE) || 'null'); } catch (e) {}
    if (!done) return;
    try { sessionStorage.removeItem(EXT_DONE); } catch (e) {}
    if (done.at && Date.now() - done.at > 120000) return;
    const t = CD.externalCaseType ? CD.externalCaseType(done.type) : null;
    const what = (t ? t.label + ' ' : '') + done.num;
    const n = extResultCount();
    extNote = {
      type: done.type,
      num: done.num,
      text: n === null ? 'החיפוש בוצע: ' + what
          : n === 0 ? 'לא נמצאו תיקים עבור ' + what
          : 'נמצאו ' + n + ' תיקים עבור ' + what,
      ok: n === null || n > 0,
    };
  }

  // The header menu's "תיקים לפי מס' תיק מקור" entry. Matched by control name
  // first (stable across both domains) and by caption as a backstop.
  function externalMenuLink() {
    const byId = document.querySelector('a[id$="btnExternalSearchCases"], a[href*="btnExternalSearchCases"]');
    if (byId) return byId;
    return Array.prototype.slice.call(document.querySelectorAll('a[href*="__doPostBack"]'))
      .find((a) => /תיק\s*מקור/.test(a.textContent || '')) || null;
  }
  // Same app root as the current page: /NGCS.Web.Site/… (public) or
  // /Ngcs.Web.Secured/… (authenticated). LAST resort only — a plain GET to that
  // screen is bounced back to the home page unless the site's own postback took
  // us there, so we only try it when the menu link is missing entirely.
  function externalPageUrl() {
    const app = (location.pathname.split('/')[1] || '').trim();
    return app ? location.origin + '/' + app + '/SearchCase/CasesSearchExternalView.aspx' : null;
  }
  function gotoExternalPage() {
    const link = externalMenuLink();
    if (link && pressPostback(link)) return true;
    const url = externalPageUrl();
    if (url) { location.assign(url); return true; }
    return false;
  }

  // Public entry: search by source-case type + number, from any portal page.
  // The query is always stashed first — it takes several page loads to play out
  // (see advanceExternal), whether or not we start on the right screen.
  function submitExternal(typeId, rawNum) {
    const t = CD.externalCaseType ? CD.externalCaseType(typeId) : null;
    if (!t) return { ok: false, error: 'בחר/י סוג תיק מקור.' };
    const num = String(rawNum == null ? '' : rawNum).trim();
    if (!num) return { ok: false, error: 'יש להזין מספר תיק מקור (' + t.label + ').' };
    if (!writePending({ type: t.id, num: num, at: Date.now() })) {
      return { ok: false, error: 'הדפדפן חוסם אחסון מקומי — לא ניתן להעביר את החיפוש.' };
    }
    // Cover the page for the whole sequence — the intermediate postbacks would
    // otherwise flash a half-filled search form at the user (content/ext-busy.js
    // re-raises the veil on each of those loads).
    if (CD.extVeilShow) CD.extVeilShow('מחפש ' + t.label + ' ' + num + '…');
    if (EXT_PAGE_RE.test(location.pathname)) {
      const r = advanceExternal();
      if (!r.ok) clearPending();
      return r;
    }
    if (gotoExternalPage()) return { ok: true, navigating: true };
    clearPending();
    return { ok: false, error: 'לא נמצא הקישור "תיקים לפי מס\' תיק מקור" בעמוד זה.' };
  }
  CD.caseOpenSubmitExternal = submitExternal;

  // The pieces of the source-case screen, shared with the bulk runner
  // (content/ext-bulk.js) so the two features drive the site the same way.
  CD.extSearchApi = {
    onScreen: () => EXT_PAGE_RE.test(location.pathname),
    goto: gotoExternalPage,
    typeSelect: extTypeSelect,
    numberField: extNumberField,
    searchButton: extSearchButton,
    optionValue: extTypeOptionValue,
    press: pressPostback,
  };

  // Carry a stashed query one step further on every load of the screen, until
  // advanceExternal runs the search and clears it.
  function consumePendingExternal() {
    if (!EXT_PAGE_RE.test(location.pathname)) return;
    const q = readPending();
    if (!q || !q.type || !q.num) return;
    // Only follow through on a query the user just made: if a step went astray
    // the stash must not wake up on some later, unrelated visit to this screen.
    if (q.at && Date.now() - q.at > 90000) { clearPending(); return; }
    let tries = 0;
    (function attempt() {
      if (advanceExternal().ok) return;
      if (++tries < 8) setTimeout(attempt, 400); // the screen can render late
      else clearPending();
    })();
  }

  // ── message from the popup ───────────────────────────────────────────────
  try {
    if (w.chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, send) => {
        if (msg && msg.type === 'cd/quickOpenCase') {
          send(msg.externalType ? submitExternal(msg.externalType, msg.text || '')
                                : submitText(msg.text || ''));
          return true;
        }
      });
    }
  } catch (e) {}

  // ── in-page quick-open panel ─────────────────────────────────────────────
  const PANEL_ID = 'cd-caseopen-panel';

  const NUMBER_PLACEHOLDER = 'למשל 39163-07-22';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.id = PANEL_ID;
    p.className = 'cd-panel cd-caseopen';
    p.dir = 'rtl';
    // The "חיפוש לפי" combo keeps the default (paste a case number, as before)
    // as its first option; the rest is the site's own closed "סוג תיק מקור" list.
    const typeOptions = ['<option value="">מספר תיק</option>'].concat(
      (CD.EXTERNAL_CASE_TYPES || []).map((t) =>
        '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>')).join('');
    p.innerHTML =
      '<div class="cd-panel__bar">' +
        '<div class="cd-panel__title">🔎 איתור תיק מהיר</div>' +
        '<select class="cd-co__type" title="חיפוש לפי — מספר תיק או סוג תיק מקור">' + typeOptions + '</select>' +
        '<input class="cd-co__input" type="text" autocomplete="off" placeholder="' + NUMBER_PLACEHOLDER + '" />' +
        '<button type="button" class="cd-panel__btn cd-panel__btn--primary cd-co__go">אתר</button>' +
      '</div>' +
      '<div class="cd-co__status" hidden></div>';
    const type = p.querySelector('.cd-co__type');
    const input = p.querySelector('.cd-co__input');
    const go = p.querySelector('.cd-co__go');
    const status = p.querySelector('.cd-co__status');
    function say(text, ok) {
      status.hidden = !text;
      status.className = 'cd-co__status' + (ok ? ' ok' : '');
      status.textContent = text || '';
    }
    type.addEventListener('change', () => {
      input.placeholder = type.value ? 'מספר תיק מקור' : NUMBER_PLACEHOLDER;
      // Collapsed to a chevron on the default mode, labelled once a type is on.
      type.classList.toggle('is-picked', !!type.value);
      say('');
    });
    function run() {
      const kind = type.value;
      const r = kind ? submitExternal(kind, input.value) : submitText(input.value);
      if (!r.ok) say(r.error);
      else say(kind ? 'מחפש תיק מקור…' : 'פותח…', true);
    }
    go.addEventListener('click', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    // Carry the finished source-case search over the page load that ran it, so
    // the panel shows what was searched and how many cases came back.
    if (extNote) {
      type.value = extNote.type;
      type.classList.add('is-picked');
      input.placeholder = 'מספר תיק מקור';
      input.value = extNote.num;
      say(extNote.text, extNote.ok);
    }
    return p;
  }

  // Inline host — a shared flex ROW inserted as a new <tr> right AFTER the
  // site's header row (the page layout is one big table). Mounting INSIDE the
  // header cell (the old approach) inflated its height and made the site's own
  // locator strip ride over the menu row above it. A fresh row below the whole
  // header can't disturb the header's layout, and the flex wrapper lets the
  // quick-locate and favorites panels sit SIDE-BY-SIDE on wide screens and
  // stack on narrow ones. Shared with favorites.js via CD.toolsRow().
  function findHeaderRow() {
    const btn = locateButton();
    if (!btn) return null;
    // Prefer the named outer header row; else the widest TR ancestor.
    const named = btn.closest('tr[id*="tr_Header" i]');
    if (named) return named;
    const vw = document.documentElement.clientWidth || 1200;
    let el = btn.parentElement, best = null;
    for (let i = 0; i < 16 && el && el !== document.body; i++) {
      if (el.tagName === 'TR' && el.getBoundingClientRect &&
          el.getBoundingClientRect().width >= vw * 0.6) best = el;
      el = el.parentElement;
    }
    return best;
  }
  function toolsRow() {
    let row = document.getElementById('cd-tools-row');
    if (row && row.isConnected) return row;
    const tr = findHeaderRow();
    if (!tr || !tr.parentElement) return null;
    const newTr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 40;
    row = document.createElement('div');
    row.id = 'cd-tools-row';
    row.dir = 'rtl';
    td.appendChild(row);
    newTr.appendChild(td);
    tr.parentElement.insertBefore(newTr, tr.nextSibling);
    return row;
  }
  CD.toolsRow = toolsRow;
  // Legacy fallback (non-table pages): the widest cell/block ancestor.
  function findInlineHost() {
    const btn = locateButton();
    if (!btn) return null;
    const vw = document.documentElement.clientWidth || 1200;
    let el = btn.parentElement;
    for (let i = 0; i < 14 && el && el !== document.body; i++) {
      const w = el.getBoundingClientRect ? el.getBoundingClientRect().width : 0;
      if (w >= vw * 0.5 && /^(TD|DIV|SECTION|FORM)$/.test(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function ensureMounted() {
    if (!onCourtPage()) return;
    const floating = !!(CD.uiFloating && CD.uiFloating());
    const existing = document.getElementById(PANEL_ID);
    if (existing && existing.isConnected) {
      // Already mounted — but the UI config can load a beat AFTER boot (async),
      // so relocate if the current mode no longer matches where the panel sits.
      const inFloat = !!existing.closest('#cd-float');
      if (inFloat === floating) return;
      existing.remove();
    } else if (existing) {
      existing.remove();
    }
    const panel = buildPanel();
    // Both appearance configurations must be supported (see the dual-config
    // rule): floating → the "כלי נט המשפט" window; inline → a full-width strip
    // appended into the header cell that holds the site's own locator bar.
    if (floating) {
      if (CD.floatBody) { CD.floatBody().appendChild(panel); return; }
    } else {
      const row = toolsRow();
      // Quick-locate always goes FIRST in the shared row (favorites after it).
      if (row) { row.insertBefore(panel, row.firstChild); return; }
      const host = findInlineHost();
      if (host) { host.appendChild(panel); return; }
    }
    // Fallback: the floating window (kept visible below), never a broken strip.
    if (CD.floatBody) {
      CD.floatBody().appendChild(panel);
      const win = document.getElementById('cd-float');
      if (win && win.children.length) win.style.display = '';
    } else (document.body || document.documentElement).appendChild(panel);
  }

  function boot() {
    // Before the panel gate: a source-case search stashed on the previous page
    // must replay here even if the quick-locate bar can't mount on this screen.
    reportExternalResult();   // …and a search that already ran gets reported
    consumePendingExternal();
    if (!onCourtPage()) return;
    ensureMounted();
    // The site header (with the locator bar) can render a beat after idle, and
    // full-page postbacks reload the script anyway — a few retries cover the gap.
    let n = 0;
    const iv = setInterval(() => { ensureMounted(); if (++n >= 6) clearInterval(iv); }, 800);
    try { new MutationObserver(() => ensureMounted()).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    // The appearance setting can change live — relocate inline↔floating.
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.cd_settings) setTimeout(ensureMounted, 0);
      });
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : self);
