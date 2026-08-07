// ics-builder.js — RFC 5545 iCalendar generator for court hearings.
//
// Produces VCALENDAR text that:
//   • carries a VTIMEZONE block for Asia/Jerusalem, so DTSTART values
//     reference a real TZID that Google Calendar / Outlook recognize.
//   • assigns each VEVENT a STABLE UID derived from caseId+date+time. Re-
//     importing the same calendar updates the existing event instead of
//     creating duplicates — this is the foundation for the planned Google
//     Calendar sync (calendar.events.import treats matching UIDs as upserts).
//   • escapes commas / semicolons / backslashes / newlines per RFC 5545 §3.3.11.
//
// Public surface (attached to window.CD):
//   CD.buildIcs(events, opts) → string   — one combined VCALENDAR.
//   CD.buildSingleIcs(event, opts) → string — same shape but one VEVENT.
//   CD.icsFilename(event) → string — sanitized "<caseId>_<date>_<time>.ics".
//
// Event input shape (all strings, all optional except date):
//   {
//     caseId:       '12345-01-25',
//     date:         '15/06/2026',  // DD/MM/YYYY
//     time:         '10:30',       // HH:MM, optional → all-day event if missing
//     court:        'בית משפט השלום ת"א',
//     judge:        'כבוד השופט פלוני',
//     caseName:     'פלוני נ\' אלמוני',
//     proceeding:   'תביעה אזרחית',
//     sittingType:  'קדם משפט',
//     userList:     'הרכב יחיד',
//     externalCase: '',
//     status:       'מתוכנן',
//   }

