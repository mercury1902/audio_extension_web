let currentTabId = null;
let latestLayer1 = null;
let latestSampleRate = null;
let isCapturingCurrentTab = false;
let lastActiveSeconds = 0;

const canvas = document.getElementById("fftCanvas");
const ctx = canvas.getContext("2d");
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
let rafId = null;
let lastRenderTs = 0;
let lastDomUpdateTs = 0;

const MIN_DB = -105;
const MAX_DB = -15;
const ATTACK_SPEED = 32; // Fast transient rise on beats/hi-hats
const DECAY_SPEED = 16;  // Smooth ballistic decay
const PEAK_FALL_DB_PER_SEC = 28; // Falling peak cap speed

// Spek-style Waterfall Spectrogram offscreen buffer
const WF_WIDTH = 420;
const WF_HEIGHT = 156;
const WF_COLS_PER_SEC = 32; // ~13 seconds of scrolling history across popup width

const wfCanvas = document.createElement("canvas");
wfCanvas.width = WF_WIDTH;
wfCanvas.height = WF_HEIGHT;
const wfCtx = wfCanvas.getContext("2d");
const wfColImg = wfCtx.createImageData(1, WF_HEIGHT);
let wfAccumSec = 0;
let wfHasData = false;

// 256-level Inferno/Spek thermal color LUT (neutral #181818 base matching foobar2000)
const SPEK_LUT = (() => {
  const stops = [
    { t: 0.0, r: 24, g: 24, b: 24 },
    { t: 0.16, r: 34, g: 22, b: 72 },
    { t: 0.36, r: 106, g: 27, b: 132 },
    { t: 0.56, r: 196, g: 46, b: 90 },
    { t: 0.74, r: 244, g: 120, b: 36 },
    { t: 0.9, r: 253, g: 208, b: 64 },
    { t: 1.0, r: 255, g: 252, b: 234 },
  ];
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
})();

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
  wfCtx.fillStyle = "#181818";
  wfCtx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
  wfAccumSec = 0;
  wfHasData = false;
}

