'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRecognizer, command, conversionArgs, recognitionArgs, FFMPEG, WHISPER, MODEL } = require('../../src/features/local-transcription/recognizer');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, pcm = Buffer.from([1, 0, 0, 0])) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-recognizer-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'safe-job.pcm'); fs.writeFileSync(source, pcm, { mode: 0o600 });
  return { dir, job: { path: source, bytes: pcm.length }, pcm };
}
function fakeChild() { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kills = []; c.kill = signal => c.kills.push(signal); return c; }

test('raw private PCM -> unique private 16k mono WAV -> exact pinned base.en/English/CPU4 CLI; leaves source ownership to store', async t => {
  const f = fixture(t), calls = [], converted = [], scratch = path.join(f.dir, 'scratch'); fs.mkdirSync(scratch, { mode: 0o700 });
  const recognize = createRecognizer({ tempRoot: scratch, run: async (file, args, signal, opts) => {
    calls.push({ file, args, opts }); assert.equal(signal.aborted, false);
    assert.deepEqual(fs.readdirSync(scratch), []); // No named speech file even while native work is active.
    assert.equal(fs.fstatSync(opts.passFd).mode & 0o777, 0o600); assert.equal(fs.fstatSync(opts.passFd).nlink, 0);
    if (file === FFMPEG) {
      const output = args.at(-1); converted.push(output); assert.equal(output, '/proc/self/fd/3');
      assert.equal(args[args.indexOf('-i') + 1], f.job.path);
      assert.deepEqual(args, conversionArgs(f.job.path, output)); fs.writeFileSync(opts.passFd, 'converted');
    } else { assert.equal(file, WHISPER); assert.deepEqual(args, recognitionArgs(converted.at(-1))); return Buffer.from('  final words  \n'); }
  } });
  for (let i = 0; i < 2; i++) assert.equal(await recognize(f.job, { signal: new AbortController().signal }), 'final words');
  for (const call of calls) assert.throws(() => fs.fstatSync(call.opts.passFd), { code: 'EBADF' });
  assert.deepEqual(calls[0].opts, { timeoutMs: 10000, passFd: calls[0].opts.passFd }); assert.deepEqual(calls[1].opts, { timeoutMs: 60000, maxOutput: 65536, passFd: calls[0].opts.passFd });
  assert.deepEqual(recognitionArgs('converted'), ['-m', MODEL, '-f', 'converted', '-l', 'en', '-t', '4', '--no-gpu', '-nt', '-np']);
  assert.deepEqual(conversionArgs('raw', 'converted').slice(3, 10), ['error', '-f', 's16le', '-ar', '48000', '-ac', '2']);
  assert.deepEqual(fs.readFileSync(f.job.path), f.pcm); assert.deepEqual(fs.readdirSync(f.dir).sort(), ['safe-job.pcm', 'scratch']);
});

test('concurrent injected recognizers use distinct anonymous inodes, never overwrite one another', async t => {
  const f = fixture(t), inodes = [], releases = [];
  const recognize = createRecognizer({ run: async (file, _args, _signal, opts) => {
    if (file === FFMPEG) {
      inodes.push(fs.fstatSync(opts.passFd).ino); fs.writeFileSync(opts.passFd, 'wav');
      await new Promise(resolve => releases.push(resolve));
    } else return Buffer.from('words');
  } });
  const first = recognize(f.job), second = recognize(f.job);
  assert.equal(inodes.length, 2); assert.notEqual(inodes[0], inodes[1]);
  releases.forEach(resolve => resolve()); assert.deepEqual(await Promise.all([first, second]), ['words', 'words']);
  assert.deepEqual(fs.readdirSync(f.dir), ['safe-job.pcm']);
});

test('skip only exact zero/no-data; one quiet nonzero sample anywhere must run recognition', async t => {
  for (const pcm of [Buffer.alloc(0), Buffer.alloc(1536000), Buffer.from([0, 0, 1, 0]), Buffer.concat([Buffer.alloc(70000), Buffer.from([1, 0, 0, 0])])]) {
    const f = fixture(t, pcm); let count = 0;
    const recognize = createRecognizer({ run: async (file, _args, _signal, opts) => { count++; if (file === FFMPEG) fs.writeFileSync(opts.passFd, 'wav'); else return Buffer.from('quiet speech'); } });
    const hasSpeech = pcm.includes(1);
    assert.deepEqual(await recognize(f.job), hasSpeech ? 'quiet speech' : { text: '', noSpeech: true });
    assert.equal(count, hasSpeech ? 2 : 0);
    assert.equal(fs.existsSync(f.job.path), true);
  }
});

