# Setup Guide: Open-Mic Karaoke System

This guide takes you from nothing to a working show. It assumes you have never written code. If you can install a program and follow exact instructions, you can do all of this. Plan for about 45 minutes the first time, and read each part fully before doing it.

The system has three parts:

1. **player-pool**, a website hosted on Render. Singers open it on their phones, search the songlist, and sign up for a song. The host also runs it from the host console (`/gm`): opening and closing sign-ups, and sorting the line.
2. **This app, on the show computer.** It connects to player-pool, receives every sign-up as it happens, matches each song to a video on the hard drive, and runs the show on two screens: your control panel and the big screen the room sees.
3. **The singers' phones.** When a singer is called, their phone buzzes "Please go to the stage!" and counts down with the big screen.

## What you need before starting

- The `open-mic-karaoke` folder from the zip file
- The address of your player-pool site (for example `https://player-pool.onrender.com`) and login access to its Render dashboard
- The hard drive with the karaoke videos
- The show computer (Windows or Mac), with internet during setup and during the show
- Optional: a JPG or PNG image for the big screen between sets

---

## Part 1: Get the player-pool key (about 5 minutes)

The app proves it is allowed to run the karaoke line with a secret called **POOL_KEY**. This is the same key the host console asks for.

1. Sign in at **dashboard.render.com** and open the **player-pool** service.
2. Open the **Environment** tab.
3. Find **POOL_KEY** and reveal its value. Copy it into a notes file and label it **POOL_KEY**.
4. Also copy the service's address from the top of the page (it ends in `.onrender.com`). Label it **Pool address**.

**Keep the key private.** Anyone with it can run the host console: draws, games, everything, not only karaoke. Don't put it on a poster or in a group chat.

---

## Part 2: Install the app on the show computer (about 15 minutes)

The app runs on Node.js, a free program that runs the app's code. You install it once.

### Windows

1. Go to **nodejs.org** and click the big green **LTS** download. Run the installer and click Next through everything; the defaults are correct.
2. Unzip the app: right-click the zip, **Extract All**, and put it somewhere permanent, like Documents. You get a folder named `open-mic-karaoke`.
3. Double-click **start-windows.bat** inside that folder. The first run downloads the app's components (a minute or two, needs internet). Then two windows open: the dark **Control Panel** and a black **Playback** window.
   - If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. That warning appears for any script Windows hasn't seen before.
   - If a firewall prompt appears, click **Allow**. The app only uses the network to talk to player-pool.

### Mac

1. Go to **nodejs.org**, download the **LTS** installer, and install with defaults.
2. Double-click the zip to unzip it and move the `open-mic-karaoke` folder to Documents.
3. Right-click **start-mac.command**, choose **Open**, then **Open** again. The right-click dance is only needed the first time; after that a normal double-click works. The first run downloads components, then the two windows open.

From now on, launching the app means double-clicking that same start file. **After you copy in a newer version of the app, launch it the same way.** The start file notices the update and downloads any new components.

---

## Part 3: One-time app setup (about 10 minutes)

Plug in the video hard drive first.

1. **Video library.** Click **Choose folder** and select the folder on the drive that *contains* the channel subfolders: the parent folder, not one channel. Click **Scan**. After a moment you get a summary like "43,660 videos indexed". A small number of "filenames skipped" is normal and fine. From now on the app re-scans this folder by itself every time it opens.
2. **Player Pool.** Paste your **Pool address** into the first box and your **POOL_KEY** into the second, then click **Connect**. The lamp in the top right, next to the state lamp, turns green and reads **LINKED**.
   - **BAD KEY** means the key was mistyped. Paste it again and click Connect.
   - **LINKING** for up to a minute is normal the first time in a while: the free Render plan sleeps when nobody uses it, and the app is waking it up.
3. **Standby image.** Click **Choose image** and pick your JPG or PNG. This fills the big screen edge to edge whenever nothing is playing. Skipping it gives you plain black, which is also fine.
4. Leave **Interval** at 20 seconds and **Fade** at 2 seconds for now.

The app remembers everything in this part. You will not do it again unless something changes.

**Do a dry run now, at home.**

1. Open the pool address on your phone, go to the **Karaoke** tab, and sign up for any song. If the tab isn't there, open the host console (the pool address followed by `/gm`), enter the POOL_KEY, go to **Karaoke**, and click **Open sign-ups**.
2. Your sign-up appears in the app's queue within a second. Click the row, use the preview to find where the song should start, and click **Set start here**. Find where it should end and click **Set end here**.
3. Click **Start show**. Your phone buzzes "Please go to the stage!" and counts down, and the Playback window shows your name, your song and the same countdown.
4. Click **Play**. Watch it start at your mark and fade out at your end mark.

That is the whole show, in miniature. Afterwards, clear your test sign-up from the host console (× on the row).

---

## Part 4: Every show day, before sign-ups open

1. **Start each day with a fresh line.** player-pool allows one song per singer, and yesterday's singers stay marked as done until the line is cleared. Either:
   - in the Render dashboard, open player-pool and click **Manual Deploy → Restart service** (or **Restart**) before doors. On the free plan a restart starts the line empty. Or:
   - in the host console's Karaoke tab, clear yesterday's rows with ×.
2. Plug in the video drive and the projector or second screen.
3. Double-click the start file. Check that the library summary shows your videos and the link lamp reads **LINKED**.
4. **Leave the app running and linked from the moment sign-ups open.** While it is linked, it keeps the free Render site awake. If the site goes to sleep during sign-ups, it loses the line.
5. Open sign-ups from the host console (`/gm`, Karaoke tab) when the event announces them.

**Don't change the player-pool code during the event days.** Render redeploys on every change, and a redeploy empties the line.

