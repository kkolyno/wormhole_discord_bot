'use strict';
const { TERMINAL, issue } = require('./store');
// Exactly one instance per writer-locked coordinator. No Promise.race releases
// this slot: abort is a request, and the recognizer must settle after native close.
class Scheduler {
  constructor({ store, recognize, now = Date.now, limits = {}, onChange = () => {}, onFault = () => {} }) {
    Object.assign(this, { store, recognize, now, onChange, onFault });
    this.jobMs = limits.jobMs ?? 60000; this.paused = true; this.active = null; this.timer = null;
    this.task = Promise.resolve(); this.lastSession = null;
  }
  start() { this.paused = false; this.kick(); }
  changed(sessionId) { try { this.onChange(sessionId); } catch { this.fault('SCHEDULER_CALLBACK_FAILED', sessionId); } }
  fault(code, sessionId) { try { this.onFault(issue(code), sessionId); } catch { /* no unhandled callback or private errors */ } }
  next() {
    const sessions = this.store.listSessions(); const starts = new Map(sessions.map(s => [s.id, s.startedAt]));
    const queued = this.store.listJobs().filter(j => j.state === 'queued').sort((a, b) =>
      (starts.get(a.sessionId) + a.startMs) - (starts.get(b.sessionId) + b.startMs) || a.sequence - b.sequence || a.id.localeCompare(b.id));
    // Round-robin sessions when possible, FIFO within a session. A continuing
    // new call cannot permanently starve an older draining call (or vice versa).
    return queued.find(j => j.sessionId !== this.lastSession) || queued[0];
  }
  kick() {
    if (this.paused || this.active) return;
    let job;
    try { job = this.next(); } catch { this.paused = true; this.fault('SCHEDULER_STORE_FAILED'); return; }
    if (!job) return;
    const run = { job, abort: new AbortController(), timedOut: false };
    this.active = run; this.lastSession = job.sessionId;
    this.task = this.run(run).catch(() => { this.paused = true; this.fault('SCHEDULER_STORE_FAILED', job.sessionId); })
      .finally(() => { clearTimeout(this.timer); this.timer = null; this.active = null; this.changed(job.sessionId); this.kick(); });
  }
  async run(run) {
    const { job, abort } = run;
    try {
      this.store.patchJob(job.id, { state: 'running' });
      const input = this.store.jobForRecognition(job.id);
      this.timer = setTimeout(() => { run.timedOut = true; abort.abort(); }, this.jobMs);
      const result = await this.recognize(input, { signal: abort.signal });
      const current = this.store.getJob(job.id);
      if (TERMINAL.has(current.state)) { this.store.cleanupPcm(job.id); return; }
      if (this.paused) { this.store.patchJob(job.id, { state: 'queued', issue: 'SHUTDOWN_CHECKPOINT' }); return; }
      if (abort.signal.aborted) throw Error('RECOGNITION_ABORTED');
      // Only the recognizer's explicit typed flag plus validated exact-zero
      // source is proof of no-speech. Empty model output alone is incomplete.
      const text = typeof result === 'string' ? result : result?.text;
      if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw Error('RECOGNITION_OUTPUT_INVALID');
      if (!text.trim() && !(result?.noSpeech === true && this.store.isExactZero(job.id))) {
        // An empty model response is not proof that nonzero/quiet PCM was
        // silence. Publisher reserves no_speech for exact-zero source samples.
        this.store.terminal(job.id, 'failed', { issue: 'EMPTY_RECOGNITION' });
        this.store.addIssue(job.sessionId, 'EMPTY_RECOGNITION'); this.fault('EMPTY_RECOGNITION', job.sessionId);
      } else this.store.terminal(job.id, text.trim() ? 'recognized' : 'no_speech', { text: text.trim() });
    } catch {
      const current = this.store.getJob(job.id);
      if (TERMINAL.has(current.state)) { this.store.cleanupPcm(job.id); return; }
      if (this.paused) { this.store.patchJob(job.id, { state: 'queued', issue: 'SHUTDOWN_CHECKPOINT' }); return; }
      const code = run.timedOut ? 'RECOGNITION_TIMEOUT' : 'RECOGNITION_FAILED';
      // If committing a result failed (including text/disk bounds), commit a
      // small terminal failure before attempting source cleanup.
      this.store.terminal(job.id, 'failed', { issue: code });
      this.store.addIssue(job.sessionId, code); this.fault(code, job.sessionId);
    }
  }
  cancelSession(sessionId, code = 'DRAIN_TIMEOUT') {
    for (const job of this.store.listJobs(sessionId)) {
      if (TERMINAL.has(job.state)) continue;
      const running = this.active?.job.id === job.id;
      this.store.terminal(job.id, 'cancelled', { issue: issue(code) }, { cleanup: !running });
      if (running) this.active.abort.abort();
    }
    this.changed(sessionId);
  }
  sessionTerminal(sessionId) { return this.store.listJobs(sessionId).every(j => TERMINAL.has(j.state)); }
  async shutdown() {
    this.paused = true; this.active?.abort.abort();
    // Await native closure, not minutes of queued recognition. Queued PCM is a
    // durable checkpoint for next startup. The feature owns the global deadline.
    await this.task;
  }
  status() { return { running: !!this.active, paused: this.paused, pending: this.store.status().pendingJobs }; }
}
module.exports = { Scheduler };
