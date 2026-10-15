'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { Audio, createDecoder } = require('../../src/features/local-transcription/audio');
const A = '111111111111111111', B = '222222222222222222', BOT = '333333333333333333';
const GUILD = '444444444444444444', CHANNEL = '555555555555555555';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const client = new EventEmitter(), calls = [], streams = new Map(), seen = [], faults = [], codecs = [];
  client.user = { id: BOT }; client.guilds = { cache: new Map([[GUILD, { voiceAdapterCreator: 'adapter' }]]) };
  const receiver = { speaking: new EventEmitter(), subscribe(id, opts) {
    calls.push({ id, opts });
    const stream = options.streamFactory ? options.streamFactory(opts) : new Readable({ objectMode: true, read() {} });
    streams.set(id, stream); return stream;
  } };
  const connection = new EventEmitter(); connection.state = { status: 'connecting' }; connection.receiver = receiver;
  connection.destroy = () => {
    connection.emit('stateChange', { status: 'ready' }, { status: 'destroyed' });
    client.emit('voiceStateUpdate', {}, { id: BOT, guild: { id: GUILD }, channelId: null, selfDeaf: true });
  };
  const voice = { VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected' },
    EndBehaviorType: { Manual: 0 }, joinVoiceChannel(args) {
      assert.deepEqual(args, { guildId: GUILD, channelId: CHANNEL, adapterCreator: 'adapter', selfDeaf: false, selfMute: true });
      return connection;
    }, entersState: async () => {
      receiver.speaking.emit('start', A); receiver.speaking.emit('start', B);
      await options.waitReady?.();
      connection.state = { status: 'ready' }; connection.emit('stateChange', {}, connection.state);
    } };
  const audio = new Audio({ client, guildId: GUILD, channelId: CHANNEL, voice, now: () => 1234,
    decoderFactory: options.decoderFactory || (() => {
      const codec = { count: 0, closed: 0, decode(packet) { this.count++; return Buffer.alloc(packet[0] * 4, codecs.length); }, close() { this.closed++; } };
      codecs.push(codec); return codec;
    }), limits: options.limits });
  t.after(() => audio.active?.close());
  const open = () => audio.open({ sessionId: 'session', onPcm: row => seen.push({ ...row, pcm: Buffer.from(row.pcm) }), onFault: code => faults.push(code) });
  const state = next => client.emit('voiceStateUpdate', {}, { guild: { id: GUILD }, ...next });
  return { audio, client, connection, receiver, calls, streams, seen, faults, codecs, open, state };
}

test('no subscription before explicit consent; ready handshake primes only owner; independent per-speaker state, no PCM retained', async t => {
  let ready;
  const f = fixture(t, { waitReady: () => new Promise(resolve => { ready = resolve; }) });
  const opening = f.open(); await tick(); assert.deepEqual(f.calls, []);
  ready(); const handle = await opening; assert.deepEqual(f.calls, []);
  await assert.rejects(handle.setConsented(A, 'false'), { message: 'AUDIO_CONSENT_INVALID' });
  assert.deepEqual(f.calls, []);
  await handle.setConsented(A, true); assert.deepEqual(f.calls.map(c => c.id), [A]);
  f.receiver.speaking.emit('start', B); assert.equal(f.calls.length, 1);
  f.streams.get(A).push(Buffer.from([2])); await tick();
  await handle.setConsented(B, true); f.streams.get(B).push(Buffer.from([3])); await tick(); f.streams.get(A).push(Buffer.from([1])); await tick();
  assert.equal(f.codecs.length, 2); assert.deepEqual(f.codecs.map(c => c.count), [2, 1]);
  assert.deepEqual(f.seen.map(p => [p.userId, p.pcm.length, p.atMs]), [[A, 8, 1234], [B, 12, 1234], [A, 4, 1234]]);
  f.receiver.speaking.emit('start', A); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.opts.end.behavior === 0 && c.opts.highWaterMark === 16));
  await handle.close(); assert.deepEqual(f.faults, []); assert.ok(f.codecs.every(c => c.closed === 1));
  assert.equal(handle.speakers.size, 0); assert.equal(handle.consented.size, 0);
  assert.equal(f.receiver.speaking.listenerCount('start'), 0); assert.equal(f.client.listenerCount('voiceStateUpdate'), 0);
  assert.equal(f.connection.listenerCount('stateChange'), 0);
});

