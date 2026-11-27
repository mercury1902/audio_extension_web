let mediaStream = null;
let audioCtx = null;
let analyser = null;
let analyserL = null;
let analyserR = null;
let kAnalyserL = null;
let kAnalyserR = null;
let timerId = null;

let capturedTabId = null;
let sampleRate = 48000;
let freqData = null;
let timeData = null;
let timeDataL = null;
let timeDataR = null;
let kTimeDataL = null;
let kTimeDataR = null;
let maxHold = null;

let totalFrames = 0;
let activeFrames = 0;
let overallMaxDb = -160;
let cachedCutoffHz = null;
let cachedRefDb = -140;
let cachedIsBrickwall = false;
let latestFrame = null;
let wfHistory = [];

// Rolling Dynamic Range, Phase Correlation & ITU-R BS.1770-4 LUFS states
let smoothCrestDb = null;
let smoothPhaseCorr = null;
let momentaryBlocks = []; // 400ms rolling window of K-weighted (zL + zR)
let gatedBlocks = [];     // 400ms block powers sampled every ~100ms for Integrated LUFS
let lufsHopAccumMs = 0;

const DEFAULT_FFT_SIZE = 4096;
const VALID_FFT_SIZES = new Set([512, 1024, 2048, 4096, 8192, 16384]);
let currentFftSize = DEFAULT_FFT_SIZE;
const TIME_FFT_SIZE = 2048;

function sanitizeFftSize(val) {
  const n = Number(val);
  return VALID_FFT_SIZES.has(n) ? n : DEFAULT_FFT_SIZE;
}
const INTERVAL_MS = 30;
const CUTOFF_EVERY_N_TICKS = 4;
const DISPLAY_BINS = 128;
const MAX_WF_HISTORY_COLS = 360;
const MIN_DB = -105;
const MAX_DB = -15;
const ABS_GATE_POWER = Math.pow(10, (-70 + 0.691) / 10);

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
  smoothPhaseCorr = null;
  momentaryBlocks = [];
  gatedBlocks = [];
  lufsHopAccumMs = 0;
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
  analyserL = null;
  analyserR = null;
  kAnalyserL = null;
  kAnalyserR = null;
  capturedTabId = null;
  latestFrame = null;
  wfHistory = [];
  smoothCrestDb = null;
  smoothPhaseCorr = null;
  momentaryBlocks = [];
  gatedBlocks = [];
  lufsHopAccumMs = 0;
}

