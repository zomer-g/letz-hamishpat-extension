// Tests for shared/settings.js — defaults, deep-merge persistence (a partial
// save must not clobber sibling keys), and the documents/hearings profile
// helpers. Runs against the in-memory chrome.storage.local stub.

const { loadShared } = require('./helpers/env.js');

async function run(t) {
  t.section('settings: defaults');
  {
    const CD = loadShared(['shared/settings.js'], {});
    const s = await CD.getSettings();
    t.eq('enabled defaults true', s.enabled, true);
    t.eq('documentFormat defaults pdf', s.documentFormat, 'pdf');
    t.eq('localZip default on', s.destinations.localZip, true);
    t.eq('driveSkipExisting default on', s.dedupe.driveSkipExisting, true);
    t.eq('hearings profile present', typeof s.hearings, 'object');
    t.eq('calendarSync monthsAhead default', s.calendarSync.monthsAhead, 12);
    t.eq('ui.showClownHat defaults true', s.ui.showClownHat, true);
    t.eq('ui.floating defaults false', s.ui.floating, false);
  }

  t.section('settings: ui appearance flags persist without sibling clobber');
  {
    const CD = loadShared(['shared/settings.js'], {});
    await CD.saveSettings({ ui: { floating: true } });
    const s1 = await CD.getSettings();
    t.eq('floating saved', s1.ui.floating, true);
    t.eq('showClownHat sibling preserved', s1.ui.showClownHat, true);

    await CD.saveSettings({ ui: { showClownHat: false } });
    const s2 = await CD.getSettings();
    t.eq('showClownHat saved', s2.ui.showClownHat, false);
    t.eq('floating NOT clobbered', s2.ui.floating, true);
  }

  t.section('settings: saveSettings deep-merges (no sibling clobber)');
  {
    const CD = loadShared(['shared/settings.js'], {});
    await CD.saveSettings({ server: { endpoint: 'https://x.example' } });
    const s1 = await CD.getSettings();
    t.eq('endpoint saved', s1.server.endpoint, 'https://x.example');
    t.eq('apiKey sibling preserved (empty default)', s1.server.apiKey, '');

    await CD.saveSettings({ server: { apiKey: 'secret' } });
    const s2 = await CD.getSettings();
    t.eq('apiKey saved', s2.server.apiKey, 'secret');
    t.eq('endpoint NOT clobbered by apiKey save', s2.server.endpoint, 'https://x.example');

    await CD.saveSettings({ documentFormat: 'doc' });
    const s3 = await CD.getSettings();
    t.eq('top-level scalar saved', s3.documentFormat, 'doc');
    t.eq('nested server still intact', s3.server.apiKey, 'secret');
  }

  t.section('settings: getProfile');
  {
    const CD = loadShared(['shared/settings.js'], {});
    const s = await CD.saveSettings({
      server: { endpoint: 'https://docs.example' },
      hearings: { server: { endpoint: 'https://hear.example' } },
    });
    const docs = CD.getProfile(s, 'documents');
    const hear = CD.getProfile(s, 'hearings');
    t.eq('documents endpoint', docs.server.endpoint, 'https://docs.example');
    t.eq('hearings endpoint', hear.server.endpoint, 'https://hear.example');
    t.ok('documents profile has dedupe', typeof docs.dedupe === 'object');
    t.ok('hearings profile has destinations', typeof hear.destinations === 'object');
  }

  t.section('settings: profilePatch targets the right location');
  {
    const CD = loadShared(['shared/settings.js'], {});
    const docPatch = CD.profilePatch('documents', { server: { endpoint: 'A' } });
    t.eq('documents patch is top-level', docPatch.server.endpoint, 'A');
    const hearPatch = CD.profilePatch('hearings', { server: { endpoint: 'B' } });
    t.eq('hearings patch nested under .hearings', hearPatch.hearings.server.endpoint, 'B');
    t.ok('hearings patch has no top-level server', hearPatch.server === undefined);
  }
}

module.exports = { run };
