let currentTabId = null;
let currentTabUrl = "";
let latestLayer1 = null;
let latestSampleRate = null;
let isCapturingCurrentTab = false;
let lastActiveSeconds = 0;
let spectrumScale = "lin"; // "lin" | "log"

const canvas = document.getElementById("fftCanvas");
const ctx = canvas.getContext("2d");
const meterCanvas = document.getElementById("meterCanvas");
const meterCtx = meterCanvas.getContext("2d");
const wfViewCanvas = document.getElementById("wfCanvas");
const wfViewCtx = wfViewCanvas.getContext("2d");

const bitrateChart = new SmoothBitrateChart(document.getElementById("bitrateCanvas"), {
  defaultWidth: 436,
  defaultHeight: 38,
  onHover: (val) => {
    document.getElementById("chartHoverVal").textContent = val != null ? `${val} kbps` : "";
  },
});

// Smooth 60-260 FPS interpolation state
let targetFft = null;
let smoothLive = null;
let smoothMax = null;
let peakCaps = null;
let smoothCutoffHz = null;

// Level meter smoothing state
let smoothRmsDbfs = -100;
let smoothPeakDbfs = -100;
let heldPeakDbfs = -100;

let rafId = null;
let lastRenderTs = 0;
let lastDomUpdateTs = 0;

const MIN_DB = -105;
const MAX_DB = -15;
const ATTACK_SPEED = 32;
const DECAY_SPEED = 16;
const PEAK_FALL_DB_PER_SEC = 28;

const LOG_31_LABELS = [
  "20", "", "", "40", "50", "", "80", "100", "", "160", "200", "", "315", "400", "",
  "630", "800", "", "1.2k", "1.6k", "", "2.5k", "3.1k", "", "5k", "6.3k", "", "10k",
  "12k", "16k", "20k",
];

// Waterfall Spectrogram offscreen buffer + perceptual contrast curve (foobar2000-style density)
const WF_WIDTH = 420;
const WF_HEIGHT = 152;
const WF_COLS_PER_SEC = 32;
const WF_MAX_DB = -24; // Per-bin 8192-pt FFT peak ceiling for bold mid/high contrast
const WF_GAMMA = 0.72; // Perceptual curve boosting mid-level harmonics without lifting floor

const wfCanvas = document.createElement("canvas");
wfCanvas.width = WF_WIDTH;
wfCanvas.height = WF_HEIGHT;
const wfCtx = wfCanvas.getContext("2d");
const wfColImg = wfCtx.createImageData(1, WF_HEIGHT);
const wfFullImg = wfCtx.createImageData(WF_WIDTH, WF_HEIGHT);
const wfDbBuffer = new Float32Array(WF_WIDTH * WF_HEIGHT).fill(-140);
const wfColRaw = new Float32Array(WF_HEIGHT);

let wfPendingBins = null;
let wfAccumSec = 0;
let wfHasData = false;
let wfPaletteName = "inferno";
let wfMinDb = -105;
let wfHover = { active: false, normX: 0, normY: 0 };

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

function clearWaterfall() {
  wfDbBuffer.fill(-140);
  wfPendingBins = null;
  wfCtx.fillStyle = "#181818";
  wfCtx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
  wfAccumSec = 0;
  wfHasData = false;
}

function repaintWaterfallFromDbBuffer() {
  if (!wfHasData) {
    wfCtx.fillStyle = "#181818";
    wfCtx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
    return;
  }

  const lut = (WF_PALETTES[wfPaletteName] || WF_PALETTES.inferno).lut;
  const data = wfFullImg.data;

  for (let col = 0; col < WF_WIDTH; col++) {
    const colOffset = col * WF_HEIGHT;
    for (let y = 0; y < WF_HEIGHT; y++) {
      const db = wfDbBuffer[colOffset + y];
      const idx = mapDbToLutIndex(db, wfMinDb) * 3;
      const p = (y * WF_WIDTH + col) * 4;
      data[p] = lut[idx];
      data[p + 1] = lut[idx + 1];
      data[p + 2] = lut[idx + 2];
      data[p + 3] = 255;
    }
  }

  wfCtx.putImageData(wfFullImg, 0, 0);
}