test('revocation is synchronous, drops queued old tail; leave/rejoin requires new consent and fresh codec/stream', async t => {
  const f = fixture(t), handle = await f.open(); await handle.setConsented(A, true); await tick();
  const old = f.streams.get(A); old.pause(); old.push(Buffer.from([2]));
  const revoking = handle.setConsented(A, false);
  old.emit('data', Buffer.from([2])); f.receiver.speaking.emit('start', A);
  assert.equal(f.seen.length, 0); assert.equal(handle.consented.has(A), false);
  // Resubscribe immediately, before the old stream close tick has fired.
  await Promise.all([revoking, handle.setConsented(A, true)]);
  assert.equal(f.calls.length, 2); assert.notEqual(f.streams.get(A), old); assert.equal(f.codecs[0].closed, 1);
  f.streams.get(A).push(Buffer.from([3])); await tick(); assert.equal(f.seen.length, 1);
  f.state({ id: A, channelId: null }); assert.equal(handle.consented.has(A), false);
  await tick(); f.state({ id: A, channelId: CHANNEL }); f.receiver.speaking.emit('start', A); assert.equal(f.calls.length, 2);
  await handle.setConsented(A, true); assert.equal(f.calls.length, 3);
  await handle.close(); assert.deepEqual(f.faults, []);
});

test('close drains last paused packet through base Readable EOF, disallows subscriptions and is idempotent', async t => {
  const f = fixture(t), handle = await f.open(); await handle.setConsented(A, true); await tick();
  const stream = f.streams.get(A); stream.pause(); stream.push(Buffer.from([5]));
  let overridden = 0; const push = stream.push;
  stream.push = function(packet) { if (packet === null) overridden++; return push.call(this, packet); };
  const closing = handle.close(); assert.equal(handle.close(), closing);
  await handle.setConsented(B, true); f.receiver.speaking.emit('start', B); await closing;
  assert.equal(overridden, 0); assert.equal(stream.readableEnded, true);
  assert.deepEqual(f.seen.map(p => p.pcm.length), [20]); assert.equal(f.calls.length, 1); assert.deepEqual(f.faults, []);
});

test('fake routing detaches before EOF, keeps buffered tail and leaves unrelated streams routed', async t => {
  const f = fixture(t), h = await f.open(); await h.setConsented(A, true); await tick();
  const stream = f.streams.get(A), unrelated = new Readable({ objectMode: true, read() {} });
  t.after(() => unrelated.destroy());
  const routes = f.receiver.subscriptions = new Map([[A, stream], [B, unrelated]]);
  const route = (id, value) => routes.get(id)?.push(Buffer.from([value]));
  stream.pause(); route(A, 7);
  const remove = routes.delete.bind(routes); let detached = 0;
  routes.delete = id => {
    assert.equal(id, A); assert.equal(stream._readableState.ended, false); assert.equal(stream.destroyed, false);
    detached++; return remove(id);
  };
  const resume = stream.resume;
  stream.resume = function() {
    assert.equal(detached, 1); assert.equal(routes.has(A), false);
    route(A, 9); // Simulated datagram after EOF must not push/destroy the stream.
    return resume.call(this);
  };
  await h.close();
  assert.equal(stream.readableEnded, true); assert.equal(detached, 1);
  assert.deepEqual(f.seen.map(p => p.pcm.length), [28]); assert.deepEqual(f.faults, []);
  assert.equal(routes.get(B), unrelated); assert.equal(unrelated.destroyed, false);
  route(B, 2); assert.deepEqual(unrelated.read(), Buffer.from([2]));
});

test('stale fake speaker never deletes a replacement routing entry or resumes revoked speech', async t => {
  for (const revoked of [false, true]) {
    const f = fixture(t), h = await f.open(); await h.setConsented(A, true); await tick();
    const old = f.streams.get(A), replacement = new Readable({ objectMode: true, read() {} });
    t.after(() => replacement.destroy());
    f.receiver.subscriptions = new Map([[A, replacement]]);
    old.pause(); old.push(Buffer.from([7])); let resumes = 0;
    const resume = old.resume;
    old.resume = function() { resumes++; return resume.call(this); };
    const closing = h.close(), revoking = revoked ? h.setConsented(A, false) : undefined;
    await Promise.all([closing, revoking]);
    assert.equal(f.receiver.subscriptions.get(A), replacement); assert.equal(replacement.destroyed, false);
    assert.equal(resumes, revoked ? 0 : 1);
    assert.deepEqual(f.seen.map(p => p.pcm.length), revoked ? [] : [28]); assert.deepEqual(f.faults, []);
  }
});

