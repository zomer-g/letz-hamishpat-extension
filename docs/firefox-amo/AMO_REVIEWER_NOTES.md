> **⚠️ Superseded — background reading only.**
> The notes actually submitted to AMO are GENERATED per version by
> `npm run build:firefox` into `src/dist/AMO-reviewer-notes-<version>.txt`,
> from `docs/firefox-amo/REVIEWER_NOTES_TEMPLATE.md`. Edit the TEMPLATE, not
> this file — this one is a longer architectural write-up kept for context and
> its version header is not maintained.

# AMO Reviewer Notes — Net HaMishpat Bulk Document Downloader (Firefox)

_Extension version 0.17.15. Firefox port of the existing Chrome extension._

## One-line purpose

A user signed into Israel's Net HaMishpat court portal
(`https://securesso.court.gov.il/Ngcs.Web.Secured/`) selects case materials
and bulk-exports them: **documents** as one ZIP with a CSV index, and
**hearing schedules** as CSV + ICS — locally by default, or to a destination
the user configures (a personal API server, Google Drive, or Google
Calendar).

## What's different from the Chrome version

Identical UX. Only difference is the Google OAuth path:

| Chrome build                                            | Firefox build                                                |
|---------------------------------------------------------|--------------------------------------------------------------|
| `chrome.identity.getAuthToken` + `oauth2` in `manifest` | `browser.identity.launchWebAuthFlow` + Web-app client server |
| `downloads` permission requested                        | Not requested (not used)                                     |
| `oauth2` manifest block                                 | `browser_specific_settings.gecko.id`                         |

No other behavioral changes.

## Data flow

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
       │   a Blob URL + anchor (Firefox-native, no chrome.downloads needed).
       ├─ hearings: hearings-panel.js reads the grid (and drives the page's own
       │   date-range postback), builds CSV + ICS locally.
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
     accounts.google.com (OAuth window), www.googleapis.com (opt-in), and
     a user-typed endpoint (opt-in).
```

## Where data leaves the browser — exhaustive list

| File | URL | When | Purpose |
|---|---|---|---|
| `content/list-panel.js` | `https://securesso.court.gov.il/Ngcs.Web.Secured/…` | Always (core docs flow) | Trigger postback + fetch document page images. **Same origin.** |
| `content/hearings-panel.js` | page's own form (securesso, same origin) | Hearings flow | Drive the date-range postback before reading the grid. |
| `background/service-worker.js` (`uploadServer` / `testServer`) | the endpoint the user typed | Only if user enables the "server" destination | POST each file as `multipart/form-data` with `X-API-Key`. |
| `background/service-worker.js` (Drive) | `https://www.googleapis.com/drive/v3/…`, `…/upload/drive/v3/…`, `…/oauth2/v3/userinfo` | Only if user enables Google Drive | Verify account, browse folders, dedupe, upload files. Scopes: `drive.file` + `drive.metadata.readonly`. |
| `background/service-worker.js` (Calendar) | `https://www.googleapis.com/calendar/v3/…` | Only if user enables Calendar sync | List/create calendar; list existing events in the synced date range; import new events and patch moved ones. Scope: `calendar`. |
| `background/service-worker.js` (OAuth) | `https://accounts.google.com/o/oauth2/v2/auth` | Only when user clicks "Connect to Google" | Implicit-flow consent window (`launchWebAuthFlow`). |

The popup / About pages link to `https://www.z-g.co.il/court-downloader`
(+ `/privacy`, `/terms`) as plain anchor `href`s — the extension never
fetches those URLs.

## No remote code execution

- No `eval(`, no `new Function(`
- No `<script src="http…`, no `executeScript({ code: … })`
- No CDN fetches at runtime; no WASM streaming from URLs

Reviewer-verifiable on the submission ZIP (excluding the bundled libraries):

```
grep -RIn -e 'eval(' -e 'new Function(' -e 'src="http' -e 'executeScript' . --exclude-dir=vendor
```

Matches inside `vendor/` are the bundled jsPDF/JSZip libraries.

## Bundled (minified) third-party libraries

