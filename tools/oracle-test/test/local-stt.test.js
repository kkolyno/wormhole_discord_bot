'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { UtteranceWorker, recognizeLocal, command, conversionArgs, recognitionArgs, FFMPEG, WHISPER, MODEL } = require('../local-stt');
const { wavHeader } = require('../../feasibility/capture');
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-stt-'));
  fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('bounded hard chunks launch recognition DURING capture, one active, ordered stable job IDs plus final EOF tail', async t => {
  const calls = [], releases = []; let active = 0, peak = 0;
  const worker = new UtteranceWorker({ dir: temp(t), sessionId: 'session', chunkBytes: 16,
    recognize: job => { calls.push(job); active++; peak = Math.max(peak, active);
      return new Promise(resolve => releases.push(text => { active--; resolve(text); })); } });
  worker.accept({ pcm: Buffer.alloc(40, 1), relativeMs: 12 });
  assert.equal(calls.length, 1); assert.equal(worker.inputEnded, false); assert.equal(worker.jobs.length, 2);
  assert.equal(worker.bytes, 8); assert.equal(worker.receivedBytes, 40);
  releases[0]('first'); await tick(); assert.equal(calls.length, 2);
  worker.end(); assert.equal(worker.jobs.length, 3); // Last short utterance, not discarded.
  releases[1]('second'); await tick(); assert.equal(calls.length, 3); releases[2]('last');
  const result = await worker.drain(100);
  assert.equal(peak, 1); assert.deepEqual(result.jobs.map(j => j.id), ['session-001', 'session-002', 'session-003']);
  assert.deepEqual(result.jobs.map(j => j.text), ['first', 'second', 'last']);
  assert.deepEqual(result.jobs.map(j => j.bytes), [16, 16, 8]);
  assert.equal(result.accountedBytes, 40); assert.deepEqual(result.issues, []);
  assert.equal(fs.readdirSync(worker.dir).length, 0);
});

