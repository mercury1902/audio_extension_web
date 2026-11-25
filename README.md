# Audio Bitrate Probe

A lightweight Manifest V3 Chrome extension for real-time **source bitrate inspection** and **spectral authenticity verification** (FFT + Spek-style Waterfall), styled after native Win32 / foobar2000 dark UI.

## Features

- **Layer 1 — MSE Stream Telemetry (Zero-Overhead):**
  - Hooks `MediaSource.prototype.addSourceBuffer` and `appendBuffer` in the `MAIN` world to measure actual compressed chunk bitrate before browser decoding.
  - Displays codec (`AAC-LC`, `Opus`, `FLAC`, `Vorbis`, etc.), Rolling Average, Instant chunk bitrate, Peak bitrate, MIME type, and toolbar badge.
  - Smooth Full-FPS 12-segment Canvas chart with hover inspection and automatic track-change resets via `navigator.mediaSession`.
- **Layer 2 — Real-Time Spectral Verification:**
  - **8192-point FFT Spectrum** with Max-Hold envelope, ballistic smoothing, falling peak caps, and right-aligned dB scale (`-20 dB` to `-100 dB`).
  - **Spek-style Waterfall Spectrogram** (Inferno thermal LUT) with frequency guide lines (`4k`–`22k`) and live cutoff tracking.
  - Automatic high-frequency cutoff detection to cross-check Layer 1 bitrate and flag suspected lossy-to-high-bitrate upscales/re-encodes.
- **Popup & Multi-Tab Dashboard:**
  - **Popup:** Monitors the active tab via `chrome.tabCapture` + Offscreen Document, keeping a ~10-second waterfall ring buffer so reopening the popup restores recent history immediately.
  - **Dashboard (`dashboard.html`):** Lists all audible and MSE-tracked tabs in real time and lets you run **multiple side-by-side FFT + Waterfall probes** concurrently.

## Installation (Load Unpacked)

1. Clone this repository:
   ```bash
   git clone [https://github.com/mercury1902/audio_extension_web.git](https://github.com/mercury1902/audio_extension_web.git)

Open Chrome and navigate to chrome://extensions.

Enable Developer mode (top-right).

Click Load unpacked and select the cloned folder (containing manifest.json).

Reload any already-open media tabs (F5) so the MSE probe attaches before the player initializes.