function pushWaterfallColumn(freqArr, isQuantizedByte = false) {
  if (!freqArr || !freqArr.length) return;
  const srcLen = freqArr.length;
  const data = wfColImg.data;
  const lut = (WF_PALETTES[wfPaletteName] || WF_PALETTES.inferno).lut;
  const histSpan = MAX_DB - MIN_DB;

  for (let y = 0; y < WF_HEIGHT; y++) {
    const freqTop = 1 - y / WF_HEIGHT;
    const freqBot = 1 - (y + 1) / WF_HEIGHT;
    const bStart = Math.max(0, Math.floor(freqBot * (srcLen - 1)));
    const bEnd = Math.min(srcLen - 1, Math.max(bStart, Math.ceil(freqTop * (srcLen - 1))));

    let maxDb = -140;
    if (isQuantizedByte) {
      let maxByte = 0;
      for (let b = bStart; b <= bEnd; b++) {
        if (freqArr[b] > maxByte) maxByte = freqArr[b];
      }
      maxDb = maxByte > 0 ? MIN_DB + (maxByte / 255) * histSpan : -140;
    } else {
      for (let b = bStart; b <= bEnd; b++) {
        if (freqArr[b] > maxDb) maxDb = freqArr[b];
      }
    }
    wfColRaw[y] = maxDb;
  }

  wfDbBuffer.copyWithin(0, WF_HEIGHT);
  const newestColOffset = (WF_WIDTH - 1) * WF_HEIGHT;

  // Subtle 1px vertical harmonic thickening (foobar2000-style rich body)
  for (let y = 0; y < WF_HEIGHT; y++) {
    let db = wfColRaw[y];
    if (y > 0 && wfColRaw[y - 1] - 3.5 > db) db = wfColRaw[y - 1] - 3.5;
    if (y < WF_HEIGHT - 1 && wfColRaw[y + 1] - 3.5 > db) db = wfColRaw[y + 1] - 3.5;

    wfDbBuffer[newestColOffset + y] = db;

    const idx = mapDbToLutIndex(db, wfMinDb) * 3;
    const p = y * 4;
    data[p] = lut[idx];
    data[p + 1] = lut[idx + 1];
    data[p + 2] = lut[idx + 2];
    data[p + 3] = 255;
  }

  wfCtx.drawImage(wfCanvas, -1, 0);
  wfCtx.putImageData(wfColImg, WF_WIDTH - 1, 0);
  wfHasData = true;
}

function hydrateWaterfall(historyCols) {
  clearWaterfall();
  if (!Array.isArray(historyCols) || !historyCols.length) return;
  const start = Math.max(0, historyCols.length - WF_WIDTH);
  for (let i = start; i < historyCols.length; i++) {
    pushWaterfallColumn(historyCols[i], true);
  }
}

clearWaterfall();

function resetAnimBuffers() {
  smoothLive = null;
  smoothMax = null;
  peakCaps = null;
  smoothCutoffHz = null;
  smoothRmsDbfs = -100;
  smoothPeakDbfs = -100;
  heldPeakDbfs = -100;
}

