let cachedTabs = [];
let onlyAudible = false;

// Manage multiple concurrent FFT spectral probes (live local, remote popup, and offline full-scan)
const probes = new Map(); // probeId -> SpectralProbe
let sharedAudioCtx = null;
let nextProbeSeq = 1;
let pendingLinkTabId = null;

// Unified loops for all active probes
let rafId = null;
let lastRenderTs = 0;
let analysisTimer = null;

const FFT_SIZE = 8192;
const TIME_FFT_SIZE = 2048;
const ANALYSIS_MS = 120;
const DISPLAY_BINS = 112;

const MIN_DB = -105;
const MAX_DB = -15;
const ATTACK_SPEED = 36;
const DECAY_SPEED = 14;
const PEAK_FALL_DB_PER_SEC = 26;
const ABS_GATE_POWER = Math.pow(10, (-70 + 0.691) / 10);

const ISO_31_BANDS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
  12500, 16000, 20000,
];
const LOG_31_LABELS = [
  "20", "", "", "40", "50", "", "80", "100", "", "160", "200", "", "315", "400", "",
  "630", "800", "", "1.2k", "1.6k", "", "2.5k", "3.1k", "", "5k", "6.3k", "", "10k",
  "12k", "16k", "20k",
];

const WF_WIDTH = 540;
const WF_HEIGHT = 204;
const WF_COLS_PER_SEC = 28;
const WF_MAX_DB = -24;
const WF_GAMMA = 0.72;

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function formatDurationPrecise(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1).padStart(4, "0");
  return `${m}:${rem}`;
}

function buildPaletteLut(stops) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s0 = stops[0];
    let s1 = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k].t && t <= stops[k + 1].t) {
        s0 = stops[k];
        s1 = stops[k + 1];
        break;
      }
    }
    const f = s1.t > s0.t ? (t - s0.t) / (s1.t - s0.t) : 0;
    lut[i * 3] = Math.round(s0.r + (s1.r - s0.r) * f);
    lut[i * 3 + 1] = Math.round(s0.g + (s1.g - s0.g) * f);
    lut[i * 3 + 2] = Math.round(s0.b + (s1.b - s0.b) * f);
  }
  return lut;
}

const WF_PALETTES = {
  inferno: {
    lut: buildPaletteLut([
      { t: 0.0, r: 24, g: 24, b: 24 },
      { t: 0.14, r: 44, g: 24, b: 92 },
      { t: 0.32, r: 126, g: 30, b: 142 },
      { t: 0.52, r: 212, g: 54, b: 86 },
      { t: 0.72, r: 248, g: 132, b: 36 },
      { t: 0.88, r: 254, g: 214, b: 68 },
      { t: 1.0, r: 255, g: 253, b: 238 },
    ]),
    legend: [
      [0.0, "rgb(255,253,238)"],
      [0.12, "rgb(254,214,68)"],
      [0.28, "rgb(248,132,36)"],
      [0.48, "rgb(212,54,86)"],
      [0.68, "rgb(126,30,142)"],
      [0.86, "rgb(44,24,92)"],
      [1.0, "rgb(24,24,24)"],
    ],
  },
  foobar: {
    lut: buildPaletteLut([
      { t: 0.0, r: 24, g: 24, b: 24 },
      { t: 0.16, r: 22, g: 48, b: 102 },
      { t: 0.38, r: 34, g: 106, b: 184 },
      { t: 0.62, r: 66, g: 178, b: 232 },
      { t: 0.84, r: 168, g: 226, b: 252 },
      { t: 1.0, r: 255, g: 255, b: 255 },
    ]),
    legend: [
      [0.0, "rgb(255,255,255)"],
      [0.16, "rgb(168,226,252)"],
      [0.38, "rgb(66,178,232)"],
      [0.62, "rgb(34,106,184)"],
      [0.84, "rgb(22,48,102)"],
      [1.0, "rgb(24,24,24)"],
    ],
  },
  spek: {
    lut: buildPaletteLut([
      { t: 0.0, r: 24, g: 24, b: 24 },
      { t: 0.14, r: 22, g: 42, b: 128 },
      { t: 0.32, r: 20, g: 148, b: 198 },
      { t: 0.5, r: 38, g: 192, b: 102 },
      { t: 0.68, r: 238, g: 212, b: 42 },
      { t: 0.85, r: 236, g: 68, b: 36 },
      { t: 1.0, r: 255, g: 255, b: 255 },
    ]),
    legend: [
      [0.0, "rgb(255,255,255)"],
      [0.15, "rgb(236,68,36)"],
      [0.32, "rgb(238,212,42)"],
      [0.5, "rgb(38,192,102)"],
      [0.68, "rgb(20,148,198)"],
      [0.86, "rgb(22,42,128)"],
      [1.0, "rgb(24,24,24)"],
    ],
  },
  viridis: {
    lut: buildPaletteLut([
      { t: 0.0, r: 24, g: 24, b: 24 },
      { t: 0.18, r: 62, g: 46, b: 118 },
      { t: 0.38, r: 46, g: 120, b: 148 },
      { t: 0.58, r: 36, g: 174, b: 138 },
      { t: 0.78, r: 132, g: 216, b: 84 },
      { t: 1.0, r: 254, g: 234, b: 42 },
    ]),
    legend: [
      [0.0, "rgb(254,234,42)"],
      [0.22, "rgb(132,216,84)"],
      [0.42, "rgb(36,174,138)"],
      [0.62, "rgb(46,120,148)"],
      [0.82, "rgb(62,46,118)"],
      [1.0, "rgb(24,24,24)"],
    ],
  },
  mono: {
    lut: buildPaletteLut([
      { t: 0.0, r: 24, g: 24, b: 24 },
      { t: 0.26, r: 66, g: 80, b: 96 },
      { t: 0.54, r: 120, g: 142, b: 164 },
      { t: 0.8, r: 188, g: 208, b: 228 },
      { t: 1.0, r: 250, g: 253, b: 255 },
    ]),
    legend: [
      [0.0, "rgb(250,253,255)"],
      [0.2, "rgb(188,208,228)"],
      [0.46, "rgb(120,142,164)"],
      [0.74, "rgb(66,80,96)"],
      [1.0, "rgb(24,24,24)"],
    ],
  },
};

function mapDbToLutIndex(db, floorDb) {
  const span = WF_MAX_DB - floorDb;
  const linear = Math.max(0, Math.min(1, (db - floorDb) / span));
  if (linear <= 0) return 0;
  return Math.round(Math.pow(linear, WF_GAMMA) * 255);
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isKnownLossyCodec(codec) {
  const c = (codec || "").toUpperCase();
  return (
    c === "AAC-LC" ||
    c === "AAC" ||
    c === "HE-AAC" ||
    c === "HE-AAC V2" ||
    c === "OPUS" ||
    c === "VORBIS" ||
    c === "MP3" ||
    c === "DOLBY DIGITAL" ||
    c === "DOLBY DIGITAL+"
  );
}

function isKnownLosslessCodec(codec) {
  const c = (codec || "").toUpperCase();
  return c === "FLAC" || c === "WAV";
}

function syncCanvasDpr(canvasEl, context, fallbackW, fallbackH) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvasEl.clientWidth || fallbackW;
  const cssH = canvasEl.clientHeight || fallbackH;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvasEl.width !== targetW || canvasEl.height !== targetH) {
    canvasEl.width = targetW;
    canvasEl.height = targetH;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cssW, h: cssH };
}

