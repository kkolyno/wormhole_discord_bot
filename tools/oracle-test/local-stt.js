'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { wavHeader } = require('../feasibility/capture');
const { exclusive } = require('./storage');
const FFMPEG = '/usr/bin/ffmpeg';
const WHISPER = '/usr/local/bin/whisper-cli';
const MODEL = '/opt/models/ggml-base.en.bin';
function assertLocalTools(io = fs) {
  io.accessSync(FFMPEG, fs.constants.X_OK); io.accessSync(WHISPER, fs.constants.X_OK);
  io.accessSync(MODEL, fs.constants.R_OK);
  if (!io.statSync(MODEL).isFile() || io.statSync(MODEL).size === 0) throw Error('LOCAL_MODEL_REQUIRED');
}
function conversionArgs(input, output) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1',
    '-c:a', 'pcm_s16le', '-t', '8', '-fs', '524288', '-f', 'wav', '-n', output];
}
function recognitionArgs(input) {
  // whisper-cli's transcript stdout is privately bounded in memory, never logged
  // or written to an unbounded native output file.
  return ['-m', MODEL, '-f', input, '-l', 'en', '-t', '4', '--no-gpu', '-nt', '-np'];
}
function command(file, args, signal, { maxOutput = 0 } = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('LOCAL_JOB_ABORTED'));
    let child, killer, settled = false, overflow = false, bytes = 0;
    const chunks = [];
    const done = ok => {
      if (settled) return; settled = true; clearTimeout(killer); signal.removeEventListener('abort', abort);
      if (ok && !signal.aborted && !overflow) resolve(Buffer.concat(chunks, bytes)); else reject(Error('LOCAL_COMMAND_FAILED'));
    };
    const abort = () => {
      try { child.kill('SIGTERM'); } catch { /* sanitized */ }
      killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* sanitized */ } }, 500);
    };
    try {
      child = spawnImpl(file, args, { stdio: ['ignore', maxOutput ? 'pipe' : 'ignore', 'ignore'], shell: false,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } });
      if (maxOutput) child.stdout.on('data', data => {
        if (overflow) return;
        if (bytes + data.length > maxOutput) { overflow = true; abort(); return; }
        chunks.push(Buffer.from(data)); bytes += data.length;
      });
      child.once('error', () => done(false)); child.once('close', code => done(code === 0));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    } catch { done(false); }
  });
}
async function recognizeLocal({ id, pcm, dir, signal }, run = command) {
  const source = path.join(dir, `${id}.source.wav`), converted = path.join(dir, `${id}.16k.wav`);
  try {
    exclusive(source, Buffer.concat([wavHeader(pcm.length), pcm]));
    await run(FFMPEG, conversionArgs(source, converted), signal);
    const text = await run(WHISPER, recognitionArgs(converted), signal, { maxOutput: 65536 });
    if (!Buffer.isBuffer(text) || text.length > 65536) throw Error('TEXT_BOUND');
    return text.toString('utf8').trim();
  } finally {
    for (const f of [source, converted]) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw Error('AUDIO_CLEANUP_FAILED'); } }
  }
}
// One speaker, one active local job. Packet absence endpoints an utterance; it is
// NOT synthetic silence. Hard PCM chunks make uninterrupted speech progress live.
class UtteranceWorker {
  constructor({ dir, sessionId, recognize = recognizeLocal, onFault = () => {}, quietMs = 850,
    chunkBytes = 8 * 192000, maxJobs = 12, jobMs = 60000, now = () => performance.now() }) {
    Object.assign(this, { dir, sessionId, recognize, onFault, quietMs, chunkBytes, maxJobs, jobMs, now });
    this.jobs = []; this.parts = []; this.bytes = 0; this.receivedBytes = 0; this.rejectedBytes = 0;
    this.issues = new Set(); this.inputEnded = false; this.sealed = false; this.textBytes = 0;
  }
  fault(code) { this.issues.add(code); this.onFault(code); }
  accept({ pcm, relativeMs }) {
    this.receivedBytes += pcm.length;
    if (this.inputEnded || this.sealed || this.overloaded || this.noPump) { this.rejectedBytes += pcm.length; this.fault('PCM_NOT_QUEUED'); return; }
    clearTimeout(this.quietTimer);
    let offset = 0;
    while (offset < pcm.length) {
      if (!this.bytes) this.startMs = relativeMs;
      const size = Math.min(pcm.length - offset, this.chunkBytes - this.bytes);
      this.parts.push(Buffer.from(pcm.subarray(offset, offset + size))); this.bytes += size; offset += size;
      if (this.bytes === this.chunkBytes) this.flush();
      if (this.overloaded) { this.rejectedBytes += pcm.length - offset; break; }
    }
    if (this.bytes) this.quietTimer = setTimeout(() => this.flush(), this.quietMs);
  }
  flush() {
    clearTimeout(this.quietTimer);
    if (!this.bytes) return;
    if (this.jobs.length >= this.maxJobs || this.sealed || this.noPump) {
      this.rejectedBytes += this.bytes; this.bytes = 0; this.parts = []; this.overloaded = true;
      this.fault('UTTERANCE_QUEUE_LIMIT'); return;
    }
    const pcm = Buffer.concat(this.parts, this.bytes);
    const job = { id: `${this.sessionId}-${String(this.jobs.length + 1).padStart(3, '0')}`,
      sequence: this.jobs.length + 1, startMs: this.startMs, bytes: this.bytes, pcm, status: 'queued' };
    this.parts = []; this.bytes = 0; this.jobs.push(job); void this.pump();
  }
  async pump() {
    if (this.active || this.sealed || this.noPump) return;
    const job = this.jobs.find(j => j.status === 'queued'); if (!job) return;
    this.active = job; job.status = 'running';
    const abort = new AbortController(); this.abort = abort;
    let timer;
    try {
      // Race is required even for a recognizer that ignores cancellation. Real
      // subprocesses receive abort; the parent watchdog kills remaining handles.
      const text = await Promise.race([
        this.recognize({ id: job.id, pcm: job.pcm, dir: this.dir, signal: abort.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Error('JOB_DEADLINE')); }, this.jobMs); }),
        new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(Error('JOB_ABORTED')), { once: true })),
      ]);
      if (!this.sealed) {
        if (typeof text !== 'string' || this.textBytes + Buffer.byteLength(text) > 256 * 1024) throw Error('TEXT_LIMIT');
        this.textBytes += Buffer.byteLength(text); job.text = text; job.status = 'recognized';
        if (!text.trim()) this.issues.add('EMPTY_RECOGNITION');
      }
    } catch {
      if (!this.sealed) {
        job.status = 'failed'; this.noPump = true;
        for (const pending of this.jobs) if (pending.status === 'queued') { pending.status = 'cancelled'; pending.pcm = undefined; }
        this.fault('LOCAL_JOB_FAILED_OR_TIMEOUT');
      }
    } finally {
      clearTimeout(timer); job.pcm = undefined; this.active = null; this.abort = null;
      if (!this.sealed) void this.pump();
    }
  }
  end() { if (this.inputEnded) return; this.inputEnded = true; this.flush(); }
  async drain(ms = 120000) {
    this.end(); const deadline = this.now() + ms;
    while (this.jobs.some(j => ['queued', 'running'].includes(j.status)) && this.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.min(10, Math.max(1, deadline - this.now()))));
    }
    if (this.jobs.some(j => ['queued', 'running'].includes(j.status))) {
      this.sealed = true; this.abort?.abort(); this.issues.add('RECOGNITION_DRAIN_TIMEOUT');
      for (const j of this.jobs) if (['queued', 'running'].includes(j.status)) { j.status = 'cancelled'; j.pcm = undefined; }
    }
    this.sealed = true;
    const accounted = this.jobs.reduce((n, j) => n + j.bytes, 0) + this.rejectedBytes;
    if (accounted !== this.receivedBytes) this.issues.add('PCM_ACCOUNTING_MISMATCH');
    return { receivedBytes: this.receivedBytes, accountedBytes: accounted, rejectedBytes: this.rejectedBytes,
      issues: [...this.issues], jobs: this.jobs.map(({ pcm, ...j }) => j) };
  }
}
module.exports = { UtteranceWorker, recognizeLocal, command, conversionArgs, recognitionArgs, assertLocalTools, FFMPEG, WHISPER, MODEL };
