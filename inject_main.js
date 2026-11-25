(() => {
  if (window.__AUDIO_BITRATE_PROBE_INSTALLED__) return;
  window.__AUDIO_BITRATE_PROBE_INSTALLED__ = true;

  if (typeof window.MediaSource === "undefined") return;

  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  const resetCallbacks = new Set();

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
    return "Audio";
  }

  function getTotalBuffered(ranges) {
    let total = 0;
    for (let i = 0; i < ranges.length; i++) {
      total += ranges.end(i) - ranges.start(i);
    }
    return total;
  }

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

        const deltaSec = currentTotal - lastTotalDuration;

        if (deltaSec > 0.1 && pendingBytes > 0) {
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
        }

        lastTotalDuration = currentTotal;
        pendingBytes = 0;
      });
    }

    return sb;
  };
})();
