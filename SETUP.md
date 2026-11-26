# Setup Guide: Open-Mic Karaoke System

This guide takes you from nothing to a working show. It assumes you have never written code. If you can install a program, use Google Forms, and follow exact instructions, you can do all of this. Plan for about an hour the first time, and read each part fully before doing it.

You are setting up two things that talk to each other through one Google Sheet:

1. **The sign-up side.** Singers find their song on the songlist website, tap a Sign up link, and submit a Google Form. Each submission becomes a row in a Google Sheet.
2. **The player side.** An app on the show computer reads those rows, matches each song to a video file on the hard drive, and runs the show on two screens: your control panel and the big screen the room sees.

## What you need before starting

- The `open-mic-karaoke` folder from the zip file
- A Google account (it will own the sign-up form and the sheet)
- Login access to the GitHub account that owns the `kara-song/songlist` repository
- The hard drive with the karaoke videos
- The show computer (Windows or Mac) with internet during setup
- Optional: a JPG or PNG image for the big screen between sets

---

## Part 1: Create the sign-up form (about 10 minutes)

1. Go to forms.google.com and click the blank form (the big + tile).
2. Click "Untitled form" and name it, for example, **Open Mic Sign-Up**.
3. The form starts with one empty question. Click it and set it up:
   - Question text: **Name**
   - Type: **Short answer**
   - Turn **Required** on
4. Click the circled + (Add question) on the floating toolbar and add:
   - Question text: **SongCode**
   - Type: **Short answer**
   - Turn **Required** on
5. Add one more:
   - Question text: **Title and Artist**
   - Type: **Short answer**
   - Required off is fine

**The question names matter.** The player app finds its data by these exact words. "Song Code" with a space also works, but names like "Track" or "YouTube ID" will break the connection. If you ever rename them, keep the words Name, SongCode, and Title in place.

6. Open the **Settings** tab at the top of the form editor. Under Responses:
   - **Collect email addresses**: set to **Do not collect**
   - **Limit to 1 response**: **off**

   Both of these force singers to sign in to Google if left on. A sign-in wall at the door loses singers, so check this twice.

7. Optional but nice: under Presentation, set the confirmation message to something like "You're on the list. See you at the mic."

---

## Part 2: Connect the form to a Sheet and publish it (about 5 minutes)

1. In the form editor, open the **Responses** tab and click **Link to Sheets**. Choose **Create a new spreadsheet** and click Create. A Google Sheet opens with a tab called **Form Responses 1** and headers: Timestamp, Name, SongCode, Title and Artist. (A different column order is fine.)
2. In that Sheet, open the menu: **File → Share → Publish to web**.
3. In the dialog that appears:
   - First dropdown: change "Entire Document" to **Form Responses 1**
   - Second dropdown: change "Web page" to **Comma-separated values (.csv)**
4. Click **Publish**, confirm, and **copy the link** it gives you.
5. Paste that link into a notes file. Label it **Registrant sheet link**. A correct link contains `pub?output=csv` near the end.

**The most common mistake in this whole guide happens here.** The green Share button gives a different link that ends in `/edit`. That one will not work in the app. Only the Publish to web link works.

One more thing: anyone holding the published link can read your singer list. Keep it in your notes, not on a poster.

---

## Part 3: Get the pre-filled link codes (about 5 minutes)

The Sign up links on the website need three codes from your form. Google generates them for you.

1. In the form editor, click the **three-dot menu** (top right) and choose **Get pre-filled link**. A preview of your form opens.
2. Fill it in exactly like this:
   - **Name**: leave empty
   - **SongCode**: type `TESTCODE123`
   - **Title and Artist**: type `TESTTITLE`
3. Click **Get link** (bottom of the page), then **COPY LINK**.
4. Paste it into your notes file. It looks like this:

   ```
   https://docs.google.com/forms/d/e/1FAIpQLSc...long-string.../viewform?usp=pp_url&entry.1234567890=TESTCODE123&entry.987654321=TESTTITLE
   ```

5. Pull three values out of it and label them in your notes:
   - **FORM ID**: everything between `/d/e/` and `/viewform`
   - **SongCode entry**: the `entry.` number that has `=TESTCODE123` after it
   - **Title entry**: the `entry.` number that has `=TESTTITLE` after it

   You typed two different test values precisely so you can tell the two entry numbers apart.

