// bitrate_chart.js - Full-FPS smooth 12-segment bitrate chart (foobar2000 sharp style)
class SmoothBitrateChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.maxSlots = options.maxSlots || 12;
    this.defaultWidth = options.defaultWidth || 350;
    this.defaultHeight = options.defaultHeight || 38;
    this.onHover = options.onHover || null;

    this.slots = []; // [{ cur, target }]
    this.exitingBar = null; // { val }
    this.slideOffset = 0;
    this.smoothMax = 128;
    this.targetMax = 128;
    this.smoothAvg = 0;
    this.targetAvg = 0;

    this.lastStreamId = null;
    this.lastChunkCount = 0;
    this.hoverIndex = -1;

    this.rafId = null;
    this.lastTs = 0;

    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseLeave = this._handleMouseLeave.bind(this);
    this.canvas.addEventListener("mousemove", this._onMouseMove);
    this.canvas.addEventListener("mouseleave", this._onMouseLeave);

    this.draw();
  }

  _syncDpr() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || this.defaultWidth;
    const cssH = this.canvas.clientHeight || this.defaultHeight;
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  _handleMouseMove(e) {
    if (!this.slots.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const slotW = rect.width / this.maxSlots;
    const idx = Math.floor(x / slotW);
    const nextHover = idx >= 0 && idx < this.slots.length ? idx : -1;

    if (nextHover !== this.hoverIndex) {
      this.hoverIndex = nextHover;
      if (this.onHover) {
        this.onHover(nextHover >= 0 ? Math.round(this.slots[nextHover].target) : null);
      }
      if (!this.rafId) this.draw();
    }
  }

  _handleMouseLeave() {
    if (this.hoverIndex !== -1) {
      this.hoverIndex = -1;
      if (this.onHover) this.onHover(null);
      if (!this.rafId) this.draw();
    }
  }

  update(data) {
    const history = data?.history || [];
    if (!history.length) {
      this.slots = [];
      this.exitingBar = null;
      this.slideOffset = 0;
      this.lastStreamId = null;
      this.lastChunkCount = 0;
      this._stopLoop();
      this.draw();
      return;
    }

    const streamId = data.streamId || "default";
    const chunkCount = data.chunkCount || history.length;
    const isReset =
      streamId !== this.lastStreamId ||
      chunkCount < this.lastChunkCount ||
      this.slots.length === 0;

    const newTargetMax = Math.max(...history, 64) * 1.14;
    this.targetMax = newTargetMax;
    this.targetAvg = data.avgKbps || 0;

    if (isReset) {
      this.slots = history.map((v) => ({ cur: 0, target: v }));
      this.smoothMax = newTargetMax;
      this.smoothAvg = this.targetAvg;
      this.slideOffset = 0;
      this.exitingBar = null;
    } else if (chunkCount > this.lastChunkCount) {
      const delta = chunkCount - this.lastChunkCount;

      if (delta === 1) {
        if (this.slots.length >= this.maxSlots) {
          const removed = this.slots.shift();
          this.exitingBar = { val: removed.cur };
          this.slots.push({ cur: 0, target: history[history.length - 1] });
          this.slideOffset = Math.min(2, this.slideOffset + 1);
        } else {
          this.slots.push({ cur: 0, target: history[history.length - 1] });
        }

        for (let i = 0; i < Math.min(this.slots.length, history.length); i++) {
          this.slots[i].target = history[i];
        }
      } else {
        const prev = this.slots.map((s) => s.cur);
        this.slots = history.map((v, i) => ({
          cur: i < prev.length ? prev[i] : 0,
          target: v,
        }));
        if (history.length >= this.maxSlots) {
          this.slideOffset = Math.min(2, delta);
        }
      }
    } else {
      return;
    }

    this.lastStreamId = streamId;
    this.lastChunkCount = chunkCount;
    this._startLoop();
  }

  _startLoop() {
    if (!this.rafId) {
      this.lastTs = 0;
      this.rafId = requestAnimationFrame((ts) => this._tick(ts));
    }
  }

  _stopLoop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  _tick(now) {
    const dt = this.lastTs ? Math.min((now - this.lastTs) / 1000, 0.05) : 1 / 60;
    this.lastTs = now;

    const heightAlpha = 1 - Math.exp(-15 * dt);
    const scaleAlpha = 1 - Math.exp(-9 * dt);
    let moving = false;

    if (this.slideOffset > 0.002) {
      this.slideOffset *= Math.exp(-13 * dt);
      moving = true;
    } else {
      this.slideOffset = 0;
      this.exitingBar = null;
    }

    if (Math.abs(this.targetMax - this.smoothMax) > 0.25) {
      this.smoothMax += (this.targetMax - this.smoothMax) * scaleAlpha;
      moving = true;
    } else {
      this.smoothMax = this.targetMax;
    }

    if (Math.abs(this.targetAvg - this.smoothAvg) > 0.25) {
      this.smoothAvg += (this.targetAvg - this.smoothAvg) * scaleAlpha;
      moving = true;
    } else {
      this.smoothAvg = this.targetAvg;
    }

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const diff = s.target - s.cur;
      if (Math.abs(diff) > 0.2) {
        s.cur += diff * heightAlpha;
        moving = true;
      } else {
        s.cur = s.target;
      }
    }

    this.draw();

    if (moving) {
      this.rafId = requestAnimationFrame((ts) => this._tick(ts));
    } else {
      this.rafId = null;
    }
  }

  _drawBar(x, w, val, h, isNewest, isHovered, alpha = 1) {
    const ctx = this.ctx;
    const norm = Math.max(0.06, Math.min(1, val / Math.max(this.smoothMax, 1)));
    const barH = Math.max(2, Math.round(norm * (h - 3)));
    const y = h - barH;
    const gap = 1;
    const drawX = Math.floor(x) + gap;
    const drawW = Math.max(2, Math.floor(w) - gap * 2);

    ctx.save();
    ctx.globalAlpha = alpha;

    if (isHovered) {
      ctx.fillStyle = "#d5e4f2";
    } else if (isNewest) {
      ctx.fillStyle = "#3c8cd6";
    } else {
      ctx.fillStyle = "#8ea3b8";
    }

    // Sharp 90-degree Win32/foobar2000 rectangular bar
    ctx.fillRect(drawX, y, drawW, barH);

    // Subtle crisp top highlight line (1px)
    ctx.fillStyle = isHovered ? "#ffffff" : isNewest ? "#7cb8f0" : "#b8cadb";
    ctx.fillRect(drawX, y, drawW, 1);

    ctx.restore();
  }

  draw() {
    const { w, h } = this._syncDpr();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // Inset dark background + crisp horizontal grid
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "#262626";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      const gy = Math.round((h / 3) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    if (!this.slots.length) return;

    const slotW = w / this.maxSlots;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    if (this.exitingBar && this.slideOffset > 0.002) {
      const exX = (-1 + this.slideOffset) * slotW;
      this._drawBar(exX, slotW, this.exitingBar.val, h, false, false, this.slideOffset);
    }

    for (let i = 0; i < this.slots.length; i++) {
      const x = (i + this.slideOffset) * slotW;
      const isNewest = i === this.slots.length - 1;
      const isHovered = i === this.hoverIndex;
      this._drawBar(x, slotW, this.slots[i].cur, h, isNewest, isHovered, 1);
    }

    // Crisp horizontal dashed Rolling Average reference line
    if (this.smoothAvg > 0 && this.smoothMax > 0) {
      const avgNorm = Math.max(0.06, Math.min(1, this.smoothAvg / this.smoothMax));
      const avgY = Math.round(h - avgNorm * (h - 3)) + 0.5;
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = "rgba(235, 235, 235, 0.42)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, avgY);
      ctx.lineTo(w, avgY);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  resize() {
    if (!this.rafId) this.draw();
  }

  destroy() {
    this._stopLoop();
    this.canvas.removeEventListener("mousemove", this._onMouseMove);
    this.canvas.removeEventListener("mouseleave", this._onMouseLeave);
  }
}