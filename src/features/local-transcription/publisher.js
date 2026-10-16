'use strict';
// One durable final outbox. Discord is not a transaction participant: an
// ambiguous send is reconciled or held, NEVER blindly sent a second time.
const crypto = require('node:crypto');
const USER = /^\d{17,20}$/;
const ID = /^[a-z0-9-]{1,80}$/;
const TERMINAL = new Set(['recognized', 'no_speech', 'failed', 'cancelled']);
const ACTIONS = Object.freeze([
  ['local_transcription_consent', 'I consent: record my mic', 3],
  ['local_transcription_revoke', 'Stop my microphone', 2],
  ['local_transcription_end', 'End recording', 4],
]);
function refusal(code) { const e = Error(code); e.safeCode = code; return e; }
function check(value, code) { if (!value) throw refusal(code); }
function safeText(value) {
  return String(value).replace(/@/g, '@\u200b').replace(/`/g, 'ˋ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
function duration(ms) {
  check(Number.isFinite(ms) && ms >= 0, 'INVALID_FINAL_DURATION');
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
function offset(ms) {
  check(Number.isFinite(ms) && ms >= 0, 'INVALID_JOB_OFFSET');
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600).toString().padStart(2, '0')}:${Math.floor(s % 3600 / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}
function sessionPolicy(session) {
  const mode = session.consentMode === undefined ? 'manual' : session.consentMode;
  check(mode === 'manual' || mode === 'channel', 'INVALID_CONSENT_MODE');
  return mode;
}
function buttons(disabled = false, consentMode = 'manual', startEnabled = false) {
  check(consentMode === 'manual' || consentMode === 'channel', 'INVALID_CONSENT_MODE');
  return [{ type: 1, components: ACTIONS.map(([custom_id, label, style]) => ({ type: 2, custom_id,
    label: consentMode === 'channel' && custom_id === 'local_transcription_consent' ? 'Resume my microphone' : label, style, disabled })).concat([{ type: 2, custom_id: 'local_transcription_start', label: 'Start recording again', style: 1, disabled: !startEnabled }]) }];
}
function validateSession(session) {
  check(session?.schema === 1 && ID.test(session.id), 'INVALID_FINAL_SESSION');
  check(Number.isFinite(session.startedAt), 'INVALID_FINAL_SESSION');
  sessionPolicy(session);
  check(session.participants && typeof session.participants === 'object' && !Array.isArray(session.participants), 'INVALID_PARTICIPANTS');
  const participants = Object.values(session.participants);
  check(participants.length <= 32, 'PARTICIPANT_OUTPUT_LIMIT');
  for (const [id, p] of Object.entries(session.participants)) {
    check(USER.test(id) && p?.id === id && Number.isFinite(p.durationMs) && p.durationMs >= 0, 'INVALID_PARTICIPANT');
  }
  return participants;
}
function issueCode(code) { return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNSPECIFIED_ISSUE'; }
function finalPayload(session, jobs, { allowAttachments = false, inlineLimit = 1900, maxTranscriptBytes = 4 * 1024 * 1024 } = {}) {
  check(typeof allowAttachments === 'boolean', 'INVALID_ATTACHMENT_APPROVAL');
  const participants = validateSession(session);
  const channelPolicy = sessionPolicy(session) === 'channel';
  check(['ready', 'published'].includes(session.phase) && Number.isFinite(session.endedAt) && session.endedAt >= session.startedAt, 'TRANSCRIPTION_NOT_READY');
  check(Array.isArray(jobs), 'INVALID_FINAL_JOBS');
  check(jobs.length <= 32768, 'JOB_OUTPUT_LIMIT');
  const issues = new Set((session.issues || []).map(issueCode));
  const sorted = [...jobs].sort((a, b) => a.startMs - b.startMs || a.sequence - b.sequence);
  const lines = []; let bytes = 0, formattedBytes = 0;
  for (const job of sorted) {
    check(job.sessionId === session.id && ID.test(job.id) && USER.test(job.userId) && session.participants[job.userId], 'INVALID_FINAL_JOB');
    check(TERMINAL.has(job.state), 'TRANSCRIPTION_NOT_READY');
    check(session.participants[job.userId].everConsented === true, 'JOB_WITHOUT_CONSENT');
    check(Number.isSafeInteger(job.sequence) && job.sequence >= 0 && Number.isSafeInteger(job.bytes) && job.bytes >= 0, 'INVALID_FINAL_JOB');
    bytes += job.bytes;
    check(Number.isSafeInteger(bytes), 'INVALID_FINAL_JOB');
    const name = safeText(session.participants[job.userId].name || job.userId).replace(/[\r\n\t]/g, ' ').slice(0, 80);
    const prefix = `[${offset(job.startMs)}] ${name} (${job.userId})`;
    let line;
    if (job.state === 'recognized' && typeof job.text === 'string' && job.text.trim()) {
      line = `${prefix}: ${safeText(job.text.trim())}`;
    } else if (job.state === 'no_speech') {
      line = `${prefix}: [No speech: exact-zero audio.]`;
    } else {
      const code = job.state === 'recognized' ? 'EMPTY_RECOGNITION' : issueCode(job.issue || `JOB_${job.state.toUpperCase()}`);
      issues.add(code); line = `${prefix}: [INCOMPLETE: ${code}; ${job.bytes} PCM bytes]`;
    }
    formattedBytes += Buffer.byteLength(line) + 1;
    check(formattedBytes <= maxTranscriptBytes, 'TRANSCRIPT_OUTPUT_LIMIT');
    lines.push(line);
  }
  const consented = participants.filter(p => p.everConsented).length;
  if (consented && bytes === 0) issues.add('NO_AUDIO_OBSERVED');
  const issueList = [...issues].sort();
  const status = issues.size ? 'INCOMPLETE' : consented ? 'Accepted audio processed' : channelPolicy ? 'Not recorded (no authorized audio)' : 'Not recorded (no consent)';
  let content = `📊 **Meeting Summary**\n**Status:** ${status}\n`;
  content += `**Call duration:** ${duration(session.endedAt - session.startedAt)}\n`;
  content += `**Participants and duration:**\n`;
  for (const p of [...participants].sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id))) {
    content += `• <@${p.id}>: ${duration(p.durationMs)}\n`;
  }
  if (!participants.length) content += '[No tracked participants.]\n';
  content += channelPolicy ? `\n**Recording coverage:** ${consented}/${participants.length} account(s) authorized at least once under administrator-confirmed company standing consent (channel policy). Only authorized, unpaused windows are transcribed; no per-meeting click is required.\n` :
    `\n**Recording coverage:** ${consented}/${participants.length} account(s) consented at least once. Only consented windows are transcribed.\n`;
  content += 'Local English recognition; upstream loss is unknown. Packet gaps are not reconstructed silence.\n';
  if (issueList.length) content += `**Issues:** ${issueList.length}; details in the transcript.\n`;
  let transcript = issueList.length ? `INCOMPLETE — ${issueList.join(', ')}\n\n` : '';
  transcript += lines.join('\n') || (channelPolicy ? (consented ? '[No audio observed from authorized accounts.]' : '[No recording: no participants authorized.]') :
    (consented ? '[No audio observed from consenting accounts.]' : '[No recording: no participants consented.]'));
  check(Buffer.byteLength(transcript) <= maxTranscriptBytes, 'TRANSCRIPT_OUTPUT_LIMIT');
  const inline = content + '\n**Transcript:**\n```text\n' + transcript + '\n```';
  // Reserve space for immutable reconciliation marker; do not split/flood posts.
  if (inline.length + 145 <= inlineLimit) return { content: inline, allowedMentions: { parse: [] } };
  check(allowAttachments, 'ATTACHMENT_APPROVAL_REQUIRED');
  content += '\n**Transcript:** attached as one UTF-8 text file.\n';
  check(content.length + 145 <= inlineLimit, 'SUMMARY_OUTPUT_LIMIT');
  return { content, allowedMentions: { parse: [] }, files: [{ name: `meeting-transcript-${session.id}.txt`, attachment: Buffer.from(transcript, 'utf8') }] };
}
function payloadHash(payload) {
  const hash = crypto.createHash('sha256').update(payload.content);
  for (const f of payload.files || []) hash.update('\0').update(f.name).update('\0').update(f.attachment);
  // Components belong to the notice hash; final summaries have none.
  if (payload.components) hash.update('\0').update(JSON.stringify(payload.components));
  return hash.digest('hex');
}
function addIdentity(payload, kind, id) {
  const hash = payloadHash(payload);
  const marker = `local-${kind}:${id}:${hash}`;
  const nonce = crypto.createHash('sha256').update(`local-${kind}:${id}`).digest('hex').slice(0, 24);
  return { payload: { ...payload, content: `${payload.content}\nRef: ${marker}`, nonce, enforceNonce: true }, hash, marker, nonce };
}
class Publisher {
  constructor({ store, transport, allowAttachments = false, now = Date.now, requestMs = 10000, historyPages = 10 }) {
    check(typeof allowAttachments === 'boolean', 'INVALID_ATTACHMENT_APPROVAL');
    check(store && transport && USER.test(transport.botUserId), 'INVALID_PUBLICATION_PORT');
    check(typeof transport.send === 'function' && typeof transport.edit === 'function' && typeof transport.history === 'function', 'INVALID_PUBLICATION_PORT');
    check(Number.isFinite(requestMs) && requestMs > 0 && requestMs <= 30000, 'INVALID_PUBLICATION_BOUND');
    check(Number.isInteger(historyPages) && historyPages > 0 && historyPages <= 10, 'INVALID_PUBLICATION_BOUND');
    Object.assign(this, { store, transport, allowAttachments, now, requestMs, historyPages });
    this.inflight = new Map(); this.continuations = new Set();
  }
  single(key, action) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const result = Promise.resolve().then(action); this.inflight.set(key, result);
    result.then(() => this.inflight.delete(key), () => this.inflight.delete(key));
    return result;
  }
  async drain() {
    // Coordinator stops new lifecycle/publication work before calling this.
    // A local deadline does not prove the HTTP operation (or its late notice
    // edit) settled. Keep the writer lock until every owned continuation does.
    // The mandatory transport bound/global shutdown deadline handles broken ports.
    while (this.inflight.size || this.continuations.size)
      await Promise.allSettled([...this.inflight.values(), ...this.continuations]);
  }
  async bounded(action) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(refusal('PUBLICATION_TIMEOUT')), this.requestMs); })]); }
    finally { clearTimeout(timer); }
  }
  async find(record, pages = this.historyPages) {
    let before;
    for (let page = 0; page < pages; page++) {
      let rows;
      try { rows = await this.bounded(() => this.transport.history({ limit: 100, ...(before ? { before } : {}) })); }
      catch { return null; }
      if (!Array.isArray(rows) || rows.length > 100) return null;
      for (const row of rows) {
        if (USER.test(row?.id) && row.authorId === this.transport.botUserId && typeof record.expectedContent === 'string' && row.content === record.expectedContent) return row.id;
      }
      if (rows.length < 100) return null;
      const last = rows.at(-1)?.id;
      if (!USER.test(last) || last === before) return null;
      before = last;
    }
    return null;
  }
  notice(sessionId) {
    return this.single(`notice:${sessionId}`, async () => {
      const s = this.store.getSession(sessionId); validateSession(s);
      const prior = s.notice || { state: 'pending' };
      if (prior.state === 'closed') {
        if (prior.disabled) return prior;
        const id = USER.test(prior.id) ? prior.id : prior.marker ? await this.find(prior, 1) : null;
        return this.disableKnownNotice(sessionId, { ...prior, ...(id ? { id } : {}) });
      }
      if (prior.state === 'sent') return prior;
      const payload = {
        content: sessionPolicy(s) === 'channel' ? '**Local meeting transcription — automatic company consent**\n' +
          'The administrator confirms standing company consent for ALL humans admitted here, including guests and anyone audible through shared microphones. Recording starts automatically with one person in the configured voice channel; no button or notice acknowledgement is required. ' +
          'Known startup/restart and gateway reconnect occupancy may record unless idle-waiting. Unknown occupancy pauses capture. End, safety/overload faults and the configured maximum (at most 4 hours) stop automatic capture; they are not bypassed. ' +
          '**Stop my microphone** pauses your account across leave/rejoin and restart until you use **Resume my microphone** on this current notice while present, or the channel is known empty. **End recording** stops everyone until known empty. ' +
          'Presence/duration metadata is tracked for all participants. Only authorized, unpaused audio is transcribed. Ensure everyone audible has consented; otherwise stop your mic.\n\n' +
          'Local English recognition runs during the call; a final duration summary and transcript follow completed processing. Discord transports voice and retains posts; no extra STT provider receives audio. Private audio is deleted after processing/recovery. Normal local transcript/metadata retention is 24 hours after session end; outages can delay cleanup. Personal pause account IDs persist until resume/known empty, beyond that retention. ' +
          'Gaps/overload stay incomplete; long output needs approved delivery. Empty grace or inactivity closes capture. Idle waits for fresh arrival or Start; restart alone cannot wake it.' :
          '**Local meeting transcription — consent required**\n' +
          'Only an account that clicks **I consent: record my mic** while in the configured voice channel is subscribed/recorded. Joining alone is NOT consent. Presence/duration metadata is tracked for all participants. ' +
          'Consent ends when you leave, revoke it, the connection is interrupted, or the bot restarts. Rejoining requires fresh consent. ' +
          '**Stop my microphone** revokes your consent; **End recording** stops this session for everyone. Obtain consent from anyone audible through a shared microphone.\n\n' +
          'Recognition runs locally in English, during the call. After capture and accepted transcription work finish, a final participant/duration summary and transcript are posted here. ' +
          'Nonconsenting accounts are excluded from the transcript. Discord transports voice and retains posted messages; no extra STT provider receives private audio. ' +
          'Private audio is kept while processing/recovery is pending, then deleted. Normal local transcript/metadata retention is 24 hours after the session ends; crashes or unavailable storage can delay cleanup. ' +
          'Overload/outages are reported as incomplete, not silently complete. Long output follows the configured delivery policy.\n' +
          'Empty grace or inactivity closes capture. After inactivity, a fresh arrival or Start can create a new session, still needing fresh mic consent.',
        components: buttons(false, sessionPolicy(s)), allowedMentions: { parse: [] },
      };
      return this.deliver(s, 'notice', 'notice', payload, prior);
    });
  }
  startEligible(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session || session.phase === 'active' || session.holdUntilEmpty || !['inactivity', 'known_empty'].includes(session.stopReason)) return false;
    if (this.store.getControl().holdUntilEmpty) return false;
    const latest = this.store.listSessions().sort((a, b) => (a.lifecycleOrder || 0) - (b.lifecycleOrder || 0) || a.startedAt - b.startedAt).at(-1);
    return latest?.id === sessionId;
  }
  async disableKnownNotice(sessionId, record) {
    const closed = { ...record, state: 'closed', closeRequested: true, disabled: false };
    this.store.patchSession(sessionId, { notice: closed });
    let disabled = false, startEnabled = record.startEnabled === true;
    if (USER.test(closed.id)) {
      const session = this.store.getSession(sessionId);
      const reason = /^[a-z_]{1,64}$/.test(session.stopReason || '') ? session.stopReason : 'session_closed';
      const canStart = this.startEligible(sessionId);
      const content = '**Local recording for this session has stopped.**\n' +
        `Reason: ${reason}. No additional microphone audio is being accepted for this session.\n` +
        (canStart ? 'Not recording. After inactivity, a fresh member arrival (leave/rejoin works) can start a new meeting. While present, use **Start recording again** on the latest eligible notice as a fallback. Start does not resume paused microphones or grant manual consent. Polling/restart alone does not wake inactivity.\n' : '') +
        'This is a recording-status notice, not the final meeting summary. Accepted work must finish or be explicitly accounted for before the final summary is published. ' +
        'Use `/transcription-status` for draining, incomplete, or held-publication status. ' +
        (sessionPolicy(session) === 'channel' ? 'Fixed channel policy: known occupants may record automatically on restart/reconnect, but never through personal pauses, End or safety holds. A known empty channel clears End/personal pauses; safety stops require review.\n' : 'A new session needs fresh consent.\n') +
        (closed.marker ? `Ref: ${closed.marker}` : `Session: ${sessionId}`);
      try {
        await this.bounded(() => this.transport.edit(closed.id, { content, components: buttons(true, sessionPolicy(session), canStart), allowedMentions: { parse: [] } }));
        disabled = true; startEnabled = canStart;
        // A later session/End may win while PATCH acknowledgement is slow.
        // Serialize a corrective edit after it; never leave stale Start enabled.
        if (canStart && !this.startEligible(sessionId)) {
          await this.bounded(() => this.transport.edit(closed.id, { content, components: buttons(true, sessionPolicy(session)), allowedMentions: { parse: [] } }));
          startEnabled = false;
        }
      }
      catch { /* Exact active-session checks also reject stale enabled buttons. */ }
    }
    const latest = this.store.getSession(sessionId).notice;
    const result = { ...latest, state: 'closed', closeRequested: true, disabled: latest.disabled === true || disabled, startEnabled };
    this.store.patchSession(sessionId, { notice: result }); return result;
  }
  closeNotice(sessionId) {
    return this.single(`close:${sessionId}`, async () => {
      let old = this.store.getSession(sessionId).notice || { state: 'pending' };
      if (old.state === 'closed' && old.disabled && (!old.startEnabled || this.startEligible(sessionId))) return old;
      // Durable close intent precedes waiting for a concurrent send. Its result
      // cannot resurrect this prompt, even if acknowledgement arrives late.
      this.store.patchSession(sessionId, { notice: { ...old, closeRequested: true } });
      try { await this.inflight.get(`notice:${sessionId}`); } catch { /* reconcile below */ }
      old = this.store.getSession(sessionId).notice;
      if (old.state === 'closed' && old.disabled && (!old.startEnabled || this.startEligible(sessionId))) return old;
      let id = old.id;
      if (!USER.test(id) && old.marker) id = await this.find(old, 1);
      return this.disableKnownNotice(sessionId, { ...old, ...(id ? { id } : {}) });
    });
  }
  publish(sessionId) {
    return this.single(`final:${sessionId}`, async () => {
      const s = this.store.getSession(sessionId), prior = s.publication || { state: 'pending' };
      if (prior.state === 'sent') return prior;
      let payload;
      try { payload = finalPayload(s, this.store.listJobs(sessionId), { allowAttachments: this.allowAttachments }); }
      catch (e) {
        if (!['ATTACHMENT_APPROVAL_REQUIRED', 'TRANSCRIPT_OUTPUT_LIMIT', 'SUMMARY_OUTPUT_LIMIT', 'JOB_OUTPUT_LIMIT'].includes(e.safeCode)) throw e;
        // If a send might already have happened, preserve its reconciliation data.
        const record = ['sending', 'uncertain'].includes(prior.state) ? { ...prior, state: 'uncertain', reason: 'PAYLOAD_CHANGED_AFTER_SEND_INTENT' } : { state: 'held', reason: e.safeCode, heldAt: this.now() };
        this.store.patchSession(sessionId, { publication: record }); return record;
      }
      if (prior.state === 'held' && prior.reason !== 'ATTACHMENT_APPROVAL_REQUIRED') return prior;
      return this.deliver(s, 'publication', 'final', payload, prior);
    });
  }
  async deliver(session, field, kind, plain, prior) {
    const identity = addIdentity(plain, kind, session.id);
    if (['sending', 'uncertain'].includes(prior.state)) {
      if (prior.payloadHash !== identity.hash || prior.marker !== identity.marker) {
        const record = { ...prior, state: 'uncertain', reason: 'PAYLOAD_CHANGED_AFTER_SEND_INTENT' };
        this.store.patchSession(session.id, { [field]: record }); return record;
      }
      const found = await this.find(prior);
      if (found) {
        // The history port authenticates inline content. It cannot verify the
        // attachment bytes, so attachment delivery ambiguity requires review.
        if (plain.files?.length) {
          const record = { ...prior, state: 'uncertain', id: found, reason: 'ATTACHMENT_RECONCILIATION_REQUIRES_REVIEW' };
          this.store.patchSession(session.id, { [field]: record }); return record;
        }
        const record = { ...prior, state: 'sent', id: found, reconciledAt: this.now() };
        this.store.patchSession(session.id, { [field]: record, ...(field === 'publication' ? { phase: 'published' } : {}) }); return record;
      }
      const record = { ...prior, state: 'uncertain', reason: 'SEND_UNCERTAIN_NO_AUTOMATIC_RETRY' };
      this.store.patchSession(session.id, { [field]: record }); return record;
    }
    const intent = { state: 'sending', nonce: identity.nonce, marker: identity.marker, payloadHash: identity.hash, expectedContent: identity.payload.content, startedAt: this.now() };
    this.store.patchSession(session.id, { [field]: intent }); // durable BEFORE HTTP
    let response, timedOut = false;
    const sending = Promise.resolve().then(() => this.transport.send(identity.payload));
    // A broken/late transport may settle after our deadline. Retain ownership of
    // notice closure without treating a deadline as proof of remote rejection.
    const continuation = sending.then(result => {
      if (timedOut && field === 'notice' && USER.test(result?.id)) {
        const latest = this.store.getSession(session.id).notice;
        if (latest.closeRequested) return this.disableKnownNotice(session.id, { ...latest, id: result.id });
      }
    }).catch(() => {}).finally(() => this.continuations.delete(continuation));
    this.continuations.add(continuation);
    try { response = await this.bounded(() => sending); }
    catch {
      timedOut = true;
      const latest = this.store.getSession(session.id)[field];
      const record = { ...intent, ...(latest.closeRequested ? { closeRequested: true } : {}), state: latest.closeRequested ? 'closed' : 'uncertain', reason: 'SEND_UNCERTAIN_NO_AUTOMATIC_RETRY' };
      this.store.patchSession(session.id, { [field]: record }); return record;
    }
    if (!USER.test(response?.id)) {
      const record = { ...intent, state: 'uncertain', reason: 'SEND_RESPONSE_UNCONFIRMED' };
      this.store.patchSession(session.id, { [field]: record }); return record;
    }
    // A crash/write failure here leaves durable sending intent. Startup finds the
    // already-created bot message by marker, rather than creating a duplicate.
    const record = { ...intent, state: 'sent', id: response.id, sentAt: this.now() };
    if (field === 'notice' && this.store.getSession(session.id).notice.closeRequested) return this.disableKnownNotice(session.id, record);
    this.store.patchSession(session.id, { [field]: record, ...(field === 'publication' ? { phase: 'published' } : {}) });
    return record;
  }
}
module.exports = { Publisher, finalPayload, safeText, duration, offset, payloadHash, addIdentity, buttons };