function pushWaterfallColumn(freqArr, isQuantizedByte = false) {
  if (!freqArr || !freqArr.length) return;
  const srcLen = freqArr.length;
  const data = wfColImg.data;
  const dbSpan = MAX_DB - MIN_DB;

  for (let y = 0; y < WF_HEIGHT; y++) {
    const freqTop = 1 - y / WF_HEIGHT;
    const freqBot = 1 - (y + 1) / WF_HEIGHT;
    const bStart = Math.max(0, Math.floor(freqBot * (srcLen - 1)));
    const bEnd = Math.min(srcLen - 1, Math.max(bStart, Math.ceil(freqTop * (srcLen - 1))));

    let lutLevel = 0;
    if (isQuantizedByte) {
      let maxByte = 0;
      for (let b = bStart; b <= bEnd; b++) {
        if (freqArr[b] > maxByte) maxByte = freqArr[b];
      }
      lutLevel = Math.max(0, Math.min(255, maxByte));
    } else {
      let maxDb = -140;
      for (let b = bStart; b <= bEnd; b++) {
        if (freqArr[b] > maxDb) maxDb = freqArr[b];
      }
      const norm = Math.max(0, Math.min(1, (maxDb - MIN_DB) / dbSpan));
      lutLevel = Math.round(norm * 255);
    }

    const idx = lutLevel * 3;
    const p = y * 4;
    data[p] = SPEK_LUT[idx];
    data[p + 1] = SPEK_LUT[idx + 1];
    data[p + 2] = SPEK_LUT[idx + 2];
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
}

function updateStatusBar() {
  const summaryEl = document.getElementById("statusSummary");
  if (!latestLayer1 && !isCapturingCurrentTab) {
    summaryEl.textContent = "IDLE | Waiting for MSE audio stream...";
    return;
  }
  const parts = [];
  if (latestLayer1) {
    parts.push(latestLayer1.codec.toUpperCase());
    parts.push(`${latestLayer1.avgKbps} kbps`);
  } else {
    parts.push("NON-MSE");
  }
  if (latestSampleRate) {
    parts.push(`${latestSampleRate} Hz`);
  }
  if (latestLayer1) {
    parts.push(`#${latestLayer1.chunkCount}`);
  }
  parts.push(isCapturingCurrentTab ? "FFT + SPEK ON" : "FFT OFF");
  summaryEl.textContent = parts.join(" | ");
}

function classifySource(codec, avgKbps) {
  if (codec === "FLAC" || avgKbps >= 500) return "Lossless / Hi-Bitrate";
  if (codec === "Opus" && avgKbps >= 115) return "High-Eff Lossy (~256k eq.)";
  if (avgKbps >= 220) return "High-Bitrate Lossy";
  if (avgKbps >= 110) return "Standard Lossy";
  return "Low-Bitrate Stream";
}

function renderLayer1(data) {
  latestLayer1 = data;
  const emptyEl = document.getElementById("emptyState");
  const liveEl = document.getElementById("liveView");
  const metaEl = document.getElementById("metaBox");
  const codecPill = document.getElementById("codecPill");
  const trackBar = document.getElementById("trackBar");

  if (!data) {
    emptyEl.classList.remove("hidden");
    liveEl.classList.add("hidden");
    metaEl.classList.add("hidden");
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
  document.getElementById("avgVal").textContent = data.avgKbps;
  document.getElementById("tierText").textContent = classifySource(data.codec, data.avgKbps);
  document.getElementById("instantVal").textContent = `${data.instantKbps} kbps`;
  document.getElementById("peakVal").textContent = `${data.peakKbps} kbps`;
  document.getElementById("mimeVal").textContent = data.mimeType;
  document.getElementById("chunkInfo").textContent =
    `${(data.lastChunkBytes / 1024).toFixed(1)} KB / ${data.lastDeltaSec}s (#${data.chunkCount})`;

  bitrateChart.update(data);
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
  const reportedKbps = latestLayer1?.avgKbps || 0;

  if (fft.cutoffHz >= 21000) {
    verdictBox.className = "verdict good";
    verdictBox.textContent = `Authentic Lossless / Hi-Res (~${khz} kHz) — no high-frequency cutoff.`;
  } else if (fft.cutoffHz >= 19000) {
    verdictBox.className = "verdict ok";
    verdictBox.textContent = `Authentic High-Quality Lossy (~${khz} kHz) — matches AAC 256k / Opus / MP3 320k.`;
  } else if (fft.cutoffHz >= 17000) {
    if (reportedKbps >= 230) {
      verdictBox.className = "verdict warn";
      verdictBox.textContent = `Stream reports ${reportedKbps} kbps, cutoff ~${khz} kHz (dark master or ~192k source).`;
    } else {
      verdictBox.className = "verdict warn";
      verdictBox.textContent = `Medium-quality Lossy (~${khz} kHz) — approx. 160–192 kbps.`;
    }
  } else {
    if (reportedKbps >= 200) {
      verdictBox.className = "verdict fake";
      verdictBox.textContent = `SUSPECTED UPSCALE: ${reportedKbps} kbps stream cuts off sharply at ~${khz} kHz (~128k MP3).`;
    } else {
      verdictBox.className = "verdict fake";
      verdictBox.textContent = `Low-bitrate source (~${khz} kHz cutoff, approx. 128 kbps MP3).`;
    }
  }
}

function drawSpectrumFrame(nyquist, liveBins, maxBins, caps, cutoffHz) {
  const { w, h } = syncCanvasDpr(canvas, ctx, 436, 120);
  const padRight = 32; // Right dB scale gutter (foobar2000 style)
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

  // Horizontal dB grid lines + right-aligned labels (-20dB to -100dB)
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

  // Bottom axis baseline & right gutter border
  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, plotH + 0.5);
  ctx.lineTo(plotW, plotH + 0.5);
  ctx.moveTo(plotW + 0.5, 0);
  ctx.lineTo(plotW + 0.5, plotH);
  ctx.stroke();

  if (liveBins && maxBins) {
    const count = liveBins.length;
    const barW = plotW / count;

    // foobar2000 steel-grey/blue crisp rectangular bars
    const barGrad = ctx.createLinearGradient(0, 0, 0, plotH);
    barGrad.addColorStop(0, "#a8bccf");
    barGrad.addColorStop(0.6, "#889db2");
    barGrad.addColorStop(1, "#6b7e91");

    ctx.fillStyle = barGrad;
    for (let i = 0; i < count; i++) {
      const y = dbToY(liveBins[i]);
      const barH = plotH - y;
      if (barH > 0.5) {
        ctx.fillRect(i * barW, y, Math.max(1, barW - 1), barH);
      }
    }

    // Crisp 1px falling peak caps
    if (caps) {
      ctx.fillStyle = "#e6eef5";
      for (let i = 0; i < count; i++) {
        if (caps[i] > MIN_DB + 2) {
          const cy = Math.floor(dbToY(caps[i]));
          ctx.fillRect(i * barW, cy - 1, Math.max(1, barW - 1), 1);
        }
      }
    }

    // Max-Hold envelope line
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = i * barW + barW / 2;
      const y = dbToY(maxBins[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#d96b88";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // Frequency reference lines (8k, 12k, 16k, 20k, 22k)
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
  ctx.fillText("0k", 2, h - 3);
  ctx.fillText(`${(nyquist / 1000).toFixed(0)}k`, plotW - 18, h - 3);

  // Detected Cutoff line
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

function drawWaterfallFrame(nyquist, cutoffHz) {
  const { w, h } = syncCanvasDpr(wfViewCanvas, wfViewCtx, 436, 156);
  const padLeft = 30;
  const padRight = 38;
  const padTop = 5;
  const padBottom = 6;
  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  wfViewCtx.clearRect(0, 0, w, h);
  wfViewCtx.fillStyle = "#181818";
  wfViewCtx.fillRect(0, 0, w, h);

  // Blit offscreen Spek heatmap cleanly
  wfViewCtx.save();
  wfViewCtx.imageSmoothingEnabled = false;
  wfViewCtx.drawImage(wfCanvas, padLeft, padTop, plotW, plotH);
  wfViewCtx.restore();

  // Sharp border around spectrogram
  wfViewCtx.strokeStyle = "#333333";
  wfViewCtx.lineWidth = 1;
  wfViewCtx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

  // Horizontal frequency guide lines (0k at bottom -> Nyquist at top)
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

  // Horizontal detected Cutoff line + tag
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

  // Right-hand dB thermal legend bar (Spek style)
  const legendX = padLeft + plotW + 7;
  const legendW = 7;
  const legendGrad = wfViewCtx.createLinearGradient(0, padTop, 0, padTop + plotH);
  legendGrad.addColorStop(0.0, "rgb(255,252,234)");
  legendGrad.addColorStop(0.12, "rgb(253,208,64)");
  legendGrad.addColorStop(0.28, "rgb(244,120,36)");
  legendGrad.addColorStop(0.46, "rgb(196,46,90)");
  legendGrad.addColorStop(0.66, "rgb(106,27,132)");
  legendGrad.addColorStop(0.84, "rgb(34,22,72)");
  legendGrad.addColorStop(1.0, "rgb(24,24,24)");

  wfViewCtx.fillStyle = legendGrad;
  wfViewCtx.fillRect(legendX, padTop, legendW, plotH);
  wfViewCtx.strokeStyle = "#363636";
  wfViewCtx.strokeRect(legendX + 0.5, padTop + 0.5, legendW - 1, plotH - 1);

  wfViewCtx.fillStyle = "#7a7a7a";
  wfViewCtx.font = "9px Segoe UI, Tahoma, sans-serif";
  wfViewCtx.textAlign = "left";
  wfViewCtx.textBaseline = "middle";
  wfViewCtx.fillText("-15", legendX + legendW + 3, padTop + 4);
  wfViewCtx.fillText("-60", legendX + legendW + 3, padTop + plotH / 2);
  wfViewCtx.fillText("-105", legendX + legendW + 3, padTop + plotH - 4);

  if (!wfHasData) {
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

function renderLoop(now) {
  if (!isCapturingCurrentTab || !targetFft) {
    rafId = null;
    return;
  }

  const dt = lastRenderTs ? Math.min((now - lastRenderTs) / 1000, 0.1) : 1 / 60;
  lastRenderTs = now;

  const tLive = targetFft.liveBins;
  const tMax = targetFft.maxBins;
  const nyquist = targetFft.nyquist || 24000;

  if (tLive && tMax) {
    // Advance Waterfall at steady time-based rate regardless of monitor refresh rate
    const wfStepSec = 1 / WF_COLS_PER_SEC;
    wfAccumSec += dt;
    let steps = 0;
    while (wfAccumSec >= wfStepSec && steps < 3) {
      pushWaterfallColumn(tLive, false);
      wfAccumSec -= wfStepSec;
      steps += 1;
    }
    if (steps === 3) wfAccumSec = 0;

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
    drawWaterfallFrame(24000, null);
    return;
  }

  if (isInitialState && Array.isArray(fft.wfHistory) && fft.wfHistory.length) {
    hydrateWaterfall(fft.wfHistory);
  } else if ((fft.activeSeconds || 0) < lastActiveSeconds - 0.5) {
    // Auto-clear on track change reset from offscreen.js
    resetAnimBuffers();
    clearWaterfall();
  }
  lastActiveSeconds = fft.activeSeconds || 0;

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
  drawWaterfallFrame(24000, null);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  currentTabId = tab.id;

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