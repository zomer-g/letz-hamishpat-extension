// header-sync.js — a global "sync my hearings to Google Calendar" button.
//
// Runs on EVERY secured net-hamishpat page (not just the hearings list), and
// injects a button into the top header next to the username / "יציאה" link.
// One click runs a self-driving job that:
//   1. navigates to "הדיונים שלי / דיונים של המשרד" via the site's own menu
//      postback (if we're not already there),
//   2. sets the date range to today … +N months (N from settings, default 12),
//      and runs the report,
//   3. collects every hearing (paging through the grid),
//   4. upserts them into the configured Google Calendar (stable iCalUID, so
//      re-syncs update instead of duplicating),
//   5. stores + shows the last-sync timestamp under the button.
//
// The job lives in sessionStorage so it survives the full-page postbacks the
// site performs between steps; this script re-runs on each load and resumes.

(function () {
  const w = window;
  if (/\/Viewer\/NGCSViewerPage\.aspx/i.test(location.pathname)) return; // not on the doc viewer

  const CD = w.CD || {};
  const adapter = CD.adapters && CD.adapters['net-court-hearings'];
  if (!adapter) return;

  const JOB_KEY = 'cd_global_calsync';
  // The extension's "home" page on z-g.co.il — the clickable jester brand opens it.
  const JESTER_URL = 'https://www.z-g.co.il/court-downloader';
  let settings = null;
  let handledThisLoad = false;
  // Declared up here (not next to installToggleDelegation) because init() — which
  // calls installToggleDelegation() — runs at the top of this IIFE, before the
  // later `let` lines execute. A `let` declared lower would be in the temporal
  // dead zone at that point and throw, aborting the whole script (no toggle/hat).
  let toggleDelegated = false;
  let lastToggleAt = 0; // debounce so a direct listener + the delegation don't double-fire
  const els = {};

  // Candidate menu labels for the firm/litigant hearings view.
  const MENU_LABELS = ['הדיונים שלי', 'דיונים של המשרד', 'דיונים לעורך דין', 'יומן בעל דין'];

  init();

  let decorRaf = false;

  function init() {
    installToggleDelegation();   // bulletproof click handling for the toggle
    loadSettingsThen(() => {
      decorate();
      // Resume an in-flight job after a postback reload.
      if (readJob() && readJob().active) { reflectBusy(true); pump(); }
      else reflectIdle();
    });
    // Re-apply decorations if the site re-renders its header (idempotent —
    // only inserts when something is missing, so no flicker loop).
    try {
      const obs = new MutationObserver(() => {
        if (decorRaf) return;
        decorRaf = true;
        requestAnimationFrame(() => { decorRaf = false; decorate(); });
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  // Perch the clown hat + jester brand tag on the logo (every page), and show
  // the Google-sync button only on the pages where syncing one's own hearings
  // makes sense. The original logo/text/gradient are left untouched.
  function decorate() {
    applyEnabledClass();    // reflect on/off across the whole page (hides UI when off)
    stripSiteTooltips();    // drop the site's lingering "מתעדכן…" envelope tooltip
    ensureHat();            // clown hat on the logo (CSS hides it when off)
    ensureToggle();         // the "לץ המשפט" on/off switch — on EVERY page
    // Create the sync button on its pages REGARDLESS of on/off, so its layout
    // space is always reserved and the toggle next to it never jumps. When off,
    // CSS hides it with visibility:hidden (invisible but keeps its width).
    if (syncButtonAllowed()) ensureButton();
    else if (!(readJob() && readJob().active)) removeButton();
  }

  // ── master on/off switch ───────────────────────────────────────────────
  // The whole extension can be turned on/off live from the "לץ המשפט" header
  // button. State lives in settings.enabled and is mirrored onto <html> as the
  // class `cd-ext-off`; toolbar.css uses that class to hide every injected
  // widget (panels, checkboxes, sync button, clown hat, …) — leaving only the
  // toggle itself, so the user can switch it back on. Persisted in
  // chrome.storage, so it applies on every page of the domain and across tabs.
  function isEnabled() { return !(settings && settings.enabled === false); }

  function applyEnabledClass() {
    try { document.documentElement.classList.toggle('cd-ext-off', !isEnabled()); } catch (e) {}
  }

  function toggleEnabled() {
    // Coalesce double-calls: the same click can reach both the element's direct
    // listener and the document-level delegation; flip the switch only once.
    const now = Date.now();
    if (now - lastToggleAt < 500) return; // coalesce pointerdown + click of one press
    lastToggleAt = now;
    const next = !isEnabled();
    if (!settings) settings = {};
    settings.enabled = next;
    applyEnabledClass();
    reflectToggle();
    decorate();
    flashToast(next);
    if (w.CD && w.CD.saveSettings) { try { w.CD.saveSettings({ enabled: next }); } catch (e) {} }
  }

  // Single document-level capture delegation for the toggle. Survives the site
  // re-rendering / replacing the header (and the toggle element) between a real
  // click's mousedown and mouseup — the per-element listener could miss that.
  // (toggleDelegated is declared near the top of the IIFE — see note there.)
  function installToggleDelegation() {
    if (toggleDelegated) return;
    toggleDelegated = true;
    // ONLY pointerdown, and it NEVER calls preventDefault/stopPropagation — so it
    // fires the toggle on a genuine toggle hit and can NEVER interfere with any
    // other control (e.g. the sync button). click/keydown are handled by the
    // direct listeners bound on the element itself (see ensureToggle).
    document.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('#cd-jester-toggle')) toggleEnabled();
    }, true);
  }

  // Brief centered confirmation so the toggle is unmistakably responsive. Uses a
  // non-cd id + inline styles so it isn't hidden by the html.cd-ext-off rule.
  function flashToast(on) {
    try {
      let el = document.getElementById('jtoast');
      if (!el) { el = document.createElement('div'); el.id = 'jtoast'; (document.body || document.documentElement).appendChild(el); }
      el.textContent = on ? '🤡 לץ המשפט — הופעל' : '⏸ לץ המשפט — כובה';
      el.setAttribute('style', 'position:fixed;top:64px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483647;background:' + (on ? '#1b7a34' : '#9c2a2a') + ';color:#fff;' +
        'font:800 17px Arial,"Arial Hebrew",sans-serif;padding:13px 26px;border-radius:10px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.4);direction:rtl;pointer-events:none;opacity:1;transition:opacity .5s;');
      clearTimeout(el._t1); clearTimeout(el._t2);
      el.style.opacity = '1';
      el._t1 = setTimeout(function () { el.style.opacity = '0'; }, 2600);
      el._t2 = setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
    } catch (e) {}
  }

  // Anchor for the toggle: prefer the "יציאה" (logout) link, so the toggle sits
  // on the far side of the user strip — well away from the sync button (by the
  // envelope). Falls back to findHeaderAnchor.
  function toggleAnchor() {
    let logout = document.querySelector('a[id*="Exit"], a[id*="Logout"], a[id*="Logoff"], a[id*="LogOff"], a[id*="webbtnLogout"]');
    if (!logout) {
      for (const a of document.querySelectorAll('#Header1_Table a, header a, a')) {
        if ((a.textContent || '').trim() === 'יציאה') { logout = a; break; }
      }
    }
    if (logout && logout.parentElement) return { el: logout, pos: 'before' };
    return findHeaderAnchor();
  }

  // Place the toggle in the site's top user strip, on every page — a normal spot
  // that never covers the logo. Falls back to a small fixed pill if no strip.
  function ensureToggle() {
    let t = document.getElementById('cd-jester-toggle');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cd-jester-toggle';
      t.dir = 'rtl';
      t.setAttribute('role', 'switch');
      t.tabIndex = 0;
      // A clear ON/OFF switch: clown + brand + a sliding switch track + state word.
      t.innerHTML = '<span class="jt-ico">🤡</span>' +
        '<span class="jt-name">לץ המשפט</span>' +
        '<span class="jt-switch" aria-hidden="true"><span class="jt-knob"></span></span>' +
        '<span class="jt-state"></span>';
    }
    // Direct listener on the element — the SAME pattern as the (working) sync
    // button. A document-level delegation is ALSO installed (survives the
    // element being re-created); toggleEnabled() debounces so the two together
    // never double-fire. Guarded so we bind once per element.
    if (!t.dataset.cdBound) {
      t.dataset.cdBound = '1';
      t.addEventListener('click', function (e) { e.preventDefault(); toggleEnabled(); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEnabled(); }
      });
    }
    // Inline in the header user-strip, anchored near "יציאה" (logout) — SEPARATE
    // from the sync button (which sits by the envelope), so the toggle can never
    // overlap or steal the sync button's clicks. The on/off jump is avoided by
    // reserving the sync button's space when off (see decorate + toolbar.css).
    const anchor = toggleAnchor();
    if (anchor && anchor.el.parentElement) {
      // Authenticated pages: inline next to "יציאה".
      t.classList.remove('cd-jt--fixed');
      t.classList.remove('cd-jt--inheader');
      const ref = anchor.pos === 'after' ? anchor.el.nextSibling : anchor.el;
      if (t.parentElement !== anchor.el.parentElement || t.nextSibling !== ref) {
        anchor.el.parentElement.insertBefore(t, ref);
      }
    } else {
      // No user strip (e.g. the PUBLIC portal, before login). Anchor it INSIDE
      // the header table (which exists on every page), absolutely positioned at
      // the top-left of the header strip — the empty area where the user strip
      // would be — so it stays aligned with the (centered) header rather than
      // floating in the page margin.
      const tbl = headerTableEl();
      if (tbl) {
        t.classList.remove('cd-jt--fixed');
        t.classList.add('cd-jt--inheader');
        if (getComputedStyle(tbl).position === 'static') tbl.style.position = 'relative';
        if (t.parentElement !== tbl) tbl.appendChild(t);
      } else {
        // No header table either — last-resort fixed pill (always visible).
        t.classList.remove('cd-jt--inheader');
        t.classList.add('cd-jt--fixed');
        if (t.parentElement !== document.body && (document.body || document.documentElement)) {
          (document.body || document.documentElement).appendChild(t);
        }
      }
    }
    reflectToggle();
  }

  // The site puts a native title ("מתעדכן מספר פעמים בשעה") on the messages
  // envelope; it lingers over our toggle area and the user finds it noise.
  // Drop that one title (cosmetic, harmless).
  function stripSiteTooltips() {
    try {
      document.querySelectorAll('table.HeaderHomePage [title], #Header1_Table [title], header [title]').forEach((el) => {
        if (el.id === 'cd-jester-toggle') return;
        if ((el.getAttribute('title') || '').indexOf('מתעדכן') !== -1) el.removeAttribute('title');
      });
    } catch (e) {}
  }

  function reflectToggle() {
    const t = document.getElementById('cd-jester-toggle');
    if (!t) return;
    const on = isEnabled();
    t.classList.toggle('cd-jester-toggle--on', on);
    t.classList.toggle('cd-jester-toggle--off', !on);
    t.setAttribute('aria-checked', on ? 'true' : 'false');
    const st = t.querySelector('.jt-state');
    if (st) st.textContent = on ? 'פועל' : 'כבוי';
    // aria-label, not title — avoids a native tooltip stacking with the others.
    t.setAttribute('aria-label', on
      ? 'לץ המשפט פעיל — לחץ/י לכיבוי התוסף בכל האתר'
      : 'התוסף כבוי — לחץ/י להפעלה');
  }

  // The Google-calendar sync button appears only on the three pages where the
  // user's own hearings live: the private personal area, the lawyer home page,
  // and the lawyer "my hearings" report. (Hat + brand tag remain everywhere.)
  function syncButtonAllowed() {
    const p = location.pathname || '';
    return /\/PersonalAreaPage\.aspx/i.test(p) ||
      /\/LawyerHomePage\.aspx/i.test(p) ||
      /\/Reports\/ReportLawyerSittingsQueryView\.aspx/i.test(p);
  }
  function removeButton() {
    const b = document.getElementById('cd-hsync');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  // Add the uniform bottom-gradient band (masks the header image's diagonal
  // seam) and the colorful clown hat on the logo. Both are CSS elements
  // appended to the header table; styling lives in toolbar.css.
  // The header table's id varies by page (Header1_Table on some, _ctl0_Header_Table
  // on others, e.g. the decisions screen) — but it always carries the
  // HeaderHomePage class. Match flexibly so the hat shows on EVERY page.
  function headerTableEl() {
    return document.getElementById('Header1_Table') ||
      document.querySelector('table.HeaderHomePage') ||
      document.querySelector('table[id$="Header_Table"]');
  }
  function ensureHat() {
    const tbl = headerTableEl();
    if (!tbl) return;
    if (!document.getElementById('cd-hdr-fix')) {
      const f = document.createElement('div');
      f.id = 'cd-hdr-fix';
      tbl.appendChild(f);
    }
    // The clown hat is optional (settings.ui.showClownHat, default on). The
    // header gradient band above stays regardless.
    const showHat = !(w.CD && w.CD.uiShowClownHat) || w.CD.uiShowClownHat();
    const existingHat = document.getElementById('cd-lg-hat');
    if (!showHat) { if (existingHat) { try { existingHat.remove(); } catch (e) {} } return; }
    if (!existingHat) {
      const h = document.createElement('a');
      h.id = 'cd-lg-hat';
      h.href = JESTER_URL;
      h.target = '_blank';
      h.rel = 'noopener';
      // aria-label (not title) so the browser/site doesn't pop a native tooltip
      // that would crowd the header next to the toggle + sync button.
      h.setAttribute('aria-label', 'לץ המשפט — פתח/י את עמוד התוסף');
      h.innerHTML = buildHatSvg();
      tbl.appendChild(h);
    }
  }

  // A realistic clown/party hat as inline SVG: rainbow stripes converging at
  // the apex, a soft-gradient + fuzzy red pom-pom on top, a yellow pom-pom
  // fringe at the base, and a glossy sheen down one side.
  function buildHatSvg() {
    const ax = 50, ay = 16, baseY = 100, x0 = 14, x1 = 86, N = 8;
    const cols = ['#2ca02c', '#f4c20d', '#e23b3b', '#2f7fe0'];
    let wedges = '';
    for (let i = 0; i < N; i++) {
      const xa = x0 + (x1 - x0) * i / N, xb = x0 + (x1 - x0) * (i + 1) / N;
      wedges += '<polygon points="' + ax + ',' + ay + ' ' + xa.toFixed(1) + ',' + baseY + ' ' + xb.toFixed(1) + ',' + baseY + '" fill="' + cols[i % cols.length] + '"/>';
    }
    let fringe = '';
    for (let i = 0; i <= 8; i++) {
      const cx = x0 + (x1 - x0) * i / 8;
      fringe += '<circle cx="' + cx.toFixed(1) + '" cy="' + (baseY + 2) + '" r="5"/>';
    }
    let fuzz = '';
    for (let i = 0; i < 12; i++) {
      const ang = i / 12 * Math.PI * 2, r1 = 7, r2 = 13;
      fuzz += '<line x1="' + (ax + Math.cos(ang) * r1).toFixed(1) + '" y1="' + (ay + Math.sin(ang) * r1).toFixed(1) +
        '" x2="' + (ax + Math.cos(ang) * r2).toFixed(1) + '" y2="' + (ay + Math.sin(ang) * r2).toFixed(1) + '"/>';
    }
    return '<svg viewBox="0 0 100 120" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<radialGradient id="cdpom" cx="40%" cy="33%" r="68%"><stop offset="0%" stop-color="#ff8a8a"/><stop offset="55%" stop-color="#e23b3b"/><stop offset="100%" stop-color="#a81a1a"/></radialGradient>' +
        '<linearGradient id="cdsheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#fff" stop-opacity=".4"/><stop offset="42%" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '</defs>' +
      '<g>' + wedges + '</g>' +
      '<path d="M' + ax + ',' + ay + ' L' + x0 + ',' + baseY + ' L' + (x0 + (x1 - x0) * 0.28).toFixed(1) + ',' + baseY + ' Z" fill="url(#cdsheen)"/>' +
      '<path d="M' + (x0 - 1) + ',' + baseY + ' Q50,' + (baseY + 12) + ' ' + (x1 + 1) + ',' + baseY + '" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="2"/>' +
      '<g fill="#f4c20d" stroke="#d39e00" stroke-width=".6">' + fringe + '</g>' +
      '<g stroke="#cf2a2a" stroke-width="3.2" stroke-linecap="round">' + fuzz + '</g>' +
      '<circle cx="' + ax + '" cy="' + ay + '" r="11.5" fill="url(#cdpom)"/>' +
      '<circle cx="' + (ax - 3.5) + '" cy="' + (ay - 3.5) + '" r="3" fill="#ffb3b3" opacity=".8"/>' +
      '</svg>';
  }

  function loadSettingsThen(cb) {
    if (w.CD && w.CD.getSettings) {
      w.CD.getSettings().then((s) => { settings = s; cb(); });
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.cd_settings && w.CD.getSettings) {
            w.CD.getSettings().then((s) => {
              settings = s;
              // Reflect an on/off toggle made in another tab, live.
              applyEnabledClass();
              reflectToggle();
              if (!(readJob() && readJob().active)) reflectIdle();
            });
          }
        });
      } catch (e) {}
    } else { cb(); }
  }

  function calCfg() {
    return (settings && settings.calendarSync) || {
      calendarId: '', calendarName: '', lastSyncAt: 0, lastSyncCount: 0, monthsAhead: 12,
      titleTemplate: '{caseId} {caseName}', locationTemplate: '{court}', descriptionTemplate: 'שופט: {judge}',
    };
  }

  // ── button placement ─────────────────────────────────────────────────
  // Preferred: inside the site header strip, to the right of the envelope
  // (#Header1_imgEnvelope). On pages without that strip, fall back to a fixed
  // floating pill. The element is moved (not re-created) so its listeners and
  // status survive re-placement.
  //
  // The button is rendered only on the three pages allowed by
  // syncButtonAllowed() — the private personal area, the lawyer home page, and
  // the lawyer "my hearings" report — i.e. the entry points where syncing the
  // user's own hearings is meaningful. On those pages the sync flow navigates
  // to the right hearings grid via __doPostBack (lawyer) or sitting_Click
  // (private user). The clown hat + brand tag + header gradient still render on
  // EVERY page via `decorate()` → `ensureHat()`.

  // Find a reliable anchor in the site's top user strip. The envelope id only
  // exists on some masters (e.g. the home page), but the username label and the
  // "יציאה" (logout) link are present on every secured page — including the
  // report pages (ReportJudgeSittingsDayView) where the envelope is absent. We
  // return {el, pos} so the button lands next to the user info on all pages
  // instead of falling back to the floating pill.
  function findHeaderAnchor() {
    const env = document.getElementById('Header1_imgEnvelope');
    if (env && env.parentElement) return { el: env, pos: 'before' };
    const userLbl = document.querySelector('[id*="lblUserName"], [id*="UserName"], [id*="lblUser"]');
    if (userLbl && userLbl.parentElement) return { el: userLbl, pos: 'after' };
    let logout = document.querySelector('a[id*="Exit"], a[id*="Logout"], a[id*="Logoff"], a[id*="LogOff"]');
    if (!logout) {
      const anchors = document.querySelectorAll('#Header1_Table a, header a, a');
      for (const a of anchors) { if ((a.textContent || '').trim() === 'יציאה') { logout = a; break; } }
    }
    if (logout && logout.parentElement) return { el: logout, pos: 'before' };
    return null;
  }

  function ensureButton() {
    const existing = document.getElementById('cd-hsync');
    let box = existing;
    if (!box) {
      box = document.createElement('div');
      box.id = 'cd-hsync';
      box.dir = 'rtl';
      box.innerHTML =
        '<span class="cd-hsync__logo">נ</span>' +
        '<button type="button" id="cd-hsync-btn" class="cd-hsync__btn" aria-label="סנכרן את כל הדיונים שלי ל-Google Calendar">' +
          '🔄 סנכרן יומן ל-Google</button>' +
        '<span class="cd-hsync__ts" id="cd-hsync-ts"></span>';
    }
    const anchor = findHeaderAnchor();
    if (anchor) {
      box.classList.remove('cd-hsync--fixed');
      box.classList.add('cd-hsync--inline');
      const ref = anchor.pos === 'after' ? anchor.el.nextSibling : anchor.el;
      // Only (re)insert if not already in the right place — avoids churn loops.
      if (box.parentElement !== anchor.el.parentElement || box.nextSibling !== ref) {
        anchor.el.parentElement.insertBefore(box, ref);
      }
    } else if (!box.parentElement) {
      box.classList.remove('cd-hsync--inline');
      box.classList.add('cd-hsync--fixed');
      document.body.appendChild(box);
    }
    bind();
  }

  function bind() {
    els.box = document.getElementById('cd-hsync');
    els.btn = document.getElementById('cd-hsync-btn');
    els.ts = document.getElementById('cd-hsync-ts');
    if (els.btn && !els.btn.dataset.cdBound) {
      els.btn.dataset.cdBound = '1';
      els.btn.addEventListener('click', startSync);
    }
  }

  function findByText(tag, text) {
    const nodes = document.querySelectorAll(tag);
    for (const n of nodes) { if ((n.textContent || '').trim() === text) return n; }
    return null;
  }

  function setStatus(text) {
    if (els.ts) { els.ts.textContent = text; } // shown via the hover tooltip; no native title
  }

  function reflectIdle() {
    if (els.btn) { els.btn.disabled = false; }
    const cs = calCfg();
    if (!cs.lastSyncAt) { setStatus('טרם סונכרן'); return; }
    const d = new Date(cs.lastSyncAt);
    const p = (n) => (n < 10 ? '0' : '') + n;
    setStatus('סונכרן: ' + p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + (cs.lastSyncCount ? ' · ' + cs.lastSyncCount + ' דיונים' : ''));
  }

  function reflectBusy(busy) {
    if (els.btn) els.btn.disabled = !!busy;
  }

  // ── sessionStorage job ────────────────────────────────────────────────
  function readJob() { try { return JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null'); } catch (e) { return null; } }
  function writeJob(j) { try { sessionStorage.setItem(JOB_KEY, JSON.stringify(j)); } catch (e) {} }
  function clearJob() { try { sessionStorage.removeItem(JOB_KEY); } catch (e) {} }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }

  function startSync() {
    if (readJob() && readJob().active) return;
    const cs = calCfg();
    if (!cs.calendarId) {
      setStatus('יש להגדיר יומן יעד בהגדרות (לשונית "יומן Google")…');
      try { chrome.runtime.sendMessage({ type: 'cd/openOptions' }); } catch (e) {}
      return;
    }
    const today = new Date();
    const to = new Date(today.getFullYear(), today.getMonth() + (cs.monthsAhead || 12), today.getDate());
    const job = { active: true, step: 'route', from: fmtDate(today), to: fmtDate(to), tries: 0 };
    writeJob(job);
    // The private flow runs entirely in one page load (no reload), so a second
    // click must not be blocked by the once-per-load guard from the first run.
    handledThisLoad = false;
    reflectBusy(true);
    setStatus('מתחיל סנכרון…');
    pump();
  }

  // Built from the page's OWN application root, not a hard-coded secured path.
  // Hard-coding "/Ngcs.Web.Secured" sent this to
  // www.court.gov.il/Ngcs.Web.Secured/... on the public portal — a path that
  // host does not serve, which its WAF answers with "זוהתה פעילות בלתי מורשת"
  // (verified live). That both fails and spends a flagged request. Same bug
  // class as the viewer path fixed in 0.19.2; this was the instance left behind.
  function personalAreaUrl() {
    const root = (w.CD && w.CD.appRoot) ? w.CD.appRoot() : '/Ngcs.Web.Secured';
    return location.origin + root + '/PersonalAreaPage.aspx';
  }

  // Two user types, two data sources (confirmed by live inspection):
  //   • Lawyers ("אזור לעורכי דין") → ReportLawyerSittingsQueryView page via
  //     the "הדיונים שלי" menu postback; we select the "דיונים של המשרד" radio,
  //     set the range, run the report, and scrape the grid.
  //   • Private users ("אזור אישי") → the personal-area "דיונים שלי" tile,
  //     which calls sitting_Click(true) to fill #SittingGrid in-page (the
  //     lawyer report is empty for them). We open it and scrape #SittingGrid.
  function isLawyerUser() {
    const t = (document.body && document.body.textContent) || '';
    return /אזור\s+לעורכ/i.test(t) || !!document.querySelector('[href*="btnLawyer"], [onclick*="btnLawyer"]');
  }

  async function pump() {
    const job = readJob();
    if (!job || !job.active) return;
    if (handledThisLoad) return;
    handledThisLoad = true;
    reflectBusy(true);

    try {
      // Lawyer: after the report postback reload, collect the report grid.
      if (job.step === 'collect-report') { await collectReportAndSync(job); return; }

      const path = location.pathname || '';

      if (isLawyerUser()) {
        // ── Lawyer flow ──
        if (/ReportLawyerSittingsQueryView/i.test(path) || adapter.detectMode(document, location) === 'user') {
          setStatus('מריץ דו"ח "דיונים של המשרד" לטווח ' + job.from + ' – ' + job.to + '…');
          selectFirmRadio();
          adapter.setDateRange(document, job.from, job.to);
          job.step = 'collect-report';
          writeJob(job);
          if (!adapter.submitReport(document)) failJob('לא ניתן להפעיל את הדו"ח.');
          return; // reload → collect-report
        }
        job.tries = (job.tries || 0) + 1;
        if (job.tries > 4) { failJob('לא הצלחתי להגיע לדיונים לעורך דין. ניתן לפתוח ידנית: יומן דיונים → הדיונים שלי.'); return; }
        const link = findHearingsMenuLink(document);
        if (!link) { failJob('לא נמצא קישור "הדיונים שלי" בתפריט.'); return; }
        writeJob(job);
        setStatus('עובר לדיונים לעורך דין… (' + job.tries + ')');
        navigateViaPostback(link);
        return;
      }

      // ── Private user flow ──
      if (/PersonalAreaPage/i.test(path)) {
        await collectSittingModalAndSync(job);
        return;
      }
      // Navigate to the personal area (direct URL works for the home page).
      job.tries = (job.tries || 0) + 1;
      if (job.tries > 3) { failJob('לא הצלחתי לפתוח את האזור האישי. ניתן לפתוח ידנית וללחוץ שוב.'); return; }
      writeJob(job);
      setStatus('עובר לאזור האישי…');
      location.href = personalAreaUrl();
    } catch (e) {
      failJob((e && e.message) || String(e));
    }
  }

  // Lawyer: tick the "דיונים של המשרד" radio so the report covers the whole
  // firm, not just the logged-in lawyer.
  function selectFirmRadio() {
    const radios = document.querySelectorAll('input[type="radio"]');
    for (const r of radios) {
      // The label text sits in an adjacent <label> or the parent.
      const lbl = (r.id && document.querySelector('label[for="' + r.id + '"]'));
      const txt = norm((lbl && lbl.textContent) || (r.parentElement && r.parentElement.textContent) || '');
      if (txt.indexOf('דיונים של המשרד') !== -1) {
        if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('click', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      }
    }
    return false;
  }

  // Private: open the "דיונים שלי" tile (sitting_Click) and scrape #SittingGrid.
  async function collectSittingModalAndSync(job) {
    setStatus('פותח את "הדיונים שלי"…');
    openSittingModal();
    // The modal fills #SittingGrid by AJAX. Poll until rows ACTUALLY appear —
    // don't trust the transient "no rows" overlay that shows before the data
    // arrives (that race is what made sync report 0 prematurely).
    let grid = null, rows = [];
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      grid = document.querySelector('#SittingGrid, [id$="SittingGrid"]');
      if (grid) {
        rows = adapter.listHearingsInGrid(grid, document);
        if (rows.length) break;
      }
      await sleep(300);
    }
    if (!rows.length) {
      // Conclude "empty docket" only if the grid explicitly shows the no-rows
      // overlay after the full wait; otherwise it simply failed to load.
      const noRows = grid && grid.querySelector('.ag-overlay-no-rows-to-show, .ag-overlay-no-rows-center');
      if (!grid || !noRows) {
        failJob('לא הצלחתי לטעון את רשימת הדיונים. פתח/י ידנית את "דיונים שלי" ולחץ/י סנכרן.');
        return;
      }
    }
    setStatus('אוסף ' + rows.length + ' דיונים…');
    await syncRows(rows, job);
  }

  function openSittingModal() {
    // The tile's footer link carries onclick="sitting_Click(true)"; a synthetic
    // click triggers the page's inline handler (it runs in the page world).
    const link = document.querySelector('a[onclick*="sitting_Click"], [onclick*="sitting_Click"]');
    if (link) { link.click(); return true; }
    // Fallback: click the "דיונים שלי" small-box tile itself.
    const boxes = document.querySelectorAll('.small-box');
    for (const b of boxes) {
      if (norm(b.textContent).indexOf('דיונים שלי') !== -1) { (b.querySelector('a') || b).click(); return true; }
    }
    return false;
  }

  async function waitForSittingGrid(maxMs) {
    // The modal loads its rows by AJAX after sitting_Click, and AG-Grid shows a
    // transient "no rows" overlay BEFORE the data arrives. So we wait for actual
    // rows; we only accept the "no rows" overlay after a minimum settle time
    // (otherwise we'd harvest an empty grid and report 0 hearings).
    const start = Date.now();
    const deadline = start + (maxMs || 12000);
    const MIN_BEFORE_EMPTY = 4000;
    while (Date.now() < deadline) {
      const grid = document.querySelector('#SittingGrid, [id$="SittingGrid"]');
      if (grid) {
        const hasRows = grid.querySelector('.ag-center-cols-container [role="row"][row-index]');
        if (hasRows) return grid;
        const noRows = grid.querySelector('.ag-overlay-no-rows-to-show, .ag-overlay-no-rows-center');
        if (noRows && (Date.now() - start) > MIN_BEFORE_EMPTY) return grid;
      }
      await sleep(250);
    }
    return document.querySelector('#SittingGrid, [id$="SittingGrid"]');
  }

  async function collectReportAndSync(job) {
    setStatus('אוסף דיונים…');
    // Wait for the report grid to render actual rows before harvesting, so a
    // slow report doesn't get read as empty.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const grid = adapter.findGridRoot(document);
      if (grid && grid.querySelector('.ag-center-cols-container [role="row"][row-index]')) break;
      await sleep(300);
    }
    const rows = await collectAllRows();
    await syncRows(rows, job);
  }

  async function syncRows(rows, job) {
    const cs = calCfg();
    const fmt = {
      titleTemplate: cs.titleTemplate, locationTemplate: cs.locationTemplate, descriptionTemplate: cs.descriptionTemplate,
    };
    const events = rows.map((h) => w.CD.gcalEvent(h, fmt)).filter(Boolean);
    if (!events.length) {
      finishJob('לא נמצאו דיונים בטווח ' + job.from + ' – ' + job.to + '.');
      return;
    }
    if (!cs.calendarId) { failJob('לא הוגדר יומן יעד.'); return; }
    setStatus('מסנכרן ' + events.length + ' דיונים ל-"' + (cs.calendarName || '') + '"…');
    const r = await sendToSW({ type: 'cd/calSyncEvents', calendarId: cs.calendarId, events: events });
    if (r && r.ok) {
      await persistCal({ lastSyncAt: Date.now(), lastSyncCount: r.synced || 0 });
      const failNote = r.failed ? ' · ' + r.failed + ' נכשלו' : '';
      finishJob('✓ סונכרנו ' + (r.synced || 0) + ' דיונים' + failNote);
    } else {
      failJob('סנכרון נכשל: ' + String((r && r.error) || 'שגיאה').slice(0, 120));
    }
  }

  function finishJob(msg) {
    clearJob();
    reflectBusy(false);
    // Re-render the persisted timestamp, then show the result note briefly.
    reflectIdle();
    if (msg) setStatus(msg);
  }
  function failJob(msg) {
    clearJob();
    reflectBusy(false);
    setStatus('⚠ ' + msg);
  }

  async function persistCal(partial) {
    if (!(w.CD && w.CD.saveSettings)) return;
    settings = await w.CD.saveSettings({ calendarSync: partial });
  }

  // ── menu navigation ────────────────────────────────────────────────────
  function norm(s) { return String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }

  function findHearingsMenuLink(doc) {
    // The "הדיונים שלי" item is an <a> with
    //   __doPostBack('Header1$UpperMenu1$btnMyDiscussion','')
    // (confirmed by live inspection). Match by postback target first (most
    // robust), then by normalized menu-label text.
    const anchors = Array.from(doc.querySelectorAll('a[href*="__doPostBack"], a[onclick*="__doPostBack"], [onclick*="__doPostBack"]'));
    // 1) target-based: btnMyDiscussion is the litigant/firm hearings.
    for (const el of anchors) {
      const src = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
      if (/btnMyDiscussion/i.test(src)) return el;
    }
    // 2) label-based (normalized) fallback.
    for (const label of MENU_LABELS) {
      for (const el of anchors) {
        if (norm(el.textContent) === label) return el;
      }
    }
    // 3) loose contains match.
    for (const label of MENU_LABELS) {
      for (const el of anchors) {
        if (norm(el.textContent).indexOf(label) !== -1) return el;
      }
    }
    return null;
  }

  function navigateViaPostback(el) {
    const src = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
    const m = src.match(/__doPostBack\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    const form = document.forms[0];
    if (m && form) {
      let et = form.querySelector('input[name="__EVENTTARGET"]');
      let ea = form.querySelector('input[name="__EVENTARGUMENT"]');
      if (!et) { et = document.createElement('input'); et.type = 'hidden'; et.name = '__EVENTTARGET'; form.appendChild(et); }
      if (!ea) { ea = document.createElement('input'); ea.type = 'hidden'; ea.name = '__EVENTARGUMENT'; form.appendChild(ea); }
      et.value = m[1]; ea.value = m[2] || '';
      form.submit();
      return;
    }
    el.click();
  }

  // ── grid collection (paged) ────────────────────────────────────────────
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitGridReady(maxMs) {
    const deadline = Date.now() + (maxMs || 8000);
    while (Date.now() < deadline) {
      const grid = adapter.findGridRoot(document);
      if (grid) {
        const hasRows = grid.querySelector('.ag-center-cols-container [role="row"][row-index]');
        const noRows = grid.querySelector('.ag-overlay-no-rows-to-show, .ag-overlay-no-rows-center');
        if (hasRows || noRows) return;
      }
      await sleep(200);
    }
  }

  function readPagingTotal() {
    const grid = adapter.findGridRoot(document) || document;
    const panel = grid.querySelector('.ag-paging-row-summary-panel');
    if (!panel) return null;
    const m = (panel.textContent || '').match(/(\d+)\s*עד\s*(\d+)\s*מתוך\s*(\d+)/);
    return m ? parseInt(m[3], 10) : null;
  }

  function clickNextPage() {
    const grid = adapter.findGridRoot(document) || document;
    let btn = grid.querySelector('.ag-paging-button [ref="btNext"], button[ref="btNext"], [ref="btNext"]');
    if (!btn) {
      const cands = grid.querySelectorAll('.ag-paging-button, button');
      for (const c of cands) { if ((c.textContent || '').indexOf('לדף הבא') > -1) { btn = c; break; } }
    }
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  }

  async function collectAllRows() {
    let rows = adapter.listAllHearings(document);
    const total = readPagingTotal();
    if (total == null || rows.length >= total) return rows;
    const map = new Map();
    const sig = (h) => (h.caseId || '') + '|' + (h.date || '') + '|' + (h.time || '') + '|' + (h.sittingType || '') + '|' + (h.caseName || '');
    rows.forEach((h) => map.set(sig(h), h));
    let guard = 0;
    while (map.size < total && guard < 120) {
      if (!clickNextPage()) break;
      await sleep(450);
      adapter.listAllHearings(document).forEach((h) => map.set(sig(h), h));
      guard++;
    }
    return Array.from(map.values());
  }

  // ── SW bridge ──────────────────────────────────────────────────────────
  function sendToSW(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: e.message || String(e) }); }
    });
  }
})();
