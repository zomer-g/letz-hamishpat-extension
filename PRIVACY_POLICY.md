# Privacy Policy — מוריד מסמכים אצווה (נט המשפט)

_Last updated: 2026-06-05 · extension version 0.9.7_

> The canonical, user-facing Hebrew version lives at
> `https://www.z-g.co.il/court-downloader/privacy` (source in `site/privacy.md`).
> This English copy is the reviewer-facing reference bundled in the package.

This extension lets a user who is already signed into Net HaMishpat
(`https://securesso.court.gov.il/Ngcs.Web.Secured/`) bulk-export selected case
materials — **documents** (as PDFs in a ZIP with a CSV index) and **hearing
schedules** (as CSV + ICS, optionally synced to Google Calendar) — onto their
own computer or to a destination they configure themselves.

## What the extension does on your computer
- Reads the document/hearing-list table on the **active Net HaMishpat page only**, to show a checkbox next to each row.
- Fetches the items you explicitly select, using the authenticated session that already exists in your browser (cookies are sent by the browser; the extension never reads or copies them).
- Packages documents into a ZIP with an `index.csv`, or hearings into CSV + ICS files, locally, then asks the browser to save them.

## Optional destinations (only when YOU enable them)
- **API server** — if you enter an endpoint + key, each file is POSTed to *your* endpoint as `multipart/form-data` with an `X-API-Key` header. Endpoint and key are stored locally and used only for the destination you configured.
- **Google Drive** — after you sign in (Google OAuth), files upload to a folder named **"מסמכי נט המשפט"** which the extension creates for you in My Drive the first time you connect. Scope `drive.file` (the default, non-sensitive scope) limits access to files the extension itself created — it cannot see or touch anything else in your Drive. If you open *Advanced Options → choose a custom destination folder*, the extension additionally requests `drive.metadata.readonly` so its built-in folder picker can show the names of folders you already own. That additional scope is requested only on that explicit click and you can decline it.
- **Google Calendar** — if you enable calendar sync, the extension creates/updates hearing events in a calendar you choose (scope `calendar`), only on an action you initiate. Hearing data is written directly to your Google calendar.

## What is stored locally (chrome.storage.local)
Configuration preferences only — never document content or PII: destination
selection, the API endpoint + key you typed, the Drive folder id/name, the
dedupe toggle, and the calendar-sync templates. All of it is deleted when you
uninstall the extension.

## What the extension does NOT do
- ❌ No analytics, no telemetry, no error reporting.
- ❌ No reading or storage of cookies, passwords, ID numbers, names, emails, or any other PII.
- ❌ No selling, sharing, or transferring of data to any third party.
- ❌ No remote code execution: all JavaScript is bundled in the package; nothing is loaded from a CDN at runtime; `eval()` and `new Function()` are never used.

## Data categories (Chrome Web Store classification)
- **Website content**: YES — the extension reads the document/hearing-list HTML on the active tab. It is sent only to `securesso.court.gov.il` itself (the source origin) to fetch the items you selected, and — **only if you enable those destinations** — to your configured API endpoint, Google Drive, or Google Calendar.
- All other categories (PII, auth info, financial, health, location, web history, user activity, communications): NO.

## Permissions and why
| Permission | Why |
|---|---|
| `downloads` | Save the assembled ZIP / files via the browser's download flow. |
| `activeTab` | Read the list on the page you are currently looking at. |
| `storage` | Remember configuration preferences only. |
| `identity` | Google OAuth sign-in, only for the optional Drive/Calendar destinations. |
| host `https://securesso.court.gov.il/*` | Fetch the items you selected from Net HaMishpat. |
| host `https://www.googleapis.com/*` | Upload to Drive / sync Calendar, when enabled. |
| optional host `https://*/*`, `http://*/*` | Requested only if you configure a personal API server, to send files there. |

**Google OAuth scopes** (requested only on explicit sign-in):
- `drive.file` — default Drive scope, requested on Drive connect. Non-sensitive.
- `drive.metadata.readonly` — requested ONLY when you open the advanced "custom folder picker"; you can refuse.
- `calendar` — requested only on Calendar connect.

## Your control
Uninstall at any time (deletes all stored preferences), disconnect the Google
account, and revoke access from your Google account settings.

## Contact
Attorney Guy Zomer — guy@z-g.co.il · 054-7650202
Bug reports: https://github.com/zomer-g/court_downloader/issues