function percentile(arr, p) {
  if (!arr.length) return -140;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function detectCutoffHz(holdArr, sr, fftSz = currentFftSize) {
  const binHz = sr / fftSz;
  const nyquist = sr / 2;

  const midStart = Math.min(holdArr.length - 1, Math.floor(2000 / binHz));
  const midEnd = Math.min(holdArr.length - 1, Math.max(midStart, Math.floor(8000 / binHz)));
  const midVals = [];
  for (let i = midStart; i <= midEnd; i++) {
    midVals.push(holdArr[i]);
  }
  const refDb = percentile(midVals, 0.8);
  if (refDb < -72) return { cutoffHz: null, refDb, isBrickwall: false };

  // Estimate ultrasonic noise floor using the lowest 10% of near-Nyquist bins
  // and cap at -98 dB so genuine full-bandwidth 48kHz+ music never inflates the floor.
  let noiseFloorDb = -104;
  const nfLow = Math.max(nyquist - 1500, 22500);
  if (nyquist >= 23500 && nfLow < nyquist - 50) {
    const nfStart = Math.min(holdArr.length - 1, Math.floor(nfLow / binHz));
    const nfEnd = Math.min(holdArr.length - 1, Math.max(nfStart, Math.floor((nyquist - 40) / binHz)));
    const nfVals = [];
    for (let i = nfStart; i <= nfEnd; i++) {
      nfVals.push(holdArr[i]);
    }
    if (nfVals.length > 0) {
      noiseFloorDb = Math.max(-118, Math.min(-98, percentile(nfVals, 0.1)));
    }
  }

  const floorThreshold = noiseFloorDb + 5.0;
  const threshold = Math.max(refDb - 64, floorThreshold);

  const stepHz = Math.max(nyquist > 30000 ? 400 : 150, Math.ceil(binHz));
  const bands = [];

  for (let f = 8000; f <= nyquist - stepHz; f += stepHz) {
    const bStart = Math.min(holdArr.length - 1, Math.floor(f / binHz));
    const bEnd = Math.min(holdArr.length - 1, Math.max(bStart, Math.floor((f + stepHz) / binHz)));
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

function computeLog31Bins(arr, sr, fftSz = currentFftSize) {
  const binHz = sr / fftSz;
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

// 4x oversampled True Peak estimator using Catmull-Rom cubic interpolation
function estimateTruePeakAbs(buf) {
  let peak = 0;
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > peak) peak = a;
  }
  if (peak < 0.25 || n < 4) return peak;

  const checkFloor = Math.max(0.25, peak * 0.72);
  for (let i = 1; i < n - 2; i++) {
    const y1 = buf[i];
    const y2 = buf[i + 1];
    if ((y1 < 0 ? -y1 : y1) < checkFloor && (y2 < 0 ? -y2 : y2) < checkFloor) continue;

    const y0 = buf[i - 1];
    const y3 = buf[i + 2];
    const c0 = 2 * y1;
    const c1 = -y0 + y2;
    const c2 = 2 * y0 - 5 * y1 + 4 * y2 - y3;
    const c3 = -y0 + 3 * y1 - 3 * y2 + y3;

    // Evaluate at t = 0.25, 0.5, 0.75
    const p25 = Math.abs(0.5 * (c0 + c1 * 0.25 + c2 * 0.0625 + c3 * 0.015625));
    const p50 = Math.abs(0.5 * (c0 + c1 * 0.5 + c2 * 0.25 + c3 * 0.125));
    const p75 = Math.abs(0.5 * (c0 + c1 * 0.75 + c2 * 0.5625 + c3 * 0.421875));
    if (p25 > peak) peak = p25;
    if (p50 > peak) peak = p50;
    if (p75 > peak) peak = p75;
  }
  return peak;
}

function computeGatedIntegratedLufs(blocks) {
  if (!blocks.length) return null;
  let sumAbs = 0;
  let countAbs = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] > ABS_GATE_POWER) {
      sumAbs += blocks[i];
      countAbs += 1;
    }
  }
  if (countAbs === 0) return null;

  const ungatedMean = sumAbs / countAbs;
  const relGatePower = ungatedMean * 0.1; // -10 LU relative threshold

  let sumRel = 0;
  let countRel = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] > relGatePower) {
      sumRel += blocks[i];
      countRel += 1;
    }
  }
  if (countRel === 0) return null;
  return -0.691 + 10 * Math.log10(sumRel / countRel);
}

