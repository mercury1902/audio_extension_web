let mediaStream = null;
let audioCtx = null;
let analyser = null;
let timerId = null;

let capturedTabId = null;
let sampleRate = 48000;
let freqData = null;
let timeData = null;
let maxHold = null;

let totalFrames = 0;
let activeFrames = 0;
let overallMaxDb = -160;
let cachedCutoffHz = null;
let cachedRefDb = -140;
let cachedIsBrickwall = false;
let latestFrame = null;
let wfHistory = [];

// Rolling Dynamic Range (Crest Factor) state
let smoothCrestDb = null;

const FFT_SIZE = 8192;
const INTERVAL_MS = 30;
const CUTOFF_EVERY_N_TICKS = 4;
const DISPLAY_BINS = 128;
const MAX_WF_HISTORY_COLS = 360;
const MIN_DB = -105;
const MAX_DB = -15;

// Standard ISO 31-band 1/3-octave center frequencies (20 Hz to 20 kHz)
const ISO_31_BANDS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
  12500, 16000, 20000,
];

function resetSpectrum() {
  if (analyser) {
    maxHold = new Float32Array(analyser.frequencyBinCount).fill(-140);
  }
  totalFrames = 0;
  activeFrames = 0;
  overallMaxDb = -160;
  cachedCutoffHz = null;
  cachedRefDb = -140;
  cachedIsBrickwall = false;
  latestFrame = null;
  wfHistory = [];
  smoothCrestDb = null;
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
  smoothCrestDb = null;
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
  if (refDb < -72) return { cutoffHz: null, refDb, isBrickwall: false };

  // Measure actual ultrasonic noise floor near Nyquist (e.g. 22.5k - 23.8k on 48kHz AudioContext)
  let noiseFloorDb = -104;
  if (nyquist >= 23500) {
    const nfStart = Math.floor(22500 / binHz);
    const nfEnd = Math.min(holdArr.length - 1, Math.floor((nyquist - 150) / binHz));
    const nfVals = [];
    for (let i = nfStart; i <= nfEnd; i++) {
      nfVals.push(holdArr[i]);
    }
    if (nfVals.length > 0) {
      noiseFloorDb = Math.max(-115, Math.min(-88, percentile(nfVals, 0.5)));
    }
  }

  // Adaptive threshold: tracks genuine anti-aliasing roll-off down to ~6.5 dB above noise floor
  const floorThreshold = noiseFloorDb + 6.5;
  const threshold = Math.max(refDb - 62, floorThreshold);

  const stepHz = 200;
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
      const cutoffHz = Math.round(bands[i].freq);
      const belowIdx = Math.max(0, i - 3);
      const aboveIdx = Math.min(bands.length - 1, i + 3);
      const dropDb = bands[belowIdx].db - bands[aboveIdx].db;
      const isBrickwall = dropDb >= 26;
      return { cutoffHz, refDb, isBrickwall };
    }
  }

  return { cutoffHz: 8000, refDb, isBrickwall: true };
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

function computeLog31Bins(arr, sr) {
  const binHz = sr / FFT_SIZE;
  const maxIdx = arr.length - 1;
  const halfStep = Math.pow(2, 1 / 6);
  const out = new Array(ISO_31_BANDS.length);

  for (let i = 0; i < ISO_31_BANDS.length; i++) {
    const fc = ISO_31_BANDS[i];
    const fLow = fc / halfStep;
    const fHigh = fc * halfStep;
    const bStart = Math.max(1, Math.min(maxIdx, Math.floor(fLow / binHz)));
    const bEnd = Math.max(bStart, Math.min(maxIdx, Math.ceil(fHigh / binHz)));

    let maxVal = -140;
    for (let b = bStart; b <= bEnd; b++) {
      if (arr[b] > maxVal) maxVal = arr[b];
    }
    out[i] = Math.round(maxVal * 10) / 10;
  }
  return out;
}

function computeDynamics(buf) {
  let sumSq = 0;
  let peakAbs = 0;
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const s = buf[i];
    const a = s < 0 ? -s : s;
    if (a > peakAbs) peakAbs = a;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / n);
  const peakDbfs = peakAbs > 1e-7 ? 20 * Math.log10(peakAbs) : -140;
  const rmsDbfs = rms > 1e-7 ? 20 * Math.log10(rms) : -140;

  if (rmsDbfs > -55 && peakDbfs > -50) {
    const instantCrest = Math.max(0, Math.min(35, peakDbfs - rmsDbfs));
    if (smoothCrestDb === null) {
      smoothCrestDb = instantCrest;
    } else {
      smoothCrestDb += (instantCrest - smoothCrestDb) * 0.04;
    }
  }

  return {
    peakDbfs: Math.round(peakDbfs * 10) / 10,
    rmsDbfs: Math.round(rmsDbfs * 10) / 10,
    crestDb: smoothCrestDb !== null ? Math.round(smoothCrestDb * 10) / 10 : null,
  };
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
  if (!analyser || !freqData || !timeData || !maxHold) return;

  analyser.getFloatFrequencyData(freqData);
  analyser.getFloatTimeDomainData(timeData);
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
    cachedIsBrickwall = res.isBrickwall;
  }

  const activeSeconds = Number(((activeFrames * INTERVAL_MS) / 1000).toFixed(1));
  const drmSilentWarning =
    totalFrames * INTERVAL_MS > 3000 && activeFrames === 0 && overallMaxDb < -95;

  const liveBins = downsampleForCanvas(freqData, DISPLAY_BINS);
  const maxBins = downsampleForCanvas(maxHold, DISPLAY_BINS);
  const logLiveBins = computeLog31Bins(freqData, sampleRate);
  const logMaxBins = computeLog31Bins(maxHold, sampleRate);
  const dynamics = computeDynamics(timeData);

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
    isBrickwall: cachedIsBrickwall,
    refDb: Math.round(cachedRefDb),
    drmSilentWarning,
    liveBins,
    maxBins,
    logLiveBins,
    logMaxBins,
    peakDbfs: dynamics.peakDbfs,
    rmsDbfs: dynamics.rmsDbfs,
    crestDb: dynamics.crestDb,
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
  timeData = new Float32Array(FFT_SIZE);
  maxHold = new Float32Array(analyser.frequencyBinCount).fill(-140);
  capturedTabId = tabId;
  totalFrames = 0;
  activeFrames = 0;
  overallMaxDb = -160;
  cachedCutoffHz = null;
  cachedRefDb = -140;
  cachedIsBrickwall = false;
  wfHistory = [];
  smoothCrestDb = null;

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
            isBrickwall: false,
            wfHistory: [],
          }
    );
    return true;
  }
});