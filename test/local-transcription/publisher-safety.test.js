'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Publisher, finalPayload } = require('../../src/features/local-transcription/publisher');
const BOT = '1465236568536252527', USER = '1465125548379607094';
function fixture() {
  const records = new Map(), jobs = new Map();
  const store = { getSession: id => structuredClone(records.get(id)), listJobs: id => structuredClone(jobs.get(id)),
    patchSession(id, patch) { Object.assign(records.get(id), structuredClone(patch)); return this.getSession(id); } };
  function add(id = 'session-a', phase = 'ready') {
    records.set(id, { schema: 1, id, startedAt: 0, endedAt: phase === 'ready' ? 10000 : null, phase,
      participants: { [USER]: { id: USER, name: 'Person', durationMs: 10000, everConsented: true } }, issues: [], notice: { state: 'pending' }, publication: { state: 'pending' } });
    jobs.set(id, [{ schema: 1, id: 'job-a', sessionId: id, userId: USER, bytes: 192000, startMs: 0, sequence: 1, state: 'recognized', text: 'Recognized speech.' }]);
  }
  const port = { botUserId: BOT, messages: [], sends: 0, edits: [], reads: 0,
    async send(payload) { this.sends++; const id = String(1560398382244036720n + BigInt(this.sends)); this.messages.unshift({ id, content: payload.content, authorId: BOT }); return { id }; },
    async edit(id, payload) { this.edits.push({ id, payload }); },
    async history() { this.reads++; return this.messages; },
  };
  add(); return { store, port, records, jobs, add };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('nonboolean attachment permission is rejected, including string false', () => {
  const f = fixture();
  for (const value of ['false', 'true', 1, {}, []]) {
    assert.throws(() => new Publisher({ store: f.store, transport: f.port, allowAttachments: value }), /INVALID_ATTACHMENT_APPROVAL/);
    assert.throws(() => finalPayload(f.store.getSession('session-a'), f.store.listJobs('session-a'), { allowAttachments: value }), /INVALID_ATTACHMENT_APPROVAL/);
  }
});
test('recognized job inconsistent with no prior consent fails closed before HTTP', async () => {
  const f = fixture(); f.records.get('session-a').participants[USER].everConsented = false;
  await assert.rejects(new Publisher({ store: f.store, transport: f.port }).publish('session-a'), /JOB_WITHOUT_CONSENT/);
  assert.equal(f.port.sends, 0);
});
test('marker preserved but body edited cannot resolve an uncertain canonical send', async () => {
  const f = fixture(), original = f.port.send;
  f.port.send = async payload => { await original.call(f.port, payload); throw Error('lost acknowledgement'); };
  const pub = new Publisher({ store: f.store, transport: f.port }); await pub.publish('session-a');
  const marker = f.port.messages[0].content.slice(f.port.messages[0].content.lastIndexOf('\nRef: '));
  f.port.messages[0].content = 'Transcript removed by another actor.' + marker;
  const result = await pub.publish('session-a'); assert.equal(result.state, 'uncertain'); assert.equal(f.port.sends, 1);
});
test('attachment ambiguity remains for review: content-only history cannot verify attachment bytes', async () => {
  const f = fixture(), original = f.port.send; f.jobs.get('session-a')[0].text = 'Long transcript. '.repeat(500);
  f.port.send = async payload => { await original.call(f.port, payload); throw Error('lost acknowledgement'); };
  const pub = new Publisher({ store: f.store, transport: f.port, allowAttachments: true }); await pub.publish('session-a');
  const result = await pub.publish('session-a'); assert.equal(result.state, 'uncertain');
  assert.equal(result.reason, 'ATTACHMENT_RECONCILIATION_REQUIRES_REVIEW'); assert.equal(f.port.sends, 1);
});
test('closing during an outstanding notice cannot resurrect enabled consent', async () => {
  const f = fixture(); f.add('session-a', 'active'); const original = f.port.send; let release;
  f.port.send = payload => new Promise(resolve => { release = async () => resolve(await original.call(f.port, payload)); });
  const pub = new Publisher({ store: f.store, transport: f.port });
  const creating = pub.notice('session-a'); await settle(); const closing = pub.closeNotice('session-a'); await settle();
  assert.equal(f.records.get('session-a').notice.closeRequested, true); await release();
  await Promise.all([creating, closing]); assert.equal(f.records.get('session-a').notice.state, 'closed');
  assert.equal(f.records.get('session-a').notice.disabled, true); assert.ok(f.port.edits.every(x => x.payload.components[0].components.every(b => b.disabled)));
});
test('notice accepted after timeout/closure is still disabled when late acknowledgement arrives', async () => {
  const f = fixture(); f.add('session-a', 'active'); const original = f.port.send; let release;
  f.port.send = payload => new Promise(resolve => { release = async () => resolve(await original.call(f.port, payload)); });
  const pub = new Publisher({ store: f.store, transport: f.port, requestMs: 10 });
  await pub.notice('session-a'); await pub.closeNotice('session-a'); assert.equal(f.records.get('session-a').notice.state, 'closed');
  await release(); await settle(); await settle();
  assert.equal(f.records.get('session-a').notice.state, 'closed'); assert.equal(f.records.get('session-a').notice.disabled, true); assert.equal(f.port.sends, 1);
});
test('bounded history pagination can reconcile on page two without resend', async () => {
  const f = fixture(), original = f.port.send;
  f.port.send = async payload => { await original.call(f.port, payload); throw Error('lost ack'); };
  const pub = new Publisher({ store: f.store, transport: f.port }); await pub.publish('session-a');
  const fillers = Array.from({ length: 100 }, (_, i) => ({ id: String(1560398382244040000n - BigInt(i)), authorId: BOT, content: 'Unrelated message' }));
  f.port.history = async options => { f.port.reads++; return options.before ? f.port.messages : fillers; };
  assert.equal((await pub.publish('session-a')).state, 'sent'); assert.equal(f.port.reads, 2); assert.equal(f.port.sends, 1);
});
test('history exhaustion and repeated cursors are bounded and never cause resend', async () => {
  const f = fixture(); f.port.send = async () => { f.port.sends++; throw Error('unknown'); };
  const pub = new Publisher({ store: f.store, transport: f.port, historyPages: 3 }); await pub.publish('session-a');
  f.port.history = async () => { f.port.reads++; return Array.from({ length: 100 }, (_, i) => ({ id: String(1560398382244040000n - BigInt(f.port.reads * 100 + i)), authorId: BOT, content: 'Unrelated' })); };
  await pub.publish('session-a'); assert.equal(f.port.reads, 3); assert.equal(f.port.sends, 1);
  f.port.reads = 0; const rows = await f.port.history(); f.port.reads = 0; f.port.history = async () => { f.port.reads++; return rows; };
  await pub.publish('session-a'); assert.equal(f.port.reads, 2); assert.equal(f.port.sends, 1);
});
test('independent sessions publish without waiting for another session HTTP response', async () => {
  const f = fixture(); f.add('session-b'); const original = f.port.send; let release;
  f.port.send = payload => payload.content.includes('local-final:session-a:') ? new Promise(resolve => { release = async () => resolve(await original.call(f.port, payload)); }) : original.call(f.port, payload);
  const pub = new Publisher({ store: f.store, transport: f.port }), a = pub.publish('session-a'); await settle();
  const b = await pub.publish('session-b'); assert.equal(b.state, 'sent'); assert.equal(f.records.get('session-a').publication.state, 'sending');
  f.store.patchSession('session-a', { unrelatedMetadata: 'preserve me' }); await release(); await a;
  assert.equal(f.records.get('session-a').unrelatedMetadata, 'preserve me'); assert.equal(f.records.get('session-a').publication.state, 'sent'); assert.equal(f.port.sends, 2);
});
