(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    local: $('dest-local'), server: $('dest-server'), drive: $('dest-drive'),
    apiEndpoint: $('api-endpoint'), apiKey: $('api-key'), apiSave: $('api-save'), apiTest: $('api-test'), apiStatus: $('api-status'),
    apiCard: $('api-card'), driveCard: $('drive-card'),
    driveConnect: $('drive-connect'), driveStatus: $('drive-status'), driveSkip: $('drive-skip'),
    driveSkipRow: $('drive-skip-row'), driveTargetName: $('drive-target-name'),
    openOptions: $('open-options'), openAbout: $('open-about'),
    tabDocs: $('tab-documents'), tabHearings: $('tab-hearings'), profileTag: $('profile-tag'),
  };

  // Active profile: 'documents' (top-level settings) or 'hearings'
  // (settings.hearings). Drive *connect* (OAuth) is account-level and stays
  // global; everything else (destinations, API endpoint/key, target folder,
  // dedupe) is per-profile. dedupe applies to documents only.
  let activeProfile = 'documents';
  let settings = null;

  function setStatus(el, text, cls) { el.textContent = text; el.className = 'pu-status' + (cls ? ' ' + cls : ''); }
  function reflect() {
    els.apiCard.classList.toggle('disabled', !els.server.checked);
    els.driveCard.classList.toggle('disabled', !els.drive.checked);
    // Dedupe is documents-only.
    if (els.driveSkipRow) els.driveSkipRow.style.display = (activeProfile === 'documents') ? '' : 'none';
  }
  function originPattern(url) { try { return new URL(url).origin + '/*'; } catch (e) { return null; } }
  function reqPerm(url) {
    const pat = originPattern(url);
    if (!pat) return Promise.resolve(true);
    return new Promise((res) => chrome.permissions.request({ origins: [pat] }, (g) => res(g)));
  }

  function prof() { return window.CD.getProfile(settings, activeProfile); }

  // Render the current profile's values into the shared inputs.
  function renderProfile() {
    const p = prof();
    els.local.checked = !!p.destinations.localZip;
    els.server.checked = !!p.destinations.server;
    els.drive.checked = !!p.destinations.drive;
    els.apiEndpoint.value = p.server.endpoint || '';
    els.apiKey.value = p.server.apiKey || '';
    els.driveSkip.checked = activeProfile === 'documents' ? !!(p.dedupe && p.dedupe.driveSkipExisting) : false;
    if (els.driveTargetName) els.driveTargetName.textContent = p.drive.folderName || 'שורש Drive';
    if (els.profileTag) els.profileTag.textContent = activeProfile === 'documents' ? 'מסמכים' : 'דיונים';
    els.tabDocs.classList.toggle('pu-tab--active', activeProfile === 'documents');
    els.tabHearings.classList.toggle('pu-tab--active', activeProfile === 'hearings');
    reflect();
  }

  // Persist a partial config to the active profile, then refresh local copy.
  function saveProfile(partial) {
    const patch = window.CD.profilePatch(activeProfile, partial);
    return window.CD.saveSettings(patch).then((merged) => { settings = merged; });
  }

  // Load settings once.
  window.CD.getSettings().then((s) => { settings = s; renderProfile(); });

  // Tab switching — reload from storage so unsaved text edits don't bleed
  // across profiles (matches the explicit-save model for API/folder).
  function switchProfile(name) {
    if (name === activeProfile) return;
    activeProfile = name;
    window.CD.getSettings().then((s) => { settings = s; renderProfile(); });
  }
  els.tabDocs.addEventListener('click', () => switchProfile('documents'));
  els.tabHearings.addEventListener('click', () => switchProfile('hearings'));

  // Destinations persist immediately on toggle (to the active profile).
  function saveDests() {
    saveProfile({ destinations: { localZip: els.local.checked, server: els.server.checked, drive: els.drive.checked } });
    reflect();
  }
  els.local.addEventListener('change', saveDests);
  els.server.addEventListener('change', saveDests);
  els.drive.addEventListener('change', saveDests);

  // Save API (active profile).
  els.apiSave.addEventListener('click', async () => {
    const ep = els.apiEndpoint.value.trim();
    if (ep) { const ok = await reqPerm(ep); if (!ok) { setStatus(els.apiStatus, 'נדרשת הרשאה לכתובת', 'err'); return; } }
    await saveProfile({ server: { endpoint: ep, apiKey: els.apiKey.value } });
    setStatus(els.apiStatus, '✓ נשמר', 'ok');
    setTimeout(() => setStatus(els.apiStatus, ''), 2000);
  });

  // Test API (active profile's endpoint).
  els.apiTest.addEventListener('click', async () => {
    const ep = els.apiEndpoint.value.trim();
    if (!ep) { setStatus(els.apiStatus, 'הזן כתובת', 'err'); return; }
    if (!(await reqPerm(ep))) { setStatus(els.apiStatus, 'נדרשת הרשאה', 'err'); return; }
    setStatus(els.apiStatus, 'בודק…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/testServer', endpoint: ep, apiKey: els.apiKey.value }, (r) => {
      if (chrome.runtime.lastError) { setStatus(els.apiStatus, 'שגיאה', 'err'); return; }
      if (r && r.ok) setStatus(els.apiStatus, '✓ הגיע (' + r.status + ')', 'ok');
      else setStatus(els.apiStatus, 'נכשל: ' + ((r && r.error) || '').slice(0, 24), 'err');
    });
  });

  // Connect Google — account-level (shared by both profiles).
  els.driveConnect.addEventListener('click', () => {
    setStatus(els.driveStatus, 'פותח הזדהות…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/driveConnect' }, (r) => {
      if (chrome.runtime.lastError) { setStatus(els.driveStatus, 'שגיאה: ' + chrome.runtime.lastError.message, 'err'); return; }
      if (r && r.ok) setStatus(els.driveStatus, '✓ מחובר' + (r.email ? ' (' + r.email + ')' : ''), 'ok');
      else setStatus(els.driveStatus, 'נכשל: ' + ((r && r.error) || 'ראה SETUP.md').slice(0, 30), 'err');
    });
  });

  // Persist the dedupe toggle immediately (documents only).
  els.driveSkip.addEventListener('change', () => {
    if (activeProfile === 'documents') saveProfile({ dedupe: { driveSkipExisting: els.driveSkip.checked } });
  });

  // ---- Drive folder browser ----
  const fb = {
    browse: $('drive-browse'), panel: $('drive-browser'), bc: $('drive-bc'),
    list: $('drive-list'), pick: $('drive-pick'), close: $('drive-browse-close'),
    status: $('drive-browse-status'),
    newBtn: $('drive-newfolder'), newRow: $('drive-new-row'), newName: $('drive-new-name'), newCreate: $('drive-new-create'),
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
    // The pick button always names the folder you're currently inside.
    fb.pick.textContent = 'בחר את "' + fbCurrent().name + '"';
  }
  function fbLoad() {
    fbRenderBc();
    fb.newRow.hidden = true;
    fb.list.innerHTML = '<li class="empty">טוען…</li>';
    const cur = fbCurrent();
    chrome.runtime.sendMessage({ type: 'cd/driveListFolders', parentId: cur.id === 'root' ? '' : cur.id }, (resp) => {
      if (chrome.runtime.lastError) { fb.list.innerHTML = ''; setStatus(fb.status, 'שגיאה', 'err'); return; }
      if (!resp || !resp.ok) { fb.list.innerHTML = ''; setStatus(fb.status, ((resp && resp.error) || 'התחבר ל־Google תחילה').slice(0, 40), 'err'); return; }
      setStatus(fb.status, '');
      const folders = resp.folders || [];
      fb.list.innerHTML = '';
      if (!folders.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'אין תת־תיקיות כאן — אפשר ליצור חדשה'; fb.list.appendChild(li); return; }
      folders.forEach((f) => {
        const li = document.createElement('li');
        const nm = document.createElement('span'); nm.className = 'fb-name'; nm.textContent = f.name;
        nm.title = 'פתח את "' + f.name + '" (כניסה לתת־תיקיות)';
        nm.addEventListener('click', () => { fbStack.push({ id: f.id, name: f.name }); fbLoad(); });
        const sel = document.createElement('button');
        sel.type = 'button'; sel.className = 'fb-pick'; sel.textContent = '✓ בחר';
        sel.title = 'שמור את "' + f.name + '" כתיקיית היעד';
        sel.addEventListener('click', async (e) => {
          e.stopPropagation();
          await saveProfile({ drive: { folderId: f.id, folderName: f.name } });
          if (els.driveTargetName) els.driveTargetName.textContent = f.name;
          fb.panel.hidden = true;
        });
        li.appendChild(nm); li.appendChild(sel);
        fb.list.appendChild(li);
      });
    });
  }
  fb.browse.addEventListener('click', () => {
    const willShow = fb.panel.hidden;
    fb.panel.hidden = !willShow;
    if (willShow) { fbStack = [{ id: 'root', name: 'My Drive' }]; fbLoad(); }
  });
  fb.close.addEventListener('click', () => { fb.panel.hidden = true; });
  fb.pick.addEventListener('click', async () => {
    const cur = fbCurrent();
    const id = cur.id === 'root' ? '' : cur.id;
    await saveProfile({ drive: { folderId: id, folderName: cur.name } });
    if (els.driveTargetName) els.driveTargetName.textContent = cur.name;
    fb.panel.hidden = true;
  });

  // Create a new sub-folder in the current location.
  fb.newBtn.addEventListener('click', () => {
    fb.newRow.hidden = !fb.newRow.hidden;
    if (!fb.newRow.hidden) { fb.newName.value = ''; fb.newName.focus(); }
  });
  function createFolder() {
    const name = (fb.newName.value || '').trim();
    if (!name) { fb.newName.focus(); return; }
    const cur = fbCurrent();
    setStatus(fb.status, 'יוצר תיקייה…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/driveEnsureFolder', parentId: cur.id === 'root' ? '' : cur.id, name }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok) { setStatus(fb.status, 'יצירה נכשלה: ' + ((r && r.error) || '').slice(0, 30), 'err'); return; }
      fb.newRow.hidden = true;
      // Enter the new folder so the user can pick it or go deeper.
      fbStack.push({ id: r.id, name: r.name || name });
      fbLoad();
    });
  }
  fb.newCreate.addEventListener('click', createFolder);
  fb.newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') createFolder(); });

  // Links
  els.openOptions.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  els.openAbout.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'https://www.z-g.co.il/court-downloader' }); });
})();