function percentile(arr, p) {
  if (!arr.length) return -140;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

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

  const relGatePower = (sumAbs / countAbs) * 0.1;
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

function detectCutoffHz(holdArr, sr) {
  const binHz = sr / FFT_SIZE;
  const nyquist = sr / 2;

  const midStart = Math.floor(2000 / binHz);
  const midEnd = Math.min(holdArr.length - 1, Math.floor(8000 / binHz));
  const midVals = [];
  for (let i = midStart; i <= midEnd; i++) midVals.push(holdArr[i]);
  const refDb = percentile(midVals, 0.8);
  if (refDb < -72) return { cutoffHz: null, refDb, isBrickwall: false };

  let noiseFloorDb = -104;
  if (nyquist >= 23500) {
    const nfStart = Math.floor(22500 / binHz);
    const nfEnd = Math.min(holdArr.length - 1, Math.floor((nyquist - 150) / binHz));
    const nfVals = [];
    for (let i = nfStart; i <= nfEnd; i++) nfVals.push(holdArr[i]);
    if (nfVals.length > 0) {
      noiseFloorDb = Math.max(-115, Math.min(-88, percentile(nfVals, 0.5)));
    }
  }

  const floorThreshold = noiseFloorDb + 6.5;
  const threshold = Math.max(refDb - 62, floorThreshold);

  const stepHz = 200;
  const bands = [];

  for (let f = 8000; f <= nyquist - stepHz; f += stepHz) {
    const bStart = Math.floor(f / binHz);
    const bEnd = Math.min(holdArr.length - 1, Math.floor((f + stepHz) / binHz));
    const slice = [];
    for (let i = bStart; i <= bEnd; i++) slice.push(holdArr[i]);
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

function downsampleToArray(srcArr, outCount, reuseArr) {
  const out = reuseArr && reuseArr.length === outCount ? reuseArr : new Float32Array(outCount);
  const binCount = srcArr.length;
  const step = binCount / outCount;

  for (let i = 0; i < outCount; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(binCount, Math.max(start + 1, Math.floor((i + 1) * step)));
    let maxVal = -140;
    for (let j = start; j < end; j++) {
      if (srcArr[j] > maxVal) maxVal = srcArr[j];
    }
    out[i] = maxVal;
  }
  return out;
}

function computeLog31ToArray(srcArr, sr, reuseArr) {
  const n = ISO_31_BANDS.length;
  const out = reuseArr && reuseArr.length === n ? reuseArr : new Float32Array(n);
  const binHz = sr / FFT_SIZE;
  const maxIdx = srcArr.length - 1;
  const halfStep = Math.pow(2, 1 / 6);

  for (let i = 0; i < n; i++) {
    const fc = ISO_31_BANDS[i];
    const fLow = fc / halfStep;
    const fHigh = fc * halfStep;
    const bStart = Math.max(1, Math.min(maxIdx, Math.floor(fLow / binHz)));
    const bEnd = Math.max(bStart, Math.min(maxIdx, Math.ceil(fHigh / binHz)));

    let maxVal = -140;
    for (let b = bStart; b <= bEnd; b++) {
      if (srcArr[b] > maxVal) maxVal = srcArr[b];
    }
    out[i] = maxVal;
  }
  return out;
}

function updateBottomStatusBar() {
  const audibleCount = cachedTabs.filter((t) => t.audible).length;
  const trackedTabs = cachedTabs.filter((t) => t.telemetry);
  const topBitrate = trackedTabs.reduce(
    (max, t) => Math.max(max, t.telemetry?.avgKbps || 0),
    0
  );
  const srText = sharedAudioCtx ? `${sharedAudioCtx.sampleRate} Hz` : "48000 Hz";
  document.getElementById("dashStatusLeft").textContent =
    `Audible: ${audibleCount} | Streams: ${trackedTabs.length} | FFT Probes: ${probes.size} | Peak: ${topBitrate ? `${topBitrate} kbps` : "—"}`;
  document.getElementById("dashStatusRight").textContent =
    `FFT ${FFT_SIZE}-pt | ${srText} | BS.1770-4 LUFS | Stereo Phase | Spek Waterfall`;
}

// ---------- SpectralProbe ----------

class SpectralProbe {
  constructor(options) {
    this.id = options.id;
    this.seq = options.seq || 0;
    this.isRemote = Boolean(options.isRemote);
    this.isFullScan = Boolean(options.isFullScan);
    this.fullScanData = options.fullScanData || null;
    this.rawLabel = options.rawLabel || "Tab audio";
    this.linkedTabId = options.linkedTabId ?? null;
    this.spectrumScale = "lin";

    this.stream = options.stream || null;
    this.audioNodes = options.audioNodes || [];
    this.analyser = options.analyser || null;
    this.analyserL = options.analyserL || null;
    this.analyserR = options.analyserR || null;
    this.kAnalyserL = options.kAnalyserL || null;
    this.kAnalyserR = options.kAnalyserR || null;
    this.sampleRate = options.sampleRate || 48000;

    if (this.analyser) {
      const bins = this.analyser.frequencyBinCount;
      this.freqData = new Float32Array(bins);
      this.timeDataL = new Float32Array(TIME_FFT_SIZE);
      this.timeDataR = new Float32Array(TIME_FFT_SIZE);
      this.kTimeDataL = new Float32Array(TIME_FFT_SIZE);
      this.kTimeDataR = new Float32Array(TIME_FFT_SIZE);
      this.maxHold = new Float32Array(bins).fill(-140);
    } else {
      this.freqData = null;
      this.timeDataL = null;
      this.timeDataR = null;
      this.kTimeDataL = null;
      this.kTimeDataR = null;
      this.maxHold = null;
    }

    this.totalFrames = 0;
    this.activeFrames = 0;
    this.overallMaxDb = -160;
    this.cutoffHz = null;
    this.isBrickwall = false;
    this.activeSeconds = 0;
    this.drmSilentWarning = false;

    this.rawPeakL = -100;
    this.rawPeakR = -100;
    this.rawRmsL = -100;
    this.rawRmsR = -100;
    this.truePeakDbtp = -100;
    this.crestDb = null;
    this.phaseCorr = null;
    this.momentaryLufs = null;
    this.integratedLufs = null;
    this.momentaryBlocks = [];
    this.gatedBlocks = [];

    this.smoothPeakL = -100;
    this.smoothPeakR = -100;
    this.smoothRmsL = -100;
    this.smoothRmsR = -100;
    this.heldPeakL = -100;
    this.heldPeakR = -100;
    this.smoothPhase = 0;
    this.hasPhase = false;

    this.remoteTarget = null;
    this.lastRemoteTs = 0;
    this.lastRemoteActiveSec = 0;

    this.lastTrackKey = "";

    this.smoothLive = null;
    this.smoothMax = null;
    this.peakCaps = null;
    this.smoothCutoffHz = null;
    this.scratchLiveBins = new Float32Array(DISPLAY_BINS);
    this.scratchMaxBins = new Float32Array(DISPLAY_BINS);
    this.scratchLogLive = new Float32Array(ISO_31_BANDS.length);
    this.scratchLogMax = new Float32Array(ISO_31_BANDS.length);

    this.wfCanvas = document.createElement("canvas");
    this.wfCanvas.width = WF_WIDTH;
    this.wfCanvas.height = WF_HEIGHT;
    this.wfCtx = this.wfCanvas.getContext("2d");
    this.wfColImg = this.wfCtx.createImageData(1, WF_HEIGHT);
    this.wfFullImg = this.wfCtx.createImageData(WF_WIDTH, WF_HEIGHT);
    this.wfDbBuffer = new Float32Array(WF_WIDTH * WF_HEIGHT).fill(-140);
    this.wfColRaw = new Float32Array(WF_HEIGHT);
    this.wfPendingBins = null;
    this.wfAccumSec = 0;
    this.wfHasData = false;
    this.wfPaletteName = "inferno";
    this.wfMinDb = -105;
    this.wfHover = { active: false, normX: 0, normY: 0 };

    this.clearWaterfall();
    this._buildDom();
    this.syncTabLinkOptions();
    this.updateHeaderTitle();

    if (this.isFullScan && this.fullScanData) {
      this.applyFullScanData(this.fullScanData);
    }
  }

  _buildDom() {
    const el = document.createElement("div");
    el.className = "probe-card";
    el.dataset.probeId = this.id;

    const badgeText = this.isFullScan ? "FULL SCAN" : this.isRemote ? "POPUP" : `#${this.seq}`;
    const badgeClass = this.isFullScan
      ? "probe-badge is-fullscan"
      : this.isRemote
      ? "probe-badge is-popup"
      : "probe-badge";

    el.innerHTML = `
      <div class="probe-head">
        <div class="probe-title-wrap">
          <span class="${badgeClass}">${badgeText}</span>
          <div class="probe-name js-probe-name"></div>
        </div>
        <div class="probe-controls">
          ${
            this.isRemote || this.isFullScan
              ? ""
              : `<select class="probe-link-select js-link-select" title="Link to a tab to display track name & cross-check Layer 1 bitrate"></select>`
          }
          ${this.isFullScan ? "" : `<button class="btn-ghost btn-sm js-probe-reset">Reset</button>`}
          <button class="btn-danger btn-sm js-probe-stop">${this.isFullScan ? "Close" : "Stop"}</button>
        </div>
      </div>

      <div class="probe-body">
        <div class="dual-charts">
          <div class="chart-pane">
            <div class="chart-pane-head">
              <span>Spectrum (FFT + Max-Hold)</span>
              <div class="seg-group" title="Switch frequency axis scale">
                <button class="seg-btn active js-scale-lin">LIN</button>
                <button class="seg-btn js-scale-log">LOG</button>
              </div>
            </div>
            <canvas class="probe-canvas js-bar-canvas" width="540" height="182"></canvas>
            <canvas class="probe-meter-canvas js-meter-canvas" width="540" height="38"></canvas>
          </div>
          <div class="chart-pane">
            <div class="chart-pane-head">
              <span class="js-wf-title">Waterfall Spectrogram (Spek)</span>
              <div class="pane-head-tools">
                <select class="win-select js-wf-palette" title="Waterfall color palette">
                  <option value="inferno" selected>Inferno</option>
                  <option value="foobar">Foobar</option>
                  <option value="spek">Spek</option>
                  <option value="viridis">Viridis</option>
                  <option value="mono">Mono</option>
                </select>
                <select class="win-select js-wf-floor" title="Dynamic noise floor (dB)">
                  <option value="-90">-90 dB</option>
                  <option value="-105" selected>-105 dB</option>
                  <option value="-120">-120 dB</option>
                </select>
              </div>
            </div>
            <canvas class="probe-wf-canvas js-wf-canvas" width="540" height="220"></canvas>
          </div>
        </div>

        <div class="fft-meta">
          <div class="fft-meta-item">Cutoff: <strong class="js-cutoff">—</strong></div>
          <div class="fft-meta-item">Sample: <strong class="js-sample-time">0.0s</strong></div>
          <div class="fft-meta-item js-bitrate-ref">Layer 1: <strong>Unlinked</strong></div>
          <div class="fft-meta-item">Rate: <strong class="js-sr">${(this.sampleRate / 1000).toFixed(1)} kHz</strong></div>
        </div>

        <div class="verdict js-verdict">Starting spectral analysis...</div>
      </div>
    `;

    this.el = el;
    this.nameEl = el.querySelector(".js-probe-name");
    this.wfTitleEl = el.querySelector(".js-wf-title");
    this.linkSelectEl = el.querySelector(".js-link-select");
    this.btnLin = el.querySelector(".js-scale-lin");
    this.btnLog = el.querySelector(".js-scale-log");
    this.barCanvas = el.querySelector(".js-bar-canvas");
    this.barCtx = this.barCanvas.getContext("2d");
    this.meterCanvas = el.querySelector(".js-meter-canvas");
    this.meterCtx = this.meterCanvas.getContext("2d");
    this.wfViewCanvas = el.querySelector(".js-wf-canvas");
    this.wfViewCtx = this.wfViewCanvas.getContext("2d");
    this.cutoffEl = el.querySelector(".js-cutoff");
    this.sampleTimeEl = el.querySelector(".js-sample-time");
    this.bitrateRefEl = el.querySelector(".js-bitrate-ref");
    this.srEl = el.querySelector(".js-sr");
    this.verdictEl = el.querySelector(".js-verdict");

    this.btnLin.addEventListener("click", () => this.setSpectrumScale("lin"));
    this.btnLog.addEventListener("click", () => this.setSpectrumScale("log"));

    el.querySelector(".js-wf-palette").addEventListener("change", (e) => {
      this.wfPaletteName = e.target.value;
      this.repaintWaterfallFromDbBuffer();
      if (this.isFullScan) this.renderFullScanStatic();
    });

    el.querySelector(".js-wf-floor").addEventListener("change", (e) => {
      this.wfMinDb = Number(e.target.value) || -105;
      this.repaintWaterfallFromDbBuffer();
      if (this.isFullScan) this.renderFullScanStatic();
    });

    this._onWfMouseMove = (e) => {
      const rect = this.wfViewCanvas.getBoundingClientRect();
      const { padLeft, padTop, plotW, plotH } = this._getWaterfallLayout(rect.width, rect.height);
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (mx >= padLeft && mx <= padLeft + plotW && my >= padTop && my <= padTop + plotH) {
        this.wfHover.active = true;
        this.wfHover.normX = Math.max(0, Math.min(1, (mx - padLeft) / plotW));
        this.wfHover.normY = Math.max(0, Math.min(1, (my - padTop) / plotH));
      } else {
        this.wfHover.active = false;
      }
      if (this.isFullScan) {
        this.drawWaterfallChart(this.sampleRate / 2);
      }
    };

    this._onWfMouseLeave = () => {
      this.wfHover.active = false;
      if (this.isFullScan) {
        this.drawWaterfallChart(this.sampleRate / 2);
      }
    };

    this.wfViewCanvas.addEventListener("mousemove", this._onWfMouseMove);
    this.wfViewCanvas.addEventListener("mouseleave", this._onWfMouseLeave);

    if (this.linkSelectEl) {
      this.linkSelectEl.addEventListener("change", () => {
        const val = this.linkSelectEl.value;
        this.linkedTabId = val ? Number(val) : null;
        this.lastTrackKey = this._getCurrentLinkedTrackKey();
        this.updateHeaderTitle();
        this.updateTextUi();
        renderTabs(cachedTabs);
      });
    }

    const resetBtn = el.querySelector(".js-probe-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        this.resetAll();
        if (this.isRemote) {
          chrome.runtime.sendMessage({ target: "background", type: "RESET_FFT" });
        }
      });
    }

    el.querySelector(".js-probe-stop").addEventListener("click", () => {
      if (this.isRemote) {
        chrome.runtime.sendMessage({ target: "background", type: "STOP_FFT" });
      }
      removeProbe(this.id);
    });
  }

  applyFullScanData(resp) {
    this.isFullScan = true;
    this.fullScanData = resp;
    this.sampleRate = resp.sampleRate || 48000;
    this.cutoffHz = resp.cutoffHz ?? null;
    this.smoothCutoffHz = resp.cutoffHz ?? null;
    this.isBrickwall = Boolean(resp.isBrickwall);
    this.activeSeconds = resp.duration || resp.activeSeconds || 0;

    this.smoothPeakL = resp.peakLDbfs ?? -100;
    this.smoothPeakR = resp.peakRDbfs ?? -100;
    this.smoothRmsL = resp.rmsLDbfs ?? -100;
    this.smoothRmsR = resp.rmsRDbfs ?? -100;
    this.heldPeakL = this.smoothPeakL;
    this.heldPeakR = this.smoothPeakR;
    this.truePeakDbtp = resp.truePeakDbtp ?? -100;
    this.crestDb = resp.crestDb ?? null;
    this.phaseCorr = resp.phaseCorr ?? null;
    this.smoothPhase = resp.phaseCorr ?? 0;
    this.hasPhase = resp.phaseCorr != null;
    this.momentaryLufs = resp.momentaryLufs ?? null;
    this.integratedLufs = resp.integratedLufs ?? null;

    this.wfTitleEl.textContent = `Full-Track Spectrogram (0:00 → ${formatDuration(resp.duration)})`;
    this.loadFullScanWaterfall(resp.wfCols);
    this.updateTextUi();
    this.renderFullScanStatic();
  }

  loadFullScanWaterfall(wfCols) {
    this.wfDbBuffer.fill(-140);
    if (!Array.isArray(wfCols) || !wfCols.length) {
      this.clearWaterfall();
      return;
    }

    const numSrcCols = wfCols.length;
    for (let col = 0; col < WF_WIDTH; col++) {
      const srcIdx = Math.min(numSrcCols - 1, Math.floor((col / WF_WIDTH) * numSrcCols));
      const freqArr = wfCols[srcIdx];
      const srcLen = freqArr.length;

      for (let y = 0; y < WF_HEIGHT; y++) {
        const freqTop = 1 - y / WF_HEIGHT;
        const freqBot = 1 - (y + 1) / WF_HEIGHT;
        const bStart = Math.max(0, Math.floor(freqBot * (srcLen - 1)));
        const bEnd = Math.min(srcLen - 1, Math.max(bStart, Math.ceil(freqTop * (srcLen - 1))));
        let maxDb = -140;
        for (let b = bStart; b <= bEnd; b++) {
          if (freqArr[b] > maxDb) maxDb = freqArr[b];
        }
        this.wfColRaw[y] = maxDb;
      }

      const colOffset = col * WF_HEIGHT;
      for (let y = 0; y < WF_HEIGHT; y++) {
        let db = this.wfColRaw[y];
        if (y > 0 && this.wfColRaw[y - 1] - 3.5 > db) db = this.wfColRaw[y - 1] - 3.5;
        if (y < WF_HEIGHT - 1 && this.wfColRaw[y + 1] - 3.5 > db) db = this.wfColRaw[y + 1] - 3.5;
        this.wfDbBuffer[colOffset + y] = db;
      }
    }

    this.wfHasData = true;
    this.repaintWaterfallFromDbBuffer();
  }

  renderFullScanStatic() {
    if (!this.fullScanData) return;
    const r = this.fullScanData;
    const nyquist = this.sampleRate / 2;
    this.smoothLive = Float32Array.from(
      this.spectrumScale === "log" ? r.logLiveBins : r.liveBins
    );
    this.smoothMax = Float32Array.from(
      this.spectrumScale === "log" ? r.logMaxBins : r.maxBins
    );
    this.peakCaps = null;

    this.drawBarsChart(nyquist);
    this.drawLevelMeter();
    this.drawWaterfallChart(nyquist);
  }

  setSpectrumScale(scale) {
    this.spectrumScale = scale;
    this.btnLin.classList.toggle("active", scale === "lin");
    this.btnLog.classList.toggle("active", scale === "log");
    this.smoothLive = null;
    this.smoothMax = null;
    this.peakCaps = null;
    if (this.isFullScan) {
      this.renderFullScanStatic();
    }
  }

  getLinkedTab() {
    if (this.linkedTabId == null) return null;
    return cachedTabs.find((t) => t.tabId === this.linkedTabId) || null;
  }

  _getCurrentLinkedTrackKey() {
    const tab = this.getLinkedTab();
    const t = tab?.telemetry;
    if (!t?.trackTitle) return "";
    return `${t.trackTitle}::${t.trackArtist || ""}`;
  }

  syncTabLinkOptions() {
    if (!this.linkSelectEl) return;

    const currentVal = this.linkedTabId != null ? String(this.linkedTabId) : "";
    const options = [`<option value="">-- Link to tab (optional) --</option>`];
    let stillExists = false;

    for (const tab of cachedTabs) {
      const idStr = String(tab.tabId);
      if (idStr === currentVal) stillExists = true;
      const t = tab.telemetry;
      const rateSuffix = t && t.avgKbps > 0 ? ` ${t.avgKbps}k` : "";
      const suffix = t ? ` [${t.codec}${rateSuffix}]` : tab.audible ? " [LIVE]" : "";
      const shortTitle =
        tab.title.length > 34 ? `${tab.title.slice(0, 34)}…` : tab.title;
      options.push(`<option value="${idStr}">${esc(shortTitle + suffix)}</option>`);
    }

    if (currentVal && !stillExists) {
      this.linkedTabId = null;
    }

    this.linkSelectEl.innerHTML = options.join("");
    this.linkSelectEl.value = this.linkedTabId != null ? String(this.linkedTabId) : "";
  }

  checkTrackChange() {
    if (this.isRemote || this.isFullScan || this.linkedTabId == null) return;
    const key = this._getCurrentLinkedTrackKey();
    if (!key) return;

    if (!this.lastTrackKey) {
      this.lastTrackKey = key;
      return;
    }

    if (key !== this.lastTrackKey) {
      this.lastTrackKey = key;
      this.resetMaxHoldOnly();
      this.drawWaterfallDivider();
      this.updateHeaderTitle();
    }
  }

  updateHeaderTitle() {
    const tab = this.getLinkedTab();
    if (tab) {
      const track = tab.telemetry?.trackTitle
        ? `${tab.telemetry.trackTitle}${tab.telemetry.trackArtist ? ` — ${tab.telemetry.trackArtist}` : ""}`
        : tab.title;
      this.nameEl.textContent = track;
      this.nameEl.title = `${tab.title}${tab.telemetry?.trackTitle ? ` (${track})` : ""}`;
    } else {
      this.nameEl.textContent = this.isFullScan
        ? `${this.rawLabel} (Offline Full Scan)`
        : this.isRemote
        ? `Tab #${this.linkedTabId ?? "?"} (via Popup)`
        : `${this.rawLabel} (Probe #${this.seq})`;
      this.nameEl.title = this.nameEl.textContent;
    }
  }

  clearWaterfall() {
    this.wfDbBuffer.fill(-140);
    this.wfPendingBins = null;
    this.wfCtx.fillStyle = "#181818";
    this.wfCtx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
    this.wfAccumSec = 0;
    this.wfHasData = false;
  }

  repaintWaterfallFromDbBuffer() {
    if (!this.wfHasData) {
      this.wfCtx.fillStyle = "#181818";
      this.wfCtx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
      return;
    }

    const lut = (WF_PALETTES[this.wfPaletteName] || WF_PALETTES.inferno).lut;
    const data = this.wfFullImg.data;

    for (let col = 0; col < WF_WIDTH; col++) {
      const colOffset = col * WF_HEIGHT;
      for (let y = 0; y < WF_HEIGHT; y++) {
        const db = this.wfDbBuffer[colOffset + y];
        const idx = mapDbToLutIndex(db, this.wfMinDb) * 3;
        const p = (y * WF_WIDTH + col) * 4;
        data[p] = lut[idx];
        data[p + 1] = lut[idx + 1];
        data[p + 2] = lut[idx + 2];
        data[p + 3] = 255;
      }
    }

    this.wfCtx.putImageData(this.wfFullImg, 0, 0);
  }

  drawWaterfallDivider() {
    if (!this.wfHasData) return;
    this.wfDbBuffer.copyWithin(0, WF_HEIGHT * 2);
    this.wfDbBuffer.fill(-140, (WF_WIDTH - 2) * WF_HEIGHT);
    this.wfCtx.drawImage(this.wfCanvas, -2, 0);
    this.wfCtx.fillStyle = "#3399ff";
    this.wfCtx.fillRect(WF_WIDTH - 2, 0, 2, WF_HEIGHT);
  }

  _accumulateWaterfallBins(freqArr) {
    if (!freqArr) return;
    if (!this.wfPendingBins || this.wfPendingBins.length !== freqArr.length) {
      this.wfPendingBins = Float32Array.from(freqArr);
    } else {
      for (let i = 0; i < freqArr.length; i++) {
        if (freqArr[i] > this.wfPendingBins[i]) {
          this.wfPendingBins[i] = freqArr[i];
        }
      }
    }
  }

  pushWaterfallColumn(freqArr) {
    if (!freqArr || !freqArr.length) return;
    const srcLen = freqArr.length;
    const data = this.wfColImg.data;
    const lut = (WF_PALETTES[this.wfPaletteName] || WF_PALETTES.inferno).lut;

    for (let y = 0; y < WF_HEIGHT; y++) {
      const freqTop = 1 - y / WF_HEIGHT;
      const freqBot = 1 - (y + 1) / WF_HEIGHT;
      const bStart = Math.max(0, Math.floor(freqBot * (srcLen - 1)));
      const bEnd = Math.min(srcLen - 1, Math.max(bStart, Math.ceil(freqTop * (srcLen - 1))));

      let maxDb = -140;
      for (let b = bStart; b <= bEnd; b++) {
        if (freqArr[b] > maxDb) maxDb = freqArr[b];
      }
      this.wfColRaw[y] = maxDb;
    }

    this.wfDbBuffer.copyWithin(0, WF_HEIGHT);
    const newestColOffset = (WF_WIDTH - 1) * WF_HEIGHT;

    for (let y = 0; y < WF_HEIGHT; y++) {
      let db = this.wfColRaw[y];
      if (y > 0 && this.wfColRaw[y - 1] - 3.5 > db) db = this.wfColRaw[y - 1] - 3.5;
      if (y < WF_HEIGHT - 1 && this.wfColRaw[y + 1] - 3.5 > db) db = this.wfColRaw[y + 1] - 3.5;

      this.wfDbBuffer[newestColOffset + y] = db;

      const idx = mapDbToLutIndex(db, this.wfMinDb) * 3;
      const p = y * 4;
      data[p] = lut[idx];
      data[p + 1] = lut[idx + 1];
      data[p + 2] = lut[idx + 2];
      data[p + 3] = 255;
    }

    this.wfCtx.drawImage(this.wfCanvas, -1, 0);
    this.wfCtx.putImageData(this.wfColImg, WF_WIDTH - 1, 0);
    this.wfHasData = true;
  }

  resetAnimBuffers() {
    this.smoothLive = null;
    this.smoothMax = null;
    this.peakCaps = null;
    this.smoothCutoffHz = null;
    this.smoothPeakL = -100;
    this.smoothPeakR = -100;
    this.smoothRmsL = -100;
    this.smoothRmsR = -100;
    this.heldPeakL = -100;
    this.heldPeakR = -100;
    this.smoothPhase = 0;
    this.hasPhase = false;
  }

  resetMaxHoldOnly() {
    if (this.analyser) {
      this.maxHold = new Float32Array(this.analyser.frequencyBinCount).fill(-140);
    }
    this.totalFrames = 0;
    this.activeFrames = 0;
    this.overallMaxDb = -160;
    this.cutoffHz = null;
    this.isBrickwall = false;
    this.activeSeconds = 0;
    this.crestDb = null;
    this.phaseCorr = null;
    this.momentaryLufs = null;
    this.integratedLufs = null;
    this.momentaryBlocks = [];
    this.gatedBlocks = [];
    this.smoothMax = null;
    this.smoothCutoffHz = null;
  }

  resetAll() {
    this.resetMaxHoldOnly();
    this.resetAnimBuffers();
    this.clearWaterfall();
    this.updateTextUi();
  }

  ingestRemoteFrame(payload) {
    if (payload.activeSeconds < this.lastRemoteActiveSec - 0.5) {
      this.resetAnimBuffers();
      this.clearWaterfall();
    }
    this.lastRemoteActiveSec = payload.activeSeconds || 0;
    this.remoteTarget = payload;
    this.lastRemoteTs = performance.now();
    this.sampleRate = payload.sampleRate || 48000;
    this.activeSeconds = payload.activeSeconds || 0;
    this.cutoffHz = payload.cutoffHz ?? null;
    this.isBrickwall = Boolean(payload.isBrickwall);
    this.drmSilentWarning = Boolean(payload.drmSilentWarning);

    this.rawPeakL = payload.peakLDbfs ?? payload.peakDbfs ?? -100;
    this.rawPeakR = payload.peakRDbfs ?? payload.peakDbfs ?? -100;
    this.rawRmsL = payload.rmsLDbfs ?? payload.rmsDbfs ?? -100;
    this.rawRmsR = payload.rmsRDbfs ?? payload.rmsDbfs ?? -100;
    this.truePeakDbtp = payload.truePeakDbtp ?? Math.max(this.rawPeakL, this.rawPeakR);
    this.crestDb = payload.crestDb ?? null;
    this.phaseCorr = payload.phaseCorr ?? null;
    this.momentaryLufs = payload.momentaryLufs ?? null;
    this.integratedLufs = payload.integratedLufs ?? null;

    if (payload.liveBins) {
      this._accumulateWaterfallBins(payload.liveBins);
    }

    if (payload.tabId != null && payload.tabId !== this.linkedTabId) {
      this.linkedTabId = payload.tabId;
      this.updateHeaderTitle();
    }
  }

  _updateLocalStereoAndLoudness() {
    if (!this.analyserL || !this.analyserR || !this.timeDataL || !this.timeDataR) return;
    this.analyserL.getFloatTimeDomainData(this.timeDataL);
    this.analyserR.getFloatTimeDomainData(this.timeDataR);

    const n = this.timeDataL.length;
    let sumSqL = 0;
    let sumSqR = 0;
    let sumLR = 0;
    let peakL = 0;
    let peakR = 0;

    for (let i = 0; i < n; i++) {
      const l = this.timeDataL[i];
      const r = this.timeDataR[i];
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
    const tpAbs = Math.max(
      estimateTruePeakAbs(this.timeDataL),
      estimateTruePeakAbs(this.timeDataR)
    );

    this.rawPeakL = peakL > 1e-7 ? 20 * Math.log10(peakL) : -140;
    this.rawPeakR = peakR > 1e-7 ? 20 * Math.log10(peakR) : -140;
    this.rawRmsL = rmsL > 1e-7 ? 20 * Math.log10(rmsL) : -140;
    this.rawRmsR = rmsR > 1e-7 ? 20 * Math.log10(rmsR) : -140;
    this.truePeakDbtp = tpAbs > 1e-7 ? 20 * Math.log10(tpAbs) : -140;

    const peakDbfs = peakMono > 1e-7 ? 20 * Math.log10(peakMono) : -140;
    const rmsDbfs = rmsMono > 1e-7 ? 20 * Math.log10(rmsMono) : -140;

    if (rmsDbfs > -55 && peakDbfs > -50) {
      const instantCrest = Math.max(0, Math.min(35, peakDbfs - rmsDbfs));
      this.crestDb =
        this.crestDb === null ? instantCrest : this.crestDb + (instantCrest - this.crestDb) * 0.08;
    }

    const denom = Math.sqrt(sumSqL * sumSqR);
    if (denom > 1e-9 && rmsDbfs > -62) {
      const corr = Math.max(-1, Math.min(1, sumLR / denom));
      this.phaseCorr =
        this.phaseCorr === null ? corr : this.phaseCorr + (corr - this.phaseCorr) * 0.22;
    }

    if (this.kAnalyserL && this.kAnalyserR && this.kTimeDataL && this.kTimeDataR) {
      this.kAnalyserL.getFloatTimeDomainData(this.kTimeDataL);
      this.kAnalyserR.getFloatTimeDomainData(this.kTimeDataR);
      let kSumL = 0;
      let kSumR = 0;
      const kn = this.kTimeDataL.length;
      for (let i = 0; i < kn; i++) {
        kSumL += this.kTimeDataL[i] * this.kTimeDataL[i];
        kSumR += this.kTimeDataR[i] * this.kTimeDataR[i];
      }
      const zFrame = kSumL / kn + kSumR / kn;
      this.momentaryBlocks.push(zFrame);
      if (this.momentaryBlocks.length > 4) this.momentaryBlocks.shift();

      let momSum = 0;
      for (let i = 0; i < this.momentaryBlocks.length; i++) momSum += this.momentaryBlocks[i];
      const z400 = momSum / this.momentaryBlocks.length;
      if (z400 > 1e-10) {
        this.momentaryLufs = -0.691 + 10 * Math.log10(z400);
      }

      if (this.momentaryBlocks.length >= 3) {
        this.gatedBlocks.push(z400);
        if (this.gatedBlocks.length > 6000) this.gatedBlocks.shift();
        this.integratedLufs = computeGatedIntegratedLufs(this.gatedBlocks);
      }
    }
  }

  runAnalysisTick() {
    if (this.isFullScan) return;
    if (this.isRemote) {
      this.updateTextUi();
      return;
    }
    if (!this.analyser || !this.freqData || !this.maxHold) return;

    this.analyser.getFloatFrequencyData(this.freqData);
    this._updateLocalStereoAndLoudness();
    this.totalFrames += 1;

    if (document.hidden) {
      this.pushWaterfallColumn(this.freqData);
    } else {
      this._accumulateWaterfallBins(this.freqData);
    }

    const binHz = this.sampleRate / FFT_SIZE;
    const midStart = Math.floor(300 / binHz);
    const midEnd = Math.min(this.freqData.length - 1, Math.floor(5000 / binHz));

    let frameMidPeak = -160;
    for (let i = midStart; i <= midEnd; i++) {
      if (this.freqData[i] > frameMidPeak) frameMidPeak = this.freqData[i];
    }
    if (frameMidPeak > this.overallMaxDb) this.overallMaxDb = frameMidPeak;

    if (frameMidPeak > -64) {
      this.activeFrames += 1;
      for (let i = 0; i < this.freqData.length; i++) {
        if (this.freqData[i] > this.maxHold[i]) {
          this.maxHold[i] = this.freqData[i];
        }
      }
    }

    this.activeSeconds = Number(((this.activeFrames * ANALYSIS_MS) / 1000).toFixed(1));
    const { cutoffHz, isBrickwall } = detectCutoffHz(this.maxHold, this.sampleRate);
    this.cutoffHz = cutoffHz;
    this.isBrickwall = isBrickwall;
    this.drmSilentWarning =
      this.totalFrames * ANALYSIS_MS > 3000 &&
      this.activeFrames === 0 &&
      this.overallMaxDb < -95;

    this.updateTextUi();
  }

  stepSmoothing(targetLive, targetMax, dt) {
    const n = targetLive.length;
    if (!this.smoothLive || this.smoothLive.length !== n) {
      this.smoothLive = Float32Array.from(targetLive);
      this.smoothMax = Float32Array.from(targetMax);
      this.peakCaps = Float32Array.from(targetLive);
      return;
    }

    const attackAlpha = 1 - Math.exp(-ATTACK_SPEED * dt);
    const decayAlpha = 1 - Math.exp(-DECAY_SPEED * dt);
    const maxAlpha = 1 - Math.exp(-16 * dt);

    for (let i = 0; i < n; i++) {
      const tv = targetLive[i];
      const alpha = tv > this.smoothLive[i] ? attackAlpha : decayAlpha;
      this.smoothLive[i] += (tv - this.smoothLive[i]) * alpha;

      if (this.smoothLive[i] >= this.peakCaps[i]) {
        this.peakCaps[i] = this.smoothLive[i];
      } else {
        this.peakCaps[i] = Math.max(
          this.smoothLive[i],
          this.peakCaps[i] - PEAK_FALL_DB_PER_SEC * dt
        );
      }

      if (targetMax[i] > this.smoothMax[i]) {
        this.smoothMax[i] = targetMax[i];
      } else {
        this.smoothMax[i] += (targetMax[i] - this.smoothMax[i]) * maxAlpha;
      }
    }
  }

  renderFrame(dt) {
    if (this.isFullScan) return;

    const wfStepSec = 1 / WF_COLS_PER_SEC;
    let nyquist = this.sampleRate / 2;

    if (!this.isRemote && this.analyser && this.freqData && this.maxHold) {
      this.analyser.getFloatFrequencyData(this.freqData);
      this._accumulateWaterfallBins(this.freqData);

      this.wfAccumSec += dt;
      let steps = 0;
      while (this.wfAccumSec >= wfStepSec && steps < 3) {
        this.pushWaterfallColumn(this.wfPendingBins || this.freqData);
        this.wfAccumSec -= wfStepSec;
        steps += 1;
      }
      if (steps > 0) {
        this.wfPendingBins = null;
        if (steps === 3) this.wfAccumSec = 0;
      }

      if (this.spectrumScale === "log") {
        computeLog31ToArray(this.freqData, this.sampleRate, this.scratchLogLive);
        computeLog31ToArray(this.maxHold, this.sampleRate, this.scratchLogMax);
        this.stepSmoothing(this.scratchLogLive, this.scratchLogMax, dt);
      } else {
        downsampleToArray(this.freqData, DISPLAY_BINS, this.scratchLiveBins);
        downsampleToArray(this.maxHold, DISPLAY_BINS, this.scratchMaxBins);
        this.stepSmoothing(this.scratchLiveBins, this.scratchMaxBins, dt);
      }
    } else if (this.isRemote && this.remoteTarget?.liveBins && this.remoteTarget?.maxBins) {
      nyquist = this.remoteTarget.nyquist || 24000;

      this.wfAccumSec += dt;
      let steps = 0;
      while (this.wfAccumSec >= wfStepSec && steps < 3) {
        this.pushWaterfallColumn(this.wfPendingBins || this.remoteTarget.liveBins);
        this.wfAccumSec -= wfStepSec;
        steps += 1;
      }
      if (steps > 0) {
        this.wfPendingBins = null;
        if (steps === 3) this.wfAccumSec = 0;
      }

      const tLive =
        this.spectrumScale === "log" && this.remoteTarget.logLiveBins
          ? this.remoteTarget.logLiveBins
          : this.remoteTarget.liveBins;
      const tMax =
        this.spectrumScale === "log" && this.remoteTarget.logMaxBins
          ? this.remoteTarget.logMaxBins
          : this.remoteTarget.maxBins;
      this.stepSmoothing(tLive, tMax, dt);
    }

    const mAttack = 1 - Math.exp(-40 * dt);
    const mDecay = 1 - Math.exp(-14 * dt);
    this.smoothPeakL += (this.rawPeakL - this.smoothPeakL) * (this.rawPeakL > this.smoothPeakL ? mAttack : mDecay);
    this.smoothPeakR += (this.rawPeakR - this.smoothPeakR) * (this.rawPeakR > this.smoothPeakR ? mAttack : mDecay);
    this.smoothRmsL += (this.rawRmsL - this.smoothRmsL) * (this.rawRmsL > this.smoothRmsL ? mAttack : mDecay);
    this.smoothRmsR += (this.rawRmsR - this.smoothRmsR) * (this.rawRmsR > this.smoothRmsR ? mAttack : mDecay);

    this.heldPeakL =
      this.smoothPeakL >= this.heldPeakL ? this.smoothPeakL : Math.max(this.smoothPeakL, this.heldPeakL - 14 * dt);
    this.heldPeakR =
      this.smoothPeakR >= this.heldPeakR ? this.smoothPeakR : Math.max(this.smoothPeakR, this.heldPeakR - 14 * dt);

    if (this.phaseCorr != null) {
      this.hasPhase = true;
      this.smoothPhase += (this.phaseCorr - this.smoothPhase) * (1 - Math.exp(-18 * dt));
    }

    if (this.cutoffHz && this.activeSeconds >= 2) {
      this.smoothCutoffHz =
        this.smoothCutoffHz === null
          ? this.cutoffHz
          : this.smoothCutoffHz +
            (this.cutoffHz - this.smoothCutoffHz) * (1 - Math.exp(-14 * dt));
    } else {
      this.smoothCutoffHz = null;
    }

    this.drawBarsChart(nyquist);
    this.drawLevelMeter();
    this.drawWaterfallChart(nyquist);
  }

  drawBarsChart(nyquist) {
    const ctx = this.barCtx;
    const { w, h } = syncCanvasDpr(this.barCanvas, ctx, 540, 182);
    const padRight = 34;
    const padBottom = 18;
    const plotW = Math.max(10, w - padRight);
    const plotH = Math.max(10, h - padBottom);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, w, h);

    const dbToY = (db) => {
      const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
      const norm = (clamped - MIN_DB) / (MAX_DB - MIN_DB);
      return plotH - norm * plotH;
    };

    const dbTicks = [-20, -40, -60, -80, -100];
    ctx.save();
    ctx.strokeStyle = "#292929";
    ctx.fillStyle = "#7a7a7a";
    ctx.lineWidth = 1;
    ctx.font = "10px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (const db of dbTicks) {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.fillText(`${db}dB`, w - 3, y);
    }
    ctx.restore();

    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(plotW, plotH + 0.5);
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, plotH);
    ctx.stroke();

    const isLog = this.spectrumScale === "log";

    if (this.smoothLive && this.smoothMax) {
      const count = this.smoothLive.length;
      const slotW = plotW / count;
      const gap = isLog ? 1.8 : 1.2;

      const barGrad = ctx.createLinearGradient(0, 0, 0, plotH);
      barGrad.addColorStop(0, "#a8bccf");
      barGrad.addColorStop(0.6, "#889db2");
      barGrad.addColorStop(1, "#6b7e91");

      ctx.fillStyle = barGrad;
      for (let i = 0; i < count; i++) {
        const y = dbToY(this.smoothLive[i]);
        const barH = plotH - y;
        if (barH > 0.5) {
          ctx.fillRect(i * slotW, y, Math.max(1.2, slotW - gap), barH);
        }
      }

      if (this.peakCaps) {
        ctx.fillStyle = "#e6eef5";
        for (let i = 0; i < count; i++) {
          if (this.peakCaps[i] > MIN_DB + 2) {
            const cy = Math.floor(dbToY(this.peakCaps[i]));
            ctx.fillRect(i * slotW, cy - 1.5, Math.max(1.2, slotW - gap), 1.5);
          }
        }
      }

      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const x = i * slotW + (slotW - gap) / 2;
        const y = dbToY(this.smoothMax[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#d96b88";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    if (isLog) {
      const n = LOG_31_LABELS.length;
      const slotW = plotW / n;
      ctx.fillStyle = "#7a7a7a";
      ctx.font = "9.5px Segoe UI, Tahoma, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (let i = 0; i < n; i++) {
        const lbl = LOG_31_LABELS[i];
        if (!lbl) continue;
        const cx = i * slotW + slotW / 2;
        ctx.fillText(lbl, cx, h - 4);
      }
    } else {
      const markers = [
        { hz: 8000, label: "8k", color: "rgba(135, 135, 135, 0.45)" },
        { hz: 12000, label: "12k", color: "rgba(135, 135, 135, 0.45)" },
        { hz: 16000, label: "16k", color: "rgba(214, 147, 45, 0.78)" },
        { hz: 20000, label: "20k", color: "rgba(61, 163, 93, 0.78)" },
        { hz: 22050, label: "22k", color: "rgba(176, 118, 214, 0.72)" },
        { hz: 32000, label: "32k", color: "rgba(135, 135, 135, 0.45)" },
        { hz: 40000, label: "40k", color: "rgba(176, 118, 214, 0.65)" },
      ];

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.font = "10.5px Segoe UI, Tahoma, sans-serif";
      ctx.textAlign = "left";
      for (const m of markers) {
        if (m.hz >= nyquist - 400) continue;
        const x = Math.round((m.hz / nyquist) * plotW) + 0.5;
        ctx.strokeStyle = m.color;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotH);
        ctx.stroke();
        ctx.fillStyle = m.color;
        ctx.fillText(m.label, x - 9, h - 4);
      }
      ctx.restore();

      ctx.fillStyle = "#7a7a7a";
      ctx.font = "10.5px Segoe UI, Tahoma, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("0k", 3, h - 4);
      ctx.fillText(`${(nyquist / 1000).toFixed(0)}k`, plotW - 22, h - 4);

      if (this.smoothCutoffHz) {
        const cx = Math.round((Math.min(this.smoothCutoffHz, nyquist) / nyquist) * plotW) + 0.5;
        ctx.strokeStyle = "#3399ff";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, plotH);
        ctx.stroke();
      }
    }
  }

  drawLevelMeter() {
    const ctx = this.meterCtx;
    const { w, h } = syncCanvasDpr(this.meterCanvas, ctx, 540, 38);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, w, h);

    const labelPadRight = 212;
    const chLabelW = 14;
    const barX = chLabelW + 5;
    const barW = Math.max(60, w - labelPadRight - barX - 8);

    const dbToX = (db) => {
      const clamped = Math.max(-60, Math.min(0, db));
      return barX + ((clamped + 60) / 60) * barW;
    };

    const drawChannelBar = (label, y, barH, peakDb, rmsDb, heldDb) => {
      ctx.font = "bold 9px Segoe UI, Tahoma, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#8a8a8a";
      ctx.fillText(label, 5, y + barH / 2 + 0.5);

      ctx.fillStyle = "#101010";
      ctx.fillRect(barX, y, barW, barH);
      ctx.strokeStyle = "#2c2c2c";
      ctx.strokeRect(barX + 0.5, y + 0.5, barW - 1, barH - 1);

      if (peakDb > -60) {
        const px = dbToX(peakDb);
        ctx.fillStyle = "rgba(82, 148, 207, 0.34)";
        ctx.fillRect(barX + 1, y + 1, Math.max(0, px - barX - 1), barH - 2);
      }
      if (rmsDb > -60) {
        const rx = dbToX(rmsDb);
        ctx.fillStyle = rmsDb > -6 ? "#d6932d" : "#5294cf";
        ctx.fillRect(barX + 1, y + 1, Math.max(0, rx - barX - 1), barH - 2);
      }
      if (heldDb > -60) {
        const hx = Math.round(dbToX(heldDb));
        ctx.fillStyle = heldDb > -0.3 ? "#cf4646" : "#e6eef5";
        ctx.fillRect(hx - 1, y + 1, 2, barH - 2);
      }
    };

    drawChannelBar("L", 4, 8, this.smoothPeakL, this.smoothRmsL, this.heldPeakL);
    drawChannelBar("R", 14, 8, this.smoothPeakR, this.smoothRmsR, this.heldPeakR);

    // Phase Correlation bar (-1 to +1)
    const phY = 26;
    const phH = 8;
    ctx.font = "bold 9px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#8a8a8a";
    ctx.fillText("Φ", 5, phY + phH / 2 + 0.5);

    ctx.fillStyle = "#101010";
    ctx.fillRect(barX, phY, barW, phH);
    ctx.strokeStyle = "#2c2c2c";
    ctx.strokeRect(barX + 0.5, phY + 0.5, barW - 1, phH - 1);

    const midX = barX + barW / 2;
    ctx.strokeStyle = "#3a3a3a";
    ctx.beginPath();
    ctx.moveTo(Math.round(midX) + 0.5, phY + 1);
    ctx.lineTo(Math.round(midX) + 0.5, phY + phH - 1);
    ctx.stroke();

    if (this.hasPhase) {
      const clampedPh = Math.max(-1, Math.min(1, this.smoothPhase));
      const phX = midX + clampedPh * (barW / 2 - 2);
      const phColor = clampedPh < 0 ? "#cf4646" : clampedPh < 0.3 ? "#d6932d" : "#3da35d";

      ctx.fillStyle = phColor;
      if (clampedPh >= 0) {
        ctx.fillRect(midX, phY + 2, Math.max(1, phX - midX), phH - 4);
      } else {
        ctx.fillRect(phX, phY + 2, Math.max(1, midX - phX), phH - 4);
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.round(phX) - 1, phY + 1, 2, phH - 2);
    }

    // Right-side 2-line broadcast readout
    const tpStr = this.truePeakDbtp > -90 ? `${this.truePeakDbtp.toFixed(1)}` : "-∞";
    const drStr = this.crestDb != null ? `${this.crestDb.toFixed(1)}` : "—";
    const hasInt = this.integratedLufs != null;
    const lufsVal = hasInt ? this.integratedLufs : this.momentaryLufs;
    const lufsTag = hasInt ? "I" : "M";
    const lufsStr = lufsVal != null ? `${lufsTag} ${lufsVal.toFixed(1)} LUFS` : "LUFS —";
    const phStr = this.hasPhase
      ? `${this.smoothPhase >= 0 ? "+" : ""}${this.smoothPhase.toFixed(2)}`
      : "—";

    ctx.font = "10px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.truePeakDbtp > -0.2 ? "#f29696" : "#b8b8b8";
    ctx.fillText(`TP ${tpStr} dBTP | DR ${drStr} dB`, w - 6, 11);
    ctx.fillStyle = "#96c7f2";
    ctx.fillText(`${lufsStr} | Φ ${phStr}`, w - 6, 27);
  }

  _getWaterfallLayout(w, h) {
    const padLeft = 32;
    const padRight = 40;
    const padTop = 6;
    const padBottom = 17;
    const plotW = Math.max(10, w - padLeft - padRight);
    const plotH = Math.max(10, h - padTop - padBottom);
    return { padLeft, padRight, padTop, padBottom, plotW, plotH };
  }

  drawWaterfallChart(nyquist) {
    const ctx = this.wfViewCtx;
    const { w, h } = syncCanvasDpr(this.wfViewCanvas, ctx, 540, 220);
    const { padLeft, padTop, plotW, plotH } = this._getWaterfallLayout(w, h);
    const isFull = this.isFullScan && this.fullScanData;
    const totalSec = isFull ? this.fullScanData.duration : WF_WIDTH / WF_COLS_PER_SEC;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.wfCanvas, padLeft, padTop, plotW, plotH);
    ctx.restore();

    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

    // Bottom Time Axis ticks & subtle vertical grid
    ctx.save();
    ctx.font = "9.5px Segoe UI, Tahoma, sans-serif";
    ctx.textBaseline = "alphabetic";
    if (isFull && totalSec > 0) {
      const tickCount = 6;
      for (let i = 0; i <= tickCount; i++) {
        const frac = i / tickCount;
        const x = Math.round(padLeft + frac * plotW) + 0.5;
        const sec = frac * totalSec;

        if (i > 0 && i < tickCount && this.wfHasData) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
          ctx.beginPath();
          ctx.moveTo(x, padTop + 1);
          ctx.lineTo(x, padTop + plotH - 1);
          ctx.stroke();
        }

        ctx.strokeStyle = "#555555";
        ctx.beginPath();
        ctx.moveTo(x, padTop + plotH);
        ctx.lineTo(x, padTop + plotH + 3);
        ctx.stroke();

        ctx.fillStyle = "#7a7a7a";
        ctx.textAlign = i === 0 ? "left" : i === tickCount ? "right" : "center";
        ctx.fillText(formatDuration(sec), x, h - 3);
      }
    } else {
      const stepSec = 3;
      for (let s = 0; s <= Math.floor(totalSec); s += stepSec) {
        const x = Math.round(padLeft + plotW - (s / totalSec) * plotW) + 0.5;
        if (x < padLeft + 10) continue;

        if (s > 0 && this.wfHasData) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
          ctx.beginPath();
          ctx.moveTo(x, padTop + 1);
          ctx.lineTo(x, padTop + plotH - 1);
          ctx.stroke();
        }

        ctx.strokeStyle = "#555555";
        ctx.beginPath();
        ctx.moveTo(x, padTop + plotH);
        ctx.lineTo(x, padTop + plotH + 3);
        ctx.stroke();

        ctx.fillStyle = "#7a7a7a";
        ctx.textAlign = s === 0 ? "right" : "center";
        const lbl = s === 0 ? "0s" : `-${s}s`;
        ctx.fillText(lbl, s === 0 ? padLeft + plotW : x, h - 3);
      }
    }
    ctx.restore();

    const yMarkers = [
      { hz: 4000, label: "4k", color: "rgba(160, 160, 160, 0.25)", text: "#7a7a7a" },
      { hz: 8000, label: "8k", color: "rgba(160, 160, 160, 0.3)", text: "#969696" },
      { hz: 12000, label: "12k", color: "rgba(160, 160, 160, 0.3)", text: "#969696" },
      { hz: 16000, label: "16k", color: "rgba(214, 147, 45, 0.65)", text: "#d6932d" },
      { hz: 20000, label: "20k", color: "rgba(61, 163, 93, 0.72)", text: "#5cc47b" },
      { hz: 22050, label: "22k", color: "rgba(176, 118, 214, 0.58)", text: "#c494e6" },
      { hz: 32000, label: "32k", color: "rgba(160, 160, 160, 0.28)", text: "#969696" },
      { hz: 40000, label: "40k", color: "rgba(176, 118, 214, 0.58)", text: "#c494e6" },
    ];

    ctx.save();
    ctx.font = "10px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    ctx.fillStyle = "#7a7a7a";
    ctx.fillText("0k", padLeft - 5, padTop + plotH - 3);
    ctx.fillText(`${(nyquist / 1000).toFixed(0)}k`, padLeft - 5, padTop + 4);

    ctx.setLineDash([3, 3]);
    for (const m of yMarkers) {
      if (m.hz >= nyquist - 400) continue;
      const y = Math.round(padTop + (1 - m.hz / nyquist) * plotH) + 0.5;
      ctx.strokeStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = m.text;
      ctx.fillText(m.label, padLeft - 5, y);
    }
    ctx.restore();

    if (this.smoothCutoffHz && this.wfHasData) {
      const cy =
        Math.round(padTop + (1 - Math.min(this.smoothCutoffHz, nyquist) / nyquist) * plotH) +
        0.5;
      ctx.save();
      ctx.strokeStyle = "#3399ff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padLeft, cy);
      ctx.lineTo(padLeft + plotW, cy);
      ctx.stroke();

      const tag = `Cutoff ~${(this.smoothCutoffHz / 1000).toFixed(1)}k`;
      ctx.font = "bold 10px Segoe UI, Tahoma, sans-serif";
      const tw = ctx.measureText(tag).width + 8;
      const tx = padLeft + plotW - tw - 5;
      const ty = Math.max(padTop + 4, cy - 17);
      ctx.fillStyle = "rgba(24, 24, 24, 0.9)";
      ctx.fillRect(tx, ty, tw, 15);
      ctx.strokeStyle = "#3399ff";
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, ty, tw, 15);
      ctx.fillStyle = "#8cc6ff";
      ctx.fillText(tag, tx + 4, ty + 11);
      ctx.restore();
    }

    const paletteObj = WF_PALETTES[this.wfPaletteName] || WF_PALETTES.inferno;
    const legendX = padLeft + plotW + 8;
    const legendW = 8;
    const legendGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    for (const [stop, color] of paletteObj.legend) {
      legendGrad.addColorStop(stop, color);
    }

    ctx.fillStyle = legendGrad;
    ctx.fillRect(legendX, padTop, legendW, plotH);
    ctx.strokeStyle = "#363636";
    ctx.strokeRect(legendX + 0.5, padTop + 0.5, legendW - 1, plotH - 1);

    const midDb = Math.round((WF_MAX_DB + this.wfMinDb) / 2);
    ctx.fillStyle = "#7a7a7a";
    ctx.font = "9.5px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${WF_MAX_DB}`, legendX + legendW + 3, padTop + 5);
    ctx.fillText(`${midDb}`, legendX + legendW + 3, padTop + plotH / 2);
    ctx.fillText(`${this.wfMinDb}`, legendX + legendW + 3, padTop + plotH - 4);

    if (this.wfHover.active) {
      const hx = Math.round(padLeft + this.wfHover.normX * plotW) + 0.5;
      const hy = Math.round(padTop + this.wfHover.normY * plotH) + 0.5;

      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = "rgba(235, 245, 255, 0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, padTop + plotH);
      ctx.moveTo(padLeft, hy);
      ctx.lineTo(padLeft + plotW, hy);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(hx - 1.5, hy - 1.5, 3, 3);

      const freqHz = (1 - this.wfHover.normY) * nyquist;
      const freqStr =
        freqHz >= 1000 ? `${(freqHz / 1000).toFixed(2)} kHz` : `${Math.round(freqHz)} Hz`;

      let timeStr = "";
      if (isFull) {
        timeStr = formatDurationPrecise(this.wfHover.normX * totalSec);
      } else {
        const timeAgo = (1 - this.wfHover.normX) * totalSec;
        timeStr = timeAgo < 0.05 ? "0.0s" : `-${timeAgo.toFixed(1)}s`;
      }

      const col = Math.max(0, Math.min(WF_WIDTH - 1, Math.floor(this.wfHover.normX * WF_WIDTH)));
      const row = Math.max(0, Math.min(WF_HEIGHT - 1, Math.floor(this.wfHover.normY * WF_HEIGHT)));
      const dbVal = this.wfDbBuffer[col * WF_HEIGHT + row];
      const dbStr = this.wfHasData && dbVal > -135 ? `${dbVal.toFixed(1)} dB` : "-∞ dB";

      const hudText = `${freqStr} | ${dbStr} | ${timeStr}`;
      ctx.font = "bold 10px Segoe UI, Tahoma, sans-serif";
      const boxW = ctx.measureText(hudText).width + 10;
      const boxH = 17;

      let bx = hx + 8;
      if (bx + boxW > padLeft + plotW - 2) bx = hx - boxW - 8;
      bx = Math.max(padLeft + 2, bx);

      let by = hy - boxH - 6;
      if (by < padTop + 2) by = hy + 8;
      by = Math.min(padTop + plotH - boxH - 2, by);

      ctx.fillStyle = "rgba(18, 18, 18, 0.92)";
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = "#5294cf";
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);

      ctx.fillStyle = "#e6eef5";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(hudText, bx + 5, by + boxH / 2 + 0.5);
      ctx.restore();
    }
  }

  updateTextUi() {
    this.cutoffEl.textContent = this.cutoffHz
      ? `~${(this.cutoffHz / 1000).toFixed(1)} kHz`
      : "Measuring...";
    this.sampleTimeEl.textContent =
      this.isFullScan && this.fullScanData
        ? `${formatDuration(this.fullScanData.duration)} (${this.fullScanData.scanMs}ms)`
        : `${this.activeSeconds.toFixed(1)}s`;
    this.srEl.textContent = `${(this.sampleRate / 1000).toFixed(1)} kHz`;

    const linkedTab = this.getLinkedTab();
    const layer1Codec = linkedTab?.telemetry?.codec || "";
    const reportedKbps = linkedTab?.telemetry?.avgKbps || 0;
    if (linkedTab?.telemetry) {
      const ratePart = reportedKbps > 0 ? ` ${reportedKbps} kbps` : " LIVE";
      const bitsPart = linkedTab.telemetry.nativeBitDepth
        ? ` (${linkedTab.telemetry.nativeBitDepth}-bit)`
        : "";
      this.bitrateRefEl.innerHTML = `Layer 1: <strong>${esc(layer1Codec.toUpperCase())}${ratePart}${bitsPart}</strong>`;
    } else if (linkedTab) {
      this.bitrateRefEl.innerHTML = `Layer 1: <strong>Unmeasured</strong>`;
    } else {
      this.bitrateRefEl.innerHTML = `Layer 1: <strong>Unlinked</strong>`;
    }

    const box = this.verdictEl;
    if (this.drmSilentWarning) {
      box.className = "verdict warn";
      box.textContent =
        "No audio signal detected — tab is muted, 'Share tab audio' is unchecked, or content is DRM-protected.";
      return;
    }

    if (!this.isFullScan && (this.activeSeconds < 4.5 || !this.cutoffHz)) {
      box.className = "verdict";
      box.textContent = `Accumulating Max-Hold peaks (${this.activeSeconds.toFixed(1)}s / ~5s) — waiting for transients...`;
      return;
    }

    const khz = this.cutoffHz ? (this.cutoffHz / 1000).toFixed(1) : "—";
    const drPart = this.crestDb != null ? `DR ${this.crestDb.toFixed(1)} dB` : "DR —";
    const lufsVal = this.integratedLufs ?? this.momentaryLufs;
    const lufsPart = lufsVal != null ? ` | ${lufsVal.toFixed(1)} LUFS` : "";
    const tpPart =
      this.truePeakDbtp > -90 ? ` | TP ${this.truePeakDbtp.toFixed(1)} dBTP` : "";

    const layer1Lossy =
      isKnownLossyCodec(layer1Codec) ||
      (reportedKbps > 0 && reportedKbps < 500 && !isKnownLosslessCodec(layer1Codec));
    const layer1Lossless =
      isKnownLosslessCodec(layer1Codec) || reportedKbps >= 500;
    const spectralLossless =
      this.cutoffHz >= 21300 || (this.cutoffHz >= 20800 && !this.isBrickwall);

    if (!layer1Lossy && spectralLossless) {
      box.className = "verdict good";
    } else if (this.cutoffHz >= 19000) {
      if (layer1Lossless && this.cutoffHz < 20500) {
        box.className = "verdict warn";
      } else {
        box.className = "verdict ok";
      }
    } else if (this.cutoffHz >= 17000) {
      box.className = layer1Lossless ? "verdict fake" : "verdict warn";
    } else {
      box.className = "verdict fake";
    }
    box.textContent = `~${khz} kHz | ${drPart}${lufsPart}${tpPart}`;
  }

  destroy() {
    if (this.wfViewCanvas) {
      this.wfViewCanvas.removeEventListener("mousemove", this._onWfMouseMove);
      this.wfViewCanvas.removeEventListener("mouseleave", this._onWfMouseLeave);
    }
    for (const node of this.audioNodes) {
      try {
        node.disconnect();
      } catch {
        // Ignore
      }
    }
    this.audioNodes = [];
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.analyser = null;
    this.analyserL = null;
    this.analyserR = null;
    this.kAnalyserL = null;
    this.kAnalyserR = null;
    if (this.el && this.el.parentNode) {
      this.el.remove();
    }
  }
}