test('packet absence flushes short utterance without fabricating silence; later PCM and EOF preserve order', async t => {
  const seen = [];
  const worker = new UtteranceWorker({ dir: temp(t), sessionId: 'quiet', quietMs: 10,
    recognize: async j => { seen.push([...j.pcm]); return 'recognized'; } });
  worker.accept({ pcm: Buffer.from([1, 2, 3, 4]), relativeMs: 5 }); await delay(25);
  assert.equal(seen.length, 1); assert.equal(worker.inputEnded, false);
  worker.accept({ pcm: Buffer.from([5, 6, 7, 8]), relativeMs: 1000 });
  const result = await worker.drain(100);
  assert.deepEqual(seen, [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.deepEqual(result.jobs.map(j => j.startMs), [5, 1000]); assert.equal(result.accountedBytes, 8);
});

test('queue overload accounts explicitly for all accepted/rejected bytes, never silent drops', async t => {
  const worker = new UtteranceWorker({ dir: temp(t), sessionId: 'bounded', chunkBytes: 8, maxJobs: 2,
    recognize: async () => 'okay' });
  worker.accept({ pcm: Buffer.alloc(28), relativeMs: 0 }); worker.accept({ pcm: Buffer.alloc(4), relativeMs: 1 });
  const result = await worker.drain(100);
  assert.equal(result.jobs.length, 2); assert.equal(result.receivedBytes, 32); assert.equal(result.rejectedBytes, 16);
  assert.equal(result.accountedBytes, 32); assert.ok(result.issues.includes('UTTERANCE_QUEUE_LIMIT'));
  assert.ok(result.issues.includes('PCM_NOT_QUEUED'));
});

test('job errors/deadlines cancel queued jobs and forbid overlapping recognizers, including cancellation-ignoring fake', async t => {
  for (const recognize of [async () => { throw Error('payload'); }, () => new Promise(() => {})]) {
    let calls = 0;
    const worker = new UtteranceWorker({ dir: temp(t), sessionId: 'failure', chunkBytes: 8, jobMs: 10,
      recognize: j => { calls++; return recognize(j); } });
    worker.accept({ pcm: Buffer.alloc(24), relativeMs: 0 });
    const result = await worker.drain(100);
    assert.equal(calls, 1); assert.deepEqual(result.jobs.map(j => j.status), ['failed', 'cancelled', 'cancelled']);
    assert.equal(result.accountedBytes, 24); assert.ok(result.issues.includes('LOCAL_JOB_FAILED_OR_TIMEOUT'));
    assert.ok(!JSON.stringify(result).includes('payload'));
  }
});

test('total drain deadline cancels active and queued work, accounts all bytes, ignores late recognition', async t => {
  let release; const worker = new UtteranceWorker({ dir: temp(t), sessionId: 'drain', chunkBytes: 8,
    recognize: () => new Promise(r => { release = r; }) });
  worker.accept({ pcm: Buffer.alloc(20), relativeMs: 0 });
  const start = Date.now(), result = await worker.drain(15);
  assert.ok(Date.now() - start < 250); assert.equal(result.accountedBytes, 20);
  assert.deepEqual(result.jobs.map(j => j.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.ok(result.issues.includes('RECOGNITION_DRAIN_TIMEOUT'));
  release('late speech'); await tick(); assert.equal(worker.jobs[0].text, undefined);
});

test('blank recognition and oversized recognition never masquerade as successful transcript', async t => {
  const w = new UtteranceWorker({ dir: temp(t), sessionId: 'empty', recognize: async () => '' });
  w.accept({ pcm: Buffer.alloc(4), relativeMs: 0 }); assert.ok((await w.drain(100)).issues.includes('EMPTY_RECOGNITION'));
  const huge = new UtteranceWorker({ dir: temp(t), sessionId: 'huge', recognize: async () => 'a'.repeat(256 * 1024 + 1) });
  huge.accept({ pcm: Buffer.alloc(4), relativeMs: 0 }); const r = await huge.drain(100);
  assert.equal(r.jobs[0].status, 'failed'); assert.equal(r.jobs[0].text, undefined);
});

test('local pipeline writes private stereo WAV, resamples then bounds local English stdout, deletes all temporary files', async t => {
  const dir = temp(t), calls = [];
  const result = await recognizeLocal({ id: 'stable-001', dir, pcm: Buffer.alloc(3840), signal: new AbortController().signal },
    async (file, args, _signal, options) => {
      calls.push([file, args]);
      if (file === FFMPEG) {
        const input = args[args.indexOf('-i') + 1], source = fs.readFileSync(input);
        assert.equal(source.readUInt16LE(22), 2); assert.equal(source.readUInt32LE(24), 48000);
        assert.equal(source.readUInt32LE(40), 3840); assert.equal(fs.statSync(input).mode & 0o777, 0o600);
        fs.writeFileSync(args.at(-1), 'fake-converted', { mode: 0o600 });
      } else {
        assert.equal(file, WHISPER); assert.equal(args[args.indexOf('-m') + 1], MODEL);
        assert.deepEqual(options, { maxOutput: 65536 });
        return Buffer.from('  American English test  ');
      }
    });
  assert.equal(result, 'American English test'); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1], conversionArgs(path.join(dir, 'stable-001.source.wav'), path.join(dir, 'stable-001.16k.wav')));
  assert.ok(calls[0][1].includes('16000')); assert.ok(calls[0][1].includes('1'));
  assert.deepEqual(calls[1][1], recognitionArgs(path.join(dir, 'stable-001.16k.wav')));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('local pipeline failures remove raw/converted/text artifacts without exposing errors', async t => {
  const dir = temp(t);
  await assert.rejects(recognizeLocal({ id: 'bad-001', dir, pcm: Buffer.alloc(4), signal: new AbortController().signal },
    async () => { throw Error('fake converter'); }));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('subprocess wrapper has no shell/credentials/output; abort sends TERM then KILL and waits close', async () => {
  const child = new EventEmitter(), kills = []; child.kill = s => kills.push(s);
  const abort = new AbortController(); let settled = false;
  const promise = command(FFMPEG, ['fixed'], abort.signal, {}, (file, args, opts) => {
    assert.equal(file, FFMPEG); assert.deepEqual(args, ['fixed']); assert.equal(opts.shell, false);
    assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'ignore']); assert.deepEqual(Object.keys(opts.env).sort(), ['LANG', 'PATH']); return child;
  });
  promise.catch(() => { settled = true; }); abort.abort();
  assert.deepEqual(kills, ['SIGTERM']); await delay(550);
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false);
  child.emit('close', null); await assert.rejects(promise); assert.equal(settled, true);
});

test('subprocess transcript stdout is bounded, never logged/written, overflow terminates and fails', async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); const kills = []; child.kill = s => kills.push(s);
  const promise = command(WHISPER, ['fixed'], new AbortController().signal, { maxOutput: 8 }, (_file, _args, opts) => {
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'ignore']); return child;
  });
  child.stdout.emit('data', Buffer.from('1234')); child.stdout.emit('data', Buffer.from('56789'));
  assert.deepEqual(kills, ['SIGTERM']); child.emit('close', 0); await assert.rejects(promise);
});

test('optional real synthetic ffmpeg conversion produces 16k mono PCM WAV, not dropped samples', { skip: !fs.existsSync(FFMPEG) }, async t => {
  const dir = temp(t), input = path.join(dir, 'synthetic.wav'), output = path.join(dir, 'resampled.wav');
  const pcm = Buffer.alloc(48000 * 4);
  for (let n = 0; n < 48000; n++) { const value = Math.round(1000 * Math.sin(2 * Math.PI * 440 * n / 48000));
    pcm.writeInt16LE(value, n * 4); pcm.writeInt16LE(value, n * 4 + 2); }
  fs.writeFileSync(input, Buffer.concat([wavHeader(pcm.length), pcm]), { mode: 0o600 });
  await command(FFMPEG, conversionArgs(input, output), AbortSignal.timeout(3000));
  const wav = fs.readFileSync(output); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let fmt, data;
  for (let at = 12; at + 8 <= wav.length;) { const size = wav.readUInt32LE(at + 4), name = wav.toString('ascii', at, at + 4);
    if (name === 'fmt ') fmt = wav.subarray(at + 8, at + 8 + size);
    if (name === 'data') data = wav.subarray(at + 8, at + 8 + size); at += 8 + size + size % 2; }
  assert.equal(fmt.readUInt16LE(0), 1); assert.equal(fmt.readUInt16LE(2), 1); assert.equal(fmt.readUInt32LE(4), 16000);
  assert.equal(fmt.readUInt16LE(14), 16); assert.equal(data.length, 16000 * 2);
});
