# Audio Bitrate Probe

A Manifest V3 Chrome extension for real-time audio bitrate telemetry, dynamic range metering, and spectral authenticity verification (FFT + Waterfall), styled after native Win32 / foobar2000 dark interfaces.

## Features

### Layer 1: Stream & File Telemetry
- **Media Source Extensions (MSE) Hook:** Intercepts `MediaSource.prototype.addSourceBuffer` and `appendBuffer` in the `MAIN` world to measure compressed audio chunk sizes and durations prior to browser decoding, filtering out seek and micro-buffer spikes.
- **Direct, HLS & Local File Support:** Detects non-MSE `<audio>` / `<video>` elements, detached `new Audio()` instances, HTTP headers (`Content-Length`, `Content-Range`, `icy-br`), HLS (`.m3u8`) stream manifests, and local `file://` audio files.
- **Live Bitrate Metrics:** Displays codec (`FLAC`, `WAV`, `AAC-LC`, `HE-AAC`, `Opus`, `Vorbis`, `MP3`), Rolling Average, Instant chunk bitrate, Peak bitrate, MIME type, and dynamic toolbar badge indicators.
- **12-Segment History Chart:** Smooth Full-FPS Canvas bar chart with hover inspection and automatic track-change resets via `navigator.mediaSession`.

### Layer 2: Real-Time Spectral & Dynamics Analysis
- **8192-Point FFT Spectrum Analyzer:** Features ballistic attack/decay smoothing, a Max-Hold peak envelope, falling peak caps, and a right-aligned dB scale (`-20 dB` to `-100 dB`).
- **Linear & 31-Band Logarithmic Modes (`LIN` / `LOG`):** Switch between a linear frequency axis (`0 kHz` to Nyquist) for pinpointing high-frequency cutoffs and a standard ISO 31-band 1/3-octave RTA (`20 Hz` to `20 kHz`).
- **Level & Dynamic Range Meter:** Computes real-time time-domain Peak (`dBFS`), RMS (`dBFS`), held peak indicators, and Crest Factor (`DR` in `dB`).
- **Waterfall Spectrogram (Spek-Style):**
  - Scrolling time-frequency heatmap with a calibrated bottom time axis (`-12s` / `-18s` to `0s`) and frequency guide markers (`4k` to `22k`).
  - Interactive coordinate crosshair displaying exact frequency (`Hz` / `kHz`), signal intensity (`dB`), and time offset (`-X.Xs`) on hover.
  - Selectable color palettes (`Inferno`, `Spek`, `Viridis`, `Mono`) and adjustable noise floors (`-90 dB`, `-105 dB`, `-120 dB`) with instant historical repainting.
- **Cross-Layer Authenticity Verification:** Combines adaptive ultrasonic noise-floor cutoff detection with Layer 1 codec/bitrate cross-checking to distinguish authentic Lossless audio from high-quality lossy streams and flag suspected lossy-to-lossless upscales.

### Popup & Multi-Tab Dashboard
- **Popup (`popup.html`):** Monitors the active tab via `chrome.tabCapture` and an Offscreen Document, maintaining an in-memory waterfall ring buffer so reopening the popup restores recent spectral history immediately.
- **Multi-Tab Dashboard (`dashboard.html`):** Displays all audible and tracked tabs in real time and supports running multiple concurrent side-by-side FFT + Waterfall analyzers.

## Installation (Load Unpacked)

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/mercury1902/audio_extension_web.git](https://github.com/mercury1902/audio_extension_web.git)
   ```
2. **Open Chrome Extensions:**
   Navigate to `chrome://extensions` in Google Chrome (or any Chromium-based browser).
3. **Enable Developer Mode:**
   Toggle **Developer mode** ON in the top-right corner of the page.
4. **Load the Extension:**
   Click **Load unpacked** and select the cloned `audio_extension_web` directory (the folder containing `manifest.json`).
5. **Enable Local File Access (Required for `file://` audio):**
   - On the **Audio Bitrate Probe** card in `chrome://extensions`, click **Details**.
   - Scroll down and enable **Allow access to file URLs**.
6. **Reload Media Tabs:**
   Press `F5` on any already-open audio or video tabs so the telemetry hooks attach before playback initializes.

## Usage

- **Streaming Web Audio (YouTube Music, YouTube, SoundCloud, etc.):** Open the tab, play audio, and click the extension icon in the toolbar to view Layer 1 bitrate metrics. Click **Start FFT** to inspect the live spectrum, dynamic range, and waterfall spectrogram.
- **Local Audio Files (`FLAC`, `MP3`, `WAV`):** Drag and drop an audio file directly into a Chrome tab (after enabling *Allow access to file URLs*), open the extension popup, and click **Start FFT**.
- **Multi-Tab Monitoring:** Click **Dashboard** in the popup toolbar to open the full-screen monitor. Click **+ Add FFT Probe** (or **Probe FFT** on any tab card), select the target tab under **Chrome Tab**, and ensure **Share tab audio** is checked.

## Project Structure

```text
audio_extension_web/
├── manifest.json         # Manifest V3 configuration and permissions
├── inject_main.js        # MAIN-world MSE hook and HTMLMediaElement scanner
├── content_bridge.js     # Isolated-world message relay to background worker
├── background.js         # Service worker for session state, webRequest headers, and offscreen lifecycle
├── offscreen.html        # Hidden document host for tabCapture Web Audio processing
├── offscreen.js          # 8192-pt FFT, 31-band RTA, Crest Factor, and cutoff detection engine
├── bitrate_chart.js      # Smooth 12-segment bitrate Canvas renderer
├── popup.html            # Popup UI (win32 / foobar2000 dark theme)
├── popup.js              # Popup controller and real-time Canvas renderers
├── dashboard.html        # Multi-tab Dashboard UI
└── dashboard.js          # Multi-tab grid manager and concurrent SpectralProbe instances
```

## Known Browser Limitations

- **DRM-Protected Content:** Services using Encrypted Media Extensions / Widevine (e.g., Spotify Web, Netflix) output silence to browser audio capture APIs. Layer 1 MSE bitrate telemetry still functions normally on supported streams.
- **Sample Rate Ceiling:** Browser `AudioContext` instances operate at the operating system's Shared Mode sample rate (typically `48 kHz`, yielding a `24 kHz` Nyquist ceiling).