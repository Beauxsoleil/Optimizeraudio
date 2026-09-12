# Speech Optimizer

A single-page tool that converts an interview recording into a
transcription-ready MP3 (mono, 16 kHz, 64 kbps, metadata stripped) — the
browser equivalent of:

```
ffmpeg -i input -map 0:a:0 -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 64k -map_metadata -1 -id3v2_version 3 output.mp3
```

Everything runs in the visitor's browser; audio files never leave the device.

**Live site:** https://beauxsoleil.github.io/Optimizeraudio/

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The page (markup + styles). |
| `app.js` | All logic: file pick/drop, engine loading with progress + stall watchdog, conversion with live percentage, download link. |
| `vendor/ffmpeg.js` + `vendor/814.ffmpeg.js` | `@ffmpeg/ffmpeg` 0.12.15 (UMD build) — the library that drives the engine. |
| `vendor/ffmpeg-core.js` | `@ffmpeg/core` 0.12.10 — FFmpeg compiled to JavaScript (the wasm loader). |
| `vendor/ffmpeg-core.wasm.001` + `.002` | The ~32 MB wasm engine, split into two parts so each file is under GitHub's 25 MB browser-upload limit. The page downloads both parts and stitches them back together in memory. |
| `Audio Conversion Guide.html` | Redirect stub; the page originally lived at this filename. |
| `test/smoke.js` | End-to-end check that the vendored engine still converts audio. |

## Publishing changes without git (browser upload)

GitHub's website accepts file uploads up to **25 MB each**, which is why the
engine wasm is stored as two ~16 MB parts. To publish from a browser:

1. Download this repository as files (or a zip) on your computer.
2. Go to the repo on github.com → **Add file** → **Upload files**.
3. Drag in `index.html`, `app.js`, `README.md`, `Audio Conversion Guide.html`,
   the whole `vendor/` folder, and `test/smoke.js`.
4. Click **Commit changes**. GitHub Pages rebuilds in a minute or two.

## Why the engine is vendored (not loaded from unpkg.com)

The original page downloaded the ~32 MB engine from `unpkg.com` at
conversion time, with no progress indicator and no timeout. Two problems:

1. **It looked stuck.** A slow or stalled 30 MB download with a static
   "Loading conversion engine…" message reads as "loading forever."
2. **It could fail outright.** `@ffmpeg/ffmpeg`'s UMD build starts its Web
   Worker from the directory its own `<script>` tag was loaded from. When
   that is a different origin (unpkg.com), browsers refuse to construct the
   worker, so the engine could never start.

Serving everything same-origin from this repository fixes both, and removes
the dependency on a third-party CDN. The first visit downloads the engine
once (~32 MB, with a visible progress bar); the browser caches it after
that, and the page warms the engine as soon as it opens so the first
Convert is quick.

## Running locally

```
python3 -m http.server 8000
# open http://localhost:8000/
```

(Opening `index.html` directly as a `file://` URL will not work — the page
needs http(s) to start its Web Worker.)

## Testing the engine

```
node test/smoke.js
```

Generates a WAV, runs the same conversion the page performs, and checks
that a valid MP3 comes out. Useful after updating the files in `vendor/`.

## Updating the engine

```
npm pack @ffmpeg/ffmpeg @ffmpeg/core
# extract each tarball and copy dist/umd/* (excluding *.map) into vendor/
# split the core wasm into two parts under 25 MB each, e.g. on Linux/macOS:
#   split -n 2 -d -a 3 vendor/ffmpeg-core.wasm vendor/ffmpeg-core.wasm.
#   rm vendor/ffmpeg-core.wasm
# then update CORE_PARTS / ENGINE_TOTAL_BYTES in app.js
node test/smoke.js   # verifies sizes, the stitched sha256, and conversion
```

Keep `ffmpeg.js` and `814.ffmpeg.js` from the same `@ffmpeg/ffmpeg`
version — the numbered chunk is the library's worker script, referenced
relative to `ffmpeg.js`.