test('empty or whitespace-only model output for nonzero PCM stays a string, never verified noSpeech', async t => {
  const f = fixture(t);
  for (const output of [Buffer.alloc(0), Buffer.from(' \n\t ')]) {
    const calls = [];
    const recognize = createRecognizer({ run: async (file, _args, _signal, opts) => {
      calls.push(file);
      if (file === FFMPEG) fs.writeFileSync(opts.passFd, 'wav');
      else return output;
    } });
    assert.equal(await recognize(f.job), '');
    assert.deepEqual(calls, [FFMPEG, WHISPER]);
    assert.deepEqual(fs.readFileSync(f.job.path), f.pcm);
  }
});

test('reject missing/misaligned/size-mismatched/oversized/permissive/symlink/hardlink PCM before native command', async t => {
  const f = fixture(t); let count = 0; const recognize = createRecognizer({ run: () => { count++; } });
  for (const job of [{ ...f.job, path: 'relative.pcm' }, { ...f.job, bytes: 3 }, { ...f.job, bytes: 8 }, { ...f.job, bytes: 1536004 }, { ...f.job, path: path.join(f.dir, 'missing') }]) await assert.rejects(recognize(job));
  fs.chmodSync(f.job.path, 0o644); await assert.rejects(recognize(f.job)); fs.chmodSync(f.job.path, 0o600);
  const link = path.join(f.dir, 'link.pcm'); fs.symlinkSync(f.job.path, link); await assert.rejects(recognize({ ...f.job, path: link })); fs.unlinkSync(link);
  fs.linkSync(f.job.path, link); await assert.rejects(recognize(f.job)); fs.unlinkSync(link);
  fs.chmodSync(f.dir, 0o755); await assert.rejects(recognize(f.job)); fs.chmodSync(f.dir, 0o700);
  assert.equal(count, 0); assert.equal(fs.existsSync(f.job.path), true);
});

test('conversion/recognition/overflow/abort failures remove only private converted artifacts and sanitize exceptions', async t => {
  for (const failure of ['conversion', 'recognition', 'output', 'abort', 'missing', 'huge']) {
    const f = fixture(t), abort = new AbortController();
    const recognize = createRecognizer({ run: async (file, _args, _signal, opts) => {
      if (file === FFMPEG) {
        if (failure === 'conversion') throw Error('private native details');
        if (failure !== 'missing') fs.writeFileSync(opts.passFd, failure === 'huge' ? Buffer.alloc(524289) : 'wav');
        if (failure === 'abort') abort.abort();
      } else {
        if (failure === 'recognition') throw Error('private speech');
        return Buffer.alloc(65537);
      }
    } });
    await assert.rejects(recognize(f.job, { signal: abort.signal }), error => !error.message.includes('private'));
    assert.deepEqual(fs.readdirSync(f.dir), ['safe-job.pcm']); assert.deepEqual(fs.readFileSync(f.job.path), f.pcm);
  }
});

test('sanitized child environment has no shell/secrets, privately bounded stdout; TERM/KILL abort awaits actual close', async () => {
  const child = fakeChild(), abort = new AbortController(); let settled = false;
  const running = command(WHISPER, ['fixed'], abort.signal, { maxOutput: 64, killGraceMs: 10 }, (file, args, opts) => {
    assert.equal(file, WHISPER); assert.deepEqual(args, ['fixed']); assert.equal(opts.shell, false);
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'ignore']);
    assert.deepEqual(opts.env, { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: '/usr/local/lib' }); return child;
  });
  running.catch(() => { settled = true; }); abort.abort(); await delay(25);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false);
  // Even a late native 'error' must not release the sole scheduler slot.
  child.emit('error', Error('private')); await delay(5); assert.equal(settled, false);
  child.emit('close', 0); await assert.rejects(running, { code: 'LOCAL_JOB_ABORTED' }); assert.equal(settled, true);
});

test('runtime deadline, output overflow and child error wait close rather than overlapping next native job', async () => {
  for (const reason of ['timeout', 'overflow', 'error']) {
    const child = fakeChild(); let settled = false;
    const running = command(WHISPER, [], undefined, { maxOutput: 8, timeoutMs: 15, killGraceMs: 5 }, () => child);
    running.catch(() => { settled = true; });
    if (reason === 'overflow') { child.stdout.emit('data', Buffer.from('1234')); child.stdout.emit('data', Buffer.from('56789')); }
    if (reason === 'error') child.emit('error', Error('private'));
    await delay(35); assert.equal(settled, false); assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    child.emit('close', 0);
    await assert.rejects(running, { code: reason === 'timeout' ? 'LOCAL_COMMAND_TIMEOUT' : reason === 'overflow' ? 'LOCAL_OUTPUT_LIMIT' : 'LOCAL_COMMAND_FAILED' });
  }
});