test('a real leave event revokes an old closing runtime before its buffered tail decodes', async t => {
  const f = fixture(t), handle = await f.open(); await handle.setConsented(A, true); await tick();
  const stream = f.streams.get(A); stream.pause(); stream.push(Buffer.from([7]));
  const closing = handle.close();
  f.state({ id: A, channelId: null });
  assert.equal(handle.consented.has(A), false);
  await closing; assert.deepEqual(f.seen, []); assert.deepEqual(f.faults, []);
  assert.equal(f.codecs[0].closed, 1);
});

test('real pinned voice 0.19.2 AudioReceiveStream regression: buffered final words not destroyed by push(null)', async t => {
  const { AudioReceiveStream } = require('@discordjs/voice');
  const f = fixture(t, { streamFactory: opts => new AudioReceiveStream(opts) });
  const handle = await f.open(); await handle.setConsented(A, true); await tick();
  const stream = f.streams.get(A); stream.pause(); stream.push(Buffer.from([7]));
  assert.equal(stream.readableLength, 1);
  await handle.close(); assert.equal(stream.readableEnded, true); assert.deepEqual(f.seen.map(p => p.pcm.length), [28]); assert.deepEqual(f.faults, []);
});

test('real voice receiver detaches UDP routing before EOF and retains the last buffered frame', async t => {
  const { VoiceReceiver } = require('@discordjs/voice');
  const f = fixture(t), receiver = new VoiceReceiver(f.connection); f.connection.receiver = receiver;
  const h = await f.open(); await h.setConsented(A, true); await tick();
  receiver.ssrcMap.update({ userId: A, audioSSRC: 1 }); receiver.ssrcMap.update({ userId: B, audioSSRC: 2 });
  receiver.connectionData = { encryptionMode: 'fixture', nonceBuffer: Buffer.alloc(1), secretKey: Buffer.alloc(1) };
  // Stub only decryption/parsing; exercise the actual pinned UDP routing path.
  receiver.parsePacket = msg => msg.subarray(12);
  const datagram = (ssrc, value) => {
    const msg = Buffer.alloc(13); msg[0] = 0x80; msg[1] = 120; msg.writeUInt32BE(ssrc, 8); msg[12] = value;
    receiver.onUdpMessage(msg);
  };
  const stream = receiver.subscriptions.get(A), unrelated = receiver.subscribe(B, { end: { behavior: 0 } });
  t.after(() => unrelated.destroy());
  const otherPackets = []; unrelated.on('data', packet => otherPackets.push(packet[0]));
  stream.pause(); datagram(1, 7); assert.equal(stream.readableLength, 1);
  const remove = receiver.subscriptions.delete.bind(receiver.subscriptions); let detached = 0;
  receiver.subscriptions.delete = id => {
    if (receiver.subscriptions.get(id) === stream) {
      assert.equal(stream._readableState.ended, false); assert.equal(stream.destroyed, false); detached++;
    }
    return remove(id);
  };
  const resume = stream.resume;
  stream.resume = function() {
    assert.equal(detached, 1); assert.equal(receiver.subscriptions.has(A), false);
    datagram(1, 9); datagram(2, 2);
    return resume.call(this);
  };
  await h.close();
  assert.equal(stream.readableEnded, true); assert.equal(detached, 1);
  assert.deepEqual(f.seen.map(p => p.pcm.length), [28]); assert.deepEqual(f.faults, []);
  assert.equal(receiver.subscriptions.get(B), unrelated); assert.equal(unrelated.destroyed, false);
  assert.deepEqual(otherPackets, [2]);
});