---

## Part 4: Add Sign up links to the songlist website (about 10 minutes)

This is the only step that touches code, and it is pure copy-paste. You will not need to read or understand any existing code.

1. In the `open-mic-karaoke` folder, open the `extras` folder, then open **signup-link-snippet.js** with a plain text editor (Windows: right-click, Open with, Notepad. Mac: open with TextEdit).
2. Near the top are three lines marked **CHANGE ME**. Replace the placeholder text between the quotes with your three values from Part 3. Keep the quote marks. Change nothing else.
3. Select the entire file (Ctrl+A on Windows, Cmd+A on Mac) and copy it.
4. In a browser, signed in to the GitHub account that owns the repository, go to **github.com/kara-song/songlist** and click **script.js**.
5. Click the **pencil icon** near the top right of the file ("Edit this file").
6. Scroll to the very bottom of the file. Click at the end of the last line, press Enter twice, and paste.
7. Click the green **Commit changes...** button, keep the defaults ("Commit directly to the main branch"), and click **Commit changes**.
8. Wait about a minute for the website to update, then open **kara-song.github.io/songlist** and hard-refresh it (Ctrl+Shift+R on Windows, Cmd+Shift+R on Mac).
9. Search for any song. Every result now shows a **Sign up** link under its Song Code. Click one: the form opens with the code and title already filled in. Type your own name and submit. This is your test registrant.
10. Open the Google Sheet and confirm your test row appeared.

If the links don't appear after a hard refresh, wait another minute and refresh again; the website takes a moment to rebuild after a commit. If they still don't appear, re-open script.js on GitHub and check that the block pasted cleanly at the bottom in one piece.

---

## Part 5: Install the player on the show computer (about 15 minutes)

The app runs on Node.js, a free program that runs the app's code. You install it once.

### Windows

1. Go to **nodejs.org** and click the big green **LTS** download. Run the installer and click Next through everything; the defaults are correct.
2. Unzip the app: right-click the zip, **Extract All**, and put it somewhere permanent, like Documents. You get a folder named `open-mic-karaoke`.
3. Double-click **start-windows.bat** inside that folder. The first run downloads the app's components (a minute or two, needs internet), then two windows open: the dark **Control Panel** and a black **Playback** window.
   - If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. That warning appears for any script Windows hasn't seen before.
   - If a firewall prompt appears, click **Allow**. The app only uses the network to read your Google Sheet.

### Mac

1. Go to **nodejs.org**, download the **LTS** installer, and install with defaults.
2. Double-click the zip to unzip it and move the `open-mic-karaoke` folder to Documents.
3. Right-click **start-mac.command**, choose **Open**, then **Open** again. (The right-click dance is only needed the first time; after that a normal double-click works.) The first run downloads components, then the two windows open.

From now on, launching the app means double-clicking that same start file.

---

## Part 6: One-time app setup (about 10 minutes)

Plug in the video hard drive first.

1. **Video library**: click **Choose folder** and select the folder on the drive that *contains* the channel subfolders (the parent folder, not one channel). Click **Scan**. After a moment you get a summary like "43,660 videos indexed". A small number of "filenames skipped" is normal and fine.
2. **Registrant sheet**: paste your Registrant sheet link from Part 2 and click **Load registrants**. Your test row from Part 4 appears in the queue.
3. **Standby image**: click **Choose image** and pick your JPG or PNG. This fills the big screen edge to edge whenever nothing is playing. Skipping it gives you plain black, which is also fine.
4. Leave the **Fade** box at 2 seconds for now.

The app remembers everything in this part. You will not do it again unless something changes.

**Do a dry run now, at home.** With your test row loaded: click the row, use the preview player to find where the song should start, click **Set start here**, find where it should end, click **Set end here**. Click **Finalize queue**, then **Play**. Watch it start at your mark, fade out at your end mark, and return to the name screen. That is the whole show, in miniature.

---

## Part 7: Before doors, every show night (prep)

