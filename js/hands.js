// Camera + MediaPipe hand tracking. Emits normalized, mirrored
// landmarks (x=1-x so movement matches what the player sees of
// themselves, as in a mirror).

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const TIP_LANDMARKS = [4, 8, 12, 16, 20];

export async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: 640, height: 480 },
    audio: false,
  });
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.playsInline = true;
  await videoEl.play();
  return stream;
}

export async function initHands(videoEl) {
  const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  const { HandLandmarker, FilesetResolver } = vision;
  const filesetResolver = await FilesetResolver.forVisionTasks(CDN_BASE);

  let landmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      numHands: 2,
      runningMode: 'VIDEO',
    });
  } catch (err) {
    // GPU delegate unavailable on this device/browser — fall back to CPU.
    landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      numHands: 2,
      runningMode: 'VIDEO',
    });
  }

  let lastVideoTime = -1;

  return {
    detect(nowMs) {
      if (videoEl.currentTime === lastVideoTime) {
        return { hands: [] };
      }
      lastVideoTime = videoEl.currentTime;

      const result = landmarker.detectForVideo(videoEl, nowMs);
      const hands = [];
      const rawHands = result.landmarks || [];
      for (let h = 0; h < rawHands.length; h++) {
        const raw = rawHands[h];
        const landmarks = new Array(21);
        for (let i = 0; i < 21; i++) {
          landmarks[i] = { x: 1 - raw[i].x, y: raw[i].y, z: raw[i].z };
        }
        const tips = TIP_LANDMARKS.map((i) => ({ x: landmarks[i].x, y: landmarks[i].y }));
        const wrist = { x: landmarks[0].x, y: landmarks[0].y };
        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const pinch = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
        hands.push({
          landmarks,
          tips,
          wrist,
          raised: wrist.y < 0.35,
          pinch,
        });
      }
      return { hands };
    },
  };
}
