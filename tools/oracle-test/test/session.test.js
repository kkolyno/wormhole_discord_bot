'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { MicTest, LIMITS, NOTICE, safeText } = require('../session');
const { TARGET } = require('../config');
const { Capture } = require('../../feasibility/capture');
const { UtteranceWorker } = require('../local-stt');
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  assert.fail('condition not reached'); }
class FakeAdapter extends EventEmitter {
  constructor() {
    super(); this.calls = []; this.messages = []; this.members = new Set(); this.subscriptions = []; this.streams = new Map();
    this.receiver = { speaking: new EventEmitter(), subscribe: (id, options) => {
      this.subscriptions.push(id); assert.equal(options.end.behavior, 0);
      const stream = new Readable({ read() {} }); this.streams.set(id, stream); return stream;
    } };
  }
  async initialize() { this.calls.push('initialize'); }
  async notice(payload) { this.calls.push('notice'); this.noticePayload = payload; return { id: 'notice', author: { id: TARGET.application } }; }
  async result(payload) { this.calls.push('result'); this.messages.push(payload); }
  async ack(i, text) { this.acks ||= []; this.acks.push([i.user.id, text]); }
  async inVoice(id) { return this.members.has(id); }
  async join(owner) { this.calls.push('join'); this.owner = owner; return this.receiver; }
  disconnect() { this.calls.push('disconnect'); }
  async destroy() { this.calls.push('destroy'); }
  async disableNotice(_message, components) { this.components = components; }
  speak(id, pcm = Buffer.alloc(8)) { this.receiver.speaking.emit('start', id); this.streams.get(id)?.push(pcm); }
}
async function fixture(t, options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-session-')); fs.chmodSync(data, 0o700);
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const adapter = options.adapter || new FakeAdapter();
  const session = new MicTest({ adapter, config: { ...TARGET, data },
    captureFactory: o => new Capture({ ...o, decoderFactory: () => ({ decode: p => Buffer.from(p), close() {} }) }),
    workerFactory: o => new UtteranceWorker({ ...o, quietMs: 15, recognize: async () => 'hello @everyone <@123> `words`' }),
    limits: { startupMs: 1000, armMs: 2000, voiceStartupMs: 1000, recordMs: 2000, drainMs: 100, postMs: 100, cleanupMs: 100 }, ...options });
  const done = session.run(); await until(() => session.state === 'waiting' || session.state === 'closed');
  const user = '111111111111111111', other = '222222222222222222';
  const interaction = (action, id = user, overrides = {}) => ({ isButton: () => true, guildId: TARGET.guild,
    channelId: TARGET.alerts, message: { id: 'notice', author: { id: TARGET.application } },
    customId: `${session.id}:${action}`, user: { id, bot: false }, ...overrides });
  return { adapter, session, done, interaction, user, other, data };
}

test('notice discloses scope/local STT/Discord publication; no voice join/subscriptions before explicit consent', async t => {
  const f = await fixture(t);
  f.adapter.speak(f.user); f.adapter.speak(f.other); assert.deepEqual(f.adapter.subscriptions, []);
  assert.equal(f.adapter.calls.includes('join'), false);
  assert.match(NOTICE, /ONLY the person clicking Start/); assert.match(NOTICE, /transcript.*posted/);
  assert.match(NOTICE, /no external STT/); assert.match(NOTICE, /Discord already transports/);
  assert.deepEqual(f.adapter.noticePayload.allowedMentions, { parse: [] });
  await f.session.handle(f.interaction('cancel')); await f.done;
  assert.equal(f.adapter.calls.includes('join'), false); assert.deepEqual(f.adapter.subscriptions, []);
  assert.match(f.adapter.messages[0].content, /not recorded/);
});

test('interaction guild/channel/message/author/custom ID/user must match; non-target member denied', async t => {
  const f = await fixture(t); f.adapter.members.add(f.user);
  for (const change of [{ guildId: 'wrong' }, { channelId: 'wrong' }, { message: { id: 'wrong', author: { id: TARGET.application } } },
    { message: { id: 'notice', author: { id: 'wrong' } } }, { customId: 'wrong:start' }, { user: { id: f.user, bot: true } },
    { user: { id: 'not-an-id' } }, { isButton: () => false }]) {
    await f.session.handle(f.interaction('start', f.user, change)); assert.equal(f.session.state, 'waiting');
  }
  await f.session.handle(f.interaction('start', f.other));
  assert.equal(f.session.state, 'waiting'); assert.match(f.adapter.acks.at(-1)[1], /denied/);
  assert.equal(f.adapter.calls.includes('join'), false);
  await f.session.stop('test_cancel');
});

