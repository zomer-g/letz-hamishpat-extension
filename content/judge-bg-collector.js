// judge-bg-collector.js — collects the "דיונים לשופט ליום דיונים" report over a
// date range in the BACKGROUND: instead of driving the page's own ASP.NET
// postback (form.submit → a FULL visible reload per day), each day is fetched
// with a same-origin POST that replays the exact postback body, and the
// returned HTML is parsed with DOMParser. The visible page never moves; the
// caller shows only a progress card.
//
// Exposed as CD.judgeBg with two entry points:
//
//   collectRange({seedDoc, seedUrl, days, onProgress, token, ...overrides})
//     Seed from a live judge-report page (the user already picked court+judge
//     on it). Iterates the days, carrying __VIEWSTATE forward from each
//     response into the next request.
//
//   collectFromCase({courtName, judgeName, days, onProgress, token, baseDoc, baseUrl})
//     Seed from ANY secured page (e.g. a case page that shows the judge +
//     court as text): fetches the report page, matches the court option by
//     name, replays the court-combo postback (the judge combo is CASCADED —
//     it populates only after a court is chosen), matches the judge option,
//     then runs the same day loop.
//
// Verification model: a fetched day is "verified" when the response embeds an
// ArrayStore (rows found) or an explicitly-empty store ("[]"). If a whole run
// produces ONLY structurally-valid-but-unverifiable empty pages, the collector
// returns ok:false/error:'unverified-empty' — the report data may load via a
// secondary request on this deployment — and the caller falls back to the
// visible (reload-based) flow. Never silently report 0 hearings on a gap.

