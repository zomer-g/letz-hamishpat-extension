// Google Calendar sync — the reconciliation that replaced blind events.import.
//
// The bug: uidFor() hashes caseId+date+time+sittingType, so a postponed hearing
// produced a NEW iCalUID and import created a SECOND event, leaving the
// original on the calendar. The same hearing scraped from a view without a
// "סוג דיון" column duplicated too, with nothing actually changed.

const { loadScripts } = require('./helpers/env.js');

function env() {
  return loadScripts('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://securesso.court.gov.il/Ngcs.Web.Secured/Calendar/CalendarSittingCase.aspx',
    scripts: ['shared/ics-builder.js', 'shared/cal-sync.js'],
  });
}

// A calendar event as Google would hand it back to us.
function existing(id, caseId, startISO, summary) {
  return {
    id,
    iCalUID: id + '@court-downloader',
    summary: summary || 'דיון',
    start: { dateTime: startISO, timeZone: 'Asia/Jerusalem' },
    end: { dateTime: startISO, timeZone: 'Asia/Jerusalem' },
    extendedProperties: { private: { cdSource: 'letz-hamishpat', cdCase: caseId } },
  };
}

// Records what the sync asked the service worker to do.
function recorder(listResult) {
  const calls = [];
  const send = async (msg) => {
    calls.push(msg);
    if (msg.type === 'cd/calListEvents') return { ok: true, events: listResult || [] };
    return { ok: true, id: 'x' };
  };
  return { calls, send,
    of: (t) => calls.filter((c) => c.type === t) };
}

