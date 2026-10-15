'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { randomBytes } = require('node:crypto');
const { Capture } = require('../feasibility/capture');
const { UtteranceWorker } = require('./local-stt');
const { newSession, exclusive } = require('./storage');
const LIMITS = Object.freeze({ startupMs: 20000, armMs: 600000, voiceStartupMs: 15000,
  recordMs: 30000, drainMs: 120000, cleanupMs: 3000, postMs: 5000, signalDrainMs: 3000 });
function bounded(promise, ms) {
  let timer; return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('BOUND_EXCEEDED')), ms);
  })]).finally(() => clearTimeout(timer));
}
function safeText(text) { return String(text).replace(/@/g, '@\u200b').replace(/`/g, 'ˋ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''); }
function buttons(id, disabled = false) {
  return [{ type: 1, components: [['start', 'Start: I consent', 3], ['stop', 'Stop my test', 2], ['cancel', 'Cancel waiting test', 4]].map(([action, label, style]) =>
    ({ type: 2, custom_id: `${id}:${action}`, label, style, disabled })) }];
}
const NOTICE = '**NONCANONICAL — 30-second microphone test (not a meeting summary).**\n' +
  'Click **Start: I consent** only if you agree to local speech recognition of your microphone for up to 30 seconds. ' +
  'You must be in the configured target voice channel. Capture begins immediately after consent and voice readiness. ' +
  'ONLY the person clicking Start is subscribed/captured; other users are NOT recorded by this test. ' +
  'The recognized transcript and consenting account ID/duration will be posted to this Discord alerts channel at the end. ' +
  'Recognition runs locally (no external STT); Discord already transports voice and receives the posted transcript. ' +
  'Only that consenting account can Stop. Anyone can Cancel while waiting. Waiting expires in 10 minutes. ' +
  'Temporary test audio is deleted after finalization; shared microphones may include other people, so obtain their consent too. ' +
  'A crash/forced shutdown may leave no test-result notice; absence of a result never means success. Legacy bot functionality resumes after the test process exits.';
// This is deliberately a single-use microphone test, NOT the meeting coordinator.
class MicTest extends EventEmitter {
  constructor({ adapter, config, captureFactory = o => new Capture(o), workerFactory = o => new UtteranceWorker(o),
    now = () => performance.now(), limits = {} }) {
    super(); Object.assign(this, { adapter, config, captureFactory, workerFactory, now });
    this.limits = { ...LIMITS, ...limits }; this.id = randomBytes(8).toString('hex');
    this.state = 'initializing'; this.issues = new Set(); this.abort = new AbortController();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }
  async run() {
    this.dir = newSession(this.config.data);
    this.interaction = i => { void this.handle(i).catch(() => this.stop('interaction_error', 'INTERACTION_FAILED')); };
    this.fault = code => { void this.stop('transport_or_capture_failure', code); };
    this.adapter.on('interaction', this.interaction); this.adapter.on('fault', this.fault);
    this.startupTimer = setTimeout(() => void this.stop('startup_timeout', 'STARTUP_TIMEOUT'), this.limits.startupMs);
    try {
      await this.adapter.initialize(this.abort.signal);
      if (this.ending) return this.done;
      this.message = await this.adapter.notice({ content: NOTICE, components: buttons(this.id), allowedMentions: { parse: [] } });
      if (this.ending) return this.done;
      clearTimeout(this.startupTimer); this.state = 'waiting';
      this.armTimer = setTimeout(() => void this.stop('arming_expired'), this.limits.armMs);
    } catch { void this.stop('startup_failed', 'STARTUP_FAILED'); }
    return this.done;
  }
  matches(i) {
    return i.isButton?.() && i.guildId === this.config.guild && i.channelId === this.config.alerts &&
      i.message?.id === this.message?.id && i.message?.author?.id === this.config.application &&
      /^\d{17,20}$/.test(i.user?.id || '') && !i.user.bot &&
      [`${this.id}:start`, `${this.id}:stop`, `${this.id}:cancel`].includes(i.customId);
  }
  async handle(i) {
    if (this.ending || !this.matches(i)) return;
    const action = i.customId.split(':')[1];
    if (action === 'cancel' && this.state === 'waiting') {
      void this.stop('cancelled_before_recording');
      await this.adapter.ack(i, 'Waiting microphone test cancelled. No recording started.');
      return;
    }
    if (action === 'stop' && ['starting', 'recording'].includes(this.state) && i.user.id === this.owner) {
      // Stop immediately, not after an HTTP round trip.
      void this.stop('consenting_user_stopped');
      await this.adapter.ack(i, 'Your microphone test has stopped. Local work is draining before the test-result notice.'); return;
    }
    if (action !== 'start' || this.state !== 'waiting') {
      await this.adapter.ack(i, 'This test is not available to start/stop from this account right now.'); return;
    }
    if (!await this.adapter.inVoice(i.user.id)) {
      await this.adapter.ack(i, 'Start denied: join the configured target voice channel first.'); return;
    }
    if (this.ending || this.state !== 'waiting') return;
    this.owner = i.user.id; this.state = 'starting'; clearTimeout(this.armTimer);
    this.voiceTimer = setTimeout(() => void this.stop('voice_startup_timeout', 'VOICE_STARTUP_TIMEOUT'), this.limits.voiceStartupMs);
    await this.adapter.ack(i, 'Consent accepted. Your microphone test starts as soon as the voice connection is ready; use Stop my test to end early.');
    if (this.ending) return;
    if (!await this.adapter.inVoice(this.owner)) return void this.stop('consenting_user_left', 'CONSENTING_USER_LEFT');
    if (this.ending) return;
    const receiver = await this.adapter.join(this.owner, this.abort.signal);
    if (this.ending) return;
    clearTimeout(this.voiceTimer); this.readyAt = this.now(); this.state = 'recording';
    // Both event filtering AND subscribe filtering. No other ID can reach the real receiver.
    const speaking = new EventEmitter(); const forward = id => { if (id === this.owner) speaking.emit('start', id); };
    receiver.speaking.on('start', forward); this.removeForward = () => receiver.speaking.off('start', forward);
    const restricted = { speaking, subscribe: (id, options) => {
      if (id !== this.owner) throw Error('UNCONSENTED_SUBSCRIPTION'); return receiver.subscribe(id, options);
    } };
    this.worker = this.workerFactory({ dir: this.dir, sessionId: this.id,
      onFault: code => void this.stop('recognition_failure', code) });
    this.capture = this.captureFactory({ out: path.join(this.dir, 'capture'), receiver: restricted, manualEnd: 0,
      now: this.now,
      limits: { maxSpeakers: 1, maxDurationMs: Math.max(0, this.limits.recordMs - (this.now() - this.readyAt)), maxPcmTotal: 6 * 1024 * 1024,
        maxPcmPerSpeaker: 6 * 1024 * 1024, maxDisk: 16 * 1024 * 1024, maxPackets: 12000, drainMs: 1500 },
      onPcm: p => this.worker.accept(p), onFault: code => void this.stop('capture_failure', code) });
    // The owner's speaking.start may have occurred during the ready handshake.
    // Prime just their Manual stream now; do not wait for another speech burst.
    speaking.emit('start', this.owner);
    this.recordTimer = setTimeout(() => void this.stop('duration_limit'), Math.max(0, this.limits.recordMs - (this.now() - this.readyAt)));
    this.emit('recording');
  }
  stop(reason, issue, shutdown = false) {
    if (issue) this.issues.add(issue);
    if (shutdown) { this.shutting = true; this.worker?.abort?.abort(); }
    if (this.ending) return this.done;
    this.ending = true; this.state = 'draining'; this.reason = reason; this.stoppedAt = this.now(); this.abort.abort();
    for (const name of ['startupTimer', 'armTimer', 'voiceTimer', 'recordTimer']) clearTimeout(this[name]);
    void this.finish().catch(() => { this.issues.add('FINALIZATION_FAILED'); }).finally(() => this.cleanup()).catch(() => {
      this.issues.add('CLEANUP_FAILED'); this.resolveDone({ issues: [...this.issues], outcome: this.outcome });
    });
    return this.done;
  }
  async finish() {
    const drainStart = this.now(); let manifest;
    if (this.capture) {
      try { manifest = await bounded(this.capture.stop(this.reason), 2000); }
      catch { this.issues.add('CAPTURE_DRAIN_FAILED'); }
    }
    this.removeForward?.();
    try { this.adapter.disconnect(); } catch { this.issues.add('VOICE_DESTROY_FAILED'); }
    if (manifest) for (const code of manifest.issues) this.issues.add(code);
    if (this.capture && !manifest) this.issues.add('CAPTURE_ACCOUNTING_UNKNOWN');
    let work;
    if (this.worker) {
      const budget = this.shutting ? this.limits.signalDrainMs : this.limits.drainMs;
      work = await this.worker.drain(Math.max(0, budget - (this.now() - drainStart)));
      for (const code of work.issues) this.issues.add(code);
      if (manifest && manifest.pcmBytes !== work.receivedBytes) this.issues.add('CAPTURE_WORKER_BYTE_MISMATCH');
    }
    const jobs = work?.jobs || [];
    const transcript = jobs.map(j => j.status === 'recognized' ?
      `[${(j.startMs / 1000).toFixed(2)}s; ${j.id}] ${j.text || '[no recognized text]'}` :
      `[${(j.startMs / 1000).toFixed(2)}s; ${j.id}] [INCOMPLETE: ${j.status}; ${j.bytes} PCM bytes]`).join('\n');
    if (this.owner && !jobs.some(j => j.status === 'recognized' && j.text?.trim())) this.issues.add('NO_RECOGNIZED_SPEECH');
    if (this.shutting) this.issues.add('INTERRUPTED');
    const incomplete = this.issues.size > 0;
    const durationMs = this.readyAt === undefined ? 0 : Math.max(0, this.stoppedAt - this.readyAt);
    const header = '**NONCANONICAL — 30-second microphone test RESULT (not a meeting summary).**\n' +
      `Outcome: ${incomplete ? 'INCOMPLETE' : this.owner ? 'observed audio processed' : 'not recorded'}; reason: ${this.reason}.\n` +
      `Consenting Discord account ID (no ping): ${this.owner || 'none'}; recording window: ${(durationMs / 1000).toFixed(2)} seconds.\n` +
      `Accepted PCM: ${work?.receivedBytes || 0} bytes; accounted: ${work?.accountedBytes || 0}; unqueued: ${work?.rejectedBytes || 0}.\n` +
      `Issues: ${[...this.issues].sort().join(', ') || 'none locally detected'}.\n` +
      'Local English recognition. Simple packet-gap/8-second segmentation may split words; no silence reconstruction. ' +
      'Upstream packet loss/DAVE discards are unknown; this is NOT a lossless-capture guarantee.\n';
    const text = safeText(transcript || '[No transcript. No blank or partial canonical meeting summary was published.]');
    const payload = { content: header, allowedMentions: { parse: [] } };
    if (header.length + text.length < 1900) payload.content += `\n${text}`;
    else { payload.content += '\nRecognized transcript/test gaps attached as one text file.';
      payload.files = [{ attachment: Buffer.from(text), name: 'microphone-test-transcript.txt' }]; }
    // No publication before capture EOF + every accepted job terminal/accounted.
    if (!this.shutting && this.message) {
      try { await bounded(this.adapter.result(payload), this.limits.postMs); }
      catch { this.issues.add('RESULT_PUBLICATION_FAILED_OR_UNKNOWN'); }
    }
    this.outcome = { schema: 1, outcome: this.issues.size ? 'incomplete' : this.owner ? 'observed_audio_processed' : 'not_recorded',
      reason: this.reason, durationMs, pcmBytes: work?.receivedBytes || 0, jobs: jobs.length,
      issues: [...this.issues].sort(), finishedAt: new Date().toISOString() };
  }
  async cleanup() {
    this.removeForward?.(); this.adapter.off('interaction', this.interaction); this.adapter.off('fault', this.fault);
    try { await bounded(this.adapter.disableNotice(this.message, buttons(this.id, true)), this.limits.postMs); } catch { /* parent watchdog covers stuck transport */ }
    try { await bounded(this.adapter.destroy(), this.limits.cleanupMs); } catch { this.issues.add('CLIENT_CLEANUP_FAILED_OR_TIMEOUT'); }
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { this.issues.add('AUDIO_CLEANUP_FAILED'); }
    try {
      const outcome = this.outcome || { schema: 1, outcome: 'incomplete', reason: 'finalization_failed' };
      outcome.issues = [...this.issues].sort(); if (this.issues.size) outcome.outcome = 'incomplete';
      exclusive(path.join(this.config.data, 'outcome.json'), JSON.stringify(outcome) + '\n');
    } catch { this.issues.add('OUTCOME_WRITE_FAILED'); }
    this.state = 'closed'; this.resolveDone({ issues: [...this.issues], outcome: this.outcome });
  }
}
module.exports = { MicTest, LIMITS, NOTICE, buttons, safeText, bounded };
