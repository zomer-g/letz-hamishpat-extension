# Reviewer Notes — Net HaMishpat Bulk Document Downloader

_Extension version 0.9.7._

**One-line purpose**
A user who is signed into Net HaMishpat (`https://securesso.court.gov.il/Ngcs.Web.Secured/`) selects case materials and bulk-exports them: **documents** as one ZIP with a CSV index, and **hearing schedules** as CSV + ICS — locally by default, or to a destination the user configures (a personal API server, Google Drive, or Google Calendar).

---

## Data flow diagram

```
                 [user's authenticated tab]
                      |  (existing browser session — extension never reads cookies)
                      v
   ┌────────────────────────────────────────────────────────────────┐
   │  Net HaMishpat page (securesso.court.gov.il/Ngcs.Web.Secured/…) │
   └────────────────────────────────────────────────────────────────┘
                      |
   (1) content scripts read the doc/hearing AG-Grid → inject checkboxes + panel
       list-panel.js (documents) · hearings-panel.js (hearings)
                      |
   (2) user clicks the panel's primary button
                      |
       ├─ documents: list-panel.js POSTs the page's own __doPostBack form and
       │   the viewer's GetAllImages endpoint — SAME ORIGIN (securesso) — then
       │   builds a PDF (jsPDF) and a ZIP (JSZip) IN THE PAGE, and saves via
       │   chrome.downloads.
       ├─ hearings: hearings-panel.js reads the grid (and drives the page's own
       │   date-range postback), builds CSV + ICS locally, saves via downloads.
       |
   (3) OPTIONAL destinations (only if the user turned them on) go through
       background/service-worker.js:
       ├─ user API server  → POST multipart to the endpoint the user typed
       ├─ Google Drive     → www.googleapis.com (OAuth, drive.file)
       └─ Google Calendar  → www.googleapis.com (OAuth, calendar)
                      |
                      v
        [user's local disk]  and/or  [the destination the user chose]

   ✗ No connection to any developer server, analytics, telemetry, or any
     third-party endpoint. The only hosts ever contacted are securesso.court.gov.il,
     www.googleapis.com (opt-in), and a user-typed endpoint (opt-in).
```

---

## Key source files

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 declaration. `downloads`, `activeTab`, `storage`, `identity`; host `securesso.court.gov.il` + `www.googleapis.com`; optional hosts `https://*/*`,`http://*/*`; OAuth scopes `drive.file`, `drive.metadata.readonly`, `calendar`. Content scripts match only `securesso.court.gov.il/Ngcs.Web.Secured/*`. |
| `background/service-worker.js` | Handles ONLY the optional destinations: user API server (multipart POST), Google Drive (upload/list/create), Google Calendar (list/create/import). No court-site fetches happen here. |
| `content/list-panel.js` | Documents panel: selection UI, same-origin postback + GetAllImages fetch, jsPDF→ZIP assembly, progress/cancel/resume, routing to destinations. |
| `content/hearings-panel.js` | Hearings panel: selection UI, CSV+ICS build, calendar-sync trigger, routing to destinations. |
| `content/adapters/net-court.js` | Document folder DOM + per-folder `__doPostBack` argument derivation. |
| `content/adapters/net-court-hearings.js` | Hearing-grid DOM + mode detection (case / "my hearings" / judge report). |
| `shared/{constants,settings,csv,ics-builder,datepicker}.js` | Message IDs, settings store, CSV (UTF-8 BOM), ICS builder (Asia/Jerusalem), date picker. |
| `vendor/{jszip,jspdf}.min.js` | JSZip 3.10.x + jsPDF, **bundled** — never loaded from a CDN at runtime. |
| `popup/` + `options/` + `about/` | Control center, settings, about page. |

---

## Where data leaves the browser — exhaustive list

Every outbound network call in the extension:

