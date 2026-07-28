// Tests for shared/ics-builder.js — calendar event generation (ICS + Google
// Calendar resource), RFC 5545 escaping, stable UIDs, template expansion, and
// all-day vs timed events.

const { loadShared } = require('./helpers/env.js');

function run(t) {
  const CD = loadShared(['shared/ics-builder.js']);

  t.section('ics-builder: gcalEvent end-time');
  {
    const g = CD.gcalEvent({ date: '10/06/2026', time: '10:30', endTime: '12:45', caseId: '1', caseName: 'x', court: 'y' }, {});
    t.eq('start', g.start.dateTime, '2026-06-10T10:30:00');
    t.eq('end uses real endTime', g.end.dateTime, '2026-06-10T12:45:00');
    t.eq('timeZone is Jerusalem', g.start.timeZone, 'Asia/Jerusalem');

    t.eq('fallback +1h when no end', CD.gcalEvent({ date: '10/06/2026', time: '10:30' }, {}).end.dateTime, '2026-06-10T11:30:00');
    t.eq('equal end ignored → +1h', CD.gcalEvent({ date: '10/06/2026', time: '10:30', endTime: '10:30' }, {}).end.dateTime, '2026-06-10T11:30:00');
    t.eq('earlier end ignored → +1h', CD.gcalEvent({ date: '10/06/2026', time: '10:30', endTime: '09:00' }, {}).end.dateTime, '2026-06-10T11:30:00');

    const roll = CD.gcalEvent({ date: '10/06/2026', time: '23:30' }, {});
    t.eq('rollover start', roll.start.dateTime, '2026-06-10T23:30:00');
    t.eq('rollover end day+1', roll.end.dateTime, '2026-06-11T00:30:00');
  }

  t.section('ics-builder: gcalEvent all-day when no time');
  {
    const g = CD.gcalEvent({ date: '10/06/2026', caseId: '1' }, {});
    t.eq('all-day start date', g.start.date, '2026-06-10');
    t.eq('all-day end date (day+1)', g.end.date, '2026-06-11');
    t.ok('no dateTime on all-day', g.start.dateTime === undefined);
  }

  t.section('ics-builder: gcalEvent returns null on unusable date');
  {
    t.ok('null for empty date', CD.gcalEvent({ caseId: '1' }, {}) === null);
    t.ok('null for malformed date', CD.gcalEvent({ date: 'not-a-date' }, {}) === null);
  }

  t.section('ics-builder: stable UID (upsert key)');
  {
    const a = CD.gcalEvent({ date: '10/06/2026', time: '10:30', sittingType: 'קדם', caseId: '111' }, {});
    const b = CD.gcalEvent({ date: '10/06/2026', time: '10:30', sittingType: 'קדם', caseId: '111', caseName: 'changed' }, {});
    t.eq('same key → same iCalUID', a.iCalUID, b.iCalUID);
    const c = CD.gcalEvent({ date: '11/06/2026', time: '10:30', sittingType: 'קדם', caseId: '111' }, {});
    t.ok('different date → different UID', a.iCalUID !== c.iCalUID);
    t.ok('UID is suffixed', /@court-downloader$/.test(a.iCalUID));
  }

  t.section('ics-builder: template expansion');
  {
    const ev = { date: '10/06/2026', time: '10:30', caseId: '111-01-26', caseName: 'פלוני נ׳ אלמוני', court: 'שלום ת"א', judge: 'השופט א' };
    const g = CD.gcalEvent(ev, { titleTemplate: '{caseId} {caseName}', locationTemplate: '{court}', descriptionTemplate: 'שופט: {judge}' });
    t.eq('title', g.summary, '111-01-26 פלוני נ׳ אלמוני');
    t.eq('location', g.location, 'שלום ת"א');
    t.eq('description', g.description, 'שופט: השופט א');

    // Empty fields drop out and whitespace collapses.
    const g2 = CD.gcalEvent({ date: '10/06/2026', time: '10:30', caseId: '111' }, { titleTemplate: '{caseId} {caseName}' });
    t.eq('empty field collapses', g2.summary, '111');
  }

  t.section('ics-builder: buildIcs / buildVEvent');
  {
    const ics = CD.buildIcs([{ date: '10/06/2026', time: '09:00', endTime: '11:15', caseId: '1' }], {});
    t.ok('has VCALENDAR', /BEGIN:VCALENDAR/.test(ics) && /END:VCALENDAR/.test(ics));
    t.ok('has VTIMEZONE Jerusalem', /TZID:Asia\/Jerusalem/.test(ics));
    t.ok('DTSTART present', /DTSTART;TZID=[^:]+:20260610T090000/.test(ics));
    t.ok('DTEND uses real end', /DTEND;TZID=[^:]+:20260610T111500/.test(ics));

    const ics2 = CD.buildIcs([{ date: '10/06/2026', time: '09:00', caseId: '1' }], {});
    t.ok('DTEND fallback +1h', /DTEND;TZID=[^:]+:20260610T100000/.test(ics2));

    const allDay = CD.buildIcs([{ date: '10/06/2026', caseId: '1' }], {});
    t.ok('all-day DTSTART;VALUE=DATE', /DTSTART;VALUE=DATE:20260610/.test(allDay));
  }

  t.section('ics-builder: RFC 5545 escaping');
  {
    const ics = CD.buildIcs([{ date: '10/06/2026', time: '09:00', caseId: '1', caseName: 'א, ב; ג', court: 'בית, משפט' }], {});
    t.ok('commas escaped in DESCRIPTION', /תיק: א\\, ב\\; ג/.test(ics));
    t.ok('commas escaped in LOCATION', /LOCATION:בית\\, משפט/.test(ics));
  }

  t.section('ics-builder: icsFilename sanitization');
  {
    t.eq('builds caseId_date_time', CD.icsFilename({ caseId: '111-01-26', date: '10/06/2026', time: '10:30' }), '111-01-26_10-06-2026_1030.ics');
    t.ok('no path separators leak', !/[\\/:*?"<>|]/.test(CD.icsFilename({ caseId: 'a/b:c', date: '10/06/2026' }).replace('.ics', '')));
  }
}

module.exports = { run };
