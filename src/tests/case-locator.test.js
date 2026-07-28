// Tests for shared/case-locator.js — the quick-open parser that turns a
// free-form "מספר תיק" string into serial + month + year parts.

const { loadShared } = require('./helpers/env.js');

function run(t) {
  const CD = loadShared(['shared/case-locator.js']);
  const P = CD.parseCaseLocator;

  t.section('case-locator: canonical + separator variants');
  {
    const expect = { serial: '39163', month: '07', year2: '22', year4: '2022', canonical: '39163-07-22' };
    for (const s of ['39163-07-22', '39163/07/22', '39163.07.22', '39163\\07\\22', '39163 07 22', '39163 - 07 - 22']) {
      const r = P(s);
      t.deepEq('parses "' + s + '"', r, expect);
    }
  }

  t.section('case-locator: single-digit month and 4-digit year');
  {
    t.deepEq('single-digit month padded', P('39163-7-22'),
      { serial: '39163', month: '07', year2: '22', year4: '2022', canonical: '39163-07-22' });
    t.deepEq('4-digit year → year2 derived', P('80819-05-2026'),
      { serial: '80819', month: '05', year2: '26', year4: '2026', canonical: '80819-05-26' });
    t.eq('12 is a valid month', P('123-12-24').month, '12');
  }

  t.section('case-locator: tolerant of a leading case-type prefix');
  {
    t.eq('prefix stripped, serial found', P('ת"א 39163-07-22').serial, '39163');
    t.eq('canonical from prefixed', P('תא 30638-12-25').canonical, '30638-12-25');
  }

  t.section('case-locator: rejects invalid / ambiguous input');
  {
    t.eq('no separators → null', P('3916322'), null);
    t.eq('month 0 → null', P('39163-00-22'), null);
    t.eq('month 13 → null', P('39163-13-22'), null);
    t.eq('empty → null', P(''), null);
    t.eq('null → null', P(null), null);
    t.eq('garbage → null', P('abc'), null);
  }

  t.section('case-locator: extracts from surrounding text');
  {
    t.eq('grabs the pattern mid-string', P('התיק שלי 12345-03-24 בבקשה').canonical, '12345-03-24');
  }
}

module.exports = { run };
