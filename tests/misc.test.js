// Misc invariant tests. The defense-mode slice rule is a pure rule mirrored
// from list-panel.js processOne() (which can't be loaded standalone — it needs
// JSZip/jsPDF/fetch). Kept as an executable spec of the intended behavior.

function run(t) {
  t.section('defense mode: first+last page slice');
  function defenseSlice(images, defense) {
    if (defense && images.length > 2) return [images[0], images[images.length - 1]];
    return images;
  }
  {
    const out = defenseSlice(['a', 'b', 'c', 'd', 'e'], true);
    t.eq('5 pages → 2', out.length, 2);
    t.eq('keeps first', out[0], 'a');
    t.eq('keeps last', out[1], 'e');
  }
  t.eq('2 pages unchanged', defenseSlice(['a', 'b'], true).length, 2);
  t.eq('1 page unchanged', defenseSlice(['a'], true).length, 1);
  t.eq('defense off → full', defenseSlice(['a', 'b', 'c'], false).length, 3);
}

module.exports = { run };