function updateStatusBar() {
  const summaryEl = document.getElementById("statusSummary");
  if (!latestLayer1 && !isCapturingCurrentTab) {
    summaryEl.textContent = "IDLE | Waiting for audio stream...";
    return;
  }
  const parts = [];
  if (latestLayer1) {
    parts.push(latestLayer1.codec.toUpperCase());
    parts.push(latestLayer1.avgKbps > 0 ? `${latestLayer1.avgKbps} kbps` : "LIVE");
    if (latestLayer1.streamMode) parts.push(latestLayer1.streamMode);
  } else {
    parts.push("AUDIO");
  }
  if (latestSampleRate) {
    parts.push(`${latestSampleRate} Hz`);
  }
  if (targetFft?.crestDb != null && isCapturingCurrentTab) {
    parts.push(`DR ${targetFft.crestDb.toFixed(1)} dB`);
  }
  parts.push(isCapturingCurrentTab ? "FFT + SPEK ON" : "FFT OFF");
  summaryEl.textContent = parts.join(" | ");
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

function classifySource(codec, avgKbps) {
  const c = (codec || "").toUpperCase();
  if (c === "FLAC" || c === "WAV" || avgKbps >= 500) return "Lossless / Hi-Bitrate";
  if (c === "OPUS" && avgKbps >= 115) return "High-Eff Lossy (~256k eq.)";
  if (avgKbps >= 220) return "High-Bitrate Lossy";
  if (avgKbps >= 110) return "Standard Lossy";
  if (avgKbps > 0) return "Low-Bitrate Stream";
  return "Direct Stream";
}

function renderLayer1(data) {
  latestLayer1 = data;
  const emptyEl = document.getElementById("emptyState");
  const liveEl = document.getElementById("liveView");
  const metaEl = document.getElementById("metaBox");
  const codecPill = document.getElementById("codecPill");
  const modePill = document.getElementById("modePill");
  const trackBar = document.getElementById("trackBar");

  if (!data) {
    if (currentTabUrl.startsWith("file://")) {
      emptyEl.innerHTML =
        `Local file detected (<code>file://</code>).<br />` +
        `Enable <strong>Allow access to file URLs</strong> in <code>chrome://extensions</code> → <strong>Details</strong>, then press <strong>F5</strong>.`;
    } else {
      emptyEl.innerHTML =
        `No audio stream detected on this tab.<br />` +
        `Press <strong>F5</strong> to reload and play audio (FFT Spectrum &amp; Waterfall below still work).`;
    }
    emptyEl.classList.remove("hidden");
    liveEl.classList.add("hidden");
    metaEl.classList.add("hidden");
    modePill.classList.add("hidden");
    codecPill.textContent = "IDLE";
    bitrateChart.update(null);
    updateStatusBar();
    return;
  }

  emptyEl.classList.add("hidden");
  liveEl.classList.remove("hidden");
  metaEl.classList.remove("hidden");

  if (data.trackTitle) {
    trackBar.classList.remove("hidden");
    document.getElementById("trackTitle").textContent = data.trackTitle;
    document.getElementById("trackArtist").textContent = data.trackArtist
      ? `— ${data.trackArtist}`
      : "";
  }

  codecPill.textContent = data.codec.toUpperCase();
  modePill.textContent = (data.streamMode || "MSE").toUpperCase();
  modePill.classList.remove("hidden");

  const hasRate = data.avgKbps > 0;
  document.getElementById("avgVal").textContent = hasRate ? data.avgKbps : "LIVE";
  document.getElementById("tierText").textContent = classifySource(data.codec, data.avgKbps);
  document.getElementById("instantVal").textContent = hasRate ? `${data.instantKbps} kbps` : "—";
  document.getElementById("peakVal").textContent = hasRate ? `${data.peakKbps} kbps` : "—";
  document.getElementById("mimeVal").textContent = data.mimeType;
  document.getElementById("chunkInfo").textContent =
    data.lastChunkBytes > 0
      ? `${(data.lastChunkBytes / 1024).toFixed(1)} KB / ${data.lastDeltaSec}s (#${data.chunkCount})`
      : `${data.lastDeltaSec}s (#${data.chunkCount})`;

  bitrateChart.update(data);
  if (targetFft) evaluateVerdict(targetFft);
  updateStatusBar();
}

function updateButtons(capturing) {
  isCapturingCurrentTab = capturing;
  const toggleBtn = document.getElementById("btnToggleFft");
  const resetBtn = document.getElementById("btnResetFft");

  if (capturing) {
    toggleBtn.textContent = "Stop FFT";
    toggleBtn.className = "btn-danger";
    resetBtn.classList.remove("hidden");
  } else {
    toggleBtn.textContent = "Start FFT";
    toggleBtn.className = "btn-primary";
    resetBtn.classList.add("hidden");
  }
  updateStatusBar();
}

function evaluateVerdict(fft) {
  const verdictBox = document.getElementById("verdictBox");

  if (fft.drmSilentWarning) {
    verdictBox.className = "verdict warn";
    verdictBox.textContent =
      "No audio signal — tab is muted or DRM-protected (e.g., Spotify Web).";
    return;
  }

  if (fft.activeSeconds < 4.5 || !fft.cutoffHz) {
    verdictBox.className = "verdict";
    verdictBox.textContent = `Accumulating Max-Hold (${fft.activeSeconds.toFixed(1)}s / ~5s) — waiting for transients...`;
    return;
  }

  const khz = (fft.cutoffHz / 1000).toFixed(1);
  const drPart = fft.crestDb != null ? `DR ${fft.crestDb.toFixed(1)} dB` : "DR —";
  const layer1Codec = latestLayer1?.codec || "";
  const reportedKbps = latestLayer1?.avgKbps || 0;

  const layer1Lossy =
    isKnownLossyCodec(layer1Codec) ||
    (reportedKbps > 0 && reportedKbps < 500 && !isKnownLosslessCodec(layer1Codec));
  const layer1Lossless =
    isKnownLosslessCodec(layer1Codec) || reportedKbps >= 500;
  const spectralLossless =
    fft.cutoffHz >= 21300 || (fft.cutoffHz >= 20800 && !fft.isBrickwall);

  if (!layer1Lossy && spectralLossless) {
    verdictBox.className = "verdict good";
  } else if (fft.cutoffHz >= 19000) {
    if (layer1Lossless && fft.cutoffHz < 20500) {
      verdictBox.className = "verdict warn";
    } else {
      verdictBox.className = "verdict ok";
    }
  } else if (fft.cutoffHz >= 17000) {
    verdictBox.className = layer1Lossless ? "verdict fake" : "verdict warn";
  } else {
    verdictBox.className = "verdict fake";
  }
  verdictBox.textContent = `~${khz} kHz | ${drPart}`;
}

function drawSpectrumFrame(nyquist, liveBins, maxBins, caps, cutoffHz) {
  const { w, h } = syncCanvasDpr(canvas, ctx, 436, 120);
  const padRight = 32;
  const padBottom = 15;
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
  ctx.font = "9.5px Segoe UI, Tahoma, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (const db of dbTicks) {
    const y = Math.round(dbToY(db)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.fillText(`${db}dB`, w - 2, y);
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

  const isLog = spectrumScale === "log";

  if (liveBins && maxBins) {
    const count = liveBins.length;
    const slotW = plotW / count;
    const gap = isLog ? 1.5 : 1;

    const barGrad = ctx.createLinearGradient(0, 0, 0, plotH);
    barGrad.addColorStop(0, "#a8bccf");
    barGrad.addColorStop(0.6, "#889db2");
    barGrad.addColorStop(1, "#6b7e91");

    ctx.fillStyle = barGrad;
    for (let i = 0; i < count; i++) {
      const y = dbToY(liveBins[i]);
      const barH = plotH - y;
      if (barH > 0.5) {
        ctx.fillRect(i * slotW, y, Math.max(1, slotW - gap), barH);
      }
    }

    if (caps) {
      ctx.fillStyle = "#e6eef5";
      for (let i = 0; i < count; i++) {
        if (caps[i] > MIN_DB + 2) {
          const cy = Math.floor(dbToY(caps[i]));
          ctx.fillRect(i * slotW, cy - 1, Math.max(1, slotW - gap), 1);
        }
      }
    }

    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = i * slotW + (slotW - gap) / 2;
      const y = dbToY(maxBins[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#d96b88";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  if (isLog) {
    const n = LOG_31_LABELS.length;
    const slotW = plotW / n;
    ctx.fillStyle = "#7a7a7a";
    ctx.font = "9px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let i = 0; i < n; i++) {
      const lbl = LOG_31_LABELS[i];
      if (!lbl) continue;
      const cx = i * slotW + slotW / 2;
      ctx.fillText(lbl, cx, h - 3);
    }
  } else {
    const markers = [
      { hz: 8000, label: "8k", color: "rgba(135, 135, 135, 0.45)" },
      { hz: 12000, label: "12k", color: "rgba(135, 135, 135, 0.45)" },
      { hz: 16000, label: "16k", color: "rgba(214, 147, 45, 0.78)" },
      { hz: 20000, label: "20k", color: "rgba(61, 163, 93, 0.78)" },
      { hz: 22050, label: "22k", color: "rgba(176, 118, 214, 0.72)" },
    ];

    ctx.save();
    ctx.setLineDash([2, 2]);
    ctx.font = "9.5px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "left";
    for (const m of markers) {
      if (m.hz >= nyquist) continue;
      const x = Math.round((m.hz / nyquist) * plotW) + 0.5;
      ctx.strokeStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, x - 8, h - 3);
    }
    ctx.restore();

    ctx.fillStyle = "#7a7a7a";
    ctx.font = "9.5px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("0k", 2, h - 3);
    ctx.fillText(`${(nyquist / 1000).toFixed(0)}k`, plotW - 18, h - 3);

    if (cutoffHz) {
      const cx = Math.round((cutoffHz / nyquist) * plotW) + 0.5;
      ctx.strokeStyle = "#3399ff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, plotH);
      ctx.stroke();
    }
  }
}

function drawLevelMeter(peakDbfs, rmsDbfs, heldPeak, crestDb) {
  const { w, h } = syncCanvasDpr(meterCanvas, meterCtx, 436, 22);
  meterCtx.clearRect(0, 0, w, h);
  meterCtx.fillStyle = "#161616";
  meterCtx.fillRect(0, 0, w, h);

  const labelPadRight = 186;
  const barW = Math.max(40, w - labelPadRight - 8);
  const barX = 4;
  const barY = 5;
  const barH = h - 10;

  meterCtx.fillStyle = "#101010";
  meterCtx.fillRect(barX, barY, barW, barH);
  meterCtx.strokeStyle = "#2c2c2c";
  meterCtx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);

  const dbToX = (db) => {
    const clamped = Math.max(-60, Math.min(0, db));
    return barX + ((clamped + 60) / 60) * barW;
  };

  if (peakDbfs > -60) {
    const px = dbToX(peakDbfs);
    meterCtx.fillStyle = "rgba(82, 148, 207, 0.32)";
    meterCtx.fillRect(barX, barY, Math.max(0, px - barX), barH);
  }

  if (rmsDbfs > -60) {
    const rx = dbToX(rmsDbfs);
    meterCtx.fillStyle = rmsDbfs > -6 ? "#d6932d" : "#5294cf";
    meterCtx.fillRect(barX, barY, Math.max(0, rx - barX), barH);
  }

  if (heldPeak > -60) {
    const hx = Math.round(dbToX(heldPeak));
    meterCtx.fillStyle = heldPeak > -0.5 ? "#cf4646" : "#e6eef5";
    meterCtx.fillRect(hx - 1, barY, 2, barH);
  }

  const peakStr = peakDbfs > -90 ? `${peakDbfs.toFixed(1)}` : "-∞";
  const rmsStr = rmsDbfs > -90 ? `${rmsDbfs.toFixed(1)}` : "-∞";
  const drStr = crestDb != null ? `${crestDb.toFixed(1)}dB` : "—";

  meterCtx.font = "10px Segoe UI, Tahoma, sans-serif";
  meterCtx.textAlign = "right";
  meterCtx.textBaseline = "middle";
  meterCtx.fillStyle = "#a8a8a8";
  meterCtx.fillText(`Pk ${peakStr} | RMS ${rmsStr} | DR ${drStr}`, w - 5, h / 2);
}

function getWaterfallLayout(w, h) {
  const padLeft = 30;
  const padRight = 38;
  const padTop = 6;
  const padBottom = 16;
  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);
  return { padLeft, padRight, padTop, padBottom, plotW, plotH };
}

