// Gesture -> music mapping. Tracks each fingertip's x position across
// frames and fires a pluck whenever it sweeps across a string fast
// enough. Also derives brightness (avg tip height) and shimmer (both
// hands raised) and forwards them to the AudioEngine.

const STRING_COUNT = 7;
const PLUCK_SPEED_THRESHOLD = 0.25; // units/s
const PLUCK_COOLDOWN_MS = 90;
const EXCITE_DECAY_TAU = 1.1; // seconds
const SHIMMER_ATTACK_TAU = 0.5;
const SHIMMER_RELEASE_TAU = 1.5;
const PINCH_DAMP_THRESHOLD = 0.05;
const MAX_HANDS = 2;
const TIPS_PER_HAND = 5;

function stringX(i) {
  return 0.15 + 0.7 * (i / (STRING_COUNT - 1));
}

function nearestStringIndex(x) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < STRING_COUNT; i++) {
    const d = Math.abs(stringX(i) - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export class Interaction {
  constructor(audioEngine) {
    this.audio = audioEngine;
    this.strings = new Array(STRING_COUNT);
    for (let i = 0; i < STRING_COUNT; i++) {
      this.strings[i] = { x: stringX(i), freq: 220, excite: 0 };
    }
    this.shimmer = 0;

    // per (hand slot, fingertip) tracking: previous x, cooldown-until per string
    this._prevX = new Array(MAX_HANDS * TIPS_PER_HAND).fill(null);
    this._cooldown = new Array(MAX_HANDS * TIPS_PER_HAND * STRING_COUNT).fill(0);
  }

  setScale(name, freqs) {
    for (let i = 0; i < STRING_COUNT; i++) this.strings[i].freq = freqs[i];
    this.audio.setScale(name);
  }

  update(handsResult, dt) {
    const hands = (handsResult && handsResult.hands) || [];
    const plucks = [];

    // --- brightness: 1 - avg(tip.y) across all tips of all hands ---
    let tipYSum = 0, tipYCount = 0;

    for (let h = 0; h < hands.length && h < MAX_HANDS; h++) {
      const hand = hands[h];
      const tips = hand.tips;

      for (let ti = 0; ti < TIPS_PER_HAND; ti++) {
        const tip = tips[ti];
        tipYSum += tip.y;
        tipYCount++;

        const slot = h * TIPS_PER_HAND + ti;
        const prevX = this._prevX[slot];
        if (prevX !== null && dt > 0) {
          const dx = tip.x - prevX;
          const speed = Math.abs(dx) / dt;
          if (speed > PLUCK_SPEED_THRESHOLD) {
            // crossed a string this frame if any string's x lies between prevX and tip.x
            const lo = Math.min(prevX, tip.x), hi = Math.max(prevX, tip.x);
            for (let s = 0; s < STRING_COUNT; s++) {
              const sx = this.strings[s].x;
              if (sx >= lo && sx <= hi) {
                const cdIdx = slot * STRING_COUNT + s;
                const now = performance.now();
                if (now >= this._cooldown[cdIdx]) {
                  this._cooldown[cdIdx] = now + PLUCK_COOLDOWN_MS;
                  const vel = Math.max(0, Math.min(1, speed / 2.5));
                  this.audio.pluck(s, vel);
                  this.strings[s].excite = Math.min(1, this.strings[s].excite + vel);
                  plucks.push({ string: s, y: tip.y, vel });
                }
              }
            }
          }
        }
        this._prevX[slot] = tip.x;

        // pinch damp: nearest string to this fingertip
        if (hand.pinch < PINCH_DAMP_THRESHOLD) {
          this.audio.damp(nearestStringIndex(tip.x));
        }
      }
    }

    // clear stale tracking for hand slots that vanished
    for (let slot = hands.length * TIPS_PER_HAND; slot < MAX_HANDS * TIPS_PER_HAND; slot++) {
      this._prevX[slot] = null;
    }

    // --- decay excite ---
    const decay = Math.exp(-dt / EXCITE_DECAY_TAU);
    for (let i = 0; i < STRING_COUNT; i++) this.strings[i].excite *= decay;

    // --- brightness ---
    const brightness = tipYCount > 0 ? 1 - tipYSum / tipYCount : 0.5;
    this.audio.setBrightness(brightness);

    // --- shimmer: both hands present and both raised ---
    const bothRaised = hands.length >= 2 && hands.every((h) => h.raised);
    const target = bothRaised ? 1 : 0;
    const tau = bothRaised ? SHIMMER_ATTACK_TAU : SHIMMER_RELEASE_TAU;
    const alpha = 1 - Math.exp(-dt / tau);
    this.shimmer += (target - this.shimmer) * alpha;
    this.audio.setShimmer(this.shimmer);

    return {
      hands,
      strings: this.strings,
      shimmer: this.shimmer,
      plucks,
    };
  }
}