1. **Load registrants.** Google's published link updates a few minutes behind the live sheet, so a singer who signed up 30 seconds ago may not show yet. Load once when you start prep, and load one final time a few minutes after you close sign-ups. Loading again keeps all the trim marks you've already set.
2. Fix the stragglers in the queue:
   - **No file** means the song isn't on the drive or the code has a typo. Click **Browse** on that row and pick the right file by hand. With a catalog slightly larger than the drive, expect a handful of these per night.
   - **2 files** means the same song was downloaded twice. The newer one is pre-picked; change the date in the dropdown if you want the other.
3. Click each row and set its **start** and **end** marks in the preview. Songs you leave unmarked play from the beginning and fade out just before their natural end.
4. **Drag rows** into the running order you want.
5. Delete any test rows from the Google Sheet (right-click the row number, Delete row), load registrants once more, then click **Finalize queue**. From here the order and marks are locked; the only change the night allows is skipping a no-show.

---

## Part 8: Running the show

The bottom strip of the Control Panel is the whole show:

- **Play** starts the next singer's song at its start mark. The big screen shows "Up next: NAME" until you press it, so you control the pacing, not the app.
- The song **fades out by itself** at its end mark and the screen moves to the next name. You do nothing between songs except press Play when the next singer is ready.
- **Emergency stop** ends the current song with the exact same graceful fade. The room cannot tell it apart from a normal ending.
- **Skip no-show** is for when the named singer isn't in the room. It crosses them off and calls the next one.
- The **Fade** box takes any value from 0.1 to 5 seconds and can be changed between songs or mid-song. Type a number and press Enter. Anything outside the range snaps to the nearest limit.
- The colored **lamp** in the top right always tells you the state: STANDBY, WAIT, PLAYING, FADING.
- Buttons gray out while their action is in flight, so double-clicks and jumpy mice cannot double-fire anything.

**Screens.** With two displays connected, the Playback window goes fullscreen on the second one by itself. If it lands on the wrong screen, or you plugged the projector in after launching, click **Reposition playback**. On a single screen (prepping at home), Playback is a small movable window; **Show / hide playback** tucks it away while you work.

After the last singer, the big screen returns to your standby image. That's the night.

---

## Show-night checklist

1. Plug in the video drive and the projector or second screen.
2. Double-click the start file.
3. Load registrants.
4. Fix No file rows, set start and end marks, drag the order.
5. Close sign-ups, wait a few minutes, load registrants one last time.
6. Finalize queue.
7. Press Play when each singer is ready. Emergency stop and Skip cover everything that goes sideways.

---

## Troubleshooting

**"npm is not recognized" or "command not found" in a black window.** Node.js isn't installed, or the window opened before the install finished. Install Node.js from nodejs.org, close the window, and double-click the start file again.

**Load registrants fails with an HTTP error or "Check that the sheet is published".** You pasted the `/edit` sharing link instead of the published one. Redo Part 2, steps 2 to 5, and use the link containing `pub?output=csv`.

**"Could not find the Name and SongCode columns."** The form questions were renamed. The error lists the headers it found. Rename the questions in the Google Form back to include Name and SongCode; the Sheet headers follow automatically.

**Nearly every row says No file.** Either the drive wasn't plugged in when you scanned (plug it in, press Scan again) or you chose a channel folder instead of the parent folder that contains all the channels (Choose folder again, one level up, then Scan).

**A singer's sign-up isn't showing.** The published link lags the live sheet by a few minutes. Wait, then press Load registrants again.

**The Playback window disappeared.** Someone closed it. Click **Reposition playback** and it comes back where it belongs. If it vanished mid-song, the app puts that singer back at the top; press Play to restart them.

**No sound during playback.** Check the computer's output device (system volume settings) and the cable to the mixer. The app plays at full volume until the fade.

**Sign up links missing from the website.** Hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R). Still missing after a minute: re-open script.js on GitHub and confirm the pasted block is intact at the bottom, with your three CHANGE ME values filled in between quotes.

**Starting over.** The app keeps its settings and the current event in a small data folder. Deleting that folder resets the app to factory-fresh. Windows: `%APPDATA%\open-mic-karaoke-player`. Mac: `~/Library/Application Support/open-mic-karaoke-player`. Discarding just the current event is easier: the **Discard session** button in the app.
