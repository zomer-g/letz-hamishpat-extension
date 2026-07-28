# Firefox / AMO setup — one-time

The Firefox port uses `browser.identity.launchWebAuthFlow` instead of Chrome's
`chrome.identity.getAuthToken`. That changes the Google Cloud Console setup:
the Chrome OAuth client (type **Chrome Extension**) does **not** work on
Firefox because Firefox's redirect URI is `https://<id>.extensions.allizom.org/`
— a normal `https://` URL that only **Web application** clients accept.

You only need to do this once.

## 1. Get the Firefox redirect URI for this extension

1. Open Firefox → `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `src/dist/firefox/manifest.json` (הרץ תחילה `npm run build:firefox`).
3. Click the extension's **Inspect** button to open its service-worker
   console.
4. In the console, run:
   ```js
   browser.identity.getRedirectURL()
   ```
   You get a URL like:
   ```
   https://9a2c…f0.extensions.allizom.org/
   ```
   Copy it — that's the redirect URI you need to register with Google.

## 2. Create a Google OAuth 2.0 *Web application* client

1. https://console.cloud.google.com → pick the same project you used for the
   Chrome client (or create a new one).
2. **APIs & Services → Library** → enable **Google Drive API** and
   **Google Calendar API** (the latter only if you'll use hearing sync).
3. **APIs & Services → OAuth consent screen** → External →
   add yourself as **Test user** while the app is in "Testing" mode.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - **Application type:** *Web application* (not *Chrome Extension*).
   - **Name:** `Court Downloader — Firefox`.
   - **Authorized JavaScript origins:** leave empty.
   - **Authorized redirect URIs:** paste the URL from step 1, e.g.
     `https://9a2c…f0.extensions.allizom.org/`.
5. Copy the **Client ID** (`12345-abcd.apps.googleusercontent.com`).

## 3. Wire the client ID into the extension

Open `src/background/service-worker.js` and replace the
placeholder:

```js
const FIREFOX_OAUTH_CLIENT_ID = 'REPLACE_WITH_WEB_APP_CLIENT_ID.apps.googleusercontent.com';
```

with your actual Web-application client ID. Reload the temporary add-on.

> The client ID is a **public** OAuth identifier — it's safe to ship in the
> extension bundle (same as Chrome's `oauth2.client_id` in `manifest.json`).
> It is NOT a secret.

## 4. Smoke test

1. Open the popup → **Connect to Google** → consent in the browser window
   that launchWebAuthFlow opens.
2. The popup should show "✓ connected" plus your Google email.
3. Trigger a Drive upload from any document/hearing flow.

If Google returns `redirect_uri_mismatch`, the URI in step 4 of section 2
does not exactly match what `getRedirectURL()` printed in section 1
(trailing slash matters).

## 5. Submitting to AMO

See [AMO_REVIEWER_NOTES.md](AMO_REVIEWER_NOTES.md) for the reviewer-facing
text and [AMO_LISTING.md](AMO_LISTING.md) for the public listing copy.

Build the submission ZIP:

```bash
cd src
npm run build:firefox
# → dist/firefox-extension-v{version}.zip
```

Optional pre-submission validation:

```bash
npx web-ext lint --source-dir src/dist/firefox
npx web-ext build --source-dir src/dist/firefox
```

Upload at https://addons.mozilla.org/developers/ → **Submit a New Add-on**
→ **On this site** (Listed) → upload the ZIP → fill listing fields from
`AMO_LISTING.md` → paste reviewer notes from `AMO_REVIEWER_NOTES.md`.

Because `vendor/jszip.min.js` and `vendor/jspdf.umd.min.js` are minified,
AMO will ask for **source code**. Upload either:

- the same folder as a ZIP (the build script is plain JS, no transpile
  needed), OR
- a ZIP containing this folder + a `README` pointing the reviewer at
  https://github.com/jspdf/jspdf and https://github.com/Stuk/jszip
  for the unminified upstream sources.
