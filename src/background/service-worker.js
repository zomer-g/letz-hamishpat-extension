// Cross-browser shim (Firefox: chrome→browser). No-op on Chrome. Inlined
// rather than imported so it runs before anything else in this context.
if (typeof browser !== 'undefined' && browser !== globalThis.chrome) {
  try { globalThis.chrome = browser; } catch (e) {}
}

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
// Two browsers, two mechanisms, one interface. Chrome has identity.getAuthToken
// (the browser owns the token cache and the account picker). Firefox has no
// such API — only launchWebAuthFlow — so there we run Google's implicit flow
// ourselves and keep the token cache in memory, mirrored to storage.session so
// an idle event-page restart doesn't force a fresh consent screen.
//
// We capability-detect rather than sniff the user agent: whichever browser this
// is, if getAuthToken exists we use it. Everything below calls
// getAuthToken(interactive, scopes) and never needs to know the difference.
const HAS_GET_AUTH_TOKEN =
  typeof chrome !== 'undefined' && !!chrome.identity &&
  typeof chrome.identity.getAuthToken === 'function';

// Firefox needs a Google OAuth client of type "Web application" — the Chrome
// one is bound to the extension id and Google rejects it here — whose
// authorized redirect URI is identity.getRedirectURL(). This is a public
// identifier, not a secret. Setup: docs/firefox-amo/SETUP_FIREFOX.md.
const FIREFOX_OAUTH_CLIENT_ID = 'REPLACE_WITH_WEB_APP_CLIENT_ID.apps.googleusercontent.com';

const TOKEN_CACHE = new Map(); // scopeKey → { token, expiresAt }   (Firefox path only)
function _scopeKey(scopes) { return (scopes || DRIVE_SCOPES).slice().sort().join(' '); }

async function _restoreCacheFromSession() {
  try {
    const r = await new Promise((res) => chrome.storage.session.get('fxOauthCache', (v) => res(v || {})));
    const stored = r && r.fxOauthCache;
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(stored)) {
        const v = stored[k];
        if (v && v.token && v.expiresAt > Date.now() + 30000) TOKEN_CACHE.set(k, v);
      }
    }
  } catch (e) {}
}
let _restorePromise = null;
function _ensureRestored() { if (!_restorePromise) _restorePromise = _restoreCacheFromSession(); return _restorePromise; }

async function _persistCacheToSession() {
  try {
    const obj = {};
    for (const [k, v] of TOKEN_CACHE.entries()) obj[k] = v;
    await new Promise((res) => chrome.storage.session.set({ fxOauthCache: obj }, () => res()));
  } catch (e) {}
}