test('real UDP receiver missing or refusing its routing Map fails explicitly without resuming tail', async t => {
  const { VoiceReceiver } = require('@discordjs/voice');
  for (const failure of ['missing', 'refuses-delete']) {
    const f = fixture(t), receiver = new VoiceReceiver(f.connection); f.connection.receiver = receiver;
    const h = await f.open(); await h.setConsented(A, true); await tick();
    const stream = receiver.subscriptions.get(A); stream.pause(); stream.push(Buffer.from([7]));
    let resumes = 0; stream.resume = () => { resumes++; return stream; };
    if (failure === 'missing') receiver.subscriptions = undefined;
    else receiver.subscriptions.delete = () => false;
    // The pinned close listener uses the Map too; keep this deliberate broken-
    // seam test focused on our fail-closed drain rather than its later cleanup.
    stream.prependOnceListener('close', () => { receiver.subscriptions = new Map(); });
    await h.close();
    assert.deepEqual(f.faults, ['RECEIVER_ROUTING_DETACH_FAILED']);
    assert.equal(resumes, 0); assert.deepEqual(f.seen, []);
  }
});

test('real voice receiver resubscription waits old Map deletion; revoke racing EOF is intentional, not a fault', async t => {
  const { VoiceReceiver } = require('@discordjs/voice');
  const f = fixture(t);
  const receiver = new VoiceReceiver(f.connection);
  f.connection.receiver = receiver;
  const h = await f.open(); await h.setConsented(A, true); await tick();
  const old = receiver.subscriptions.get(A); old.pause(); old.push(Buffer.from([3]));
  const revoke = h.setConsented(A, false), reconsent = h.setConsented(A, true);
  await Promise.all([revoke, reconsent]);
  const current = receiver.subscriptions.get(A); assert.ok(current); assert.notEqual(current, old);
  current.push(Buffer.from([2])); await tick(); assert.deepEqual(f.seen.map(p => p.pcm.length), [8]);
  current.pause(); current.push(Buffer.from([7]));
  const closing = h.close(); await tick(); // EOF queued while paused stream resumes normally.
  await h.setConsented(A, false); await closing;
  assert.deepEqual(f.faults, []); assert.equal(receiver.subscriptions.size, 0);
});

test('revocation during pending drain drops tail without reporting a false fault', async t => {
  const f = fixture(t), h = await f.open(); await h.setConsented(A, true); await tick();
  const stream = f.streams.get(A); stream.pause(); stream.push(Buffer.from([2])); stream.resume = () => stream;
  const closing = h.close(); await tick();
  await h.setConsented(A, false); await closing;
  assert.deepEqual(f.faults, []); assert.equal(f.seen.length, 0); assert.equal(f.codecs[0].closed, 1);
});

test('retiring decoder/streams count toward memory cap during account churn', async t => {
  const f = fixture(t, { limits: { maxSpeakers: 1 } }), h = await f.open(); await h.setConsented(A, true);
  const retiring = h.setConsented(A, false);
  await h.setConsented(B, true); await retiring;
  assert.deepEqual(f.faults, ['SPEAKER_LIMIT']); assert.equal(f.calls.length, 1); await h.close();
});

test('bounded speakers, packets, PCM and buffered queues fail closed with sanitized codes', async t => {
  for (const [options, inject, expected] of [
    [{ limits: { maxSpeakers: 1 } }, async (f, h) => h.setConsented(B, true), 'SPEAKER_LIMIT'],
    [{ limits: { maxPacket: 1 } }, async f => f.streams.get(A).push(Buffer.from([1, 2])), 'PACKET_SIZE_LIMIT'],
    [{ limits: { maxPcmPacket: 4 } }, async f => f.streams.get(A).push(Buffer.from([2])), 'PCM_FORMAT_OR_SIZE'],
    [{ decoderFactory: () => ({ decode() { throw Error('private'); }, close() {} }) }, async f => f.streams.get(A).push(Buffer.from([1])), 'DECODE_FAILED'],
    [{ decoderFactory: () => ({ decode: () => Buffer.alloc(3), close() {} }) }, async f => f.streams.get(A).push(Buffer.from([1])), 'PCM_FORMAT_OR_SIZE'],
    [{ limits: { maxBufferedPackets: 1 } }, async f => {
      const s = f.streams.get(A); s.pause(); s.push(Buffer.from([1])); s.push(Buffer.from([1])); s.push(Buffer.from([1])); s.resume();
    }, 'PACKET_QUEUE_LIMIT'],
  ]) {
    const f = fixture(t, options), h = await f.open(); await h.setConsented(A, true); await tick(); await inject(f, h); await tick();
    assert.deepEqual(f.faults, [expected]); assert.equal(f.seen.length, 0);
    await h.setConsented(B, true); assert.equal(f.calls.length, 1); await h.close();
  }
});