function computeStereoAndLoudness(bufL, bufR, kBufL, kBufR) {
  const n = bufL.length;
  let sumSqL = 0;
  let sumSqR = 0;
  let sumLR = 0;
  let peakL = 0;
  let peakR = 0;

  for (let i = 0; i < n; i++) {
    const l = bufL[i];
    const r = bufR[i];
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    if (al > peakL) peakL = al;
    if (ar > peakR) peakR = ar;
    sumSqL += l * l;
    sumSqR += r * r;
    sumLR += l * r;
  }

  const rmsL = Math.sqrt(sumSqL / n);
  const rmsR = Math.sqrt(sumSqR / n);
  const peakMono = Math.max(peakL, peakR);
  const rmsMono = Math.sqrt((sumSqL + sumSqR) / (2 * n));

  const tpAbs = Math.max(estimateTruePeakAbs(bufL), estimateTruePeakAbs(bufR));
  const peakLDbfs = peakL > 1e-7 ? 20 * Math.log10(peakL) : -140;
  const peakRDbfs = peakR > 1e-7 ? 20 * Math.log10(peakR) : -140;
  const rmsLDbfs = rmsL > 1e-7 ? 20 * Math.log10(rmsL) : -140;
  const rmsRDbfs = rmsR > 1e-7 ? 20 * Math.log10(rmsR) : -140;
  const peakDbfs = peakMono > 1e-7 ? 20 * Math.log10(peakMono) : -140;
  const rmsDbfs = rmsMono > 1e-7 ? 20 * Math.log10(rmsMono) : -140;
  const truePeakDbtp = tpAbs > 1e-7 ? 20 * Math.log10(tpAbs) : -140;

  // Dynamic Range (Crest Factor)
  if (rmsDbfs > -55 && peakDbfs > -50) {
    const instantCrest = Math.max(0, Math.min(35, peakDbfs - rmsDbfs));
    smoothCrestDb =
      smoothCrestDb === null ? instantCrest : smoothCrestDb + (instantCrest - smoothCrestDb) * 0.04;
  }

  // Stereo Phase Correlation (-1.0 to +1.0)
  const denom = Math.sqrt(sumSqL * sumSqR);
  if (denom > 1e-9 && rmsDbfs > -62) {
    const corr = Math.max(-1, Math.min(1, sumLR / denom));
    smoothPhaseCorr =
      smoothPhaseCorr === null ? corr : smoothPhaseCorr + (corr - smoothPhaseCorr) * 0.18;
  }

  // ITU-R BS.1770-4 K-weighted Loudness (Momentary 400ms + Gated Integrated)
  let momentaryLufs = null;
  let integratedLufs = null;
  if (kBufL && kBufR) {
    let kSumL = 0;
    let kSumR = 0;
    const kn = kBufL.length;
    for (let i = 0; i < kn; i++) {
      kSumL += kBufL[i] * kBufL[i];
      kSumR += kBufR[i] * kBufR[i];
    }
    const zFrame = kSumL / kn + kSumR / kn;
    momentaryBlocks.push(zFrame);
    const maxMomFrames = Math.max(1, Math.round(400 / INTERVAL_MS));
    if (momentaryBlocks.length > maxMomFrames) momentaryBlocks.shift();

    let momSum = 0;
    for (let i = 0; i < momentaryBlocks.length; i++) momSum += momentaryBlocks[i];
    const z400 = momSum / momentaryBlocks.length;
    if (z400 > 1e-10) {
      momentaryLufs = -0.691 + 10 * Math.log10(z400);
    }

    lufsHopAccumMs += INTERVAL_MS;
    if (lufsHopAccumMs >= 100 && momentaryBlocks.length >= Math.min(4, maxMomFrames)) {
      lufsHopAccumMs -= 100;
      gatedBlocks.push(z400);
      if (gatedBlocks.length > 6000) gatedBlocks.shift();
    }

    integratedLufs = computeGatedIntegratedLufs(gatedBlocks);
  }

  return {
    peakDbfs: Math.round(peakDbfs * 10) / 10,
    rmsDbfs: Math.round(rmsDbfs * 10) / 10,
    peakLDbfs: Math.round(peakLDbfs * 10) / 10,
    peakRDbfs: Math.round(peakRDbfs * 10) / 10,
    rmsLDbfs: Math.round(rmsLDbfs * 10) / 10,
    rmsRDbfs: Math.round(rmsRDbfs * 10) / 10,
    truePeakDbtp: Math.round(truePeakDbtp * 10) / 10,
    crestDb: smoothCrestDb !== null ? Math.round(smoothCrestDb * 10) / 10 : null,
    phaseCorr: smoothPhaseCorr !== null ? Math.round(smoothPhaseCorr * 100) / 100 : null,
    momentaryLufs: momentaryLufs !== null ? Math.round(momentaryLufs * 10) / 10 : null,
    integratedLufs: integratedLufs !== null ? Math.round(integratedLufs * 10) / 10 : null,
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
  if (!analyser || !freqData || !maxHold) return;

  analyser.getFloatFrequencyData(freqData);
  if (analyserL && analyserR && timeDataL && timeDataR) {
    analyserL.getFloatTimeDomainData(timeDataL);
    analyserR.getFloatTimeDomainData(timeDataR);
  }
  if (kAnalyserL && kAnalyserR && kTimeDataL && kTimeDataR) {
    kAnalyserL.getFloatTimeDomainData(kTimeDataL);
    kAnalyserR.getFloatTimeDomainData(kTimeDataR);
  }
  totalFrames += 1;

  const binHz = sampleRate / currentFftSize;
  const midStart = Math.min(freqData.length - 1, Math.floor(300 / binHz));
  const midEnd = Math.min(freqData.length - 1, Math.max(midStart, Math.floor(5000 / binHz)));

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
    const res = detectCutoffHz(maxHold, sampleRate, currentFftSize);
    cachedCutoffHz = res.cutoffHz;
    cachedRefDb = res.refDb;
    cachedIsBrickwall = res.isBrickwall;
  }

  const activeSeconds = Number(((activeFrames * INTERVAL_MS) / 1000).toFixed(1));
  const drmSilentWarning =
    totalFrames * INTERVAL_MS > 3000 && activeFrames === 0 && overallMaxDb < -95;

  const liveBins = downsampleForCanvas(freqData, DISPLAY_BINS);
  const maxBins = downsampleForCanvas(maxHold, DISPLAY_BINS);
  const logLiveBins = computeLog31Bins(freqData, sampleRate, currentFftSize);
  const logMaxBins = computeLog31Bins(maxHold, sampleRate, currentFftSize);
  const dynamics = computeStereoAndLoudness(timeDataL, timeDataR, kTimeDataL, kTimeDataR);

  wfHistory.push(quantizeColumnForHistory(liveBins));
  if (wfHistory.length > MAX_WF_HISTORY_COLS) {
    wfHistory.shift();
  }

  latestFrame = {
    capturing: true,
    tabId: capturedTabId,
    fftSize: currentFftSize,
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
    ...dynamics,
  };

  chrome.runtime
    .sendMessage({
      target: "ui",
      type: "FFT_FRAME",
      payload: latestFrame,
    })
    .catch(() => {});
}

