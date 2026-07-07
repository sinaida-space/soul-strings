// 15-second video+audio recorder: composites the WebGL canvas stream
// with the AudioEngine's capture stream into a single MediaRecorder.

const MAX_SECONDS = 15;

const MIME_CANDIDATES = [
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

function pickMime() {
  for (const candidate of MIME_CANDIDATES) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate.mime)) {
      return candidate;
    }
  }
  return { mime: '', ext: 'webm' };
}

export class Recorder {
  constructor(canvas, audioStream) {
    this.canvas = canvas;
    this.audioStream = audioStream;
    this._recorder = null;
    this._chunks = [];
    this._tickTimer = null;
    this._secondsLeft = MAX_SECONDS;
  }

  get active() {
    return !!this._recorder && this._recorder.state === 'recording';
  }

  start(onTick, onDone) {
    if (this.active) return;

    const videoStream = this.canvas.captureStream(60);
    const tracks = [...videoStream.getVideoTracks()];
    if (this.audioStream) tracks.push(...this.audioStream.getAudioTracks());
    const combined = new MediaStream(tracks);

    const { mime, ext } = pickMime();
    const options = { videoBitsPerSecond: 8_000_000 };
    if (mime) options.mimeType = mime;

    let recorder;
    try {
      recorder = new MediaRecorder(combined, options);
    } catch (err) {
      recorder = new MediaRecorder(combined);
    }

    this._chunks = [];
    this._secondsLeft = MAX_SECONDS;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    recorder.onstop = () => {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
      const blob = new Blob(this._chunks, { type: recorder.mimeType || mime || 'video/webm' });
      if (onDone) onDone(blob, ext);
    };

    recorder.start();
    this._recorder = recorder;

    if (onTick) onTick(this._secondsLeft);
    this._tickTimer = setInterval(() => {
      this._secondsLeft -= 1;
      if (onTick) onTick(Math.max(0, this._secondsLeft));
      if (this._secondsLeft <= 0) {
        this.stop();
      }
    }, 1000);
  }

  stop() {
    if (!this.active) return;
    this._recorder.stop();
  }
}
