// "Sign up" links for the songlist search page (kara-song/songlist).
//
// HOW TO USE (no coding knowledge needed):
//   1. Fill in the three CHANGE ME lines below. SETUP.md Part 3 explains
//      where the values come from. Keep the quote marks.
//   2. Copy this ENTIRE file.
//   3. On GitHub, open script.js in the songlist repo, click the pencil
//      to edit, scroll to the very bottom, and paste this at the end.
//   4. Commit. Done.
//
// You do not need to find or understand any of the existing code. This
// block watches the results table on the page and adds a "Sign up" link
// under the Song Code of every row, including rows that appear later
// when someone searches. Clicking the link opens the Google Form with
// the song already filled in, so the singer only types their name.

(function () {
  // ---------- CHANGE ME: three values from your Google Form ----------
  var FORM_ID = 'PASTE_FORM_ID_HERE';        // long string between /d/e/ and /viewform
  var ENTRY_SONGCODE = 'entry.1111111111';   // the entry.number that carried TESTCODE123
  var ENTRY_TITLE = 'entry.2222222222';      // the entry.number that carried TESTTITLE
  // ---------- no changes needed below this line ----------

  function signupUrl(code, title) {
    var params = new URLSearchParams({ usp: 'pp_url' });
    params.set(ENTRY_SONGCODE, code);
    params.set(ENTRY_TITLE, title);
    return 'https://docs.google.com/forms/d/e/' + FORM_ID + '/viewform?' + params.toString();
  }

  // Find which columns hold the Song Code and the Title, by reading the
  // table headers. Falls back to the page's known layout
  // (Date | Title & Artist | Song Code) if the headers ever change.
  function columnIndexes(table) {
    var headers = table.querySelectorAll('th');
    if (!headers.length && table.rows.length) headers = table.rows[0].cells;
    var codeIdx = -1;
    var titleIdx = -1;
    for (var i = 0; i < headers.length; i++) {
      var t = (headers[i].textContent || '').toLowerCase();
      if (codeIdx === -1 && t.indexOf('code') !== -1) codeIdx = i;
      if (titleIdx === -1 && t.indexOf('title') !== -1) titleIdx = i;
    }
    if (codeIdx === -1) codeIdx = headers.length ? headers.length - 1 : 2;
    if (titleIdx === -1) titleIdx = 1;
    return { code: codeIdx, title: titleIdx };
  }

  // The code cell's own text, ignoring the link this script adds to it.
  function ownText(cell) {
    var t = '';
    for (var n = cell.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) t += n.textContent;
    }
    return t.trim();
  }

  function addLinkToRow(row, idx) {
    var cells = row.cells;
    if (!cells || cells.length <= Math.max(idx.code, idx.title)) return;
    var codeCell = cells[idx.code];
    var code = ownText(codeCell);
    var title = (cells[idx.title].textContent || '').trim();
    if (!code) return;

    var a = codeCell.querySelector('a.signup-link');
    if (a && a.dataset.code === code) return; // link already correct for this row

    if (!a) {
      a = document.createElement('a');
      a.className = 'signup-link';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Sign up';
      a.style.display = 'inline-block';
      a.style.marginTop = '4px';
      a.style.fontWeight = 'bold';
      a.addEventListener('click', function (ev) {
        ev.stopPropagation(); // don't trigger the row's play-on-click behavior
      });
      codeCell.appendChild(document.createElement('br'));
      codeCell.appendChild(a);
    }
    a.dataset.code = code;
    a.href = signupUrl(code, title);
  }

  function start() {
    var table = document.querySelector('table');
    if (!table) return;
    var idx = columnIndexes(table);

    function sweep() {
      var body = table.tBodies.length ? table.tBodies[0] : table;
      var rows = body.rows;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('th')) continue; // skip header rows
        addLinkToRow(rows[i], idx);
      }
    }

    sweep();
    // Re-run whenever the search rebuilds or filters the rows.
    new MutationObserver(sweep).observe(table, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
