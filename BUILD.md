# Build instructions (for AMO / Chrome Web Store reviewers)

This archive is the complete, unmodified source of the extension. Building it
reproduces the exact add-on package that was uploaded.

## Build environment

- **Operating system:** any OS that runs Node.js (developed on Windows 11,
  builds identically on macOS and Linux — the build script is plain Node, no
  platform-specific steps).
- **Node.js 18 or newer** — https://nodejs.org (the LTS installer includes
  `npm`). No other program is required.
- **No build toolchain.** There is no bundler, minifier, transpiler, template
  engine or preprocessor anywhere in this project. There are **no runtime
  dependencies**; `npm install` is only needed if you want to run the test
  suite (its single devDependency is `jsdom`).

## Steps

```bash
cd src
npm run build:firefox     # → dist/firefox-extension-<version>.zip   (the AMO package)
```

For the Chrome package, or both at once:

```bash
cd src
npm run build             # → dist/extension-<version>.zip
npm run build:all         # both, from the same version
```

Optional — run the offline test suite (no network access needed):

```bash
cd src
npm install
npm test
```

## What the build script does

`src/build-zip.js` walks `src/`, skips the development-only paths (`tests/`,
`dist/`, `node_modules/`, `samples/`, `marketing/`, `package.json`,
`package-lock.json`, `build-zip.js` itself, and the markdown files) and writes
every remaining file into the ZIP **byte-for-byte, unchanged**.

Exactly one file is generated rather than copied: `manifest.json` for the
Firefox target. `toFirefoxManifest()` in `src/build-zip.js` takes the Chrome
manifest and

- converts `background.service_worker` to an event page (`background.scripts`),
- adds `browser_specific_settings.gecko` — the permanent add-on id,
  `strict_min_version: "140.0"`, and
  `data_collection_permissions: { "required": ["none"] }`,
- removes the Chrome-only `oauth2` block.

Nothing else is transformed. `src/tests/dual-build.test.js` pins this contract,
asserting that the two manifests differ only in those keys and that every other
part of the package is identical between the browsers.

Note: the ZIP is written with current timestamps, so a rebuild produces an
archive with the same contents but a different checksum than the uploaded file.
The extension files inside are identical.

## Third-party libraries

Two libraries are vendored under `src/vendor/`. They are the **official
distribution files of their publishers, unchanged** — we do not minify anything
ourselves. Manifest V3 forbids loading remote code, so they ship inside the
package:

| File | Library | Version | License | Source |
|---|---|---|---|---|
| `src/vendor/jszip.min.js` | JSZip | 3.10.1 | MIT | https://github.com/Stuk/jszip/releases/tag/v3.10.1 |
| `src/vendor/jspdf.umd.min.js` | jsPDF | 2.5.1 | MIT | https://github.com/parallax/jsPDF/releases/tag/v2.5.1 |

## Repository

The project is public and MIT-licensed:
https://github.com/zomer-g/letz-hamishpat-extension

The uploaded package was built from the commit tagged for this version. The
version number itself lives in `src/manifest.json` and is mirrored into the ZIP
file name.
