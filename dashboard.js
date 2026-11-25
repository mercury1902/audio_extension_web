let cachedTabs = [];
let onlyAudible = false;

// Manage multiple concurrent FFT spectral probes
const probes = new Map(); // probeId -> SpectralProbe
let sharedAudioCtx = null;
let nextProbeSeq = 1;
let pendingLinkTabId = null;

// Unified loops for all active probes
let rafId = null;
let lastRenderTs = 0;
let analysisTimer = null;

const FFT_SIZE = 8192;
const ANALYSIS_MS = 120;
const DISPLAY_BINS = 112;

const MIN_DB = -105;
const MAX_DB = -15;
const ATTACK_SPEED = 36;
const DECAY_SPEED = 14;
const PEAK_FALL_DB_PER_SEC = 26;

// Spek-style Waterfall Spectrogram buffer settings
const WF_WIDTH = 540;
const WF_HEIGHT = 186;
const WF_COLS_PER_SEC = 28;

// Shared 256-level Inferno/Spek thermal color LUT (dark neutral base matching #181818)
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

function detectCutoffHz(holdArr, sr) {
  const binHz = sr / FFT_SIZE;
  const nyquist = sr / 2;

  const midStart = Math.floor(2000 / binHz);
  const midEnd = Math.min(holdArr.length - 1, Math.floor(8000 / binHz));
  const midVals = [];
  for (let i = midStart; i <= midEnd; i++) midVals.push(holdArr[i]);
  const refDb = percentile(midVals, 0.8);
  if (refDb < -72) return { cutoffHz: null, refDb };

  const threshold = Math.max(refDb - 45, -92);
  const stepHz = 250;
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
      return { cutoffHz: Math.round(bands[i].freq), refDb };
    }
  }
  return { cutoffHz: 8000, refDb };
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

function updateBottomStatusBar() {
  const audibleCount = cachedTabs.filter((t) => t.audible).length;
  const mseTabs = cachedTabs.filter((t) => t.telemetry);
  const topBitrate = mseTabs.reduce(
    (max, t) => Math.max(max, t.telemetry?.avgKbps || 0),
    0
  );
  const srText = sharedAudioCtx ? `${sharedAudioCtx.sampleRate} Hz` : "48000 Hz";
  document.getElementById("dashStatusLeft").textContent =
    `Audible: ${audibleCount} | MSE Streams: ${mseTabs.length} | FFT Probes: ${probes.size} | Peak: ${topBitrate ? `${topBitrate} kbps` : "—"}`;
  document.getElementById("dashStatusRight").textContent =
    `FFT ${FFT_SIZE}-pt | ${srText} | Spek Scale (-105dB to -15dB)`;
}

// ---------- SpectralProbe: Manages one tab stream with BOTH charts side-by-side ----------

class SpectralProbe {
  constructor(options) {
    this.id = options.id;
    this.seq = options.seq || 0;
    this.isRemote = Boolean(options.isRemote);
    this.rawLabel = options.rawLabel || "Tab audio";
    this.linkedTabId = options.linkedTabId ?? null;

    this.stream = options.stream || null;
    this.sourceNode = options.sourceNode || null;
    this.analyser = options.analyser || null;
    this.sampleRate = options.sampleRate || 48000;

    if (this.analyser) {
      const bins = this.analyser.frequencyBinCount;
      this.freqData = new Float32Array(bins);
      this.maxHold = new Float32Array(bins).fill(-140);
    } else {
      this.freqData = null;
      this.maxHold = null;
    }

    this.totalFrames = 0;
    this.activeFrames = 0;
    this.overallMaxDb = -160;
    this.cutoffHz = null;
    this.activeSeconds = 0;
    this.drmSilentWarning = false;

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

    this.wfCanvas = document.createElement("canvas");
    this.wfCanvas.width = WF_WIDTH;
    this.wfCanvas.height = WF_HEIGHT;
    this.wfCtx = this.wfCanvas.getContext("2d");
    this.wfColImg = this.wfCtx.createImageData(1, WF_HEIGHT);
    this.wfAccumSec = 0;
    this.wfHasData = false;
    this.clearWaterfall();

    this._buildDom();
    this.syncTabLinkOptions();
    this.updateHeaderTitle();
  }