function setFftSize(newSize) {
  const valid = sanitizeFftSize(newSize);
  if (valid === currentFftSize && analyser) return currentFftSize;
  currentFftSize = valid;
  if (analyser) {
    analyser.fftSize = currentFftSize;
    freqData = new Float32Array(analyser.frequencyBinCount);
    maxHold = new Float32Array(analyser.frequencyBinCount).fill(-140);
    totalFrames = 0;
    activeFrames = 0;
    overallMaxDb = -160;
    cachedCutoffHz = null;
    cachedRefDb = -140;
    cachedIsBrickwall = false;
  }
  return currentFftSize;
}

async function startCapture(tabId, streamId, requestedFftSize) {
  stopCapture();
  currentFftSize = sanitizeFftSize(requestedFftSize || currentFftSize);

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

  // Main FFT analyser (mono mix)
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = currentFftSize;
  analyser.smoothingTimeConstant = 0.0;
  source.connect(analyser);
  source.connect(audioCtx.destination);

  // Stereo channel split for L/R meters, True Peak & Phase Correlation
  const splitter = audioCtx.createChannelSplitter(2);
  analyserL = audioCtx.createAnalyser();
  analyserR = audioCtx.createAnalyser();
  analyserL.fftSize = TIME_FFT_SIZE;
  analyserR.fftSize = TIME_FFT_SIZE;
  source.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  // ITU-R BS.1770-4 K-Weighting chain for LUFS
  const kShelf = audioCtx.createBiquadFilter();
  kShelf.type = "highshelf";
  kShelf.frequency.value = 1681.974;
  kShelf.gain.value = 3.9998;

  const kHighpass = audioCtx.createBiquadFilter();
  kHighpass.type = "highpass";
  kHighpass.frequency.value = 38.135;
  kHighpass.Q.value = 0.5003;

  const kSplitter = audioCtx.createChannelSplitter(2);
  kAnalyserL = audioCtx.createAnalyser();
  kAnalyserR = audioCtx.createAnalyser();
  kAnalyserL.fftSize = TIME_FFT_SIZE;
  kAnalyserR.fftSize = TIME_FFT_SIZE;

  source.connect(kShelf);
  kShelf.connect(kHighpass);
  kHighpass.connect(kSplitter);
  kSplitter.connect(kAnalyserL, 0);
  kSplitter.connect(kAnalyserR, 1);

  freqData = new Float32Array(analyser.frequencyBinCount);
  timeData = new Float32Array(TIME_FFT_SIZE);
  timeDataL = new Float32Array(TIME_FFT_SIZE);
  timeDataR = new Float32Array(TIME_FFT_SIZE);
  kTimeDataL = new Float32Array(TIME_FFT_SIZE);
  kTimeDataR = new Float32Array(TIME_FFT_SIZE);
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
  smoothPhaseCorr = null;
  momentaryBlocks = [];
  gatedBlocks = [];
  lufsHopAccumMs = 0;

  timerId = setInterval(analyzeTick, INTERVAL_MS);
  analyzeTick();
}