function drawWaterfallFrame(nyquist, cutoffHz) {
  const { w, h } = syncCanvasDpr(wfViewCanvas, wfViewCtx, 436, 164);
  const { padLeft, padTop, plotW, plotH } = getWaterfallLayout(w, h);
  const totalSec = WF_WIDTH / WF_COLS_PER_SEC;

  wfViewCtx.clearRect(0, 0, w, h);
  wfViewCtx.fillStyle = "#181818";
  wfViewCtx.fillRect(0, 0, w, h);

  wfViewCtx.save();
  wfViewCtx.imageSmoothingEnabled = false;
  wfViewCtx.drawImage(wfCanvas, padLeft, padTop, plotW, plotH);
  wfViewCtx.restore();

  wfViewCtx.strokeStyle = "#333333";
  wfViewCtx.lineWidth = 1;
  wfViewCtx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

  // Bottom Time Axis ticks & subtle vertical grid (-12s -> 0s)
  wfViewCtx.save();
  wfViewCtx.font = "9px Segoe UI, Tahoma, sans-serif";
  wfViewCtx.textBaseline = "alphabetic";
  const stepSec = 2;
  for (let s = 0; s <= Math.floor(totalSec); s += stepSec) {
    const x = Math.round(padLeft + plotW - (s / totalSec) * plotW) + 0.5;
    if (x < padLeft + 8) continue;

    if (s > 0 && wfHasData) {
      wfViewCtx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      wfViewCtx.beginPath();
      wfViewCtx.moveTo(x, padTop + 1);
      wfViewCtx.lineTo(x, padTop + plotH - 1);
      wfViewCtx.stroke();
    }

    wfViewCtx.strokeStyle = "#555555";
    wfViewCtx.beginPath();
    wfViewCtx.moveTo(x, padTop + plotH);
    wfViewCtx.lineTo(x, padTop + plotH + 3);
    wfViewCtx.stroke();

    wfViewCtx.fillStyle = "#7a7a7a";
    wfViewCtx.textAlign = s === 0 ? "right" : "center";
    const lbl = s === 0 ? "0s" : `-${s}s`;
    wfViewCtx.fillText(lbl, s === 0 ? padLeft + plotW : x, h - 3);
  }
  wfViewCtx.restore();

  const yMarkers = [
    { hz: 4000, label: "4k", color: "rgba(160, 160, 160, 0.25)", text: "#7a7a7a" },
    { hz: 8000, label: "8k", color: "rgba(160, 160, 160, 0.3)", text: "#969696" },
    { hz: 12000, label: "12k", color: "rgba(160, 160, 160, 0.3)", text: "#969696" },
    { hz: 16000, label: "16k", color: "rgba(214, 147, 45, 0.65)", text: "#d6932d" },
    { hz: 20000, label: "20k", color: "rgba(61, 163, 93, 0.72)", text: "#5cc47b" },
    { hz: 22050, label: "22k", color: "rgba(176, 118, 214, 0.58)", text: "#c494e6" },
  ];

  wfViewCtx.save();
  wfViewCtx.font = "9.5px Segoe UI, Tahoma, sans-serif";
  wfViewCtx.textAlign = "right";
  wfViewCtx.textBaseline = "middle";

  wfViewCtx.fillStyle = "#7a7a7a";
  wfViewCtx.fillText("0k", padLeft - 4, padTop + plotH - 3);
  wfViewCtx.fillText(`${(nyquist / 1000).toFixed(0)}k`, padLeft - 4, padTop + 4);

  wfViewCtx.setLineDash([3, 3]);
  for (const m of yMarkers) {
    if (m.hz >= nyquist - 400) continue;
    const y = Math.round(padTop + (1 - m.hz / nyquist) * plotH) + 0.5;
    wfViewCtx.strokeStyle = m.color;
    wfViewCtx.beginPath();
    wfViewCtx.moveTo(padLeft, y);
    wfViewCtx.lineTo(padLeft + plotW, y);
    wfViewCtx.stroke();

    wfViewCtx.fillStyle = m.text;
    wfViewCtx.fillText(m.label, padLeft - 4, y);
  }
  wfViewCtx.restore();

  if (cutoffHz && wfHasData) {
    const cy =
      Math.round(padTop + (1 - Math.min(cutoffHz, nyquist) / nyquist) * plotH) + 0.5;
    wfViewCtx.save();
    wfViewCtx.strokeStyle = "#3399ff";
    wfViewCtx.lineWidth = 1.4;
    wfViewCtx.beginPath();
    wfViewCtx.moveTo(padLeft, cy);
    wfViewCtx.lineTo(padLeft + plotW, cy);
    wfViewCtx.stroke();

    const tag = `Cutoff ~${(cutoffHz / 1000).toFixed(1)}k`;
    wfViewCtx.font = "bold 9.5px Segoe UI, Tahoma, sans-serif";
    const tw = wfViewCtx.measureText(tag).width + 8;
    const tx = padLeft + plotW - tw - 4;
    const ty = Math.max(padTop + 3, cy - 16);
    wfViewCtx.fillStyle = "rgba(24, 24, 24, 0.9)";
    wfViewCtx.fillRect(tx, ty, tw, 14);
    wfViewCtx.strokeStyle = "#3399ff";
    wfViewCtx.lineWidth = 1;
    wfViewCtx.strokeRect(tx, ty, tw, 14);
    wfViewCtx.fillStyle = "#8cc6ff";
    wfViewCtx.fillText(tag, tx + 4, ty + 10);
    wfViewCtx.restore();
  }

  const paletteObj = WF_PALETTES[wfPaletteName] || WF_PALETTES.inferno;
  const legendX = padLeft + plotW + 7;
  const legendW = 7;
  const legendGrad = wfViewCtx.createLinearGradient(0, padTop, 0, padTop + plotH);
  for (const [stop, color] of paletteObj.legend) {
    legendGrad.addColorStop(stop, color);
  }

  wfViewCtx.fillStyle = legendGrad;
  wfViewCtx.fillRect(legendX, padTop, legendW, plotH);
  wfViewCtx.strokeStyle = "#363636";
  wfViewCtx.strokeRect(legendX + 0.5, padTop + 0.5, legendW - 1, plotH - 1);

  const midDb = Math.round((WF_MAX_DB + wfMinDb) / 2);
  wfViewCtx.fillStyle = "#7a7a7a";
  wfViewCtx.font = "9px Segoe UI, Tahoma, sans-serif";
  wfViewCtx.textAlign = "left";
  wfViewCtx.textBaseline = "middle";
  wfViewCtx.fillText(`${WF_MAX_DB}`, legendX + legendW + 3, padTop + 4);
  wfViewCtx.fillText(`${midDb}`, legendX + legendW + 3, padTop + plotH / 2);
  wfViewCtx.fillText(`${wfMinDb}`, legendX + legendW + 3, padTop + plotH - 4);

  if (wfHover.active) {
    const hx = Math.round(padLeft + wfHover.normX * plotW) + 0.5;
    const hy = Math.round(padTop + wfHover.normY * plotH) + 0.5;

    wfViewCtx.save();
    wfViewCtx.setLineDash([2, 2]);
    wfViewCtx.strokeStyle = "rgba(235, 245, 255, 0.7)";
    wfViewCtx.lineWidth = 1;
    wfViewCtx.beginPath();
    wfViewCtx.moveTo(hx, padTop);
    wfViewCtx.lineTo(hx, padTop + plotH);
    wfViewCtx.moveTo(padLeft, hy);
    wfViewCtx.lineTo(padLeft + plotW, hy);
    wfViewCtx.stroke();
    wfViewCtx.setLineDash([]);

    wfViewCtx.fillStyle = "#ffffff";
    wfViewCtx.fillRect(hx - 1.5, hy - 1.5, 3, 3);

    const freqHz = (1 - wfHover.normY) * nyquist;
    const freqStr =
      freqHz >= 1000 ? `${(freqHz / 1000).toFixed(2)} kHz` : `${Math.round(freqHz)} Hz`;
    const timeAgo = (1 - wfHover.normX) * totalSec;
    const timeStr = timeAgo < 0.05 ? "0.0s" : `-${timeAgo.toFixed(1)}s`;

    const col = Math.max(0, Math.min(WF_WIDTH - 1, Math.floor(wfHover.normX * WF_WIDTH)));
    const row = Math.max(0, Math.min(WF_HEIGHT - 1, Math.floor(wfHover.normY * WF_HEIGHT)));
    const dbVal = wfDbBuffer[col * WF_HEIGHT + row];
    const dbStr = wfHasData && dbVal > -135 ? `${dbVal.toFixed(1)} dB` : "-∞ dB";

    const hudText = `${freqStr} | ${dbStr} | ${timeStr}`;
    wfViewCtx.font = "bold 9.5px Segoe UI, Tahoma, sans-serif";
    const boxW = wfViewCtx.measureText(hudText).width + 10;
    const boxH = 16;

    let bx = hx + 7;
    if (bx + boxW > padLeft + plotW - 2) bx = hx - boxW - 7;
    bx = Math.max(padLeft + 2, bx);

    let by = hy - boxH - 6;
    if (by < padTop + 2) by = hy + 7;
    by = Math.min(padTop + plotH - boxH - 2, by);

    wfViewCtx.fillStyle = "rgba(18, 18, 18, 0.92)";
    wfViewCtx.fillRect(bx, by, boxW, boxH);
    wfViewCtx.strokeStyle = "#5294cf";
    wfViewCtx.lineWidth = 1;
    wfViewCtx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);

    wfViewCtx.fillStyle = "#e6eef5";
    wfViewCtx.textAlign = "left";
    wfViewCtx.textBaseline = "middle";
    wfViewCtx.fillText(hudText, bx + 5, by + boxH / 2 + 0.5);
    wfViewCtx.restore();
  } else if (!wfHasData) {
    wfViewCtx.fillStyle = "#6e6e6e";
    wfViewCtx.font = "11px Segoe UI, Tahoma, sans-serif";
    wfViewCtx.textAlign = "center";
    wfViewCtx.textBaseline = "middle";
    wfViewCtx.fillText(
      "Spek Waterfall — Click 'Start FFT' above to begin",
      padLeft + plotW / 2,
      padTop + plotH / 2
    );
  }
}

