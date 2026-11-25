window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;

  try {
    if (event.data.source === "AUDIO_PROBE_MAIN") {
      chrome.runtime.sendMessage({
        target: "background",
        type: "AUDIO_TELEMETRY",
        payload: event.data.payload,
      });
    } else if (event.data.source === "AUDIO_PROBE_TRACK_CHANGE") {
      chrome.runtime.sendMessage({
        target: "background",
        type: "TRACK_CHANGED",
        payload: event.data.payload,
      });
    }
  } catch {
    // Ignore errors when extension reloads while tab is open
  }
});
