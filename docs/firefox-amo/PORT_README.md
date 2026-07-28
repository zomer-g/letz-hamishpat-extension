# מוריד מסמכים אצווה — נט המשפט (Firefox Add-on)

_Version 0.17.15 — Firefox port of the Chrome extension._

MV3 Firefox add-on for Net HaMishpat (`https://securesso.court.gov.il/Ngcs.Web.Secured/`).

For Google Drive / Calendar OAuth setup, see [SETUP_FIREFOX.md](SETUP_FIREFOX.md).
For AMO submission, see [AMO_LISTING.md](AMO_LISTING.md) and
[AMO_REVIEWER_NOTES.md](AMO_REVIEWER_NOTES.md).
A signed-in user selects case materials and bulk-exports them:

- **Documents** — select across folders (decisions, motions, pleadings, affidavits, judgments, protocols, exhibits, paper file) and pages, download as one ZIP with a CSV index. PDFs are built in-page (jsPDF) from the viewer's `GetAllImages` endpoint.
- **Hearings** — download hearing lists (incl. cross-case "my hearings" with a date range) as CSV + ICS, or sync them into Google Calendar.
- **Destinations** — local ZIP (default), a personal API server (multipart + `X-API-Key`), or Google Drive (folder picker, sub-folder by case + list, dedupe).

Everything runs client-side by default; the optional server/Drive/Calendar
destinations activate only when the user turns them on with their own credentials.

## Load unpacked

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select the `firefox/` folder.
3. Sign into Net HaMishpat normally (smart-card / gov.il SSO).
4. Open a case's documents or hearings page. A blue panel ("📥 הורדת מסמכים" / hearings) appears above the grid, with checkboxes per row.

## Architecture (file layout)

```
firefox/
├── manifest.json                 # MV3: downloads, activeTab, storage, identity
├── _locales/he/messages.json
├── icons/{16,48,128}.png
├── background/service-worker.js  # OPTIONAL destinations only: API server, Drive, Calendar
├── content/
│   ├── list-panel.js             # documents panel (same-origin postback + GetAllImages → jsPDF → ZIP)
│   ├── hearings-panel.js         # hearings panel (CSV + ICS + calendar sync)
│   ├── header-sync.js
│   ├── toolbar.css
│   └── adapters/
│       ├── net-court.js          # document folders + __doPostBack arg derivation
│       └── net-court-hearings.js # hearing grids + mode detection
├── shared/{constants,settings,csv,ics-builder,datepicker}.js
├── vendor/{jszip,jspdf}.min.js   # bundled, no CDN
├── popup/ · options/ · about/    # control center, settings, about
├── build-zip.js                  # creates dist/extension-vX.Y.Z.zip
└── STORE_LISTING.md · CWS_DASHBOARD_TEXTS.md · PRIVACY_POLICY.md · REVIEWER_NOTES.md · SETUP.md
```

Site page texts (homepage / privacy / terms) for `z-g.co.il` live under `site/`.

## Build a submission ZIP

```bash
cd chrome-extension
node build-zip.js   # → dist/extension-v<version>.zip
```
Excludes: `.md` docs, `site/`, `marketing/`, `dist/`, `build-zip.js`, `node_modules`, `.git`.

## Chrome Web Store submission

1. Store listing URLs (live, HTTPS, no login):
   - Homepage: `https://www.z-g.co.il/court-downloader`
   - Privacy: `https://www.z-g.co.il/court-downloader/privacy`
   - Terms: `https://www.z-g.co.il/court-downloader/terms`
2. Upload the latest `dist/extension-v<version>.zip`.
3. Paste the texts from `CWS_DASHBOARD_TEXTS.md` (privacy URL, single-purpose, per-permission justifications, data-usage declarations).
4. Paste the full `REVIEWER_NOTES.md` into "Notes to reviewer".
5. Set Visibility = **Unlisted**. Typical review: 1–3 business days.

See `SETUP.md` for the API-server contract and the Google Cloud OAuth setup
(client id, test users, scopes).