function redrawWaterfallIdleIfNeeded() {
  if (!rafId) {
    const nyquist = targetFft?.nyquist || (latestSampleRate ? latestSampleRate / 2 : 24000);
    drawWaterfallFrame(nyquist, smoothCutoffHz);
  }
}

function renderLoop(now) {
  if (!isCapturingCurrentTab || !targetFft) {
    rafId = null;
    return;
  }

  const dt = lastRenderTs ? Math.min((now - lastRenderTs) / 1000, 0.1) : 1 / 60;
  lastRenderTs = now;

  const colSource = wfPendingBins || targetFft.liveBins;
  const nyquist = targetFft.nyquist || 24000;

  if (colSource) {
    const wfStepSec = 1 / WF_COLS_PER_SEC;
    wfAccumSec += dt;
    let steps = 0;
    while (wfAccumSec >= wfStepSec && steps < 3) {
      pushWaterfallColumn(colSource, false);
      wfAccumSec -= wfStepSec;
      steps += 1;
    }
    if (steps > 0) {
      wfPendingBins = null;
      if (steps === 3) wfAccumSec = 0;
    }
  }

  const tLive =
    spectrumScale === "log" && targetFft.logLiveBins ? targetFft.logLiveBins : targetFft.liveBins;
  const tMax =
    spectrumScale === "log" && targetFft.logMaxBins ? targetFft.logMaxBins : targetFft.maxBins;

  if (tLive && tMax) {
    const n = tLive.length;
    if (!smoothLive || smoothLive.length !== n) {
      smoothLive = Float32Array.from(tLive);
      smoothMax = Float32Array.from(tMax);
      peakCaps = Float32Array.from(tLive);
    } else {
      const attackAlpha = 1 - Math.exp(-ATTACK_SPEED * dt);
      const decayAlpha = 1 - Math.exp(-DECAY_SPEED * dt);
      const maxAlpha = 1 - Math.exp(-16 * dt);

      for (let i = 0; i < n; i++) {
        const targetVal = tLive[i];
        const alpha = targetVal > smoothLive[i] ? attackAlpha : decayAlpha;
        smoothLive[i] += (targetVal - smoothLive[i]) * alpha;

        if (smoothLive[i] >= peakCaps[i]) {
          peakCaps[i] = smoothLive[i];
        } else {
          peakCaps[i] = Math.max(smoothLive[i], peakCaps[i] - PEAK_FALL_DB_PER_SEC * dt);
        }

        if (tMax[i] > smoothMax[i]) {
          smoothMax[i] = tMax[i];
        } else {
          smoothMax[i] += (tMax[i] - smoothMax[i]) * maxAlpha;
        }
      }
    }
  }

  const targetPeak = targetFft.peakDbfs ?? -100;
  const targetRms = targetFft.rmsDbfs ?? -100;
  const meterAttack = 1 - Math.exp(-40 * dt);
  const meterDecay = 1 - Math.exp(-14 * dt);

  smoothPeakDbfs +=
    (targetPeak - smoothPeakDbfs) * (targetPeak > smoothPeakDbfs ? meterAttack : meterDecay);
  smoothRmsDbfs +=
    (targetRms - smoothRmsDbfs) * (targetRms > smoothRmsDbfs ? meterAttack : meterDecay);

  if (smoothPeakDbfs >= heldPeakDbfs) {
    heldPeakDbfs = smoothPeakDbfs;
  } else {
    heldPeakDbfs = Math.max(smoothPeakDbfs, heldPeakDbfs - 14 * dt);
  }

  if (targetFft.cutoffHz && targetFft.activeSeconds >= 2) {
    if (smoothCutoffHz === null) {
      smoothCutoffHz = targetFft.cutoffHz;
    } else {
      smoothCutoffHz += (targetFft.cutoffHz - smoothCutoffHz) * (1 - Math.exp(-14 * dt));
    }
  } else {
    smoothCutoffHz = null;
  }

  drawSpectrumFrame(nyquist, smoothLive, smoothMax, peakCaps, smoothCutoffHz);
  drawLevelMeter(smoothPeakDbfs, smoothRmsDbfs, heldPeakDbfs, targetFft.crestDb ?? null);
  drawWaterfallFrame(nyquist, smoothCutoffHz);

  rafId = requestAnimationFrame(renderLoop);
}

