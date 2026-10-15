'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { Capture } = require('../capture');
const { createDecoder, preflight } = require('../codec');
const { parseConfig, assertApplication, PRODUCTION } = require('../config');
const { main } = require('../probe');

class Receiver {
  constructor() { this.speaking = new EventEmitter(); this.streams = new Map(); this.calls = []; }
  subscribe(id, options) {
    this.calls.push({ id, options });
    const stream = new Readable({ read() {} }); this.streams.set(id, stream); return stream;
  }
  start(id) { this.speaking.emit('start', id); return this.streams.get(id); }
}
function fixture(t, options = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'feasibility-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const receiver = new Receiver();
  let closed = 0, decoders = 0;
  const decoderFactory = () => {
    const tag = ++decoders;
    return { decode: packet => Buffer.alloc(packet[0] * 4, tag), close: () => closed++ };
  };
  const out = path.join(parent, 'session');
  const capture = new Capture({ out, receiver, decoderFactory, ...options });
  return { receiver, capture, out, closed: () => closed, decoders: () => decoders };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('isolates interleaved speakers, variable PCM sizes, immediate writes, private outputs and final counters', async t => {
  const { receiver, capture, out, closed, decoders } = fixture(t);
  const a = receiver.start('1'), b = receiver.start('2');
  a.push(Buffer.from([2])); b.push(Buffer.from([3])); a.push(Buffer.from([5]));
  await tick();
  assert.equal(fs.statSync(path.join(out, 'speaker-1.wav')).size, 44 + 28); // Written during capture, before finalization.
  const m = await capture.stop();
  assert.equal(m.outcome, 'drained_observed_audio'); assert.equal(m.pcmFrames, 10); assert.equal(m.pcmBytes, 40);
  assert.equal(decoders(), 2); assert.equal(closed(), 2);
  for (const [id, tag, bytes] of [['1', 1, 28], ['2', 2, 12]]) {
    const wav = fs.readFileSync(path.join(out, `speaker-${id}.wav`));
    assert.equal(wav.readUInt32LE(40), bytes); assert.deepEqual(wav.subarray(44), Buffer.alloc(bytes, tag));
    const rows = fs.readFileSync(path.join(out, `speaker-${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.reduce((n, x) => n + x.pcmBytes, 0), bytes);
    assert.ok(rows.every(x => Number.isFinite(x.relativeMs) && x.capturedAt));
  }
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(out)) assert.equal(fs.statSync(path.join(out, name)).mode & 0o777, 0o600);
  assert.equal(receiver.calls[0].options.end.behavior, 0);
});

test('stop flushes last buffered packet before EOF, repeated speaking events do not replace manual stream', async t => {
  const { receiver, capture, closed } = fixture(t);
  const stream = receiver.start('1');
  stream.pause(); stream.push(Buffer.from([7]));
  assert.equal(receiver.start('1'), stream); assert.equal(receiver.calls.length, 1);
  const stopping = capture.stop('signal');
  assert.equal(capture.stop('again'), stopping);
  const m = await stopping;
  assert.equal(m.pcmBytes, 28); assert.equal(m.packets, 1); assert.equal(closed(), 1);
  assert.equal(receiver.speaking.listenerCount('start'), 0);
  receiver.start('2'); assert.equal(receiver.calls.length, 1);
});

test('unexpected EOF is explicit, resubscription preserves the same per-speaker codec/output', async t => {
  const { receiver, capture, decoders } = fixture(t);
  const a = receiver.start('1'); a.push(Buffer.from([2])); a.push(null); await tick();
  const b = receiver.start('1'); assert.notEqual(a, b); b.push(Buffer.from([4]));
  const m = await capture.stop();
  assert.equal(m.outcome, 'incomplete'); assert.ok(m.issues.includes('UNEXPECTED_EOF'));
  assert.equal(m.pcmFrames, 6); assert.equal(m.speakers[0].subscriptions, 2); assert.equal(decoders(), 1);
});

test('speaker, byte, packet and PCM limits fail incomplete without extra output', async t => {
  for (const [limits, packets, issue] of [
    [{ maxPcmPerSpeaker: 8 }, [2, 2], 'PCM_BYTE_LIMIT'],
    [{ maxPcmTotal: 4 }, [2], 'PCM_BYTE_LIMIT'],
    [{ maxPackets: 1 }, [1, 1], 'PACKET_COUNT_LIMIT'],
    [{ maxPcmPacket: 4 }, [2], 'PCM_FORMAT_OR_SIZE'],
    [{ maxPacket: 0 }, [1], 'PACKET_SIZE_LIMIT'],
  ]) {
    const { receiver, capture } = fixture(t, { limits });
    const s = receiver.start('1'); for (const p of packets) s.push(Buffer.from([p]));
    const m = await capture.stop(); assert.equal(m.outcome, 'incomplete'); assert.ok(m.issues.includes(issue));
    assert.ok(m.rejectedPackets > 0);
  }
  const { receiver, capture } = fixture(t, { limits: { maxSpeakers: 1 } });
  receiver.start('1'); receiver.start('2');
  const m = await capture.stop(); assert.ok(m.issues.includes('SPEAKER_LIMIT')); assert.equal(m.speakers.length, 1);
});

test('disk budget, write failures, short writes, decoder errors and receive errors are explicit', async t => {
  {
    const { receiver, capture } = fixture(t, { limits: { maxDisk: 16430 } });
    receiver.start('1').push(Buffer.from([4]));
    const m = await capture.stop(); assert.equal(m.outcome, 'incomplete'); assert.ok(m.issues.includes('WRITE_OR_DISK_LIMIT'));
  }
  {
    const { receiver, capture } = fixture(t, { decoderFactory: () => ({ decode() { throw Error('sensitive payload'); }, close() {} }) });
    receiver.start('1').push(Buffer.from([1])); const m = await capture.stop();
    assert.ok(m.issues.includes('DECODE_FAILED')); assert.ok(!JSON.stringify(m).includes('sensitive'));
  }
  {
    const io = Object.create(fs); io.writeSync = (fd, buffer, offset, length, pos) => fs.writeSync(fd, buffer, offset, Math.min(3, length), pos);
    const { receiver, capture } = fixture(t, { io });
    receiver.start('1').push(Buffer.from([2])); const m = await capture.stop(); assert.equal(m.pcmBytes, 8);
  }
  {
    const io = Object.create(fs); let count = 0;
    io.writeSync = (...args) => { if (++count === 2) throw Error('private disk details'); return fs.writeSync(...args); };
    const { receiver, capture } = fixture(t, { io }); receiver.start('1').push(Buffer.from([1]));
    const m = await capture.stop(); assert.ok(m.issues.includes('WRITE_OR_DISK_LIMIT'));
  }
  {
    const { receiver, capture } = fixture(t); receiver.start('1').destroy(Error('credential-like detail')); await tick();
    const m = await capture.stop(); assert.ok(m.issues.includes('RECEIVE_ERROR')); assert.equal(m.outcome, 'incomplete');
  }
});

test('bounded drain timeout, no-audio outcome, no overwrite', async t => {
  const { receiver, capture, out } = fixture(t, { limits: { drainMs: 10 } });
  const stream = receiver.start('1');
  stream.pause(); stream.push(Buffer.from([1]));
  stream.resume = () => stream; // Fake hung consumer with unread data; base EOF cannot emit end.
  const m = await capture.stop();
  assert.ok(m.issues.includes('DRAIN_TIMEOUT')); assert.ok(m.issues.includes('NO_AUDIO_OBSERVED'));
  assert.throws(() => new Capture({ out, receiver }), { code: 'EEXIST' });
  assert.throws(() => capture.open('manifest.json'), { code: 'EEXIST' });
});

test('configuration gates cannot reach a login boundary without explicit consent; production IDs forbidden', async () => {
  // Locally constructed, deliberately nonauthentic tokens; never sent to Discord.
  const fakeToken = id => `${Buffer.from(id).toString('base64url')}.fake.c2lnbmF0dXJl`;
  const expected = '333333333333333333';
  const env = { DEV_DISCORD_TOKEN: fakeToken(expected), TEST_APPLICATION_ID: expected,
    TEST_GUILD_ID: '111111111111111111', TEST_VOICE_CHANNEL_ID: '222222222222222222' };
  const args = ['--record', '--consent-ack', '--out', 'unused']; let calls = 0;
  for (const [a, e] of [
    [['--record'], env], [['--consent-ack'], env], [args, {}],
    [args, { ...env, TEST_GUILD_ID: PRODUCTION.guild }],
    [args, { ...env, TEST_VOICE_CHANNEL_ID: PRODUCTION.channel }],
    [args, { ...env, TEST_APPLICATION_ID: undefined }],
    [args, { ...env, TEST_APPLICATION_ID: PRODUCTION.application }],
    // Production token cannot reach live/login, even with false expected id + unrelated guild/channel.
    [args, { ...env, DEV_DISCORD_TOKEN: fakeToken(PRODUCTION.application) }],
    [args, { ...env, DEV_DISCORD_TOKEN: fakeToken('444444444444444444') }],
    ...['', 'mfa.fake', 'Bot token', 'not-a-token', 'YWJj.fake.signature',
      `${Buffer.from(expected).toString('base64url')}.a.c2lnbmF0dXJl`,
      `${Buffer.from(expected).toString('base64url')}.fake.a`,
      `${Buffer.from(expected).toString('base64url')}=.fake.signature`,
      `${Buffer.from(expected).toString('base64url')}.fake.signature.extra`,
      `${Buffer.from(expected).toString('base64url')}.fake.`].map(token => [args, { ...env, DEV_DISCORD_TOKEN: token }]),
    [[...args, '--seconds', '121'], env], [[...args, '--seconds', '-1'], env],
    [[...args, '--seconds', 'NaN'], env], [[...args, '--unknown'], env],
  ]) await assert.rejects(main(a, e, () => calls++));
  await assert.rejects(main(args, { ...env, DEV_DISCORD_TOKEN: fakeToken(PRODUCTION.application) }, () => calls++),
    { safeCode: 'PRODUCTION_APPLICATION' });
  assert.equal(calls, 0);
  assert.equal(parseConfig([], env).record, false); // Token presence alone never enables recording.
  assert.equal(parseConfig(args, env).seconds, 30);
  assert.equal(parseConfig(args, env).application, expected);
  const identity = id => ({ user: { id }, application: { id } });
  assert.throws(() => assertApplication(identity(PRODUCTION.application), expected));
  assert.throws(() => assertApplication(identity(expected), PRODUCTION.application));
  assert.throws(() => assertApplication({}, expected));
  assert.throws(() => assertApplication(identity('444444444444444444'), expected));
  assert.throws(() => assertApplication({ user: { id: expected }, application: { id: '444444444444444444' } }, expected));
  assert.doesNotThrow(() => assertApplication(identity(expected), expected));
});

test('offline DAVE API load is not native/receive proof; real WASM variable-size synthetic Opus roundtrip', () => {
  const report = preflight();
  assert.equal(report.dave.moduleLoaded, true); assert.equal(report.dave.sessionApiAvailable, true);
  assert.equal(report.dave.implementation, 'unknown'); assert.equal(report.dave.receiveDecryptVerified, false);
  assert.equal(Object.hasOwn(report.dave, 'binaryLoaded'), false);
  const Opus = require('opusscript');
  const encoder = new Opus(48000, 2, Opus.Application.AUDIO, { wasm: true });
  const decoder = createDecoder();
  try {
    for (const frames of [120, 240, 480, 960, 1920, 2880]) {
      const pcm = Buffer.alloc(frames * 4);
      for (let i = 0; i < frames; i++) {
        const v = Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 3000);
        pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(-v, i * 4 + 2);
      }
      const decoded = decoder.decode(encoder.encode(pcm, frames));
      assert.equal(decoded.length, pcm.length, `frame size ${frames}`);
    }
  } finally { decoder.close(); encoder.delete(); }
});

test('voice 0.19.2 real paused AudioReceiveStream drains buffered tail without destructive push override', async t => {
  const { AudioReceiveStream, EndBehaviorType } = require('@discordjs/voice');
  const { receiver, capture } = fixture(t);
  receiver.subscribe = (id, options) => {
    const stream = new AudioReceiveStream(options); receiver.streams.set(id, stream); return stream;
  };
  const stream = receiver.start('1'); assert.equal(stream.end.behavior, EndBehaviorType.Manual);
  await tick(); stream.pause(); stream.push(Buffer.from([5]));
  assert.equal(stream.readableLength, 1); assert.equal(capture.packets, 0);
  let nullOverrides = 0;
  const originalPush = stream.push;
  stream.push = function (packet) { if (packet === null) nullOverrides++; return originalPush.call(this, packet); };
  const m = await capture.stop();
  assert.equal(nullOverrides, 0); assert.equal(stream.readableEnded, true);
  assert.equal(m.packets, 1); assert.deepEqual(m.issues, []);
  assert.equal(m.pcmBytes, 20); assert.equal(m.outcome, 'drained_observed_audio');
});

test('monotonic duration guard and manifest IO failure cannot report drained success', async t => {
  let clock = 0;
  const { receiver, capture } = fixture(t, { now: () => clock, limits: { maxDurationMs: 10 } });
  const stream = receiver.start('1'); stream.push(Buffer.from([2])); await tick();
  clock = 11; stream.push(Buffer.from([2]));
  const m = await capture.stop(); assert.equal(m.pcmBytes, 8); assert.ok(m.issues.includes('DURATION_LIMIT'));
  const io = Object.create(fs);
  io.openSync = (name, ...args) => { if (name.endsWith('.manifest.pending.json')) throw Error('private details'); return fs.openSync(name, ...args); };
  const f = fixture(t, { io }); f.receiver.start('1').push(Buffer.from([1]));
  const failed = await f.capture.stop(); assert.equal(failed.outcome, 'incomplete'); assert.ok(failed.issues.includes('MANIFEST_WRITE_OR_PUBLISH_FAILED'));
  assert.equal(fs.existsSync(path.join(f.out, 'manifest.json')), false);
  const closeIO = Object.create(fs); let manifestFd;
  closeIO.openSync = (name, ...args) => {
    const fd = fs.openSync(name, ...args); if (name.endsWith('.manifest.pending.json')) manifestFd = fd; return fd;
  };
  closeIO.closeSync = fd => {
    fs.closeSync(fd);
    if (fd === manifestFd) { manifestFd = undefined; throw Error('close failed private details'); }
  };
  const g = fixture(t, { io: closeIO }); g.receiver.start('1').push(Buffer.from([1]));
  assert.equal((await g.capture.stop()).outcome, 'incomplete');
  assert.equal(fs.existsSync(path.join(g.out, 'manifest.json')), false);
  const h = fixture(t); h.receiver.start('1').push(Buffer.from([1]));
  fs.writeFileSync(path.join(h.out, 'manifest.json'), 'existing', { mode: 0o600 });
  assert.equal((await h.capture.stop()).outcome, 'incomplete');
  assert.equal(fs.readFileSync(path.join(h.out, 'manifest.json'), 'utf8'), 'existing');
});