| File | Library | Upstream | License |
|---|---|---|---|
| `vendor/jszip.min.js` | JSZip 3.10.x | https://github.com/Stuk/jszip | MIT |
| `vendor/jspdf.umd.min.js` | jsPDF | https://github.com/parallax/jsPDF | MIT |

Both are vendored at build time — **never** loaded from a CDN at runtime.
We ship the minified UMD builds as published by upstream; no custom build
step. The same folder uploaded as the extension ZIP serves as the source
ZIP (there is no transpilation).

## Test instructions

The core feature needs an authenticated Net HaMishpat session (smart-card /
government SSO) a reviewer is unlikely to have. Without auth, a reviewer
can still verify:

1. **Install:** `about:debugging#/runtime/this-firefox` →
   *Load Temporary Add-on…* → pick `manifest.json`.
2. Content scripts match only `https://securesso.court.gov.il/Ngcs.Web.Secured/*`
   and `https://www.court.gov.il/*`. On any other site, nothing is injected.
3. Even on a matching path, the panel mounts only when a document/hearing
   grid is present (the adapters' `matches()` / `detectMode()` return false
   on landing pages).
4. Open the popup / options: destination toggles persist to
   `browser.storage.local`. With every destination off (default), the
   extension issues ZERO non-court requests.
5. Google sign-in (Drive/Calendar) is triggered only by an explicit user
   click; with no sign-in, no `googleapis.com` call is made.

A screencast of the full authenticated flow can be supplied on request —
contact `guy@z-g.co.il`.

## Permissions restated

| Permission / scope | Used by | Why |
|---|---|---|
| `activeTab` | `content/list-panel.js`, `content/hearings-panel.js`, adapters | Read the list on the active page. |
| `storage` | `shared/settings.js` (all surfaces) | Persist configuration preferences only. |
| `identity` | `service-worker.js` (`launchWebAuthFlow`) | Google OAuth, only for the optional Drive/Calendar destinations. |
| host `securesso.court.gov.il` | content scripts | Fetch user-selected items from the source host. |
| host `www.court.gov.il` | content scripts | New public portal endpoints (same product). |
| host `www.googleapis.com` | `service-worker.js` | Drive/Calendar, only when enabled by the user. |
| host `accounts.google.com` | `service-worker.js` | The OAuth consent window opened by `launchWebAuthFlow`. |
| scopes `drive.file`, `drive.metadata.readonly` | `service-worker.js` | Files it created; folder names for the built-in picker. |
| scope `calendar` | `service-worker.js` | The user's hearing events (only if calendar sync is enabled), including reading them back within the synced date range so a rescheduled hearing updates in place. |

## `web-ext lint` warnings — for the record

`npx web-ext lint` reports **0 errors, 0 notices, 15 warnings**. Every
warning falls into one of two well-understood categories:

1. **`DANGEROUS_EVAL` / `UNSAFE_VAR_ASSIGNMENT` inside `vendor/`** (5
   findings) — these are the published, un-modified UMD builds of JSZip
   3.10 and jsPDF. The findings are inherent to those libraries' shipped
   bundles, not introduced by us.

2. **`UNSAFE_VAR_ASSIGNMENT` (innerHTML) in our content scripts** at
   `content/header-sync.js:291`, `content/hearings-panel.js:194` /`:593`,
   `content/judge-calendar.js:124` /`:233`, `content/list-panel.js:101` /
   `:161` / `:197`, `options/options.js:42` — every innerHTML site
   assigns a static template literal containing only attribute-quoted
   string concatenation of values that originate from the same court
   portal page (case numbers, case titles, hearing dates). There is no
   user-typed-then-rendered-as-HTML path. We are happy to convert any of
   these to `textContent` + DOM construction if AMO requires.

## Background script — note on type

The Chrome version uses `background.service_worker`; the Firefox build
uses `background.scripts` (event page) for the widest cross-version
compatibility (the linter rejects `service_worker` at strict_min_version
128). The file is still named `background/service-worker.js` for parity
with the Chrome tree — it is the same code, runs identically as an
event-page script.

## Distribution

**Listed on AMO.** Free distribution; primary audience is Israeli legal
practitioners working with Net HaMishpat.

## Contact

Developer: עו"ד גיא זומר · `guy@z-g.co.il` · https://www.z-g.co.il/court-downloader
