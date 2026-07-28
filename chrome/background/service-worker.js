// Service worker — handles network egress that content scripts can't do:
//   • POST documents (multipart) to the user's configured server endpoint
//     (host-permission-privileged fetch, granted at runtime via options page).
//   • Upload documents to Google Drive via chrome.identity OAuth.
//   • Connectivity test + Drive connect for the options page.
//
// Content script (list-panel.js) sends each built PDF here as an ArrayBuffer.

// Default ("basic") Drive scope — non-sensitive: only files the app itself
// creates. No "unverified app" warning, no 100-user cap. Uploads + the
// auto-created default folder ("מסמכי נט המשפט") all work with this alone.
const DRIVE_BASIC_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
];
// "Full" Drive scope set — adds drive.metadata.readonly so the folder picker
// can list folders the user already owns. Restricted scope: triggers the
// "Google hasn't verified this app" screen until verification + CASA complete.
// Requested only when the user opts into "בחירת תיקייה מותאמת" in options.
const DRIVE_FULL_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];
// Backwards-compatible alias: anything that used to pass DRIVE_SCOPES now
// defaults to the basic set.
const DRIVE_SCOPES = DRIVE_BASIC_SCOPES;
// Full calendar scope: lets us list the user's calendars, create a new one,
// and import/upsert events. Requested only when the calendar-sync feature is
// used, so Drive-only users never grant it.
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'];

const DEFAULT_DRIVE_FOLDER_NAME = 'מסמכי נט המשפט';

function abToUint8(ab) { return ab instanceof Uint8Array ? ab : new Uint8Array(ab); }
// Binary is sent from the content script as base64 (chrome.runtime.sendMessage
// drops raw ArrayBuffers → empty files). Decode it back to bytes here.
function b64ToU8(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
function bytesFromMsg(m) { return (m && m.bytesB64 != null) ? b64ToU8(m.bytesB64) : abToUint8(m && m.bytes); }

// ── Server upload (multipart/form-data) ───────────────────────────────────
async function uploadToServer(msg) {
  const { endpoint, apiKey, filename, meta, mimeType } = msg;
  const form = new FormData();
  const blob = new Blob([bytesFromMsg(msg)], { type: mimeType || 'application/pdf' });
  form.append('file', blob, filename);
  form.append('filename', filename);
  if (meta) {
    for (const k of Object.keys(meta)) form.append(k, meta[k] == null ? '' : String(meta[k]));
  }
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(endpoint, { method: 'POST', headers, body: form });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { status: res.status };
}

async function testServer({ endpoint, apiKey }) {
  // Lightweight reachability check — POST an empty probe; any HTTP response
  // (even 4xx) proves the endpoint is reachable and CORS/permission is OK.
  const headers = { 'X-CD-Probe': '1' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body: new FormData() });
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ── Google auth ────────────────────────────────────────────────────────────
function getAuthToken(interactive, scopes) {
  return new Promise((resolve, reject) => {
    try {
      chrome.identity.getAuthToken({ interactive: !!interactive, scopes: scopes || DRIVE_SCOPES }, (token) => {
        if (chrome.runtime.lastError || !token) {
          return reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no token (check oauth2 client_id — see SETUP.md)'));
        }
        resolve(token);
      });
    } catch (e) { reject(e); }
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    try { chrome.identity.removeCachedAuthToken({ token: token }, () => resolve()); }
    catch (e) { resolve(); }
  });
}

function clearCachedTokens() {
  return new Promise((resolve) => {
    try { chrome.identity.clearAllCachedAuthTokens(() => resolve()); }
    catch (e) { resolve(); }
  });
}

async function driveConnect() {
  // BASIC connect: only drive.file (non-sensitive). Triggers a clean OAuth
  // consent without the "Google hasn't verified" warning. After authorizing,
  // we auto-create the default folder so the user can start uploading right
  // away without having to pick anything.
  const token = await getAuthToken(true, DRIVE_BASIC_SCOPES);
  let email = '';
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) { const j = await r.json(); email = j.email || ''; }
  } catch (e) {}
  // Best-effort: ensure the default folder + write its id/name into both
  // profiles' drive config (only when each profile has no folder yet).
  let defaultFolder = null;
  try { defaultFolder = await ensureDefaultDriveFolder(token); }
  catch (e) { /* folder creation failed — surface in `error`, still report ok auth */ }
  return { ok: true, email, defaultFolder };
}

