// Karplus-Strong string synthesis + ambient shimmer pad.
//
// Per pluck: a short noise burst is injected into a feedback loop of
// DelayNode(delay = 1/freq) -> BiquadFilter(lowpass) -> GainNode(loop
// gain) -> back into the delay. That's the physical-modeling "plucked
// string" trick — the delay line's length sets the pitch, the loop
// gain sets the decay, the lowpass darkens the tone as energy dies.

const SCALES = {
  minor: [110.00, 130.81, 146.83, 164.81, 196.00, 220.00, 261.63],
  major: [110.00, 123.47, 138.59, 164.81, 185.00, 220.00, 246.94],
};

const LOOP_GAIN = 0.986;
const BURST_MS = 30;
const VOICE_LIFETIME_MS = 5000;

function makeSoftClipCurve(amount = 8) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

export class AudioEngine {
  constructor() {
    this.scaleName = 'minor';
    this.scale = SCALES.minor;
    this._voices = new Array(7).fill(null); // active Karplus-Strong loop per string
    this._brightness = 0.5; // 0..1, maps to 1200..6000 Hz
  }

  async init() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    // Master chain: strings + pad -> soft clip -> reverb (35% wet) -> master gain -> destination + capture
    this.stringBus = ctx.createGain();
    this.stringBus.gain.value = 1.0;
    this.padBus = ctx.createGain();
    this.padBus.gain.value = 1.0;

    this.softClip = ctx.createWaveShaper();
    this.softClip.curve = makeSoftClipCurve(6);
    this.softClip.oversample = '2x';

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0.65;
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.35;

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._buildImpulse(2.5);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.captureDest = ctx.createMediaStreamDestination();
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;

    this.stringBus.connect(this.softClip);
    this.padBus.connect(this.softClip);
    this.softClip.connect(this.dryGain);
    this.softClip.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.dryGain.connect(this.masterGain);
    this.wetGain.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);
    this.masterAnalyser.connect(this.captureDest);

    this._initPad();
  }

  _buildImpulse(durationSec) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * durationSec);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2);
      }
    }
    return buffer;
  }

  _initPad() {
    const ctx = this.ctx;
    const root = 110; // A2
    const ratios = [1, 3 / 2, 2]; // root, fifth, octave
    const detuneCents = [-4, 0, 4];

    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.0;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.4;

    this.padOscillators = ratios.map((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = root * ratio;
      osc.detune.value = detuneCents[i];
      osc.connect(this.padFilter);
      osc.start();
      return osc;
    });
    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.padBus);
  }

  setScale(name) {
    if (!SCALES[name]) return;
    this.scaleName = name;
    this.scale = SCALES[name];
  }

  setBrightness(v) {
    this._brightness = Math.max(0, Math.min(1, v));
  }

  _brightnessHz() {
    return 1200 + (6000 - 1200) * this._brightness;
  }

  setShimmer(v) {
    const ctx = this.ctx;
    const target = Math.max(0, Math.min(1, v)) * 0.18; // gentle pad ceiling
    this.padGain.gain.cancelScheduledValues(ctx.currentTime);
    this.padGain.gain.setTargetAtTime(target, ctx.currentTime, 0.1);
  }

  pluck(i, velocity) {
    if (i < 0 || i >= this.scale.length) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const freq = this.scale[i];
    const vel = Math.max(0, Math.min(1, velocity));

    this.damp(i);

    const delayTime = 1 / freq;
    const delay = ctx.createDelay(delayTime + 0.02);
    delay.delayTime.value = delayTime;

    const loopFilter = ctx.createBiquadFilter();
    loopFilter.type = 'lowpass';
    loopFilter.frequency.value = this._brightnessHz();
    loopFilter.Q.value = 0.3;

    const loopGain = ctx.createGain();
    loopGain.gain.value = LOOP_GAIN;

    const outGain = ctx.createGain();
    outGain.gain.value = 0.9 * (0.35 + 0.65 * vel);

    // Noise burst excitation, ~30ms.
    const burstDur = BURST_MS / 1000;
    const burstLen = Math.floor(ctx.sampleRate * burstDur);
    const burstBuffer = ctx.createBuffer(1, burstLen, ctx.sampleRate);
    const data = burstBuffer.getChannelData(0);
    for (let n = 0; n < burstLen; n++) {
      data[n] = (Math.random() * 2 - 1) * (1 - n / burstLen);
    }
    const burstSrc = ctx.createBufferSource();
    burstSrc.buffer = burstBuffer;
    const burstGain = ctx.createGain();
    burstGain.gain.value = vel;

    // Feedback loop: delay -> loopFilter -> loopGain -> delay
    burstSrc.connect(burstGain).connect(delay);
    delay.connect(loopFilter);
    loopFilter.connect(loopGain);
    loopGain.connect(delay);
    loopFilter.connect(outGain);
    outGain.connect(this.stringBus);

    burstSrc.start(now);
    burstSrc.stop(now + burstDur);

    const voice = { delay, loopFilter, loopGain, outGain, burstSrc, killTimer: null };
    this._voices[i] = voice;

    voice.killTimer = setTimeout(() => this._teardownVoice(i, voice), VOICE_LIFETIME_MS);
  }

  damp(i) {
    const voice = this._voices[i];
    if (!voice) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Fast-kill: collapse the loop gain and output so the delay's
    // recirculating energy dies in a few ms instead of ringing on.
    voice.loopGain.gain.cancelScheduledValues(now);
    voice.loopGain.gain.setTargetAtTime(0, now, 0.01);
    voice.outGain.gain.cancelScheduledValues(now);
    voice.outGain.gain.setTargetAtTime(0, now, 0.015);
    if (voice.killTimer) clearTimeout(voice.killTimer);
    voice.killTimer = setTimeout(() => this._teardownVoice(i, voice), 200);
  }

  _teardownVoice(i, voice) {
    try {
      voice.burstSrc.disconnect();
      voice.delay.disconnect();
      voice.loopFilter.disconnect();
      voice.loopGain.disconnect();
      voice.outGain.disconnect();
    } catch (e) {
      // already disconnected — fine
    }
    if (this._voices[i] === voice) this._voices[i] = null;
  }

  get captureStream() {
    return this.captureDest.stream;
  }

  get analyser() {
    return this.masterAnalyser;
  }
}
