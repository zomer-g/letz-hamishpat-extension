# letz-hamishpat-extension — Project Instructions

**לץ המשפט** — a Manifest V3 browser extension for Israel's Net HaMishpat
court portal (נט המשפט). Fully client-side: bulk document download (→ local
ZIP / File System Access API / Google Drive), hearing & judge calendars,
quick case locate ("איתור תיק"), and favorites. No backend of its own — it
reads the court portal DOM and the portal's own JSON stores; nothing is sent
to any server we run.

This repo is the **public, open-source source of truth** for the extension in
**both browsers** (MIT, CI on GitHub): `zomer-g/letz-hamishpat-extension`.
Nothing extension-related lives in the private `court_downloader` monorepo any
more — if you find a copy there, it is stale; delete it rather than edit it.

## Layout — two browser builds, side by side

| Path | What | Version |
|---|---|---|
| `chrome/` | Chrome/Edge extension — **the lead build**, gets features first | 0.18.37 |
| `firefox/` | Firefox/AMO port — separate tree, lags the Chrome feature set | 0.17.15 |
| `chrome-lite/` | Archived stripped-down variant; unmaintained, never published | 1.0.0 |
| `docs/` | `screenshots/`, `chrome-web-store/`, `firefox-amo/`, `testing/`, `site/` |

`CHANGELOG.md` at the repo root is the single version history for both browsers —
**update it on every release**, in the right browser's section.

The two trees are separate because the Firefox port was made from an earlier
Chrome version and uses a different OAuth flow (`identity.launchWebAuthFlow` +
a Google *Web application* client, vs Chrome's `getAuthToken`) — see
`docs/firefox-amo/SETUP_FIREFOX.md`. The intended end state is ONE tree with a
per-target build (`--target=firefox`), like the sibling "לץ הממשל" extension;
until then, a change that must reach both browsers has to be applied twice.
Firefox specifics (event-page background, `chrome`→`browser` shim, the mandatory
`data_collection_permissions` manifest key) are covered by the `firefox-port` skill.

## Architecture (`chrome/` — the Firefox tree mirrors it)

Content scripts run on the court portal pages and inject UI panels; a service
worker coordinates downloads and the Google Drive OAuth flow.

- `manifest.json` — MV3 manifest. `version` is the single source of truth for
  the version number; the DOM stamp `documentElement[data-cd-version]` mirrors it.
- `background/service-worker.js` — download coordination, ZIP assembly handoff,
  Drive OAuth. The only place with elevated permissions.
- `content/` — page-injected features:
  - `case-open.js` — "איתור תיק מהיר" quick case locate.
  - `favorites.js` — favorite cases (persist, "כניסה", star reflects open case).
  - `hearings-panel.js`, `list-panel.js` — document/hearing collectors + export.
  - `judge-calendar.js`, `judge-runner.js`, `judge-bg-collector.js`,
    `case-judge-chip.js` — judge calendar feature (court+judge → calendar).
  - `header-sync.js`, `adapters/` — per-domain DOM adaptation.
  - `toolbar.css` — injected panel styles.
- `shared/` — domain-agnostic helpers: `case-locator.js`, `courts.js`
  (static seed of the ~90 Net HaMishpat courts), `csv.js`, `zip-builder.js`,
  `ics-builder.js`, `datepicker.js`, `ui-host.js`, `settings.js`, `constants.js`.
- `popup/`, `options/`, `about/` — extension UI surfaces.
- `_locales/` — i18n (Hebrew primary).
- `vendor/` — third-party libs bundled locally (no remote code — MV3 forbids it).
- `build-zip.js` — produces the clean CWS upload ZIP.
- `tests/` — jsdom offline unit suite.

## Build & test

All npm work happens **inside `chrome/`** (that's where `package.json` lives):

- `cd chrome && npm test` — jsdom unit suite (`tests/run-tests.js`), offline.
  **Must be green before every release.**
- `cd chrome && npm run build` — clean ZIP for the Chrome Web Store.
- `cd firefox && node build-zip.js` — clean ZIP for AMO. Validate with
  `npx web-ext lint --source-dir <unzipped>` (expect 0 errors; the Android
  min-version warning is benign).

## 🚨 Release / testing policy (mandatory per version)

See `docs/testing/TESTING.md` for the full checklist. Non-negotiables:

1. **Test on BOTH Net HaMishpat domains** — the no-auth public domain
   (`www.court.gov.il/NGCS.Web.Site/…`) AND the authenticated secure domain
   (`securesso.court.gov.il/Ngcs.Web.Secured/…`). Their DOM differs, so a
   feature that works on one can silently break on the other. Run `npm test`
   AND live-verify each changed feature on both domains.
2. **Dual UI config** — EVERY feature must render in **both** inline and
   floating-window modes (branch on the UI-floating flag). Verify both.
3. **Never log in for the user** — they authenticate in the automation window
   themselves; sessions expire fast, re-request auth when the tab bounces to
   `login.gov.il`.
4. **"Fix didn't take effect"?** First suspect a **duplicate copy** — a
   Chrome-Web-Store install coexisting with the unpacked dev copy. Both inject
   content scripts and share `sessionStorage` (`cd_jrun`, `cd_judge_job`),
   which corrupts judge-calendar collectors. Remove the store copy. Also: a page
   refresh does NOT reload content scripts — reload the extension, then
   hard-refresh. Verify via `[data-cd-version]` / `[data-cd-runner]` DOM stamps.

## Do NOT publish without explicit go-ahead

Do not bump the version, build a store ZIP, commit a release, or push to
`origin/main` unless the user explicitly asks for a release. Regular pushes to
`main` are fine for finished changes, but a **version bump / store submission is
a distinct, user-triggered action** — park work-in-progress on a branch instead.

## Security / secrets

Never hardcode secrets. User-entered `apiKey`/token fields live in
`chrome.storage`; the Google OAuth `client_id` is public and fine to commit.
MV3 forbids remote code — all third-party code must be vendored under `vendor/`.

## Repo hygiene

- `_locales/` Hebrew strings drive the UI; keep them in sync with features.
- `CHANGELOG.md` — update on every release, under the right browser.
- Store paperwork lives in `docs/`: `chrome-web-store/` (`STORE_LISTING.md`,
  `REVIEWER_NOTES.md`, `CWS_DASHBOARD_TEXTS.md`) and `firefox-amo/`
  (`AMO_PUBLISH_GUIDE.md`, `AMO_LISTING.md`, `AMO_REVIEWER_NOTES.md`,
  `SETUP_FIREFOX.md`). Keep them current when behavior or permissions change —
  a permission change means BOTH stores' declarations need review.
- `docs/screenshots/` is shared by both stores (1280×800). Regenerate via the
  marketing template rather than hand-editing PNGs.