function startRenderLoop() {
  if (!rafId) {
    lastRenderTs = 0;
    rafId = requestAnimationFrame(renderLoop);
  }
}

function stopRenderLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  targetFft = null;
  wfPendingBins = null;
  lastActiveSeconds = 0;
  resetAnimBuffers();
}

function ingestFftFrame(fft, isInitialState = false) {
  if (!fft || !fft.capturing || fft.tabId !== currentTabId) {
    latestSampleRate = null;
    updateButtons(false);
    stopRenderLoop();
    clearWaterfall();
    drawSpectrumFrame(24000, null, null, null, null);
    drawLevelMeter(-100, -100, -100, null);
    drawWaterfallFrame(24000, null);
    return;
  }

  if (isInitialState && Array.isArray(fft.wfHistory) && fft.wfHistory.length) {
    hydrateWaterfall(fft.wfHistory);
  } else if ((fft.activeSeconds || 0) < lastActiveSeconds - 0.5) {
    resetAnimBuffers();
    clearWaterfall();
  }
  lastActiveSeconds = fft.activeSeconds || 0;

  // Accumulate peak energy across all incoming FFT frames between waterfall column shifts
  if (fft.liveBins) {
    if (!wfPendingBins || wfPendingBins.length !== fft.liveBins.length) {
      wfPendingBins = Float32Array.from(fft.liveBins);
    } else {
      for (let i = 0; i < fft.liveBins.length; i++) {
        if (fft.liveBins[i] > wfPendingBins[i]) {
          wfPendingBins[i] = fft.liveBins[i];
        }
      }
    }
  }

  latestSampleRate = fft.sampleRate || 48000;
  updateButtons(true);
  targetFft = fft;
  startRenderLoop();

  const now = performance.now();
  if (isInitialState || now - lastDomUpdateTs >= 120) {
    lastDomUpdateTs = now;
    document.getElementById("cutoffVal").textContent = fft.cutoffHz
      ? `~${(fft.cutoffHz / 1000).toFixed(1)} kHz`
      : "Measuring...";
    document.getElementById("sampleTimeVal").textContent = `${(fft.activeSeconds || 0).toFixed(1)}s`;
    document.getElementById("srVal").textContent = `${(latestSampleRate / 1000).toFixed(1)} kHz`;
    evaluateVerdict(fft);
    updateStatusBar();
  }
}

