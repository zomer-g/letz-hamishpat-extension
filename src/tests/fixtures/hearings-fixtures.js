// Fixtures for the hearings adapter (net-court-hearings.js). The adapter scrapes
// the VISIBLE AG-Grid by its Hebrew column headers, so the fixtures reproduce
// .ag-header-cell labels + .ag-center-cols-container rows. A separate builder
// makes the judge-day report page (court/judge selects + single date + report
// button).

const { esc } = require('./fixtures.js');

// columns: [{ label: 'שעת התחלה', cells: ['10:30', '11:00'] }]
// All columns must have the same number of cells (= row count).
// opts.caseBanner → a case-number header band (for single-case fallback caseId).
// opts.gridId (default 'SittingGrid'), opts.visible (default true).
function hearingsPage(opts) {
  opts = opts || {};
  const columns = opts.columns || [];
  const gridId = opts.gridId || 'SittingGrid';
  const rowCount = columns.length ? (columns[0].cells || []).length : 0;
  const hiddenStyle = opts.visible === false ? ' style="display:none"' : '';

  // opts.colIds  → emit col-id on headers AND cells (what the real AG-Grid does)
  // opts.cellOrder → render the row's cells in this column order, which is how
  //   AG-Grid actually behaves: DOM cell order need not match header order.
  const colId = (c, i) => (opts.colIds ? ' col-id="' + esc(c.colId || ('c' + i)) + '"' : '');
  const headerHtml = columns
    .map((c, i) => '<div role="columnheader" class="ag-header-cell"' + colId(c, i) + '>' + esc(c.label) + '</div>')
    .join('');

  const order = opts.cellOrder || columns.map((_c, i) => i);
  let rowsHtml = '';
  for (let r = 0; r < rowCount; r++) {
    const cells = order
      .map((ci) => {
        const c = columns[ci];
        const v = (c.cells || [])[r];
        return '<div role="gridcell"' + colId(c, ci) + '>' + esc(v == null ? '' : v) + '</div>';
      })
      .join('');
    rowsHtml += '<div role="row" row-index="' + r + '">' + cells + '</div>';
  }

  const banner = opts.caseBanner
    ? '<div class="CaseHeader">תיק ' + esc(opts.caseBanner) + ' — בית משפט השלום בתל אביב</div>'
    : '';

  return '<!DOCTYPE html><html><head><title>מועדי דיון - נט המשפט</title></head><body>' +
    banner +
    '<form action="/Ngcs.Web.Secured/Calendar/CalendarSittingCase.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="vs-token">' +
    '</form>' +
    '<div id="' + gridId + '"' + hiddenStyle + '><div class="ag-root-wrapper">' +
      '<div class="ag-header">' + headerHtml + '</div>' +
      '<div class="ag-center-cols-container">' + rowsHtml + '</div>' +
    '</div></div>' +
    '</body></html>';
}

// Judge-day report page: court + judge selects, a single date input, and the
// report button. Deliberately has NO ToDate field (that would make it the
// lawyer RANGE report, i.e. user mode).
function judgeReportPage(opts) {
  opts = opts || {};
  const court = opts.court || { value: 'C1', text: 'בית משפט השלום בתל אביב' };
  const judge = opts.judge || { value: 'J1', text: 'כבוד השופט פלוני' };
  return '<!DOCTYPE html><html><head><title>דיונים לשופט - נט המשפט</title></head><body>' +
    '<form action="/Ngcs.Web.Secured/Calendar/CalendarSittingJudge.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="vs-token">' +
      '<select id="_ctl2_ComboBoxCourt" name="_ctl2:ComboBoxCourt"><option value="">בחר</option>' +
        '<option value="' + esc(court.value) + '" selected>' + esc(court.text) + '</option></select>' +
      '<select id="_ctl2_ComboBoxJudge" name="_ctl2:ComboBoxJudge"><option value="">בחר</option>' +
        '<option value="' + esc(judge.value) + '" selected>' + esc(judge.text) + '</option></select>' +
      '<input type="text" id="_ctl2_NGCSWebCalendarFromDate" name="_ctl2:NGCSWebCalendarFromDate" value="">' +
      '<a id="_ctl2_makeReportUIButton" href="javascript:__doPostBack(\'_ctl2:makeReportUIButton\',\'\')">הצגת דו"ח</a>' +
    '</form>' +
    '<div id="SittingGrid" style="display:none"><div class="ag-root-wrapper"></div></div>' +
    '</body></html>';
}

// Lawyer/firm RANGE report (user mode): FromDate + ToDate + report button, and
// a visible hearings grid with a "מספר תיק" column (→ user mode).
function lawyerRangeReportPage(opts) {
  opts = opts || {};
  const columns = opts.columns || [
    { label: 'תאריך דיון', cells: ['15/06/2026'] },
    { label: 'שעת דיון', cells: ['10:30'] },
    { label: 'מספר תיק', cells: ['12345-06-26'] },
    { label: 'סוג דיון', cells: ['קדם משפט'] },
  ];
  const grid = hearingsPage({ columns: columns, gridId: 'ReportGrid' });
  // Inject the from/to date inputs + report button into the form.
  const extra =
    '<input type="text" id="_ctl0_FromDate" name="_ctl0:FromDate" value="">' +
    '<input type="text" id="_ctl0_ToDate" name="_ctl0:ToDate" value="">' +
    '<a id="_ctl0_makeReportUIButton" href="javascript:__doPostBack(\'_ctl0:btnRunReport\',\'\')">הצגת דו"ח</a>';
  return grid.replace('<input type="hidden" name="__VIEWSTATE" value="vs-token">',
    '<input type="hidden" name="__VIEWSTATE" value="vs-token">' + extra);
}

