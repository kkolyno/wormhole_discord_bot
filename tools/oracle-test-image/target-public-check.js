'use strict';
// Fixed public fixture only. No Discord client, bot login, private call audio,
// participant recording, marker consumption, or external recognition service.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { command, recognizeLocal, recognitionArgs, MODEL, WHISPER, FFMPEG } = require('/app/tools/oracle-test/local-stt');
const { privateDir } = require('/app/tools/oracle-test/storage');
const URL = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav';
const FIXTURE_SHA = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';
const MODEL_SHA = 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002';
function temperatures() {
  const rows = [];
  for (let i = 0; i < 16; i++) {
    const base = `/sys/class/thermal/thermal_zone${i}`;
    try {
      const type = fs.readFileSync(`${base}/type`, 'utf8').trim();
      const milliC = Number(fs.readFileSync(`${base}/temp`, 'utf8').trim());
      if (/^[A-Za-z0-9_-]{1,64}$/.test(type) && Number.isFinite(milliC)) rows.push({ type, celsius: milliC / 1000 });
    } catch { /* unavailable remains unknown */ }
  }
  return rows;
}
async function shaFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function main() {
  if (process.env.DISCORD_TOKEN || process.getuid() !== 1001 || process.arch !== 'arm64') throw Error('ISOLATED_ARM64_PREFLIGHT_REQUIRED');
  process.umask(0o077);
  const codecPreflight = require('/app/tools/feasibility/codec').preflight();
  const data = process.env.DATA_DIR;
  privateDir(data);
  if (fs.existsSync(path.join(data, 'attempted.json'))) throw Error('TEST_ALREADY_CONSUMED');
  if (fs.statSync(MODEL).size !== 147964211 || await shaFile(MODEL) !== MODEL_SHA) throw Error('MODEL_HASH');
  const initial = { temperatures: temperatures(), freeMemoryBytes: os.freemem() };
  const dir = fs.mkdtempSync(path.join(data, 'public-check-'));
  const timer = new AbortController();
  const deadline = setTimeout(() => timer.abort(), 120000);
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw Error('PUBLIC_DOWNLOAD');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 352078) throw Error('PUBLIC_SIZE_BOUND');
      chunks.push(Buffer.from(chunk));
    }
    const fixture = Buffer.concat(chunks, size);
    if (size !== 352078 || crypto.createHash('sha256').update(fixture).digest('hex') !== FIXTURE_SHA) throw Error('PUBLIC_HASH');
    const wav = path.join(dir, 'public.wav'); fs.writeFileSync(wav, fixture, { mode: 0o600, flag: 'wx' });
    const start = performance.now();
    const text = (await command(WHISPER, recognitionArgs(wav), timer.signal, { maxOutput: 65536 })).toString('utf8').trim();
    const fullMs = performance.now() - start;
    if (!/ask not/i.test(text) || !/country/i.test(text)) throw Error('PUBLIC_RECOGNITION');
    const pcmPath = path.join(dir, 'public.pcm');
    await command(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', wav, '-t', '8', '-ar', '48000', '-ac', '2', '-f', 's16le', '-n', pcmPath], timer.signal);
    const pcm = fs.readFileSync(pcmPath);
    if (pcm.length <= 0 || pcm.length > 8 * 192000) throw Error('PCM_BOUND');
    const helperStart = performance.now();
    const helperText = await recognizeLocal({ id: 'public-helper', dir, pcm, signal: timer.signal });
    const helperMs = performance.now() - helperStart;
    if (!/americans|fellow/i.test(helperText)) throw Error('HELPER_RECOGNITION');
    if (fs.existsSync(path.join(dir, 'public-helper.source.wav')) || fs.existsSync(path.join(dir, 'public-helper.16k.wav'))) throw Error('HELPER_CLEANUP');
    const result = {
      kind: 'public_fixture_only_not_call_accuracy', codecPreflight, node: process.version, architecture: process.arch,
      cpuCount: os.cpus().length, cpuModels: [...new Set(os.cpus().map(c => c.model))],
      modelSha256: MODEL_SHA, fixtureSha256: FIXTURE_SHA,
      fullFixtureWallMs: Math.round(fullMs), fullFixtureText: text,
      warmHelperAudioSeconds: pcm.length / 192000, warmHelperWallMs: Math.round(helperMs),
      warmHelperRealTimeFactor: Number((helperMs / (pcm.length / 192)).toFixed(3)),
      warmHelperText: helperText, initial,
      final: { temperatures: temperatures(), freeMemoryBytes: os.freemem() },
      limits: 'One short public clip; not sustained, multi-speaker, DAVE receive, or microphone accuracy evidence.'
    };
    try { result.memoryPeakBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim()); } catch { result.memoryPeakBytes = null; }
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(deadline); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('PUBLIC_TARGET_CHECK_FAILED_DETAILS_SUPPRESSED'); process.exitCode = 1; });
