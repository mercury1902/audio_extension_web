let activeFftTabId = null;

// Cache HTTP headers & HLS manifest metadata per tab for Non-MSE audio streams
// tabId -> Map<urlKey, { contentType, totalBytes, icyBr, codecOverride, firstSeenAt }>
const tabDirectMediaMeta = new Map();
const fetchedHlsUrls = new Set();

// Cache exact byte size for local file:// URLs resolved via Service Worker fetch()
const localFileByteCache = new Map(); // url -> number | "pending"

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

// Resolve exact file size in bytes for local file:// audio files (requires "Allow access to file URLs")
function resolveLocalFileSize(url) {
  if (!url || !url.startsWith("file://")) return 0;
  const cached = localFileByteCache.get(url);
  if (typeof cached === "number") return cached;
  if (cached === "pending") return 0;

  localFileByteCache.set(url, "pending");
  fetch(url)
    .then((resp) => resp.blob())
    .then((blob) => {
      localFileByteCache.set(url, blob && blob.size > 0 ? blob.size : 0);
    })
    .catch(() => {
      localFileByteCache.set(url, 0);
    });
  return 0;
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

// Capture HTTP headers for Direct Audio & HLS streams (include extraHeaders for cross-origin Content-Length)
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
    justification: "Real-time FFT spectral analysis for the active tab audio stream.",
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
      const bgLocalBytes = isLocalFile ? resolveLocalFileSize(p.src) : 0;
      const totalBytes =
        bgLocalBytes || p.exactBytes || meta?.totalBytes || p.transferSize || 0;

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
    return;
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