// ---------- Ultra-Fast Full-Track Offline Scanner (Dynamic Radix-2 FFT + BS.1770-4 LUFS) ----------

const fftTableCache = new Map();

function getFftTables(n) {
  let tbl = fftTableCache.get(n);
  if (tbl) return tbl;

  const bitRev = new Uint32Array(n);
  const hann = new Float32Array(n);
  const half = n >> 1;
  const cos = new Float32Array(half);
  const sin = new Float32Array(half);
  const bits = Math.round(Math.log2(n));

  for (let i = 0; i < n; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < bits; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    bitRev[i] = y;
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }

  tbl = { bitRev, hann, cos, sin };
  fftTableCache.set(n, tbl);
  return tbl;
}

function runRadix2Fft(re, im, n, tables) {
  const { bitRev, cos, sin } = tables;
  for (let i = 0; i < n; i++) {
    const j = bitRev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      let tableIdx = 0;
      for (let j = i; j < i + half; j++) {
        const wr = cos[tableIdx];
        const wi = sin[tableIdx];
        tableIdx += step;

        const k = j + half;
        const tRe = wr * re[k] - wi * im[k];
        const tIm = wr * im[k] + wi * re[k];
        re[k] = re[j] - tRe;
        im[k] = im[j] - tIm;
        re[j] += tRe;
        im[j] += tIm;
      }
    }
  }
}

function makeHighShelfCoeffs(sr, f0, gainDb, Q) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * Q);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cosw + twoSqrtAAlpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosw);
  const b2 = A * (A + 1 + (A - 1) * cosw - twoSqrtAAlpha);
  const a0 = A + 1 - (A - 1) * cosw + twoSqrtAAlpha;
  const a1 = 2 * (A - 1 - (A + 1) * cosw);
  const a2 = A + 1 - (A - 1) * cosw - twoSqrtAAlpha;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function makeHighPassCoeffs(sr, f0, Q) {
  const w0 = (2 * Math.PI * f0) / sr;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * Q);

  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquadInPlace(arr, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < arr.length; i++) {
    const x0 = arr[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    arr[i] = y0;
  }
}

async function decodeAtNativeSampleRate(arrayBuffer, nativeSampleRate) {
  const preferredSr =
    nativeSampleRate >= 8000 && nativeSampleRate <= 192000 ? nativeSampleRate : 48000;

  try {
    const offCtx = new OfflineAudioContext(2, 1, preferredSr);
    return await offCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    const fallbackCtx = new OfflineAudioContext(2, 1, 48000);
    return await fallbackCtx.decodeAudioData(arrayBuffer.slice(0));
  }
}

