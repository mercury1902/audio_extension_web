let activeFftTabId = null;

// Cache HTTP headers & HLS manifest metadata per tab for Non-MSE audio streams
// tabId -> Map<urlKey, { contentType, totalBytes, icyBr, codecOverride, firstSeenAt }>
const tabDirectMediaMeta = new Map();
const fetchedHlsUrls = new Set();

// Cache exact byte size + parsed native header metadata for local file:// URLs
// url -> { size, sampleRate, bitDepth, channels, md5 } | "pending"
const localFileMetaCache = new Map();

function formatBadge(kbps) {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)}M`;
  return `${kbps}k`;
}

function getBadgeColor(codec, avgKbps) {
  const c = (codec || "").toUpperCase();
  if (c === "FLAC" || c === "WAV" || avgKbps >= 500) return "#16a34a";
  if ((c === "OPUS" && avgKbps >= 115) || avgKbps >= 220) return "#2563eb";
  return "#d97706";
}

function normalizeUrlKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl || "";
  }
}

function inferCodecFromMimeOrUrl(contentType, url) {
  const raw = `${contentType || ""} ${url || ""}`.toLowerCase();
  if (raw.includes("flac")) return "FLAC";
  if (raw.includes("opus")) return "Opus";
  if (raw.includes("vorbis") || raw.includes(".ogg") || raw.includes(".oga")) return "Vorbis";
  if (raw.includes("mp4a.40.5")) return "HE-AAC";
  if (raw.includes("mp4a") || raw.includes("aac") || raw.includes(".m4a")) return "AAC";
  if (raw.includes("mpeg") || raw.includes("mp3")) return "MP3";
  if (raw.includes("wav") || raw.includes("pcm")) return "WAV";
  if (raw.includes("mpegurl") || raw.includes(".m3u8")) return "HLS";
  return "Audio";
}

function getTabMetaMap(tabId) {
  let map = tabDirectMediaMeta.get(tabId);
  if (!map) {
    map = new Map();
    tabDirectMediaMeta.set(tabId, map);
  }
  return map;
}

function readAscii(view, offset, len) {
  let out = "";
  for (let i = 0; i < len && offset + i < view.byteLength; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

// Pure JS Byte Parser for native FLAC STREAMINFO and WAV fmt headers
function parseAudioHeader(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 36) return null;
  const view = new DataView(arrayBuffer);

  // FLAC: starts with "fLaC"
  if (readAscii(view, 0, 4) === "fLaC") {
    let offset = 4;
    while (offset + 4 <= view.byteLength) {
      const headerByte = view.getUint8(offset);
      const isLast = (headerByte & 0x80) !== 0;
      const blockType = headerByte & 0x7f;
      const blockLen =
        (view.getUint8(offset + 1) << 16) |
        (view.getUint8(offset + 2) << 8) |
        view.getUint8(offset + 3);
      offset += 4;

      if (blockType === 0 && offset + 34 <= view.byteLength) {
        const b10 = view.getUint8(offset + 10);
        const b11 = view.getUint8(offset + 11);
        const b12 = view.getUint8(offset + 12);
        const b13 = view.getUint8(offset + 13);

        const sampleRate = (b10 << 12) | (b11 << 4) | (b12 >> 4);
        const channels = ((b12 >> 1) & 0x07) + 1;
        const bitDepth = (((b12 & 0x01) << 4) | (b13 >> 4)) + 1;

        let md5 = "";
        let nonZero = false;
        for (let i = 0; i < 16; i++) {
          const b = view.getUint8(offset + 18 + i);
          if (b !== 0) nonZero = true;
          md5 += b.toString(16).padStart(2, "0");
        }

        return {
          sampleRate: sampleRate > 0 ? sampleRate : 0,
          bitDepth: bitDepth > 0 ? bitDepth : 0,
          channels: channels > 0 ? channels : 0,
          md5: nonZero ? md5 : "",
        };
      }

      offset += blockLen;
      if (isLast || blockLen <= 0) break;
    }
    return null;
  }

  // WAV: RIFF .... WAVE
  if (readAscii(view, 0, 4) === "RIFF" && readAscii(view, 8, 4) === "WAVE") {
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const chunkId = readAscii(view, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      offset += 8;

      if (chunkId === "fmt " && offset + 16 <= view.byteLength) {
        const channels = view.getUint16(offset + 2, true);
        const sampleRate = view.getUint32(offset + 4, true);
        const bitDepth = view.getUint16(offset + 14, true);
        return {
          sampleRate: sampleRate > 0 ? sampleRate : 0,
          bitDepth: bitDepth > 0 ? bitDepth : 0,
          channels: channels > 0 ? channels : 0,
          md5: "",
        };
      }

      offset += chunkSize + (chunkSize % 2);
      if (chunkSize === 0) break;
    }
    return null;
  }

  return null;
}

// Resolve exact file size + native FLAC/WAV header metadata for local file:// URLs
function resolveLocalFileMeta(url, tabId) {
  if (!url || !url.startsWith("file://")) return null;
  const cached = localFileMetaCache.get(url);
  if (cached && cached !== "pending") return cached;
  if (cached === "pending") return null;

  localFileMetaCache.set(url, "pending");
  fetch(url)
    .then(async (resp) => {
      const blob = await resp.blob();
      const size = blob && blob.size > 0 ? blob.size : 0;
      let header = null;
      try {
        const headBuf = await blob.slice(0, 65536).arrayBuffer();
        header = parseAudioHeader(headBuf);
      } catch {
        // Ignore header parse errors
      }

      const meta = {
        size,
        sampleRate: header?.sampleRate || 0,
        bitDepth: header?.bitDepth || 0,
        channels: header?.channels || 0,
        md5: header?.md5 || "",
      };
      localFileMetaCache.set(url, meta);

      // Immediately patch stored telemetry for this tab if present
      if (tabId != null) {
        const key = `tab_${tabId}`;
        chrome.storage.session.get(key, (res) => {
          const existing = res[key];
          if (!existing || existing.srcUrl !== url) return;
          const dur = existing.lastDeltaSec || 0;
          const kbps =
            size > 0 && dur > 0.5 ? Math.round((size * 8) / dur / 1000) : existing.avgKbps;
          const updated = {
            ...existing,
            lastChunkBytes: size || existing.lastChunkBytes,
            avgKbps: kbps,
            instantKbps: kbps,
            peakKbps: Math.max(existing.peakKbps || 0, kbps),
            nativeSampleRate: meta.sampleRate,
            nativeBitDepth: meta.bitDepth,
            nativeChannels: meta.channels,
            nativeMd5: meta.md5,
            updatedAt: Date.now(),
          };
          chrome.storage.session.set({ [key]: updated });
          if (kbps >= 8) {
            chrome.action.setBadgeText({ tabId, text: formatBadge(kbps) });
            chrome.action.setBadgeBackgroundColor({
              tabId,
              color: getBadgeColor(updated.codec, kbps),
            });
          }
        });
      }
    })
    .catch(() => {
      localFileMetaCache.set(url, {
        size: 0,
        sampleRate: 0,
        bitDepth: 0,
        channels: 0,
        md5: "",
      });
    });

  return null;
}

// Parse HLS .m3u8 playlist to extract highest variant BANDWIDTH & CODECS
async function inspectHlsPlaylist(tabId, url) {
  if (fetchedHlsUrls.has(url)) return;
  fetchedHlsUrls.add(url);
  if (fetchedHlsUrls.size > 200) fetchedHlsUrls.clear();

  try {
    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) return;
    const text = await resp.text();
    const lines = text.split(/\r?\n/);

    let bestBandwidth = 0;
    let bestCodecs = "";
    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        const codecMatch = line.match(/CODECS="([^"]+)"/i);
        const bw = bwMatch ? Number(bwMatch[1]) : 0;
        if (bw > bestBandwidth) {
          bestBandwidth = bw;
          bestCodecs = codecMatch ? codecMatch[1] : "";
        }
      }
    }

    if (bestBandwidth > 0) {
      const kbps = Math.round(bestBandwidth / 1000);
      const codec = bestCodecs ? inferCodecFromMimeOrUrl(bestCodecs, "") : "HLS";
      const map = getTabMetaMap(tabId);
      map.set("__HLS_LATEST__", {
        contentType: bestCodecs
          ? `application/vnd.apple.mpegurl; codecs="${bestCodecs}"`
          : "application/vnd.apple.mpegurl",
        totalBytes: 0,
        icyBr: kbps,
        codecOverride: codec,
        firstSeenAt: Date.now(),
      });
    }
  } catch {
    // Ignore CORS or network failures on restricted playlists
  }
}

// Capture HTTP headers for Direct Audio & HLS streams
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || !details.responseHeaders) return;

    let contentType = "";
    let contentLength = 0;
    let contentRangeTotal = 0;
    let icyBr = 0;

    for (const h of details.responseHeaders) {
      const name = (h.name || "").toLowerCase();
      const val = h.value || "";
      if (name === "content-type") contentType = val;
      else if (name === "content-length") contentLength = Number(val) || 0;
      else if (name === "content-range") {
        const slashIdx = val.lastIndexOf("/");
        if (slashIdx !== -1) {
          const total = Number(val.slice(slashIdx + 1));
          if (Number.isFinite(total) && total > 0) contentRangeTotal = total;
        }
      } else if (name === "icy-br") {
        icyBr = Number(val) || 0;
      }
    }

    const lowerType = contentType.toLowerCase();
    const lowerUrl = details.url.toLowerCase();
    const isHls = lowerType.includes("mpegurl") || lowerUrl.includes(".m3u8");
    const isAudio =
      lowerType.startsWith("audio/") ||
      lowerType.includes("ogg") ||
      /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav)(\?|#|$)/i.test(lowerUrl);

    if (!isAudio && !isHls) return;

    if (isHls) {
      inspectHlsPlaylist(details.tabId, details.url);
      return;
    }

    const totalBytes = contentRangeTotal || contentLength;
    const map = getTabMetaMap(details.tabId);
    const key = normalizeUrlKey(details.url);
    const prev = map.get(key);

    map.set(key, {
      contentType: contentType || prev?.contentType || "audio/unknown",
      totalBytes: Math.max(totalBytes, prev?.totalBytes || 0),
      icyBr: icyBr || prev?.icyBr || 0,
      firstSeenAt: prev?.firstSeenAt || Date.now(),
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders", "extraHeaders"]
);

function notifyDashboard() {
  chrome.runtime
    .sendMessage({ target: "dashboard", type: "TABS_UPDATED" })
    .catch(() => {});
}

async function openOrFocusDashboard() {
  const dashUrl = chrome.runtime.getURL("dashboard.html");
  const existing = await chrome.tabs.query({ url: dashUrl });
  if (existing.length > 0 && existing[0].id != null) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: dashUrl });
}

async function getAllAudioTabs() {
  const [tabs, sessionData] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.session.get(null),
  ]);

  const results = [];
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const telemetry = sessionData[`tab_${tab.id}`] || null;

    if (tab.audible || telemetry) {
      results.push({
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title || "Untitled Tab",
        url: tab.url || "",
        favIconUrl: tab.favIconUrl || "",
        audible: Boolean(tab.audible),
        muted: Boolean(tab.mutedInfo?.muted),
        telemetry,
      });
    }
  }

  results.sort((a, b) => {
    if (a.audible !== b.audible) return a.audible ? -1 : 1;
    const ta = a.telemetry?.updatedAt || 0;
    const tb = b.telemetry?.updatedAt || 0;
    return tb - ta;
  });

  return results;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Real-time FFT, LUFS, stereo phase, and offline full-track spectral analysis.",
  });
}

async function stopOffscreenCapture() {
  activeFftTabId = null;
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "OFFSCREEN_STOP",
      });
    } catch {
      // Ignore if already closed
    }
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // Ignore if already closed
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "background") return;

  if (message.type === "AUDIO_TELEMETRY" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    const data = { streamMode: "MSE", ...message.payload };
    const key = `tab_${tabId}`;

    chrome.storage.session.set({ [key]: data });
    chrome.action.setBadgeText({ tabId, text: formatBadge(data.avgKbps) });
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: getBadgeColor(data.codec, data.avgKbps),
    });
    return;
  }

  if (message.type === "AUDIO_DIRECT_MEDIA" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    const p = message.payload;
    const key = `tab_${tabId}`;

    chrome.storage.session.get(key, (res) => {
      const existing = res[key];
      if (existing && existing.streamMode === "MSE") return;

      const metaMap = tabDirectMediaMeta.get(tabId);
      const urlKey = normalizeUrlKey(p.src);
      const meta = metaMap?.get(urlKey) || metaMap?.get("__HLS_LATEST__") || null;

      const isLocalFile = p.src.startsWith("file://");
      const bgMeta = isLocalFile ? resolveLocalFileMeta(p.src, tabId) : null;
      const totalBytes =
        bgMeta?.size || p.exactBytes || meta?.totalBytes || p.transferSize || 0;

      const codec =
        meta?.codecOverride || inferCodecFromMimeOrUrl(meta?.contentType || "", p.src);
      const mimeType =
        meta?.contentType ||
        (isLocalFile ? `local/${codec.toLowerCase()}` : `direct/${codec.toLowerCase()}`);

      let kbps = 0;
      if (meta?.icyBr > 0) {
        kbps = Math.round(meta.icyBr);
      } else if (totalBytes > 0 && p.duration > 0.5) {
        kbps = Math.round((totalBytes * 8) / p.duration / 1000);
      } else if (p.transferSize > 0 && p.currentTime > 1.5) {
        kbps = Math.round((p.transferSize * 8) / p.currentTime / 1000);
      }

      if (kbps > 20000) kbps = 0;

      // Still show known codecs / local files even before byte size resolves
      if (kbps < 8 && codec === "Audio" && !isLocalFile) return;

      const isSameSrc = existing?.streamId === urlKey;
      const prevHist = isSameSrc && Array.isArray(existing.history) ? existing.history : [];
      const nextHist = kbps >= 8 ? [...prevHist.slice(-11), kbps] : prevHist;
      const peakKbps = isSameSrc ? Math.max(existing.peakKbps || 0, kbps) : kbps;
      const chunkCount = isSameSrc ? (existing.chunkCount || 0) + 1 : 1;

      const streamMode =
        meta?.codecOverride === "HLS" ? "HLS" : isLocalFile ? "LOCAL" : "DIRECT";

      const telemetry = {
        streamMode,
        streamId: urlKey,
        srcUrl: p.src,
        codec,
        mimeType,
        instantKbps: kbps,
        avgKbps: kbps,
        peakKbps,
        chunkCount,
        lastChunkBytes: totalBytes,
        lastDeltaSec: Number((p.duration || p.currentTime || 0).toFixed(2)),
        history: nextHist,
        trackTitle: p.trackTitle || existing?.trackTitle || "",
        trackArtist: p.trackArtist || existing?.trackArtist || "",
        host: p.host || "",
        nativeSampleRate: bgMeta?.sampleRate || existing?.nativeSampleRate || 0,
        nativeBitDepth: bgMeta?.bitDepth || existing?.nativeBitDepth || 0,
        nativeChannels: bgMeta?.channels || existing?.nativeChannels || 0,
        nativeMd5: bgMeta?.md5 || existing?.nativeMd5 || "",
        updatedAt: Date.now(),
      };

      chrome.storage.session.set({ [key]: telemetry });
      chrome.action.setBadgeText({
        tabId,
        text: kbps >= 8 ? formatBadge(kbps) : codec.slice(0, 4).toUpperCase(),
      });
      chrome.action.setBadgeBackgroundColor({
        tabId,
        color: getBadgeColor(codec, kbps),
      });
    });
    return;
  }

  if (message.type === "TRACK_CHANGED" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    const key = `tab_${tabId}`;

    chrome.storage.session.get(key, (res) => {
      const existing = res[key];
      if (existing) {
        chrome.storage.session.set({
          [key]: {
            ...existing,
            trackTitle: message.payload.title,
            trackArtist: message.payload.artist,
          },
        });
      }
    });

    if (!message.payload.isInitial && activeFftTabId === tabId) {
      chrome.runtime
        .sendMessage({ target: "offscreen", type: "OFFSCREEN_RESET" })
        .catch(() => {});
    }
    return;
  }

  if (message.type === "OPEN_DASHBOARD") {
    openOrFocusDashboard().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "GET_ALL_AUDIO_TABS") {
    getAllAudioTabs().then((list) => sendResponse(list));
    return true;
  }

  if (message.type === "FOCUS_TAB") {
    (async () => {
      try {
        const tab = await chrome.tabs.update(message.tabId, { active: true });
        if (tab?.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message.type === "TOGGLE_MUTE_TAB") {
    (async () => {
      try {
        const tab = await chrome.tabs.get(message.tabId);
        await chrome.tabs.update(message.tabId, { muted: !tab.mutedInfo?.muted });
        notifyDashboard();
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message.type === "GET_TAB_STATE") {
    const key = `tab_${message.tabId}`;
    chrome.storage.session.get(key, (result) => {
      sendResponse(result[key] || null);
    });
    return true;
  }

  if (message.type === "START_FFT") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        activeFftTabId = message.tabId;
        const resp = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OFFSCREEN_START",
          tabId: message.tabId,
          streamId: message.streamId,
          fftSize: message.fftSize || 4096,
        });
        sendResponse(resp || { ok: true });
      } catch (err) {
        activeFftTabId = null;
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "STOP_FFT") {
    (async () => {
      await stopOffscreenCapture();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "RESET_FFT") {
    chrome.runtime
      .sendMessage({ target: "offscreen", type: "OFFSCREEN_RESET" })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "SET_FFT_SIZE") {
    (async () => {
      if (!(await hasOffscreenDocument())) {
        sendResponse({ ok: true, fftSize: message.fftSize || 4096 });
        return;
      }
      try {
        const resp = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OFFSCREEN_SET_FFT_SIZE",
          fftSize: message.fftSize || 4096,
        });
        sendResponse(resp || { ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message.type === "GET_FFT_STATE") {
    (async () => {
      if (!(await hasOffscreenDocument())) {
        sendResponse({ capturing: false, tabId: null });
        return;
      }
      try {
        const state = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OFFSCREEN_GET_STATE",
        });
        sendResponse(state || { capturing: false, tabId: null });
      } catch {
        sendResponse({ capturing: false, tabId: null });
      }
    })();
    return true;
  }

  if (message.type === "SCAN_FULL_TRACK") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const resp = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OFFSCREEN_SCAN_FULL",
          tabId: message.tabId,
          url: message.url,
          nativeSampleRate: message.nativeSampleRate || 0,
          fftSize: message.fftSize || 4096,
        });
        sendResponse(resp || { ok: false, error: "Empty response from scanner" });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.storage.session.remove(`tab_${tabId}`);
    tabDirectMediaMeta.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
    if (activeFftTabId === tabId) {
      stopOffscreenCapture();
    }
    notifyDashboard();
    return;
  }

  if (
    changeInfo.audible !== undefined ||
    changeInfo.mutedInfo !== undefined ||
    changeInfo.title !== undefined
  ) {
    notifyDashboard();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab_${tabId}`);
  tabDirectMediaMeta.delete(tabId);
  if (activeFftTabId === tabId) {
    stopOffscreenCapture();
  }
  notifyDashboard();
});