test('consent restricts interleaved speakers at facade; only owner can stop; final buffered EOF accepted and published after drain', async t => {
  let release, recognitionStarted = false;
  const f = await fixture(t, { workerFactory: o => new UtteranceWorker({ ...o, quietMs: 10,
    recognize: () => { recognitionStarted = true; return new Promise(r => { release = r; }); } }) });
  f.adapter.members.add(f.user); f.adapter.members.add(f.other);
  await f.session.handle(f.interaction('start'));
  assert.equal(f.session.state, 'recording'); f.adapter.speak(f.other); f.adapter.speak(f.user); await tick();
  f.adapter.speak(f.other); await f.session.handle(f.interaction('stop', f.other));
  assert.equal(f.session.state, 'recording'); assert.deepEqual(f.adapter.subscriptions, [f.user]);
  const stream = f.adapter.streams.get(f.user); stream.pause(); stream.push(Buffer.alloc(12, 1));
  await f.session.handle(f.interaction('stop')); await until(() => recognitionStarted);
  assert.equal(f.adapter.messages.length, 0); assert.equal(f.session.state, 'draining');
  release('final @everyone <@111111111111111111>'); await f.done;
  assert.equal(f.adapter.messages.length, 1); assert.deepEqual(f.adapter.messages[0].allowedMentions, { parse: [] });
  assert.match(f.adapter.messages[0].content, /Accepted PCM: 20 bytes; accounted: 20/);
  assert.match(f.adapter.messages[0].content, /NONCANONICAL/); assert.ok(!f.adapter.messages[0].content.includes('@everyone'));
  assert.match(f.adapter.messages[0].content, /Consenting Discord account ID \(no ping\): 111111111111111111/);
  assert.equal(f.adapter.receiver.speaking.listenerCount('start'), 0);
  assert.ok(f.adapter.components[0].components.every(b => b.disabled));
  assert.deepEqual(fs.readdirSync(f.data), ['outcome.json']);
  const outcome = fs.readFileSync(path.join(f.data, 'outcome.json'), 'utf8');
  assert.ok(!outcome.includes('final')); assert.ok(!outcome.includes(f.user)); assert.equal(JSON.parse(outcome).pcmBytes, 20);
  assert.equal(fs.statSync(path.join(f.data, 'outcome.json')).mode & 0o777, 0o600);
});

test('owner already speaking during join gets a primed Manual stream and next packet without another start; others never subscribed', async t => {
  const adapter = new FakeAdapter(); let ready;
  adapter.join = async () => {
    adapter.calls.push('join');
    // Events happen during the handshake, before MicTest has a receiver facade.
    adapter.receiver.speaking.emit('start', '111111111111111111');
    adapter.receiver.speaking.emit('start', '222222222222222222');
    await new Promise(r => { ready = r; }); return adapter.receiver;
  };
  const f = await fixture(t, { adapter }); adapter.members.add(f.user);
  const start = f.session.handle(f.interaction('start')); await until(() => ready);
  assert.deepEqual(adapter.subscriptions, []); assert.equal(f.session.readyAt, undefined);
  ready(); await start;
  assert.ok(f.session.capture instanceof Capture);
  assert.deepEqual(adapter.subscriptions, [f.user]);
  // No more owner speaking.start events: this is the next continuing packet.
  adapter.streams.get(f.user).push(Buffer.alloc(12, 1));
  adapter.speak(f.other, Buffer.alloc(16, 2)); await tick();
  assert.equal(adapter.streams.has(f.other), false);
  assert.equal(f.session.capture.pcmBytes, 12);
  assert.deepEqual([...f.session.capture.speakers.keys()], [f.user]);
  await f.session.stop('test_end');
  assert.equal(f.session.outcome.pcmBytes, 12);
  assert.deepEqual(adapter.subscriptions, [f.user]);
  assert.match(adapter.messages[0].content, /Accepted PCM: 12 bytes; accounted: 12/);
});

