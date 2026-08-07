// cal-sync.js — reconciling sync of hearings into Google Calendar.
//
// WHY THIS EXISTS
// The old sync POSTed every hearing to calendar.events.import and relied on
// iCalUID to upsert. But the UID is a hash of caseId+date+time+sittingType —
// the event's CONTENT, not its identity. So:
//   • a postponed hearing hashed to a NEW UID → import created a second event
//     and left the original in place (the duplicate the user reported);
//   • the same hearing scraped from a view without a "סוג דיון" column hashed
//     differently again → duplicated with no real change at all.
// Net HaMishpat's hearing screens expose no sitting id (verified live: the
// מועדי דיון grid has no ArrayStore, only the visible columns), so identity has
// to be reconstructed at sync time rather than read off the row.
//
// WHAT IT DOES
// Every event we write is tagged extendedProperties.private.cdSource/cdCase.
// A sync lists OUR events for the cases it is about to write, matches them to
// the incoming hearings, then updates in place / inserts / marks as dropped.
// Matching is scoped per case AND to that case's date window, so a partial
// scrape can never disturb events it wasn't looking at.

(function (root) {
  const CD = root.CD = root.CD || {};

  const TAG = 'letz-hamishpat';
  const UID_SUFFIX = '@court-downloader';
  // Prefix put on the title of an event whose hearing no longer appears.
  // Deliberately NOT status:'cancelled' — for a non-recurring event Google
  // treats that as a delete and the event vanishes, which is the opposite of
  // "keep it, but show that it dropped".
  const DROPPED_PREFIX = 'בוטל: ';
  // Group key for hearings whose case number could not be read.
  const UNKEYED = '__cd_unkeyed__';

  // ── helpers ───────────────────────────────────────────────────────────────
  // "2026-09-06T08:30:00" | "2026-09-06" → sortable "2026-09-06T08:30"
  function startKey(gev) {
    const s = (gev && gev.start) || {};
    if (s.dateTime) return String(s.dateTime).slice(0, 16);
    if (s.date) return String(s.date) + 'T';
    return '';
  }
  function dayKey(gev) { return startKey(gev).slice(0, 10); }
  function caseOf(gev) {
    const p = gev && gev.extendedProperties && gev.extendedProperties.private;
    return (p && p.cdCase) || '';
  }
  function isOurs(gev) {
    const p = gev && gev.extendedProperties && gev.extendedProperties.private;
    if (p && p.cdSource === TAG) return true;
    // Legacy: written before tagging existed. Every UID this extension has ever
    // produced ends with the suffix, which is how the old duplicates get found
    // and absorbed instead of lingering forever.
    return typeof gev.iCalUID === 'string' && gev.iCalUID.endsWith(UID_SUFFIX);
  }
  function isDropped(gev) {
    return typeof gev.summary === 'string' && gev.summary.indexOf(DROPPED_PREFIX) === 0;
  }

  // ── matching ──────────────────────────────────────────────────────────────
  // Pair incoming hearings with the events already on the calendar for the SAME
  // case. Returns { updates:[{event, incoming}], inserts:[incoming], drops:[event] }.
  //
  // Passes, most certain first:
  //   1. same start date AND time      → unchanged, or only its details changed
  //   2. same date, different time     → time moved
  //   3. leftovers paired in date order → postponed (the whole point: one
  //      incoming + one stale existing become an UPDATE, not a second event)
  // Anything still unmatched is a genuine insert or a genuine drop.
  function matchCase(incoming, existing) {
    const inLeft = incoming.slice();
    const exLeft = existing.filter((e) => !isDropped(e)); // already-marked stay put
    const updates = [];

    function take(pred) {
      for (let i = inLeft.length - 1; i >= 0; i--) {
        const j = exLeft.findIndex((e) => pred(inLeft[i], e));
        if (j === -1) continue;
        updates.push({ event: exLeft[j], incoming: inLeft[i] });
        exLeft.splice(j, 1);
        inLeft.splice(i, 1);
      }
    }
    take((a, b) => startKey(a) && startKey(a) === startKey(b));
    take((a, b) => dayKey(a) && dayKey(a) === dayKey(b));

    // Pass 3 — pair what's left in chronological order. Only safe because both
    // lists are already scoped to one case.
    inLeft.sort((a, b) => (startKey(a) < startKey(b) ? -1 : 1));
    exLeft.sort((a, b) => (startKey(a) < startKey(b) ? -1 : 1));
    while (inLeft.length && exLeft.length) {
      updates.push({ event: exLeft.shift(), incoming: inLeft.shift() });
    }
    return { updates, inserts: inLeft, drops: exLeft };
  }

  // Fields we overwrite on an update. The event id and iCalUID are deliberately
  // left alone — that is what keeps the calendar entry the SAME entry, so a
  // postponement moves the existing event instead of spawning a new one.
  function patchFrom(incoming) {
    const p = {
      summary: incoming.summary,
      start: incoming.start,
      end: incoming.end,
      extendedProperties: incoming.extendedProperties,
    };
    p.description = incoming.description || '';
    p.location = incoming.location || '';
    // A previously-dropped hearing that came back should look normal again.
    p.transparency = 'opaque';
    return p;
  }
  function dropPatch(gev) {
    return {
      summary: DROPPED_PREFIX + String(gev.summary || 'דיון'),
      // Freed-up time, but still visible — the user asked not to lose anything.
      transparency: 'transparent',
    };
  }

  // ── orchestration ─────────────────────────────────────────────────────────
  // `send` is the content script's sendToSW. Returns counts for the status line.
  async function calSync(opts) {
    const calendarId = opts.calendarId;
    const events = (opts.events || []).filter(Boolean);
    const send = opts.send;
    const out = { added: 0, updated: 0, dropped: 0, failed: 0, errors: [] };
    if (!calendarId || !events.length) return out;

    const note = (e) => { out.failed++; if (out.errors.length < 3) out.errors.push(String(e).slice(0, 120)); };

    // Group by case. Hearings whose case number couldn't be read still get
    // reconciled — as ONE unkeyed group, matched against our own events in the
    // same date window. Blind-importing them instead is how a caseId that came
    // back empty (the hearings page put the case banner past the old 6000-char
    // scan limit) turned every sync into "3 added" all over again. Reconciling
    // without the case filter is still safe: it only ever touches events this
    // extension created, inside the window being synced.
    const byCase = new Map();
    for (const ev of events) {
      const c = caseOf(ev) || UNKEYED;
      if (!byCase.has(c)) byCase.set(c, []);
      byCase.get(c).push(ev);
    }

    for (const [caseId, incoming] of byCase) {
      let existing = [];
      try {
        // Window the query to this case's own dates (± a day for timezone
        // edges) so events outside what we just scraped are never candidates
        // for being marked dropped.
        const keys = incoming.map(startKey).filter(Boolean).sort();
        const r = await send({
          type: 'cd/calListEvents',
          calendarId,
          caseId: caseId === UNKEYED ? '' : caseId,
          timeMin: dayShift(keys[0], -1),
          timeMax: dayShift(keys[keys.length - 1], +1),
        });
        if (r && r.ok && Array.isArray(r.events)) existing = r.events.filter(isOurs).filter((e) => {
          if (caseId === UNKEYED) return true;   // no case to scope by; window + ownership only
          const c = caseOf(e);
          return c ? c === caseId : true;        // legacy events carry no case tag
        });
        else if (r && !r.ok) note(r.error || 'list failed');
      } catch (e) { note((e && e.message) || e); }

      const { updates, inserts, drops } = matchCase(incoming, existing);

      for (const u of updates) {
        try {
          const r = await send({ type: 'cd/calPatchEvent', calendarId, eventId: u.event.id, patch: patchFrom(u.incoming) });
          if (r && r.ok) out.updated++; else note((r && r.error) || 'patch failed');
        } catch (e) { note((e && e.message) || e); }
      }
      for (const ev of inserts) {
        try {
          const r = await send({ type: 'cd/calImportEvent', calendarId, event: ev });
          if (r && r.ok) out.added++; else note((r && r.error) || 'import failed');
        } catch (e) { note((e && e.message) || e); }
      }
      for (const gev of drops) {
        try {
          const r = await send({ type: 'cd/calPatchEvent', calendarId, eventId: gev.id, patch: dropPatch(gev) });
          if (r && r.ok) out.dropped++; else note((r && r.error) || 'drop failed');
        } catch (e) { note((e && e.message) || e); }
      }
    }

    return out;
  }

  // "2026-09-06T08:30" → RFC3339 bound n days away, for timeMin/timeMax.
  function dayShift(key, days) {
    const d = new Date((String(key || '').slice(0, 10) || '1970-01-01') + 'T00:00:00Z');
    if (isNaN(d.getTime())) return undefined;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // One phrasing for all three sync entry points. "עודכנו" is the number that
  // used to show up as fresh duplicates, so it is worth naming explicitly.
  function calSyncSummary(r) {
    const parts = [];
    if (r.added) parts.push(r.added + ' נוספו');
    if (r.updated) parts.push(r.updated + ' עודכנו');
    if (r.dropped) parts.push(r.dropped + ' סומנו כבוטלו');
    if (!parts.length) parts.push('אין שינוי');
    return 'סנכרון יומן: ' + parts.join(' · ') + (r.failed ? ' · ' + r.failed + ' נכשלו' : '');
  }

  CD.calSync = calSync;
  CD.calSyncSummary = calSyncSummary;
  CD.calMatchCase = matchCase;      // exported for tests
  CD.CAL_DROPPED_PREFIX = DROPPED_PREFIX;
})(typeof window !== 'undefined' ? window : self);
