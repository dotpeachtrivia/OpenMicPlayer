// Two files, two lifetimes.
//
// prefs.json    Standing app preferences that survive across nights:
//               fade duration, library path, sheet URL, standby image.
//               Read on launch so the app opens with last night's values.
//
// session.json  The per-event working state: registrant rows, trim marks,
//               queue order, finalized flag, playback pointer. Written on
//               every prep mutation so closing mid-prep loses nothing.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PREFS = {
  fadeDurationSeconds: 2,
  libraryPath: '',
  sheetUrl: '',
  standbyImagePath: '',
};

function makeStore(userDataDir) {
  const prefsPath = path.join(userDataDir, 'prefs.json');
  const sessionPath = path.join(userDataDir, 'session.json');

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    getPrefs() {
      return { ...DEFAULT_PREFS, ...readJson(prefsPath, {}) };
    },
    setPrefs(partial) {
      const next = { ...this.getPrefs(), ...partial };
      writeJson(prefsPath, next);
      return next;
    },
    loadSession() {
      return readJson(sessionPath, null);
    },
    saveSession(data) {
      writeJson(sessionPath, data);
    },
    clearSession() {
      try {
        fs.unlinkSync(sessionPath);
      } catch {
        /* already gone */
      }
    },
  };
}

module.exports = { makeStore, DEFAULT_PREFS };