---

## Part 5: Prep while sign-ups come in

Each sign-up appears in the queue as it happens.

- **Ready** means the video is on the drive.
- **No file** means the song isn't on the drive. Click **Browse…** and pick the right file by hand. Until you do, that singer is skipped over when it's their turn (the red mark and the hint say so).
- **2 files** means the same song was downloaded twice. The newer one is pre-picked; change the date in the dropdown if you want the other.
- **JP lyrics** means the video's lyrics are Japanese only.
- Click each row and set its **start** and **end** marks in the preview. Songs you leave unmarked play from the beginning and fade out just before their natural end.
- **Drag rows** into the running order you want. The host console and the singers' phones follow the new order. The host can also reorder from the host console, and the queue here follows.

---

## Part 6: Running the show

The bottom strip of the Control Panel is the whole show.

- **Start show** (top of the queue) puts every singer's number on their phone and **calls up** the first singer.
- **Calling up a singer.**
  - Their phone buzzes "Please go to the stage!" and counts down.
  - The big screen shows **UP NEXT**, their name, their song, and the same countdown.
  - At zero the screen says **GET READY**.
  - **Nothing plays until you press Play.** Press it when the singer has the mic, even before zero.
- **Play** starts the song at its start mark. It **fades out by itself** at its end mark, the singer is marked done, and the next singer is called up straight away. Between songs your only job is pressing Play when the next singer is ready.
- **Interval** is how many seconds the countdown gives a singer to reach the stage, from 0 to 120. Set it to 0 for no countdown.
- **Skip no-show** is for when the called singer isn't in the room. Tap it twice: it takes them out of the line (their phone can sign up again, at the back) and calls the next singer.
- **Emergency stop** ends the current song with the same graceful fade; the room cannot tell it apart from a normal ending. If you stop a song within 10 seconds of starting it (wrong file, singer not ready), that singer stays called up. Press Play to restart them, or Skip.
- **Latecomers** sign up without a number. Drag them where they belong, then click **Reveal N new** so their phones show their place. If the line ran out, a **Call _name_** button appears in the bottom strip to continue.
- **Fade** takes any value from 0.1 to 5 seconds and can be changed between songs or mid-song. Type a number and press Enter. Anything outside the range snaps to the nearest limit.
- **The two lamps** in the top right always tell you where things stand. The link lamp (LINKED, LINKING, OFFLINE, BAD KEY, DETACHED) shows the connection to player-pool. The state lamp (STANDBY, WAIT, PLAYING, FADING) shows the show.
- Buttons gray out while their action is in flight, so double-clicks and jumpy mice cannot double-fire anything.

**The host console during the show.** While this app is linked, the host console shows "Show laptop linked" and hides its own **Call up** and **Done** buttons, so two people can't call two different singers. The host can still open and close sign-ups, reorder, remove and reveal. If the app's link drops, those buttons come back for the host.

**Screens.** With two displays connected, the Playback window goes fullscreen on the second one by itself. If it lands on the wrong screen, or you plugged the projector in after launching, click **Reposition playback**. On a single screen (prepping at home), Playback is a small movable window; **Show / hide playback** tucks it away while you work.

After the last singer, the big screen returns to your standby image. That's the night.

---

## Show-night checklist

1. Before doors, start a fresh line: restart player-pool from Render, or clear yesterday's rows in the host console.
2. Plug in the video drive and the projector or second screen.
3. Double-click the start file. Check that videos are indexed and the link lamp reads LINKED.
4. Keep the app running and linked while sign-ups are open.
5. Fix No file rows, set start and end marks, drag the order.
6. When the slot begins, click Start show.
7. Press Play when each called singer has the mic. Skip and Emergency stop cover everything that goes sideways.

---

## Troubleshooting

**"npm is not recognized" or "command not found" in a black window.** Node.js isn't installed, or the window opened before the install finished. Install Node.js from nodejs.org, close the window, and double-click the start file again.

**The link lamp says BAD KEY.** The POOL_KEY doesn't match the one on Render. Copy it again from the Render dashboard's Environment tab, paste it, and click Connect.

**The link lamp says LINKING or OFFLINE for a long time.** Check the venue internet: open the pool address in the computer's browser. The first connection after the site slept can take up to a minute. The app keeps retrying by itself, and the show keeps running from the last line it saw.

**The link lamp says DETACHED.** player-pool restarted and lost its line, usually because someone changed its code or it slept. The app keeps the last line it saw so the show can go on. Singers who haven't sung yet will need to sign up again. When you're ready, click **Use the new line** in the banner, or click the lamp to bring the banner back.

**"This install is missing a component."** The app was updated but its components weren't. Close the app and launch it with the start file, which downloads them.

**Nearly every row says No file.** Either the drive wasn't plugged in when the app scanned (plug it in and press Scan), or you chose a channel folder instead of the parent folder (Choose folder again, one level up, then Scan).

**A singer says they can't sign up: "one song per singer".** They already sang today, or yesterday's line was never cleared (see Part 4). The host can clear their Done row with × in the host console.

**The Playback window disappeared.** Someone closed it. Click **Reposition playback** and it comes back where it belongs. If it vanished mid-song, the singer stays called up; press Play to restart them.

**No sound during playback.** Check the computer's output device in the system volume settings, and the cable to the mixer. The app plays at full volume until the fade.

**Starting over.** The app keeps its settings and the current session in a small data folder. Deleting that folder resets the app to factory-fresh: `%APPDATA%\open-mic-karaoke-player` on Windows, `~/Library/Application Support/open-mic-karaoke-player` on Mac. **Reset session** in the app is easier: it clears this computer's file choices, trims and show progress, and leaves the line on player-pool alone.