// FULL connect: re-prompt for the additional drive.metadata.readonly scope so
// the folder picker can list folders the user already owns. Clears cached
// tokens first so Chrome actually re-requests consent instead of returning a
// stale basic-only token.
async function driveConnectFull() {
  await clearCachedTokens();
  const token = await getAuthToken(true, DRIVE_FULL_SCOPES);
  let email = '';
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) { const j = await r.json(); email = j.email || ''; }
  } catch (e) {}
  return { ok: true, email };
}

// Find or create the default upload folder ("מסמכי נט המשפט") in My Drive
// root. Uses drive.file scope — search returns only files the app itself has
// created, so subsequent calls find the same folder. Updates settings so both
// the documents and hearings profiles point at the default (only when each
// profile has no folder configured yet — never overwrites an explicit pick).
async function ensureDefaultDriveFolder(token) {
  const tok = token || await getAuthToken(false, DRIVE_BASIC_SCOPES);
  const name = DEFAULT_DRIVE_FOLDER_NAME;
  const esc = name.replace(/'/g, "\\'");
  const q = "mimeType='application/vnd.google-apps.folder' and trashed=false and name='" + esc + "'";
  const searchUrl = 'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name)&q=' + encodeURIComponent(q);
  let folderId = '';
  try {
    const sr = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + tok } });
    if (sr.ok) {
      const j = await sr.json();
      if (j.files && j.files.length) folderId = j.files[0].id;
    }
  } catch (e) { /* fall through to create */ }
  if (!folderId) {
    const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!cr.ok) throw new Error('Default folder HTTP ' + cr.status);
    const cj = await cr.json();
    folderId = cj.id;
  }
  // Patch into settings.local without overwriting any existing explicit pick.
  await new Promise((resolve) => {
    chrome.storage.local.get('cd_settings', (data) => {
      const cur = (data && data.cd_settings) || {};
      const docDrive = (cur.drive && cur.drive.folderId) ? cur.drive : { folderId: folderId, folderName: name };
      const hrDrive = (cur.hearings && cur.hearings.drive && cur.hearings.drive.folderId)
        ? cur.hearings.drive : { folderId: folderId, folderName: name };
      const next = Object.assign({}, cur, {
        drive: docDrive,
        hearings: Object.assign({}, cur.hearings || {}, { drive: hrDrive }),
      });
      chrome.storage.local.set({ cd_settings: next }, () => resolve());
    });
  });
  return { id: folderId, name: name };
}

async function disconnectGoogle() {
  // Best-effort: revoke the grant at Google (so the next connect re-prompts for
  // consent + the account picker), then drop Chrome's cached tokens for every
  // scope set the extension uses (Drive basic, Drive full, Calendar). Each
  // getAuthToken call may return a different token depending on what's cached.
  for (const scopes of [DRIVE_BASIC_SCOPES, DRIVE_FULL_SCOPES, CALENDAR_SCOPES]) {
    try {
      const token = await getAuthToken(false, scopes);
      if (token) {
        try {
          await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
        } catch (e) { /* revoke is best-effort */ }
        await removeCachedToken(token);
      }
    } catch (e) { /* not connected for this scope — fine */ }
  }
  await clearCachedTokens();
  return { ok: true };
}

// Find or create a sub-folder by name under an optional parent. Returns its id.
async function ensureDriveFolder({ parentId, name }) {
  const token = await getAuthToken(false);
  const safe = (String(name || '').replace(/[\\]/g, ' ').trim()) || 'נט-המשפט';
  const esc = safe.replace(/'/g, "\\'");
  let q = "mimeType='application/vnd.google-apps.folder' and trashed=false and name='" + esc + "'";
  if (parentId) q += " and '" + parentId + "' in parents";
  const searchUrl = 'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name)&q=' + encodeURIComponent(q);
  const sr = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + token } });
  if (sr.ok) {
    const j = await sr.json();
    if (j.files && j.files.length) return { id: j.files[0].id, name: safe };
  }
  const metadata = { name: safe, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  if (!cr.ok) throw new Error('Drive folder HTTP ' + cr.status + ': ' + (await cr.text()).slice(0, 120));
  const cj = await cr.json();
  return { id: cj.id, name: safe };
}

