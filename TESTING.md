# Extension release testing — MANDATORY per version

Every version is regression-tested on **BOTH** Net HaMishpat domains before it
ships. Their DOM differs, so a feature that works on one can silently break on
the other (e.g. the "איתור תיק / חובה להזין ערך בשדה סדרה" bug reproduced ONLY on
the public domain; the favorites-overwrite bug ONLY on the secured domain).

## The two domains

| | URL prefix | Auth |
|---|---|---|
| **Public (no auth)** | `https://www.court.gov.il/NGCS.Web.Site/…` | none |
| **Secure (auth)** | `https://securesso.court.gov.il/Ngcs.Web.Secured/…` | government identity / smart card |

The user authenticates in the automation window themselves — **never log in for
them.** Sessions expire fast; re-request auth when the tab bounces to
`login.gov.il`.

## Per-version checklist

1. **Unit suite:** `npm test` — must be green (jsdom, offline). Keep fixtures for
   BOTH DOM shapes where they differ (e.g. `tests/case-open.test.js` covers the
   secured header locator **and** the public locator + "סדרה" combo).
2. **Live, on EACH domain above**, verify every changed feature — and in BOTH UI
   configs (inline + floating; see the dual-config rule):
   - [ ] **איתור תיק מהיר** — paste a free-form number (`39163-07-22`, `ת"א …`,
         `עת"מ 40348-05-20 …`) → opens the case, no "שדה סדרה" error.
   - [ ] **תיקים מועדפים** — add ≥2 different cases → all persist (no overwrite);
         "כניסה" opens each; star reflects the OPEN case (not a favorite).
   - [ ] **יומן שופט** — court+judge detected → calendar opens; no stuck cascade;
         text renders clean (no gibberish) for a judge WITH hearings.
   - [ ] **מסמכים / דיונים** collectors still mount and export.
3. **Regressions:** anything touched by the change, on both domains.

## Before debugging "a fix didn't take effect"

1. **Duplicate copy?** Search `chrome://extensions` for the extension name — a
   Chrome-Web-Store copy can silently coexist with the unpacked dev copy. Both
   inject content scripts; panels dedupe by DOM id so the UI looks single, but
   sessionStorage state (`cd_jrun`, `cd_judge_job`) is SHARED between the two
   copies' scripts → racing collectors corrupt judge-calendar data. Remove the
   store copy (the card without the ↻ icon).
2. **Stale scripts?** A page refresh does NOT update content scripts — reload
   the extension, then hard-refresh the tab. Verify with the DOM stamps:
   `documentElement[data-cd-version]` (manifest) and `[data-cd-runner]`
   (judge-runner build tag).

## Notes on domain-specific DOM

- The **same** header locator control (`CaseLocatorHeaderUC2_…HT`) appears on both
  domains, BUT the public domain enforces the "סדרה" (`NumeratorGroupTypeComboBoxHT`)
  validator — its selection only registers when a `change` event fires.
- Page charset is `windows-1255` with **no `<meta charset>`** on both — rely on the
  HTTP header; harvest hearing data from the JSON ArrayStore, not the AG-Grid.
