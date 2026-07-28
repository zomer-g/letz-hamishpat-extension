// shared/ui-host.js — appearance mode + a single floating window host.
//
// Two UI placements for the extension's download/export panels:
//   • inline  (default) — each panel is inserted into the site DOM next to the
//     grid it belongs to, exactly as before.
//   • floating — every panel is instead placed inside ONE draggable floating
//     window overlaid on the page. Because each panel only mounts when its
//     feature is relevant to the current page, the floating window's content
//     naturally adapts to whatever the page offers.
//
// Public surface (on window.CD):
//   CD.setUiConfig(ui)     — cache { showClownHat, floating } (from settings.ui).
//   CD.uiFloating()        — bool.
//   CD.uiShowClownHat()    — bool (default true).
//   CD.placePanel(panel, inlineAnchor) — put a panel inline (before the anchor)
//     or into the floating window, per the current mode.
//   CD.floatBody()         — the floating window's body element (lazily created).

(function (root) {
  const CD = root.CD || (root.CD = {});
  let cfg = { showClownHat: true, floating: false };

  CD.setUiConfig = function (ui) {
    cfg = {
      showClownHat: !ui || ui.showClownHat !== false,
      floating: !!(ui && ui.floating),
    };
    // Live-apply a mode switch: relocate any panels already on the page.
    try { relocateExistingPanels(); } catch (e) {}
  };
  CD.uiFloating = function () { return !!cfg.floating; };
  CD.uiShowClownHat = function () { return cfg.showClownHat !== false; };

  // ── the floating window ────────────────────────────────────────────────
  function ensureWindow() {
    let win = document.getElementById('cd-float');
    if (win) return win;
    win = document.createElement('div');
    win.id = 'cd-float';
    win.dir = 'rtl';
    win.className = 'cd-float';
    win.innerHTML =
      '<div class="cd-float__bar" id="cd-float-bar">' +
        '<span class="cd-float__title">🧰 כלי נט המשפט</span>' +
        '<button type="button" class="cd-float__btn" data-cdf="min" title="מזער">–</button>' +
        '<button type="button" class="cd-float__btn" data-cdf="close" title="הסתר">×</button>' +
      '</div>' +
      '<div class="cd-float__body" id="cd-float-body"></div>';
    (document.body || document.documentElement).appendChild(win);

    const bar = win.querySelector('#cd-float-bar');
    bar.addEventListener('click', function (e) {
      const b = e.target.closest && e.target.closest('[data-cdf]');
      if (!b) return;
      if (b.dataset.cdf === 'close') win.style.display = 'none';
      else if (b.dataset.cdf === 'min') win.classList.toggle('cd-float--min');
    });
    makeDraggable(win, bar);

    const body = win.querySelector('#cd-float-body');
    const reflect = () => { win.style.display = (body && body.children.length) ? '' : 'none'; };
    try { new MutationObserver(reflect).observe(body, { childList: true }); } catch (e) {}
    reflect();
    return win;
  }

  function makeDraggable(win, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('[data-cdf]')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = win.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
      document.addEventListener('mousemove', mm, true);
      document.addEventListener('mouseup', mu, true);
    });
    function mm(e) {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(nx, window.innerWidth - 60));
      ny = Math.max(0, Math.min(ny, window.innerHeight - 30));
      win.style.left = nx + 'px'; win.style.top = ny + 'px'; win.style.right = 'auto';
    }
    function mu() { dragging = false; document.removeEventListener('mousemove', mm, true); document.removeEventListener('mouseup', mu, true); }
  }

  CD.floatBody = function () { ensureWindow(); return document.getElementById('cd-float-body'); };

  // ── panel placement ────────────────────────────────────────────────────
  CD.placePanel = function (panel, inlineAnchor) {
    if (!panel) return;
    panel.setAttribute('data-cd-floatable', '1');
    if (cfg.floating) {
      const body = CD.floatBody();
      if (panel.parentElement !== body) body.appendChild(panel);
      // Inline width-matching (set by some panels) must not stick in the window.
      panel.style.width = '';
      return;
    }
    if (inlineAnchor && inlineAnchor.parentElement) inlineAnchor.parentElement.insertBefore(panel, inlineAnchor);
    else if (panel.parentElement == null) (document.body || document.documentElement).insertBefore(panel, (document.body || document.documentElement).firstChild);
  };

  // On a live mode switch, move panels that are already mounted. Inline→float
  // just re-parents them into the window; float→inline drops them back near the
  // page top (the panels' own watchdogs re-anchor them precisely on the next
  // tick / page load).
  function relocateExistingPanels() {
    const panels = document.querySelectorAll('[data-cd-floatable="1"]');
    if (!panels.length) return;
    if (cfg.floating) {
      const body = CD.floatBody();
      panels.forEach((p) => { if (p.parentElement !== body) { body.appendChild(p); p.style.width = ''; } });
    } else {
      const win = document.getElementById('cd-float');
      const body = win && document.getElementById('cd-float-body');
      if (body) {
        panels.forEach((p) => { if (p.parentElement === body) (document.body || document.documentElement).insertBefore(p, (document.body || document.documentElement).firstChild); });
        win.style.display = 'none';
      }
    }
  }

  // ── self-init: keep the cached ui config fresh ─────────────────────────
  try {
    if (CD.getSettings) CD.getSettings().then((s) => CD.setUiConfig(s && s.ui));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.cd_settings && CD.getSettings) CD.getSettings().then((s) => CD.setUiConfig(s && s.ui));
    });
  } catch (e) {}
})(typeof window !== 'undefined' ? window : self);
