let mediaStream = null;
let audioCtx = null;
let analyser = null;
let timerId = null;

let capturedTabId = null;
let sampleRate = 48000;
let freqData = null;
let maxHold = null;

let totalFrames = 0;
let activeFrames = 0;
let overallMaxDb = -160;
let cachedCutoffHz = null;
let cachedRefDb = -140;
let latestFrame = null;
let wfHistory = []; // Lightweight ring buffer (0-255 quantized) so Popup Waterfall resumes instantly

const FFT_SIZE = 8192;
const INTERVAL_MS = 30; // ~33 FPS smooth stream updates for Popup
const CUTOFF_EVERY_N_TICKS = 4; // Recompute cutoff every ~120ms to save CPU
const DISPLAY_BINS = 128; // Higher vertical resolution for Popup Spek Waterfall
const MAX_WF_HISTORY_COLS = 360; // ~10.8 seconds of instant history (~45 KB RAM)
const MIN_DB = -105;
const MAX_DB = -15;

function resetSpectrum() {
  if (analyser) {
    maxHold = new Float32Array(analyser.frequencyBinCount).fill(-140);
  }
  totalFrames = 0;
  activeFrames = 0;
  overallMaxDb = -160;
  cachedCutoffHz = null;
  cachedRefDb = -140;
  latestFrame = null;
  wfHistory = [];
}

function stopCapture() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  capturedTabId = null;
  latestFrame = null;
  wfHistory = [];
}

function percentile(arr, p) {
  if (!arr.length) return -140;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function detectCutoffHz(holdArr, sr) {
  const binHz = sr / FFT_SIZE;
  const nyquist = sr / 2;

  const midStart = Math.floor(2000 / binHz);
  const midEnd = Math.min(holdArr.length - 1, Math.floor(8000 / binHz));
  const midVals = [];
  for (let i = midStart; i <= midEnd; i++) {
    midVals.push(holdArr[i]);
  }
  const refDb = percentile(midVals, 0.8);
  if (refDb < -72) return { cutoffHz: null, refDb };

  const threshold = Math.max(refDb - 45, -92);
  const stepHz = 250;
  const bands = [];

  for (let f = 8000; f <= nyquist - stepHz; f += stepHz) {
    const bStart = Math.floor(f / binHz);
    const bEnd = Math.min(holdArr.length - 1, Math.floor((f + stepHz) / binHz));
    const slice = [];
    for (let i = bStart; i <= bEnd; i++) {
      slice.push(holdArr[i]);
    }
    bands.push({ freq: f + stepHz / 2, db: percentile(slice, 0.8) });
  }

  for (let i = bands.length - 1; i >= 1; i--) {
    if (bands[i].db > threshold && bands[i - 1].db > threshold) {
      return { cutoffHz: Math.round(bands[i].freq), refDb };
    }
  }

  return { cutoffHz: 8000, refDb };
}

function downsampleForCanvas(arr, outCount) {
  const out = new Array(outCount);
  const binCount = arr.length;
  const step = binCount / outCount;

  for (let i = 0; i < outCount; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(binCount, Math.max(start + 1, Math.floor((i + 1) * step)));
    let maxVal = -140;
    for (let j = start; j < end; j++) {
      if (arr[j] > maxVal) maxVal = arr[j];
    }
    out[i] = Math.round(maxVal * 10) / 10;
  }
  return out;
}

function quantizeColumnForHistory(dbBins) {
  const span = MAX_DB - MIN_DB;
  const col = new Array(dbBins.length);
  for (let i = 0; i < dbBins.length; i++) {
    const norm = Math.max(0, Math.min(1, (dbBins[i] - MIN_DB) / span));
    col[i] = Math.round(norm * 255);
  }
  return col;
}

function analyzeTick() {
  if (!analyser || !freqData || !maxHold) return;

  analyser.getFloatFrequencyData(freqData);
  totalFrames += 1;

  const binHz = sampleRate / FFT_SIZE;
  const midStart = Math.floor(300 / binHz);
  const midEnd = Math.min(freqData.length - 1, Math.floor(5000 / binHz));

  let frameMidPeak = -160;
  for (let i = midStart; i <= midEnd; i++) {
    if (freqData[i] > frameMidPeak) frameMidPeak = freqData[i];
  }
  if (frameMidPeak > overallMaxDb) overallMaxDb = frameMidPeak;

  if (frameMidPeak > -64) {
    activeFrames += 1;
    for (let i = 0; i < freqData.length; i++) {
      if (freqData[i] > maxHold[i]) {
        maxHold[i] = freqData[i];
      }
    }
  }

  if (totalFrames % CUTOFF_EVERY_N_TICKS === 0 || cachedCutoffHz === null) {
    const res = detectCutoffHz(maxHold, sampleRate);
    cachedCutoffHz = res.cutoffHz;
    cachedRefDb = res.refDb;
  }

  const activeSeconds = Number(((activeFrames * INTERVAL_MS) / 1000).toFixed(1));
  const drmSilentWarning =
    totalFrames * INTERVAL_MS > 3000 && activeFrames === 0 && overallMaxDb < -95;

  const liveBins = downsampleForCanvas(freqData, DISPLAY_BINS);
  const maxBins = downsampleForCanvas(maxHold, DISPLAY_BINS);

  wfHistory.push(quantizeColumnForHistory(liveBins));
  if (wfHistory.length > MAX_WF_HISTORY_COLS) {
    wfHistory.shift();
  }

  latestFrame = {
    capturing: true,
    tabId: capturedTabId,
    sampleRate,
    nyquist: sampleRate / 2,
    activeSeconds,
    cutoffHz: cachedCutoffHz,
    refDb: Math.round(cachedRefDb),
    drmSilentWarning,
    liveBins,
    maxBins,
  };

  chrome.runtime
    .sendMessage({
      target: "ui",
      type: "FFT_FRAME",
      payload: latestFrame,
    })
    .catch(() => {});
}

async function startCapture(tabId, streamId) {
  stopCapture();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  audioCtx = new AudioContext();
  sampleRate = audioCtx.sampleRate;

  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.0;

  source.connect(analyser);
  source.connect(audioCtx.destination);

  freqData = new Float32Array(analyser.frequencyBinCount);
  maxHold = new Float32Array(analyser.frequencyBinCount).fill(-140);
  capturedTabId = tabId;
  totalFrames = 0;
  activeFrames = 0;
  overallMaxDb = -160;
  cachedCutoffHz = null;
  cachedRefDb = -140;
  wfHistory = [];

  timerId = setInterval(analyzeTick, INTERVAL_MS);
  analyzeTick();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  if (message.type === "OFFSCREEN_START") {
    startCapture(message.tabId, message.streamId)
      .then(() => sendResponse({ ok: true, sampleRate }))
      .catch((err) => {
        stopCapture();
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (message.type === "OFFSCREEN_STOP") {
    stopCapture();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "OFFSCREEN_RESET") {
    resetSpectrum();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "OFFSCREEN_GET_STATE") {
    sendResponse(
      latestFrame
        ? { ...latestFrame, wfHistory }
        : {
            capturing: Boolean(mediaStream),
            tabId: capturedTabId,
            sampleRate,
            nyquist: sampleRate / 2,
            activeSeconds: 0,
            cutoffHz: null,
            wfHistory: [],
          }
    );
    return true;
  }
});