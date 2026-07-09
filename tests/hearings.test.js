// Tests for the hearings adapter (content/adapters/net-court-hearings.js):
// mode detection (case / user / judge / none), DOM-grid scraping into the CSV
// hearing shape, date/time splitting, and the date-range / judge-report drivers.

const { loadHearings } = require('./helpers/env.js');
const { decisionsPage, PROTOCOL_URL } = require('./fixtures/fixtures.js');
const {
  hearingsPage, judgeReportPage, lawyerRangeReportPage,
  HEARINGS_CASE_URL, JUDGE_REPORT_URL, LAWYER_REPORT_URL,
} = require('./fixtures/hearings-fixtures.js');

function run(t) {
  t.section('hearings: detectMode');
  {
    // Single-case "מועדי דיון" — no "מספר תיק" column → case mode.
    const caseCols = [
      { label: 'שעת התחלה', cells: ['10:30', '11:45'] },
      { label: 'סוג דיון', cells: ['קדם משפט', 'הוכחות'] },
    ];
    const c = loadHearings(hearingsPage({ columns: caseCols }), HEARINGS_CASE_URL);
    t.eq('case mode', c.adapter.detectMode(c.document), 'case');

    // Cross-case grid with "מספר תיק" → user mode.
    const userCols = caseCols.concat([{ label: 'מספר תיק', cells: ['111-01-26', '222-02-26'] }]);
    const u = loadHearings(hearingsPage({ columns: userCols }), HEARINGS_CASE_URL);
    t.eq('user mode (has מספר תיק column)', u.adapter.detectMode(u.document), 'user');

    // Judge-day report controls → judge mode.
    const j = loadHearings(judgeReportPage(), JUDGE_REPORT_URL);
    t.eq('judge mode', j.adapter.detectMode(j.document), 'judge');

    // Lawyer RANGE report (FromDate + ToDate) is user mode, NOT judge.
    const l = loadHearings(lawyerRangeReportPage(), LAWYER_REPORT_URL);
    t.eq('lawyer range report → user (not judge)', l.adapter.detectMode(l.document), 'user');

    // A hidden grid must not be detected.
    const hidden = loadHearings(hearingsPage({ columns: caseCols, visible: false }), HEARINGS_CASE_URL);
    t.eq('hidden grid → null', hidden.adapter.detectMode(hidden.document), null);

    // The protocols documents screen must NEVER be claimed as hearings.
    const proto = loadHearings(
      '<!DOCTYPE html><html><body><div role="grid"><div class="ag-header">' +
      '<div class="ag-header-cell">תאריך דיון</div></div>' +
      '<div col-id="ProtocolDocument"></div></div></body></html>', PROTOCOL_URL);
    t.eq('protocols screen → null', proto.adapter.detectMode(proto.document), null);
  }

  t.section('hearings: listAllHearings scrapes the grid into hearing rows');
  {
    const cols = [
      { label: 'תאריך', cells: ['15/06/2026', '16/06/2026'] },
      { label: 'שעת התחלה', cells: ['10:30', '09:00'] },
      { label: 'שעת סיום', cells: ['12:00', '10:15'] },
      { label: 'מספר תיק', cells: ['12345-06-26', '67890-06-26'] },
      { label: 'שם התיק', cells: ['פלוני נ׳ אלמוני', 'מדינה נ׳ פלוני'] },
      { label: 'סוג דיון', cells: ['קדם משפט', 'הוכחות'] },
      { label: 'בפני', cells: ['השופט א', 'השופט ב'] },
    ];
    const { adapter, document } = loadHearings(hearingsPage({ columns: cols }), HEARINGS_CASE_URL);
    const hs = adapter.listAllHearings(document);
    t.eq('hearing count', hs.length, 2);
    t.eq('date', hs[0].date, '15/06/2026');
    t.eq('start time', hs[0].time, '10:30');
    t.eq('end time', hs[0].endTime, '12:00');
    t.eq('caseId', hs[0].caseId, '12345-06-26');
    t.eq('caseName', hs[0].caseName, 'פלוני נ׳ אלמוני');
    t.eq('sittingType', hs[0].sittingType, 'קדם משפט');
    t.eq('judge (בפני)', hs[0].judge, 'השופט א');
  }

  t.section('hearings: csvRow shape matches CSV_HEADERS');
  {
    const { adapter } = loadHearings(hearingsPage({ columns: [{ label: 'שעת התחלה', cells: ['10:00'] }] }), HEARINGS_CASE_URL);
    const row = adapter.csvRow({
      court: 'בימ"ש השלום', judge: 'השופט א', date: '15/06/2026', time: '10:30',
      caseId: '1-2-3', proceeding: 'אזרחי', caseName: 'x נ׳ y', sittingType: 'קדם',
      userList: 'הרכב', externalCase: '', status: 'מתוכנן',
    });
    t.deepEq('row keys equal CSV_HEADERS', Object.keys(row), adapter.CSV_HEADERS);
    t.eq('court column', row['בית משפט'], 'בימ"ש השלום');
    t.eq('case column', row['מספר תיק'], '1-2-3');
  }

  t.section('hearings: hearingId is stable + content-derived');
  {
    const { adapter } = loadHearings(hearingsPage({ columns: [{ label: 'שעת התחלה', cells: ['10:00'] }] }), HEARINGS_CASE_URL);
    const h = { caseId: '12345-06-26', date: '15/06/2026', time: '10:30', sittingType: 'קדם משפט' };
    t.eq('same input → same id', adapter.hearingId(h, 0), adapter.hearingId(h, 9));
    t.ok('empty hearing falls back to row index', adapter.hearingId({}, 7) === 'row-7');
  }

  t.section('hearings: setDateRange writes the from/to inputs');
  {
    const { adapter, document } = loadHearings(lawyerRangeReportPage(), LAWYER_REPORT_URL);
    const res = adapter.setDateRange(document, '01/06/2026', '30/06/2026');
    t.ok('found from input', res.from === true);
    t.ok('found to input', res.to === true);
    t.eq('from value set', document.querySelector('input[name*="FromDate"]').value, '01/06/2026');
    t.eq('to value set', document.querySelector('input[name*="ToDate"]').value, '30/06/2026');
  }

  t.section('hearings: judgeContext reads the selected court + judge');
  {
    const { adapter, document } = loadHearings(
      judgeReportPage({ court: { value: 'C9', text: 'מחוזי חיפה' }, judge: { value: 'J9', text: 'השופטת כהן' } }),
      JUDGE_REPORT_URL);
    const ctx = adapter.judgeContext(document);
    t.eq('court name', ctx.courtName, 'מחוזי חיפה');
    t.eq('judge name', ctx.judgeName, 'השופטת כהן');
    t.eq('report target resolved', ctx.reportTarget, '_ctl2:makeReportUIButton');
    t.ok('has single date field', ctx.hasDate === true);
  }

  t.section('hearings: documents list page is NOT a hearings page');
  {
    const { adapter, document } = loadHearings(
      decisionsPage({ rows: [{ DocumentID: 1, name: 'x', date: '01/01/2026' }] }),
      'https://securesso.court.gov.il/Ngcs.Web.Secured/Decision/DecisionList.aspx');
    t.eq('decisions list → no hearings mode', adapter.detectMode(document), null);
  }
}

module.exports = { run };
