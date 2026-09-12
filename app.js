/* Speech Optimizer — in-browser interview audio converter.
 *
 * Engine: ffmpeg.wasm (single-threaded), self-hosted in vendor/ so there is
 * no dependency on third-party CDNs like unpkg.com. Everything loads from
 * the same origin, which is also what allows the engine's Web Worker to
 * start (browsers block cross-origin classic workers).
 *
 * Flow: pick/drop a file → Convert → engine warms up (one-time ~32 MB
 * download with a visible progress bar) → decode, downmix to mono, resample
 * to 16 kHz, encode 64 kbps MP3 → download link.
 */
(function () {
  'use strict';

  var CORE_JS = 'vendor/ffmpeg-core.js';
  // The wasm engine is 32 MB, split into parts so every file stays under
  // GitHub's 25 MB browser-upload limit. The parts are fetched in order and
  // stitched back together in memory — the engine never knows the difference.
  var CORE_PARTS = ['vendor/ffmpeg-core.wasm.001', 'vendor/ffmpeg-core.wasm.002'];
  var ENGINE_TOTAL_BYTES = 32232419; // exact size of the stitched engine
  var STALL_MS = 45000; // engine download: give up if no data for this long

  var ffmpeg = null;        // FFmpeg instance, set once the engine is ready
  var engineJob = null;     // in-flight engine load (null again after failure, so Convert retries)
  var selectedFile = null;
  var busy = false;
  var inputDuration = null; // seconds, parsed from ffmpeg's own log output

  function $(id) { return document.getElementById(id); }
  var drop = $('drop');
  var fileInput = $('fileInput');
  var fileChip = $('fileChip');
  var fileName = $('fileName');
  var fileSize = $('fileSize');
  var runBtn = $('runBtn');
  var logEl = $('log');
  var resultEl = $('result');
  var meter = $('meter');
  var statusEl = $('status');
  var statusText = $('statusText');

  /* ---------- small helpers ---------- */

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtClock(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss;
  }

  function setStatus(text, warn) {
    statusText.textContent = text;
    statusEl.classList.toggle('warn', !!warn);
    statusEl.classList.add('show');
  }

  function logLine(text, active) {
    logEl.classList.add('show');
    var div = document.createElement('div');
    div.className = 'line' + (active ? ' active' : '');
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  var liveCount = 0;
  function meterOn() { liveCount++; meter.classList.add('live'); }
  function meterOff() { liveCount = Math.max(0, liveCount - 1); if (!liveCount) meter.classList.remove('live'); }

  /* ---------- engine loading (with progress + stall watchdog) ---------- */

  function engineErrorText(err) {
    var msg = (err && err.message) || String(err);
    if (/failed to construct/i.test(msg) || /worker/i.test(msg)) {
      return 'The engine could not start in this browser. Open the page from its web address (https://…) rather than as a downloaded file, and use a current version of Chrome, Edge, Firefox, or Safari.';
    }
    if (/stalled/i.test(msg) || /HTTP \d+/.test(msg)) {
      return msg + ' Press Convert to try again.';
    }
    return 'The engine could not load: ' + msg;
  }

  /* Download the engine parts with a progress indicator and a stall watchdog.
     Returns a blob: URL of the stitched-together engine. */
  function fetchWasmWithProgress(onProgress) {
    var controller = new AbortController();
    var lastActivity = Date.now();
    var watchdog = setInterval(function () {
      if (Date.now() - lastActivity > STALL_MS) controller.abort();
    }, 3000);

    onProgress(0, ENGINE_TOTAL_BYTES);

    function fetchOne(url) {
      return fetch(url, { signal: controller.signal }).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' while downloading the engine.');
        if (!resp.body || !resp.body.getReader) {
          // Streaming not supported: fetch whole thing, no granular progress.
          return resp.arrayBuffer().then(function (buf) { return [new Uint8Array(buf)]; });
        }
        var reader = resp.body.getReader();
        var chunks = [];
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return chunks;
            chunks.push(r.value);
            lastActivity = Date.now();
            return pump();
          });
        }
        return pump();
      });
    }

    var partChunks = []; // chunks of each part, in order
    var received = 0;

    var chain = Promise.resolve();
    CORE_PARTS.forEach(function (url) {
      chain = chain.then(function () {
        return fetchOne(url).then(function (chunks) {
          partChunks.push(chunks);
          for (var i = 0; i < chunks.length; i++) received += chunks[i].length;
          onProgress(received, ENGINE_TOTAL_BYTES);
        });
      });
    });

    return chain.then(function () {
      clearInterval(watchdog);
      var all = [];
      partChunks.forEach(function (chunks) {
        chunks.forEach(function (c) { all.push(c); });
      });
      return URL.createObjectURL(new Blob(all, { type: 'application/wasm' }));
    }).catch(function (err) {
      clearInterval(watchdog);
      if (err && err.name === 'AbortError') {
        throw new Error('The engine download stalled — no data for 45 seconds. Check your internet connection.');
      }
      throw err;
    });
  }

  function loadEngine() {
    if (engineJob) return engineJob;
    meterOn();
    engineJob = (async function () {
      if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
        throw new Error('vendor/ffmpeg.js did not load. Make sure the vendor folder sits next to index.html and the page is served over http(s)://');
      }
      var ff = new window.FFmpegWASM.FFmpeg();
      ff.on('log', onEngineLog);

      var wasmURL = await fetchWasmWithProgress(function (done, total) {
        if (!total) {
          setStatus('Downloading conversion engine (one-time, ~32 MB)…');
          return;
        }
        var pct = Math.min(100, Math.round((done / total) * 100));
        setStatus('Downloading conversion engine (one-time)… ' + pct + '% · ' + fmtBytes(done) + ' of ' + fmtBytes(total));
      });

      setStatus('Starting the engine…');
      // The FFmpeg wrapper forwards coreURL to a worker running from vendor/.
      // Make it absolute so the worker does not resolve it as vendor/vendor/… .
      var coreURL = new URL(CORE_JS, window.location.href).href;
      await ff.load({ coreURL: coreURL, wasmURL: wasmURL });
      ffmpeg = ff;
      setStatus('Engine ready ✓');
    })().then(
      function (ok) { meterOff(); return ok; },
      function (err) { meterOff(); engineJob = null; throw err; }
    );
    return engineJob;
  }

  /* ffmpeg log lines: capture the input duration, turn time= progress
     lines into a percentage, and keep the log panel readable. */
  function onEngineLog(evt) {
    var message = (evt && evt.message) || '';
    if (!message) return;

    var d = message.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (d && inputDuration == null) {
      inputDuration = (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]);
    }

    var t = message.match(/time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (t && inputDuration) {
      var cur = (+t[1]) * 3600 + (+t[2]) * 60 + (+t[3]);
      var pct = Math.min(99, Math.round((cur / inputDuration) * 100));
      setStatus('Converting… ' + pct + '% · ' + fmtClock(cur) + ' of ' + fmtClock(inputDuration));
    }

    if (message.indexOf('time=') !== -1) return; // progress spam → status line instead
    if (message.slice(0, 2) === '  ') return;    // indented codec/option lists
    logLine(message);
  }

  /* ---------- file selection ---------- */

  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('hover'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('hover'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('hover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function (e) {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  function handleFile(file) {
    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = fmtBytes(file.size);
    fileChip.classList.add('show');
    runBtn.disabled = false;
    resultEl.classList.remove('show');
    logEl.innerHTML = '';
    logEl.classList.remove('show');
    if (ffmpeg) setStatus('Ready — press Convert.');
  }

  /* ---------- conversion ---------- */

  runBtn.addEventListener('click', function () {
    if (busy || !selectedFile) return;
    convert();
  });

  async function convert() {
    busy = true;
    runBtn.disabled = true;
    meterOn();
    resultEl.classList.remove('show');
    logEl.innerHTML = '';
    logEl.classList.remove('show');
    inputDuration = null;

    try {
      if (!ffmpeg) setStatus('Preparing the conversion engine…');
      await loadEngine();

      var ext = (selectedFile.name.match(/\.[^.]+$/) || ['.dat'])[0];
      var inputName = 'input' + ext;
      var outputName = selectedFile.name.replace(/\.[^.]+$/, '') + '-optimized.mp3';

      setStatus('Reading ' + selectedFile.name + '…');
      var bytes = new Uint8Array(await selectedFile.arrayBuffer());
      await ffmpeg.writeFile(inputName, bytes);

      setStatus('Converting… 0%');
      await ffmpeg.exec([
        '-i', inputName,
        '-map', '0:a:0',
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'libmp3lame',
        '-b:a', '64k',
        '-map_metadata', '-1',
        '-id3v2_version', '3',
        outputName
      ]);

      setStatus('Finishing…');
      var data = await ffmpeg.readFile(outputName);
      var blob = new Blob([data], { type: 'audio/mpeg' });
      var url = URL.createObjectURL(blob);

      $('outName').textContent = outputName;
      $('outSize').textContent = fmtBytes(blob.size) + ' (from ' + fmtBytes(selectedFile.size) + ')';
      var link = $('downloadLink');
      link.href = url;
      link.download = outputName;
      resultEl.classList.add('show');
      setStatus('Done ✓ — your file is ready to download.');
      logLine('Done.');

      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch (err) {
      console.error(err);
      var msg = (err && err.message) || String(err);
      logLine('Error: ' + msg);
      if (!ffmpeg) {
        setStatus(engineErrorText(err), true);
      } else {
        setStatus('Something went wrong during conversion — see the details above.', true);
      }
    } finally {
      meterOff();
      busy = false;
      runBtn.disabled = false;
    }
  }

  /* ---------- warm the engine as soon as the page opens ---------- */

  window.addEventListener('load', function () {
    if (location.protocol === 'file:') {
      setStatus('This page must be opened from its web address (https://…), not as a downloaded file on your computer.', true);
      return;
    }
    loadEngine().catch(function () {
      /* The status line already shows what went wrong; Convert will retry. */
    });
  });
})();
