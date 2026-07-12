# letz-hamishpat-extension — Project Instructions

**לץ המשפט** — a Manifest V3 Chrome extension for Israel's Net HaMishpat
court portal (נט המשפט). Fully client-side: bulk document download (→ local
ZIP / File System Access API / Google Drive), hearing & judge calendars,
quick case locate ("איתור תיק"), and favorites. No backend of its own — it
reads the court portal DOM and the portal's own JSON stores; nothing is sent
to any server we run.

This repo is the **public, open-source source of truth** for the extension
(MIT, CI on GitHub). Public repo: `zomer-g/letz-hamishpat-extension`.

> Historical note: the extension used to live as `chrome-extension/` inside the
> private `court_downloader` monorepo. It was split out into this standalone
> repo. If a `chrome-extension/` copy still exists in that monorepo, treat
> **this** repo as authoritative and do not edit both — see the source-of-truth
> note in the monorepo before touching either.

## Architecture

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

- `npm test` — jsdom unit suite (`tests/run-tests.js`), offline. **Must be green
  before every release.**
- `npm run build` — `build-zip.js` → clean ZIP for the Chrome Web Store.

## 🚨 Release / testing policy (mandatory per version)

See `TESTING.md` for the full checklist. Non-negotiables:

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
- `LICENSE` (MIT), `SECURITY.md`, `PRIVACY_POLICY.md`, `STORE_LISTING.md`,
  `REVIEWER_NOTES.md`, `CWS_DASHBOARD_TEXTS.md` are the Chrome Web Store /
  open-source paperwork — keep them current when behavior or permissions change.
