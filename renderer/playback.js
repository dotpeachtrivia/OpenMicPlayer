'use strict';

// Playback window. Shows exactly one thing at a time: standby image,
// wait screen, or video. All decisions come from the control panel over
// IPC; this window only executes and reports back.
//
// Timing note: the end-point watcher and the fade completion run on
// setInterval/setTimeout, not requestAnimationFrame. rAF stops when the
// window is hidden, and this window can legally be hidden (single-monitor
// prep). The main process disables background throttling so these timers
// hold their rate. rAF is used only for the brightness ramp, which is
// invisible when hidden anyway.

const video = document.getElementById('video');
const standbyImg = document.getElementById('standby');
const waitName = document.getElementById('wait-name');

const CLAMP_MIN = 0.1;
const CLAMP_MAX = 5;
const WATCH_MS = 50;

let fadeDuration = 2; // updated live by set-fade; read at the moment a fade starts
let fading = false;
let watchTimer = null;
let fadeTimeout = null;
let fadeToken = 0; // invalidates a brightness ramp that outlived its fade
let currentEnd = null; // endSeconds for the playing song, null = play to natural end

let audioCtx = null;
let gainNode = null;

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaElementSource(video);
  gainNode = audioCtx.createGain();
  src.connect(gainNode).connect(audioCtx.destination);
}

function show(screen) {
  document.body.className = screen ? 'show-' + screen : '';
}

function stopWatch() {
  if (watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

function resetVideo() {
  stopWatch();
  if (fadeTimeout !== null) {
    clearTimeout(fadeTimeout);
    fadeTimeout = null;
  }
  fadeToken += 1;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.style.filter = '';
  if (gainNode) {
    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    gainNode.gain.value = 1;
  }
  fading = false;
  currentEnd = null;
}

function startFade() {
  // Guard: a fade already in motion ignores every further trigger,
  // automatic or manual. No hard cut, no restart.
  if (fading) return;
  fading = true;
  stopWatch();

  // "The value in effect at the moment a fade starts is the one used."
  const duration = Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, fadeDuration));

  playbackBridge.sendEvent({ type: 'fading' });

  ensureAudio();
  const t0 = audioCtx.currentTime;
  const current = Math.max(0.001, gainNode.gain.value);
  gainNode.gain.cancelScheduledValues(t0);
  gainNode.gain.setValueAtTime(current, t0);
  // Exponential tracks perceived loudness; a linear amplitude ramp sounds
  // like it collapses in the last moment.
  gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

  const token = ++fadeToken;
  const wallStart = performance.now();
  (function ramp() {
    if (token !== fadeToken) return;
    const p = Math.min(1, (performance.now() - wallStart) / (duration * 1000));
    video.style.filter = 'brightness(' + (1 - p).toFixed(3) + ')';
    if (p < 1) requestAnimationFrame(ramp);
  })();

  fadeTimeout = setTimeout(() => {
    fadeTimeout = null;
    resetVideo();
    show(''); // black until the control panel sends wait or standby
    playbackBridge.sendEvent({ type: 'faded' });
  }, duration * 1000);
}

function watchEndPoint() {
  stopWatch();
  watchTimer = setInterval(() => {
    if (fading) return;
    const end = currentEnd !== null ? currentEnd : video.duration;
    if (!Number.isFinite(end)) return;
    // fadeDuration is read fresh each tick, so a mid-song adjustment
    // still lands before this song's fade begins.
    if (video.currentTime >= end - fadeDuration) startFade();
  }, WATCH_MS);
}

function playSong(cmd) {
  resetVideo();
  show('video');
  currentEnd = typeof cmd.end === 'number' ? cmd.end : null;

  video.src = cmd.videoUrl;

  video.onloadedmetadata = () => {
    ensureAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    gainNode.gain.value = 1;
    const start = typeof cmd.start === 'number' ? cmd.start : 0;
    video.currentTime = Math.max(0, Math.min(start, Math.max(0, video.duration - 0.5)));
    video
      .play()
      .then(() => {
        playbackBridge.sendEvent({ type: 'started' });
        watchEndPoint();
      })
      .catch((err) => {
        playbackBridge.sendEvent({ type: 'error', message: 'Playback failed: ' + err.message });
        resetVideo();
        show('');
      });
  };

  video.onerror = () => {
    playbackBridge.sendEvent({ type: 'error', message: 'The video file failed to load or decode.' });
    resetVideo();
    show('');
  };

  // Safety net: if the file is shorter than the stored end point and the
  // watcher never fires, treat the natural end as an instant finish.
  video.onended = () => {
    if (fading) return;
    fading = true;
    stopWatch();
    playbackBridge.sendEvent({ type: 'fading' });
    resetVideo();
    show('');
    playbackBridge.sendEvent({ type: 'faded' });
  };
}

playbackBridge.onCmd((cmd) => {
  switch (cmd.type) {
    case 'set-fade':
      fadeDuration = cmd.seconds;
      break;
    case 'standby':
      resetVideo();
      if (cmd.imageUrl) {
        standbyImg.src = cmd.imageUrl;
        show('standby');
      } else {
        show(''); // no image supplied: plain black
      }
      break;
    case 'wait':
      resetVideo();
      waitName.textContent = cmd.name || '';
      show('wait');
      break;
    case 'play':
      playSong(cmd);
      break;
    case 'stop':
      // Emergency stop: same fade as a natural ending. Ignored while
      // already fading, and ignored when nothing is playing.
      if (document.body.className === 'show-video' && !video.paused) startFade();
      break;
  }
});
