(() => {
  if (window.__AUDIO_BITRATE_PROBE_INSTALLED__) return;
  window.__AUDIO_BITRATE_PROBE_INSTALLED__ = true;

  const resetCallbacks = new Set();
  const mseBlobUrls = new Set();
  const trackedMediaElements = new Set();
  const localFileSizeCache = new Map(); // src -> number (bytes) | "pending"

  let currentTrack = { title: "", artist: "" };
  let lastTrackKey = "";

  // Track changes on SPA media players (YouTube Music, YouTube, SoundCloud, Spotify, etc.)
  function checkMediaSession() {
    const meta = navigator.mediaSession?.metadata;
    if (!meta || !meta.title) return;

    const title = (meta.title || "").trim();
    const artist = (meta.artist || "").trim();
    const key = `${title}::${artist}`;

    if (key !== lastTrackKey) {
      const isInitial = lastTrackKey === "";
      lastTrackKey = key;
      currentTrack = { title, artist };

      if (!isInitial) {
        resetCallbacks.forEach((fn) => fn());
      }

      window.postMessage(
        {
          source: "AUDIO_PROBE_TRACK_CHANGE",
          payload: { title, artist, isInitial, changedAt: Date.now() },
        },
        "*"
      );
    }
  }

  setInterval(checkMediaSession, 700);

  function parseCodec(mimeType) {
    const raw = (mimeType || "").toLowerCase();
    if (raw.includes("opus")) return "Opus";
    if (raw.includes("flac")) return "FLAC";
    if (raw.includes("mp4a.40.2")) return "AAC-LC";
    if (raw.includes("mp4a.40.5")) return "HE-AAC";
    if (raw.includes("mp4a.40.29")) return "HE-AAC v2";
    if (raw.includes("mp4a")) return "AAC";
    if (raw.includes("vorbis")) return "Vorbis";
    if (raw.includes("ec-3")) return "Dolby Digital+";
    if (raw.includes("ac-3")) return "Dolby Digital";
    if (raw.includes("mpeg") || raw.includes("mp3")) return "MP3";
    if (raw.includes("wav") || raw.includes("pcm")) return "WAV";
    return "Audio";
  }

  function extractTitleFromSrc(src) {
    try {
      const clean = src.split("?")[0].split("#")[0];
      const fileName = decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1));
      return fileName.replace(/\.(flac|mp3|wav|ogg|oga|opus|m4a|aac|webm|mp4)$/i, "");
    } catch {
      return "";
    }
  }

  function getTotalBuffered(ranges) {
    let total = 0;
    for (let i = 0; i < ranges.length; i++) {
      total += ranges.end(i) - ranges.start(i);
    }
    return total;
  }

  // Track MediaSource blob URLs so Non-MSE scanner ignores MSE elements
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = origCreateObjectURL.call(this, obj);
      if (typeof MediaSource !== "undefined" && obj instanceof MediaSource) {
        mseBlobUrls.add(url);
      }
      return url;
    };
  }

  // Hook HTMLMediaElement.prototype.play to catch detached `new Audio(url)` elements as well
  if (typeof HTMLMediaElement !== "undefined" && HTMLMediaElement.prototype.play) {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      trackedMediaElements.add(this);
      return origPlay.apply(this, args);
    };
  }

  // Measure exact byte size of local file:// audio files via XHR blob
  function resolveLocalFileBytes(src) {
    if (!src.startsWith("file://")) return 0;
    const cached = localFileSizeCache.get(src);
    if (typeof cached === "number") return cached;
    if (cached === "pending") return 0;

    localFileSizeCache.set(src, "pending");
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", src, true);
      xhr.responseType = "blob";
      xhr.onload = () => {
        if (xhr.response && typeof xhr.response.size === "number" && xhr.response.size > 0) {
          localFileSizeCache.set(src, xhr.response.size);
        } else {
          localFileSizeCache.set(src, 0);
        }
      };
      xhr.onerror = () => localFileSizeCache.set(src, 0);
      xhr.send();
    } catch {
      localFileSizeCache.set(src, 0);
    }
    return 0;
  }

  // Layer 1A: Media Source Extensions (MSE) Hook
  if (typeof window.MediaSource !== "undefined") {
    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;

    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      const sb = origAddSourceBuffer.call(this, mimeType);

      if (typeof mimeType === "string" && mimeType.toLowerCase().includes("audio")) {
        const origAppend = sb.appendBuffer;
        const streamId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const codec = parseCodec(mimeType);

        let pendingBytes = 0;
        let lastTotalDuration = 0;
        let chunkCount = 0;
        let peakKbps = 0;
        let skipFirstAfterSeek = false;
        let windowChunks = [];

        const onTrackReset = () => {
          windowChunks = [];
          chunkCount = 0;
          peakKbps = 0;
        };
        resetCallbacks.add(onTrackReset);

        sb.appendBuffer = function (data) {
          if (data && typeof data.byteLength === "number") {
            pendingBytes += data.byteLength;
          }
          return origAppend.call(this, data);
        };

        sb.addEventListener("updateend", () => {
          let currentTotal = 0;
          try {
            currentTotal = getTotalBuffered(sb.buffered);
          } catch {
            pendingBytes = 0;
            return;
          }

          if (currentTotal < lastTotalDuration - 0.25) {
            lastTotalDuration = currentTotal;
            pendingBytes = 0;
            skipFirstAfterSeek = true;
            return;
          }

          const deltaSec = currentTotal - lastTotalDuration;

          if (deltaSec >= 0.35 && pendingBytes > 0) {
            if (skipFirstAfterSeek) {
              skipFirstAfterSeek = false;
              lastTotalDuration = currentTotal;
              pendingBytes = 0;
              return;
            }

            const instantKbps = Math.round((pendingBytes * 8) / deltaSec / 1000);

            if (instantKbps >= 8 && instantKbps <= 15000) {
              chunkCount += 1;
              if (instantKbps > peakKbps) peakKbps = instantKbps;

              windowChunks.push({ bytes: pendingBytes, sec: deltaSec, kbps: instantKbps });
              if (windowChunks.length > 12) windowChunks.shift();

              const sumBytes = windowChunks.reduce((acc, c) => acc + c.bytes, 0);
              const sumSec = windowChunks.reduce((acc, c) => acc + c.sec, 0);
              const avgKbps = Math.round((sumBytes * 8) / sumSec / 1000);

              window.postMessage(
                {
                  source: "AUDIO_PROBE_MAIN",
                  payload: {
                    streamMode: "MSE",
                    streamId,
                    codec,
                    mimeType,
                    instantKbps,
                    avgKbps,
                    peakKbps,
                    chunkCount,
                    lastChunkBytes: pendingBytes,
                    lastDeltaSec: Number(deltaSec.toFixed(2)),
                    history: windowChunks.map((c) => c.kbps),
                    trackTitle: currentTrack.title,
                    trackArtist: currentTrack.artist,
                    host: window.location.hostname,
                    updatedAt: Date.now(),
                  },
                },
                "*"
              );
            }

            lastTotalDuration = currentTotal;
            pendingBytes = 0;
          } else if (deltaSec <= 0.02 && pendingBytes > 0) {
            lastTotalDuration = currentTotal;
            pendingBytes = 0;
          }
        });
      }

      return sb;
    };
  }

  // Layer 1B: Non-MSE HTML5 <audio> / <video> & detached Audio() Direct Stream Scanner
  function scanDirectMediaElements() {
    const candidates = new Set(trackedMediaElements);
    document.querySelectorAll("audio, video").forEach((el) => candidates.add(el));

    for (const el of candidates) {
      if (el.paused || el.ended || el.readyState < 2) continue;
      if (el.srcObject) continue;

      const src = el.currentSrc || el.src || "";
      if (!src || mseBlobUrls.has(src)) continue;

      let transferSize = 0;
      try {
        const entries = performance.getEntriesByName(src);
        if (entries && entries.length > 0) {
          const lastEntry = entries[entries.length - 1];
          transferSize = lastEntry.encodedBodySize || lastEntry.transferSize || 0;
        }
      } catch {
        // Ignore Performance API restrictions
      }

      const exactBytes = src.startsWith("file://") ? resolveLocalFileBytes(src) : 0;
      const fallbackTitle = currentTrack.title || extractTitleFromSrc(src);

      window.postMessage(
        {
          source: "AUDIO_PROBE_DIRECT_MEDIA",
          payload: {
            src,
            duration: Number.isFinite(el.duration) ? el.duration : 0,
            currentTime: el.currentTime || 0,
            transferSize,
            exactBytes,
            trackTitle: fallbackTitle,
            trackArtist: currentTrack.artist,
            host: window.location.hostname || (src.startsWith("file://") ? "Local File" : ""),
            updatedAt: Date.now(),
          },
        },
        "*"
      );
      break;
    }
  }

  setInterval(scanDirectMediaElements, 1000);
})();