function setSpectrumScale(scale) {
  spectrumScale = scale;
  document.getElementById("btnScaleLin").classList.toggle("active", scale === "lin");
  document.getElementById("btnScaleLog").classList.toggle("active", scale === "log");
  smoothLive = null;
  smoothMax = null;
  peakCaps = null;
  if (!rafId) {
    drawSpectrumFrame(24000, null, null, null, null);
  }
}

wfViewCanvas.addEventListener("mousemove", (e) => {
  const rect = wfViewCanvas.getBoundingClientRect();
  const { padLeft, padTop, plotW, plotH } = getWaterfallLayout(rect.width, rect.height);
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  if (mx >= padLeft && mx <= padLeft + plotW && my >= padTop && my <= padTop + plotH) {
    wfHover.active = true;
    wfHover.normX = Math.max(0, Math.min(1, (mx - padLeft) / plotW));
    wfHover.normY = Math.max(0, Math.min(1, (my - padTop) / plotH));
  } else {
    wfHover.active = false;
  }
  redrawWaterfallIdleIfNeeded();
});

wfViewCanvas.addEventListener("mouseleave", () => {
  if (wfHover.active) {
    wfHover.active = false;
    redrawWaterfallIdleIfNeeded();
  }
});

document.getElementById("wfPaletteSelect").addEventListener("change", (e) => {
  wfPaletteName = e.target.value;
  repaintWaterfallFromDbBuffer();
  redrawWaterfallIdleIfNeeded();
});

