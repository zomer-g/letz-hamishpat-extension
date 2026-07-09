// content/case-open.js — "quick open a case" convenience.
//
// Net HaMishpat's own "איתור תיק" bar splits a case number across two fields:
// a serial ("39163") and a month-year ("07-22", MM-YY). This lets the user
// paste the whole thing into ONE field in any format (39163-07-22, 39163/07/2022,
// ת"א 39163-07-22, …); we parse it (CD.parseCaseLocator), fill the site's real
// fields, and click "אתר" — which the page turns into a normal postback that
// opens the case.
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

  // ── message from the popup ───────────────────────────────────────────────
  try {
    if (w.chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, send) => {
        if (msg && msg.type === 'cd/quickOpenCase') { send(submitText(msg.text || '')); return true; }
      });
    }
  } catch (e) {}

  // ── in-page quick-open panel ─────────────────────────────────────────────
  const PANEL_ID = 'cd-caseopen-panel';

  function buildPanel() {
    const p = document.createElement('div');
    p.id = PANEL_ID;
    p.className = 'cd-panel cd-caseopen';
    p.dir = 'rtl';
    p.innerHTML =
      '<div class="cd-panel__bar">' +
        '<div class="cd-panel__title">🔎 איתור תיק מהיר</div>' +
        '<input class="cd-co__input" type="text" autocomplete="off" placeholder="למשל 39163-07-22" />' +
        '<button type="button" class="cd-panel__btn cd-panel__btn--primary cd-co__go">אתר</button>' +
      '</div>' +
      '<div class="cd-co__status" hidden></div>';
    const input = p.querySelector('.cd-co__input');
    const go = p.querySelector('.cd-co__go');
    const status = p.querySelector('.cd-co__status');
    function run() {
      const r = submitText(input.value);
      if (!r.ok) { status.hidden = false; status.textContent = r.error; }
      else { status.hidden = false; status.className = 'cd-co__status ok'; status.textContent = 'פותח…'; }
    }
    go.addEventListener('click', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
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