async function run(t) {
  const CASE = '30638-12-25';
  const hearing = (date, time, sittingType) => ({
    caseId: CASE, caseName: 'זומר נ׳ אדמסו', date, time,
    sittingType: sittingType === undefined ? 'דיון' : sittingType,
  });

  t.section('calendar: a postponed hearing MOVES the event, never adds one');
  {
    const e = env();
    const CD = e.window.CD;
    // On the calendar: the hearing as it was, 06/09 08:30.
    const before = [existing('ev1', CASE, '2026-09-06T08:30:00')];
    // Net HaMishpat now says 13/09 08:30 — same hearing, new date.
    const events = [CD.gcalEvent(hearing('13/09/2026', '08:30'))];

    const rec = recorder(before);
    const r = await CD.calSync({ calendarId: 'cal1', events, send: rec.send });

    t.eq('nothing was imported', r.added, 0);
    t.eq('the existing event was updated', r.updated, 1);
    t.eq('nothing was marked dropped', r.dropped, 0);
    const patches = rec.of('cd/calPatchEvent');
    t.eq('patched the same event id', patches[0].eventId, 'ev1');
    t.eq('moved to the new date', patches[0].patch.start.dateTime.slice(0, 10), '2026-09-13');
  }

  t.section('calendar: a time change moves it too');
  {
    const e = env();
    const CD = e.window.CD;
    const before = [existing('ev1', CASE, '2026-09-06T08:30:00')];
    const events = [CD.gcalEvent(hearing('06/09/2026', '09:30'))];
    const rec = recorder(before);
    const r = await CD.calSync({ calendarId: 'cal1', events, send: rec.send });
    t.eq('updated, not added', r.updated + ':' + r.added, '1:0');
    t.eq('new start time', rec.of('cd/calPatchEvent')[0].patch.start.dateTime.slice(11, 16), '09:30');
  }

  // The second duplication path: the same hearing read from a grid that has no
  // "סוג דיון" column hashed to a different UID and duplicated with no change.
  t.section('calendar: a missing סוג דיון no longer duplicates');
  {
    const e = env();
    const CD = e.window.CD;
    const withType = CD.gcalEvent(hearing('06/09/2026', '08:30', 'דיון'));
    const without = CD.gcalEvent(hearing('06/09/2026', '08:30', ''));
    t.eq('the UIDs really do differ (the old bug)', withType.iCalUID === without.iCalUID, false);

    const before = [existing('ev1', CASE, '2026-09-06T08:30:00')];
    const rec = recorder(before);
    const r = await CD.calSync({ calendarId: 'cal1', events: [without], send: rec.send });
    t.eq('matched on start time, so updated', r.updated, 1);
    t.eq('no second event', r.added, 0);
  }

  t.section('calendar: a genuinely new hearing is added');
  {
    const e = env();
    const CD = e.window.CD;
    const rec = recorder([]);
    const r = await CD.calSync({ calendarId: 'cal1', events: [CD.gcalEvent(hearing('06/09/2026', '08:30'))], send: rec.send });
    t.eq('one import', r.added, 1);
    t.eq('no patches', rec.of('cd/calPatchEvent').length, 0);
  }

  // The user chose "mark as cancelled, keep it visible". status:'cancelled'
  // would REMOVE a non-recurring event from the calendar, so the title is
  // prefixed and the time freed instead.
  t.section('calendar: a vanished hearing is marked, not deleted');
  {
    const e = env();
    const CD = e.window.CD;
    const before = [
      existing('ev1', CASE, '2026-09-06T08:30:00'),
      existing('ev2', CASE, '2026-09-07T08:30:00'),
    ];
    const events = [CD.gcalEvent(hearing('06/09/2026', '08:30'))];
    const rec = recorder(before);
    const r = await CD.calSync({ calendarId: 'cal1', events, send: rec.send });
    t.eq('one dropped', r.dropped, 1);
    const drop = rec.of('cd/calPatchEvent').find((c) => c.eventId === 'ev2');
    t.eq('title marked', drop.patch.summary.indexOf('בוטל: '), 0);
    t.eq('shows as free', drop.patch.transparency, 'transparent');
    t.eq('status is NOT set to cancelled', drop.patch.status, undefined);
    t.eq('no delete call was made', rec.calls.some((c) => /delete/i.test(c.type)), false);
  }

  // Migration: the duplicates the old scheme already created carry no cdSource
  // tag, but every UID it ever produced ends with @court-downloader.
  t.section('calendar: legacy untagged duplicates are absorbed');
  {
    const e = env();
    const CD = e.window.CD;
    const legacy = {
      id: 'old1',
      iCalUID: 'deadbeef@court-downloader',
      summary: '30638-12-25 זומר',
      start: { dateTime: '2026-09-06T08:30:00' },
      end: { dateTime: '2026-09-06T09:30:00' },
      // no extendedProperties at all — written before tagging existed
    };
    const rec = recorder([legacy]);
    const r = await CD.calSync({ calendarId: 'cal1', events: [CD.gcalEvent(hearing('13/09/2026', '08:30'))], send: rec.send });
    t.eq('the legacy event was reused', r.updated, 1);
    t.eq('no duplicate created', r.added, 0);
    t.eq('patched the legacy id', rec.of('cd/calPatchEvent')[0].eventId, 'old1');
  }

  t.section('calendar: a foreign event is never touched');
  {
    const e = env();
    const CD = e.window.CD;
    const foreign = {
      id: 'mine', iCalUID: 'whatever@google.com', summary: 'פגישה אישית',
      start: { dateTime: '2026-09-06T08:30:00' }, end: { dateTime: '2026-09-06T09:00:00' },
    };
    const rec = recorder([foreign]);
    const r = await CD.calSync({ calendarId: 'cal1', events: [CD.gcalEvent(hearing('06/09/2026', '08:30'))], send: rec.send });
    t.eq('imported alongside it', r.added, 1);
    t.eq('the personal event was left alone', r.updated + r.dropped, 0);
  }

  // Safety: matching is scoped per case, so another case's events can never be
  // marked dropped by a scrape that didn't cover them.
  t.section('calendar: reconciliation is scoped to one case');
  {
    const e = env();
    const CD = e.window.CD;
    const other = existing('ev-other', '11111-01-24', '2026-09-06T08:30:00');
    const rec = recorder([other]);
    const r = await CD.calSync({ calendarId: 'cal1', events: [CD.gcalEvent(hearing('06/09/2026', '08:30'))], send: rec.send });
    t.eq('other case not dropped', r.dropped, 0);
    t.eq('our hearing was added', r.added, 1);
    const list = rec.of('cd/calListEvents')[0];
    t.eq('query was scoped to our case', list.caseId, CASE);
  }

  t.section('calendar: events carry the ownership tags');
  {
    const e = env();
    const ev = e.window.CD.gcalEvent(hearing('06/09/2026', '08:30'));
    t.eq('source tag', ev.extendedProperties.private.cdSource, 'letz-hamishpat');
    t.eq('case tag', ev.extendedProperties.private.cdCase, CASE);
  }
}

module.exports = { run };
