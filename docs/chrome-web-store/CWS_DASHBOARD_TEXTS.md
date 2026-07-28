# CWS Developer Dashboard — Copy-Paste Texts

> Paste these as-is into the Chrome Web Store Developer Dashboard. Order follows
> the dashboard sections. Reflects extension version 0.17.4 (name: "לץ המשפט").

---

## 0. Store listing URLs

| Field | URL |
|---|---|
| Homepage URL | `https://www.z-g.co.il/court-downloader` |
| Privacy policy URL | `https://www.z-g.co.il/court-downloader/privacy` |
| Terms of service URL | `https://www.z-g.co.il/court-downloader/terms` |

---

## 1. Privacy practices

### Privacy Policy URL
```
https://www.z-g.co.il/court-downloader/privacy
```
(Must resolve over HTTPS without login. Verified by reviewer.)

### Single Purpose Description
```
The extension lets a user who is signed into Net HaMishpat (the Israeli courts portal, נט המשפט) download and save their own case materials that they select — case documents (saved as PDFs in a single ZIP file with a CSV index) and hearing schedules — to their own computer and/or to their own Google Drive, and optionally sync their own hearings to a Google Calendar they choose. One coherent purpose: downloading and saving the user's own case documents and hearings.
```

Hebrew (matches the listing language):
```
הורדה ושמירה של מסמכים ודיונים מתיק בנט המשפט שהמשתמש/ת מחובר/ת אליו — לקובץ ZIP אחד עם אינדקס ו/או ל-Google Drive.
```

### Permission Justifications

**`downloads`**
```
Used to save the output the extension assembles in the browser — the ZIP of selected PDFs plus its CSV index — to the user's computer. Without it there is no way to deliver the file the extension just built in memory.
```

**`activeTab`**
```
The content scripts (content/list-panel.js, content/hearings-panel.js, content/header-sync.js and the adapters under content/adapters/) read the document / hearing list inside the Net HaMishpat page the user is currently viewing, to build the in-page selection panel. activeTab is used instead of the broader "tabs" permission because the extension only acts on the page the user already opened, and only after the user interacts with the in-page panel or the toolbar icon.
```

**`storage`**
```
Persists configuration preferences only (shared/settings.js): destination selection, the chosen Google Drive folder id/name, a dedupe toggle, the master on/off toggle, and Google Calendar field/template preferences. No document content, cookies, or PII is ever written to storage.
```

**`identity`**
```
Used in background/service-worker.js (chrome.identity.getAuthToken) to obtain a Google OAuth token, ONLY when the user explicitly enables an optional Google destination — uploading the files to their own Google Drive, or syncing their hearings to their own Google Calendar. Not used at all if the user stays on the default local-ZIP destination.
```

### Host permission justifications

**`https://securesso.court.gov.il/*`**
```
The authenticated Net HaMishpat portal that hosts the lawyer's case views (national-ID login). The extension reads the document/hearing list on these pages and fetches the items the user selected from this same origin (riding the user's existing session).
```

**`https://secure.court.gov.il/*`**
```
The SECOND authenticated Net HaMishpat portal — identical Net HaMishpat application, reached via the smart-card login instead of national-ID. Same behavior as securesso.court.gov.il: read the case document/hearing list and fetch the selected items from this same origin, on the user's existing session. Needed so lawyers who sign in with a smart card can use the extension.
```

**`https://www.court.gov.il/*`**
```
The PUBLIC Net HaMishpat portal (the same web app, no login). Included so the extension is available there too — chiefly so reviewers can load and test the UI without lawyer credentials. Same read-the-list / fetch-selected-items behavior, scoped to this origin.
```

**`https://www.googleapis.com/*`**
```
Used only when the user enables a Google destination: Drive uploads (files.create) and, if turned on, Calendar events. No Google call is made unless the user signs in and turns the destination on.
```

> NOTE (v0.17.4): the broad `optional_host_permissions` (`https://*/*`, `http://*/*`)
> was REMOVED. It previously backed an optional "send to my own API server"
> destination, which is now hidden from the UI. Removing it avoids the
> in-depth host-permission review.

### Google OAuth scopes (requested only on explicit sign-in)
- `https://www.googleapis.com/auth/drive.file` — access only files the extension created (Drive uploads).
- `https://www.googleapis.com/auth/drive.metadata.readonly` — read folder names for the built-in Drive folder picker.
- `https://www.googleapis.com/auth/calendar` — create/update the user's hearing events in a calendar they choose.

### Data Usage Declarations (tick the boxes truthfully)

| Category | Collected? | Justification text |
|---|---|---|
| Personally identifiable information | **No** | The extension never reads names, IDs, emails, or auth credentials. |
| Health information | No | N/A. |
| Financial and payment information | No | N/A. |
| Authentication information | **No** | Does not read cookies, tokens, or login forms; it rides on the browser's existing session via `credentials: 'include'`. |
| Personal communications | No | N/A. |
| Location | No | N/A. |
| Web history | No | N/A. |
| User activity | No | No telemetry, no analytics, no off-device logging. |
| Website content | **Yes** | The content scripts read the case document / hearing list on the active page to build the selection UI. Selected items are fetched from `court.gov.il` (the source origin) and — only if the user enables those optional destinations — uploaded to the user's own Google Drive or written to the user's own Google Calendar. It is never sent to the developer or any analytics service. |

### Three certifications (all three must be checked YES)
- ✅ I do not sell or transfer user data to third parties, apart from the approved use cases described above.
- ✅ I do not use or transfer user data for purposes unrelated to the extension's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or for lending.

---

## 2. Listing

### Visibility
**Unlisted** (direct-link install only)

### Homepage URL
```
https://www.z-g.co.il/court-downloader
```

### Terms of Service URL
```
https://www.z-g.co.il/court-downloader/terms
```

### Support URL
```
https://github.com/zomer-g/court_downloader/issues
```

### Graphic assets (in marketing/cws/, 24-bit PNG, no alpha)
- Store icon 128×128 → `icons/128.png`
- Screenshots 1280×800 → `1-select.png`, `2-progress.png`, `3-popup.png`, `4-folderpicker.png`, `5-hearings.png`
- Small promo tile 440×280 → `promo-small.png`
- Marquee promo tile 1400×560 → `promo-marquee.png`

---

## 3. Reviewer notes (paste into the "Notes to reviewer" field)
Paste the entire content of `REVIEWER_NOTES.md` (bundled in the extension package).