// ---------- Unified Loop Orchestration ----------

function updateProbesLayoutState() {
  const count = probes.size;
  document.getElementById("statProbes").textContent = count;
  document.getElementById("probesEmpty").classList.toggle("hidden", count > 0);
  document.getElementById("btnStopAllFft").classList.toggle("hidden", count === 0);
  updateBottomStatusBar();
}

function hasLiveProbes() {
  for (const probe of probes.values()) {
    if (!probe.isFullScan) return true;
  }
  return false;
}

function startUnifiedLoops() {
  if (!hasLiveProbes()) return;

  if (!analysisTimer) {
    analysisTimer = setInterval(() => {
      const now = performance.now();
      for (const [id, probe] of probes.entries()) {
        if (probe.isFullScan) continue;
        if (probe.isRemote && probe.lastRemoteTs && now - probe.lastRemoteTs > 1800) {
          removeProbe(id);
          continue;
        }
        probe.runAnalysisTick();
      }
    }, ANALYSIS_MS);
  }

  if (!rafId) {
    lastRenderTs = 0;
    rafId = requestAnimationFrame(unifiedRenderLoop);
  }
}

function stopUnifiedLoopsIfEmpty() {
  if (hasLiveProbes()) return;

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (analysisTimer) {
    clearInterval(analysisTimer);
    analysisTimer = null;
  }
  if (sharedAudioCtx) {
    sharedAudioCtx.close().catch(() => {});
    sharedAudioCtx = null;
  }
  updateBottomStatusBar();
}

