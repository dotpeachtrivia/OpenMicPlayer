'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// One preload serves both windows. The control panel uses `api`,
// the playback window uses `playbackBridge`. Each ignores the other.

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  scanLibrary: (folder) => ipcRenderer.invoke('scan-library', folder),
  matchCodes: (codes) => ipcRenderer.invoke('match-codes', codes),
  fetchSheet: (url) => ipcRenderer.invoke('fetch-sheet', url),
  getPrefs: () => ipcRenderer.invoke('prefs-get'),
  setPrefs: (partial) => ipcRenderer.invoke('prefs-set', partial),
  loadSession: () => ipcRenderer.invoke('session-load'),
  saveSession: (data) => ipcRenderer.invoke('session-save', data),
  clearSession: () => ipcRenderer.invoke('session-clear'),
  toFileUrl: (p) => ipcRenderer.invoke('to-file-url', p),
  playbackCmd: (cmd) => ipcRenderer.send('playback-cmd', cmd),
  onPlaybackEvent: (cb) => ipcRenderer.on('playback-event', (_e, evt) => cb(evt)),
});

contextBridge.exposeInMainWorld('playbackBridge', {
  onCmd: (cb) => ipcRenderer.on('cmd', (_e, cmd) => cb(cmd)),
  sendEvent: (evt) => ipcRenderer.send('playback-event', evt),
});
