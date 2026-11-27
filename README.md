# Open-Mic Karaoke Media Player

A two-window Electron app for the show laptop. It takes karaoke sign-ups live from **player-pool**: people register on their phones and pick a song from the songlist. Each sign-up is matched to its video on the drive, and the app runs the room's big screen. **Setting this up for the first time, or handing it to someone non-technical? Start with SETUP.md instead.**

How it fits together:

```
phones ──sign up──▶ player-pool (Render) ──thin link (WebSocket, POOL_KEY)──▶ this app ──▶ big screen
                         ▲    │                                                  │      (or teleprompter)
                         │    └──▶ /show-stage: logo + UP NEXT card              │
                         └──── call up · done · skip · reorder · reveal · started┘
host console (/gm) ─────┘   (Call up / Done hide there while this app is linked)
```

player-pool owns the line: who is in it, the order, the revealed numbers, and each singer's state. This app owns the media: which video plays for each singer, a hand-picked file, duplicate choices and trim marks. It also owns playback and call-ups, and it tells player-pool when each song actually starts, so player-pool's stage screen can follow along. Media never leaves this laptop.

## Run it

```
npm install
npm start
```

This needs Node 18+ and an internet connection for `npm install`. While connected to player-pool, the app keeps one outbound WebSocket open. Every 4.5 minutes it also sends a small health check, which stops the free Render instance from going idle and losing its line.

## First-time setup, inside the app

1. **Video library.** Choose the drive folder that holds your channel subfolders, then press Scan. The scan walks every subfolder, parses `Date^SongCode^Title and Artist.mp4`, and reports how many files it indexed and how many filenames it skipped. On later launches the saved folder is scanned by itself.
2. **Player Pool.** Paste the player-pool address (for example `https://player-pool.onrender.com`) and the `POOL_KEY` from the Render dashboard (Environment tab), then press Connect. The key is encrypted with the operating system's key store. On a computer without one, it is kept only until the app closes. The **link lamp** in the header shows the connection:

   | Lamp | Meaning |
   |---|---|
   | LINKED | Connected |
   | LINKING | Connecting |
   | OFFLINE | Retrying by itself |
   | BAD KEY | The key is wrong; fix it and press Connect |
   | DETACHED | player-pool restarted and lost its line (see below) |

3. **Standby image.** Pick a JPG or PNG. The playback window stretches it edge to edge regardless of aspect ratio. If you skip this, standby shows plain black.

The app remembers the folder, the address and key, the image, and the fade and interval settings.

## Before the slot

- Each phone sign-up appears in the queue within a second, already matched. **Ready** means a file was found. **No file** means the song isn't on the drive; use **Browse…** to pick one. **2 files** means the song was redownloaded, and the newer file is chosen by default.
- If a singer changes their song on their phone, their row updates. The new song is matched again, and the old trim marks are cleared.
- Click a row to load it in the preview. Scrub, then use "Set start here" and "Set end here". Songs without marks play from 0:00 and fade just before their natural end.
- Drag rows to reorder. A drag changes the order on player-pool itself, so the host console and the phones follow. The host can reorder from `/gm` too, and the change appears here.

## Running the show

- **Start show** puts every waiting singer's number on their phone and **calls up** the first singer.
- **Call-up and the interval.**
  - The singer's phone buzzes "Please go to the stage!" and counts down.
  - The big screen shows **UP NEXT · name · song** with the same countdown. The default is 20 s; the **Interval** box takes 0–120, and 0 means no countdown.
  - At zero the screen reads GET READY.
  - **Nothing starts by itself.** Press **Play** when the singer is at the mic, before zero if they're ready.
