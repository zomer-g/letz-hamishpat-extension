// Tests for shared/csv.js — RFC 4180-ish field escaping, the UTF-8 BOM (so
// Excel reads Hebrew), and CRLF line endings.

const { loadShared } = require('./helpers/env.js');

function run(t) {
  const CD = loadShared(['shared/csv.js']);

  t.section('csv: buildCsv structure');
  {
    const csv = CD.buildCsv(['a', 'b'], [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    t.ok('starts with UTF-8 BOM', csv.charCodeAt(0) === 0xFEFF);
    t.ok('uses CRLF', csv.indexOf('\r\n') !== -1);
    const body = csv.slice(1); // drop BOM
    t.ok('header row', body.indexOf('a,b\r\n') === 0);
    t.ok('contains data rows', /1,2\r\n3,4/.test(body));
  }

  t.section('csv: field escaping');
  {
    const csv = CD.buildCsv(['x'], [
      { x: 'has,comma' },
      { x: 'has"quote' },
      { x: 'has\nnewline' },
      { x: null },
      { x: undefined },
      { x: 'plain' },
    ]);
    t.ok('comma field quoted', csv.indexOf('"has,comma"') !== -1);
    t.ok('quote doubled + wrapped', csv.indexOf('"has""quote"') !== -1);
    t.ok('newline field quoted', csv.indexOf('"has\nnewline"') !== -1);
    t.ok('plain field unquoted', /(^|\r\n|,)plain(,|\r\n|$)/.test(csv));
  }

  t.section('csv: missing keys render empty');
  {
    const csv = CD.buildCsv(['a', 'b', 'c'], [{ a: '1' }]);
    t.ok('row with missing b,c → trailing commas', /1,,(\r\n|$)/.test(csv.slice(1)));
  }

  t.section('csv: INDEX_HEADERS present');
  {
    t.ok('INDEX_HEADERS is a non-empty array', Array.isArray(CD.INDEX_HEADERS) && CD.INDEX_HEADERS.length > 0);
  }
}

module.exports = { run };
