// shared/settings.js — central settings store, shared by content script,
// options page, and service worker. Persisted in chrome.storage.local.
//
// Two independent destination PROFILES:
//   • documents (decisions/pleadings/…) — lives at the TOP LEVEL of the
//     settings object, unchanged, so the existing docs feature keeps working
//     with zero migration.
//   • hearings (מועדי דיון / יומן דיונים) — lives under `hearings`.
//
// Shape:
// {
//   // ── documents profile (top level, legacy layout) ──
//   destinations: { localZip: bool, server: bool, drive: bool },
//   server: { endpoint: string, apiKey: string },
//   drive:  { folderId: string, folderName: string },
//   dedupe: { driveSkipExisting: bool },
//   // ── hearings profile ──
//   hearings: {
//     destinations: { localZip: bool, server: bool, drive: bool },
//     server: { endpoint: string, apiKey: string },
//     drive:  { folderId: string, folderName: string }
//   }
// }
//
// Use CD.getProfile(settings, name) to read either profile uniformly, and
// CD.profilePatch(name, partial) to build a saveSettings() patch targeting
// the right profile.

(function (root) {
  const DEFAULTS = {
    // Master on/off switch, toggled live from the "לץ המשפט" header button.
    // When false, every injected widget is hidden across the whole domain
    // (only the toggle itself stays) and the clown hat disappears.
    enabled: true,
    // Document download format on screens that support the native Word export
    // (decisions / judgments / protocols): 'pdf' (built from page images) or
    // 'doc' (the site's own Word/DOC bulk download).
    documentFormat: 'pdf',
    // Word download mode: false = fast (5-doc batches, site filenames, no index);
    // true = slow (one doc per request → informative names + index.csv).
    wordSlowIndex: false,
    // Filename source for per-document downloads (PDF / "Word with index"):
    // false = type + date + case (e.g. "כתב טענות 2025-05-12 12345-06-25");
    // true  = the document's name as shown in Net HaMishpat (e.g. "כתב תביעה").
    nameByTitle: false,
    // "סניגוריה" mode (protocols screen only): each protocol PDF keeps only its
    // FIRST and LAST page. Forces PDF format.
    defenseMode: false,
    destinations: { localZip: true, server: false, drive: false },
    server: { endpoint: '', apiKey: '' },
    drive: { folderId: '', folderName: '' },
    // Dedupe: when uploading to Drive, skip documents already present in the
    // target sub-folder (matched by stable document id, not filename).
    dedupe: { driveSkipExisting: true },
    // Separate destination profile for hearing exports.
    hearings: {
      destinations: { localZip: true, server: false, drive: false },
      server: { endpoint: '', apiKey: '' },
      drive: { folderId: '', folderName: '' },
    },
    // Google Calendar sync (account-level — one calendar/"layer" for the
    // litigant's hearings). lastSyncAt is epoch ms; lastSyncCount is how many
    // events the last sync pushed. monthsAhead is the default sync window
    // (today … +N months). The three templates control the event shape;
    // placeholders: {caseId} {caseName} {court} {judge} {sittingType}
    // {proceeding} {status} {date} {time} {externalCase} {userList}.
    calendarSync: {
      calendarId: '', calendarName: '',
      lastSyncAt: 0, lastSyncCount: 0,
      monthsAhead: 12,
      titleTemplate: '{caseId} {caseName}',
      locationTemplate: '{court}',
      descriptionTemplate: 'שופט: {judge}',
    },
    // Dedicated Google calendar ("layer") for a JUDGE's hearings — separate from
    // the personal calendarSync above (which is the litigant's own hearings,
    // configured when connecting to Google in options). Created on demand the
    // first time the user syncs a judge's hearings.
    judgeCalSync: { calendarId: '', calendarName: '' },
    // Floating judge-calendar window (content/judge-calendar.js): the last view
    // (day/4day/week/month) and which fields show on each hearing.
    judgeCalendar: {
      view: 'week',
      fields: { time: true, sittingType: true, caseType: true, caseId: true, caseName: true },
    },
    // Appearance (account-level). showClownHat: the jester hat on the site
    // logo (default shown). floating: render the download/export panels inside
    // a single draggable floating window that adapts to the current page's
    // features, instead of embedding them inline in the site UI.
    ui: { showClownHat: true, floating: false },
  };

  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (over && typeof over === 'object') {
      for (const k of Object.keys(over)) {
        if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
          out[k] = deepMerge(base[k] || {}, over[k]);
        } else {
          out[k] = over[k];
        }
      }
    }
    return out;
  }

  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('cd_settings', (data) => {
          resolve(deepMerge(DEFAULTS, (data && data.cd_settings) || {}));
        });
      } catch (e) {
        resolve(deepMerge(DEFAULTS, {}));
      }
    });
  }

  function saveSettings(partial) {
    return getSettings().then((cur) => {
      const merged = deepMerge(cur, partial);
      return new Promise((resolve) => {
        chrome.storage.local.set({ cd_settings: merged }, () => resolve(merged));
      });
    });
  }

  // Read a profile's destination config uniformly. name is 'documents'
  // (top level) or 'hearings' (under .hearings). Returns { destinations,
  // server, drive } — always populated from DEFAULTS so callers never hit
  // undefined.
  function getProfile(settings, name) {
    const s = settings || {};
    if (name === 'hearings') {
      const h = s.hearings || {};
      return {
        destinations: Object.assign({}, DEFAULTS.hearings.destinations, h.destinations),
        server: Object.assign({}, DEFAULTS.hearings.server, h.server),
        drive: Object.assign({}, DEFAULTS.hearings.drive, h.drive),
      };
    }
    return {
      destinations: Object.assign({}, DEFAULTS.destinations, s.destinations),
      server: Object.assign({}, DEFAULTS.server, s.server),
      drive: Object.assign({}, DEFAULTS.drive, s.drive),
      dedupe: Object.assign({}, DEFAULTS.dedupe, s.dedupe),
    };
  }

  // Build a saveSettings() patch that targets the right profile location.
  // partial = { destinations?, server?, drive?, dedupe? }.
  function profilePatch(name, partial) {
    if (name === 'hearings') return { hearings: partial };
    return partial;
  }

  root.CD = root.CD || {};
  root.CD.DEFAULT_SETTINGS = DEFAULTS;
  root.CD.getSettings = getSettings;
  root.CD.saveSettings = saveSettings;
  root.CD.getProfile = getProfile;
  root.CD.profilePatch = profilePatch;
})(typeof self !== 'undefined' ? self : globalThis);
