# Audio Bitrate Probe

A Manifest V3 Chrome extension for real-time audio bitrate telemetry, broadcast loudness metering (ITU-R BS.1770-4), stereo phase analysis, and high-resolution spectral verification (FFT + Waterfall), styled after native Win32 / foobar2000 dark interfaces.

## Features

### Layer 1: Stream & Native File Telemetry
- **Media Source Extensions (MSE) Hook:** Intercepts `MediaSource.prototype.addSourceBuffer` and `appendBuffer` in the `MAIN` world to measure compressed audio chunk sizes and durations prior to browser decoding, filtering out seek and micro-buffer spikes.
- **Direct, HLS & Local File Support:** Detects non-MSE `<audio>` / `<video>` elements, detached `new Audio()` instances, HTTP headers (`Content-Length`, `Content-Range`, `icy-br`), HLS (`.m3u8`) stream manifests, and local `file://` audio files.
- **Native FLAC & WAV Header Byte Parser:** Pure JavaScript `DataView` parser that reads `FLAC STREAMINFO` and `WAV fmt ` headers directly from local `file://` files to extract native bit depth (`16-bit` / `24-bit`), native sample rate (`44.1` / `48` / `96` / `192 kHz`), channel count, and MD5 checksum.
- **Live Bitrate Metrics:** Displays codec (`FLAC`, `WAV`, `AAC-LC`, `HE-AAC`, `Opus`, `Vorbis`, `MP3`, `HLS`), Rolling Average, Instant chunk bitrate, Peak bitrate, MIME type, and dynamic toolbar badge indicators.
- **12-Segment History Chart:** Smooth Canvas bar chart with hover inspection and automatic track-change resets via `navigator.mediaSession`.

### Layer 2: Spectral, Loudness & Stereo Analysis
- **Selectable FFT Resolution (`512` – `16384`):** Switch seamlessly between `512`, `1024`, `2048`, `4096` (default), `8192`, and `16384` FFT points during live playback without clearing the waterfall history or resetting sample timers, with automatic Max-Hold bin resampling.
- **Spectrum Analyzer (`LIN` / `LOG`):** Features ballistic attack/decay smoothing, a Max-Hold peak envelope, falling peak caps, and a right-aligned dB scale (`-20 dB` to `-100 dB`). Toggle between a linear frequency axis (`0 kHz` to Nyquist) and an ISO 31-band 1/3-octave RTA (`20 Hz` to `20 kHz`).
- **Stereo L/R & Phase Correlation Meter:** Uses `ChannelSplitterNode(2)` to display independent Left/Right Peak & RMS bars alongside a real-time Stereo Phase Correlation indicator (`Φ` from `-1.0` to `+1.0`).
- **ITU-R BS.1770-4 Loudness & True Peak:** Built-in K-Weighting filter chain computing **Momentary (400 ms)** and **Gated Integrated Loudness (`LUFS`)**, 4x oversampled Catmull-Rom **True Peak (`dBTP`)** with clipping highlights, and Dynamic Range / Crest Factor (`DR` in `dB`).
- **Waterfall Spectrogram (Spek / foobar2000 Style):**
  - Perceptual contrast curve (`-24 dB` ceiling, `γ = 0.72`), inter-column peak accumulation, and subtle 1px vertical harmonic thickening for crisp, dense visualization.
  - 5 selectable color palettes (`Inferno`, `Foobar`, `Spek`, `Viridis`, `Mono`) and adjustable noise floors (`-90 dB`, `-105 dB`, `-120 dB`) with instant historical repainting.
  - Interactive crosshair HUD showing exact frequency (`Hz` / `kHz`), signal intensity (`dB`), and time offset (`-X.Xs` in live mode or `M:SS.s` in full-track scan mode).
