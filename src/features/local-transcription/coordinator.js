'use strict';
const { Scheduler } = require('./scheduler');
const { account, issue, fail } = require('./store');
const DEFAULTS = Object.freeze({ emptyGraceMs: 90000, quietMs: 850, maxDrainMs: 300000,
  maxSessionMs: 4 * 60 * 60 * 1000, maxConsenting: 8, maxParticipants: 32,
  maxPacketBytes: 192000, audioOpenMs: 20000, audioCloseMs: 5000 });
function bounded(promise, ms, code) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })])
    .finally(() => clearTimeout(timer));
}
function finishParticipants(participants, at) {
  const result = structuredClone(participants);
  for (const p of Object.values(result)) {
    if (p.joinedAt !== null) p.durationMs += Math.max(0, at - p.joinedAt);
    p.joinedAt = null; p.consented = false;
  }
  return result;
}
class Coordinator {
  constructor({ store, audio, recognize, publisher, now = Date.now, limits = {}, consentMode = 'manual' }) {
    if (!['manual', 'channel'].includes(consentMode)) fail('INVALID_CONSENT_MODE');
    Object.defineProperty(this, 'consentMode', { value: consentMode, enumerable: true });
    Object.assign(this, { store, audio, publisher, now });
    // Latest synchronous occupancy is a privacy barrier, not queued accounting.
    this.observedMembers = null;
    this.limits = { ...DEFAULTS, ...store.limits, ...limits };
    this.current = null; this.members = null; this.emptySince = null; this.holdUntilEmpty = false;
    this.epochs = new Map(); this.tail = Promise.resolve(); this.background = new Set(); this.closures = new Set();
    this.captureClosures = new Set(); this.runtimes = new Set();
    this.initialized = false; this.stopping = false; this.failed = false; this.lastIssue = null;
    this.scheduler = new Scheduler({ store, recognize, now, limits: this.limits,
      onChange: id => this.deferCheck(id), onFault: (code, id) => this.schedulerFault(code, id) });
  }
  enqueue(fn) {
    const task = this.tail.then(fn).catch(() => { this.emergency('CORE_STORAGE_OR_LIFECYCLE_FAILED'); fail('CORE_STORAGE_OR_LIFECYCLE_FAILED'); });
    this.tail = task.catch(() => {}); return task;
  }
  backgroundTask(task, code) {
    const owned = Promise.resolve(task).catch(() => { this.lastIssue = issue(code); })
      .finally(() => this.background.delete(owned));
    this.background.add(owned); return owned;
  }
  emergency(code) {
    this.failed = true; this.lastIssue = issue(code);
    if (this.current) { const rt = this.current; rt.accepting = false; rt.gates.clear();
      // Do not depend on a functioning disk/lifecycle queue to stop the receiver.
      if (rt.handle && !rt.closePromise) {
        rt.closePromise = Promise.resolve().then(() => rt.handle.close());
        this.trackCaptureClose(rt.closePromise, rt);
        this.backgroundTask(rt.closePromise, 'CAPTURE_CLOSE_FAILED');
      }
    }
  }
  deferCheck(id) {
    if (!this.initialized || this.stopping) return;
    queueMicrotask(() => { void this.enqueue(() => this.maybeFinalize(id)).catch(() => {}); });
  }
  schedulerFault(code, id) {
    this.lastIssue = issue(code);
    const global = ['SCHEDULER_STORE_FAILED', 'SCHEDULER_CALLBACK_FAILED'].includes(code);
    if (this.current && (global || !id || this.current.id === id)) void this.fault(code).catch(() => {});
  }
  async init() {
    return this.enqueue(() => {
      if (this.initialized) return;
      this.store.recover({ now: this.now() });
      this.holdUntilEmpty = this.store.getControl().holdUntilEmpty;
      for (const s of this.store.listSessions()) {
        if (s.holdUntilEmpty) this.holdUntilEmpty = true;
        if (s.phase === 'active') {
          const endedAt = Math.max(s.startedAt, s.lastSeenAt);
          this.store.patchSession(s.id, { phase: 'draining', endedAt, participants: finishParticipants(s.participants, endedAt),
            stopReason: 'restart', captureEof: true, captureCloseAcknowledged: false, drainStartedAt: this.now(),
            issues: [...new Set([...s.issues, 'RESTART_INTERRUPTED'])].slice(0, 64) });
        } else if (s.phase === 'draining') {
          this.store.patchSession(s.id, { captureEof: true, participants: finishParticipants(s.participants, s.endedAt ?? s.lastSeenAt),
            // Restart gives pending durable work a bounded new drain window.
            drainStartedAt: this.now() });
        }
        const recovered = this.store.getSession(s.id);
        if (recovered.phase !== 'active' && (recovered.notice.state !== 'closed' || recovered.notice.disabled !== true))
          this.backgroundTask(Promise.resolve().then(() => this.publisher.closeNotice(s.id)), 'NOTICE_CLOSE_FAILED');
      }
      this.initialized = true; this.scheduler.start();
      for (const s of this.store.listSessions()) {
        if (s.phase === 'draining') this.maybeFinalize(s.id);
        else if (s.phase === 'ready' && s.publication.state !== 'sent') this.publish(s.id);
      }
      this.store.prune(this.now());
    });
  }
  releaseRuntime(rt) {
    if (rt.closing && rt.eof && rt.physicalClosed) {
      this.runtimes.delete(rt); rt.epochs.clear();
    }
  }
  trackCaptureClose(promise, rt) {
    this.captureClosures.add(promise);
    promise.finally(() => {
      this.captureClosures.delete(promise);
      if (rt) { rt.physicalClosed = true; this.releaseRuntime(rt); }
    }).catch(() => {});
    return promise;
  }
  invalidateRuntime(rt, userId) {
    if (!this.store.getSession(rt.id)?.participants[userId]) {
      // A trustworthy observation can precede queued participant accounting.
      // Fence previously queued Resume requests without retaining unbounded IDs.
      if (rt === this.current && this.observedMembers?.has(userId)) rt.pendingAuthorization = Symbol();
      rt.gates.delete(userId); return;
    }
    rt.epochs.set(userId, (rt.epochs.get(userId) || 0) + 1);
    rt.gates.delete(userId);
  }
  invalidate(userId) {
    // Scope epochs to participant-bounded runtimes, including physically closing
    // old receivers. A next session must not make the old tail unreachable.
    if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) return;
    for (const rt of this.runtimes) this.invalidateRuntime(rt, userId);
  }
  setHold(hold) {
    if (this.store.getControl().holdUntilEmpty !== hold) this.store.setHoldUntilEmpty(hold);
    this.holdUntilEmpty = hold;
  }
  async membership(members) {
    // Gate invalidation is deliberately outside the serialized queue. Refuse an
    // over-cap snapshot without retaining an arbitrarily large membership map.
    if (members !== null) members = members.filter(m => m.bot !== true && m.user?.bot !== true);
    if (members !== null && members.length > this.limits.maxParticipants) {
      this.observedMembers = null;
      if (this.current) { this.current.accepting = false; this.current.gates.clear(); }
      return this.enqueue(() => {
        this.lastIssue = 'PARTICIPANT_LIMIT'; this.setHold(true);
        if (this.current) this.stopCurrent('participant_limit', 'PARTICIPANT_LIMIT', true);
        return false;
      });
    }
    const ids = members === null ? null : new Set(members.map(m => account(m.id)));
    if (this.current && (!ids || this.observedMembers && [...this.observedMembers].some(id => !ids.has(id))))
      this.current.pendingAuthorization = Symbol();
    this.observedMembers = ids;
    for (const rt of this.runtimes) for (const id of rt.gates) if (!ids || !ids.has(id)) this.invalidate(id);
    if (this.members) for (const id of this.members.keys()) if (!ids || !ids.has(id)) this.invalidate(id);
    // Reset at observation time, not later behind readiness: a newer Stop
    // must not be erased by processing an older queued empty snapshot.
    if (ids?.size === 0 && this.initialized && !this.stopping && !this.failed) {
      try { this.store.clearAutomaticOptOuts(); }
      catch { this.optOutFailure(); fail('AUTOMATIC_OPTOUT_FAILED'); }
    }
    // Own a bounded copy, never a caller's mutable array during readiness.
    members = members === null ? null : members.map(m => ({ id: m.id, name: String(m.name || m.id).slice(0, 128) }));
    if (this.consentMode !== 'channel') return this.enqueue(() => this.applyMembership(members));
    const optedOut = new Set(this.store.getAutomaticOptOuts());
    if (ids && [...ids].filter(id => !optedOut.has(id)).length > this.limits.maxConsenting) {
      // A later smaller poll must not coalesce away an observed safety cap.
      if (this.current) { this.current.accepting = false; this.current.gates.clear(); }
      return this.enqueue(() => this.applyMembership(members));
    }
    // One waiting snapshot per lifecycle barrier, in addition to the in-flight
    // operation. Never move a later known-empty event ahead of an enqueued End.
    // Preserve empty/unknown barriers even when polling coalesces the payload.
    if (this.pendingMembership && this.pendingMembership.tail === this.tail) {
      this.pendingMembership.members = members;
      this.pendingMembership.empty ||= members?.length === 0;
      this.pendingMembership.unknown ||= members === null;
      return this.pendingMembership.task;
    }
    const pending = { members, empty: members?.length === 0, unknown: members === null };
    this.pendingMembership = pending;
    pending.task = this.enqueue(async () => {
      if (this.pendingMembership === pending) this.pendingMembership = null;
      if (pending.unknown && pending.members !== null) await this.applyMembership(null);
      if (pending.empty && pending.members?.length !== 0) await this.applyMembership([]);
      return this.applyMembership(pending.members);
    });
    pending.tail = this.tail;
    return pending.task;
  }
  async applyMembership(members) {
    if (!this.initialized || this.stopping || this.failed) return false;
    if (members === null) {
      this.members = null; this.emptySince = null;
      if (this.current) {
        const s = this.store.getSession(this.current.id);
        this.store.patchSession(s.id, { participants: finishParticipants(s.participants, s.lastSeenAt) });
        this.store.addIssue(s.id, 'OCCUPANCY_UNKNOWN');
        for (const id of this.current.jobs.keys()) this.flush(this.current, id);
        this.disableSubscriptions(this.current);
      }
      return true;
    }
    const snapshot = new Map();
    for (const member of members) { account(member.id);
      snapshot.set(member.id, { id: member.id, name: String(member.name || member.id).slice(0, 128) }); }
    this.members = snapshot;
    const now = this.now();
    if (!snapshot.size) {
      if (this.emptySince === null) this.emptySince = now;
      this.setHold(false);
      for (const s of this.store.listSessions()) if (s.holdUntilEmpty) this.store.patchSession(s.id, { holdUntilEmpty: false });
    } else this.emptySince = null;
    if (!this.current && snapshot.size && !this.holdUntilEmpty && this.startSession(now) === false) return false;
    const rt = this.current; if (!rt) return true;
    const s = this.store.getSession(rt.id), participants = s.participants;
    const distinct = new Set([...Object.keys(participants), ...snapshot.keys()]);
    if (distinct.size > this.limits.maxParticipants) { this.stopCurrent('participant_limit', 'PARTICIPANT_LIMIT', true); return false; }
    for (const p of Object.values(participants)) {
      if (!snapshot.has(p.id)) {
        if (p.joinedAt !== null) p.durationMs += Math.max(0, now - p.joinedAt);
        p.joinedAt = null; p.consented = false; this.flush(rt, p.id); this.disableSubscription(rt, p.id);
      } else if (!rt.gates.has(p.id) && p.consented) {
        p.consented = false; this.flush(rt, p.id); this.disableSubscription(rt, p.id);
      }
    }
    for (const m of snapshot.values()) {
      if (!participants[m.id]) participants[m.id] = { ...m, joinedAt: now, durationMs: 0, consented: false, everConsented: false };
      else { const p = participants[m.id]; p.name = m.name; if (p.joinedAt === null) p.joinedAt = now; }
    }
    this.store.patchSession(s.id, { participants, lastSeenAt: now });
    if (this.consentMode === 'channel') {
      const optedOut = new Set(this.store.getAutomaticOptOuts());
      const eligible = [...snapshot.keys()].filter(id => !optedOut.has(id));
      if (eligible.length > this.limits.maxConsenting) {
        rt.accepting = false; rt.gates.clear();
        this.lastIssue = 'CONSENT_LIMIT'; this.stopCurrent('consent_limit', 'CONSENT_LIMIT', true); return false;
      }
      // Capture every epoch before the first await, not just each account's
      // turn: a leave/Stop during another account's readiness invalidates it.
      const grants = eligible.map(id => [id, rt.epochs.get(id) || 0]);
      for (const [id, epoch] of grants) await this.grant(rt, id, epoch, { automatic: true });
    }
    return true;
  }
  startSession(now) {
    if (this.members.size > this.limits.maxParticipants) { this.setHold(true); this.lastIssue = 'PARTICIPANT_LIMIT'; return; }
    this.store.prune(now);
    let s;
    try { s = this.store.createSession({ startedAt: now, consentMode: this.consentMode }); }
    catch (e) {
      if (e.safeCode !== 'SESSION_LIMIT') throw e;
      this.lastIssue = 'SESSION_LIMIT'; this.setHold(true); return false;
    }
    const rt = { id: s.id, gates: new Set(), jobs: new Map(), handle: null, accepting: true, eof: false,
      opening: null, closePromise: null, closing: false, physicalClosed: true, epochs: new Map(), subscriptionTails: new Map(), receivedBytes: 0, acceptedBytes: 0, rejectedBytes: 0 };
    this.current = rt; this.epochs = rt.epochs; this.runtimes.add(rt);
    this.backgroundTask(Promise.resolve().then(() => this.publisher.notice(s.id)), 'NOTICE_FAILED_OR_UNCERTAIN');
  }
  validNotice(rt, noticeId) { if (!rt || rt.closing) return false;
    const s = this.store.getSession(rt.id); return s.notice.state === 'sent' && s.notice.id === noticeId; }
  async consent(userId, noticeId) {
    account(userId); const rt = this.current, epoch = rt?.epochs.get(userId) || 0;
    const pendingAuthorization = rt?.pendingAuthorization;
    return this.enqueue(() => {
      if (rt?.pendingAuthorization !== pendingAuthorization) return false;
      return this.grant(rt, userId, epoch, { automatic: false, noticeId });
    });
  }
  grantValid(rt, userId, epoch, { automatic, noticeId }) {
    if (!rt || this.current !== rt || !rt.accepting || rt.closing || rt.endRequested || this.stopping || this.failed ||
        !this.members?.has(userId) || !this.observedMembers?.has(userId) ||
        (rt.epochs.get(userId) || 0) !== epoch) return false;
    const s = this.store.getSession(rt.id);
    if (!s?.participants[userId] || (s.consentMode || 'manual') !== this.consentMode) return false;
    return automatic ? this.consentMode === 'channel' && !this.store.getAutomaticOptOuts().includes(userId)
      : this.validNotice(rt, noticeId);
  }
  // Shared queue-internal operation. Automatic membership MUST NOT enqueue
  // consent() while it owns the lifecycle queue (that would deadlock).
  async grant(rt, userId, epoch, authorization) {
    const valid = () => this.grantValid(rt, userId, epoch, authorization);
    if (!valid()) return false;
    if (rt.gates.has(userId)) return true;
    if (rt.gates.size >= this.limits.maxConsenting) { this.lastIssue = 'CONSENT_LIMIT'; return false; }
    try {
      if (!rt.handle) {
        // Physical close remains a prerequisite even after the old core EOF.
        await bounded(Promise.all([...this.captureClosures, ...this.closures]), this.limits.audioCloseMs, 'PREVIOUS_CAPTURE_NOT_CLOSED');
        if (!valid()) return false;
        rt.physicalClosed = false;
        rt.opening = Promise.resolve().then(() => this.audio.open({ sessionId: rt.id,
          onPcm: packet => this.onPcm(rt, packet), onFault: code => this.audioFault(rt, code) }));
        rt.handle = await bounded(rt.opening, this.limits.audioOpenMs, 'AUDIO_OPEN_TIMEOUT');
      }
      if (!valid()) { if (rt.handle) await this.setSubscription(rt, userId, false); return false; }
      // Only a fresh explicit current-notice Resume may erase a durable Stop.
      // No await between this authorization check, durable change and gate.
      if (!authorization.automatic && this.consentMode === 'channel' && this.store.getAutomaticOptOuts().includes(userId)) {
        try { this.store.setAutomaticOptOut(userId, false); }
        catch { this.optOutFailure(); return false; }
      }
      rt.gates.add(userId);
      const s = this.store.getSession(rt.id), participants = s.participants;
      participants[userId].consented = true; participants[userId].everConsented = true;
      this.store.patchSession(rt.id, { participants });
      await this.setSubscription(rt, userId, true, valid);
      if (!valid() || !rt.gates.has(userId)) {
        rt.gates.delete(userId);
        await this.setSubscription(rt, userId, false); return false;
      }
      return true;
    } catch {
      rt.gates.clear();
      // A handshake interrupted by an already-authenticated gateway fault is
      // still that interruption. A concurrent native/safety fault wins instead.
      const recoverable = !!rt.gatewayFault && !rt.safetyFault;
      this.stopCurrent('capture_fault', rt.safetyFault || rt.gatewayFault || 'AUDIO_OPEN_OR_SUBSCRIBE_FAILED', !recoverable);
      // A late voice handshake must close, never subscribe or revive capture.
      if (rt.opening) this.backgroundTask(this.trackCaptureClose(rt.opening.then(h => h.close()), rt), 'LATE_AUDIO_CLOSE_FAILED');
      return false;
    }
  }
  optOutFailure() {
    this.emergency('AUTOMATIC_OPTOUT_FAILED');
    // Capacity failures can still persist a global hold. With disk failure this
    // is best effort only; never claim that personal suppression was durable.
    this.holdUntilEmpty = true;
    try { this.store.setHoldUntilEmpty(true); } catch { /* already failed closed */ }
  }
  async revoke(userId, noticeId) {
    account(userId);
    // A still-closing notice can revoke only its own runtime, never a new one.
    const rt = [...this.runtimes].find(r => {
      const s = this.store.getSession(r.id);
      return s && s.notice.id === noticeId && ['sent', 'closed'].includes(s.notice.state);
    });
    if (!rt) return false;
    if (this.current === rt) {
      // Fence every previously queued explicit grant, including accounts whose
      // observation/accounting is still pending or has just become unknown.
      rt.pendingAuthorization = Symbol(); this.invalidate(userId);
    } else this.invalidateRuntime(rt, userId);
    if (this.consentMode === 'channel' && this.current === rt && this.validNotice(rt, noticeId)) {
      try { this.store.setAutomaticOptOut(userId, true); }
      catch { this.optOutFailure(); fail('AUTOMATIC_OPTOUT_FAILED'); }
    }
    return this.enqueue(async () => {
      const s = this.store.getSession(rt.id), p = s?.participants[userId]; if (!p) return false;
      p.consented = false; this.store.patchSession(rt.id, { participants: s.participants });
      if (!rt.eof) this.flush(rt, userId);
      if (rt.handle && !rt.eof) { try { await this.setSubscription(rt, userId, false); } catch { this.audioFault(rt, 'AUDIO_UNSUBSCRIBE_FAILED'); } }
      return true;
    });
  }
  async end(noticeId) {
    const rt = this.current;
    // Exact notice validation precedes the synchronous privacy barrier. Neither
    // queued lifecycle work nor pending voice readiness may extend acceptance.
    if (!this.validNotice(rt, noticeId) || rt.endRequested) return false;
    rt.endRequested = true; rt.accepting = false; rt.gates.clear();
    const endedAt = this.now(), s = this.store.getSession(rt.id);
    rt.requestedEndAt = endedAt;
    rt.endParticipants = finishParticipants(s.participants, this.members === null ? Math.min(s.lastSeenAt, endedAt) : endedAt);
    for (const id of Object.keys(this.store.getSession(rt.id).participants)) this.invalidateRuntime(rt, id);
    return this.enqueue(() => {
      if (this.current !== rt) return rt.closing && this.store.getSession(rt.id)?.stopReason === 'explicit_end';
      this.stopCurrent('explicit_end', null, true, endedAt); return true;
    });
  }
  audioFault(rt, code) {
    if (rt.eof) return;
    if (rt.closing) {
      // Audio suppresses intentional move/disconnect teardown events itself.
      // Real drain/decode/dispose faults before EOF still mean incomplete, and
      // belong to this old runtime, never to an independently capturing new one.
      rt.accepting = false; rt.gates.clear();
      void this.enqueue(() => {
        if (this.store.getSession(rt.id)) this.store.addIssue(rt.id, issue(code));
      }).catch(() => {});
      return;
    }
    if (this.current !== rt) return;
    rt.accepting = false; rt.gates.clear();
    void this.fault(issue(code)).catch(() => {});
  }
  async fault(code) {
    this.lastIssue = issue(code);
    const rt = this.current;
    const recoverable = this.consentMode === 'channel' &&
      ['GATEWAY_INTERRUPTION', 'GATEWAY_DISCONNECT', 'GATEWAY_RECONNECT'].includes(code);
    if (rt) {
      rt.accepting = false; rt.gates.clear();
      // Latch before enqueueing: a gateway callback must not hide a simultaneous
      // native/safety stop just because its teardown happens to run first.
      if (recoverable) rt.gatewayFault = issue(code); else rt.safetyFault = issue(code);
    }
    if (recoverable) this.observedMembers = null; // requires a new trustworthy snapshot
    return this.enqueue(() => {
      if (rt && this.current === rt) this.stopCurrent('capture_fault', rt.safetyFault || issue(code), !recoverable || !!rt.safetyFault);
    });
  }
  setSubscription(rt, id, yes, authorized = () => true) {
    const prior = rt.subscriptionTails.get(id) || Promise.resolve();
    const operation = prior.catch(() => {}).then(() => {
      if (yes && (!rt.accepting || !rt.gates.has(id) || rt.closing || this.current !== rt || this.stopping || !authorized())) return;
      return rt.handle?.setConsented(id, yes);
    });
    rt.subscriptionTails.set(id, operation);
    operation.finally(() => { if (rt.subscriptionTails.get(id) === operation) rt.subscriptionTails.delete(id); }).catch(() => {});
    return operation;
  }
  disableSubscription(rt, id) {
    if (rt.handle) this.backgroundTask(this.setSubscription(rt, id, false).catch(() => {
      this.audioFault(rt, 'AUDIO_UNSUBSCRIBE_FAILED');
    }), 'AUDIO_UNSUBSCRIBE_FAILED');
  }
  disableSubscriptions(rt) { const s = this.store.getSession(rt.id); for (const id of Object.keys(s.participants)) this.disableSubscription(rt, id); }
  onPcm(rt, { userId, pcm, atMs }) {
    // Never consult a mutable next-session buffer. revoke/leave removes this
    // synchronous gate before any lifecycle await, including during handshake.
    if (!rt.accepting || rt.eof || !rt.gates.has(userId) || this.stopping && !rt.closing) return false;
    const size = Buffer.isBuffer(pcm) ? pcm.length : 0;
    rt.receivedBytes += size;
    let accepted = 0;
    try {
      if (!size || size % 4 || size > this.limits.maxPacketBytes || !Number.isFinite(atMs)) fail('PCM_PACKET_INVALID');
      const s = this.store.getSession(rt.id);
      let cursor = rt.jobs.get(userId);
      if (cursor && atMs - cursor.lastAt > this.limits.quietMs) { this.flush(rt, userId); cursor = null; }
      while (accepted < size) {
        cursor = rt.jobs.get(userId);
        if (!cursor) {
          const j = this.store.createJob({ sessionId: rt.id, userId, startMs: Math.max(0, atMs - s.startedAt + accepted / 192) });
          cursor = { id: j.id, lastAt: atMs }; rt.jobs.set(userId, cursor);
        }
        const j = this.store.getJob(cursor.id), count = Math.min(size - accepted, this.store.limits.maxUtteranceBytes - j.bytes);
        this.store.appendPcm(j.id, pcm.subarray(accepted, accepted + count));
        accepted += count; rt.acceptedBytes += count; cursor.lastAt = atMs;
        if (j.bytes + count === this.store.limits.maxUtteranceBytes) this.flush(rt, userId);
      }
      return true;
    } catch (e) {
      rt.rejectedBytes += size - accepted; rt.accepting = false; rt.gates.clear();
      const code = ['QUEUE_LIMIT', 'SPOOL_LIMIT', 'JOB_RECORD_LIMIT', 'PCM_WRITE_FAILED', 'PCM_PACKET_INVALID'].includes(e.safeCode) ? e.safeCode : 'PCM_STORAGE_FAILED';
      this.lastIssue = code;
      // Persist against the packet's runtime even if current already belongs to
      // a new call. Commit before a queued finalization can report completion.
      try { this.store.addIssue(rt.id, code); } catch { this.emergency('CORE_STORAGE_OR_LIFECYCLE_FAILED'); }
      void this.enqueue(() => { if (this.current === rt) this.stopCurrent('capture_overload_or_fault', code, true); }).catch(() => {});
      return false;
    }
  }
  flush(rt, userId) {
    const cursor = rt.jobs.get(userId); if (!cursor) return;
    this.store.queueJob(cursor.id); rt.jobs.delete(userId); this.scheduler.kick();
  }
  stopCurrent(reason, code, hold, endedAt = this.now()) {
    const rt = this.current; if (!rt || rt.closing) return;
    // An authenticated End is a synchronous safety decision. An older queued
    // gateway teardown may perform its close, but cannot downgrade its hold or
    // move its frozen timestamp later.
    if (rt.endRequested) { reason = 'explicit_end'; hold = true; endedAt = rt.requestedEndAt; }
    rt.closing = true;
    this.setHold(hold);
    const s = this.store.getSession(rt.id), now = this.now();
    this.store.patchSession(rt.id, { phase: 'draining', endedAt, lastSeenAt: endedAt, stopReason: reason,
      participants: rt.endParticipants || finishParticipants(s.participants, this.members === null ? Math.min(s.lastSeenAt, endedAt) : endedAt),
      drainStartedAt: now, captureEof: false, captureCloseAcknowledged: false, holdUntilEmpty: hold,
      issues: code ? [...new Set([...s.issues, issue(code)])].slice(0, 64) : s.issues });
    this.current = null; this.emptySince = null;
    this.backgroundTask(Promise.resolve().then(() => this.publisher.closeNotice(rt.id)), 'NOTICE_CLOSE_FAILED');
    const closing = (async () => {
      let closeAcknowledged = !rt.handle && !rt.opening;
      try {
        if (rt.handle) {
          if (!rt.closePromise) rt.closePromise = this.trackCaptureClose(Promise.resolve().then(() => rt.handle.close()), rt);
          await bounded(rt.closePromise, this.limits.audioCloseMs, 'AUDIO_CLOSE_TIMEOUT');
          closeAcknowledged = true;
        }
      } catch { this.store.addIssue(rt.id, 'CAPTURE_EOF_UNCONFIRMED'); }
      finally {
        rt.accepting = false; rt.eof = true; rt.gates.clear(); this.releaseRuntime(rt);
        for (const id of [...rt.jobs.keys()]) this.flush(rt, id);
        // Include durable create-intents whose audio creation failed.
        for (const j of this.store.listJobs(rt.id)) if (j.state === 'recording') this.store.queueJob(j.id);
        // EOF means the coordinator input is now sealed. A timed-out port is
        // never presented as an acknowledged receiver close: its physical close
        // barrier remains owned, new opens are refused, and output is incomplete.
        this.store.patchSession(rt.id, { captureEof: true, captureCloseAcknowledged: closeAcknowledged, receivedBytes: rt.receivedBytes,
          acceptedBytes: rt.acceptedBytes, rejectedBytes: rt.rejectedBytes });
        this.scheduler.kick(); this.deferCheck(rt.id);
      }
    })();
    this.closures.add(closing); closing.finally(() => this.closures.delete(closing)).catch(() => {});
    this.backgroundTask(closing, 'CAPTURE_CHECKPOINT_FAILED');
  }
  maybeFinalize(id) {
    const s = this.store.getSession(id); if (!s || s.phase !== 'draining' || !s.captureEof) return;
    if (!this.scheduler.sessionTerminal(id)) return;
    const jobs = this.store.listJobs(id), accountedBytes = jobs.reduce((n, j) => n + j.bytes, 0);
    const issues = new Set(s.issues);
    for (const j of jobs) if (['failed', 'cancelled'].includes(j.state)) issues.add(j.issue || 'INCOMPLETE_JOB');
    if (s.rejectedBytes > 0) issues.add('PCM_REJECTED');
    if (s.acceptedBytes !== undefined && s.acceptedBytes !== accountedBytes) issues.add('PCM_ACCOUNTING_MISMATCH');
    if (s.receivedBytes !== undefined && s.receivedBytes !== accountedBytes + (s.rejectedBytes || 0)) issues.add('PCM_ACCOUNTING_MISMATCH');
    this.store.patchSession(id, { phase: 'ready', accountedBytes, issues: [...issues].slice(0, 64) });
    if (!this.stopping) this.publish(id);
  }
  publish(id) { this.backgroundTask(Promise.resolve().then(() => this.publisher.publish(id)), 'PUBLICATION_FAILED_OR_UNCERTAIN'); }
  async tick() {
    return this.enqueue(() => {
      if (!this.initialized || this.stopping || this.failed) return;
      const now = this.now(), rt = this.current;
      if (rt) {
        for (const [id, cursor] of rt.jobs) if (now - cursor.lastAt > this.limits.quietMs) this.flush(rt, id);
        if (this.members !== null) this.store.patchSession(rt.id, { lastSeenAt: now,
          receivedBytes: rt.receivedBytes, acceptedBytes: rt.acceptedBytes, rejectedBytes: rt.rejectedBytes });
        const s = this.store.getSession(rt.id);
        if (now - s.startedAt >= this.limits.maxSessionMs) this.stopCurrent('duration_limit', null, true);
        else if (this.members?.size === 0 && this.emptySince !== null && now - this.emptySince >= this.limits.emptyGraceMs)
          this.stopCurrent('known_empty', null, false, this.emptySince);
      }
      for (const s of this.store.listSessions()) {
        if (s.phase !== 'draining') continue;
        if (now - (s.drainStartedAt ?? s.endedAt) >= this.limits.maxDrainMs && !this.scheduler.sessionTerminal(s.id)) {
          this.store.addIssue(s.id, 'DRAIN_TIMEOUT'); this.scheduler.cancelSession(s.id, 'DRAIN_TIMEOUT');
        }
        this.maybeFinalize(s.id);
      }
      this.store.prune(now);
    });
  }
  shutdown() {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    // Block starting another native job even while EOF callbacks flush a tail.
    this.scheduler.paused = true; this.scheduler.active?.abort.abort();
    this.shutdownTask = (async () => {
      let checkpointFailed = false;
      try { await this.enqueue(() => { if (this.current) this.stopCurrent('shutdown', 'SHUTDOWN_INTERRUPTED', this.holdUntilEmpty); }); }
      catch { checkpointFailed = true; }
      const closed = await Promise.allSettled([...this.closures, ...this.captureClosures]);
      if (closed.some(r => r.status === 'rejected')) checkpointFailed = true;
      await this.scheduler.shutdown();
      await this.tail;
      // Publication transports have their own mandatory bounded REST timeout;
      // coordinator awaits owned callbacks rather than abandoning them. An
      // uncooperative port must trip the feature's global shutdown deadline;
      // it must not be mistaken for an acknowledged/closed capture process.
      await Promise.all([...this.background]);
      for (const s of this.store.listSessions()) if (s.phase === 'draining') this.maybeFinalize(s.id);
      // Timed-out HTTP may acknowledge late and launch a notice edit. Those
      // continuations can still patch Store; never release its lock before them.
      if (this.publisher.drain) await this.publisher.drain();
      if (checkpointFailed) fail('SHUTDOWN_CHECKPOINT_FAILED');
    })();
    return this.shutdownTask;
  }
  status() {
    const records = this.store.listSessions(), s = this.current && this.store.getSession(this.current.id);
    return { initialized: this.initialized, shuttingDown: this.stopping, failed: this.failed,
      recording: !!s && this.current.gates.size > 0, sessionId: s?.id || null,
      consenting: this.current?.gates.size || 0, occupancy: this.members === null ? 'unknown' : this.members.size,
      draining: records.filter(r => r.phase === 'draining').length,
      incomplete: records.filter(r => r.issues.length > 0).length,
      held: records.filter(r => ['held', 'uncertain'].includes(r.publication.state)).length,
      consentMode: this.consentMode, automaticOptOuts: this.store.getAutomaticOptOuts().length,
      holdUntilEmpty: this.holdUntilEmpty, issue: this.lastIssue, ...this.store.status(), scheduler: this.scheduler.status() };
  }
}
module.exports = { Coordinator, DEFAULTS };