  _buildDom() {
    const el = document.createElement("div");
    el.className = "probe-card";
    el.dataset.probeId = this.id;

    const badgeText = this.isRemote ? "POPUP" : `#${this.seq}`;
    const badgeClass = this.isRemote ? "probe-badge is-popup" : "probe-badge";

    el.innerHTML = `
      <div class="probe-head">
        <div class="probe-title-wrap">
          <span class="${badgeClass}">${badgeText}</span>
          <div class="probe-name js-probe-name"></div>
        </div>
        <div class="probe-controls">
          ${
            this.isRemote
              ? ""
              : `<select class="probe-link-select js-link-select" title="Link to a tab to display track name & cross-check Layer 1 bitrate"></select>`
          }
          <button class="btn-ghost btn-sm js-probe-reset">Reset</button>
          <button class="btn-danger btn-sm js-probe-stop">Stop</button>
        </div>
      </div>

      <div class="probe-body">
        <div class="dual-charts">
          <div class="chart-pane">
            <div class="chart-pane-head">
              <span>Spectrum (FFT + Max-Hold)</span>
              <span class="chart-pane-sub">Live + Peak Envelope</span>
            </div>
            <canvas class="probe-canvas js-bar-canvas" width="540" height="186"></canvas>
          </div>
          <div class="chart-pane">
            <div class="chart-pane-head">
              <span>Waterfall Spectrogram (Spek)</span>
              <span class="chart-pane-sub">Time-Frequency Heatmap</span>
            </div>
            <canvas class="probe-canvas js-wf-canvas" width="540" height="186"></canvas>
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
    this.linkSelectEl = el.querySelector(".js-link-select");
    this.barCanvas = el.querySelector(".js-bar-canvas");
    this.barCtx = this.barCanvas.getContext("2d");
    this.wfViewCanvas = el.querySelector(".js-wf-canvas");
    this.wfViewCtx = this.wfViewCanvas.getContext("2d");
    this.cutoffEl = el.querySelector(".js-cutoff");
    this.sampleTimeEl = el.querySelector(".js-sample-time");
    this.bitrateRefEl = el.querySelector(".js-bitrate-ref");
    this.srEl = el.querySelector(".js-sr");
    this.verdictEl = el.querySelector(".js-verdict");

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

    el.querySelector(".js-probe-reset").addEventListener("click", () => {
      this.resetAll();
      if (this.isRemote) {
        chrome.runtime.sendMessage({ target: "background", type: "RESET_FFT" });
      }
    });

    el.querySelector(".js-probe-stop").addEventListener("click", () => {
      if (this.isRemote) {
        chrome.runtime.sendMessage({ target: "background", type: "STOP_FFT" });
      }
      removeProbe(this.id);
    });
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
      const suffix = t ? ` [${t.codec} ${t.avgKbps}k]` : tab.audible ? " [LIVE]" : "";
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
    if (this.isRemote || this.linkedTabId == null) return;
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
      this.nameEl.textContent = this.isRemote
        ? `Tab #${this.linkedTabId ?? "?"} (via Popup)`
        : `${this.rawLabel} (Probe #${this.seq})`;
      this.nameEl.title = this.nameEl.textContent;
    }
  }

  clearWaterfall() {
    this.wfCtx.fillStyle = "#181818";
    this.wfCtx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
    this.wfAccumSec = 0;
    this.wfHasData = false;
  }

  drawWaterfallDivider() {
    if (!this.wfHasData) return;
    this.wfCtx.drawImage(this.wfCanvas, -2, 0);
    this.wfCtx.fillStyle = "#3399ff";
    this.wfCtx.fillRect(WF_WIDTH - 2, 0, 2, WF_HEIGHT);
  }

  pushWaterfallColumn(freqArr) {
    if (!freqArr || !freqArr.length) return;
    const srcLen = freqArr.length;
    const data = this.wfColImg.data;
    const dbSpan = MAX_DB - MIN_DB;

    for (let y = 0; y < WF_HEIGHT; y++) {
      const freqTop = 1 - y / WF_HEIGHT;
      const freqBot = 1 - (y + 1) / WF_HEIGHT;
      const bStart = Math.max(0, Math.floor(freqBot * (srcLen - 1)));
      const bEnd = Math.min(srcLen - 1, Math.max(bStart, Math.ceil(freqTop * (srcLen - 1))));

      let maxDb = -140;
      for (let b = bStart; b <= bEnd; b++) {
        if (freqArr[b] > maxDb) maxDb = freqArr[b];
      }

      const norm = Math.max(0, Math.min(1, (maxDb - MIN_DB) / dbSpan));
      const idx = Math.round(norm * 255) * 3;
      const p = y * 4;
      data[p] = SPEK_LUT[idx];
      data[p + 1] = SPEK_LUT[idx + 1];
      data[p + 2] = SPEK_LUT[idx + 2];
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
  }

  resetMaxHoldOnly() {
    if (this.analyser) {
      this.maxHold = new Float32Array(this.analyser.frequencyBinCount).fill(-140);
    }
    this.totalFrames = 0;
    this.activeFrames = 0;
    this.overallMaxDb = -160;
    this.cutoffHz = null;
    this.activeSeconds = 0;
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
    this.drmSilentWarning = Boolean(payload.drmSilentWarning);

    if (payload.tabId != null && payload.tabId !== this.linkedTabId) {
      this.linkedTabId = payload.tabId;
      this.updateHeaderTitle();
    }
  }

  runAnalysisTick() {
    if (this.isRemote) {
      this.updateTextUi();
      return;
    }
    if (!this.analyser || !this.freqData || !this.maxHold) return;

    this.analyser.getFloatFrequencyData(this.freqData);
    this.totalFrames += 1;

    if (document.hidden) {
      this.pushWaterfallColumn(this.freqData);
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
    const { cutoffHz } = detectCutoffHz(this.maxHold, this.sampleRate);
    this.cutoffHz = cutoffHz;
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
    const wfStepSec = 1 / WF_COLS_PER_SEC;
    let nyquist = this.sampleRate / 2;

    if (!this.isRemote && this.analyser && this.freqData && this.maxHold) {
      this.analyser.getFloatFrequencyData(this.freqData);

      this.wfAccumSec += dt;
      let steps = 0;
      while (this.wfAccumSec >= wfStepSec && steps < 3) {
        this.pushWaterfallColumn(this.freqData);
        this.wfAccumSec -= wfStepSec;
        steps += 1;
      }
      if (steps === 3) this.wfAccumSec = 0;

      downsampleToArray(this.freqData, DISPLAY_BINS, this.scratchLiveBins);
      downsampleToArray(this.maxHold, DISPLAY_BINS, this.scratchMaxBins);
      this.stepSmoothing(this.scratchLiveBins, this.scratchMaxBins, dt);
    } else if (this.isRemote && this.remoteTarget?.liveBins && this.remoteTarget?.maxBins) {
      nyquist = this.remoteTarget.nyquist || 24000;

      this.wfAccumSec += dt;
      let steps = 0;
      while (this.wfAccumSec >= wfStepSec && steps < 3) {
        this.pushWaterfallColumn(this.remoteTarget.liveBins);
        this.wfAccumSec -= wfStepSec;
        steps += 1;
      }
      if (steps === 3) this.wfAccumSec = 0;

      this.stepSmoothing(this.remoteTarget.liveBins, this.remoteTarget.maxBins, dt);
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
    this.drawWaterfallChart(nyquist);
  }

  drawBarsChart(nyquist) {
    const ctx = this.barCtx;
    const { w, h } = syncCanvasDpr(this.barCanvas, ctx, 540, 186);
    const padRight = 34; // foobar2000 right-aligned dB scale
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

    // Horizontal dB grid + right-aligned labels
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

    // Crisp axis dividers
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(plotW, plotH + 0.5);
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, plotH);
    ctx.stroke();

    if (this.smoothLive && this.smoothMax) {
      const count = this.smoothLive.length;
      const barW = plotW / count;

      // foobar2000 steel-grey/blue crisp rectangular bars
      const barGrad = ctx.createLinearGradient(0, 0, 0, plotH);
      barGrad.addColorStop(0, "#a8bccf");
      barGrad.addColorStop(0.6, "#889db2");
      barGrad.addColorStop(1, "#6b7e91");

      ctx.fillStyle = barGrad;
      for (let i = 0; i < count; i++) {
        const y = dbToY(this.smoothLive[i]);
        const barH = plotH - y;
        if (barH > 0.5) {
          ctx.fillRect(i * barW, y, Math.max(1.2, barW - 1.2), barH);
        }
      }

      // Crisp 1.5px peak caps
      if (this.peakCaps) {
        ctx.fillStyle = "#e6eef5";
        for (let i = 0; i < count; i++) {
          if (this.peakCaps[i] > MIN_DB + 2) {
            const cy = Math.floor(dbToY(this.peakCaps[i]));
            ctx.fillRect(i * barW, cy - 1.5, Math.max(1.2, barW - 1.2), 1.5);
          }
        }
      }

      // Max-Hold envelope
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const x = i * barW + barW / 2;
        const y = dbToY(this.smoothMax[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#d96b88";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    const markers = [
      { hz: 8000, label: "8k", color: "rgba(135, 135, 135, 0.45)" },
      { hz: 12000, label: "12k", color: "rgba(135, 135, 135, 0.45)" },
      { hz: 16000, label: "16k", color: "rgba(214, 147, 45, 0.78)" },
      { hz: 20000, label: "20k", color: "rgba(61, 163, 93, 0.78)" },
      { hz: 22050, label: "22k", color: "rgba(176, 118, 214, 0.72)" },
    ];

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.font = "10.5px Segoe UI, Tahoma, sans-serif";
    for (const m of markers) {
      if (m.hz >= nyquist) continue;
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
    ctx.fillText("0k", 3, h - 4);
    ctx.fillText(`${(nyquist / 1000).toFixed(0)}k`, plotW - 22, h - 4);

    if (this.smoothCutoffHz) {
      const cx = Math.round((this.smoothCutoffHz / nyquist) * plotW) + 0.5;
      ctx.strokeStyle = "#3399ff";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, plotH);
      ctx.stroke();
    }
  }

  drawWaterfallChart(nyquist) {
    const ctx = this.wfViewCtx;
    const { w, h } = syncCanvasDpr(this.wfViewCanvas, ctx, 540, 186);
    const padLeft = 32;
    const padRight = 40;
    const padTop = 6;
    const padBottom = 8;
    const plotW = Math.max(10, w - padLeft - padRight);
    const plotH = Math.max(10, h - padTop - padBottom);

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

    const yMarkers = [
      { hz: 4000, label: "4k", color: "rgba(160, 160, 160, 0.25)", text: "#7a7a7a" },
      { hz: 8000, label: "8k", color: "rgba(160, 160, 160, 0.3)", text: "#969696" },
      { hz: 12000, label: "12k", color: "rgba(160, 160, 160, 0.3)", text: "#969696" },
      { hz: 16000, label: "16k", color: "rgba(214, 147, 45, 0.65)", text: "#d6932d" },
      { hz: 20000, label: "20k", color: "rgba(61, 163, 93, 0.72)", text: "#5cc47b" },
      { hz: 22050, label: "22k", color: "rgba(176, 118, 214, 0.58)", text: "#c494e6" },
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

    const legendX = padLeft + plotW + 8;
    const legendW = 8;
    const legendGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    legendGrad.addColorStop(0.0, "rgb(255,252,234)");
    legendGrad.addColorStop(0.12, "rgb(253,208,64)");
    legendGrad.addColorStop(0.28, "rgb(244,120,36)");
    legendGrad.addColorStop(0.46, "rgb(196,46,90)");
    legendGrad.addColorStop(0.66, "rgb(106,27,132)");
    legendGrad.addColorStop(0.84, "rgb(34,22,72)");
    legendGrad.addColorStop(1.0, "rgb(24,24,24)");

    ctx.fillStyle = legendGrad;
    ctx.fillRect(legendX, padTop, legendW, plotH);
    ctx.strokeStyle = "#363636";
    ctx.strokeRect(legendX + 0.5, padTop + 0.5, legendW - 1, plotH - 1);

    ctx.fillStyle = "#7a7a7a";
    ctx.font = "9.5px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("-15", legendX + legendW + 3, padTop + 5);
    ctx.fillText("-60", legendX + legendW + 3, padTop + plotH / 2);
    ctx.fillText("-105", legendX + legendW + 3, padTop + plotH - 4);
  }

  updateTextUi() {
    this.cutoffEl.textContent = this.cutoffHz
      ? `~${(this.cutoffHz / 1000).toFixed(1)} kHz`
      : "Measuring...";
    this.sampleTimeEl.textContent = `${this.activeSeconds.toFixed(1)}s`;
    this.srEl.textContent = `${(this.sampleRate / 1000).toFixed(1)} kHz`;

    const linkedTab = this.getLinkedTab();
    const reportedKbps = linkedTab?.telemetry?.avgKbps || 0;
    if (linkedTab?.telemetry) {
      this.bitrateRefEl.innerHTML = `Layer 1: <strong>${esc(linkedTab.telemetry.codec.toUpperCase())} ${reportedKbps} kbps</strong>`;
    } else if (linkedTab) {
      this.bitrateRefEl.innerHTML = `Layer 1: <strong>Non-MSE</strong>`;
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

    if (this.activeSeconds < 4.5 || !this.cutoffHz) {
      box.className = "verdict";
      box.textContent = `Accumulating Max-Hold peaks (${this.activeSeconds.toFixed(1)}s / ~5s) — waiting for transients...`;
      return;
    }

    const khz = (this.cutoffHz / 1000).toFixed(1);
    if (this.cutoffHz >= 21000) {
      box.className = "verdict good";
      box.textContent = `Authentic Lossless / Hi-Res (~${khz} kHz) — full high-frequency extension.`;
    } else if (this.cutoffHz >= 19000) {
      box.className = "verdict ok";
      box.textContent = `Authentic High-Quality Lossy (~${khz} kHz) — matches AAC 256k / Opus / MP3 320k.`;
    } else if (this.cutoffHz >= 17000) {
      if (reportedKbps >= 230) {
        box.className = "verdict warn";
        box.textContent = `Stream reports ${reportedKbps} kbps, but spectrum stops at ~${khz} kHz (dark master or ~192k source).`;
      } else {
        box.className = "verdict warn";
        box.textContent = `Medium-quality Lossy (~${khz} kHz cutoff) — approx. 160–192 kbps.`;
      }
    } else {
      if (reportedKbps >= 200) {
        box.className = "verdict fake";
        box.textContent = `SUSPECTED UPSCALE / RE-ENCODE: Stream reports ${reportedKbps} kbps, but cuts off sharply at ~${khz} kHz (~128k MP3).`;
      } else {
        box.className = "verdict fake";
        box.textContent = `Low-bitrate source (~${khz} kHz cutoff) — approx. 128k MP3 or upscaled.`;
      }
    }
  }

  destroy() {
    try {
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.analyser) this.analyser.disconnect();
    } catch {
      // Ignore disconnect errors if already disconnected
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.sourceNode = null;
    this.analyser = null;
    if (this.el && this.el.parentNode) {
      this.el.remove();
    }
  }
}

// ---------- Unified Loop Orchestration for All Spectral Probes ----------

function updateProbesLayoutState() {
  const count = probes.size;
  document.getElementById("statProbes").textContent = count;
  document.getElementById("probesEmpty").classList.toggle("hidden", count > 0);
  document.getElementById("btnStopAllFft").classList.toggle("hidden", count === 0);
  updateBottomStatusBar();
}

function startUnifiedLoops() {
  if (!analysisTimer) {
    analysisTimer = setInterval(() => {
      const now = performance.now();
      for (const [id, probe] of probes.entries()) {
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
  if (probes.size > 0) return;

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
  if (probes.size === 0) {
    rafId = null;
    return;
  }

  const dt = lastRenderTs ? Math.min((now - lastRenderTs) / 1000, 0.1) : 1 / 60;
  lastRenderTs = now;

  for (const probe of probes.values()) {
    probe.renderFrame(dt);
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
      sourceNode,
      analyser,
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

function syncAllProbesWithTabs() {
  for (const probe of probes.values()) {
    probe.syncTabLinkOptions();
    probe.checkTrackChange();
    probe.updateHeaderTitle();
  }
}

// ---------- Multi-Tab Grid Manager (In-place DOM Patching) ----------

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
          <div class="big-kbps"><span class="js-avg">0</span> <span>kbps avg</span></div>
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
        <div style="font-size:11.5px; color:#969696; line-height:1.45;">
          Audio via HTML5 / WebAudio / WebRTC (non-MSE).<br/>
          Click <strong>Probe FFT</strong> to inspect its real-time spectrum.
        </div>
      </div>
    </div>

    <div class="card-footer">
      <div class="card-footer-left">
        <button class="btn-ghost btn-sm" data-action="focus" data-tab="${tabId}">Go to tab</button>
        <button class="btn-ghost btn-sm js-mute-btn" data-action="mute" data-tab="${tabId}">Mute</button>
      </div>
      <button class="btn-accent btn-sm js-probe-btn" data-action="probe" data-tab="${tabId}">Probe FFT</button>
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
    avgEl: el.querySelector(".js-avg"),
    instantEl: el.querySelector(".js-instant"),
    peakEl: el.querySelector(".js-peak"),
    mimeEl: el.querySelector(".js-mime"),
    muteBtn: el.querySelector(".js-mute-btn"),
    probeBtn: el.querySelector(".js-probe-btn"),
  };
}

function renderTabs(tabs) {
  cachedTabs = tabs || [];
  const filtered = onlyAudible ? cachedTabs.filter((t) => t.audible) : cachedTabs;

  const audibleCount = cachedTabs.filter((t) => t.audible).length;
  const mseTabs = cachedTabs.filter((t) => t.telemetry);
  const topBitrate = mseTabs.reduce(
    (max, t) => Math.max(max, t.telemetry?.avgKbps || 0),
    0
  );

  document.getElementById("statAudible").textContent = audibleCount;
  document.getElementById("statMse").textContent = mseTabs.length;
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
      : `<span class="pill pill-nonmse">NON-MSE</span>`;
    const probeBadge = probed ? `<span class="pill pill-probe">PROBING FFT</span>` : "";
    entry.badgesEl.innerHTML = `${statusBadge}${muteBadge}${codecBadge}${probeBadge}`;

    entry.muteBtn.textContent = item.muted ? "Unmute" : "Mute";
    entry.probeBtn.textContent = probed ? "+ Probe Again" : "Probe FFT";

    if (t) {
      entry.mseWrap.classList.remove("hidden");
      entry.nonMseWrap.classList.add("hidden");
      entry.avgEl.textContent = t.avgKbps;
      entry.instantEl.textContent = `${t.instantKbps} kbps`;
      entry.peakEl.textContent = `${t.peakKbps} kbps`;
      const mimeText = `${t.mimeType} | ${(t.lastChunkBytes / 1024).toFixed(1)} KB / ${t.lastDeltaSec}s (#${t.chunkCount})`;
      entry.mimeEl.textContent = mimeText;
      entry.mimeEl.title = t.mimeType;

      entry.chart.update(t);
    } else {
      entry.mseWrap.classList.add("hidden");
      entry.nonMseWrap.classList.remove("hidden");
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
  }
});

window.addEventListener("resize", () => {
  tabCardMap.forEach((entry) => entry.chart.resize());
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