// List sub-folders under a parent (or "My Drive" root when parentId is empty),
// for the built-in folder picker. Needs drive.metadata.readonly — only the
// "advanced" Drive connect grants it. Non-interactive: if the user is on the
// basic grant only, this returns "no token" and the UI prompts to upgrade.
async function driveListFolders({ parentId }) {
  const token = await getAuthToken(false, DRIVE_FULL_SCOPES);
  const parent = parentId || 'root';
  const q = "mimeType='application/vnd.google-apps.folder' and trashed=false and '" + parent + "' in parents";
  const folders = [];
  let pageToken = '';
  do {
    let url = 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=name&pageSize=200' +
      '&fields=nextPageToken,files(id,name)&q=' + encodeURIComponent(q);
    if (pageToken) url += '&pageToken=' + pageToken;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Drive list HTTP ' + r.status);
    const j = await r.json();
    (j.files || []).forEach((f) => folders.push({ id: f.id, name: f.name }));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return { folders };
}

// List the stable document ids already present in a Drive folder (stored in
// each file's appProperties.cdDocId). Used for dedupe.
async function driveListDocIds({ folderId }) {
  if (!folderId) return { ids: [] };
  const token = await getAuthToken(false);
  const ids = [];
  let pageToken = '';
  do {
    let url = 'https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000' +
      '&fields=nextPageToken,files(appProperties)&q=' +
      encodeURIComponent("'" + folderId + "' in parents and trashed=false");
    if (pageToken) url += '&pageToken=' + pageToken;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) break;
    const j = await r.json();
    (j.files || []).forEach((f) => { const id = f.appProperties && f.appProperties.cdDocId; if (id) ids.push(String(id)); });
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return { ids };
}

async function uploadToDrive(msg) {
  const { folderId, filename, mimeType, docId } = msg;
  const token = await getAuthToken(false);
  const mt = mimeType || 'application/pdf';
  const metadata = { name: filename, mimeType: mt };
  if (folderId) metadata.parents = [folderId];
  if (docId != null && docId !== '') metadata.appProperties = { cdDocId: String(docId) };
  const boundary = 'cdb' + Math.random().toString(16).slice(2);
  const enc = new TextEncoder();
  const pre = enc.encode(
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + mt + '\r\n\r\n'
  );
  const post = enc.encode('\r\n--' + boundary + '--');
  const body = new Blob([pre, bytesFromMsg(msg), post], { type: 'multipart/related; boundary=' + boundary });
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body,
  });
  if (!res.ok) throw new Error('Drive HTTP ' + res.status + ': ' + (await res.text()).slice(0, 120));
  const j = await res.json();
  return { id: j.id };
}

// ── Google Calendar ─────────────────────────────────────────────────────────
// All calendar calls go through calFetch, which acquires a calendar-scoped
// token and, on 401/403 (stale token / scope not yet granted), drops the
// cached token and retries interactively once.
async function calFetch(url, opts) {
  opts = opts || {};
  let token;
  try { token = await getAuthToken(false, CALENDAR_SCOPES); }
  catch (e) { token = await getAuthToken(true, CALENDAR_SCOPES); }
  const withAuth = (t) => Object.assign({}, opts, {
    headers: Object.assign({}, opts.headers, { Authorization: 'Bearer ' + t }),
  });
  let res = await fetch(url, withAuth(token));
  if (res.status === 401 || res.status === 403) {
    await removeCachedToken(token);
    token = await getAuthToken(true, CALENDAR_SCOPES);
    res = await fetch(url, withAuth(token));
  }
  return res;
}