function _buildAuthUrl(scopes, redirectUri) {
  const params = new URLSearchParams({
    client_id: FIREFOX_OAUTH_CLIENT_ID,
    response_type: 'token',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    include_granted_scopes: 'true',
    prompt: 'consent',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

function _parseTokenFromRedirect(redirectUrl) {
  // The implicit flow returns the token in the URL fragment (#access_token=…);
  // some redirects hand it back as a query string instead, so accept both.
  let frag = '';
  const hashIdx = redirectUrl.indexOf('#');
  if (hashIdx >= 0) frag = redirectUrl.slice(hashIdx + 1);
  else {
    const qIdx = redirectUrl.indexOf('?');
    if (qIdx >= 0) frag = redirectUrl.slice(qIdx + 1);
  }
  const params = new URLSearchParams(frag);
  const error = params.get('error');
  if (error) throw new Error('OAuth error: ' + error);
  const token = params.get('access_token');
  if (!token) throw new Error('no access_token in redirect');
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
  return { token: token, expiresAt: Date.now() + (expiresIn - 60) * 1000 }; // 1-min safety margin
}

async function _getAuthTokenViaWebFlow(interactive, scopes) {
  const scopeList = (scopes && scopes.length) ? scopes : DRIVE_SCOPES;
  const key = _scopeKey(scopeList);
  await _ensureRestored();

  const cached = TOKEN_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (!interactive) throw new Error('no cached token (non-interactive)');

  if (!FIREFOX_OAUTH_CLIENT_ID || FIREFOX_OAUTH_CLIENT_ID.startsWith('REPLACE_WITH_')) {
    throw new Error('OAuth client_id not configured — see docs/firefox-amo/SETUP_FIREFOX.md');
  }
  const identity = chrome.identity;
  if (!identity || !identity.launchWebAuthFlow) throw new Error('identity.launchWebAuthFlow unavailable');

  const redirectUri = identity.getRedirectURL();
  let redirectUrl;
  try {
    redirectUrl = await identity.launchWebAuthFlow({ interactive: true, url: _buildAuthUrl(scopeList, redirectUri) });
  } catch (e) {
    throw new Error('launchWebAuthFlow failed: ' + ((e && e.message) || e));
  }
  if (!redirectUrl) throw new Error('OAuth cancelled');

  const parsed = _parseTokenFromRedirect(redirectUrl);
  TOKEN_CACHE.set(key, parsed);
  _persistCacheToSession();
  return parsed.token;
}

function getAuthToken(interactive, scopes) {
  if (!HAS_GET_AUTH_TOKEN) return _getAuthTokenViaWebFlow(interactive, scopes);
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

async function removeCachedToken(token) {
  if (!HAS_GET_AUTH_TOKEN) {
    // Drop any cache entry holding this token. We deliberately do NOT call
    // Google's revoke endpoint — that matches Chrome's cache-wipe semantics.
    let mutated = false;
    for (const [k, v] of TOKEN_CACHE.entries()) {
      if (v && v.token === token) { TOKEN_CACHE.delete(k); mutated = true; }
    }
    if (mutated) await _persistCacheToSession();
    return;
  }
  return new Promise((resolve) => {
    try { chrome.identity.removeCachedAuthToken({ token: token }, () => resolve()); }
    catch (e) { resolve(); }
  });
}

async function clearCachedTokens() {
  if (!HAS_GET_AUTH_TOKEN) {
    TOKEN_CACHE.clear();
    await _persistCacheToSession();
    return;
  }
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

// ── Calendar event primitives ────────────────────────────────────────────
// The reconciling sync lives in shared/cal-sync.js (content-script side, where
// it is testable in jsdom); this side just does the three privileged calls.
//
// There is deliberately no bulk "sync" call any more. The old one POSTed every
// hearing to events.import and trusted iCalUID to upsert — but that UID hashes
// the hearing's date and time, so a postponed hearing produced a NEW UID and
// import created a SECOND event, leaving the original behind. That is the
// duplication this replaces.
const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/';

// Our events for one case, within a date window. Google ANDs repeated
// privateExtendedProperty filters, but legacy events predate the tag, so the
// case filter is applied by the caller and this only narrows by source+window.
async function calListEvents({ calendarId, timeMin, timeMax }) {
  if (!calendarId) throw new Error('no calendarId');
  const qs = new URLSearchParams({
    singleEvents: 'true',
    showDeleted: 'false',
    maxResults: '250',
    fields: 'items(id,iCalUID,summary,start,end,extendedProperties)',
  });
  if (timeMin) qs.set('timeMin', timeMin);
  if (timeMax) qs.set('timeMax', timeMax);
  const res = await calFetch(CAL_BASE + encodeURIComponent(calendarId) + '/events?' + qs.toString(), {});
  if (!res.ok) throw new Error('Calendar list HTTP ' + res.status + ': ' + (await res.text()).slice(0, 140));
  const j = await res.json();
  return { events: j.items || [] };
}

// PATCH, not PUT: leaves fields we don't manage (reminders, colour, the user's
// own edits) untouched, and keeps the event id — which is what makes a
// postponement MOVE the existing entry instead of creating another one.
async function calPatchEvent({ calendarId, eventId, patch }) {
  if (!calendarId || !eventId) throw new Error('no calendarId/eventId');
  const res = await calFetch(CAL_BASE + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });
  if (!res.ok) throw new Error('Calendar patch HTTP ' + res.status + ': ' + (await res.text()).slice(0, 140));
  return { id: eventId };
}

async function calImportEvent({ calendarId, event }) {
  if (!calendarId) throw new Error('no calendarId');
  const res = await calFetch(CAL_BASE + encodeURIComponent(calendarId) + '/events/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error('Calendar import HTTP ' + res.status + ': ' + (await res.text()).slice(0, 140));
  const j = await res.json();
  return { id: j.id };
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
        case 'cd/calListEvents': { const r = await calListEvents(msg); return sendResponse({ ok: true, events: r.events }); }
        case 'cd/calPatchEvent': { const r = await calPatchEvent(msg); return sendResponse({ ok: true, id: r.id }); }
        case 'cd/calImportEvent': { const r = await calImportEvent(msg); return sendResponse({ ok: true, id: r.id }); }
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
