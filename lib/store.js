// Two files, two lifetimes.
//
// prefs.json    Standing app preferences that survive across nights:
//               fade duration, between-songs interval, library path,
//               player-pool URL and (encrypted) key, standby image.
//               Read on launch so the app opens with last night's values.
//
// session.json  The per-event working state: the last player-pool line seen,
//               this laptop's media for each singer (file, trim marks), the
//               called-up singer, and commands still owed to the pool.
//               Written on every change so closing mid-show loses nothing.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PREFS = {
  fadeDurationSeconds: 2,
  intervalSeconds: 20, // the called-up singer's walk to the stage; 0 = no countdown
  libraryPath: '',
  poolUrl: '', // e.g. https://player-pool.onrender.com
  poolKeyEnc: '', // POOL_KEY, encrypted with safeStorage; never stored in plain text
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