(function (root) {
  const CD = root.CD || (root.CD = {});

  const PRODID = '-//court_downloader chrome-extension//NetHaMishpat hearings//HE';
  const TZID = 'Asia/Jerusalem';

  // Fixed VTIMEZONE block. Captures Israel's current IDT/IST DST pattern.
  // Calendar clients use this purely for display alignment — the actual
  // offset rule lives in their own zoneinfo, but having a TZID makes them
  // treat DTSTART as local Israel time instead of floating.
  const VTIMEZONE = [
    'BEGIN:VTIMEZONE',
    'TZID:' + TZID,
    'X-LIC-LOCATION:' + TZID,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZNAME:IST',
    'TZOFFSETFROM:+0300',
    'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700101T000000',
    'TZNAME:IDT',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0300',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1FR',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ].join('\r\n');

  // RFC 5545 §3.3.11 — escape \, ; , , \n inside TEXT values.
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,');
  }

  // Line folding per RFC 5545 §3.1 — fold at >75 octets. We approximate by
  // chars (Hebrew is 2 bytes UTF-8, so we fold at 60 chars to stay safe).
  function fold(line) {
    if (line.length <= 60) return line;
    const out = [];
    let i = 0;
    while (i < line.length) {
      out.push((i === 0 ? '' : ' ') + line.slice(i, i + 60));
      i += 60;
    }
    return out.join('\r\n');
  }

  // Parse "DD/MM/YYYY" → { y, m, d }. Returns null on malformed input.
  function parseDate(s) {
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return { d: parseInt(m[1], 10), m: parseInt(m[2], 10), y: parseInt(m[3], 10) };
  }

  // Parse "HH:MM" → { h, min }. Returns null on malformed input.
  function parseTime(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return { h: parseInt(m[1], 10), min: parseInt(m[2], 10) };
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function dateStamp(d) {
    return d.y + pad2(d.m) + pad2(d.d);
  }

  function dateTimeStamp(d, t) {
    return dateStamp(d) + 'T' + pad2(t.h) + pad2(t.min) + '00';
  }

  // DTSTAMP must be UTC ("Z" suffix). We synthesize from the event date at
  // 00:00 local — the value is documentary only (when the calendar was
  // generated), not the event time itself. Using the event date keeps the
  // calendar deterministic across re-exports (no Date.now noise).
  function dtstamp(d) {
    return dateStamp(d) + 'T000000Z';
  }

  // Stable UID = djb2 hash of caseId+date+time. Collisions vanishingly
  // unlikely across one user's hearing set; same input → same UID across
  // re-exports → Google Calendar treats as the same event.
  function djb2(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
  }

  function uidFor(ev) {
    const key = (ev.caseId || '') + '|' + (ev.date || '') + '|' + (ev.time || '') + '|' + (ev.sittingType || '');
    return djb2(key) + '@court-downloader';
  }

  // Marks an event as one of ours, in extendedProperties.private.cdSource.
  // The Google sync matches on this (plus cdCase) rather than on the UID.
  const CAL_TAG = 'letz-hamishpat';
  // Legacy events — written before the sync reconciled — carry no tag, but every
  // UID this file has ever produced ends with this suffix. The sync uses it to
  // find and absorb the duplicates the old UID scheme left behind.
  const UID_SUFFIX = '@court-downloader';

  function summary(ev) {
    const parts = [];
    if (ev.sittingType) parts.push(ev.sittingType);
    if (ev.caseId) parts.push(ev.caseId);
    if (!parts.length && ev.caseName) parts.push(ev.caseName);
    return parts.join(' — ') || 'דיון';
  }

  function description(ev) {
    const lines = [];
    if (ev.caseName) lines.push('תיק: ' + ev.caseName);
    if (ev.judge) lines.push('שופט: ' + ev.judge);
    if (ev.proceeding) lines.push('הליך: ' + ev.proceeding);
    if (ev.userList) lines.push('גורם שיפוטי: ' + ev.userList);
    if (ev.externalCase) lines.push('תיק חיצוני: ' + ev.externalCase);
    if (ev.status) lines.push('סטטוס: ' + ev.status);
    return lines.join('\n');
  }

  // Build one VEVENT block. Returns null if the date is unparsable —
  // a hearing with no usable date can't be placed on a calendar.
  function buildVEvent(ev) {
    const d = parseDate(ev.date);
    if (!d) return null;
    const t = parseTime(ev.time);

    const lines = ['BEGIN:VEVENT'];
    lines.push('UID:' + uidFor(ev));
    lines.push('DTSTAMP:' + dtstamp(d));

    if (t) {
      // Real end time ("שעת סיום") when present and after the start; else +1h.
      const te = parseTime(ev.endTime);
      let endH, endMin;
      if (te && (te.h > t.h || (te.h === t.h && te.min > t.min))) { endH = te.h; endMin = te.min; }
      else { endH = t.h + 1; endMin = t.min; }
      const end = endH >= 24
        ? { y: d.y, m: d.m, d: d.d + 1, h: endH - 24, min: endMin }
        : { y: d.y, m: d.m, d: d.d, h: endH, min: endMin };
      lines.push('DTSTART;TZID=' + TZID + ':' + dateTimeStamp(d, t));
      lines.push('DTEND;TZID=' + TZID + ':' +
        dateStamp({ y: end.y, m: end.m, d: end.d }) + 'T' + pad2(end.h) + pad2(end.min) + '00');
    } else {
      // All-day event: VALUE=DATE per RFC 5545 §3.3.4. DTEND is the day after.
      const nextDay = new Date(Date.UTC(d.y, d.m - 1, d.d + 1));
      const endStamp = nextDay.getUTCFullYear() +
        pad2(nextDay.getUTCMonth() + 1) +
        pad2(nextDay.getUTCDate());
      lines.push('DTSTART;VALUE=DATE:' + dateStamp(d));
      lines.push('DTEND;VALUE=DATE:' + endStamp);
    }

    lines.push(fold('SUMMARY:' + esc(summary(ev))));
    const desc = description(ev);
    if (desc) lines.push(fold('DESCRIPTION:' + esc(desc)));
    if (ev.court) lines.push(fold('LOCATION:' + esc(ev.court)));
    if (ev.sittingType) lines.push(fold('CATEGORIES:' + esc(ev.sittingType)));
    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
    return lines.join('\r\n');
  }

  function buildIcs(events, opts) {
    opts = opts || {};
    const calName = opts.calName || 'דיונים — נט המשפט';
    const out = ['BEGIN:VCALENDAR'];
    out.push('VERSION:2.0');
    out.push('PRODID:' + PRODID);
    out.push('CALSCALE:GREGORIAN');
    out.push('METHOD:PUBLISH');
    out.push(fold('X-WR-CALNAME:' + esc(calName)));
    out.push('X-WR-TIMEZONE:' + TZID);
    out.push(VTIMEZONE);
    let skipped = 0;
    for (const ev of events) {
      const block = buildVEvent(ev);
      if (block) out.push(block);
      else skipped++;
    }
    out.push('END:VCALENDAR');
    if (skipped && opts.onSkipped) {
      try { opts.onSkipped(skipped); } catch (e) {}
    }
    return out.join('\r\n') + '\r\n';
  }

  function buildSingleIcs(event, opts) {
    return buildIcs([event], opts);
  }

  function sanitizeFilename(s, maxLen) {
    return String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen || 100);
  }

  function icsFilename(ev) {
    const parts = [];
    if (ev.caseId) parts.push(ev.caseId);
    if (ev.date) parts.push(ev.date.replace(/\//g, '-'));
    if (ev.time) parts.push(ev.time.replace(':', ''));
    return sanitizeFilename(parts.join('_') || 'hearing', 100) + '.ics';
  }

  // Resolve a single {placeholder} against a hearing.
  function fieldVal(ev, key) {
    switch (key) {
      case 'caseId': return ev.caseId;
      case 'caseName': return ev.caseName;
      case 'court': return ev.court;
      case 'judge': return ev.judge || ev.userList;
      case 'sittingType': return ev.sittingType;
      case 'proceeding': return ev.proceeding;
      case 'status': return ev.status;
      case 'date': return ev.date;
      case 'time': return ev.time;
      case 'externalCase': return ev.externalCase;
      case 'userList': return ev.userList;
      default: return '';
    }
  }
  // Expand a template like "{caseId} {caseName}" against a hearing, dropping
  // empty fields and collapsing whitespace. Returns '' for an empty template.
  function applyTemplate(tmpl, ev) {
    if (tmpl == null || tmpl === '') return '';
    return String(tmpl)
      .replace(/\{(\w+)\}/g, (m, k) => (fieldVal(ev, k) || ''))
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  const DEFAULT_FMT = {
    titleTemplate: '{caseId} {caseName}',
    locationTemplate: '{court}',
    descriptionTemplate: 'שופט: {judge}',
  };

  // Build a Google Calendar event resource for the events.import endpoint.
  // `fmt` (optional) supplies title/location/description templates; defaults
  // put the case number+name in the title, court in the location, judge in
  // the description. Carries the SAME stable iCalUID as the ICS export, so a
  // sync upserts (re-syncing updates instead of duplicating). Returns null
  // when the date is unusable.
  function gcalEvent(ev, fmt) {
    const d = parseDate(ev.date);
    if (!d) return null;
    const t = parseTime(ev.time);
    fmt = fmt || DEFAULT_FMT;
    const title = applyTemplate(fmt.titleTemplate != null ? fmt.titleTemplate : DEFAULT_FMT.titleTemplate, ev) || summary(ev);
    const loc = applyTemplate(fmt.locationTemplate != null ? fmt.locationTemplate : DEFAULT_FMT.locationTemplate, ev);
    const desc = applyTemplate(fmt.descriptionTemplate != null ? fmt.descriptionTemplate : DEFAULT_FMT.descriptionTemplate, ev);
    const out = {
      iCalUID: uidFor(ev),
      summary: title,
      status: 'confirmed',
      // Ownership tags. The UID alone can NOT identify a hearing across syncs:
      // it hashes the date/time/type, so a postponed hearing produces a new UID
      // and events.import creates a SECOND event instead of moving the first.
      // The sync reconciles on these tags instead — cdCase scopes the match to
      // one case, so a partial scrape can never disturb another case's events.
      extendedProperties: {
        private: {
          cdSource: CAL_TAG,
          cdCase: String(ev.caseId || ''),
        },
      },
    };
    if (desc) out.description = desc;
    if (loc) out.location = loc;

    if (t) {
      const startISO = d.y + '-' + pad2(d.m) + '-' + pad2(d.d) + 'T' + pad2(t.h) + ':' + pad2(t.min) + ':00';
      // Real end time ("שעת סיום") when present and after the start; else +1h.
      const te = parseTime(ev.endTime);
      let eh, emin, ey = d.y, em = d.m, ed = d.d;
      if (te && (te.h > t.h || (te.h === t.h && te.min > t.min))) { eh = te.h; emin = te.min; }
      else { eh = t.h + 1; emin = t.min; }
      if (eh >= 24) {
        eh -= 24;
        const nx = new Date(Date.UTC(d.y, d.m - 1, d.d + 1));
        ey = nx.getUTCFullYear(); em = nx.getUTCMonth() + 1; ed = nx.getUTCDate();
      }
      const endISO = ey + '-' + pad2(em) + '-' + pad2(ed) + 'T' + pad2(eh) + ':' + pad2(emin) + ':00';
      out.start = { dateTime: startISO, timeZone: TZID };
      out.end = { dateTime: endISO, timeZone: TZID };
    } else {
      const nx = new Date(Date.UTC(d.y, d.m - 1, d.d + 1));
      out.start = { date: d.y + '-' + pad2(d.m) + '-' + pad2(d.d) };
      out.end = { date: nx.getUTCFullYear() + '-' + pad2(nx.getUTCMonth() + 1) + '-' + pad2(nx.getUTCDate()) };
    }
    return out;
  }

  CD.buildIcs = buildIcs;
  CD.buildSingleIcs = buildSingleIcs;
  CD.icsFilename = icsFilename;
  CD.gcalEvent = gcalEvent;
  CD.CAL_TAG = CAL_TAG;
  CD.CAL_UID_SUFFIX = UID_SUFFIX;
})(typeof window !== 'undefined' ? window : self);
