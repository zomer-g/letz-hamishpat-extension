// Cross-browser shim (Firefox: chrome→browser). No-op on Chrome. Inlined
// rather than imported so it runs before anything else in this context.
if (typeof browser !== 'undefined' && browser !== globalThis.chrome) {
  try { globalThis.chrome = browser; } catch (e) {}
}

(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    local: $('dest-local'), server: $('dest-server'), drive: $('dest-drive'),
    endpoint: $('server-endpoint'), apikey: $('server-apikey'),
    serverTest: $('server-test'), serverStatus: $('server-status'),
    driveConnect: $('drive-connect'), driveDisconnect: $('drive-disconnect'), driveAccount: $('drive-account'), driveSkip: $('drive-skip'),
    driveSkipRow: $('drive-skip-row'), driveTargetName: $('drive-target-name'),
    serverCard: $('server-card'), driveCard: $('drive-card'),
    save: $('save'), saveStatus: $('save-status'),
    tabDocs: $('tab-documents'), tabHearings: $('tab-hearings'), profileNote: $('profile-note'),
  };

  // Two profiles: 'documents' (top-level settings) and 'hearings'
  // (settings.hearings). Google connect is account-level (global); all other
  // fields are per-profile. Dedupe (skip existing) is documents-only.
  let activeProfile = 'documents';
  let settings = null;

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = 'cdo-status' + (cls ? ' ' + cls : '');
  }
  function reflectEnabled() {
    els.serverCard.classList.toggle('disabled', !els.server.checked);
    els.driveCard.classList.toggle('disabled', !els.drive.checked);
    if (els.driveSkipRow) els.driveSkipRow.style.display = (activeProfile === 'documents') ? '' : 'none';
  }

  function prof() { return window.CD.getProfile(settings, activeProfile); }

  function renderProfile() {
    const p = prof();
    els.local.checked = !!p.destinations.localZip;
    els.server.checked = !!p.destinations.server;
    els.drive.checked = !!p.destinations.drive;
    els.endpoint.value = p.server.endpoint || '';
    els.apikey.value = p.server.apiKey || '';
    if (els.driveSkip) els.driveSkip.checked = activeProfile === 'documents' ? !!(p.dedupe && p.dedupe.driveSkipExisting) : false;
    if (els.driveTargetName) els.driveTargetName.textContent = p.drive.folderName || 'מסמכי נט המשפט';
    if (els.profileNote) {
      els.profileNote.innerHTML = activeProfile === 'documents'
        ? 'ההגדרות הבאות חלות על <b>הורדת מסמכים והחלטות</b>.'
        : 'ההגדרות הבאות חלות על <b>ייצוא דיונים</b> (CSV + יומן/ICS).';
    }
    els.tabDocs.classList.toggle('cdo-tab--active', activeProfile === 'documents');
    els.tabHearings.classList.toggle('cdo-tab--active', activeProfile === 'hearings');
    reflectEnabled();
  }

  // Load existing settings.
  window.CD.getSettings().then((s) => { settings = s; renderProfile(); });

  function switchProfile(name) {
    if (name === activeProfile) return;
    activeProfile = name;
    window.CD.getSettings().then((s) => { settings = s; renderProfile(); });
  }
  els.tabDocs.addEventListener('click', () => switchProfile('documents'));
  els.tabHearings.addEventListener('click', () => switchProfile('hearings'));

  els.server.addEventListener('change', reflectEnabled);
  els.drive.addEventListener('change', reflectEnabled);

  function originPattern(url) {
    try { const u = new URL(url); return u.origin + '/*'; } catch (e) { return null; }
  }

  els.save.addEventListener('click', async () => {
    const endpoint = els.endpoint.value.trim();
    if (els.server.checked && endpoint) {
      const pat = originPattern(endpoint);
      if (pat) {
        const granted = await new Promise((res) =>
          chrome.permissions.request({ origins: [pat] }, (g) => res(g)));
        if (!granted) { setStatus(els.saveStatus, 'נדרשת הרשאה לכתובת השרת — לא נשמר.', 'err'); return; }
      }
    }
    // Note: the Drive target folder is saved directly by the folder picker,
    // so it is intentionally NOT part of this patch (avoid overwriting it).
    const partial = {
      destinations: { localZip: els.local.checked, server: els.server.checked, drive: els.drive.checked },
      server: { endpoint: endpoint, apiKey: els.apikey.value },
    };
    if (activeProfile === 'documents') {
      partial.dedupe = { driveSkipExisting: els.driveSkip ? els.driveSkip.checked : true };
    }
    settings = await window.CD.saveSettings(window.CD.profilePatch(activeProfile, partial));
    setStatus(els.saveStatus, '✓ נשמר (' + (activeProfile === 'documents' ? 'מסמכים' : 'דיונים') + ')', 'ok');
    setTimeout(() => setStatus(els.saveStatus, ''), 2500);
  });

  // Test server connectivity (active profile's endpoint).
  els.serverTest.addEventListener('click', async () => {
    const endpoint = els.endpoint.value.trim();
    if (!endpoint) { setStatus(els.serverStatus, 'הזן כתובת תחילה', 'err'); return; }
    const pat = originPattern(endpoint);
    if (pat) {
      const granted = await new Promise((res) => chrome.permissions.request({ origins: [pat] }, res));
      if (!granted) { setStatus(els.serverStatus, 'נדרשת הרשאה לכתובת', 'err'); return; }
    }
    setStatus(els.serverStatus, 'בודק…', 'muted');
    chrome.runtime.sendMessage(
      { type: 'cd/testServer', endpoint, apiKey: els.apikey.value },
      (resp) => {
        if (chrome.runtime.lastError) { setStatus(els.serverStatus, 'שגיאה: ' + chrome.runtime.lastError.message, 'err'); return; }
        if (resp && resp.ok) setStatus(els.serverStatus, '✓ הגיע לשרת (קוד ' + resp.status + ')', 'ok');
        else setStatus(els.serverStatus, 'נכשל: ' + ((resp && resp.error) || 'no response'), 'err');
      }
    );
  });

  // Connect Google Drive — account-level (interactive OAuth via the SW).
  // BASIC scope set only: drive.file. No "unverified app" warning, and the SW
  // auto-creates "מסמכי נט המשפט" as the default target folder.
  els.driveConnect.addEventListener('click', () => {
    setStatus(els.driveAccount, 'פותח חלון הזדהות…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/driveConnect' }, async (resp) => {
      if (chrome.runtime.lastError) { setStatus(els.driveAccount, 'שגיאה: ' + chrome.runtime.lastError.message, 'err'); return; }
      if (resp && resp.ok) {
        setStatus(els.driveAccount, '✓ מחובר' + (resp.email ? ' (' + resp.email + ')' : ''), 'ok');
        // Re-render so the auto-created default folder name shows up.
        try { settings = await window.CD.getSettings(); renderProfile(); } catch (e) {}
      } else {
        setStatus(els.driveAccount, 'נכשל: ' + ((resp && resp.error) || 'אין client_id מוגדר? ראה SETUP.md'), 'err');
      }
    });
  });

  if (els.driveDisconnect) els.driveDisconnect.addEventListener('click', () => {
    setStatus(els.driveAccount, 'מנתק…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/disconnectGoogle' }, (resp) => {
      if (chrome.runtime.lastError) { setStatus(els.driveAccount, 'שגיאה: ' + chrome.runtime.lastError.message, 'err'); return; }
      setStatus(els.driveAccount, '✓ החשבון נותק. בהתחברות הבאה תתבקש/י לבחור חשבון מחדש.', 'muted');
    });
  });

  // ---- Drive folder browser ----
  // Needs the FULL scope set (drive.file + drive.metadata.readonly) so the
  // listing API can return folders the user already owns. We request that
  // scope only here, behind the "אפשרויות מתקדמות" disclosure, so 99% of
  // users never see Google's "unverified app" warning.
  const fb = {
    browse: $('drive-browse'), panel: $('drive-browser'), bc: $('drive-bc'),
    list: $('drive-list'), pick: $('drive-pick'), close: $('drive-browse-close'),
    status: $('drive-browse-status'),
    newBtn: $('drive-newfolder'), newRow: $('drive-new-row'), newName: $('drive-new-name'), newCreate: $('drive-new-create'),
    advancedStatus: $('drive-advanced-status'),
  };
  let fbStack = [{ id: 'root', name: 'My Drive' }];
  const fbCurrent = () => fbStack[fbStack.length - 1];

  function fbRenderBc() {
    fb.bc.innerHTML = '';
    fbStack.forEach((node, i) => {
      if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; fb.bc.appendChild(s); }
      const a = document.createElement('a'); a.textContent = node.name;
      a.addEventListener('click', () => { fbStack = fbStack.slice(0, i + 1); fbLoad(); });
      fb.bc.appendChild(a);
    });
    fb.pick.textContent = 'בחר את "' + fbCurrent().name + '"';
  }
  function fbLoad() {
    fbRenderBc();
    if (fb.newRow) fb.newRow.hidden = true;
    fb.list.innerHTML = '<li class="empty">טוען…</li>';
    const cur = fbCurrent();
    chrome.runtime.sendMessage({ type: 'cd/driveListFolders', parentId: cur.id === 'root' ? '' : cur.id }, (resp) => {
      if (chrome.runtime.lastError) { fb.list.innerHTML = ''; setStatus(fb.status, 'שגיאה: ' + chrome.runtime.lastError.message, 'err'); return; }
      if (!resp || !resp.ok) { fb.list.innerHTML = ''; setStatus(fb.status, 'נכשל: ' + ((resp && resp.error) || 'התחבר ל־Google תחילה (ואשר את ההרשאה החדשה)'), 'err'); return; }
      setStatus(fb.status, '');
      const folders = resp.folders || [];
      fb.list.innerHTML = '';
      if (!folders.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'אין תת־תיקיות כאן — אפשר ליצור חדשה'; fb.list.appendChild(li); return; }
      folders.forEach((f) => {
        const li = document.createElement('li'); li.textContent = f.name; li.title = 'פתח את ' + f.name;
        li.addEventListener('click', () => { fbStack.push({ id: f.id, name: f.name }); fbLoad(); });
        fb.list.appendChild(li);
      });
    });
  }
  fb.browse.addEventListener('click', () => {
    // Trigger the FULL OAuth grant first (drive.file + drive.metadata.readonly).
    // The user will see Google's "unverified app" warning here — that's
    // expected until verification + CASA complete, and matches the warning
    // text we showed in the "אפשרויות מתקדמות" disclosure.
    if (fb.advancedStatus) setStatus(fb.advancedStatus, 'מבקש הרשאת קריאת שמות תיקיות…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/driveConnectFull' }, (resp) => {
      if (chrome.runtime.lastError) {
        if (fb.advancedStatus) setStatus(fb.advancedStatus, 'שגיאה: ' + chrome.runtime.lastError.message, 'err');
        return;
      }
      if (!resp || !resp.ok) {
        if (fb.advancedStatus) setStatus(fb.advancedStatus, 'נכשל / בוטל: ' + ((resp && resp.error) || ''), 'err');
        return;
      }
      if (fb.advancedStatus) setStatus(fb.advancedStatus, '✓ אושר. טוען תיקיות…', 'ok');
      const willShow = fb.panel.hidden;
      fb.panel.hidden = !willShow;
      if (willShow) { fbStack = [{ id: 'root', name: 'My Drive' }]; fbLoad(); }
    });
  });
  fb.close.addEventListener('click', () => { fb.panel.hidden = true; });
  fb.pick.addEventListener('click', async () => {
    const cur = fbCurrent();
    const id = cur.id === 'root' ? '' : cur.id;
    settings = await window.CD.saveSettings(window.CD.profilePatch(activeProfile, { drive: { folderId: id, folderName: cur.name } }));
    if (els.driveTargetName) els.driveTargetName.textContent = cur.name;
    fb.panel.hidden = true;
  });

  // Create a new sub-folder in the current location.
  if (fb.newBtn) {
    fb.newBtn.addEventListener('click', () => {
      fb.newRow.hidden = !fb.newRow.hidden;
      if (!fb.newRow.hidden) { fb.newName.value = ''; fb.newName.focus(); }
    });
    const createFolder = () => {
      const name = (fb.newName.value || '').trim();
      if (!name) { fb.newName.focus(); return; }
      const cur = fbCurrent();
      setStatus(fb.status, 'יוצר תיקייה…', 'muted');
      chrome.runtime.sendMessage({ type: 'cd/driveEnsureFolder', parentId: cur.id === 'root' ? '' : cur.id, name }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) { setStatus(fb.status, 'יצירה נכשלה: ' + ((r && r.error) || ''), 'err'); return; }
        fb.newRow.hidden = true;
        fbStack.push({ id: r.id, name: r.name || name });
        fbLoad();
      });
    };
    fb.newCreate.addEventListener('click', createFolder);
    fb.newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') createFolder(); });
  }
})();

