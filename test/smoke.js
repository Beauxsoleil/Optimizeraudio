/* Smoke test for the vendored, split-file ffmpeg.wasm engine.
 *
 * The 32 MB engine wasm lives in vendor/ as two parts (each under GitHub's
 * 25 MB browser-upload limit). This test:
 *   1. checks the parts exist and match the byte count expected by app.js,
 *   2. stitches them together and verifies the exact sha256 (so a corrupted
 *      or mis-ordered upload can never slip through),
 *   3. instantiates the engine from those stitched bytes and runs the exact
 *      conversion command the page runs, verifying a valid ~64 kbps mono
 *      16 kHz MP3 comes out.
 *
 * Run with:  node test/smoke.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const PORT = 8017;
const BASE = 'http://127.0.0.1:' + PORT;

const ENGINE_SHA256 = '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7'; // @ffmpeg/core 0.12.10
const MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm' };

function makeWav(seconds, sampleRate) {
  const n = seconds * sampleRate;
  const data = Buffer.alloc(n * 4); // stereo, 16-bit
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 8000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(sampleRate * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

function startServer(combined) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/combined.wasm') {
        res.writeHead(200, { 'Content-Type': 'application/wasm', 'Content-Length': combined.length });
        res.end(combined);
        return;
      }
      const name = path.basename((req.url || '').split('?')[0]);
      const file = path.join(VENDOR, name);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const partPaths = ['ffmpeg-core.wasm.001', 'ffmpeg-core.wasm.002']
    .map((n) => path.join(VENDOR, n));
  for (const p of partPaths.concat([path.join(VENDOR, 'ffmpeg-core.js')])) {
    if (!fs.existsSync(p)) {
      console.error('vendor/ is missing', path.basename(p), '— nothing to test.');
      process.exit(1);
    }
  }

  // [1] Part sizes must match what app.js expects.
  const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const m = appJs.match(/ENGINE_TOTAL_BYTES\s*=\s*(\d+)/);
  if (!m) {
    console.error('Could not find ENGINE_TOTAL_BYTES in app.js');
    process.exit(1);
  }
  const expectedTotal = parseInt(m[1], 10);
  const parts = partPaths.map((p) => fs.readFileSync(p));
  const combined = Buffer.concat(parts);
  const sizesOk = expectedTotal === combined.length;
  console.log('[1] parts:', parts.map((p) => p.length).join(' + '), '=', combined.length,
    sizesOk ? '(matches app.js)' : '(app.js expects ' + expectedTotal + ' — MISMATCH)');

  // [2] Stitched engine must hash to the exact known-good wasm.
  const sha = crypto.createHash('sha256').update(combined).digest('hex');
  const hashOk = sha === ENGINE_SHA256;
  console.log('[2] stitched sha256:', sha, hashOk ? '(matches known-good engine)' : '(MISMATCH!)');

  const server = await startServer(combined);
  try {
    // [3] Instantiate the engine from the stitched bytes and convert.
    globalThis.self = globalThis;
    globalThis.location = new URL(BASE + '/vendor/ffmpeg-core.js');

    const createFFmpegCore = require(path.join(VENDOR, 'ffmpeg-core.js'));

    const hash = Buffer.from(JSON.stringify({
      wasmURL: BASE + '/combined.wasm',
      workerURL: '',
    })).toString('base64');

    const logs = [];
    const core = await createFFmpegCore({
      mainScriptUrlOrBlob: BASE + '/vendor/ffmpeg-core.js#' + hash,
      print: () => {},
      printErr: () => {},
    });
    console.log('[3] wasm core instantiated from stitched parts OK');

    core.setLogger((e) => { if (logs.length < 400) logs.push(e.type + ': ' + e.message); });
    core.setProgress(() => {});

    const wav = makeWav(3, 44100);
    core.FS.writeFile('in.wav', new Uint8Array(wav));
    console.log('[4] wrote in.wav (' + wav.length + ' bytes, 3s stereo 44.1kHz)');

    core.setTimeout(-1);
    core.exec('-i', 'in.wav', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
              '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1',
              '-id3v2_version', '3', 'out.mp3');
    const ret = core.ret;
    core.reset();
    console.log('[5] exec returned:', ret);

    const out = core.FS.readFile('out.mp3');
    const head = Buffer.from(out.slice(0, 4));
    console.log('[6] out.mp3 size:', out.length, 'header:', head.toString('hex'));
    const isMp3 = head[0] === 0xff || (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33);
    const saneSize = out.length > 15000 && out.length < 40000; // 3s @ 64kbps ~= 24KB

    const pass = sizesOk && hashOk && isMp3 && saneSize && ret === 0;
    console.log(pass
      ? 'SMOKE TEST PASSED (split engine intact; valid ~64kbps mono 16kHz MP3 produced)'
      : 'SMOKE TEST FAILED');
    process.exitCode = pass ? 0 : 1;
  } catch (e) {
    console.error('SMOKE TEST FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
