// content/favorites.js — locally-saved favorite cases (⭐).
//
// On any Net HaMishpat page that carries the "איתור תיק" locator bar, mounts a
// "תיקים מועדפים" panel (inline under the locator, or in the floating window —
// per the appearance mode) listing saved cases; each opens in one click (reuses
// CD.caseOpenSubmit, the same locate the איתור-תיק field uses). On a case page a
// star adds/removes the CURRENT case. Stored locally in chrome.storage.local —
// nothing leaves the browser.
(function (w) {
  const CD = w.CD || (w.CD = {});
  const KEY = 'cd_favorites';
  const PANEL_ID = 'cd-fav-panel';

  function onCourtPage() {
    return /(^|\.)court\.gov\.il$/i.test(location.hostname) &&
      !!document.querySelector('[id*="CaseLocatorHeaderUC2"]');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function getFavs() { return new Promise((res) => { try { chrome.storage.local.get(KEY, (d) => res((d && d[KEY]) || [])); } catch (e) { res([]); } }); }
  function setFavs(list) { return new Promise((res) => { try { chrome.storage.local.set({ [KEY]: list }, () => res(list)); } catch (e) { res(list); } }); }

  // Inside the extension's own UI? (its ids/classes are all cd-*)
  function inExt(el) {
    for (let n = el; n; n = n.parentElement) {
      const id = n.id || '';
      const cls = typeof n.className === 'string' ? n.className : '';
      if (id.indexOf('cd-') === 0 || /(^|\s)cd-/.test(cls)) return true;
    }
    return false;
  }

  // The case currently open — id, case-type prefix (עת"מ/ת"א/…), and the
  // parties title ("זומר נ' כץ ואח'"), so the favorites list shows the FULL
  // display name, not just a bare number. The banner is built of small leaf
  // elements: one holds `עת"מ 71733-11-20`, the next holds `: זומר נ' כץ ואח'`.
  function currentCase() {
    const ad = CD.adapters && CD.adapters['net-court'];
    const id = ad && ad.readCaseId ? ad.readCaseId(document) : '';
    if (!id) return null;
    let type = '', name = '';
    let idLeaf = null;
    for (const el of document.querySelectorAll('td, span, div, b, strong, a, h1, h2')) {
      if (el.children.length > 1 || inExt(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 90 || t.indexOf(id) === -1) continue;
      idLeaf = el;
      // case-type abbreviation right before the number (עת"מ, ת"א, בג"ץ, תפ"ח…)
      const tm = t.split(id)[0].match(/([א-ת]+(?:["״'][א-ת]+)?)\s*$/);
      if (tm) type = tm[1];
      // parties in the same leaf, after the number
      const after = (t.split(id)[1] || '').replace(/^[\s:·|\-]+/, '').trim();
      if (after.length >= 3) name = after.slice(0, 70);
      break;
    }
    // Parties usually live in the NEXT banner leaf (": זומר נ' כץ ואח'") —
    // prefer a sibling that looks like a case title (X נ' Y).
    if (idLeaf && !/נ'|נגד/.test(name)) {
      let sib = idLeaf.nextElementSibling || (idLeaf.parentElement && idLeaf.parentElement.nextElementSibling);
      for (let hops = 0; sib && hops < 4; hops++, sib = sib.nextElementSibling) {
        const t = (sib.textContent || '').replace(/\s+/g, ' ').trim().replace(/^[:\s]+/, '');
        if (/נ'|נגד/.test(t) && t.length >= 4 && t.length <= 70) { name = t; break; }
      }
    }
    return { id: id, type: type, name: name };
  }

  // The list can grow long, so it is COLLAPSED by default: the bar shows the
  // count, an expand/collapse button, and (on a case page) the add/remove star.
  // The expanded state persists across pages in chrome.storage.local.
  let expanded = false;
  try { chrome.storage.local.get('cd_fav_open', (d) => { expanded = !!(d && d.cd_fav_open); const p = document.getElementById(PANEL_ID); if (p) render(p); }); } catch (e) {}

  async function render(panel) {
    const cur = currentCase();
    const favs = await getFavs();
    const isFav = cur && favs.some((f) => f.id === cur.id);
    let html = '<div class="cd-panel__bar"><div class="cd-panel__title">⭐ תיקים מועדפים' +
      (favs.length ? ' <span class="cd-fav__count">(' + favs.length + ')</span>' : '') + '</div>';
    // NOTE: no title="" attributes here — the site converts titles into its own
    // floating tooltip DIVs that linger on screen after hover.
    html += '<button type="button" class="cd-panel__btn cd-fav-expand">' +
      (expanded ? '▲ הסתר' : '▼ הצג') + '</button>';
    if (cur) {
      html += '<button type="button" class="cd-panel__btn ' + (isFav ? '' : 'cd-panel__btn--primary') + ' cd-fav-toggle">' +
        (isFav ? '★ במועדפים' : '☆ הוסף תיק זה') + '</button>';
    }
    html += '</div><div class="cd-fav__body"' + (expanded ? '' : ' hidden') + '>';
    if (!favs.length) {
      html += '<div class="cd-fav__empty">אין תיקים מועדפים. פתח/י תיק ולחצ/י "☆ הוסף תיק זה".</div>';
    } else {
      html += '<ul class="cd-fav__list">' + favs.map((f) =>
        '<li class="cd-fav__item">' +
          '<span class="cd-fav__txt"><span class="cd-fav__id">' + esc((f.type ? f.type + ' ' : '') + f.id) + '</span>' +
          (f.name ? '<span class="cd-fav__nm">' + esc(f.name) + '</span>' : '') + '</span>' +
          '<span class="cd-fav__acts">' +
            '<button type="button" class="cd-panel__btn cd-panel__btn--primary cd-fav-open" data-id="' + esc(f.id) + '">כניסה</button>' +
            '<button type="button" class="cd-fav-rm" data-id="' + esc(f.id) + '" aria-label="הסר">×</button>' +
          '</span></li>').join('') + '</ul>';
    }
    html += '</div>';
    panel.innerHTML = html;
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.id = PANEL_ID; p.className = 'cd-panel cd-fav'; p.dir = 'rtl';
    render(p);
    p.addEventListener('click', async (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      if (btn.classList.contains('cd-fav-expand')) {
        expanded = !expanded;
        try { chrome.storage.local.set({ cd_fav_open: expanded }); } catch (e2) {}
        render(p);
      } else if (btn.classList.contains('cd-fav-toggle')) {
        const cur = currentCase(); if (!cur) return;
        let favs = await getFavs();
        if (favs.some((f) => f.id === cur.id)) favs = favs.filter((f) => f.id !== cur.id);
        else favs = [{ id: cur.id, type: cur.type || '', name: cur.name, ts: Date.now() }].concat(favs);
        await setFavs(favs); render(p);
      } else if (btn.classList.contains('cd-fav-open')) {
        const id = btn.getAttribute('data-id');
        if (CD.caseOpenSubmit) CD.caseOpenSubmit(id); // fills the locator + clicks אתר
      } else if (btn.classList.contains('cd-fav-rm')) {
        const id = btn.getAttribute('data-id');
        await setFavs((await getFavs()).filter((f) => f.id !== id)); render(p);
      }
    });
    return p;
  }

  function mount() {
    if (!onCourtPage()) return;
    const floating = !!(CD.uiFloating && CD.uiFloating());
    const ex = document.getElementById(PANEL_ID);
    if (ex && ex.isConnected) {
      if (!!ex.closest('#cd-float') === floating) return; // right place already
      ex.remove();
    } else if (ex) ex.remove();
    const panel = buildPanel();
    if (floating && CD.floatBody) { CD.floatBody().appendChild(panel); return; }
    // Inline: into the shared tools row (side-by-side with quick-locate on wide
    // screens, stacked on narrow ones — see #cd-tools-row in toolbar.css).
    const row = (CD.toolsRow && CD.toolsRow()) || null;
    if (row) { row.appendChild(panel); return; }
    // Fallback: right after the quick-locate strip, wherever it mounted.
    const anchor = document.getElementById('cd-caseopen-panel');
    if (anchor && anchor.parentElement) { anchor.parentElement.insertBefore(panel, anchor.nextSibling); return; }
    if (CD.floatBody) CD.floatBody().appendChild(panel);
    else (document.body || document.documentElement).appendChild(panel);
  }

  function boot() {
    if (!onCourtPage()) return;
    mount();
    let n = 0;
    const iv = setInterval(() => { mount(); if (++n >= 6) clearInterval(iv); }, 800);
    try { new MutationObserver(() => mount()).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.cd_favorites) { const p = document.getElementById(PANEL_ID); if (p) render(p); }
        if (ch.cd_settings) setTimeout(mount, 0);
      });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : self);