function unifiedRenderLoop(now) {
  if (!hasLiveProbes()) {
    rafId = null;
    return;
  }

  const dt = lastRenderTs ? Math.min((now - lastRenderTs) / 1000, 0.1) : 1 / 60;
  lastRenderTs = now;

  for (const probe of probes.values()) {
    if (!probe.isFullScan) {
      probe.renderFrame(dt);
    }
  }

  rafId = requestAnimationFrame(unifiedRenderLoop);
}

function removeProbe(probeId) {
  const probe = probes.get(probeId);
  if (!probe) return;
  probe.destroy();
  probes.delete(probeId);
  updateProbesLayoutState();
  stopUnifiedLoopsIfEmpty();
  renderTabs(cachedTabs);
}

function stopAllProbes() {
  for (const probe of probes.values()) {
    if (probe.isRemote) {
      chrome.runtime.sendMessage({ target: "background", type: "STOP_FFT" });
    }
    probe.destroy();
  }
  probes.clear();
  updateProbesLayoutState();
  stopUnifiedLoopsIfEmpty();
  renderTabs(cachedTabs);
}

function pickDefaultLinkTabId() {
  if (pendingLinkTabId != null) {
    const id = pendingLinkTabId;
    pendingLinkTabId = null;
    return id;
  }
  const usedIds = new Set();
  for (const p of probes.values()) {
    if (p.linkedTabId != null) usedIds.add(p.linkedTabId);
  }
  const candidates = cachedTabs.filter((t) => t.audible && !usedIds.has(t.tabId));
  return candidates.length === 1 ? candidates[0].tabId : null;
}

