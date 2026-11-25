let activeFftTabId = null;

function formatBadge(kbps) {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)}M`;
  return `${kbps}k`;
}

function getBadgeColor(codec, avgKbps) {
  if (codec === "FLAC" || avgKbps >= 500) return "#16a34a";
  if ((codec === "Opus" && avgKbps >= 115) || avgKbps >= 220) return "#2563eb";
  return "#d97706";
}

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

    // Include every audible tab OR tab with captured MSE audio telemetry
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

  // Sort audible tabs first, then by latest telemetry update
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
      // Ignore if offscreen document is already closed
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
    const data = message.payload;
    const key = `tab_${tabId}`;

    chrome.storage.session.set({ [key]: data });
    chrome.action.setBadgeText({ tabId, text: formatBadge(data.avgKbps) });
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: getBadgeColor(data.codec, data.avgKbps),
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
  if (activeFftTabId === tabId) {
    stopOffscreenCapture();
  }
  notifyDashboard();
});
