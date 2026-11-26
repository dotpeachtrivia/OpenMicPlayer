// Parses the published Google Sheet CSV into registrant rows.
//
// Handles quoted fields, embedded commas, embedded newlines, and doubled
// quotes per RFC 4180, because free-text names and song titles will
// contain all of those. Header mapping is tolerant: it normalizes each
// header (lowercase, strip everything but letters) and matches on
// keywords, so "Song Code", "SongCode", and "song_code" all resolve.

'use strict';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(h) {
  return String(h).toLowerCase().replace(/[^a-z]/g, '');
}

function findColumn(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    if (candidates.includes(headers[i])) return i;
  }
  return -1;
}

/**
 * @param {string} text raw CSV from the published sheet
 * @returns {{ ok: boolean, rows?: Array, error?: string }}
 *   rows: [{ timestamp, name, songCode, titleAndArtist }]
 */
function parseRegistrants(text) {
  // Published CSVs sometimes lead with a UTF-8 BOM; strip it so the
  // first header matches cleanly.
  text = String(text).replace(/^\uFEFF/, '');
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (grid.length < 2) {
    return { ok: false, error: 'The sheet has no registrant rows yet (header only, or empty).' };
  }

  const headers = grid[0].map(normalizeHeader);
  const cols = {
    timestamp: findColumn(headers, ['timestamp']),
    name: findColumn(headers, ['name', 'singername', 'yourname']),
    songCode: findColumn(headers, ['songcode', 'code']),
    titleAndArtist: findColumn(headers, ['titleandartist', 'titleartist', 'songtitleandartist', 'title', 'song']),
  };

  if (cols.songCode === -1 || cols.name === -1) {
    return {
      ok: false,
      error:
        'Could not find the Name and SongCode columns. Headers found: ' +
        grid[0].join(', ') +
        '. Rename the form fields so the headers contain "Name" and "SongCode".',
    };
  }

  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const get = (idx) => (idx >= 0 && idx < r.length ? r[idx].trim() : '');
    const entry = {
      timestamp: get(cols.timestamp),
      name: get(cols.name),
      songCode: get(cols.songCode),
      titleAndArtist: get(cols.titleAndArtist),
    };
    if (!entry.name && !entry.songCode) continue;
    rows.push(entry);
  }

  return { ok: true, rows };
}

module.exports = { parseCsv, parseRegistrants };
