# Security Policy

## Reporting a vulnerability

If you find a security issue in this extension — anything that could leak a
user's court data, execute remote code, or act on the user's authenticated
session beyond what the UI exposes — please **do not open a public issue**.

Report it privately via the contact form at
[z-g.co.il](https://www.z-g.co.il/court-downloader) or by opening a
[GitHub security advisory](../../security/advisories/new) on this repository.
You should receive a response within a few days.

## Scope & design guarantees

- The extension has **no server of its own** and sends no telemetry.
- All processing is client-side, inside the user's existing authenticated
  session. The extension never reads or transmits cookies or credentials, and
  never performs authentication on the user's behalf.
- Optional destinations (personal API server, Google Drive/Calendar) activate
  only when the user configures them, with the user's own credentials
  (stored in `chrome.storage`).
- No remote code: all libraries (jsPDF, JSZip) are bundled in `vendor/`.
  A PR that introduces a remote script/CDN reference will be rejected.