(function (root) {
  const CD = root.CD || (root.CD = {});
  const w = root;

  const DEBUG_PREFIX = '[judge-bg]';
  function dbg() {
    try { console.log.apply(console, [DEBUG_PREFIX].concat(Array.from(arguments))); } catch (e) {}
  }

  function adapter() { return CD.adapters && CD.adapters['net-court-hearings']; }

  function parseHtml(html) {
    return new w.DOMParser().parseFromString(html, 'text/html');
  }

  // ---------- form serialization (browser-faithful) ----------
  // Everything a real submit would send: hidden inputs (__VIEWSTATE,
  // __EVENTVALIDATION, …), text inputs, SELECT values (court/judge combos),
  // checked radios/checkboxes. Buttons are excluded — an ASP.NET __doPostBack
  // posts the trigger via __EVENTTARGET, not as a button field.
  function serializeForm(doc) {
    const body = new URLSearchParams();
    const form = doc.forms && doc.forms[0];
    if (!form) return body;
    form.querySelectorAll('input, select, textarea').forEach((el) => {
      if (!el.name || el.disabled) return;
      const t = (el.type || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'image' || t === 'file' || t === 'reset') return;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) return;
      body.append(el.name, el.value == null ? '' : el.value);
    });
    return body;
  }

  function postbackBody(doc, eventTarget, extra) {
    const body = serializeForm(doc);
    body.set('__EVENTTARGET', eventTarget || '');
    body.set('__EVENTARGUMENT', '');
    if (extra) for (const k of Object.keys(extra)) body.set(k, extra[k]);
    return body;
  }

  function formActionUrl(doc, baseUrl) {
    const form = doc.forms && doc.forms[0];
    const action = (form && form.getAttribute('action')) || '';
    try { return new w.URL(action || baseUrl, baseUrl).href; } catch (e) { return baseUrl; }
  }

  async function postPostback(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return { doc: parseHtml(html), url: res.url || url };
  }

  async function fetchDoc(url) {
    const res = await fetch(url, { method: 'GET', credentials: 'include', redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return { doc: parseHtml(html), url: res.url || url };
  }

  // ---------- combo postback target ----------
  // The court combo auto-postbacks on change; its __EVENTTARGET is either in
  // an inline __doPostBack(...) handler or is simply the control's unique
  // name. (ASP.NET unique names use '$'; fall back to converting ':' → '$'.)
  function comboPostbackTarget(sel) {
    const src = (sel.getAttribute('onchange') || '') + ' ' + (sel.getAttribute('onclick') || '');
    const m = src.match(/__doPostBack\(['"]([^'"]+)['"]/);
    if (m) return m[1];
    return (sel.name || '').replace(/:/g, '$') || sel.name || '';
  }

  // ---------- name matching (court / judge shown as text vs combo options) ──
  // Judge honorifics and role prefixes that never appear consistently between
  // the case header ("בפני כבוד השופטת ...") and the combo ("כהן דנה").
  const NAME_NOISE = /(?:^|\s)(?:בפני|כבוד|כב'?|הש'?|השופטת|השופט|שופטת|שופט|הרשמת|הרשם|רשמת|רשם|הבכירה|הבכיר|בכירה|בכיר|סגנית|סגן|נשיאת|הנשיאה|הנשיא|נשיאה|נשיא|עמיתה|עמית|בדימוס|ד"ר|דר'?|פרופ'?)(?=\s|$)/g;

  function normJudge(s) {
    return String(s || '')
      .replace(/[״"”]/g, '"').replace(/[׳'’]/g, "'")
      .replace(NAME_NOISE, ' ')
      .replace(/["'.,()\-–]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normCourt(s) {
    return String(s || '')
      .replace(/[״"”]/g, '').replace(/[׳'’]/g, '')
      .replace(/בית\s*ה?משפט/g, 'בימש')
      .replace(/בית\s*ה?דין/g, 'ביד')
      .replace(/ביהמ"?ש/g, 'בימש')
      .replace(/מחוז\s+/g, '')
      .replace(/[.,()\-–]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) { return s ? s.split(' ').filter(Boolean) : []; }

  // Compare tokens ignoring a leading Hebrew locative "ב" / definite "ה", so the
  // case banner "…השלום בפתח תקווה" matches the report option "…השלום פתח תקווה"
  // ("בפתח" vs "פתח"), and "השלום" matches "שלום".
  function tokBase(t) { return t.length > 2 ? t.replace(/^[בה]/, '') : t; }

  // Score how well option text matches the wanted name: all tokens of the
  // SHORTER side must appear in the longer side (order-free — "דנה כהן" vs
  // "כהן דנה"). Score = number of shared tokens (ties broken by exact match).
  function nameScore(wantedNorm, optionNorm) {
    if (!wantedNorm || !optionNorm) return 0;
    if (wantedNorm === optionNorm) return 1000;
    const a = tokens(wantedNorm), b = tokens(optionNorm);
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    const longSet = {};
    long.forEach((t) => { longSet[t] = true; longSet[tokBase(t)] = true; });
    let shared = 0;
    for (const t of short) {
      if (longSet[t] || longSet[tokBase(t)]) shared++;
      else return 0; // every token of the shorter side must match
    }
    return shared;
  }

  // Best-matching <option> of a select for a display name, or null.
  function bestOption(sel, wantedName, normFn) {
    if (!sel || !wantedName) return null;
    const wanted = normFn(wantedName);
    let best = null, bestScore = 0, ambiguous = false;
    for (const o of Array.from(sel.options || [])) {
      const v = (o.value || '').trim();
      if (!v || v === '-1' || v === '0') continue;
      const score = nameScore(wanted, normFn(o.text));
      if (!score) continue;
      if (score > bestScore) { best = { value: v, text: (o.text || '').trim() }; bestScore = score; ambiguous = false; }
      else if (score === bestScore) ambiguous = true;
    }
    if (ambiguous) dbg('bestOption: ambiguous match for', wantedName);
    return ambiguous ? null : best;
  }

  // ---------- day extraction from a fetched report page ----------
  // rows: hearings of the day; verified: the data was genuinely embedded
  // (populated OR explicitly-empty store). null → the page no longer looks
  // like the report at all (session dropped, error page, redirect to login).
  function extractDay(doc) {
    const ad = adapter();
    if (!ad) return null;
    const rows = ad.listHearingsFromStore(doc);
    if (rows) return { rows: rows, verified: true };
    if (ad.hasEmptyHearingStore(doc)) return { rows: [], verified: true };
    const ctx = ad.judgeContext(doc);
    if (ctx && ctx.reportTarget && ctx.hasDate) return { rows: [], verified: false };
    return null;
  }

  // ---------- the day loop ----------
  // opts: {seedDoc, seedUrl, days, onProgress(iDone, n, collected), token,
  //        courtFieldName?, courtValue?, judgeFieldName?, judgeValue?}
  // The court/judge overrides re-assert the selection on EVERY postback — the
  // case-page flow needs them (its seed doc is a parsed page whose selects may
  // not echo the choice as `selected`); the panel flow serializes the live
  // document, so the user's own selection rides along naturally.
  async function collectRange(opts) {
    const ad = adapter();
    if (!ad) return { ok: false, error: 'adapter-missing', hearings: [] };
    const days = opts.days || [];
    if (!days.length) return { ok: false, error: 'no-days', hearings: [] };

    let cur = opts.seedDoc, curUrl = opts.seedUrl;
    const out = [];
    let verifiedDays = 0, unverifiedDays = 0;

    for (let i = 0; i < days.length; i++) {
      if (opts.token && opts.token.cancelled) {
        return { ok: false, cancelled: true, hearings: out, verifiedDays: verifiedDays, unverifiedDays: unverifiedDays };
      }
      const day = days[i];
      if (opts.onProgress) { try { opts.onProgress(i, days.length, out.length); } catch (e) {} }
      // Re-check after the progress callback — the cancel button fires while
      // we're between fetches, and the callback is its earliest observer.
      if (opts.token && opts.token.cancelled) {
        return { ok: false, cancelled: true, hearings: out, verifiedDays: verifiedDays, unverifiedDays: unverifiedDays };
      }

      const dateEl = ad.findSingleDateInput(cur);
      const target = ad.reportTargetName(cur);
      if (!dateEl || !dateEl.name || !target) {
        dbg('controls missing on day', day);
        return { ok: false, error: 'controls-missing', hearings: out, day: day };
      }
      const extra = {};
      extra[dateEl.name] = day;
      if (opts.courtFieldName && opts.courtValue) extra[opts.courtFieldName] = opts.courtValue;
      if (opts.judgeFieldName && opts.judgeValue) extra[opts.judgeFieldName] = opts.judgeValue;

      let r;
      try {
        r = await postPostback(formActionUrl(cur, curUrl), postbackBody(cur, target, extra));
      } catch (e) {
        dbg('fetch failed on day', day, e);
        return { ok: false, error: 'fetch-failed', detail: (e && e.message) || String(e), hearings: out, day: day };
      }
      cur = r.doc; curUrl = r.url;

      const ex = extractDay(cur);
      if (!ex) {
        dbg('page shape lost on day', day);
        return { ok: false, error: 'page-shape-lost', hearings: out, day: day };
      }
      if (ex.verified) verifiedDays++; else unverifiedDays++;
      for (const h of ex.rows) { if (!h.date) h.date = day; }
      out.push.apply(out, ex.rows);
    }

    if (opts.onProgress) { try { opts.onProgress(days.length, days.length, out.length); } catch (e) {} }

    // Zero verifiable signals across the whole range → we cannot tell "no
    // hearings" from "this deployment doesn't inline the data". Refuse, so the
    // caller falls back to the visible flow instead of reporting a false 0.
    if (!verifiedDays && unverifiedDays) {
      return { ok: false, error: 'unverified-empty', hearings: [], unverifiedDays: unverifiedDays };
    }
    return { ok: true, hearings: out, verifiedDays: verifiedDays, unverifiedDays: unverifiedDays };
  }

  // ---------- acquiring the report page (case-page flow) ----------
  const SECURED_REPORT_PATH = '/Ngcs.Web.Secured/Calendar/CalendarSittingJudge.aspx';

  // Menu link to "דיונים לשופט ליום דיונים" (btnJudgeDiscussion) on the
  // current page, if present — used when a direct GET doesn't land.
  function judgeMenuTarget(doc) {
    const anchors = doc.querySelectorAll('a[href*="__doPostBack"], a[onclick*="__doPostBack"], [onclick*="__doPostBack"]');
    for (const el of anchors) {
      const src = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
      if (/btnJudgeDiscussion/i.test(src)) {
        const m = src.match(/__doPostBack\(['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
    }
    for (const el of anchors) {
      if (/דיונים\s+לשופט/.test(el.textContent || '')) {
        const src = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
        const m = src.match(/__doPostBack\(['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
    }
    return '';
  }

  function looksLikeReportPage(doc) {
    const ad = adapter();
    if (!ad) return false;
    return !!(ad.findReportButton(doc) && ad.findSingleDateInput(doc) &&
      (ad.findCourtSelect(doc) || ad.findJudgeSelect(doc)));
  }

  async function acquireReportDoc(baseDoc, baseUrl) {
    const origin = (function () { try { return new w.URL(baseUrl).origin; } catch (e) { return ''; } })();
    // 1) Direct GET of the secured report page.
    if (origin) {
      try {
        const r = await fetchDoc(origin + SECURED_REPORT_PATH);
        if (looksLikeReportPage(r.doc)) return r;
        dbg('direct GET did not land on the report page');
      } catch (e) { dbg('direct GET failed', e); }
    }
    // 2) Replay the site's own menu postback from the current page.
    const menuTarget = judgeMenuTarget(baseDoc) || 'Header1$UpperMenu1$btnJudgeDiscussion';
    try {
      const r = await postPostback(formActionUrl(baseDoc, baseUrl), postbackBody(baseDoc, menuTarget));
      if (looksLikeReportPage(r.doc)) return r;
      dbg('menu postback did not land on the report page');
    } catch (e) { dbg('menu postback failed', e); }
    return null;
  }

  // ---------- case-page entry point ----------
  // opts: {courtName, judgeName, days, onProgress, token, baseDoc?, baseUrl?}
  async function collectFromCase(opts) {
    const ad = adapter();
    if (!ad) return { ok: false, error: 'adapter-missing', hearings: [] };
    const baseDoc = opts.baseDoc || w.document;
    const baseUrl = opts.baseUrl || (w.location && w.location.href) || '';

    const acq = await acquireReportDoc(baseDoc, baseUrl);
    if (!acq) return { ok: false, error: 'report-page-unreachable', hearings: [] };
    let doc = acq.doc, url = acq.url;

    const courtSel = ad.findCourtSelect(doc);
    if (!courtSel) return { ok: false, error: 'controls-missing', hearings: [] };

    const courtOpt = bestOption(courtSel, opts.courtName, normCourt);
    if (!courtOpt) return { ok: false, error: 'court-not-found', hearings: [], wanted: opts.courtName };

    // The judge combo is cascaded on court selection. If the fresh page's
    // judge combo doesn't already carry our judge, replay the court-change
    // postback and re-look in the response.
    let judgeSel = ad.findJudgeSelect(doc);
    let judgeOpt = judgeSel ? bestOption(judgeSel, opts.judgeName, normJudge) : null;
    if (!judgeOpt) {
      const extra = {};
      extra[courtSel.name] = courtOpt.value;
      let r;
      try {
        r = await postPostback(formActionUrl(doc, url), postbackBody(doc, comboPostbackTarget(courtSel), extra));
      } catch (e) {
        return { ok: false, error: 'fetch-failed', detail: (e && e.message) || String(e), hearings: [] };
      }
      doc = r.doc; url = r.url;
      judgeSel = ad.findJudgeSelect(doc);
      judgeOpt = judgeSel ? bestOption(judgeSel, opts.judgeName, normJudge) : null;
    }
    if (!judgeOpt) return { ok: false, error: 'judge-not-found', hearings: [], wanted: opts.judgeName, courtName: courtOpt.text };

    const courtField = (ad.findCourtSelect(doc) || courtSel).name;
    const res = await collectRange({
      seedDoc: doc, seedUrl: url, days: opts.days,
      onProgress: opts.onProgress, token: opts.token,
      courtFieldName: courtField, courtValue: courtOpt.value,
      judgeFieldName: judgeSel.name, judgeValue: judgeOpt.value,
    });
    res.judgeName = judgeOpt.text;
    res.courtName = courtOpt.text;
    return res;
  }

  CD.judgeBg = {
    collectRange: collectRange,
    collectFromCase: collectFromCase,
    // exposed for tests
    _normJudge: normJudge,
    _normCourt: normCourt,
    _bestOption: bestOption,
    _serializeForm: serializeForm,
    _extractDay: extractDay,
  };
})(typeof window !== 'undefined' ? window : self);