async function addTabForFft(preLinkTabId = null) {
  pendingLinkTabId = preLinkTabId;

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1, frameRate: 1 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: false,
      },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
    });

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      pendingLinkTabId = null;
      alert("Selected source has no audio track — choose a tab under 'Chrome Tab' and enable 'Share tab audio'.");
      return;
    }

    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioContext();
    }
    if (sharedAudioCtx.state === "suspended") {
      await sharedAudioCtx.resume();
    }

    const sourceNode = sharedAudioCtx.createMediaStreamSource(stream);
    const analyser = sharedAudioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.0;
    sourceNode.connect(analyser);

    // Stereo L/R splitter
    const splitter = sharedAudioCtx.createChannelSplitter(2);
    const analyserL = sharedAudioCtx.createAnalyser();
    const analyserR = sharedAudioCtx.createAnalyser();
    analyserL.fftSize = TIME_FFT_SIZE;
    analyserR.fftSize = TIME_FFT_SIZE;
    sourceNode.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    // ITU-R BS.1770-4 K-Weighting chain
    const kShelf = sharedAudioCtx.createBiquadFilter();
    kShelf.type = "highshelf";
    kShelf.frequency.value = 1681.974;
    kShelf.gain.value = 3.9998;

    const kHighpass = sharedAudioCtx.createBiquadFilter();
    kHighpass.type = "highpass";
    kHighpass.frequency.value = 38.135;
    kHighpass.Q.value = 0.5003;

    const kSplitter = sharedAudioCtx.createChannelSplitter(2);
    const kAnalyserL = sharedAudioCtx.createAnalyser();
    const kAnalyserR = sharedAudioCtx.createAnalyser();
    kAnalyserL.fftSize = TIME_FFT_SIZE;
    kAnalyserR.fftSize = TIME_FFT_SIZE;

    sourceNode.connect(kShelf);
    kShelf.connect(kHighpass);
    kHighpass.connect(kSplitter);
    kSplitter.connect(kAnalyserL, 0);
    kSplitter.connect(kAnalyserR, 1);

    const seq = nextProbeSeq++;
    const probeId = `local_${seq}`;
    const linkedTabId = pickDefaultLinkTabId();

    const probe = new SpectralProbe({
      id: probeId,
      seq,
      isRemote: false,
      rawLabel: audioTracks[0].label || "Tab audio",
      linkedTabId,
      stream,
      audioNodes: [
        sourceNode,
        analyser,
        splitter,
        analyserL,
        analyserR,
        kShelf,
        kHighpass,
        kSplitter,
        kAnalyserL,
        kAnalyserR,
      ],
      analyser,
      analyserL,
      analyserR,
      kAnalyserL,
      kAnalyserR,
      sampleRate: sharedAudioCtx.sampleRate,
    });

    probes.set(probeId, probe);
    document.getElementById("probesStack").appendChild(probe.el);
    updateProbesLayoutState();

    audioTracks[0].addEventListener("ended", () => {
      removeProbe(probeId);
    });

    probe.runAnalysisTick();
    startUnifiedLoops();
    renderTabs(cachedTabs);

    probe.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    pendingLinkTabId = null;
    if (err?.name !== "AbortError" && err?.name !== "NotAllowedError") {
      alert(`Failed to capture tab audio: ${err?.message || err}`);
    }
  }
}