// Judge-day report RESULT page — what the server returns AFTER a report
// postback: the same court/judge/date/report controls PLUS an ArrayStore
// hidden input carrying the day's hearings as inline JSON (the way the real
// page feeds AG-Grid). `rows` is an array of raw store objects; [] renders an
// explicitly-empty store; `noStore: true` omits the store entirely (models a
// deployment where the grid loads via a secondary request).
// `viewState` lets tests verify that the background collector carries the
// fresh __VIEWSTATE of each response into the next request.
function judgeReportResultPage(opts) {
  opts = opts || {};
  const court = opts.court || { value: 'C1', text: 'בית משפט השלום בתל אביב' };
  const judges = opts.judges || [opts.judge || { value: 'J1', text: 'כהן דנה' }];
  const selectedJudge = opts.selectedJudge || (opts.judge && opts.judge.value) || '';
  const viewState = opts.viewState || 'vs-token';
  const storeHtml = opts.noStore ? '' :
    '<input type="hidden" name="ReportJudgeSittingsDayGridStore" value="' +
      esc(JSON.stringify(opts.rows || [])) + '">';
  const judgeOpts = judges.map((j) =>
    '<option value="' + esc(j.value) + '"' + (j.value === selectedJudge ? ' selected' : '') + '>' +
    esc(j.text) + '</option>').join('');
  return '<!DOCTYPE html><html><head><title>דיונים לשופט - נט המשפט</title></head><body>' +
    '<form action="/Ngcs.Web.Secured/Calendar/CalendarSittingJudge.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="' + esc(viewState) + '">' +
      '<input type="hidden" name="__EVENTVALIDATION" value="ev-token">' +
      storeHtml +
      '<select id="_ctl2_NGCSWebComboBoxCourt" name="_ctl2$NGCSWebComboBoxCourt"><option value="">בחר</option>' +
        '<option value="' + esc(court.value) + '" selected>' + esc(court.text) + '</option></select>' +
      '<select id="_ctl2_NGCSWebComboBoxJudge" name="_ctl2$NGCSWebComboBoxJudge"><option value="">בחר</option>' +
        judgeOpts + '</select>' +
      '<input type="text" id="_ctl2_NGCSWebCalendarFromDate" name="_ctl2$NGCSWebCalendarFromDate" value="">' +
      '<a id="_ctl2_makeReportUIButton" href="javascript:__doPostBack(\'_ctl2$makeReportUIButton\',\'\')">הצגת דו"ח</a>' +
    '</form>' +
    '</body></html>';
}

// The report LANDING page in its cascaded-combo state: courts listed, but the
// judge combo is EMPTY until a court is chosen (court change = postback).
function judgeReportLandingPage(opts) {
  opts = opts || {};
  const courts = opts.courts || [
    { value: 'C1', text: 'בית משפט השלום בתל אביב' },
    { value: 'C2', text: 'בית המשפט המחוזי בחיפה' },
  ];
  const courtOpts = courts.map((c) =>
    '<option value="' + esc(c.value) + '">' + esc(c.text) + '</option>').join('');
  return '<!DOCTYPE html><html><head><title>דיונים לשופט - נט המשפט</title></head><body>' +
    '<form action="/Ngcs.Web.Secured/Calendar/CalendarSittingJudge.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="vs-landing">' +
      '<select id="_ctl2_NGCSWebComboBoxCourt" name="_ctl2$NGCSWebComboBoxCourt" ' +
        'onchange="__doPostBack(\'_ctl2$NGCSWebComboBoxCourt\',\'\')">' +
        '<option value="" selected>בחר</option>' + courtOpts + '</select>' +
      '<select id="_ctl2_NGCSWebComboBoxJudge" name="_ctl2$NGCSWebComboBoxJudge"><option value="">בחר</option></select>' +
      '<input type="text" id="_ctl2_NGCSWebCalendarFromDate" name="_ctl2$NGCSWebCalendarFromDate" value="">' +
      '<a id="_ctl2_makeReportUIButton" href="javascript:__doPostBack(\'_ctl2$makeReportUIButton\',\'\')">הצגת דו"ח</a>' +
    '</form>' +
    '</body></html>';
}

// A minimal case page: header band with the case number, the court name and
// the judge (label/value pair) — where the case-judge chip mounts.
function casePage(opts) {
  opts = opts || {};
  const judge = opts.judge || 'כבוד השופטת דנה כהן';
  const court = opts.court || 'בית משפט השלום בתל אביב';
  const caseId = opts.caseId || '12345-06-26';
  return '<!DOCTYPE html><html><head><title>תיק - נט המשפט</title></head><body>' +
    '<form action="/Ngcs.Web.Secured/CaseFile/CaseDetails.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="vs-case">' +
    '</form>' +
    '<div class="CaseHeader">תיק ' + esc(caseId) + ' — ' + esc(court) + '</div>' +
    '<table><tr><td>שופט</td><td id="JudgeNameCell">' + esc(judge) + '</td></tr>' +
    '<tr><td>בית משפט</td><td>' + esc(court) + '</td></tr></table>' +
    '</body></html>';
}

const HEARINGS_CASE_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/Calendar/CalendarSittingCase.aspx';
const JUDGE_REPORT_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/Calendar/CalendarSittingJudge.aspx';
const LAWYER_REPORT_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/Reports/ReportLawyerSittingsQueryView.aspx';
const CASE_PAGE_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/CaseFile/CaseDetails.aspx';

module.exports = {
  hearingsPage, judgeReportPage, lawyerRangeReportPage,
  judgeReportResultPage, judgeReportLandingPage, casePage,
  HEARINGS_CASE_URL, JUDGE_REPORT_URL, LAWYER_REPORT_URL, CASE_PAGE_URL,
};