- **Offline Full-Track Hi-Res Scanner (`Scan Full`):** Decodes local `file://` tracks via `OfflineAudioContext` at their native sample rate (including Hi-Res `96 kHz` / `192 kHz` masters beyond the browser's 48 kHz live playback limit), rendering a full-track 420-column Radix-2 FFT spectrogram (`0:00` → end), exact cutoff, and gated Integrated LUFS in ~0.3–2.0 seconds. Changing the FFT size in Full-Scan mode automatically rescans the track at the new resolution.
- **Cross-Layer Authenticity Verification:** Combines adaptive ultrasonic noise-floor cutoff detection (10th-percentile near-Nyquist floor capped at `-98 dB`) with Layer 1 codec/bitrate cross-checking to distinguish authentic Lossless & Hi-Res audio from lossy streams and suspected upscales.

### Popup & Multi-Tab Dashboard
- **Popup (`popup.html`):** Monitors the active tab via `chrome.tabCapture` and an Offscreen Document, preserving an in-memory waterfall ring buffer so reopening the popup restores recent spectral history immediately, plus one-click `Scan Full` for local files.
- **Multi-Tab Dashboard (`dashboard.html`):** Displays all audible and tracked tabs in real time with native bit-depth/sample-rate badges and supports running multiple concurrent side-by-side Live and Full-Scan `SpectralProbe` analyzers.

## Changelog

### v0.8.4
- **Seamless Live FFT Switching:** Decoupled explicit resets from FFT window changes via `resetSeq` tracking and added `resampleMaxHold()` with narrow-bin gain compensation so changing FFT size (`512`–`16384`) mid-playback preserves waterfall history, sample time, and loudness metrics.

### v0.8.3
- **Live Capture Stability Fix:** Fixed a render-loop freeze caused by null `smoothMax` buffers when switching FFT sizes during active playback, and cleared stale pending waterfall bins on local Dashboard probes.

### v0.8.2
- **Selectable FFT Window Sizes:** Added a `512` / `1024` / `2048` / `4096` (default) / `8192` / `16384` FFT selector to both Popup and Dashboard spectrograms, backed by dynamic cached Radix-2 FFT tables for offline full-track scans.

### v0.8.1
- **Full-Bandwidth Cutoff Precision:** Refined ultrasonic noise-floor estimation to use the 10th percentile near Nyquist (capped at `-98 dB`) with a finer `150 Hz` scan step at 48 kHz, preventing high-energy lossless tracks from clamping early around `23.0 kHz`.

### v0.8.0
- **Forensic & Mastering Upgrade:**
  - Added Pure JS byte parser for native `FLAC` (`STREAMINFO`) and `WAV` (`fmt `) headers (bit depth, sample rate, channels, MD5).
  - Added Offline Full-Track Scanner (`Scan Full`) supporting native Hi-Res decoding (`96 kHz` / `192 kHz`) and absolute `0:00 → end` spectrogram timelines.
  - Added Stereo `L / R` Peak/RMS metering and Stereo Phase Correlation (`Φ`).
  - Added ITU-R BS.1770-4 K-weighted Loudness (`Momentary` & `Integrated LUFS`) and 4x oversampled True Peak (`dBTP`).
  - Added the `Foobar` color palette and perceptual spectrogram density tuning (`-24 dB` ceiling, `γ = 0.72`).

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
5. **Enable Local File Access (Required for `file://` audio, Header Parsing & `Scan Full`):**
   - On the **Audio Bitrate Probe** card in `chrome://extensions`, click **Details**.
   - Scroll down and enable **Allow access to file URLs**.
6. **Reload Media Tabs:**
   Press `F5` on any already-open audio or video tabs so the telemetry hooks attach before playback initializes.

## Usage

- **Streaming Web Audio (YouTube Music, YouTube, SoundCloud, etc.):** Open the tab, play audio, and click the extension icon to view Layer 1 bitrate metrics. Click **Start FFT** to inspect the live spectrum, LUFS, stereo phase, and waterfall spectrogram.
- **Local Audio Files (`FLAC`, `WAV`, `MP3`):** Drag and drop an audio file into a Chrome tab (with *Allow access to file URLs* enabled). Native bit depth and sample rate appear automatically; click **Scan Full** for an instant full-track Hi-Res spectrogram + Integrated LUFS report, or **Start FFT** for live monitoring.
- **Adjusting FFT Resolution:** Use the FFT dropdown (`512`–`16384`) on the Spectrogram toolbar to trade between sharp transient timing (`512`–`1024`) and ultra-fine frequency resolution (`8192`–`16384`).
- **Multi-Tab Monitoring:** Click **Dashboard ↗** in the popup toolbar to open the full-screen monitor. Click **+ Add FFT Probe**, **Probe FFT**, or **Scan Full** on any tab card.

## Project Structure

```text
audio_extension_web/
├── manifest.json         # Manifest V3 configuration and permissions
├── inject_main.js        # MAIN-world MSE hook and HTMLMediaElement scanner
├── content_bridge.js     # Isolated-world message relay to background worker
├── background.js         # Service worker: session state, HTTP/HLS headers, FLAC/WAV byte parser, offscreen lifecycle
├── offscreen.html        # Hidden document host for Web Audio DSP and offline scanning
├── offscreen.js          # Dynamic FFT, ISO 31-band RTA, BS.1770-4 LUFS, 4x True Peak, Stereo Phase & Offline Full-Track Scanner
├── bitrate_chart.js      # Smooth 12-segment bitrate Canvas renderer
├── popup.html            # Popup UI (Win32 / foobar2000 dark theme)
├── popup.js              # Popup controller and real-time / full-scan Canvas renderers
├── dashboard.html        # Multi-tab Dashboard UI
└── dashboard.js          # Multi-tab grid manager and concurrent SpectralProbe instances
```

## Known Browser Limitations

- **DRM-Protected Content:** Services using Encrypted Media Extensions / Widevine (e.g., Spotify Web, Netflix) output silence to browser audio capture APIs. Layer 1 MSE bitrate telemetry still functions normally on supported streams.
- **Live Capture Sample Rate Ceiling:** Real-time `tabCapture` / `AudioContext` monitoring operates at the OS Shared Mode sample rate (typically `48 kHz`, yielding a `24 kHz` Nyquist ceiling). For local Hi-Res files (`96 kHz` / `192 kHz`), use **Scan Full** to decode and analyze the track at its native sample rate.