test('real move, self/server deafen, reconnect/disconnect, receive/EOF faults are distinct from expected teardown', async t => {
  for (const [inject, code] of [
    [f => f.state({ id: BOT, channelId: null }), 'BOT_MOVED_OR_DEAFENED'],
    [f => f.state({ id: BOT, channelId: CHANNEL, selfDeaf: true }), 'BOT_MOVED_OR_DEAFENED'],
    [f => f.state({ id: BOT, channelId: CHANNEL, serverDeaf: true }), 'BOT_MOVED_OR_DEAFENED'],
    [f => f.client.emit('shardReconnecting'), 'GATEWAY_RECONNECT'],
    [f => f.client.emit('shardDisconnect'), 'GATEWAY_DISCONNECT'],
    [f => f.connection.emit('stateChange', {}, { status: 'connecting' }), 'VOICE_DISCONTINUITY'],
    [f => f.streams.get(A).destroy(Error('private exception')), 'RECEIVE_ERROR'],
    [f => f.streams.get(A).push(null), 'UNEXPECTED_EOF'],
  ]) {
    const f = fixture(t), h = await f.open(); await h.setConsented(A, true); inject(f); await tick();
    assert.deepEqual(f.faults, [code]); assert.equal(h.consented.size, 0);
    await h.close(); assert.equal(f.faults.length, 1);
  }
});

test('bounded drain failure cannot claim complete audio; callback/decode init failure sanitized', async t => {
  const f = fixture(t, { limits: { drainMs: 10 } }), h = await f.open(); await h.setConsented(A, true); await tick();
  const s = f.streams.get(A); s.pause(); s.push(Buffer.from([1])); s.resume = () => s;
  await h.close(); assert.deepEqual(f.faults, ['DRAIN_INCOMPLETE']);
  const bad = fixture(t, { decoderFactory: () => { throw Error('secret'); } }); const bh = await bad.open();
  await bh.setConsented(A, true); await bh.close(); assert.deepEqual(bad.faults, ['SUBSCRIBE_OR_DECODER_FAILED']);
});

test('failed ready handshake cleans listeners/connection and allows a later fresh open', async t => {
  const f = fixture(t); f.audio.voice.entersState = async () => { throw Error('private handshake'); };
  await assert.rejects(f.open(), { message: 'AUDIO_OPEN_FAILED' });
  assert.equal(f.audio.active, null); assert.equal(f.client.listenerCount('voiceStateUpdate'), 0);
  assert.equal(f.connection.listenerCount('stateChange'), 0); assert.deepEqual(f.faults, []);
  f.audio.voice.entersState = async () => {};
  const h = await f.open(); await h.close();
});

test('subscriber/callback failures sanitize and dispose partially initialized resources', async t => {
  const f = fixture(t), h = await f.open(); f.receiver.subscribe = () => { throw Error('private'); };
  await h.setConsented(A, true); await h.close(); assert.equal(f.codecs[0].closed, 1);
  assert.deepEqual(f.faults, ['SUBSCRIBE_OR_DECODER_FAILED']);
  const other = fixture(t); const oh = await other.audio.open({ sessionId: 'session', onPcm: () => { throw Error('speech'); }, onFault: code => other.faults.push(code) });
  await oh.setConsented(A, true); other.streams.get(A).push(Buffer.from([1])); await tick(); await oh.close();
  assert.deepEqual(other.faults, ['PCM_HOOK_FAILED']);
});

test('actual WASM Opus decode handles variable bounded frame sizes without sharing codec state', () => {
  const Opus = require('opusscript'), encoder = new Opus(48000, 2, Opus.Application.AUDIO, { wasm: true });
  const decoder = createDecoder(), other = createDecoder();
  try {
    assert.notEqual(decoder, other);
    for (const frames of [120, 240, 480, 960, 1920, 2880]) {
      const pcm = Buffer.alloc(frames * 4);
      for (let i = 0; i < frames; i++) { const value = Math.round(2000 * Math.sin(i * 2 * Math.PI * 440 / 48000)); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(-value, i * 4 + 2); }
      const packet = encoder.encode(pcm, frames); assert.equal(decoder.decode(packet).length, pcm.length);
    }
  } finally { encoder.delete(); decoder.close(); other.close(); }
});