async function calConnect() {
  const token = await getAuthToken(true, CALENDAR_SCOPES);
  let email = '';
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) { const j = await r.json(); email = j.email || ''; }
  } catch (e) {}
  return { ok: true, email };
}

// List the user's writable calendars (the "layers" they can sync into).
async function calListCalendars() {
  const url = 'https://www.googleapis.com/calendar/v3/users/me/calendarList' +
    '?minAccessRole=writer&fields=items(id,summary,primary,accessRole)';
  const res = await calFetch(url, {});
  if (!res.ok) throw new Error('Calendar list HTTP ' + res.status + ': ' + (await res.text()).slice(0, 140));
  const j = await res.json();
  const calendars = (j.items || []).map((c) => ({
    id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole,
  }));
  return { calendars };
}

async function calCreateCalendar({ summary }) {
  const res = await calFetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: summary || 'דיונים — נט המשפט' }),
  });
  if (!res.ok) throw new Error('Calendar create HTTP ' + res.status + ': ' + (await res.text()).slice(0, 140));
  const j = await res.json();
  return { id: j.id, summary: j.summary };
}

// Upsert events into a calendar. We use events.import, which is idempotent on
// iCalUID within a calendar — re-syncing the same hearing updates the existing
// event instead of duplicating it (the stable UID is produced by ics-builder).
async function calSyncEvents({ calendarId, events }) {
  if (!calendarId) throw new Error('no calendarId');
  if (!Array.isArray(events) || !events.length) return { ok: 0, fail: 0, errors: [] };
  const base = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(calendarId) + '/events/import';
  let ok = 0, fail = 0;
  const errors = [];
  for (const ev of events) {
    try {
      const res = await calFetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
      });
      if (res.ok) ok++;
      else { fail++; if (errors.length < 3) errors.push('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 100)); }
    } catch (e) {
      fail++; if (errors.length < 3) errors.push((e && e.message) || String(e));
    }
  }
  return { ok, fail, errors };
}

// ── Message router ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  (async () => {
    try {
      switch (msg.type) {
        case 'cd/testServer': return sendResponse(await testServer(msg));
        case 'cd/driveConnect': return sendResponse(await driveConnect());
        case 'cd/driveConnectFull': return sendResponse(await driveConnectFull());
        case 'cd/disconnectGoogle': return sendResponse(await disconnectGoogle());
        case 'cd/uploadServer': await uploadToServer(msg); return sendResponse({ ok: true });
        case 'cd/driveEnsureFolder': { const r = await ensureDriveFolder(msg); return sendResponse({ ok: true, id: r.id, name: r.name }); }
        case 'cd/driveListDocIds': { const r = await driveListDocIds(msg); return sendResponse({ ok: true, ids: r.ids }); }
        case 'cd/driveListFolders': { const r = await driveListFolders(msg); return sendResponse({ ok: true, folders: r.folders }); }
        case 'cd/uploadDrive': { const r = await uploadToDrive(msg); return sendResponse({ ok: true, id: r.id }); }
        case 'cd/calConnect': return sendResponse(await calConnect());
        case 'cd/calListCalendars': { const r = await calListCalendars(); return sendResponse({ ok: true, calendars: r.calendars }); }
        case 'cd/calCreateCalendar': { const r = await calCreateCalendar(msg); return sendResponse({ ok: true, id: r.id, summary: r.summary }); }
        case 'cd/calSyncEvents': { const r = await calSyncEvents(msg); return sendResponse({ ok: true, synced: r.ok, failed: r.fail, errors: r.errors }); }
        case 'cd/openOptions': chrome.runtime.openOptionsPage(); return sendResponse({ ok: true });
        case 'cd/openTab': {
          // Only ever open Net HaMishpat URLs (the judge-runner landing page).
          if (!/^https:\/\/[\w.-]*\.?court\.gov\.il\//i.test(msg.url || '')) return sendResponse({ ok: false, error: 'bad url' });
          const tab = await chrome.tabs.create({ url: msg.url, active: true });
          return sendResponse({ ok: true, tabId: tab && tab.id });
        }
        default: return sendResponse({ ok: false, error: 'unknown type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true; // async
});
