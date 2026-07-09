// Tests for the documents adapter (content/adapters/net-court.js) — the core
// correctness surface: ArrayStore discovery, field mapping, the row→document
// mapping on sorted grids (the high-risk "wrong document downloads" path),
// postback-argument derivation, protocol parsing, native bulk request bodies,
// and caseId extraction.

const { loadNetCourt } = require('./helpers/env.js');
const { decisionsPage, protocolsPage, paperFilePage, PROTOCOL_URL, DECISIONS_URL, PAPERFILE_URL } = require('./fixtures/fixtures.js');

function run(t) {
  t.section('net-court: matches() gating');
  {
    const rows = [{ DocumentID: 1, name: 'א', date: '01/01/2026' }];
    const { adapter, document } = loadNetCourt(decisionsPage({ rows }), DECISIONS_URL);
    t.ok('matches a decisions list page', adapter.matches(document.location, document) === true);

    const empty = loadNetCourt('<!DOCTYPE html><html><body><div>no grid</div></body></html>', DECISIONS_URL);
    t.ok('does not match a page with no ArrayStore/grid', empty.adapter.matches(empty.document.location, empty.document) === false);
  }

  t.section('net-court: listAllItems field mapping');
  {
    const rows = [
      { DocumentID: 101, name: 'החלטה ראשונה', date: '01/01/2026', signer: 'השופט א' },
      { DocumentID: 102, name: 'החלטה שנייה', date: '02/01/2026', signer: 'השופט ב' },
    ];
    const { adapter, document } = loadNetCourt(decisionsPage({ rows }), DECISIONS_URL);
    const items = adapter.listAllItems(document);
    t.eq('item count', items.length, 2);
    t.eq('docId is DocumentID', items[0].docId, '101');
    t.eq('title from DisplayName', items[0].title, 'החלטה ראשונה');
    t.eq('date from SignatureDate', items[0].date, '01/01/2026');
    t.eq('signer from SignatureUserName', items[0].submittedBy, 'השופט א');
    t.eq('docType label from title', items[0].docType, 'החלטות');
  }

  t.section('net-court: paper-file (תיק נייר) title comes from the document, not the party');
  {
    // Regression for the "filenames used the submitting party" bug. The
    // PresentDocument store carries BOTH DocumentDesc (the document's own name)
    // and CasePartyDisplayName (who filed it, ending in DisplayName). The title
    // must be the document description; the party must land in submittedBy only.
    const rows = [
      { DocumentID: 201, desc: 'עתירה', type: 'עתירה', party: 'עותר 1', date: '01/01/2026' },
      { DocumentID: 202, desc: 'החלטה שניתנה ע"י לימור ביבי', type: 'החלטה', party: 'בית המשפט', date: '02/01/2026' },
    ];
    const { adapter, document } = loadNetCourt(paperFilePage({ rows }), PAPERFILE_URL);
    const items = adapter.listAllItems(document);
    t.eq('item count', items.length, 2);
    t.eq('title is the document description, NOT the party', items[0].title, 'עתירה');
    t.eq('party did NOT leak into the title', items[1].title, 'החלטה שניתנה ע"י לימור ביבי');
    t.eq('party is preserved in submittedBy', items[0].submittedBy, 'עותר 1');
    t.eq('docKind carries the DocumentType', items[0].docKind, 'עתירה');
    t.eq('docKind for the decision row', items[1].docKind, 'החלטה');
  }

  t.section('net-court: paper-file title falls back to DocumentType when Desc is empty');
  {
    // A confirmation row often has no free-text description — only its type
    // ("אישור על הגשת מסמך"). The title must fall back to the type, and docKind
    // must expose it so the panel can default-skip confirmations.
    const rows = [
      { DocumentID: 301, desc: '', type: 'אישור על הגשת מסמך', party: 'עו"ד פלוני', date: '03/01/2026' },
    ];
    const { adapter, document } = loadNetCourt(paperFilePage({ rows }), PAPERFILE_URL);
    const item = adapter.listAllItems(document)[0];
    t.eq('title falls back to DocumentType', item.title, 'אישור על הגשת מסמך');
    t.eq('docKind exposes the confirmation type', item.docKind, 'אישור על הגשת מסמך');
    // The panel's skip rule keys off docKind starting with "אישור".
    t.ok('docKind is detectable as a confirmation', /^\s*אישור/.test(item.docKind));
  }

  t.section('net-court: visibleRows row→item mapping on a DESCENDING-sorted grid');
  {
    // Store is ascending by date; grid renders DESCENDING (newest first). The
    // adapter must replicate the sort so the checkbox at display-row 0 maps to
    // the NEWEST document, not store[0].
    const rows = [
      { DocumentID: 101, name: 'ישן', date: '01/01/2026' },   // store idx 0
      { DocumentID: 102, name: 'אמצע', date: '02/01/2026' },  // store idx 1
      { DocumentID: 103, name: 'חדש', date: '03/01/2026' },   // store idx 2
    ];
    const html = decisionsPage({
      rows,
      storeOrder: [0, 1, 2],          // ascending in the store
      displayRows: [2, 1, 0],         // descending on screen
      sortColId: 'SignatureDate',
      sortDir: 'descending',
    });
    const { adapter, document } = loadNetCourt(html, DECISIONS_URL);
    const vr = adapter.visibleRows(document);
    t.eq('display row 0 → newest (103)', vr[0].item.docId, '103');
    t.eq('display row 1 → middle (102)', vr[1].item.docId, '102');
    t.eq('display row 2 → oldest (101)', vr[2].item.docId, '101');
  }

  t.section('net-court: visibleRows mapping on an ASCENDING-sorted grid');
  {
    const rows = [
      { DocumentID: 101, name: 'ישן', date: '01/01/2026' },
      { DocumentID: 102, name: 'אמצע', date: '02/01/2026' },
      { DocumentID: 103, name: 'חדש', date: '03/01/2026' },
    ];
    const html = decisionsPage({
      rows, storeOrder: [0, 1, 2], displayRows: [0, 1, 2],
      sortColId: 'SignatureDate', sortDir: 'ascending',
    });
    const { adapter, document } = loadNetCourt(html, DECISIONS_URL);
    const vr = adapter.visibleRows(document);
    t.eq('display row 0 → oldest (101)', vr[0].item.docId, '101');
    t.eq('display row 2 → newest (103)', vr[2].item.docId, '103');
  }

  t.section('net-court: postback argument derivation');
  {
    const rows = [{ DocumentID: 555, name: 'x', date: '01/01/2026', idc: true }];
    const { adapter, document } = loadNetCourt(decisionsPage({ rows }), DECISIONS_URL);
    const items = adapter.listAllItems(document);
    // The rendered anchor carries "555&1"; the derived arg must match it.
    t.eq('derived postbackArg matches rendered anchor', items[0].postbackArg, '555&1');
    t.eq('postbackTarget is btnDocument', items[0].postbackTarget, '_ctl0:btnDocument');
  }

  t.section('net-court: getDownloadRequest builds an ASP.NET postback body');
  {
    const rows = [{ DocumentID: 777, name: 'x', date: '01/01/2026', idc: true }];
    const { adapter, document } = loadNetCourt(decisionsPage({ rows }), DECISIONS_URL);
    const item = adapter.listAllItems(document)[0];
    const req = adapter.getDownloadRequest(item, document);
    t.eq('method POST', req.method, 'POST');
    t.ok('body carries __EVENTTARGET=btnDocument', /__EVENTTARGET=_ctl0%3AbtnDocument/.test(req.body));
    t.ok('body carries the doc arg 777&1', /__EVENTARGUMENT=777%261/.test(req.body));
    t.ok('body threads __VIEWSTATE', /__VIEWSTATE=vs-token/.test(req.body));
  }

  t.section('net-court: getNativeBulkRequest (Word) joins ids + dates');
  {
    const rows = [
      { DocumentID: 11, name: 'a', date: '01/01/2026' },
      { DocumentID: 22, name: 'b', date: '15/03/2026' },
    ];
    const { adapter, document } = loadNetCourt(decisionsPage({ rows }), DECISIONS_URL);
    const items = adapter.listAllItems(document);
    t.ok('screen supports Word download', adapter.supportsWordDownload(document) === true);
    const req = adapter.getNativeBulkRequest(items, document);
    t.ok('bulk request isBulk', req.isBulk === true);
    t.ok('documentListIDs = 11,22', /documentListIDs=11%2C22/.test(req.body));
    t.ok('targets btnDownloadWordDocs', /__EVENTTARGET=_ctl0%3AbtnDownloadWordDocs/.test(req.body));
  }

  t.section('net-court: readCaseId from the header banner');
  {
    const rows = [{ DocumentID: 1, name: 'x', date: '01/01/2026' }];
    const { adapter, document } = loadNetCourt(decisionsPage({ rows, caseBanner: '80819-05-26' }), DECISIONS_URL);
    t.eq('reads the case number', adapter.readCaseId(document), '80819-05-26');
  }

  // Regression: the favorites panel (and quick-locate strip / judge chip) render
  // OTHER case numbers into the page. On pages where the open case number isn't
  // in a header element (e.g. CaseDetails.aspx), readCaseId's body-text fallback
  // must NOT pick up those extension-injected numbers — otherwise currentCase()
  // returns a FAVORITE's id and the ⭐ toggle removes it instead of adding the
  // open case (the "adding a second favorite overwrites the first" bug).
  t.section('net-court: readCaseId ignores case numbers in the extension UI');
  {
    const html = '<!DOCTYPE html><html><body>' +
      // Inline-mode reality: our favorites panel is nested INSIDE the site's
      // header cell (which matches the [id*="CaseLocator"] banner selector). The
      // header's whole textContent therefore contains the favorite's number —
      // readCaseId must still NOT return it (per-text-node cd- exclusion).
      '<div id="_ctl0_Header_CaseLocatorHeaderUC2">' +
        '<div id="cd-fav-panel" class="cd-panel cd-fav"><span class="cd-fav__id">30638-12-25</span></div>' +
        '<div id="cd-caseopen-panel" class="cd-caseopen"><input placeholder="39163-07-22"></div>' +
      '</div>' +
      // the real open case number, deeper in the page
      '<div class="SomeCaseBody">פרטי התיק 39163-07-22 — עוד טקסט</div>' +
    '</body></html>';
    const { adapter, document } = loadNetCourt(html, DECISIONS_URL);
    t.eq('returns the open case, not a favorite nested in the header', adapter.readCaseId(document), '39163-07-22');
  }

  t.section('net-court: protocol screen parsing');
  {
    const rows = [
      { DocumentID: 900, TranscriptionOrderDocumentID: 950, date: '10/05/2026', pages: '12', idc: true, tIdc: true },
      { DocumentID: 901, TranscriptionOrderDocumentID: 0, date: '11/05/2026', pages: '4', idc: true, tIdc: false },
      { DocumentID: 902, TranscriptionOrderDocumentID: 960, date: '12/05/2026', pages: '8', idc: false, tIdc: true },
    ];
    const { adapter, document } = loadNetCourt(protocolsPage({ rows }), PROTOCOL_URL);
    t.ok('isProtocolScreen true', adapter.isProtocolScreen(document) === true);
    const items = adapter.listAllItems(document);
    // Row 0: protocol(900) + transcript(950). Row 1: protocol(901) only.
    // Row 2: protocol unpublished (idc:false) → skipped; transcript(960) kept.
    const ids = items.map((i) => i.docId).sort();
    t.deepEq('protocol+transcript items', ids, ['P_900', 'P_901', 'T_950', 'T_960'].sort());
    const proto900 = items.find((i) => i.docId === 'P_900');
    t.eq('protocol label', proto900.docType, 'פרוטוקול');
    t.eq('protocol wordId is DocumentID', proto900.wordId, 900);
    const trans950 = items.find((i) => i.docId === 'T_950');
    t.eq('transcript label', trans950.docType, 'תמליל');
    t.eq('transcript wordId is TranscriptionOrderDocumentID', trans950.wordId, 950);
  }

  t.section('net-court: protocol native bulk request uses two id&date lists');
  {
    const rows = [
      { DocumentID: 900, TranscriptionOrderDocumentID: 950, date: '10/05/2026', pages: '12', idc: true, tIdc: true },
    ];
    const { adapter, document } = loadNetCourt(protocolsPage({ rows }), PROTOCOL_URL);
    const items = adapter.listAllItems(document);
    const req = adapter.getNativeBulkRequest(items, document);
    // protocolDocumentList → "900&10/05/2026"; transcriptionOrderDocumentList → "950&10/05/2026"
    t.ok('protocol list has id&date', /protocolDocumentList=900%2610%2F05%2F2026/.test(req.body));
    t.ok('transcript list has id&date', /transcriptionOrderDocumentList=950%2610%2F05%2F2026/.test(req.body));
  }
}

module.exports = { run };