async function runFullTrackScanForTab(tabId, btnEl) {
  const tab = cachedTabs.find((t) => t.tabId === tabId);
  if (!tab) return;
  const fileUrl =
    tab.telemetry?.srcUrl && tab.telemetry.srcUrl.startsWith("file://")
      ? tab.telemetry.srcUrl
      : tab.url && tab.url.startsWith("file://")
      ? tab.url
      : "";
  if (!fileUrl) return;

  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Scanning...";
  }

  try {
    const resp = await chrome.runtime.sendMessage({
      target: "background",
      type: "SCAN_FULL_TRACK",
      tabId,
      url: fileUrl,
      nativeSampleRate: tab.telemetry?.nativeSampleRate || 0,
    });

    if (!resp?.ok) {
      throw new Error(resp?.error || "Full-track scan failed");
    }

    const probeId = `fullscan_${tabId}`;
    let probe = probes.get(probeId);
    if (!probe) {
      probe = new SpectralProbe({
        id: probeId,
        isFullScan: true,
        linkedTabId: tabId,
        rawLabel: tab.title,
        sampleRate: resp.sampleRate || 48000,
        fullScanData: resp,
      });
      probes.set(probeId, probe);
      document.getElementById("probesStack").prepend(probe.el);
      updateProbesLayoutState();
    } else {
      probe.applyFullScanData(resp);
    }

    probe.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    alert(`Full scan failed: ${err?.message || err}`);
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = "Scan Full";
    }
  }
}

