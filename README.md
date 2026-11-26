# Open-Mic Karaoke Media Player

Two-window Electron app that implements the Media Player half of the design doc. **Setting this up for the first time, or handing it to someone non-technical? Start with SETUP.md instead; it covers the Google Form, the Sheet, the website links, and this app, step by step.** The Queueing System (search page → pre-filled Google Form → Sheet) stays as designed; the only code it needs is `extras/signup-link-snippet.js`, which you paste into the songlist repo's `script.js`.

## Run it

```
npm install
npm start
```

Requires Node 18+ and an internet connection for the one-time `npm install`. After that the app only touches the network when you press "Load registrants".

## First-time setup, inside the app

1. **Video library.** Choose the drive folder that holds your channel subfolders, then press Scan. The scan walks every subfolder, parses `Date^SongCode^Title and Artist.mp4`, and reports how many files it indexed and how many filenames it skipped.
2. **Registrant sheet.** In Google Sheets: File → Share → Publish to web → CSV. Paste that link and press "Load registrants". The parser finds columns by header keywords, so name your form fields so the sheet headers contain "Name", "SongCode", and "TitleAndArtist".
3. **Standby image.** Pick a JPG or PNG. The playback window stretches it edge to edge regardless of aspect ratio, exactly as the doc specifies. Skip this and standby shows plain black.

The app remembers all three, plus the fade duration, in a prefs file. Next launch opens with last night's values.

## Prep

- Rows that match a file show **Ready**. Rows with no file show **No file** and a Browse button. Rows whose SongCode matched two files (a redownload) show a date picker, defaulting to the newer file.
- Click a row to load it in the preview. Scrub, then "Set start here" and "Set end here". Songs without marks play from 0:00 and fade before the natural end.
- Drag rows to reorder.
- **Finalize queue** locks everything and moves the show to Wait. Finalize enables only when every row has a file.

Every prep action writes to a session file on disk. Close the app mid-prep and it restores on the next launch, with a banner telling you it did. "Discard session" clears it for a new event.

## Live controls

- **Play** starts the next singer's trimmed video. The button locks the instant you press it and unlocks only after playback confirms it started, so a double-click can't re-seek a running song.
- **Emergency stop** runs the same fade as a natural ending and disables itself until the fade completes. Presses during a fade do nothing, by design.
- **Skip no-show** removes the next-up singer from the running order and calls the one after. That's the only change a finalized queue accepts.
- **Fade** takes 0.1 to 5 seconds, clamps anything outside that range, applies to both the automatic fade and the emergency stop, and persists across launches. The value at the moment a fade begins is the one that fade uses.
- The tally lamp in the header mirrors the state machine: STANDBY, WAIT, PLAYING, FADING.

## One monitor or two

With two displays the playback window goes fullscreen on the second one. With one display (laptop prep) it opens as a movable 960×540 window instead; "Show / hide playback" tucks it away while you scrub. Plug in the venue's projector, press "Reposition playback", and it jumps to the new display fullscreen.

## File locations

Prefs and the session file live in Electron's per-user data folder (`%APPDATA%/open-mic-karaoke-player` on Windows, `~/Library/Application Support/open-mic-karaoke-player` on macOS, `~/.config/open-mic-karaoke-player` on Linux).

## Packaging for show night

`npm start` from a terminal works fine for running the show. When you want a double-clickable app instead, add `electron-builder` as a dev dependency and run its default config; nothing in this codebase needs special build steps.

## Project layout

```
main.js                     window placement, IPC relay, sheet fetch, scan
preload.js                  the bridge both renderers use
lib/indexer.js              recursive scan + SongCode lookup table
lib/csv.js                  RFC 4180 parser + header mapping
lib/store.js                prefs.json and session.json
renderer/control.*          the operator's screen
renderer/playback.*         the room's screen
extras/signup-link-snippet.js  goes in the songlist repo, not this app
```