test('simultaneous start contenders cannot consent another speaker; cancel while recording cannot stop owner', async t => {
  const f = await fixture(t); f.adapter.members.add(f.user); f.adapter.members.add(f.other);
  await Promise.all([f.session.handle(f.interaction('start')), f.session.handle(f.interaction('start', f.other))]);
  assert.equal(f.adapter.calls.filter(x => x === 'join').length, 1); assert.equal(f.session.owner, f.user);
  await f.session.handle(f.interaction('cancel', f.other)); assert.equal(f.session.state, 'recording');
  f.adapter.speak(f.other); assert.deepEqual(f.adapter.subscriptions, [f.user]); await f.session.stop('test_end');
});

test('any matching user may cancel waiting; cancel takes effect before acknowledgement await and cannot race Start', async t => {
  const f = await fixture(t); f.adapter.members.add(f.user);
  let release; f.adapter.ack = () => new Promise(r => { release = r; });
  const cancelled = f.session.handle(f.interaction('cancel', f.other));
  await f.session.handle(f.interaction('start')); assert.equal(f.adapter.calls.includes('join'), false);
  release(); await cancelled; await f.done; assert.equal(f.session.owner, undefined);
});

test('arming expiry never joins or records; record timer starts only after voice readiness', async t => {
  const expired = await fixture(t, { limits: { armMs: 15, startupMs: 1000, postMs: 100, cleanupMs: 100 } });
  await expired.done; assert.equal(expired.adapter.calls.includes('join'), false);
  assert.equal(expired.session.reason, 'arming_expired');
  const adapter = new FakeAdapter(); let ready;
  adapter.join = async () => { adapter.calls.push('join'); await new Promise(r => { ready = r; }); return adapter.receiver; };
  const f = await fixture(t, { adapter, limits: { startupMs: 1000, armMs: 1000, voiceStartupMs: 300, recordMs: 20, drainMs: 100, postMs: 100, cleanupMs: 100 } });
  adapter.members.add(f.user); const start = f.session.handle(f.interaction('start'));
  await until(() => ready); await delay(35); assert.equal(f.session.state, 'starting'); assert.equal(f.session.readyAt, undefined);
  ready(); await start; adapter.speak(f.user); await f.done;
  assert.equal(f.session.reason, 'duration_limit'); assert.ok(f.session.outcome.durationMs >= 15);
  assert.ok(f.session.outcome.durationMs < 200);
  assert.equal(LIMITS.recordMs, 30000); assert.ok(LIMITS.armMs < 15 * 60000); assert.equal(LIMITS.drainMs, 120000);
});

test('startup timeout and late voice readiness cannot create capture/subscriptions after closure', async t => {
  let ready; const adapter = new FakeAdapter();
  adapter.join = async () => { await new Promise(r => { ready = r; }); return adapter.receiver; };
  const f = await fixture(t, { adapter, limits: { armMs: 1000, startupMs: 1000, voiceStartupMs: 15, postMs: 100, cleanupMs: 100 } });
  adapter.members.add(f.user); const start = f.session.handle(f.interaction('start')); await until(() => ready); await f.done;
  ready(); await start; adapter.speak(f.user);
  assert.equal(f.session.capture, undefined); assert.deepEqual(adapter.subscriptions, []);
  assert.ok(f.session.issues.has('VOICE_STARTUP_TIMEOUT'));
});

test('transport reconnect/owner departure ends test as explicit incomplete and no further capture', async t => {
  for (const code of ['VOICE_DISCONTINUITY', 'GATEWAY_RECONNECT', 'CONSENTING_USER_LEFT', 'BOT_MOVED_OR_DEAFENED']) {
    const f = await fixture(t); f.adapter.members.add(f.user); await f.session.handle(f.interaction('start'));
    f.adapter.speak(f.user); await tick(); f.adapter.emit('fault', code); await f.done;
    assert.match(f.adapter.messages[0].content, /INCOMPLETE/); assert.ok(f.adapter.messages[0].content.includes(code));
    f.adapter.speak(f.other); assert.deepEqual(f.adapter.subscriptions, [f.user]);
  }
});

test('recognizer failure and total drain timeout post explicit accounted incomplete results only after terminal work', async t => {
  for (const recognize of [async () => { throw Error('sensitive'); }, () => new Promise(() => {})]) {
    const f = await fixture(t, { workerFactory: o => new UtteranceWorker({ ...o, recognize, quietMs: 10, jobMs: 1000 }) });
    f.adapter.members.add(f.user); await f.session.handle(f.interaction('start')); f.adapter.speak(f.user); await tick();
    await f.session.stop('test_end');
    const message = f.adapter.messages[0].content;
    assert.match(message, /INCOMPLETE/); assert.match(message, /Accepted PCM: 8 bytes; accounted: 8/);
    assert.ok(message.includes('failed') || message.includes('cancelled')); assert.ok(!message.includes('sensitive'));
    assert.equal(fs.existsSync(f.session.dir), false);
  }
});