function syncAllProbesWithTabs() {
  for (const probe of probes.values()) {
    probe.syncTabLinkOptions();
    probe.checkTrackChange();
    probe.updateHeaderTitle();
  }
}

// ---------- Multi-Tab Grid Manager ----------

const tabCardMap = new Map();

function isTabBeingProbed(tabId) {
  for (const probe of probes.values()) {
    if (probe.linkedTabId === tabId) return true;
  }
  return false;
}

function createTabCard(tabId) {
  const el = document.createElement("div");
  el.className = "tab-card";
  el.dataset.tabId = String(tabId);

  el.innerHTML = `
    <div class="tab-card-titlebar">
      <img class="tab-icon js-icon" alt="" />
      <div class="tab-info">
        <div class="tab-title js-title"></div>
        <div class="tab-sub js-sub"></div>
      </div>
    </div>

    <div class="tab-card-body">
      <div class="badges js-badges"></div>

      <div class="js-mse-wrap" style="display:flex; flex-direction:column; gap:7px;">
        <div class="metrics-row">
          <div class="big-kbps js-big-kbps"><span class="js-avg">0</span> <span>kbps avg</span></div>
          <div class="mini-stats">
            <div>Instant: <strong class="js-instant">—</strong></div>
            <div>Peak: <strong class="js-peak">—</strong></div>
          </div>
        </div>
        <div class="spark-wrap">
          <div class="spark-head">
            <span>Last 12 Segments</span>
            <span class="spark-hover js-spark-hover"></span>
          </div>
          <canvas class="spark-canvas js-spark-canvas" width="310" height="34"></canvas>
        </div>
        <div class="mime-line js-mime"></div>
      </div>

      <div class="metrics-row js-nonmse-wrap hidden">
        <div class="js-nonmse-msg" style="font-size:11.5px; color:#969696; line-height:1.45;">
          Audio via WebAudio / WebRTC / unmeasured stream.<br/>
          Click <strong>Probe FFT</strong> to inspect its real-time spectrum &amp; LUFS.
        </div>
      </div>
    </div>

    <div class="card-footer">
      <div class="card-footer-left">
        <button class="btn-ghost btn-sm" data-action="focus" data-tab="${tabId}">Go to tab</button>
        <button class="btn-ghost btn-sm js-mute-btn" data-action="mute" data-tab="${tabId}">Mute</button>
      </div>
      <div class="card-footer-right">
        <button class="btn-scan btn-sm js-scan-btn hidden" data-action="scan" data-tab="${tabId}">Scan Full</button>
        <button class="btn-accent btn-sm js-probe-btn" data-action="probe" data-tab="${tabId}">Probe FFT</button>
      </div>
    </div>
  `;

  const hoverEl = el.querySelector(".js-spark-hover");
  const chart = new SmoothBitrateChart(el.querySelector(".js-spark-canvas"), {
    defaultWidth: 310,
    defaultHeight: 34,
    onHover: (val) => {
      hoverEl.textContent = val != null ? `${val} kbps` : "";
    },
  });

  return {
    el,
    chart,
    iconEl: el.querySelector(".js-icon"),
    titleEl: el.querySelector(".js-title"),
    subEl: el.querySelector(".js-sub"),
    badgesEl: el.querySelector(".js-badges"),
    mseWrap: el.querySelector(".js-mse-wrap"),
    nonMseWrap: el.querySelector(".js-nonmse-wrap"),
    nonMseMsg: el.querySelector(".js-nonmse-msg"),
    bigKbpsEl: el.querySelector(".js-big-kbps"),
    instantEl: el.querySelector(".js-instant"),
    peakEl: el.querySelector(".js-peak"),
    mimeEl: el.querySelector(".js-mime"),
    muteBtn: el.querySelector(".js-mute-btn"),
    scanBtn: el.querySelector(".js-scan-btn"),
    probeBtn: el.querySelector(".js-probe-btn"),
  };
}

