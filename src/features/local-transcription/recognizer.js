'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const FFMPEG = '/usr/bin/ffmpeg';
const WHISPER = '/usr/local/bin/whisper-cli';
const MODEL = '/opt/models/ggml-base.en.bin';
const MAX_PCM = 8 * 192000;
const MAX_WAV = 524288;
const MAX_TEXT = 65536;
const safeError = code => Object.assign(Error(code), { code });
function conversionArgs(input, output) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2',
    '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-t', '8', '-fs', String(MAX_WAV), '-f', 'wav', '-y', output];
}
function recognitionArgs(input) {
  return ['-m', MODEL, '-f', input, '-l', 'en', '-t', '4', '--no-gpu', '-nt', '-np'];
}
// Deadline/abort initiates termination, but NEVER releases the scheduler's slot
// on a timer or 'error': only actual child close proves no process overlaps.
function command(file, args, signal, { maxOutput = 0, timeoutMs = 60000, killGraceMs = 500, passFd } = {}, spawnImpl = spawn) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000 ||
      !Number.isInteger(killGraceMs) || killGraceMs <= 0 || killGraceMs > 1000 ||
      !Number.isInteger(maxOutput) || maxOutput < 0 || maxOutput > MAX_TEXT ||
      (passFd !== undefined && (!Number.isInteger(passFd) || passFd < 0))) return Promise.reject(safeError('LOCAL_LIMIT_INVALID'));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(safeError('LOCAL_JOB_ABORTED'));
    let child, deadline, killer, failure, bytes = 0, settled = false;
    const chunks = [];
    const terminate = code => {
      if (failure) return;
      failure = code;
      try { child.kill('SIGTERM'); } catch { /* close still owns completion */ }
      killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* wait close */ } }, killGraceMs);
    };
    const abort = () => terminate('LOCAL_JOB_ABORTED');
    const finish = code => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(killer); signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(safeError(failure || 'LOCAL_COMMAND_FAILED'));
      else resolve(Buffer.concat(chunks, bytes));
    };
    try {
      const stdio = ['ignore', maxOutput ? 'pipe' : 'ignore', 'ignore'];
      if (passFd !== undefined) stdio.push(passFd);
      child = spawnImpl(file, args, { stdio, shell: false,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: '/usr/local/lib' } });
    } catch { finish(1); return; }
    child.once('error', () => { terminate('LOCAL_COMMAND_FAILED'); });
    child.once('close', finish);
    if (maxOutput) child.stdout.on('data', data => {
      if (failure) return;
      if (!Buffer.isBuffer(data) || bytes + data.length > maxOutput) { terminate('LOCAL_OUTPUT_LIMIT'); return; }
      chunks.push(Buffer.from(data)); bytes += data.length;
    });
    deadline = setTimeout(() => terminate('LOCAL_COMMAND_TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function validatePcm(job, io) {
  if (!job || typeof job.path !== 'string' || !path.isAbsolute(job.path) || path.resolve(job.path) !== job.path ||
      job.path.includes('\0') || !Number.isSafeInteger(job.bytes) || job.bytes < 0 || job.bytes > MAX_PCM || job.bytes % 4) throw safeError('LOCAL_PCM_INVALID');
  const parent = io.lstatSync(path.dirname(job.path));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid() || io.realpathSync(job.path) !== job.path) throw safeError('LOCAL_PCM_INVALID');
  const fd = io.openSync(job.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size !== job.bytes) throw safeError('LOCAL_PCM_INVALID');
    const buffer = Buffer.alloc(65536); let offset = 0, nonzero = false;
    while (offset < stat.size) {
      const read = io.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!read) throw safeError('LOCAL_PCM_INVALID');
      // Only exact zero is safely skipped. Quiet/low-amplitude speech is kept.
      for (let i = 0; i < read; i++) if (buffer[i] !== 0) { nonzero = true; break; }
      offset += read;
    }
    return nonzero;
  } finally { io.closeSync(fd); }
}
function createRecognizer({ io = fs, run = command, conversionMs = 10000, recognitionMs = 60000, tempRoot = os.tmpdir() } = {}) {
  if (![conversionMs, recognitionMs].every(ms => Number.isInteger(ms) && ms > 0 && ms <= 60000)) throw safeError('LOCAL_LIMIT_INVALID');
  return async function recognize(job, { signal } = {}) {
    let dir, fd;
    try {
      if (signal?.aborted) throw safeError('LOCAL_JOB_ABORTED');
      // Only verified exact-zero PCM carries noSpeech; an empty model result
      // for nonzero audio remains a string and does not prove silence.
      if (!validatePcm(job, io)) return { text: '', noSpeech: true };
      // Never create scratch entries in Store.root: its recovery intentionally
      // refuses unknown files. Unlink the private scratch inode before any await
      // so a native crash/parent kill cannot leave a converted speech file behind.
      dir = io.mkdtempSync(path.join(tempRoot, 'local-recognize-'));
      io.chmodSync(dir, 0o700);
      const named = path.join(dir, 'audio.16k.wav');
      fd = io.openSync(named, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      io.unlinkSync(named); io.rmdirSync(dir); dir = undefined;
      // Production is Linux. Each child inherits this job's unique anonymous
      // regular file as fd 3; opening /proc/self/fd/3 is seekable (unlike a pipe).
      const converted = '/proc/self/fd/3';
      await run(FFMPEG, conversionArgs(job.path, converted), signal, { timeoutMs: conversionMs, passFd: fd });
      const output = io.fstatSync(fd);
      if (!output.isFile() || output.size === 0 || output.size > MAX_WAV || (output.mode & 0o777) !== 0o600) throw safeError('LOCAL_CONVERSION_INVALID');
      if (signal?.aborted) throw safeError('LOCAL_JOB_ABORTED');
      const text = await run(WHISPER, recognitionArgs(converted), signal, { timeoutMs: recognitionMs, maxOutput: MAX_TEXT, passFd: fd });
      if (!Buffer.isBuffer(text) || text.length > MAX_TEXT) throw safeError('LOCAL_OUTPUT_LIMIT');
      if (signal?.aborted) throw safeError('LOCAL_JOB_ABORTED');
      return text.toString('utf8').trim();
    } catch (error) {
      const allowed = ['LOCAL_JOB_ABORTED', 'LOCAL_COMMAND_FAILED', 'LOCAL_COMMAND_TIMEOUT', 'LOCAL_OUTPUT_LIMIT', 'LOCAL_PCM_INVALID', 'LOCAL_CONVERSION_INVALID'];
      throw safeError(allowed.includes(error?.code) ? error.code : 'LOCAL_RECOGNITION_FAILED');
    } finally {
      // The store owns raw job.path and terminal-result-before-delete ordering.
      let cleanupFailed = false;
      if (fd !== undefined) { try { io.closeSync(fd); } catch { cleanupFailed = true; } }
      if (dir) {
        try {
          try { io.unlinkSync(path.join(dir, 'audio.16k.wav')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          io.rmdirSync(dir);
        } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw safeError('LOCAL_CONVERSION_CLEANUP_FAILED');
    }
  };
}
const recognize = createRecognizer();
module.exports = { recognize, createRecognizer, command, conversionArgs, recognitionArgs, FFMPEG, WHISPER, MODEL };
