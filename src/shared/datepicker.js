// shared/datepicker.js — a tiny self-contained Hebrew (RTL) calendar popup.
//
// Why not <input type="date">? Its native picker formats values as ISO and
// its month/year navigation is inconsistent across browsers. We want a
// click-only popup (no manual typing), Hebrew month names, and quick
// month+year jumping. So we render our own.
//
// Public surface:
//   CD.attachDatePicker(inputEl) — makes the text input read-only and opens a
//     calendar popup on click/focus. The chosen day is written back as
//     "dd/mm/yyyy" and a 'change' event is dispatched (so existing listeners
//     keep working). Idempotent per element.
//
// The popup is appended to <body> with position:fixed (robust against the
// court site's transformed ancestors) and closes on outside-click / Escape.

(function (root) {
  const CD = root.CD || (root.CD = {});

  const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']; // Sunday-first (Israel)

  let openPopup = null; // the single currently-open popup element

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(y, m, d) { return pad2(d) + '/' + pad2(m + 1) + '/' + y; } // m is 0-based
  function parse(str) {
    const m = String(str || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return { y: +m[3], m: +m[2] - 1, d: +m[1] };
  }

  function closeOpen() {
    if (openPopup) { try { openPopup.remove(); } catch (e) {} openPopup = null; }
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onReposition, true);
    window.removeEventListener('scroll', onReposition, true);
  }
  function onDocDown(e) {
    if (openPopup && !openPopup.contains(e.target) && e.target !== openPopup._anchor) closeOpen();
  }
  function onKeyDown(e) { if (e.key === 'Escape') closeOpen(); }
  function onReposition() { if (openPopup) position(openPopup, openPopup._anchor); }

  function position(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = 252, h = pop.offsetHeight || 300;
    let left = r.left;
    if (left + w > window.innerWidth - 6) left = window.innerWidth - w - 6;
    if (left < 6) left = 6;
    let top = r.bottom + 2;
    if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 2);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function buildPopup(anchor) {
    const today = new Date();
    const valParsed = parse(anchor.value);
    const cur = valParsed || { y: today.getFullYear(), m: today.getMonth(), d: today.getDate() };
    // When the field is empty but bounded (e.g. a "to" field constrained by the
    // chosen "from"), open the view on the lower bound's month so the selectable
    // days are visible immediately instead of a fully-disabled current month.
    const viewSrc = valParsed || parse(anchor.dataset.cdMin || '') || cur;
    let viewY = viewSrc.y, viewM = viewSrc.m;

    const pop = document.createElement('div');
    pop.className = 'cd-dp';
    pop.dir = 'rtl';
    pop._anchor = anchor;

    const head = document.createElement('div');
    head.className = 'cd-dp__head';

    const prev = btn('‹', 'cd-dp__nav');
    const next = btn('›', 'cd-dp__nav');

    const monthSel = document.createElement('select');
    monthSel.className = 'cd-dp__sel';
    MONTHS.forEach((name, i) => monthSel.appendChild(opt(i, name)));

    const yearSel = document.createElement('select');
    yearSel.className = 'cd-dp__sel';
    const baseY = today.getFullYear();
    for (let y = baseY - 10; y <= baseY + 10; y++) yearSel.appendChild(opt(y, y));

    head.appendChild(prev);
    head.appendChild(monthSel);
    head.appendChild(yearSel);
    head.appendChild(next);
    pop.appendChild(head);

    const dowRow = document.createElement('div');
    dowRow.className = 'cd-dp__dow';
    DOW.forEach((d) => { const s = document.createElement('span'); s.textContent = d; dowRow.appendChild(s); });
    pop.appendChild(dowRow);

    const grid = document.createElement('div');
    grid.className = 'cd-dp__grid';
    pop.appendChild(grid);

    function render() {
      monthSel.value = String(viewM);
      yearSel.value = String(viewY);
      grid.innerHTML = '';
      // Optional min/max bounds (dd/mm/yyyy) read live from the input's dataset,
      // so callers can tighten them between opens (e.g. a "to" field bounded by
      // the chosen "from" date + a max range).
      const dmin = parse(anchor.dataset.cdMin || '');
      const dmax = parse(anchor.dataset.cdMax || '');
      const minT = dmin ? new Date(dmin.y, dmin.m, dmin.d).getTime() : -Infinity;
      const maxT = dmax ? new Date(dmax.y, dmax.m, dmax.d).getTime() : Infinity;
      const first = new Date(viewY, viewM, 1);
      const startDow = first.getDay(); // 0=Sun
      const start = new Date(viewY, viewM, 1 - startDow);
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cd-dp__day';
        cell.textContent = d.getDate();
        const inMonth = d.getMonth() === viewM;
        if (!inMonth) cell.classList.add('cd-dp__day--other');
        if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
          cell.classList.add('cd-dp__day--today');
        }
        if (cur && d.getFullYear() === cur.y && d.getMonth() === cur.m && d.getDate() === cur.d) {
          cell.classList.add('cd-dp__day--sel');
        }
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        if (t < minT || t > maxT) {
          cell.classList.add('cd-dp__day--dis');
          cell.disabled = true;
        } else {
          cell.addEventListener('click', () => {
            anchor.value = fmt(d.getFullYear(), d.getMonth(), d.getDate());
            anchor.dispatchEvent(new Event('change', { bubbles: true }));
            closeOpen();
          });
        }
        grid.appendChild(cell);
      }
    }

    prev.addEventListener('click', () => { viewM--; if (viewM < 0) { viewM = 11; viewY--; } render(); });
    next.addEventListener('click', () => { viewM++; if (viewM > 11) { viewM = 0; viewY++; } render(); });
    monthSel.addEventListener('change', () => { viewM = +monthSel.value; render(); });
    yearSel.addEventListener('change', () => { viewY = +yearSel.value; render(); });

    render();
    return pop;
  }

  function btn(text, cls) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = text;
    return b;
  }
  function opt(value, label) {
    const o = document.createElement('option');
    o.value = String(value); o.textContent = String(label);
    return o;
  }

  function openFor(anchor) {
    closeOpen();
    const pop = buildPopup(anchor);
    document.body.appendChild(pop);
    openPopup = pop;
    position(pop, anchor);
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition, true);
    window.addEventListener('scroll', onReposition, true);
  }

  function attachDatePicker(input) {
    if (!input || input.dataset.cdDp === '1') return;
    input.dataset.cdDp = '1';
    input.readOnly = true;
    input.autocomplete = 'off';
    input.style.cursor = 'pointer';
    input.style.backgroundColor = '#fff';
    const open = (e) => { e.preventDefault(); if (openPopup && openPopup._anchor === input) closeOpen(); else openFor(input); };
    input.addEventListener('click', open);
    input.addEventListener('focus', () => { if (!openPopup) openFor(input); });
  }

  CD.attachDatePicker = attachDatePicker;
})(typeof window !== 'undefined' ? window : self);
