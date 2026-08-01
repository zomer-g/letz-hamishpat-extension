// case-judge-chip.js — a small 📅 chip injected NEXT TO THE JUDGE'S NAME on
// case pages (anywhere the page shows a judge + a court, e.g. the case header
// band / case-details tabs). Clicking it opens a compact popover to pick a
// date range and pull the judge's docket DIRECTLY — no need to navigate to the
// "דיונים לשופט ליום דיונים" screen. Collection runs entirely in the
// background via CD.judgeBg.collectFromCase (fetch-replayed postbacks): the
// visible page never reloads; the popover shows a progress bar.
//
// Actions: 📅 תצוגת יומן (opens the floating judge-calendar window) and
// ⬇ הורדה (ZIP with hearings CSV + combined ICS + per-hearing ICS files —
// the same bundle the hearings panel produces).

(function () {
  const w = window;
  if (/\/Viewer\/NGCSViewerPage\.aspx/i.test(location.pathname)) return;

  const CD = w.CD || {};
  const JSZip = (CD.vendorGlobal || ((n) => w[n]))('JSZip');
  if (!(CD.judgeBg && CD.judgeBg.collectFromCase)) return;
  // Case pages live only on the secured portals.
  if (!/^https:\/\/(securesso|secure)\.court\.gov\.il$/i.test(location.origin)) return;
  // The judge-report page itself already has the full hearings panel.
  if (/CalendarSittingJudge|ReportJudgeSittingsDay/i.test(location.href)) return;

  const MAX_RANGE_DAYS = 92;

  const st = {
    settings: null,
    token: null,        // in-flight collection cancellation token
    hearings: null,     // last collected set (kept so re-opening is instant)
    meta: null,
    // Closed court list for the popover: static seed (shared/courts.js) available
    // immediately; the live report cache (cd_courtList) overrides it when present.
    courtList: (CD.COURTS || []).slice(),
    els: {},
  };

  function loadCourtList() {
    try { chrome.storage.local.get('cd_courtList', (d) => { if (d && Array.isArray(d.cd_courtList)) st.courtList = d.cd_courtList; }); } catch (e) {}
  }
  if (CD.getSettings) {
    CD.getSettings().then((s) => { st.settings = s; });
    loadCourtList();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.cd_settings && CD.getSettings) CD.getSettings().then((s) => { st.settings = s; });
        if (changes.cd_courtList) loadCourtList();
      });
    } catch (e) {}
  }

  // The site re-renders parts of the page; a cheap idempotent tick keeps the
  // chip present (same pattern as the panels' watchdogs).
  setInterval(tick, 2000);
  setTimeout(tick, 500);

  // Both appearance configurations (see the dual-config rule): inline → a 📅
  // chip next to the judge's name; floating → a "יומן שופט/ת" panel inside the
  // "כלי נט המשפט" window. Same detection + collection; only the shell differs.
  function tick() {
    const floating = !!(CD.uiFloating && CD.uiFloating());
    // Show a compact button whenever a JUDGE is detected. The court may or may
    // not be certain — the popover confirms it (or asks the user to pick one).
    const found = findJudge();
    const chip = document.getElementById('cd-judge-chip');
    const jf = document.getElementById('cd-jfloat');
    if (!found) { if (chip) chip.remove(); if (jf) jf.remove(); return; }
    st.court = findCourtName(); // '' if not certain
    if (floating) {
      if (chip) chip.remove();
      if (jf) return;
      ensureFloatingButton(found);
    } else {
      if (jf) jf.remove();
      if (chip) return;
      injectChip(found);
    }
  }

  // ---------- locating the judge (and court) on the page ----------
  function norm(s) { return String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }

  const JUDGE_LABELS = ['שופט', 'שופט:', 'שופטת', 'שופטת:', 'גורם שיפוטי', 'גורם שיפוטי:', 'בפני', 'בפני:'];
  const HONORIFIC_RE = /(?:בפני\s+)?כב(?:וד|')?\s*הש(?:ופט(?:ת)?|')?/;

  // Strip honorifics/prefixes from a display string → the bare name.
  // Status/label words that are never a judge's name (seen as false positives
  // on non-case pages, e.g. the "בית משפט פעיל" blurb → "פעיל").
  const JUDGE_NOISE = /^(פעיל|פועל|פעילה|לא\s*פעיל|סגור|סגורה|פתוח|פתוחה|פעילות|בית\s*ה?משפט|כללי|כללית|ראשי|ראשית|כל|הכל|פרטי|ציבורי|מנהלי|מנהלית)$/;
  function cleanJudgeName(s) {
    const out = norm(String(s || '')
      .replace(/(?:^|\s)(?:בפני|כבוד|כב'?|השו'?|הש'?|השופטת|השופט|שופטת|שופט|הרשמת|הרשם|רשמת|רשם|הבכירה|הבכיר|בכירה|בכיר|סגנית|סגן|נשיאת|הנשיאה|הנשיא|נשיאה|נשיא|בדימוס)(?=\s|$)/g, ' ')
      .replace(/[:,]/g, ' '));
    if (JUDGE_NOISE.test(out)) return '';
    // Reject ABBREVIATED names (initials, e.g. the case banner's "ל. ביבי"):
    // an initial can never match the report's judge list ("לימור ביבי"), so a
    // name carrying one is unusable — the FULL name lives in the hearings grid
    // (גורם שיפוטי/גורם מטפל on the מועדי-דיון tab), which findJudge prefers.
    if (/(^|\s)[א-ת]['׳.](\s|$)/.test(out)) return '';
    return out;
  }

  // A "leaf-ish" element: short own text, no more than one element child.
  function leafText(el) {
    const t = norm(el.textContent);
    if (!t || t.length > 90) return '';
    if (el.children && el.children.length > 2) return '';
    return t;
  }

  // Exclude the site's own navigation / menus / grid headers (and our own UI):
  // judge names live in CONTENT, not in nav. Without this, the "יומן דיונים →
  // דיונים לשופט ליום דיונים" menu item (its id contains "Judge") was read as a
  // judge named "דיונים לשופט ליום דיונים".
  const CHROME_SEL = 'nav, .navbar, .dropdown-menu, .dropdown-item, .btn-group, ' +
    '[role="menu"], [role="navigation"], [id*="UpperMenu" i], [id*="Menu" i], [id*="Nav" i], ' +
    '[class*="menu" i], [class*="navbar" i], .ag-header, [role="columnheader"], thead, ' +
    '#cd-judge-chip, #cd-jpop, #cd-jfloat, #cd-float';
  function inChrome(el) { return !!(el && el.closest && el.closest(CHROME_SEL)); }

  // Grid columns that hold an actual judge / signer name.
  const JUDGE_COL_RE = /(SignatureUserName|JudgeName|PresidingJudge|SittingJudge|UserList|Judge)$/i;

  // Find the element carrying the judge's name. Most structured first; nav is
  // always skipped. Returns { el, name } or null.
  function findJudge() {
    // -1) BEST source: the hearings grid (the case's מועדי-דיון tab and other
    //     hearing views) — its גורם שיפוטי/גורם מטפל columns carry the judge's
    //     FULL name ("לימור ביבי"), unlike the case banner's abbreviation
    //     ("השו' ל. ביבי") which can never match the report's judge list.
    //     Pick the most frequent full name across the rows.
    try {
      const ad = CD.adapters && CD.adapters['net-court-hearings'];
      if (ad && ad.listAllHearings) {
        const rows = ad.listAllHearings(document) || [];
        const counts = {};
        for (const r of rows) {
          for (const cand of [r.judge, r.userList, r.handler]) {
            for (const part of String(cand || '').split(/[,;]/)) {
              const name = cleanJudgeName(part);
              // require at least two Hebrew words (a full first+last name)
              if (name && name.length <= 40 && /[א-ת]{2,}\s+[א-ת]/.test(name)) {
                counts[name] = (counts[name] || 0) + 1;
              }
            }
          }
        }
        let best = '', n = 0;
        for (const k of Object.keys(counts)) { if (counts[k] > n) { best = k; n = counts[k]; } }
        if (best) return { el: document.body, name: best };
      }
    } catch (e) {}
    // 0) A data cell in a judge/signer grid column (the real name, e.g. the
    //    decisions grid's "גורם חותם" = DecisionSignatureUserName).
    for (const el of document.querySelectorAll('[col-id]')) {
      if (inChrome(el) || !JUDGE_COL_RE.test(el.getAttribute('col-id') || '')) continue;
      const name = cleanJudgeName(leafText(el));
      if (name && name.length >= 2 && name.length <= 40 && /[א-ת]/.test(name)) return { el: el, name: name };
    }
    // 1) A label element whose text is exactly a judge label → value in the
    //    adjacent cell/sibling.
    const all = document.querySelectorAll('td, th, span, label, div, dt, b, strong');
    for (const el of all) {
      if (inChrome(el)) continue;
      const t = leafText(el);
      if (!t || JUDGE_LABELS.indexOf(t) === -1) continue;
      const val = el.nextElementSibling ||
        (el.parentElement && el.parentElement.nextElementSibling);
      const name = val && cleanJudgeName(leafText(val));
      if (name && name.length >= 2 && /[א-ת]/.test(name)) return { el: val, name: name };
    }
    // 2) A STATIC element whose id/class mentions Judge (never a nav link/button).
    for (const el of document.querySelectorAll('[id*="Judge" i], [class*="Judge" i]')) {
      if (inChrome(el) || /^(A|BUTTON|INPUT|SELECT|OPTION)$/.test(el.tagName)) continue;
      const t = leafText(el);
      const name = t && cleanJudgeName(t);
      if (name && name.length >= 2 && name.length <= 40 && /[א-ת]/.test(name)) return { el: el, name: name };
    }
    // 3) A leaf whose text starts with an honorific ("בפני כבוד השופטת ...").
    for (const el of all) {
      if (inChrome(el)) continue;
      const t = leafText(el);
      if (!t || !HONORIFIC_RE.test(t)) continue;
      const name = cleanJudgeName(t);
      if (name && name.length >= 2 && name.length <= 60) return { el: el, name: name };
    }
    return null;
  }

  // Court name — returned ONLY when we're CERTAIN: exactly ONE distinct court
  // appears in the page CONTENT (nav excluded). Zero, or several different
  // courts (a multi-court decisions list / the public home), → '' so the judge
  // feature is not offered at all (per the user's rule: if the court isn't
  // certain, don't show — this also avoids the "court not found" failures).
  function courtKey(s) {
    return String(s || '')
      .replace(/[״"”׳'’.,()\-–]/g, '')
      .replace(/בית\s*ה?משפט/g, 'בימש')
      .replace(/בית\s*ה?דין/g, 'ביד')
      .replace(/\s+/g, ' ').trim();
  }
  // A real court name carries a court-TYPE keyword. This rejects junk like
  // "בית משפט פעיל" (an active/among status blurb) that otherwise matched.
  const COURT_TYPE_RE = /(השלום|שלום|המחוזי|מחוזי|העליון|עליון|לעבודה|תעבורה|משפחה|מנהליים|נוער|קטנות|הארצי|תביעות|בוררות|לחוזים)/;
  function findCourtName() {
    const COURT_RE = /(בית\s+(?:ה?משפט|ה?דין)[֐-׿\s'"“”\-–]{3,50})/;
    const byKey = {};
    for (const el of document.querySelectorAll('td, span, div, h1, h2, h3, label')) {
      if (inChrome(el)) continue;
      const t = leafText(el);
      const m = t && t.match(COURT_RE);
      if (!m) continue;
      const raw = norm(m[1]).replace(/\s+[א-ת]$/, ''); // drop a dangling single letter (truncation)
      if (!COURT_TYPE_RE.test(raw)) continue;          // must be a real court type
      if (/בית\s+ה?משפט[\s\S]*בית\s+ה?משפט/.test(raw)) continue; // "בית משפט … בית משפט" = junk
      const k = courtKey(raw);
      if (k.length >= 6 && !byKey[k]) byKey[k] = raw;
    }
    const keys = Object.keys(byKey);
    return keys.length === 1 ? byKey[keys[0]] : '';
  }

  // ---------- chip ----------
  function injectChip(found) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'cd-judge-chip';
    chip.className = 'cd-judge-chip';
    chip.title = 'משיכת יומן הדיונים של השופט/ת — בחירת טווח תאריכים כאן, ללא מעבר מסך';
    chip.innerHTML = '📅';
    chip.setAttribute('aria-label', 'יומן דיונים של ' + found.name);
    chip.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openPopover(chip, found);
    });
    // Inline right after the judge's name.
    found.el.appendChild(chip);
  }

  // ---------- floating-window: a COMPACT button that opens the popover ----------
  // (Keeps the judge feature small — it's rarely needed; the whole menu appears
  // only on click.)
  function ensureFloatingButton(found) {
    if (!(CD.floatBody)) return;
    if (document.getElementById('cd-jfloat')) return;
    const wrap = document.createElement('div');
    wrap.id = 'cd-jfloat';
    wrap.className = 'cd-panel cd-jfloatbtn';
    wrap.dir = 'rtl';
    wrap.innerHTML =
      '<button type="button" class="cd-jfb" title="יומן דיונים של השופט/ת — בחירת טווח תאריכים">' +
        '<span class="cd-jfb__t">⚖️ יומן שופט/ת</span>' +
        '<span class="cd-jfb__n">' + esc(found.name) + '</span>' +
        '<span class="cd-jfb__go">בחר טווח ▸</span>' +
      '</button>';
    CD.floatBody().appendChild(wrap);
    wrap.querySelector('.cd-jfb').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); openPopover(wrap, found);
    });
  }

  // ---------- popover ----------
  function closePopover() {
    const p = document.getElementById('cd-jpop');
    if (p && p.parentNode) p.parentNode.removeChild(p);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } }
  function onOutside(e) {
    const p = document.getElementById('cd-jpop');
    if (!p || p.contains(e.target)) return;
    // The date-picker calendar (.cd-dp) is rendered OUTSIDE the popover — clicking
    // a day there must NOT close the popover (that was the "can't pick a date" bug).
    if (e.target.closest && e.target.closest('.cd-dp')) return;
    if (e.target.id === 'cd-judge-chip') return;
    closePopover();
  }

  function openPopover(anchor, found) {
    closePopover();
    const judgeName = found.name;
    const courtName = st.court || findCourtName();

    const pop = document.createElement('div');
    pop.id = 'cd-jpop';
    pop.className = 'cd-jpop';
    pop.dir = 'rtl';
    pop.innerHTML =
      '<div class="cd-jpop__head">📅 יומן דיונים — ' + esc(judgeName) +
        '<button type="button" class="cd-jpop__close" data-jp="close" aria-label="סגירה">×</button></div>' +
      (courtName
        ? '<div class="cd-jpop__sub">' + esc(courtName) + '</div>'
        : '<label class="cd-jpop__courtrow">בית המשפט לא זוהה — יש לבחור:' +
            (st.courtList && st.courtList.length
              ? '<select data-jp="court"><option value="">— בחר/י בית משפט —</option>' +
                  st.courtList.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('') + '</select>'
              : '<input type="text" data-jp="court" placeholder="למשל: שלום פתח תקווה" autocomplete="off">') +
          '</label>') +
      '<div class="cd-jpop__range">' +
        '<label>מ־ <input type="text" data-jp="from" placeholder="dd/mm/yyyy" size="10"></label>' +
        '<label>עד <input type="text" data-jp="to" placeholder="dd/mm/yyyy" size="10"></label>' +
      '</div>' +
      '<div class="cd-jpop__actions">' +
        '<button type="button" class="cd-panel__btn cd-panel__btn--primary" data-jp="calview">📅 תצוגת יומן</button>' +
        '<button type="button" class="cd-panel__btn" data-jp="download">⬇ הורדה</button>' +
      '</div>' +
      '<div class="cd-jpop__status">האיסוף ייפתח בטאב חדש — העמוד הנוכחי יישאר פתוח.</div>';

    (document.body || document.documentElement).appendChild(pop);
    positionPopover(pop, anchor);

    st.els = {
      pop: pop,
      from: pop.querySelector('[data-jp="from"]'),
      to: pop.querySelector('[data-jp="to"]'),
      court: pop.querySelector('[data-jp="court"]'), // null when the court was detected
      status: pop.querySelector('.cd-jpop__status'),
      calview: pop.querySelector('[data-jp="calview"]'),
      download: pop.querySelector('[data-jp="download"]'),
    };
    if (CD.attachDatePicker) {
      CD.attachDatePicker(st.els.from);
      CD.attachDatePicker(st.els.to);
    }
    bindRangeBounds();

    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-jp]');
      if (!b) return;
      const a = b.getAttribute('data-jp');
      if (a === 'close') closePopover();
      else if (a === 'calview' || a === 'download') runRequest(a, judgeName);
    });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
  }

  function positionPopover(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + w.scrollY + 6;
    let left = r.left + w.scrollX - 260;
    if (left < 8) left = 8;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  function setStatus(text, kind) {
    if (!st.els.status) return;
    st.els.status.textContent = text;
    st.els.status.classList.toggle('is-error', kind === 'error');
  }
  function setProgress(frac) {
    if (!st.els.bar) return;
    st.els.bar.style.display = frac == null ? 'none' : '';
    if (frac != null && st.els.fill) {
      st.els.fill.style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + '%';
    }
  }
  function setBusy(busy) {
    if (st.els.calview) st.els.calview.disabled = !!busy;
    if (st.els.download) st.els.download.disabled = !!busy;
  }

  // ---------- range helpers (same rules as the hearings panel) ----------
  function jpParse(s) { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; }
  function jpFmt(d) { return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear(); }
  function jpAddDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

  function bindRangeBounds() {
    const update = () => {
      const off = MAX_RANGE_DAYS - 1;
      const from = jpParse(st.els.from.value);
      if (from) {
        st.els.to.dataset.cdMin = jpFmt(from);
        st.els.to.dataset.cdMax = jpFmt(jpAddDays(from, off));
      } else { delete st.els.to.dataset.cdMin; delete st.els.to.dataset.cdMax; }
      const to = jpParse(st.els.to.value);
      if (to) {
        st.els.from.dataset.cdMax = jpFmt(to);
        st.els.from.dataset.cdMin = jpFmt(jpAddDays(to, -off));
      } else { delete st.els.from.dataset.cdMax; delete st.els.from.dataset.cdMin; }
    };
    st.els.from.addEventListener('change', update);
    st.els.to.addEventListener('change', update);
  }

  function enumerateDays(fromStr, toStr) {
    const a = jpParse(fromStr), b = jpParse(toStr);
    if (!a || !b || a > b) return null;
    const out = [];
    const cur = new Date(a.getTime());
    let guard = 0;
    while (cur <= b && guard < 800) {
      out.push(jpFmt(cur));
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return out;
  }

  // ---------- run: hand off to a NEW TAB (real postbacks there are F5-safe) ----------
  function runRequest(action, judgeName) {
    // Works on BOTH portals: the secured one (securesso/secure) and the public
    // no-auth one (www.court.gov.il/NGCS.Web.Site) — the runner tab drives the
    // same "דיונים לשופט" report on whichever portal it was launched from.
    if (!/^https:\/\/(securesso|secure|www)\.court\.gov\.il$/i.test(location.origin)) {
      setStatus('התכונה זמינה רק באתר נט המשפט.', 'error'); return;
    }
    const from = (st.els.from.value || '').trim(), to = (st.els.to.value || '').trim();
    if (!from || !to) { setStatus('יש לבחור תאריך התחלה וסיום.', 'error'); return; }
    const days = enumerateDays(from, to);
    if (!days) { setStatus('טווח תאריכים לא תקין.', 'error'); return; }
    if (days.length > MAX_RANGE_DAYS) { setStatus('הטווח גדול מ-' + MAX_RANGE_DAYS + ' ימים.', 'error'); return; }
    const court = st.court || (st.els.court && (st.els.court.value || '').trim()) || '';
    if (!court) { setStatus('יש להזין בית משפט.', 'error'); return; }

    const id = 'j' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    const req = { judge: judgeName, court: court, from: from, to: to, action: action };
    setStatus('פותח טאב לאיסוף…');
    // When the extension is reloaded/updated, THIS page's content script is
    // orphaned and every chrome.* call throws "Extension context invalidated".
    // Detect that and tell the user to refresh — a raw error string is useless.
    const isStale = (m) => /invalidated|context invalidated|Extension context/i.test(String(m || ''));
    const STALE_MSG = 'התוסף עודכן ברקע — רענן/י את העמוד (F5) ואז נסה/י שוב.';
    try {
      chrome.storage.local.set({ ['cd_jreq_' + id]: req }, () => {
        if (chrome.runtime.lastError) {
          setStatus(isStale(chrome.runtime.lastError.message) ? STALE_MSG : 'שמירת הבקשה נכשלה — נסה/י שוב.', 'error');
          return;
        }
        const landing = location.origin +
          (/^www\.court\.gov\.il$/i.test(location.hostname) ? '/NGCS.Web.Site/HomePage.aspx' : '/Ngcs.Web.Secured/PersonalAreaPage.aspx') +
          '#cdjudge=' + id;
        chrome.runtime.sendMessage({ type: 'cd/openTab', url: landing }, (r) => {
          if (chrome.runtime.lastError || !(r && r.ok)) {
            const lm = chrome.runtime.lastError && chrome.runtime.lastError.message;
            setStatus(isStale(lm) ? STALE_MSG : 'פתיחת הטאב נכשלה — יש לאשר חלונות/טאבים.', 'error');
            return;
          }
          setStatus('✓ נפתח טאב חדש — האיסוף רץ שם. אפשר להמשיך לעבוד כאן.');
          setTimeout(closePopover, 1400);
        });
      });
    } catch (e) {
      const m = (e && e.message) || String(e);
      setStatus(isStale(m) ? STALE_MSG : ('שגיאה: ' + m), 'error');
    }
  }

  // ---------- (legacy in-page collection — kept for reference; blocked by F5) ----------
  async function collect(action, judgeName, courtName) {
    // The judge-sittings report lives only in the authenticated secured portal.
    // A panel left over from a prior secured page could be clicked on the public
    // site (www.court.gov.il), where the fetch has no report → a misleading
    // "court not found". Guard at click time with a clear message instead.
    if (!/^https:\/\/(securesso|secure)\.court\.gov\.il$/i.test(location.origin)) {
      setStatus('התכונה זמינה רק בפורטל המאובטח של נט המשפט (securesso). יש לפתוח את התיק שם ולנסות שוב.', 'error');
      return;
    }
    if (st.token) { setStatus('האיסוף כבר רץ — יש להמתין.', 'error'); return; }
    const from = st.els.from.value.trim();
    const to = st.els.to.value.trim();
    if (!from || !to) { setStatus('יש לבחור תאריך התחלה וסיום (לחיצה על השדה פותחת לוח שנה).', 'error'); return; }
    const days = enumerateDays(from, to);
    if (!days) { setStatus('טווח תאריכים לא תקין.', 'error'); return; }
    if (days.length > MAX_RANGE_DAYS) { setStatus('הטווח גדול מ-' + MAX_RANGE_DAYS + ' ימים.', 'error'); return; }

    // Re-use a set that was just collected for the exact same range.
    if (st.hearings && st.meta && st.meta.from === from && st.meta.to === to) {
      runAction(action);
      return;
    }

    const token = { cancelled: false };
    st.token = token;
    setBusy(true);
    setProgress(0);
    setStatus('מאתר את השופט/ת בדוח הדיונים…');

    let res;
    try {
      res = await CD.judgeBg.collectFromCase({
        judgeName: judgeName, courtName: courtName, days: days, token: token,
        onProgress: function (done, total, count) {
          setProgress(done / total);
          setStatus(done >= total
            ? 'מסכם: נאספו ' + count + ' דיונים…'
            : 'אוסף יום ' + (done + 1) + '/' + total + ' · נאספו ' + count + ' דיונים…');
        },
      });
    } catch (e) {
      res = { ok: false, error: 'exception', detail: (e && e.message) || String(e) };
    }
    st.token = null;
    setBusy(false);

    if (token.cancelled || (res && res.cancelled)) { setProgress(null); setStatus('האיסוף בוטל.'); return; }
    if (!res || !res.ok) {
      setProgress(null);
      setStatus(errorText(res), 'error');
      return;
    }

    st.hearings = res.hearings;
    st.meta = {
      from: from, to: to,
      judgeName: res.judgeName || judgeName,
      courtName: res.courtName || courtName,
    };
    setProgress(1);
    setStatus('✓ נאספו ' + res.hearings.length + ' דיונים מ-' + days.length + ' ימים.');
    runAction(action);
  }

  function errorText(res) {
    const e = (res && res.error) || '';
    if (e === 'court-not-found') {
      return 'לא נמצא בית המשפט ברשימת הדוח. ניתן למשוך את היומן מהמסך "דיונים לשופט ליום דיונים".';
    }
    if (e === 'judge-not-found') {
      return 'השופט/ת לא נמצאו ברשימת הדוח' + (res.courtName ? ' של ' + res.courtName : '') +
        '. ניתן למשוך את היומן מהמסך "דיונים לשופט ליום דיונים".';
    }
    if (e === 'unverified-empty') {
      return 'לא ניתן לאמת את נתוני הדוח ברקע בעמוד זה. ניתן למשוך את היומן מהמסך "דיונים לשופט ליום דיונים".';
    }
    if (e === 'report-page-unreachable') {
      return 'עמוד הדוח אינו נגיש מכאן. ניתן למשוך את היומן מהמסך "דיונים לשופט ליום דיונים".';
    }
    return 'האיסוף נכשל (' + (e || 'שגיאה') + '). ניתן לנסות שוב או להשתמש במסך "דיונים לשופט".';
  }

  function runAction(action) {
    if (action === 'calview') {
      if (!CD.openJudgeCalendar) { setStatus('מודול היומן לא נטען — ניתן לרענן את העמוד.', 'error'); return; }
      // Open even when empty — an empty calendar for the range is clearer than nothing.
      CD.openJudgeCalendar(st.hearings || [], st.meta, st.settings || {});
      if (!(st.hearings && st.hearings.length)) setStatus('לא נמצאו דיונים בטווח שנבחר — היומן מוצג ריק.');
      return;
    }
    // download: nothing to bundle when empty.
    if (!(st.hearings && st.hearings.length)) { setStatus('לא נמצאו דיונים בטווח שנבחר.', 'error'); return; }
    if (action === 'download') downloadZip();
  }

  // ---------- ZIP download (same bundle shape as the hearings panel) ----------
  function sanitize(name, maxLen) {
    return String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen || 100);
  }

  async function downloadZip() {
    if (!JSZip) { setStatus('ספריית ה-ZIP לא נטענה — ניתן לרענן את העמוד.', 'error'); return; }
    const m = st.meta;
    const judge = (m.judgeName || 'שופט').replace(/[\\/:*?"<>|]/g, ' ').trim();
    const stem = 'דיונים לשופט ' + judge + ' - ' + m.from.replace(/\//g, '-') + ' עד ' + m.to.replace(/\//g, '-');
    setStatus('בונה ZIP…');
    try {
      const hearings = st.hearings;
      const adapter = CD.adapters && CD.adapters['net-court-hearings'];
      const csvText = CD.buildCsv && adapter
        ? CD.buildCsv(adapter.CSV_HEADERS, hearings.map((h) => adapter.csvRow(h)))
        : '';
      const icsText = CD.buildIcs ? CD.buildIcs(hearings, { calName: stem }) : '';
      const zip = new JSZip();
      if (csvText) zip.file(sanitize(stem, 100) + '.csv', csvText);
      if (icsText) zip.file(sanitize(stem, 100) + '.ics', icsText);
      if (CD.buildSingleIcs && CD.icsFilename) {
        const sep = zip.folder('per-hearing');
        const used = new Set();
        for (const h of hearings) {
          const base = CD.icsFilename(h);
          let name = base, i = 2;
          while (used.has(name)) { name = base.replace(/\.ics$/, '_' + i + '.ics'); i++; }
          used.add(name);
          sep.file(name, CD.buildSingleIcs(h, { calName: 'דיון ' + (h.caseId || '') }));
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sanitize(stem, 110) + '_' + new Date().toISOString().slice(0, 10) + '.zip';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 4000);
      setStatus('✓ הורד ZIP — ' + st.hearings.length + ' דיונים.');
    } catch (e) {
      setStatus('בניית ה-ZIP נכשלה: ' + ((e && e.message) || String(e)), 'error');
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
})();
