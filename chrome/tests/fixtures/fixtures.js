// HTML fixture builders that reproduce the real Net HaMishpat page shapes the
// adapters parse: AG-Grid markup, the hidden <…ArrayStore> JSON input, the
// per-row __doPostBack anchors, and the protocols/hearings variants. Built as
// plain strings and handed to jsdom by the tests.

function attrJson(arr) {
  // The ArrayStore value is an HTML attribute, so quotes must be entity-encoded
  // exactly like ASP.NET emits them.
  return JSON.stringify(arr).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Decisions / generic documents list ─────────────────────────────────────
// opts:
//   rows:        [{ DocumentID, name, date, signer, idc }]
//   storeOrder:  indices into rows, the ORDER the ArrayStore holds (default 0..n)
//   displayRows: indices into rows, the ORDER the grid renders (default storeOrder)
//   sortColId:   header col-id carrying aria-sort (e.g. 'SignatureDate') or null
//   sortDir:     'ascending' | 'descending'
//   caseBanner:  case number string shown in a header band (for readCaseId)
//   gridId:      grid container id (default 'DecisionGrid')
//   storeName:   hidden input name (default '_ctl0:DecisionGridArrayStore')
//   anchors:     include per-row btnDocument anchors (default true)
//   anchorArg:   (row) => postback argument string (default `${DocumentID}&1`)
function decisionsPage(opts) {
  opts = opts || {};
  const rows = opts.rows || [];
  const storeOrder = opts.storeOrder || rows.map((_, i) => i);
  const displayRows = opts.displayRows || storeOrder;
  const gridId = opts.gridId || 'DecisionGrid';
  const storeName = opts.storeName || '_ctl0:DecisionGridArrayStore';
  const anchors = opts.anchors !== false;
  const anchorArg = opts.anchorArg || ((r) => r.DocumentID + '&' + (r.idc ? '1' : '0'));

  const store = storeOrder.map((i) => {
    const r = rows[i];
    return {
      DocumentID: r.DocumentID,
      DecisionDisplayName: r.name,
      SignatureDate: r.date,
      SignatureUserName: r.signer || '',
      IsIDCPublished: r.idc !== false,
    };
  });

  const headerCells =
    '<div role="columnheader" col-id="DecisionDisplayName" class="ag-header-cell">שם</div>' +
    '<div role="columnheader" col-id="SignatureDate" class="ag-header-cell"' +
      (opts.sortColId === 'SignatureDate' ? ' aria-sort="' + (opts.sortDir || 'ascending') + '"' : '') + '>תאריך חתימה</div>';

  let rowsHtml = '';
  displayRows.forEach((i, displayIdx) => {
    const r = rows[i];
    const anchor = anchors
      ? '<a href="javascript:__doPostBack(\'_ctl0:btnDocument\',\'' + esc(anchorArg(r)) + '\')">' + esc(r.name) + '</a>'
      : esc(r.name);
    rowsHtml +=
      '<div role="row" row-index="' + displayIdx + '">' +
        '<div role="gridcell" col-id="DecisionDisplayName">' + anchor + '</div>' +
        '<div role="gridcell" col-id="SignatureDate">' + esc(r.date) + '</div>' +
        '<div role="gridcell" col-id="download"><input type="checkbox"></div>' +
      '</div>';
  });

  const banner = opts.caseBanner
    ? '<div id="CaseLocator"><h1>תיק ' + esc(opts.caseBanner) + '</h1></div>'
    : '';

  return '<!DOCTYPE html><html><head><title>תיקית החלטות - נט המשפט</title></head><body>' +
    banner +
    '<form action="/Ngcs.Web.Secured/Decision/DecisionList.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="vs-token">' +
      '<input type="hidden" name="__EVENTVALIDATION" value="ev-token">' +
      '<input type="hidden" name="' + esc(storeName) + '" value="' + attrJson(store) + '">' +
      '<input type="hidden" name="_ctl0:documentListIDs" value="">' +
      '<input type="hidden" name="_ctl0:decisionSignatureDateIDs" value="">' +
      '<input type="submit" name="_ctl0:btnDownloadWordDocs" value="הורדת מסמכי Word">' +
    '</form>' +
    '<div id="' + gridId + '"><div class="ag-root-wrapper">' +
      '<div class="ag-header">' + headerCells + '</div>' +
      '<div class="ag-center-cols-container">' + rowsHtml + '</div>' +
    '</div></div>' +
    '</body></html>';
}

// ── Protocols screen (ProtocolFileViewer.aspx) ──────────────────────────────
// opts.rows: [{ DocumentID, TranscriptionOrderDocumentID, date, pages,
//               idc (protocol published), tIdc (transcript published) }]
function protocolsPage(opts) {
  opts = opts || {};
  const rows = opts.rows || [];
  const store = rows.map((r) => ({
    DocumentID: r.DocumentID,
    TranscriptionOrderDocumentID: r.TranscriptionOrderDocumentID || 0,
    SittingDateString: r.date,
    Pages: r.pages || '',
    IsIDCPublished: r.idc !== false,
    IsTranscriptionOrderIDCPublished: !!r.tIdc,
  }));

  let rowsHtml = '';
  rows.forEach((r, idx) => {
    const protoCell =
      '<div role="gridcell" col-id="ProtocolDocument">' +
        '<img onclick="__doPostBack(\'_ctl0:btnDocument\',\'' + r.DocumentID + '\')" src="protocol.png">' +
        '<input type="checkbox" onclick="onProtocolDocumentSelectionChanged(this.checked, ' + r.DocumentID + ')">' +
      '</div>';
    const transCell = r.TranscriptionOrderDocumentID
      ? '<div role="gridcell" col-id="TranscriptionlDocument">' +
          '<img onclick="__doPostBack(\'_ctl0:btnDocument\',\'' + r.TranscriptionOrderDocumentID + '\')" src="trans.png">' +
          '<input type="checkbox" onclick="onTranscriptionlDocumentSelectionChanged(this.checked, ' + r.TranscriptionOrderDocumentID + ')">' +
        '</div>'
      : '<div role="gridcell" col-id="TranscriptionlDocument"></div>';
    rowsHtml +=
      '<div role="row" row-index="' + idx + '">' +
        '<div role="gridcell" col-id="SittingDateString">' + esc(r.date) + '</div>' +
        '<div role="gridcell" col-id="Pages">' + esc(r.pages || '') + '</div>' +
        protoCell + transCell +
      '</div>';
  });

  return '<!DOCTYPE html><html><head><title>פרוטוקולים - נט המשפט</title></head><body>' +
    '<form action="/Ngcs.Web.Secured/Protocol/ProtocolFileViewer.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="vs-token">' +
      '<input type="hidden" name="_ctl0:CaseProtocolGridArrayStore" value="' + attrJson(store) + '">' +
      '<input type="hidden" name="_ctl0:protocolDocumentList" value="">' +
      '<input type="hidden" name="_ctl0:transcriptionOrderDocumentList" value="">' +
    '</form>' +
    '<div id="CaseProtocolGrid"><div class="ag-root-wrapper">' +
      '<div class="ag-header">' +
        '<div role="columnheader" col-id="SittingDateString" class="ag-header-cell">תאריך דיון</div>' +
        '<div role="columnheader" col-id="ProtocolDocument" class="ag-header-cell">פרוטוקול</div>' +
      '</div>' +
      '<div class="ag-center-cols-container">' + rowsHtml + '</div>' +
    '</div></div>' +
    '</body></html>';
}

// ── Paper-file (תיק נייר) documents grid — PresentDocument.aspx ─────────────
// This grid is the reason titleField excludes party fields: its store carries
// BOTH the document's own description (DocumentDesc: "עתירה", "החלטה") AND the
// submitting party (CasePartyDisplayName: "עותר 1"), plus a DocumentType used
// to default-skip administrative confirmations ("אישור על הגשת מסמך").
// opts.rows: [{ DocumentID, desc, type, party, date, idc }]
function paperFilePage(opts) {
  opts = opts || {};
  const rows = opts.rows || [];
  const gridId = opts.gridId || 'PresentDocumentGrid';
  const storeName = opts.storeName || '_ctl0:PresentDocumentGridArrayStore';

  const store = rows.map((r) => ({
    DocumentID: r.DocumentID,
    DocumentDesc: r.desc == null ? '' : r.desc,
    DocumentType: r.type == null ? '' : r.type,
    CasePartyDisplayName: r.party == null ? '' : r.party,
    PresentationDate: r.date,
    IsIDCPublished: r.idc !== false,
  }));

  let rowsHtml = '';
  rows.forEach((r, idx) => {
    const label = r.desc || r.type || '';
    const anchor = '<a href="javascript:__doPostBack(\'_ctl0:btnDocument\',\'' +
      esc(r.DocumentID + '&' + (r.idc !== false ? '1' : '0')) + '\')">' + esc(label) + '</a>';
    rowsHtml +=
      '<div role="row" row-index="' + idx + '">' +
        '<div role="gridcell" col-id="DocumentDesc">' + anchor + '</div>' +
        '<div role="gridcell" col-id="DocumentType">' + esc(r.type || '') + '</div>' +
        '<div role="gridcell" col-id="CasePartyDisplayName">' + esc(r.party || '') + '</div>' +
        '<div role="gridcell" col-id="PresentationDate">' + esc(r.date) + '</div>' +
      '</div>';
  });

  return '<!DOCTYPE html><html><head><title>תיק נייר - נט המשפט</title></head><body>' +
    '<form action="/Ngcs.Web.Secured/CaseFile/PresentDocument.aspx">' +
      '<input type="hidden" name="__VIEWSTATE" value="vs-token">' +
      '<input type="hidden" name="' + esc(storeName) + '" value="' + attrJson(store) + '">' +
      '<input type="hidden" name="_ctl0:documentListIDs" value="">' +
    '</form>' +
    '<div id="' + gridId + '"><div class="ag-root-wrapper">' +
      '<div class="ag-header">' +
        '<div role="columnheader" col-id="DocumentDesc" class="ag-header-cell">שם מסמך</div>' +
        '<div role="columnheader" col-id="DocumentType" class="ag-header-cell">סוג</div>' +
        '<div role="columnheader" col-id="CasePartyDisplayName" class="ag-header-cell">מגיש</div>' +
      '</div>' +
      '<div class="ag-center-cols-container">' + rowsHtml + '</div>' +
    '</div></div>' +
    '</body></html>';
}

const PROTOCOL_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/Protocol/ProtocolFileViewer.aspx';
const DECISIONS_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/Decision/DecisionList.aspx';
const PAPERFILE_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/CaseFile/PresentDocument.aspx';

module.exports = { decisionsPage, protocolsPage, paperFilePage, esc, attrJson, PROTOCOL_URL, DECISIONS_URL, PAPERFILE_URL };