test('spawn throws, pre-aborted jobs, nonzero exits and strict output cap all fail safely; 64KiB accepted', async t => {
  await assert.rejects(command(FFMPEG, [], undefined, {}, () => { throw Error('private'); }), { code: 'LOCAL_COMMAND_FAILED' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(command(FFMPEG, [], abort.signal, {}, () => assert.fail('must not spawn')), { code: 'LOCAL_JOB_ABORTED' });
  const child = fakeChild(); const running = command(WHISPER, [], undefined, { maxOutput: 65536 }, () => child);
  child.stdout.emit('data', Buffer.alloc(65536, 65)); child.emit('close', 0); assert.equal((await running).length, 65536);
  const failed = fakeChild(); const failure = command(FFMPEG, [], undefined, {}, () => failed); failed.emit('close', 1); await assert.rejects(failure, { code: 'LOCAL_COMMAND_FAILED' });
  const f = fixture(t); const recognize = createRecognizer({ run: () => assert.fail('must not run') });
  await assert.rejects(recognize(f.job, { signal: abort.signal }), { code: 'LOCAL_JOB_ABORTED' });
});

test('real child inherits an anonymous regular file via fd3, seekable across separate writer and reader processes', async t => {
  const f = fixture(t), named = path.join(f.dir, 'scratch');
  const fd = fs.openSync(named, 'wx+', 0o600); fs.unlinkSync(named);
  try {
    await command(process.execPath, ['-e', "require('node:fs').writeFileSync('/proc/self/fd/3','converted WAV')"], undefined, { passFd: fd });
    const stdout = await command(process.execPath, ['-e', "process.stdout.write(require('node:fs').readFileSync('/proc/self/fd/3'))"], undefined, { passFd: fd, maxOutput: 64 });
    assert.equal(stdout.toString(), 'converted WAV'); assert.equal(fs.fstatSync(fd).nlink, 0);
  } finally { fs.closeSync(fd); }
});

test('real isolated subprocess deadline kills and waits close before returning; no bot or native recognizer launched', async () => {
  const { spawn } = require('node:child_process'); let child, closed = false;
  const running = command(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], undefined,
    { timeoutMs: 200, killGraceMs: 20 }, (file, args, options) => {
      child = spawn(file, args, options); child.once('close', () => { closed = true; }); return child;
    });
  await assert.rejects(running, { code: 'LOCAL_COMMAND_TIMEOUT' });
  assert.equal(closed, true); assert.ok(child.signalCode === 'SIGKILL' || child.signalCode === 'SIGTERM');
});

test('real ffmpeg explicit RAW s16le conversion yields 16kHz mono WAV with complete synthetic samples', { skip: !fs.existsSync(FFMPEG) }, async t => {
  const pcm = Buffer.alloc(48000 * 4);
  for (let i = 0; i < 48000; i++) { const value = Math.round(1000 * Math.sin(i * 2 * Math.PI * 440 / 48000)); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
  const f = fixture(t, pcm), output = path.join(f.dir, 'converted.wav'); fs.writeFileSync(output, '', { mode: 0o600 });
  await command(FFMPEG, conversionArgs(f.job.path, output), undefined, { timeoutMs: 3000 });
  const wav = fs.readFileSync(output); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let fmt, data;
  for (let i = 12; i + 8 <= wav.length;) {
    const name = wav.toString('ascii', i, i + 4), size = wav.readUInt32LE(i + 4);
    if (name === 'fmt ') fmt = wav.subarray(i + 8, i + 8 + size);
    if (name === 'data') data = wav.subarray(i + 8, i + 8 + size);
    i += 8 + size + size % 2;
  }
  assert.equal(fmt.readUInt16LE(0), 1); assert.equal(fmt.readUInt16LE(2), 1); assert.equal(fmt.readUInt32LE(4), 16000);
  assert.equal(fmt.readUInt16LE(14), 16); assert.equal(data.length, 32000); assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  let anonymous;
  const recognize = createRecognizer({ run: async (file, args, signal, opts) => {
    if (file === FFMPEG) return command(file, args, signal, opts);
    anonymous = fs.readFileSync(`/proc/self/fd/${opts.passFd}`); return Buffer.from('synthetic fixture');
  } });
  assert.equal(await recognize(f.job), 'synthetic fixture'); assert.equal(anonymous.toString('ascii', 0, 4), 'RIFF');
  assert.equal(anonymous.length, wav.length);
});