function renderTabs(tabs) {
  cachedTabs = tabs || [];
  const filtered = onlyAudible ? cachedTabs.filter((t) => t.audible) : cachedTabs;

  const audibleCount = cachedTabs.filter((t) => t.audible).length;
  const trackedTabs = cachedTabs.filter((t) => t.telemetry);
  const topBitrate = trackedTabs.reduce(
    (max, t) => Math.max(max, t.telemetry?.avgKbps || 0),
    0
  );

  document.getElementById("statAudible").textContent = audibleCount;
  document.getElementById("statMse").textContent = trackedTabs.length;
  document.getElementById("statMaxKbps").textContent = topBitrate
    ? `${topBitrate} kbps`
    : "—";
  updateBottomStatusBar();

  const grid = document.getElementById("tabsGrid");

  if (!filtered.length) {
    tabCardMap.forEach((entry) => entry.chart.destroy());
    tabCardMap.clear();
    grid.innerHTML = `
      <div class="empty-grid">
        No audio tabs detected.<br />
        Play music or video in any Chrome tab — live monitor panels will appear here automatically.
      </div>`;
    syncAllProbesWithTabs();
    return;
  }

  const emptyEl = grid.querySelector(".empty-grid");
  if (emptyEl) emptyEl.remove();

  const visibleIds = new Set(filtered.map((t) => t.tabId));
  for (const [id, entry] of tabCardMap.entries()) {
    if (!visibleIds.has(id)) {
      entry.chart.destroy();
      entry.el.remove();
      tabCardMap.delete(id);
    }
  }

  filtered.forEach((item, index) => {
    let entry = tabCardMap.get(item.tabId);
    if (!entry) {
      entry = createTabCard(item.tabId);
      tabCardMap.set(item.tabId, entry);
      grid.appendChild(entry.el);
    }

    const t = item.telemetry;
    const host = t?.host || getHostname(item.url) || "Chrome Tab";
    const trackLine = t?.trackTitle
      ? `${t.trackTitle}${t.trackArtist ? ` — ${t.trackArtist}` : ""}`
      : host;
    const probed = isTabBeingProbed(item.tabId);
    const isLocalFile =
      (item.url && item.url.startsWith("file://")) ||
      (t?.srcUrl && t.srcUrl.startsWith("file://"));

    entry.el.className = `tab-card ${item.audible ? "is-live" : "is-paused"}`;

    if (item.favIconUrl) {
      if (entry.iconEl.src !== item.favIconUrl) entry.iconEl.src = item.favIconUrl;
      entry.iconEl.style.visibility = "visible";
    } else {
      entry.iconEl.style.visibility = "hidden";
    }

    entry.titleEl.textContent = item.title;
    entry.titleEl.title = item.title;
    entry.subEl.textContent = trackLine;
    entry.subEl.title = trackLine;

    const statusBadge = item.audible
      ? `<span class="pill pill-live">LIVE</span>`
      : `<span class="pill pill-paused">PAUSED</span>`;
    const muteBadge = item.muted ? `<span class="pill pill-muted">MUTED</span>` : "";
    const codecBadge = t
      ? `<span class="pill pill-codec">${esc(t.codec.toUpperCase())}</span>`
      : `<span class="pill pill-nonmse">UNMEASURED</span>`;
    const modeBadge =
      t && t.streamMode && t.streamMode !== "MSE"
        ? `<span class="pill pill-direct">${esc(t.streamMode.toUpperCase())}</span>`
        : "";
    const nativeSpec =
      t && (t.nativeBitDepth || t.nativeSampleRate)
        ? `<span class="pill pill-native" title="${esc(t.nativeMd5 ? `MD5: ${t.nativeMd5}` : "Native File Header")}">${esc(
            [
              t.nativeBitDepth ? `${t.nativeBitDepth}-bit` : "",
              t.nativeSampleRate ? `${(t.nativeSampleRate / 1000).toFixed(1)} kHz` : "",
            ]
              .filter(Boolean)
              .join(" / ")
          )}</span>`
        : "";
    const probeBadge = probed ? `<span class="pill pill-probe">PROBING FFT</span>` : "";
    entry.badgesEl.innerHTML = `${statusBadge}${muteBadge}${codecBadge}${modeBadge}${nativeSpec}${probeBadge}`;

    entry.muteBtn.textContent = item.muted ? "Unmute" : "Mute";
    entry.scanBtn.classList.toggle("hidden", !isLocalFile);
    entry.probeBtn.textContent = probed ? "+ Probe Again" : "Probe FFT";

    if (t) {
      entry.mseWrap.classList.remove("hidden");
      entry.nonMseWrap.classList.add("hidden");
      const hasRate = t.avgKbps > 0;
      entry.bigKbpsEl.innerHTML = hasRate
        ? `${t.avgKbps} <span>kbps avg</span>`
        : `LIVE <span>stream</span>`;
      entry.instantEl.textContent = hasRate ? `${t.instantKbps} kbps` : "—";
      entry.peakEl.textContent = hasRate ? `${t.peakKbps} kbps` : "—";
      const sizePart =
        t.lastChunkBytes > 0
          ? `${(t.lastChunkBytes / 1024).toFixed(1)} KB / ${t.lastDeltaSec}s (#${t.chunkCount})`
          : `${t.lastDeltaSec}s (#${t.chunkCount})`;
      entry.mimeEl.textContent = `${t.mimeType} | ${sizePart}`;
      entry.mimeEl.title = t.nativeMd5 ? `${t.mimeType} | MD5 ${t.nativeMd5}` : t.mimeType;

      entry.chart.update(t);
    } else {
      entry.mseWrap.classList.add("hidden");
      entry.nonMseWrap.classList.remove("hidden");
      if (item.url.startsWith("file://")) {
        entry.nonMseMsg.innerHTML =
          `Local file (<code>file://</code>). Enable <strong>Allow access to file URLs</strong> in <code>chrome://extensions</code> → <strong>Details</strong>, then press <strong>F5</strong>.`;
      } else {
        entry.nonMseMsg.innerHTML =
          `Audio via WebAudio / WebRTC / unmeasured stream.<br/>Click <strong>Probe FFT</strong> to inspect its real-time spectrum &amp; LUFS.`;
      }
    }

    if (grid.children[index] !== entry.el) {
      grid.insertBefore(entry.el, grid.children[index] || null);
    }
  });

  syncAllProbesWithTabs();
}

function refreshTabs() {
  chrome.runtime.sendMessage(
    { target: "background", type: "GET_ALL_AUDIO_TABS" },
    (tabs) => {
      if (chrome.runtime.lastError) return;
      renderTabs(tabs || []);
    }
  );
}

// ---------- Event Listeners ----------

document.getElementById("btnPickFft").addEventListener("click", () => addTabForFft(null));
document.getElementById("btnAddProbeInline").addEventListener("click", () => addTabForFft(null));
document.getElementById("btnStopAllFft").addEventListener("click", stopAllProbes);
document.getElementById("btnRefresh").addEventListener("click", refreshTabs);

document.getElementById("chkOnlyAudible").addEventListener("change", (e) => {
  onlyAudible = e.target.checked;
  renderTabs(cachedTabs);
});

document.getElementById("tabsGrid").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const tabId = Number(btn.dataset.tab);
  const action = btn.dataset.action;

  if (action === "focus") {
    chrome.runtime.sendMessage({ target: "background", type: "FOCUS_TAB", tabId });
  } else if (action === "mute") {
    chrome.runtime.sendMessage({ target: "background", type: "TOGGLE_MUTE_TAB", tabId });
  } else if (action === "probe") {
    addTabForFft(tabId);
  } else if (action === "scan") {
    runFullTrackScanForTab(tabId, btn);
  }
});

window.addEventListener("resize", () => {
  tabCardMap.forEach((entry) => entry.chart.resize());
  for (const probe of probes.values()) {
    if (probe.isFullScan) probe.renderFullScanStatic();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") refreshTabs();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.target === "dashboard" && message.type === "TABS_UPDATED") {
    refreshTabs();
    return;
  }

  if (message.target === "ui" && message.type === "FFT_FRAME") {
    const payload = message.payload;
    if (!payload?.capturing) return;

    let remoteProbe = probes.get("remote_popup");
    if (!remoteProbe) {
      remoteProbe = new SpectralProbe({
        id: "remote_popup",
        isRemote: true,
        linkedTabId: payload.tabId ?? null,
        sampleRate: payload.sampleRate || 48000,
      });
      probes.set("remote_popup", remoteProbe);
      document.getElementById("probesStack").prepend(remoteProbe.el);
      updateProbesLayoutState();
      startUnifiedLoops();
      renderTabs(cachedTabs);
    }

    remoteProbe.ingestRemoteFrame(payload);
  }
});

// Initialize
updateProbesLayoutState();
refreshTabs();