// ── Google Calendar tab (popup) ─────────────────────────────────────────────
// Mirrors the options "יומן Google" tab so the litigant-calendar sync can be
// configured straight from the toolbar popup. Persists settings.calendarSync.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    tabDocs: $('tab-documents'), tabHearings: $('tab-hearings'), tabCal: $('tab-calendar'),
    viewProfile: $('pu-view-profile'), viewCalendar: $('pu-view-calendar'), profileTag: $('profile-tag'),
    connect: $('cal-connect'), connectStatus: $('cal-connect-status'),
    select: $('cal-select'), newcal: $('cal-newcal'), pickStatus: $('cal-pick-status'),
    months: $('cal-months'),
    tplTitle: $('cal-tpl-title'), tplLocation: $('cal-tpl-location'), tplDesc: $('cal-tpl-desc'),
    save: $('cal-save'), saveStatus: $('cal-save-status'),
  };
  if (!el.tabCal) return;

  let cs = null, calendars = null;
  function st(node, text, cls) { if (node) { node.textContent = text; node.className = 'pu-status' + (cls ? ' ' + cls : ''); } }
  function opt(v, l) { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; }

  function showCalendar() {
    el.viewProfile.hidden = true; el.viewCalendar.hidden = false;
    el.tabDocs.classList.remove('pu-tab--active'); el.tabHearings.classList.remove('pu-tab--active');
    el.tabCal.classList.add('pu-tab--active');
  }
  function showProfile() {
    el.viewCalendar.hidden = true; el.viewProfile.hidden = false;
    el.tabCal.classList.remove('pu-tab--active');
  }
  el.tabCal.addEventListener('click', showCalendar);
  el.tabDocs.addEventListener('click', showProfile);
  el.tabHearings.addEventListener('click', showProfile);

  function renderSelect() {
    const sel = el.select; if (!sel) return;
    sel.innerHTML = '';
    if (Array.isArray(calendars)) {
      if (!calendars.length) sel.appendChild(opt('', 'אין יומנים זמינים'));
      calendars.forEach((c) => sel.appendChild(opt(c.id, c.summary + (c.primary ? ' (ראשי)' : ''))));
      sel.value = (cs && cs.calendarId) || (calendars[0] && calendars[0].id) || '';
    } else {
      if (cs && cs.calendarId) sel.appendChild(opt(cs.calendarId, cs.calendarName || cs.calendarId));
      sel.appendChild(opt('', 'לחץ "התחבר וטען יומנים"…'));
      sel.value = (cs && cs.calendarId) || '';
    }
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
      st(el.connectStatus, '✓ מחובר — טוען יומנים…', 'ok');
      chrome.runtime.sendMessage({ type: 'cd/calListCalendars' }, (lr) => {
        if (chrome.runtime.lastError) { st(el.connectStatus, 'שגיאת טעינה', 'err'); return; }
        if (!lr || !lr.ok) {
          const err = String((lr && lr.error) || '');
          if (/403|disabled|has not been used|PERMISSION_DENIED/i.test(err)) {
            el.connectStatus.className = 'pu-status err';
            el.connectStatus.innerHTML = 'Calendar API אינו מופעל. <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=548153685379" target="_blank" rel="noopener">הפעל כאן</a> ואז נסה שוב.';
          } else { st(el.connectStatus, 'נכשל: ' + err.slice(0, 60), 'err'); }
          return;
        }
        calendars = lr.calendars || [];
        renderSelect();
        st(el.connectStatus, '✓ נטענו ' + calendars.length + ' יומנים.', 'ok');
      });
    });
  });

  el.newcal.addEventListener('click', () => {
    const name = window.prompt('שם היומן החדש ב-Google Calendar:', 'דיונים — נט המשפט');
    if (!name) return;
    st(el.pickStatus, 'יוצר…', 'muted');
    chrome.runtime.sendMessage({ type: 'cd/calCreateCalendar', summary: name }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok) { st(el.pickStatus, 'נכשל: ' + ((r && r.error) || ''), 'err'); return; }
      if (!Array.isArray(calendars)) calendars = [];
      calendars.push({ id: r.id, summary: r.summary || name, primary: false });
      renderSelect(); el.select.value = r.id;
      st(el.pickStatus, '✓ נוצר. לחץ שמור.', 'ok');
    });
  });

  el.save.addEventListener('click', async () => {
    const selectedId = el.select.value;
    const selLabel = el.select.options[el.select.selectedIndex] ? el.select.options[el.select.selectedIndex].textContent : '';
    let months = parseInt(el.months.value, 10); if (!(months >= 1 && months <= 36)) months = 12;
    const merged = await window.CD.saveSettings({ calendarSync: {
      calendarId: selectedId || (cs && cs.calendarId) || '',
      calendarName: selectedId ? selLabel : (cs && cs.calendarName) || '',
      monthsAhead: months,
      titleTemplate: el.tplTitle.value,
      locationTemplate: el.tplLocation.value,
      descriptionTemplate: el.tplDesc.value,
    } });
    cs = merged.calendarSync;
    st(el.saveStatus, '✓ נשמר', 'ok');
    setTimeout(() => st(el.saveStatus, ''), 2000);
  });
})();
