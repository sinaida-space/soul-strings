// Mouse/touch fallback "hands" — synthesizes the same detect() shape
// hands.js produces, so main.js can drive the same interaction/render
// loop regardless of input source.

// Small canned hand-shape offset table (approximate MediaPipe layout,
// centered on 0,0), scaled down — renderer only needs plausible star
// positions, not anatomical accuracy.
const HAND_SHAPE = [
  [0.00, 0.55], [-0.35, 0.35], [-0.55, 0.10], [-0.70, -0.15], [-0.80, -0.40], // thumb (0-4)
  [-0.20, 0.05], [-0.25, -0.35], [-0.28, -0.60], [-0.30, -0.82], // index (5-8)
  [0.00, 0.00], [-0.02, -0.42], [-0.03, -0.70], [-0.05, -0.95], // middle (9-12)
  [0.20, 0.05], [0.22, -0.35], [0.24, -0.60], [0.26, -0.82], // ring (13-16)
  [0.38, 0.15], [0.42, -0.15], [0.45, -0.38], [0.48, -0.58], // pinky (17-20)
];

const TIP_LANDMARKS = [4, 8, 12, 16, 20];
const SHAPE_SCALE = 0.12;
const TIP_CLUSTER = 0.015;
const RAISED_Y = 0.30;

export class PointerHands {
  constructor(el) {
    this.el = el;
    this._pointers = new Map(); // pointerId -> {x, y}

    this._onDown = (e) => {
      this._pointers.set(e.pointerId, this._toNorm(e));
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
    };
    this._onMove = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, this._toNorm(e));
    };
    this._onUp = (e) => {
      this._pointers.delete(e.pointerId);
    };

    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onUp);
    el.addEventListener('pointerleave', this._onUp);
  }

  _toNorm(e) {
    const rect = this.el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  detect() {
    const hands = [];
    for (const { x, y } of this._pointers.values()) {
      const landmarks = new Array(21);
      for (let i = 0; i < 21; i++) {
        const [ox, oy] = HAND_SHAPE[i];
        landmarks[i] = { x: x + ox * SHAPE_SCALE, y: y + oy * SHAPE_SCALE, z: 0 };
      }
      const tips = TIP_LANDMARKS.map((i) => ({
        x: x + (Math.random() * 2 - 1) * TIP_CLUSTER + HAND_SHAPE[i][0] * SHAPE_SCALE * 0.3,
        y: y + (Math.random() * 2 - 1) * TIP_CLUSTER + HAND_SHAPE[i][1] * SHAPE_SCALE * 0.3,
      }));
      const wrist = { x, y: y + 0.03 };
      hands.push({
        landmarks,
        tips,
        wrist,
        raised: y < RAISED_Y,
        pinch: 1,
      });
    }
    return { hands };
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this._onDown);
    this.el.removeEventListener('pointermove', this._onMove);
    this.el.removeEventListener('pointerup', this._onUp);
    this.el.removeEventListener('pointercancel', this._onUp);
    this.el.removeEventListener('pointerleave', this._onUp);
  }
}