| File | URL | When | Purpose |
|---|---|---|---|
| `content/list-panel.js` (postDocument) | `form.action` → `https://securesso.court.gov.il/Ngcs.Web.Secured/…aspx` | Always (core docs flow) | Trigger the page's own document-open postback. **Same origin as the source page.** |
| `content/list-panel.js` (fetchAllImages) | `https://securesso.court.gov.il/Ngcs.Web.Secured/Viewer/NGCSViewerPage.aspx/GetAllImages` | Always (core docs flow) | Get the selected document's page images to build the PDF. **Same origin.** |
| `content/hearings-panel.js` | page's own form (securesso, same origin) | Hearings flow | Drive the date-range postback before reading the grid. |
| `background/service-worker.js` (uploadServer / testServer) | the endpoint the user typed | Only if user enables the "server" destination | POST each file as `multipart/form-data` with `X-API-Key`. |
| `background/service-worker.js` (Drive: connect/list/ensureFolder/listDocIds/upload) | `https://www.googleapis.com/drive/v3/…`, `…/upload/drive/v3/…`, `…/oauth2/v3/userinfo` | Only if user enables Google Drive | Verify account, browse folders, dedupe, upload files. Scope `drive.file` + `drive.metadata.readonly`. |
| `background/service-worker.js` (Calendar: list/create/import/patch) | `https://www.googleapis.com/calendar/v3/…` | Only if user enables Calendar sync | List/create the chosen calendar; list existing events within the synced date range; import new hearings and patch ones that moved. Scope `calendar`. |

The popup / About pages link to `https://www.z-g.co.il/court-downloader` (+ `/privacy`, `/terms`) as plain anchor hrefs — the extension never fetches those URLs.

---

## No remote code execution
- No `eval(`, no `new Function(`
- No `<script src="http…`, no `chrome.scripting.executeScript({ code })`
- No CDN fetches at runtime; no WASM streaming from URLs

Reviewer-verifiable on the submission ZIP:
```
grep -RIn -e 'eval(' -e 'new Function(' -e 'src="http' -e 'executeScript' . --exclude-dir=vendor
```
(Matches inside `vendor/` are the bundled jsPDF/JSZip libraries.)

---

## Test instructions

The core feature needs an authenticated Net HaMishpat session (smart-card / government SSO) a reviewer is unlikely to have. Without auth, a reviewer can still verify:

1. Install via Load Unpacked.
2. The content scripts match only `https://securesso.court.gov.il/Ngcs.Web.Secured/*`. On any other site, nothing is injected.
3. Even on a matching path, the panel mounts only when a document/hearing grid is present (the adapters' `matches()`/`detectMode()` return false on landing pages).
4. Open the popup/options: destination toggles persist to `chrome.storage.local`. With every destination off (default), the extension issues ZERO non-court requests.
5. Google sign-in (Drive/Calendar) is triggered only by an explicit user click; with no sign-in, no `googleapis.com` call is made.

A screencast of the full authenticated flow can be supplied on request.

---

## Permissions restated

| Permission / scope | Used by | Why |
|---|---|---|
| `downloads` | `service-worker.js`, content scripts | Save the assembled ZIP / CSV / ICS. |
| `activeTab` | `content/list-panel.js`, `content/hearings-panel.js`, adapters | Read the list on the active page. |
| `storage` | `shared/settings.js` (all surfaces) | Persist configuration preferences only. |
| `identity` | `service-worker.js` (getAuthToken) | Google OAuth, only for the optional Drive/Calendar destinations. |
| host `securesso.court.gov.il` | content scripts | Fetch the user-selected items from the source host. |
| host `www.googleapis.com` | `service-worker.js` | Drive/Calendar, when enabled. |
| optional `https://*/*`,`http://*/*` | `service-worker.js` | Only if the user configures a personal API endpoint. |
| scopes `drive.file`, `drive.metadata.readonly`, `calendar` | `service-worker.js` | Files it created; folder names for the picker; the user's hearing events (read back within the synced date range so reschedules update in place). |

---

## Visibility
**Unlisted** — direct-link distribution only.