test('long transcript uses exactly one escaped txt attachment and a single final notice', async t => {
  const f = await fixture(t, { workerFactory: o => new UtteranceWorker({ ...o, recognize: async () => '@everyone word '.repeat(300) }) });
  f.adapter.members.add(f.user); await f.session.handle(f.interaction('start')); f.adapter.speak(f.user); await tick();
  await f.session.stop('test_end'); const payload = f.adapter.messages[0];
  assert.equal(f.adapter.messages.length, 1); assert.equal(payload.files.length, 1); assert.ok(payload.files[0].name.endsWith('.txt'));
  assert.ok(!payload.files[0].attachment.toString().includes('@everyone')); assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.ok(payload.content.length < 2000); assert.equal(fs.existsSync(f.session.dir), false);
});

test('signal during recognition cancels/drains boundedly, deletes audio, destroys client and never publishes transcript', async t => {
  const f = await fixture(t, { workerFactory: o => new UtteranceWorker({ ...o, recognize: () => new Promise(() => {}), quietMs: 10 }),
    limits: { startupMs: 1000, armMs: 1000, recordMs: 1000, voiceStartupMs: 1000, drainMs: 100, signalDrainMs: 20, postMs: 100, cleanupMs: 100 } });
  f.adapter.members.add(f.user); await f.session.handle(f.interaction('start')); f.adapter.speak(f.user); await tick();
  await f.session.stop('signal', 'INTERRUPTED', true);
  assert.equal(f.adapter.messages.length, 0); assert.ok(f.adapter.calls.includes('destroy'));
  assert.equal(fs.existsSync(f.session.dir), false); assert.ok(f.session.issues.has('INTERRUPTED'));
});

test('publication failure is minimal incomplete outcome; no retained raw audio/transcript and no retry/duplicate', async t => {
  const f = await fixture(t); f.adapter.result = async () => { throw Error('raw secret exception'); };
  f.adapter.members.add(f.user); await f.session.handle(f.interaction('start')); f.adapter.speak(f.user); await tick();
  await f.session.stop('test_end');
  const outcome = fs.readFileSync(path.join(f.data, 'outcome.json'), 'utf8');
  assert.match(outcome, /RESULT_PUBLICATION_FAILED_OR_UNKNOWN/); assert.ok(!outcome.includes('raw secret'));
  assert.ok(!outcome.includes('hello')); assert.deepEqual(fs.readdirSync(f.data), ['outcome.json']);
});

test('Capture optional PCM hook observes only accepted bytes with speaker/timing and last EOF; callback failure fails incomplete', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-hook-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receiver = new FakeAdapter().receiver, seen = [];
  let time = 0;
  const capture = new Capture({ out: path.join(root, 'capture'), receiver, now: () => time,
    decoderFactory: () => ({ decode: p => p, close() {} }), onPcm: row => seen.push(row) });
  receiver.speaking.emit('start', '1'); const stream = capture.speakers.get('1').stream;
  stream.push(Buffer.alloc(8)); await tick(); time = 10; stream.pause(); stream.push(Buffer.alloc(4));
  const manifest = await capture.stop();
  assert.equal(manifest.pcmBytes, 12); assert.deepEqual(seen.map(r => [r.id, r.relativeMs, r.pcmFrameOffset, r.pcm.length]), [['1', 0, 0, 8], ['1', 10, 2, 4]]);
  const failure = new Capture({ out: path.join(root, 'failure'), receiver,
    decoderFactory: () => ({ decode: p => p, close() {} }), onPcm: () => { throw Error('private'); } });
  receiver.speaking.emit('start', '2'); failure.speakers.get('2').stream.push(Buffer.alloc(8));
  const m = await failure.stop(); assert.equal(m.pcmBytes, 8); assert.ok(m.issues.includes('PCM_HOOK_FAILED'));
  assert.equal(m.outcome, 'incomplete'); assert.ok(!JSON.stringify(m).includes('private'));
  assert.equal(safeText('@everyone <@123> `hi`').includes('@everyone'), false);
});