// ── Google Calendar sync tab ───────────────────────────────────────────────
// Self-contained: configures the calendar layer, sync window (months ahead),
// and the event-format templates. Persisted under settings.calendarSync.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    tabDocs: $('tab-documents'), tabHearings: $('tab-hearings'), tabCal: $('tab-calendar'),
    viewProfile: $('view-profile'), viewCalendar: $('view-calendar'),
    connect: $('cal-connect'), connectStatus: $('cal-connect-status'),
    select: $('cal-select'), newcal: $('cal-newcal'), pickStatus: $('cal-pick-status'),
    months: $('cal-months'),
    tplTitle: $('cal-tpl-title'), tplLocation: $('cal-tpl-location'), tplDesc: $('cal-tpl-desc'),
    save: $('cal-save'), saveStatus: $('cal-save-status'),
  };
  if (!el.tabCal) return;

  let cs = null;          // calendarSync config
  let calendars = null;   // loaded calendar list (or null)

  function st(node, text, cls) { if (node) { node.textContent = text; node.className = 'cdo-status' + (cls ? ' ' + cls : ''); } }

  function showCalendarView() {
    el.viewProfile.hidden = true;
    el.viewCalendar.hidden = false;
    el.tabDocs.classList.remove('cdo-tab--active');
    el.tabHearings.classList.remove('cdo-tab--active');
    el.tabCal.classList.add('cdo-tab--active');
  }
  function showProfileView() {
    el.viewCalendar.hidden = true;
    el.viewProfile.hidden = false;
    el.tabCal.classList.remove('cdo-tab--active');
  }
  el.tabCal.addEventListener('click', showCalendarView);
  el.tabDocs.addEventListener('click', showProfileView);
  el.tabHearings.addEventListener('click', showProfileView);

  function opt(value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }

  function renderSelect() {
    const sel = el.select; if (!sel) return;
    // What the user currently has picked, BEFORE the list is rebuilt. Rebuilding
    // used to reset the selection to the SAVED id, which silently discarded a
    // choice the user had made but not saved yet — pick a calendar (or create
    // one), press "התחבר וטען יומנים" again, and it jumped back to the old target.
    const onScreen = sel.value;
    sel.innerHTML = '';
    if (Array.isArray(calendars)) {
      if (!calendars.length) sel.appendChild(opt('', 'אין יומנים זמינים'));
      calendars.forEach((c) => sel.appendChild(opt(c.id, c.summary + (c.primary ? ' (ראשי)' : ''))));
      sel.value = pickValue(sel, onScreen);
    } else {
      // Not loaded yet — show the saved target (if any) + a prompt.
      if (cs && cs.calendarId) sel.appendChild(opt(cs.calendarId, cs.calendarName || cs.calendarId));
      sel.appendChild(opt('', 'לחץ "התחבר וטען יומנים"…'));
      sel.value = pickValue(sel, onScreen);
    }
  }
  // Keep the on-screen choice when it still exists, else the saved one, else
  // the first calendar. Never silently move the user to a different calendar.
  function pickValue(sel, onScreen) {
    const has = (v) => !!v && Array.prototype.some.call(sel.options, (o) => o.value === v);
    if (has(onScreen)) return onScreen;
    if (has(cs && cs.calendarId)) return cs.calendarId;
    return (sel.options[0] && sel.options[0].value) || '';
  }

  function renderConfig() {
    el.months.value = (cs && cs.monthsAhead) || 12;
    el.tplTitle.value = (cs && cs.titleTemplate != null) ? cs.titleTemplate : '{caseId} {caseName}';
    el.tplLocation.value = (cs && cs.locationTemplate != null) ? cs.locationTemplate : '{court}';
    el.tplDesc.value = (cs && cs.descriptionTemplate != null) ? cs.descriptionTemplate : 'שופט: {judge}';
    renderSelect();
  }

  window.CD.getSettings().then((s) => { cs = s.calendarSync || {}; renderConfig(); });

  el.connect.addEventListener('click', () => {
    st(el.connectStatus, 'מתחבר…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/calConnect' }, (r) => {
      if (chrome.runtime.lastError) { st(el.connectStatus, 'שגיאה: ' + chrome.runtime.lastError.message, 'err'); return; }
      if (!r || !r.ok) { st(el.connectStatus, 'נכשל: ' + ((r && r.error) || 'ראה SETUP.md'), 'err'); return; }
      st(el.connectStatus, '✓ מחובר' + (r.email ? ' (' + r.email + ')' : '') + ' — טוען יומנים…', 'ok');
      chrome.runtime.sendMessage({ type: 'cd/calListCalendars' }, (lr) => {
        if (chrome.runtime.lastError) { st(el.connectStatus, 'שגיאת טעינה: ' + chrome.runtime.lastError.message, 'err'); return; }
        if (!lr || !lr.ok) {
          const err = String((lr && lr.error) || '');
          if (/403|disabled|has not been used|PERMISSION_DENIED/i.test(err)) {
            // Calendar API not enabled in the OAuth client's Cloud project.
            el.connectStatus.className = 'cdo-status err';
            el.connectStatus.innerHTML = 'ה-Google Calendar API אינו מופעל בפרויקט. הפעל אותו כאן ואז נסה שוב: ' +
              '<a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=548153685379" target="_blank" rel="noopener">הפעלת Calendar API</a> ' +
              '(אחרי ההפעלה המתן דקה).';
          } else {
            st(el.connectStatus, 'טעינת יומנים נכשלה: ' + err.slice(0, 100), 'err');
          }
          return;
        }
        calendars = lr.calendars || [];
        renderSelect();
        st(el.connectStatus, '✓ נטענו ' + calendars.length + ' יומנים. בחר שכבה ולחץ "שמור הגדרות יומן".', 'ok');
      });
    });
  });

  el.newcal.addEventListener('click', () => {
    const name = window.prompt('שם היומן החדש ב-Google Calendar:', 'דיונים — נט המשפט');
    if (!name) return;
    st(el.pickStatus, 'יוצר יומן…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/calCreateCalendar', summary: name }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok) { st(el.pickStatus, 'יצירה נכשלה: ' + ((r && r.error) || ''), 'err'); return; }
      if (!Array.isArray(calendars)) calendars = [];
      calendars.push({ id: r.id, summary: r.summary || name, primary: false });
      renderSelect();
      el.select.value = r.id;
      st(el.pickStatus, '✓ נוצר "' + (r.summary || name) + '". לחץ "שמור הגדרות יומן".', 'ok');
    });
  });

  el.save.addEventListener('click', async () => {
    const selectedId = el.select.value;
    const selLabel = el.select.options[el.select.selectedIndex] ? el.select.options[el.select.selectedIndex].textContent : '';
    let months = parseInt(el.months.value, 10);
    if (!(months >= 1 && months <= 36)) months = 12;
    const patch = {
      calendarSync: {
        calendarId: selectedId || (cs && cs.calendarId) || '',
        calendarName: selectedId ? selLabel : (cs && cs.calendarName) || '',
        monthsAhead: months,
        titleTemplate: el.tplTitle.value,
        locationTemplate: el.tplLocation.value,
        descriptionTemplate: el.tplDesc.value,
      },
    };
    const merged = await window.CD.saveSettings(patch);
    cs = merged.calendarSync;
    st(el.saveStatus, '✓ נשמר', 'ok');
    setTimeout(() => st(el.saveStatus, ''), 2500);
  });
})();

// ── Appearance (מראה): clown hat + inline/floating placement ────────────────
(function () {
  const hat = document.getElementById('ui-clownhat');
  const mode = document.getElementById('ui-mode');
  if (!hat || !mode) return;
  let ui = { showClownHat: true, floating: false };

  window.CD.getSettings().then((s) => {
    ui = s.ui || ui;
    hat.checked = ui.showClownHat !== false;
    mode.value = ui.floating ? 'floating' : 'inline';
  });

  function save() {
    window.CD.saveSettings({ ui: { showClownHat: hat.checked, floating: mode.value === 'floating' } });
  }
  hat.addEventListener('change', save);
  mode.addEventListener('change', save);
})();
