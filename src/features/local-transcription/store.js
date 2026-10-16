'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT = /^\d{17,20}$/;
const TERMINAL = new Set(['recognized', 'no_speech', 'failed', 'cancelled']);
const STATES = new Set(['recording', 'queued', 'running', ...TERMINAL]);
const DEFAULT_LIMITS = Object.freeze({ maxSpoolBytes: 256 * 1024 * 1024, maxPendingJobs: 128,
  maxUtteranceBytes: 8 * 192000, maxSessionMs: 4 * 60 * 60 * 1000, maxConsenting: 8,
  maxParticipants: 32, maxTranscriptBytes: 4 * 1024 * 1024, maxRetainedSessions: 64,
  retentionMs: 24 * 60 * 60 * 1000, maxJobRecords: 32768, maxJsonBytes: 128 * 1024 });
function fail(code) { const e = Error(code); e.safeCode = code; throw e; }
function clone(value) { return structuredClone(value); }
function safeId(id) { if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_RECORD_ID'); return id; }
function account(id) { if (typeof id !== 'string' || !ACCOUNT.test(id)) fail('INVALID_ACCOUNT_ID'); return id; }
function issue(code) { return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'CORE_FAILURE'; }
function limitsWith(overrides) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const key of Object.keys(DEFAULT_LIMITS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('INVALID_LIMIT');
  if (limits.maxUtteranceBytes % 4) fail('INVALID_LIMIT');
  return limits;
}
// All mutating methods are synchronous. One external OS writer lock must cover
// this Store's entire lifetime (including recovery and cleanup).
class Store {
  constructor({ root, limits = {} }) {
    this.root = path.resolve(root); this.limits = limitsWith(limits);
    this.sessions = new Map(); this.jobs = new Map(); this.pcmSizes = new Map(); this.spoolBytes = 0;
    this.textBytes = 0; this.sequence = new Map(); this.storageFault = false;
    this.control = { holdUntilEmpty: false };
    // Refuse even an ancestor symlink; never chmod an existing untrusted path.
    for (let p = path.dirname(this.root);; p = path.dirname(p)) {
      if (fs.lstatSync(p).isSymbolicLink()) fail('PRIVATE_ROOT_REQUIRED');
      if (p === path.dirname(p)) break;
    }
    try { fs.mkdirSync(this.root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('PRIVATE_ROOT_REQUIRED');
    this.load();
  }
  file(kind, id) { if (!['s', 'j', 'p'].includes(kind)) fail('INVALID_RECORD_KIND');
    return path.join(this.root, `${kind}-${safeId(id)}.${kind === 'p' ? 'pcm' : 'json'}`); }
  syncDir() { const fd = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  checkedFd(file, flags = fs.constants.O_RDONLY) {
    const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW);
    try { const s = fs.fstatSync(fd);
      if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1) fail('PRIVATE_FILE_REQUIRED');
      return fd;
    } catch (e) { fs.closeSync(fd); throw e; }
  }
  readJson(file) { const fd = this.checkedFd(file);
    try { if (fs.fstatSync(fd).size > this.limits.maxJsonBytes) fail('METADATA_LIMIT');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch { fail('METADATA_CORRUPT'); } finally { fs.closeSync(fd); }
  }
  atomic(kind, id, value) { return this.atomicFile(this.file(kind, id), value); }
  atomicFile(target, value) {
    const data = Buffer.from(JSON.stringify(value) + '\n');
    if (data.length > this.limits.maxJsonBytes) fail('METADATA_LIMIT');
    const temp = path.join(this.root, `.tmp-${randomUUID()}`);
    let fd;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, target); this.syncDir();
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  getControl() { return clone(this.control); }
  setHoldUntilEmpty(holdUntilEmpty) {
    if (typeof holdUntilEmpty !== 'boolean') fail('CONTROL_CORRUPT');
    const control = { ...this.control, holdUntilEmpty };
    this.atomicFile(path.join(this.root, '.control.json'), control);
    this.control = control; return this.getControl();
  }
  getAutomaticOptOuts() { return [...(this.control.automaticOptOuts || [])]; }
  setAutomaticOptOut(userId, paused) {
    account(userId);
    if (typeof paused !== 'boolean') fail('CONTROL_CORRUPT');
    const ids = new Set(this.getAutomaticOptOuts());
    if (paused) ids.add(userId); else ids.delete(userId);
    if (ids.size > 32) fail('AUTOMATIC_OPTOUT_LIMIT');
    const control = { ...this.control };
    if (ids.size) control.automaticOptOuts = [...ids]; else delete control.automaticOptOuts;
    this.atomicFile(path.join(this.root, '.control.json'), control);
    this.control = control; return this.getAutomaticOptOuts();
  }
  clearAutomaticOptOuts() {
    if (!this.getAutomaticOptOuts().length) return;
    const control = { ...this.control }; delete control.automaticOptOuts;
    this.atomicFile(path.join(this.root, '.control.json'), control);
    this.control = control;
  }
  validateSession(s) {
    safeId(s.id);
    if ((s.consentMode !== undefined && !['manual', 'channel'].includes(s.consentMode)) ||
        s.schema !== 1 || !['active', 'draining', 'ready', 'published'].includes(s.phase) || !Number.isFinite(s.startedAt) ||
        !Number.isFinite(s.lastSeenAt) || !(s.endedAt === null || Number.isFinite(s.endedAt)) ||
        !s.participants || Array.isArray(s.participants) || Object.keys(s.participants).length > this.limits.maxParticipants ||
        !Array.isArray(s.issues) || s.issues.length > 64 || s.issues.some(c => issue(c) !== c) ||
        !['pending', 'sending', 'sent', 'uncertain', 'closed'].includes(s.notice?.state) ||
        (s.notice.id !== undefined && typeof s.notice.id !== 'string') ||
        !['pending', 'sending', 'sent', 'uncertain', 'held'].includes(s.publication?.state) ||
        !(s.stopReason === null || typeof s.stopReason === 'string')) fail('SESSION_CORRUPT');
    for (const [id, p] of Object.entries(s.participants)) {
      account(id);
      if (p.id !== id || typeof p.name !== 'string' || p.name.length > 128 || !Number.isFinite(p.durationMs) || p.durationMs < 0 ||
          !(p.joinedAt === null || Number.isFinite(p.joinedAt)) || typeof p.consented !== 'boolean' || typeof p.everConsented !== 'boolean') fail('SESSION_CORRUPT');
    }
    return s;
  }
  validateJob(j) {
    safeId(j.id); safeId(j.sessionId); account(j.userId);
    const fields = new Set(['schema', 'id', 'sessionId', 'userId', 'sequence', 'startMs', 'bytes', 'state', 'text', 'issue']);
    if (Object.keys(j).some(key => !fields.has(key)) || (j.issue !== undefined && issue(j.issue) !== j.issue)) fail('JOB_CORRUPT');
    if (j.schema !== 1 || !STATES.has(j.state) || !Number.isSafeInteger(j.sequence) || j.sequence < 1 ||
        !Number.isFinite(j.startMs) || j.startMs < 0 || !Number.isSafeInteger(j.bytes) || j.bytes < 0 ||
        j.bytes > this.limits.maxUtteranceBytes || j.bytes % 4 ||
        (j.text !== undefined && (typeof j.text !== 'string' || Buffer.byteLength(j.text) > 65536))) fail('JOB_CORRUPT');
    return j;
  }
  load() {
    const names = [], directory = fs.opendirSync(this.root);
    try {
      for (let entry; (entry = directory.readSync());) {
        if (names.length >= this.limits.maxJobRecords * 3 + this.limits.maxRetainedSessions + 32) fail('RECORD_LIMIT');
        names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    for (const name of names) {
      if (name === '.control.json') {
        const control = this.readJson(path.join(this.root, name));
        if (!control || Array.isArray(control) || typeof control.holdUntilEmpty !== 'boolean' ||
            Object.keys(control).some(key => !['holdUntilEmpty', 'automaticOptOuts'].includes(key)) ||
            (Object.hasOwn(control, 'automaticOptOuts') && (!Array.isArray(control.automaticOptOuts) ||
              control.automaticOptOuts.length > 32 || new Set(control.automaticOptOuts).size !== control.automaticOptOuts.length ||
              control.automaticOptOuts.some(id => typeof id !== 'string' || !ACCOUNT.test(id))))) fail('CONTROL_CORRUPT');
        this.control = clone(control); continue;
      }
      if (name === '.writer.lock') {
        const fd = this.checkedFd(path.join(this.root, name));
        try { if (fs.fstatSync(fd).size > 1024) fail('LOCK_FILE_INVALID'); } finally { fs.closeSync(fd); }
        continue; // Owned by integration's kernel flock; never unlink its inode.
      }
      if (/^\.recognize-[A-Za-z0-9]{6}$/.test(name)) {
        // Sole native slot's interrupted conversion output, never source PCM.
        // Validate the exact namespace rather than recursively deleting paths.
        const dir = path.join(this.root, name), stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('CONVERSION_DIR_INVALID');
        const entries = fs.readdirSync(dir);
        if (entries.length > 1 || entries.some(entry => entry !== 'audio.16k.wav')) fail('CONVERSION_DIR_INVALID');
        if (entries.length) {
          const file = path.join(dir, entries[0]), fd = this.checkedFd(file);
          try { if (fs.fstatSync(fd).size > 524288) fail('CONVERSION_FILE_INVALID'); } finally { fs.closeSync(fd); }
          fs.unlinkSync(file);
        }
        fs.rmdirSync(dir); continue;
      }
      if (/^\.tmp-[0-9a-f-]{36}$/.test(name)) { // Uncommitted atomic JSON; never interpreted as a record.
        const fd = this.checkedFd(path.join(this.root, name)); fs.closeSync(fd); fs.unlinkSync(path.join(this.root, name)); continue;
      }
      const match = /^([sjp])-([0-9a-f-]{36})\.(json|pcm)$/.exec(name);
      if (!match || (match[1] === 'p') !== (match[3] === 'pcm')) fail('UNEXPECTED_STORE_FILE');
      const [, kind, id] = match; safeId(id);
      if (kind === 'p') { const fd = this.checkedFd(this.file('p', id)); const size = fs.fstatSync(fd).size; fs.closeSync(fd);
        if (size > this.limits.maxUtteranceBytes) fail('PCM_LIMIT'); this.pcmSizes.set(id, size); this.spoolBytes += size;
        if (this.spoolBytes > this.limits.maxSpoolBytes) fail('SPOOL_LIMIT');
      } else {
        if (kind === 's' && this.sessions.size >= this.limits.maxRetainedSessions || kind === 'j' && this.jobs.size >= this.limits.maxJobRecords) fail('RECORD_LIMIT');
        const record = this.readJson(this.file(kind, id)); if (record.id !== id) fail('RECORD_ID_MISMATCH');
        if (kind === 's') this.sessions.set(id, this.validateSession(record));
        else {
          this.jobs.set(id, this.validateJob(record)); this.textBytes += Buffer.byteLength(record.text || '');
          if (this.textBytes > this.limits.maxTranscriptBytes) fail('TRANSCRIPT_LIMIT');
        }
      }
    }
    if (this.sessions.size > this.limits.maxRetainedSessions || this.jobs.size > this.limits.maxJobRecords ||
        this.textBytes > this.limits.maxTranscriptBytes || this.spoolBytes > this.limits.maxSpoolBytes) fail('STORE_LIMIT');
    for (const j of this.jobs.values()) {
      if (!this.sessions.has(j.sessionId)) fail('ORPHAN_JOB');
      this.sequence.set(j.sessionId, Math.max(this.sequence.get(j.sessionId) || 0, j.sequence));
    }
    for (const id of this.pcmSizes.keys()) if (!this.jobs.has(id)) fail('ORPHAN_PCM');
    this.syncDir();
  }
  getSession(id) { const s = this.sessions.get(safeId(id)); return s ? clone(s) : null; }
  listSessions() { return [...this.sessions.values()].map(clone).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)); }
  patchSession(id, patch) {
    const old = this.sessions.get(safeId(id)); if (!old) fail('SESSION_NOT_FOUND');
    if (patch.id !== undefined && patch.id !== id) fail('IMMUTABLE_ID');
    const s = this.validateSession({ ...old, ...clone(patch), id, schema: 1 });
    this.atomic('s', id, s); this.sessions.set(id, s); return clone(s);
  }
  createSession({ id = randomUUID(), startedAt, participants = {}, consentMode = 'manual' }) {
    safeId(id); if (this.sessions.has(id)) fail('SESSION_EXISTS');
    if (this.sessions.size >= this.limits.maxRetainedSessions) fail('SESSION_LIMIT');
    const s = this.validateSession({ schema: 1, id, startedAt, consentMode, endedAt: null, lastSeenAt: startedAt, phase: 'active',
      participants: clone(participants), issues: [], stopReason: null, notice: { state: 'pending' }, publication: { state: 'pending' } });
    this.atomic('s', id, s); this.sessions.set(id, s); return clone(s);
  }
  addIssue(id, code) { const s = this.getSession(id); const issues = [...new Set([...s.issues, issue(code)])].slice(0, 64);
    return this.patchSession(id, { issues }); }
  listJobs(sessionId) {
    if (sessionId !== undefined) safeId(sessionId);
    return [...this.jobs.values()].filter(j => sessionId === undefined || j.sessionId === sessionId)
      .sort((a, b) => a.startMs - b.startMs || a.sequence - b.sequence).map(clone);
  }
  getJob(id) { const j = this.jobs.get(safeId(id)); return j ? clone(j) : null; }
  pendingCount() { return [...this.jobs.values()].filter(j => !TERMINAL.has(j.state)).length; }
  createJob({ sessionId, userId, startMs }) {
    if (this.storageFault) fail('STORAGE_QUARANTINED');
    const s = this.getSession(sessionId); account(userId);
    if (!s || !['active', 'draining'].includes(s.phase) || !s.participants[userId]) fail('JOB_SESSION_INVALID');
    if (this.pendingCount() >= this.limits.maxPendingJobs) fail('QUEUE_LIMIT');
    if (this.jobs.size >= this.limits.maxJobRecords) fail('JOB_RECORD_LIMIT');
    const id = randomUUID(), sequence = (this.sequence.get(sessionId) || 0) + 1;
    const j = this.validateJob({ schema: 1, id, sessionId, userId, sequence, startMs, bytes: 0, state: 'recording' });
    this.atomic('j', id, j); this.jobs.set(id, j); this.sequence.set(sessionId, sequence);
    // Durable job intent ALWAYS precedes PCM creation.
    const fd = fs.openSync(this.file('p', id), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.syncDir(); this.pcmSizes.set(id, 0); return clone(j);
  }
  appendPcm(id, pcm) {
    if (this.storageFault) fail('STORAGE_QUARANTINED');
    const j = this.jobs.get(safeId(id));
    if (!j || j.state !== 'recording' || !Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 4) fail('PCM_INVALID');
    if (j.bytes + pcm.length > this.limits.maxUtteranceBytes) fail('UTTERANCE_LIMIT');
    if (this.spoolBytes + pcm.length > this.limits.maxSpoolBytes) fail('SPOOL_LIMIT');
    const fd = this.checkedFd(this.file('p', id), fs.constants.O_WRONLY | fs.constants.O_APPEND);
    const previous = this.pcmSizes.get(id) || 0;
    try {
      if (fs.fstatSync(fd).size !== previous) fail('PCM_SIZE_CHANGED');
      fs.writeFileSync(fd, pcm); fs.fsyncSync(fd);
      j.bytes += pcm.length; this.pcmSizes.set(id, previous + pcm.length); this.spoolBytes += pcm.length;
      return pcm.length;
    } catch {
      // Failed writes were never acknowledged; best-effort rollback. If rollback
      // fails, recovery uses the actual file, and the session is incomplete.
      try { fs.ftruncateSync(fd, previous); fs.fsyncSync(fd); }
      catch {
        this.storageFault = true;
        // Count uncertain physical disk use, but never acknowledge these bytes.
        // A sealed size mismatch will fail explicitly; restart revalidates it.
        try { const actual = fs.fstatSync(fd).size; this.spoolBytes += actual - previous; this.pcmSizes.set(id, actual); } catch { /* fail closed */ }
      }
      fail('PCM_WRITE_FAILED');
    } finally { fs.closeSync(fd); }
  }
  patchJob(id, patch) {
    const old = this.jobs.get(safeId(id)); if (!old) fail('JOB_NOT_FOUND');
    if (patch.id !== undefined && patch.id !== id || patch.sessionId !== undefined && patch.sessionId !== old.sessionId) fail('IMMUTABLE_ID');
    const j = this.validateJob({ ...old, ...clone(patch), id });
    const bytes = this.textBytes - Buffer.byteLength(old.text || '') + Buffer.byteLength(j.text || '');
    if (bytes > this.limits.maxTranscriptBytes) fail('TRANSCRIPT_LIMIT');
    this.atomic('j', id, j); this.jobs.set(id, j); this.textBytes = bytes; return clone(j);
  }
  queueJob(id) { const j = this.getJob(id); if (j.state === 'recording') return this.patchJob(id, { state: 'queued' }); return j; }
  jobForRecognition(id) { const j = this.getJob(id); if (!j) fail('JOB_NOT_FOUND');
    const fd = this.checkedFd(this.file('p', id)); try { if (fs.fstatSync(fd).size !== j.bytes) fail('PCM_SIZE_CHANGED'); }
    finally { fs.closeSync(fd); } return { ...j, path: this.file('p', id) }; }
  isExactZero(id) {
    const j = this.getJob(id); if (!j) fail('JOB_NOT_FOUND');
    const fd = this.checkedFd(this.file('p', id));
    try {
      if (fs.fstatSync(fd).size !== j.bytes) fail('PCM_SIZE_CHANGED');
      const buffer = Buffer.alloc(65536); let offset = 0;
      while (offset < j.bytes) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, j.bytes - offset), offset);
        if (!read) fail('PCM_SIZE_CHANGED');
        for (let i = 0; i < read; i++) if (buffer[i] !== 0) return false;
        offset += read;
      }
      return true;
    } finally { fs.closeSync(fd); }
  }
  terminal(id, state, extra = {}, { cleanup = true } = {}) {
    if (!TERMINAL.has(state)) fail('TERMINAL_STATE_REQUIRED');
    const j = this.getJob(id); if (!j) fail('JOB_NOT_FOUND');
    if (!TERMINAL.has(j.state)) this.patchJob(id, { ...extra, state });
    // Never delete source before its terminal result has committed durably.
    if (cleanup) this.cleanupPcm(id); return this.getJob(id);
  }
  cleanupPcm(id) {
    const file = this.file('p', id); const j = this.jobs.get(id);
    if (!j || !TERMINAL.has(j.state)) fail('TERMINAL_STATE_REQUIRED');
    try { const fd = this.checkedFd(file); fs.closeSync(fd); fs.unlinkSync(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.syncDir();
    this.spoolBytes -= this.pcmSizes.get(id) || 0; this.pcmSizes.delete(id);
  }
  recover({ now } = {}) {
    // Upgrade legacy session-only holds before any retention deletion. Supplying
    // now enables startup-only expiry of abandoned active/draining records; the
    // caller must hold the writer lock and must not have started a scheduler.
    if (this.listSessions().some(s => s.holdUntilEmpty) && !this.control.holdUntilEmpty) this.setHoldUntilEmpty(true);
    if (now !== undefined) this.prune(now, { recovery: true });
    const interrupted = new Set();
    for (const j of this.listJobs()) {
      if (TERMINAL.has(j.state)) { this.cleanupPcm(j.id); continue; }
      interrupted.add(j.sessionId);
      const size = this.pcmSizes.get(j.id);
      if (size === undefined || size % 4 || (j.state !== 'recording' && size !== j.bytes)) {
        this.terminal(j.id, 'failed', { issue: size === undefined ? 'PCM_MISSING' : 'PCM_CORRUPT' });
        this.addIssue(j.sessionId, size === undefined ? 'PCM_MISSING' : 'PCM_CORRUPT');
      } else {
        this.patchJob(j.id, { bytes: size, state: 'queued', issue: 'RESTART_INTERRUPTED' });
        this.addIssue(j.sessionId, 'RESTART_INTERRUPTED');
      }
    }
    return { interruptedSessionIds: [...interrupted] };
  }
  prune(now, { recovery = false } = {}) {
    if (!Number.isFinite(now)) fail('INVALID_PRUNE_TIME');
    // Ordinary retention never touches live capture/native input. Recovery is
    // startup-only, before recognition/publication, and can expire abandoned PCM.
    for (const s of this.listSessions()) {
      if ((!recovery && !['ready', 'published'].includes(s.phase)) ||
          now - (s.endedAt ?? s.lastSeenAt) < this.limits.retentionMs) continue;
      const jobs = this.listJobs(s.id);
      if (!recovery && jobs.some(j => !TERMINAL.has(j.state) || this.pcmSizes.has(j.id))) continue;
      if (s.holdUntilEmpty && !this.control.holdUntilEmpty) this.setHoldUntilEmpty(true);
      // PCM -> job -> session, with directory barriers between dependency
      // deletions: a crash cannot leave orphan PCM or an orphan job on restart.
      for (const j of jobs) {
        this.unlinkPrivate(this.file('p', j.id)); this.syncDir();
        this.spoolBytes -= this.pcmSizes.get(j.id) || 0; this.pcmSizes.delete(j.id);
        this.unlinkPrivate(this.file('j', j.id)); this.syncDir();
        this.jobs.delete(j.id); this.textBytes -= Buffer.byteLength(j.text || '');
      }
      this.unlinkPrivate(this.file('s', s.id)); this.syncDir();
      this.sessions.delete(s.id); this.sequence.delete(s.id);
    }
  }
  unlinkPrivate(file) {
    try { const fd = this.checkedFd(file); fs.closeSync(fd); fs.unlinkSync(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  status() { return { sessions: this.sessions.size, jobs: this.jobs.size, pendingJobs: this.pendingCount(),
    spoolBytes: this.spoolBytes, transcriptBytes: this.textBytes, storageFault: this.storageFault }; }
}
module.exports = { Store, DEFAULT_LIMITS, TERMINAL, account, issue, fail };
