'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Publisher, finalPayload, safeText, duration } = require('../../src/features/local-transcription/publisher');
const BOT = '1465236568536252527', USER = '1465125548379607094', OTHER = '1465125550036090883';
function session() {
  return { schema: 1, id: 'session-a', startedAt: 10000, endedAt: 40000, phase: 'ready', lastSeenAt: 40000,
    participants: { [USER]: { id: USER, name: 'A @everyone `name`', joinedAt: null, durationMs: 30000, everConsented: true, consented: false } },
    issues: [], notice: { state: 'pending' }, publication: { state: 'pending' } };
}
function job(overrides = {}) { return { schema: 1, id: 'job-a', sessionId: 'session-a', userId: USER, sequence: 1, startMs: 500, bytes: 192000, state: 'recognized', text: 'Hello there.', ...overrides }; }
class MemoryStore {
  constructor(s = session(), jobs = [job()]) { this.s = structuredClone(s); this.jobs = structuredClone(jobs); this.writes = []; }
  getSession(id) { assert.equal(id, this.s.id); return structuredClone(this.s); }
  listJobs(id) { assert.equal(id, this.s.id); return structuredClone(this.jobs); }
  patchSession(id, patch) {
    assert.equal(id, this.s.id);
    if (this.failIntent && patch.publication?.state === 'sending') throw Error('disk full');
    if (this.failSent && patch.publication?.state === 'sent') throw Error('crash after HTTP');
    this.writes.push(structuredClone(patch)); Object.assign(this.s, structuredClone(patch));
    return this.getSession(id);
  }
}
function transport() {
  return { botUserId: BOT, messages: [], sends: 0, edits: [], reads: 0,
    async send(payload) {
      this.sends++; const id = String(1560398382244036720n + BigInt(this.sends));
      this.messages.unshift({ id, authorId: BOT, content: payload.content, createdTimestamp: 50000 });
      this.lastPayload = payload; return { id };
    },
    async history() { this.reads++; return this.messages; },
    async edit(id, payload) { this.edits.push({ id, payload }); },
  };
}
test('one completed inline summary has durations, safe transcript, stable nonce and no pings', async () => {
  const store = new MemoryStore(), port = transport(), pub = new Publisher({ store, transport: port });
  const result = await pub.publish('session-a');
  assert.equal(result.state, 'sent'); assert.equal(store.s.phase, 'published');
  assert.equal(port.sends, 1); assert.match(port.lastPayload.content, /30s/); assert.match(port.lastPayload.content, /Hello there/);
  assert.equal(port.lastPayload.enforceNonce, true); assert.equal(port.lastPayload.nonce.length, 24);
  assert.deepEqual(port.lastPayload.allowedMentions, { parse: [] });
  assert.match(port.lastPayload.content, /Ref: local-final:session-a:[a-f0-9]{64}$/);
  assert.ok(port.lastPayload.content.length < 2000);
  await pub.publish('session-a'); assert.equal(port.sends, 1);
});
test('no canonical send before session ready or while any accepted work remains', async () => {
  const store = new MemoryStore({ ...session(), phase: 'draining' }), port = transport(), pub = new Publisher({ store, transport: port });
  await assert.rejects(pub.publish('session-a'), /TRANSCRIPTION_NOT_READY/);
  store.s.phase = 'ready'; store.jobs[0].state = 'running';
  await assert.rejects(pub.publish('session-a'), /TRANSCRIPTION_NOT_READY/); assert.equal(port.sends, 0);
});
test('concurrent finalization calls share one send', async () => {
  const store = new MemoryStore(), port = transport(), pub = new Publisher({ store, transport: port });
  await Promise.all([pub.publish('session-a'), pub.publish('session-a'), pub.publish('session-a')]);
  assert.equal(port.sends, 1);
});
test('durable intent failure prevents HTTP send entirely', async () => {
  const store = new MemoryStore(), port = transport(); store.failIntent = true;
  await assert.rejects(new Publisher({ store, transport: port }).publish('session-a'), /disk full/); assert.equal(port.sends, 0);
});
test('crash after successful remote send reconciles author and marker without resend', async () => {
  const store = new MemoryStore(), port = transport(); store.failSent = true;
  await assert.rejects(new Publisher({ store, transport: port }).publish('session-a'), /crash after HTTP/);
  assert.equal(store.s.publication.state, 'sending'); assert.equal(port.sends, 1);
  store.failSent = false;
  const result = await new Publisher({ store, transport: port }).publish('session-a');
  assert.equal(result.state, 'sent'); assert.ok(result.reconciledAt); assert.equal(port.sends, 1);
});
test('HTTP failure/unknown delivery is held uncertain even when history is empty', async () => {
  const store = new MemoryStore(), port = transport();
  port.send = async function () { this.sends++; throw Error('PRIVATE HTTP PAYLOAD MUST NOT ESCAPE'); };
  const pub = new Publisher({ store, transport: port });
  assert.equal((await pub.publish('session-a')).state, 'uncertain');
  assert.equal((await pub.publish('session-a')).state, 'uncertain'); assert.equal(port.sends, 1);
  assert.equal(store.s.publication.reason, 'SEND_UNCERTAIN_NO_AUTOMATIC_RETRY');
});
test('remote message accepted before network timeout is later reconciled, not duplicated', async () => {
  const store = new MemoryStore(), port = transport(), original = port.send;
  port.send = async function (payload) { await original.call(this, payload); throw Error('lost acknowledgement'); };
  const pub = new Publisher({ store, transport: port }); await pub.publish('session-a');
  assert.equal((await pub.publish('session-a')).state, 'sent'); assert.equal(port.sends, 1);
});
test('a forged author or partial marker cannot resolve uncertain send', async () => {
  const store = new MemoryStore(), port = transport(), original = port.send;
  port.send = async function (payload) { await original.call(this, payload); throw Error('lost ack'); };
  const pub = new Publisher({ store, transport: port }); await pub.publish('session-a');
  port.messages[0].authorId = OTHER;
  await pub.publish('session-a'); assert.equal(store.s.publication.state, 'uncertain');
  port.messages[0].authorId = BOT; port.messages[0].content += ' copied fragment';
  await pub.publish('session-a'); assert.equal(store.s.publication.state, 'uncertain'); assert.equal(port.sends, 1);
});
test('history errors never trigger a resend', async () => {
  const store = new MemoryStore(), port = transport();
  port.send = async () => { throw Error('network'); }; const pub = new Publisher({ store, transport: port }); await pub.publish('session-a');
  port.history = async () => { throw Error('permissions'); };
  assert.equal((await pub.publish('session-a')).state, 'uncertain');
});
test('changed payload after send intent cannot be silently republished', async () => {
  const store = new MemoryStore(), port = transport(); port.send = async () => { throw Error('unknown'); };
  const pub = new Publisher({ store, transport: port }); await pub.publish('session-a'); store.jobs[0].text = 'Different content';
  await pub.publish('session-a'); assert.equal(store.s.publication.reason, 'PAYLOAD_CHANGED_AFTER_SEND_INTENT');
});
test('long output requires explicit attachment opt-in and sends no blank placeholder', async () => {
  const store = new MemoryStore(session(), [job({ text: 'Long words. '.repeat(400) })]), port = transport();
  const held = await new Publisher({ store, transport: port }).publish('session-a');
  assert.equal(held.state, 'held'); assert.equal(held.reason, 'ATTACHMENT_APPROVAL_REQUIRED'); assert.equal(port.sends, 0);
  const sent = await new Publisher({ store, transport: port, allowAttachments: true }).publish('session-a');
  assert.equal(sent.state, 'sent'); assert.equal(port.sends, 1); assert.equal(port.lastPayload.files.length, 1);
  assert.match(port.lastPayload.files[0].name, /^meeting-transcript-session-a\.txt$/);
  assert.ok(Buffer.isBuffer(port.lastPayload.files[0].attachment));
  assert.match(port.lastPayload.files[0].attachment.toString(), /Long words/); assert.match(port.lastPayload.content, /Participants and duration/);
});
test('result ordering is capture-time then sequence, not completion order', () => {
  const payload = finalPayload(session(), [job({ id: 'job-late', sequence: 2, startMs: 5000, text: 'LATER' }), job({ text: 'EARLIER' })]);
  assert.ok(payload.content.indexOf('EARLIER') < payload.content.indexOf('LATER'));
});
test('failed and cancelled work are explicit gaps with INCOMPLETE status', () => {
  const payload = finalPayload(session(), [job({ state: 'failed', issue: 'LOCAL_JOB_FAILED' })]);
  assert.match(payload.content, /Status:\*\* INCOMPLETE/); assert.match(payload.content, /INCOMPLETE: LOCAL_JOB_FAILED/);
});
test('nonconsenting meeting is not an empty transcript and no-observed-audio is incomplete', () => {
  const s = session(); s.participants[USER].everConsented = false;
  assert.match(finalPayload(s, []).content, /No recording: no participants consented/);
  s.participants[USER].everConsented = true;
  assert.match(finalPayload(s, []).content, /NO_AUDIO_OBSERVED/);
});
test('only exact no-speech jobs are labelled as silence; empty recognition is incomplete', () => {
  assert.match(finalPayload(session(), [job({ state: 'no_speech', text: undefined })]).content, /exact-zero audio/);
  assert.match(finalPayload(session(), [job({ text: '  ' })]).content, /EMPTY_RECOGNITION/);
});
test('untrusted transcript mentions, fences and controls are neutralized', () => {
  const payload = finalPayload(session(), [job({ text: '@everyone ```\u0001\u202e end' })]);
  assert.ok(!payload.content.includes('@everyone')); assert.ok(!payload.content.includes('\u0001')); assert.ok(!payload.content.includes('\u202e'));
  assert.equal(payload.content.split('```').length - 1, 2);
  assert.equal(safeText('@a`\u0000'), '@\u200baˋ'); assert.equal(duration(3661000), '1h 1m 1s');
});
test('malformed session/account/job paths are rejected before publication', () => {
  const s = session(); s.id = '../escape'; assert.throws(() => finalPayload(s, []), /INVALID_FINAL_SESSION/);
  assert.throws(() => finalPayload(session(), [job({ userId: '../wrong' })]), /INVALID_FINAL_JOB/);
  assert.throws(() => finalPayload(session(), [job({ startMs: -1 })]), /INVALID_JOB_OFFSET/);
});
test('notice consent, privacy, no-auto-resume and static controls; close is idempotent', async () => {
  const s = { ...session(), phase: 'active', endedAt: null }, store = new MemoryStore(s, []), port = transport(), pub = new Publisher({ store, transport: port });
  const notice = await pub.notice('session-a'); assert.equal(notice.state, 'sent');
  assert.match(port.lastPayload.content, /Joining alone is NOT consent/); assert.match(port.lastPayload.content, /Rejoining requires fresh consent/);
  assert.match(port.lastPayload.content, /shared microphone/); assert.match(port.lastPayload.content, /24 hours/);
  assert.equal(port.lastPayload.components[0].components.length, 4);
  assert.equal(port.lastPayload.components[0].components.at(-1).disabled, true);
  assert.ok(port.lastPayload.content.length <= 2000);
  assert.match(port.lastPayload.content, /Presence\/duration metadata is tracked for all participants/);
  await pub.notice('session-a'); assert.equal(port.sends, 1);
  await pub.closeNotice('session-a'); await pub.closeNotice('session-a'); assert.equal(port.edits.length, 1);
  assert.ok(port.edits[0].payload.components[0].components.every(b => b.disabled));
});
test('channel notice is automatic with one person and policy-correct static Resume/Stop/End controls', async () => {
  const s = { ...session(), consentMode: 'channel', phase: 'active', endedAt: null };
  const store = new MemoryStore(s, []), port = transport(), pub = new Publisher({ store, transport: port });
  await pub.notice(s.id);
  const payload = port.lastPayload;
  assert.ok(payload.content.length <= 2000, payload.content.length);
  for (const text of ['standing company consent', 'including guests', 'shared microphones', 'automatically with one person',
    'no button or notice acknowledgement is required', 'startup/restart', 'gateway reconnect', 'at most 4 hours',
    'across leave/rejoin and restart', 'known empty', '24 hours', 'pause account IDs persist']) assert.ok(payload.content.includes(text), text);
  assert.doesNotMatch(payload.content, /Joining alone is NOT consent|clicks \*\*I consent|Rejoining requires fresh consent/);
  assert.deepEqual(payload.components[0].components.map(b => [b.custom_id, b.label]), [
    ['local_transcription_consent', 'Resume my microphone'], ['local_transcription_revoke', 'Stop my microphone'], ['local_transcription_end', 'End recording'],
    ['local_transcription_start', 'Start recording again'],
  ]);
  await pub.closeNotice(s.id);
  const closed = port.edits.at(-1).payload;
  assert.match(closed.content, /Fixed channel policy/);
  assert.match(closed.content, /never through personal pauses, End or safety holds/);
  assert.doesNotMatch(closed.content, /new session needs fresh consent/);
  assert.equal(closed.components[0].components[0].label, 'Resume my microphone');
  assert.ok(closed.components[0].components.every(b => b.disabled));
});
test('legacy missing policy and explicit manual use identical manual notices, finals and closed labels', async () => {
  const legacy = new MemoryStore(), manual = new MemoryStore({ ...session(), consentMode: 'manual' });
  assert.deepEqual(finalPayload(legacy.s, legacy.jobs), finalPayload(manual.s, manual.jobs));
  const payloads = [], closures = [];
  for (const store of [legacy, manual]) {
    store.s.phase = 'active'; const port = transport(), pub = new Publisher({ store, transport: port });
    await pub.notice(store.s.id); payloads.push(port.lastPayload);
    await pub.closeNotice(store.s.id); closures.push(port.edits[0].payload);
  }
  assert.deepEqual(payloads[0], payloads[1]); assert.deepEqual(closures[0], closures[1]);
  assert.equal(payloads[0].components[0].components[0].label, 'I consent: record my mic');
  assert.match(closures[0].content, /new session needs fresh consent/);
});
test('channel final attributes authorization to persisted company policy, not meeting button clicks', async () => {
  const store = new MemoryStore({ ...session(), consentMode: 'channel' }), port = transport();
  await new Publisher({ store, transport: port }).publish(store.s.id);
  assert.match(port.lastPayload.content, /authorized at least once under administrator-confirmed company standing consent \(channel policy\)/);
  assert.match(port.lastPayload.content, /no per-meeting click is required/);
  assert.doesNotMatch(port.lastPayload.content, /account\(s\) consented at least once|clicked|I consent/);
  assert.ok(port.lastPayload.content.length <= 2000);
  store.s.participants[USER].everConsented = false;
  assert.match(finalPayload(store.s, []).content, /no participants authorized/);
});
test('publisher rejects invalid persisted policy before sending any notice or final', async () => {
  for (const value of ['', 'CHANNEL', null, true]) {
    const store = new MemoryStore({ ...session(), consentMode: value }), port = transport(), pub = new Publisher({ store, transport: port });
    await assert.rejects(pub.notice(store.s.id), /INVALID_CONSENT_MODE/);
    await assert.rejects(pub.publish(store.s.id), /INVALID_CONSENT_MODE/);
    assert.equal(port.sends, 0);
  }
});
test('channel notice uncertainty preserves its persisted policy and reconciles without another send', async () => {
  const store = new MemoryStore({ ...session(), consentMode: 'channel', phase: 'active', endedAt: null }), port = transport(), original = port.send;
  port.send = async function (payload) { await original.call(this, payload); throw Error('lost ack'); };
  const pub = new Publisher({ store, transport: port });
  assert.equal((await pub.notice(store.s.id)).state, 'uncertain');
  assert.equal((await new Publisher({ store, transport: port }).notice(store.s.id)).state, 'sent');
  assert.equal(port.sends, 1); assert.match(port.lastPayload.content, /automatic company consent/);
});
test('notice send ambiguity is reconciled without creating a second consent prompt', async () => {
  const s = { ...session(), phase: 'active', endedAt: null }, store = new MemoryStore(s, []), port = transport(), original = port.send;
  port.send = async function (payload) { await original.call(this, payload); throw Error('lost ack'); };
  const pub = new Publisher({ store, transport: port });
  assert.equal((await pub.notice('session-a')).state, 'uncertain');
  assert.equal((await pub.notice('session-a')).state, 'sent'); assert.equal(port.sends, 1);
});
test('a hung transport is bounded and late acceptance is reconciled on next call', async () => {
  const store = new MemoryStore(), port = transport(), original = port.send; let release;
  port.send = payload => new Promise(resolve => { release = async () => resolve(await original.call(port, payload)); });
  const pub = new Publisher({ store, transport: port, requestMs: 10 });
  assert.equal((await pub.publish('session-a')).state, 'uncertain'); await release();
  assert.equal((await pub.publish('session-a')).state, 'sent'); assert.equal(port.sends, 1);
});