document.getElementById("wfFloorSelect").addEventListener("change", (e) => {
  wfMinDb = Number(e.target.value) || -105;
  repaintWaterfallFromDbBuffer();
  redrawWaterfallIdleIfNeeded();
});

document.getElementById("btnScaleLin").addEventListener("click", () => setSpectrumScale("lin"));
document.getElementById("btnScaleLog").addEventListener("click", () => setSpectrumScale("log"));

document.getElementById("btnOpenDashboard").addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "background", type: "OPEN_DASHBOARD" });
});

document.getElementById("btnToggleFft").addEventListener("click", async () => {
  if (!currentTabId) return;

  if (isCapturingCurrentTab) {
    await chrome.runtime.sendMessage({ target: "background", type: "STOP_FFT" });
    latestSampleRate = null;
    updateButtons(false);
    stopRenderLoop();
    clearWaterfall();
    drawSpectrumFrame(24000, null, null, null, null);
    drawLevelMeter(-100, -100, -100, null);
    drawWaterfallFrame(24000, null);
    document.getElementById("cutoffVal").textContent = "—";
    document.getElementById("sampleTimeVal").textContent = "0.0s";
    document.getElementById("srVal").textContent = "— kHz";
    const verdictBox = document.getElementById("verdictBox");
    verdictBox.className = "verdict";
    verdictBox.textContent = "FFT & Waterfall analysis stopped.";
    return;
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: currentTabId,
    });
    const resp = await chrome.runtime.sendMessage({
      target: "background",
      type: "START_FFT",
      tabId: currentTabId,
      streamId,
    });

    if (resp?.ok) {
      clearWaterfall();
      updateButtons(true);
    } else {
      const verdictBox = document.getElementById("verdictBox");
      verdictBox.className = "verdict fake";
      verdictBox.textContent = `Failed to start tabCapture: ${resp?.error || "Unknown error"}`;
    }
  } catch (err) {
    const verdictBox = document.getElementById("verdictBox");
    verdictBox.className = "verdict fake";
    verdictBox.textContent = `Unable to capture tab audio: ${err?.message || err}`;
  }
});

document.getElementById("btnResetFft").addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "background", type: "RESET_FFT" });
  resetAnimBuffers();
  clearWaterfall();
  document.getElementById("cutoffVal").textContent = "Measuring...";
  document.getElementById("sampleTimeVal").textContent = "0.0s";
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.target === "ui" && message.type === "FFT_FRAME") {
    ingestFftFrame(message.payload, false);
  }
});

async function init() {
  drawSpectrumFrame(24000, null, null, null, null);
  drawLevelMeter(-100, -100, -100, null);
  drawWaterfallFrame(24000, null);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  currentTabId = tab.id;
  currentTabUrl = tab.url || "";

  const storageKey = `tab_${tab.id}`;

  chrome.runtime.sendMessage(
    { target: "background", type: "GET_TAB_STATE", tabId: tab.id },
    (data) => renderLayer1(data)
  );

  chrome.runtime.sendMessage(
    { target: "background", type: "GET_FFT_STATE" },
    (fftState) => ingestFftFrame(fftState, true)
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[storageKey]) {
      renderLayer1(changes[storageKey].newValue);
    }
  });
}

init();