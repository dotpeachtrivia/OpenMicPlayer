// Scans the video library and builds a SongCode -> file lookup.
//
// Filenames follow:  Date^SongCode^Title and Artist.mp4
//   Date      6 digits, YYMMDD (yt-dlp download date)
//   SongCode  11-char YouTube video ID
//
// Videos live in subfolders named after the channel they were downloaded
// from, so the walk is recursive. The walk is async so a 40,000-file scan
// on a slow external drive never freezes the app. Files that don't parse
// are counted and skipped, never treated as fatal. Duplicate SongCodes
// (redownloads on a different date) are kept together, sorted newest-first,
// so the player can default to the newer file.

'use strict';

const fsp = require('fs/promises');
const path = require('path');

async function walk(rootDir, out, errors) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: dir, error: err.message });
      continue;
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        stack.push(full);
      } else if (item.isFile() && path.extname(item.name).toLowerCase() === '.mp4') {
        out.push(full);
      }
    }
  }
}

function parseFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split('^');
  if (parts.length < 3) return null;
  const date = parts[0].trim();
  const code = parts[1].trim();
  // Titles can legally contain '^', so everything past the second
  // delimiter belongs to the title.
  const titleAndArtist = parts.slice(2).join('^').trim();
  if (!code) return null;
  return { date, songCode: code, titleAndArtist, filePath };
}

/**
 * @param {string} rootDir library root (channel subfolders inside)
 * @returns {Promise<{ index: Object<string, Array>, stats: Object }>}
 *   index maps SongCode -> [{ date, songCode, titleAndArtist, filePath }],
 *   each list sorted by date descending (newest first).
 */
async function scanLibrary(rootDir) {
  const files = [];
  const errors = [];
  await walk(rootDir, files, errors);

  const index = Object.create(null);
  let skipped = 0;

  for (const filePath of files) {
    const parsed = parseFilename(filePath);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    if (!index[parsed.songCode]) index[parsed.songCode] = [];
    index[parsed.songCode].push(parsed);
  }

  let duplicates = 0;
  for (const code of Object.keys(index)) {
    const list = index[code];
    if (list.length > 1) {
      duplicates += 1;
      list.sort((a, b) => b.date.localeCompare(a.date));
    }
  }

  return {
    index,
    stats: {
      filesFound: files.length,
      parsed: files.length - skipped,
      skipped,
      uniqueCodes: Object.keys(index).length,
      duplicateCodes: duplicates,
      unreadableDirs: errors,
    },
  };
}

module.exports = { scanLibrary, parseFilename };
