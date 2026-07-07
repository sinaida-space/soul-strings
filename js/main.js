// SOUL_STRINGS — composition root. Wires UI chrome, camera/hand
// tracking (or mouse fallback), audio, interaction mapping, and the
// WebGL renderer into the live instrument.

import { UI } from './ui.js';
import { startCamera, initHands } from './hands.js';
import { AudioEngine } from './audio.js';
import { Interaction } from './interaction.js';
import { Renderer } from './render.js';
import { Recorder } from './recorder.js';
import { PointerHands } from './fallback.js';

const canvas = document.querySelector('#scene');
const camEl = document.querySelector('#cam');

const audio = new AudioEngine();
const interaction = new Interaction(audio);
const renderer = new Renderer(canvas);

let tracker = null; // {detect(nowMs)} — either the MediaPipe tracker or PointerHands
let mode = null; // 'live' | 'fallback'
let rafId = null;
let lastT = 0;

let recorder = null;
let shareUrl = null;

let hintTimer = null;

UI.init();
UI.setState('welcome');

function setHint(text, ms = 8000) {
  clearTimeout(hintTimer);
  UI.setHint(text);
  if (ms) {
    hintTimer = setTimeout(() => UI.setHint(''), ms);
  }
}

function queueHints(sequence) {
  let delay = 0;
  for (const { text, at } of sequence) {
    delay = at;
    setTimeout(() => setHint(text), delay);
  }
}

function stopLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function loop(t) {
  rafId = requestAnimationFrame(loop);
  const dt = lastT ? Math.min((t - lastT) / 1000, 1 / 15) : 1 / 60;
  lastT = t;
  const handsResult = tracker ? tracker.detect(t) : { hands: [] };
  const state = interaction.update(handsResult, dt);
  renderer.frame(t, dt, state);
}

function startLoop() {
  lastT = 0;
  stopLoop();
  rafId = requestAnimationFrame(loop);
}

async function enterLive() {
  try {
    await startCamera(camEl);
    tracker = await initHands(camEl);
    mode = 'live';
    UI.setState('live');
    startLoop();
    queueHints([
      { text: 'sweep your hands through the strings', at: 500 },
      { text: 'raise both hands to make the stars shimmer', at: 8500 },
      { text: '● REC captures 15 seconds to share', at: 17000 },
    ]);
  } catch (err) {
    console.warn('camera/hand-tracking unavailable, falling back to mouse mode', err);
    enterFallback('camera unavailable — mouse mode');
  }
}

function enterFallback(hint) {
  tracker = new PointerHands(canvas);
  mode = 'fallback';
  UI.setState('fallback');
  startLoop();
  setHint(hint || 'drag through the strings · hold near the top to shimmer');
}

window.addEventListener('soul:start', async () => {
  await audio.init();
  enterLive();
});

window.addEventListener('soul:fallback', async () => {
  await audio.init();
  enterFallback();
});

window.addEventListener('soul:scale', (e) => {
  audio.setScale(e.detail);
});

window.addEventListener('soul:rec-toggle', () => {
  if (!recorder) {
    recorder = new Recorder(canvas, audio.captureStream);
  }
  if (recorder.active) {
    recorder.stop();
    return;
  }
  recorder.start(
    (secondsLeft) => UI.setRec(true, secondsLeft),
    (blob, ext) => {
      UI.setRec(false);
      if (shareUrl) URL.revokeObjectURL(shareUrl);
      shareUrl = URL.createObjectURL(blob);
      recorder._lastBlob = blob;
      recorder._lastExt = ext;
      UI.showShareModal(shareUrl);
    }
  );
});

window.addEventListener('soul:share', async () => {
  if (!recorder || !recorder._lastBlob) return;
  const blob = recorder._lastBlob;
  const ext = recorder._lastExt || 'webm';
  const file = new File([blob], `soul-strings.${ext}`, { type: blob.type });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'SOUL STRINGS',
        text: 'played on soul strings — an instrument you play with bare hands',
        url: location.href,
      });
      return;
    } catch (err) {
      console.warn('share failed, falling back to download', err);
    }
  }

  const downloadLink = document.querySelector('#download-link');
  if (downloadLink) downloadLink.click();
});

document.addEventListener('visibilitychange', () => {
  if (!audio.ctx) return;
  if (document.hidden) {
    if (recorder && recorder.active) recorder.stop();
    audio.ctx.suspend();
  } else {
    audio.ctx.resume();
  }
});