- **Play** starts the called singer's trimmed video. The button locks the instant you press it and unlocks only after playback confirms it started, so a double-click can't re-seek a running song. That confirmation is also sent to player-pool as the song's start (`karaoke:started`).
- **player-pool's stage screen.** When the videos can't go on the room's screen, the playback window goes on the teleprompter and the room watches player-pool's `/show-stage`. From the host console's Karaoke tab, **Segment logo** puts the uploaded karaoke logo up, and **Up next and countdown** makes each call-up from this app show UP NEXT · name · song with the same countdown. The card gives way to the logo the moment Play confirms, and comes back on a false start or a playback reload. Starts and stops are reconciled like the outbox: each line from the pool is checked against this laptop's state, and anything the link dropped is sent again (`startedPlan` in `renderer/reconcile.js`). A pool from before this feature sends no `startedAt`, and is left alone.
- **When a song ends**, by reaching its end mark, reaching its natural end, or by Emergency stop, the singer is marked done on player-pool and the next singer is called up at once.
- **Next singer.** It is the first waiting singer who has both a number and a video. Anyone ahead of them without one is passed over, marked in red, and the queue hint says why.
- **Skip no-show** takes two taps. It removes the called singer from player-pool's line (their phone can sign up again) and calls the next one. Skipped singers stay listed for the night.
- **Latecomers** sign up without a number. Slot them, then press **Reveal N new**, or the host reveals them from `/gm`. If the line ran dry, **Call _name_** resumes the show.
- **Emergency stop** runs the same fade as a natural ending and disables itself until the fade completes. If a song is stopped within 10 s of starting (a false start), the singer stays called up instead of being marked done.
- **Fade** takes 0.1 to 5 seconds and clamps anything outside that range. It applies to both the automatic fade and the emergency stop, and it persists across launches. A fade uses the value in effect when it begins.
- The state lamp mirrors the state machine: STANDBY, WAIT, PLAYING, FADING.

## When the network misbehaves

- **The link drops.** The show carries on from the last line this app saw: Play, Skip and Emergency stop all work. Changes this app owes player-pool (call-ups, finishes, removals) are kept and sent when the link returns. If the host called someone else in the meantime, that wins, and a banner says so.
- **player-pool restarts and loses its line.** This happens on a redeploy, or when the free tier goes idle. The link lamp shows DETACHED and the show continues from the last known line. When you're ready, **Use the new line** switches to the restarted pool. Click the lamp to bring the choice back.
- **The playback window reloads or closes.** "Reposition playback" brings it back. A reload during the interval restores the card and its countdown. A reload mid-song puts that singer back as called up; press Play to restart them.

## One monitor or two

With two displays, the playback window goes fullscreen on the second one. With one display (laptop prep), it opens as a movable 960×540 window instead, and "Show / hide playback" tucks it away while you scrub. Plug in the venue's projector, press "Reposition playback", and it jumps to the new display fullscreen.

The second display can be a teleprompter facing the singer rather than the room's screen. The room then watches player-pool's `/show-stage`, which shows the karaoke logo and the UP NEXT card (see "player-pool's stage screen" above).

## File locations

Prefs and the session file live in Electron's per-user data folder:

| OS | Folder |
|---|---|
| Windows | `%APPDATA%/open-mic-karaoke-player` |
| macOS | `~/Library/Application Support/open-mic-karaoke-player` |
| Linux | `~/.config/open-mic-karaoke-player` |

**Reset session** clears this laptop's file choices, trim marks and show progress. It does not touch the line on player-pool.

## Tests

```
npm test
```

The tests cover the reconcile logic and the link client, run against a fake thin link. If player-pool is checked out next to this repo, one test also checks drag-to-reorder against player-pool's own queue code.

## Project layout

```
main.js                  window placement, IPC relay, library scan, player-pool link
preload.js               the bridge both renderers use
lib/indexer.js           recursive scan + SongCode lookup table
lib/pool-link.js         the thin-link client (reconnect, wake-up, keep-alive, key check)
lib/store.js             prefs.json and session.json
renderer/reconcile.js    pure rules: merge the pool's line with local media, who's next
renderer/control.*       the operator's screen
renderer/playback.*      the room's screen
test/                    node:test suites
```