async function scanFullTrack(tabId, url, nativeSampleRate, requestedFftSize) {
  const t0 = performance.now();
  const scanFftSize = sanitizeFftSize(requestedFftSize || currentFftSize);
  const fftTables = getFftTables(scanFftSize);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} while reading audio file`);
  const arrayBuffer = await resp.arrayBuffer();

  const audioBuffer = await decodeAtNativeSampleRate(arrayBuffer, nativeSampleRate);
  const sr = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  const len = audioBuffer.length;
  const chL = audioBuffer.getChannelData(0);
  const chR = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : chL;

  // Pass 1: Stereo Peaks, RMS, True Peak (4x Catmull-Rom), Phase Correlation & BS.1770-4 LUFS
  let sumSqL = 0;
  let sumSqR = 0;
  let sumLR = 0;
  let peakL = 0;
  let peakR = 0;

  for (let i = 0; i < len; i++) {
    const l = chL[i];
    const r = chR[i];
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    if (al > peakL) peakL = al;
    if (ar > peakR) peakR = ar;
    sumSqL += l * l;
    sumSqR += r * r;
    sumLR += l * r;
  }

  const tpAbs = Math.max(estimateTruePeakAbs(chL), estimateTruePeakAbs(chR));
  const rmsL = Math.sqrt(sumSqL / len);
  const rmsR = Math.sqrt(sumSqR / len);
  const peakMono = Math.max(peakL, peakR);
  const rmsMono = Math.sqrt((sumSqL + sumSqR) / (2 * len));

  const peakLDbfs = peakL > 1e-7 ? 20 * Math.log10(peakL) : -140;
  const peakRDbfs = peakR > 1e-7 ? 20 * Math.log10(peakR) : -140;
  const rmsLDbfs = rmsL > 1e-7 ? 20 * Math.log10(rmsL) : -140;
  const rmsRDbfs = rmsR > 1e-7 ? 20 * Math.log10(rmsR) : -140;
  const peakDbfs = peakMono > 1e-7 ? 20 * Math.log10(peakMono) : -140;
  const rmsDbfs = rmsMono > 1e-7 ? 20 * Math.log10(rmsMono) : -140;
  const truePeakDbtp = tpAbs > 1e-7 ? 20 * Math.log10(tpAbs) : -140;
  const crestDb = rmsDbfs > -80 ? Math.max(0, peakDbfs - rmsDbfs) : null;

  const denom = Math.sqrt(sumSqL * sumSqR);
  const phaseCorr = denom > 1e-9 ? Math.max(-1, Math.min(1, sumLR / denom)) : null;

  // K-Weighting pass on cloned buffers for exact BS.1770-4 Integrated LUFS
  const kL = new Float32Array(chL);
  const kR = new Float32Array(chR);
  const shelfC = makeHighShelfCoeffs(sr, 1681.974, 3.9998, 0.7071);
  const hpC = makeHighPassCoeffs(sr, 38.135, 0.5003);
  applyBiquadInPlace(kL, shelfC);
  applyBiquadInPlace(kL, hpC);
  applyBiquadInPlace(kR, shelfC);
  applyBiquadInPlace(kR, hpC);

  const hop = Math.max(1, Math.round(sr * 0.1)); // 100ms hop
  const numHops = Math.floor(len / hop);
  const hopPowers = new Float64Array(numHops);
  for (let h = 0; h < numHops; h++) {
    const start = h * hop;
    const end = start + hop;
    let sL = 0;
    let sR = 0;
    for (let i = start; i < end; i++) {
      sL += kL[i] * kL[i];
      sR += kR[i] * kR[i];
    }
    hopPowers[h] = (sL + sR) / hop;
  }

  const fullGatedBlocks = [];
  for (let h = 0; h <= numHops - 4; h++) {
    const z400 = (hopPowers[h] + hopPowers[h + 1] + hopPowers[h + 2] + hopPowers[h + 3]) * 0.25;
    fullGatedBlocks.push(z400);
  }
  const integratedLufs = computeGatedIntegratedLufs(fullGatedBlocks);

  // Pass 2: 420-column Full-Track FFT Spectrogram + Max-Hold + Average Spectrum
  const NUM_COLS = 420;
  const binCount = scanFftSize >> 1;
  const fullMaxHold = new Float32Array(binCount).fill(-140);
  const fullAvgAccum = new Float64Array(binCount);
  let activeSlices = 0;

  const re = new Float32Array(scanFftSize);
  const im = new Float32Array(scanFftSize);
  const sliceDb = new Float32Array(binCount);
  const wfCols = new Array(NUM_COLS);
  const invN = 1 / scanFftSize;
  const hann = fftTables.hann;

  for (let c = 0; c < NUM_COLS; c++) {
    const center = Math.floor(((c + 0.5) / NUM_COLS) * Math.max(1, len - scanFftSize));
    const offset = Math.max(0, Math.min(Math.max(0, len - scanFftSize), center));

    for (let i = 0; i < scanFftSize; i++) {
      const idx = offset + i;
      const sample = idx < len ? 0.5 * (chL[idx] + chR[idx]) : 0;
      re[i] = sample * hann[i];
      im[i] = 0;
    }

    runRadix2Fft(re, im, scanFftSize, fftTables);

    let sliceMidPeak = -160;
    const binHz = sr / scanFftSize;
    const midStart = Math.min(binCount - 1, Math.floor(300 / binHz));
    const midEnd = Math.min(binCount - 1, Math.max(midStart, Math.floor(5000 / binHz)));

    for (let b = 0; b < binCount; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]) * invN;
      const db = mag > 1e-7 ? 20 * Math.log10(mag) : -140;
      sliceDb[b] = db;
      if (b >= midStart && b <= midEnd && db > sliceMidPeak) {
        sliceMidPeak = db;
      }
    }

    if (sliceMidPeak > -64) {
      activeSlices += 1;
      for (let b = 0; b < binCount; b++) {
        if (sliceDb[b] > fullMaxHold[b]) fullMaxHold[b] = sliceDb[b];
        fullAvgAccum[b] += sliceDb[b];
      }
    }

    wfCols[c] = downsampleForCanvas(sliceDb, DISPLAY_BINS);
  }

  const fullAvgSpec = new Float32Array(binCount);
  if (activeSlices > 0) {
    for (let b = 0; b < binCount; b++) {
      fullAvgSpec[b] = fullAvgAccum[b] / activeSlices;
    }
  } else {
    fullAvgSpec.fill(-140);
  }

  const cutoffRes = detectCutoffHz(fullMaxHold, sr, scanFftSize);
  const scanMs = Math.round(performance.now() - t0);

  return {
    ok: true,
    fullScan: true,
    tabId,
    fftSize: scanFftSize,
    sampleRate: sr,
    nyquist: sr / 2,
    duration: Number(duration.toFixed(2)),
    activeSeconds: Number(duration.toFixed(1)),
    scanMs,
    cutoffHz: cutoffRes.cutoffHz,
    isBrickwall: cutoffRes.isBrickwall,
    liveBins: downsampleForCanvas(fullAvgSpec, DISPLAY_BINS),
    maxBins: downsampleForCanvas(fullMaxHold, DISPLAY_BINS),
    logLiveBins: computeLog31Bins(fullAvgSpec, sr, scanFftSize),
    logMaxBins: computeLog31Bins(fullMaxHold, sr, scanFftSize),
    wfCols,
    peakDbfs: Math.round(peakDbfs * 10) / 10,
    rmsDbfs: Math.round(rmsDbfs * 10) / 10,
    peakLDbfs: Math.round(peakLDbfs * 10) / 10,
    peakRDbfs: Math.round(peakRDbfs * 10) / 10,
    rmsLDbfs: Math.round(rmsLDbfs * 10) / 10,
    rmsRDbfs: Math.round(rmsRDbfs * 10) / 10,
    truePeakDbtp: Math.round(truePeakDbtp * 10) / 10,
    crestDb: crestDb !== null ? Math.round(crestDb * 10) / 10 : null,
    phaseCorr: phaseCorr !== null ? Math.round(phaseCorr * 100) / 100 : null,
    momentaryLufs: integratedLufs !== null ? Math.round(integratedLufs * 10) / 10 : null,
    integratedLufs: integratedLufs !== null ? Math.round(integratedLufs * 10) / 10 : null,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  if (message.type === "OFFSCREEN_START") {
    startCapture(message.tabId, message.streamId, message.fftSize)
      .then(() => sendResponse({ ok: true, sampleRate, fftSize: currentFftSize }))
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

  if (message.type === "OFFSCREEN_SET_FFT_SIZE") {
    const applied = setFftSize(message.fftSize);
    sendResponse({ ok: true, fftSize: applied });
    return;
  }

  if (message.type === "OFFSCREEN_GET_STATE") {
    sendResponse(
      latestFrame
        ? { ...latestFrame, wfHistory }
        : {
            capturing: Boolean(mediaStream),
            tabId: capturedTabId,
            fftSize: currentFftSize,
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

  if (message.type === "OFFSCREEN_SCAN_FULL") {
    scanFullTrack(message.tabId, message.url, message.nativeSampleRate || 0, message.fftSize)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) })
      );
    return true;
  }
});
