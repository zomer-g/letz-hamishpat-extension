// Service worker (Firefox port) — handles network egress that content scripts
// can't do:
//   • POST documents (multipart) to the user's configured server endpoint
//     (host-permission-privileged fetch, granted at runtime via options page).
//   • Upload documents to Google Drive via OAuth (launchWebAuthFlow).
//   • Connectivity test + Drive connect for the options page.
//
// Content script (list-panel.js) sends each built PDF here as an ArrayBuffer.
//
// Firefox OAuth — does NOT support chrome.identity.getAuthToken. We use
// browser.identity.launchWebAuthFlow with a Google OAuth 2.0 "Web application"
// client whose authorized redirect URI is browser.identity.getRedirectURL().
// See SETUP_FIREFOX.md for the Google Cloud Console steps. Paste the client ID
// below — it is NOT a secret (OAuth public client) and is fine to commit if
// this build is meant for end users; otherwise users put their own.

const FIREFOX_OAUTH_CLIENT_ID = 'REPLACE_WITH_WEB_APP_CLIENT_ID.apps.googleusercontent.com';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];
// Full calendar scope: lets us list the user's calendars, create a new one,
// and import/upsert events. Requested only when the calendar-sync feature is
// used, so Drive-only users never grant it.
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'];

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

// ── Google auth (Firefox: launchWebAuthFlow) ──────────────────────────────
// chrome.identity.getAuthToken does not exist on Firefox. We implement the
// implicit-flow equivalent: open Google's consent page via launchWebAuthFlow,
// parse the access_token + expires_in from the returned redirect fragment,
// and cache in memory keyed by scope set. The cache survives across calls
// inside the same service-worker lifetime; the storage.session mirror lets
// us survive a worker idle restart within the browser session.

const TOKEN_CACHE = new Map(); // key: sorted scopes string → { token, expiresAt }

function _scopeKey(scopes) { return (scopes || DRIVE_SCOPES).slice().sort().join(' '); }

function _now() { return Date.now(); }

async function _restoreCacheFromSession() {
  try {
    const r = await new Promise((res) => chrome.storage.session.get('fxOauthCache', (v) => res(v || {})));
    const stored = r && r.fxOauthCache;
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(stored)) {
        const v = stored[k];
        if (v && v.token && v.expiresAt > _now() + 30_000) TOKEN_CACHE.set(k, v);
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
  // Implicit flow returns the token in the URL fragment (#access_token=…)
  // launchWebAuthFlow may return the URL with the fragment intact.
  let frag = '';
  const hashIdx = redirectUrl.indexOf('#');
  if (hashIdx >= 0) frag = redirectUrl.slice(hashIdx + 1);
  else {
    // Some redirects come back with the fragment encoded as a query string.
    const qIdx = redirectUrl.indexOf('?');
    if (qIdx >= 0) frag = redirectUrl.slice(qIdx + 1);
  }
  const params = new URLSearchParams(frag);
  const token = params.get('access_token');
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
  const error = params.get('error');
  if (error) throw new Error('OAuth error: ' + error);
  if (!token) throw new Error('no access_token in redirect');
  return { token, expiresAt: _now() + (expiresIn - 60) * 1000 }; // 1-min safety margin
}

async function getAuthToken(interactive, scopes) {
  const scopeList = (scopes && scopes.length) ? scopes : DRIVE_SCOPES;
  const key = _scopeKey(scopeList);
  await _ensureRestored();

  const cached = TOKEN_CACHE.get(key);
  if (cached && cached.expiresAt > _now()) return cached.token;

  if (!interactive) throw new Error('no cached token (non-interactive)');

  if (!FIREFOX_OAUTH_CLIENT_ID || FIREFOX_OAUTH_CLIENT_ID.startsWith('REPLACE_WITH_')) {
    throw new Error('OAuth client_id not configured — see SETUP_FIREFOX.md');
  }

  const identity = (typeof browser !== 'undefined' && browser.identity) ? browser.identity : chrome.identity;
  if (!identity || !identity.launchWebAuthFlow) {
    throw new Error('browser.identity.launchWebAuthFlow unavailable');
  }

  const redirectUri = identity.getRedirectURL();
  const authUrl = _buildAuthUrl(scopeList, redirectUri);

  let redirectUrl;
  try {
    redirectUrl = await identity.launchWebAuthFlow({ interactive: true, url: authUrl });
  } catch (e) {
    throw new Error('launchWebAuthFlow failed: ' + ((e && e.message) || e));
  }
  if (!redirectUrl) throw new Error('OAuth cancelled');

  const parsed = _parseTokenFromRedirect(redirectUrl);
  TOKEN_CACHE.set(key, parsed);
  _persistCacheToSession();
  return parsed.token;
}

async function removeCachedToken(token) {
  // Drop any cache entry holding this specific token. We do NOT call
  // Google's revoke endpoint — match the Chrome semantics (cache wipe only).
  let mutated = false;
  for (const [k, v] of TOKEN_CACHE.entries()) {
    if (v && v.token === token) { TOKEN_CACHE.delete(k); mutated = true; }
  }
  if (mutated) await _persistCacheToSession();
}

async function clearCachedTokens() {
  TOKEN_CACHE.clear();
  await _persistCacheToSession();
}

async function driveConnect() {
  // Clear cached tokens first so a newly-added scope (drive.metadata.readonly)
  // is actually requested rather than served from a stale grant.
  await clearCachedTokens();
  const token = await getAuthToken(true);
  // Fetch the account email for display (best-effort).
  let email = '';
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) { const j = await r.json(); email = j.email || ''; }
  } catch (e) {}
  return { ok: true, email };
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
// for the built-in folder picker. Needs drive.metadata.readonly.
async function driveListFolders({ parentId }) {
  const token = await getAuthToken(false);
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
        default: return sendResponse({ ok: false, error: 'unknown type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true; // async
});
