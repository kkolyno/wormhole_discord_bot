'use strict';
const { Readable } = require('node:stream');

const DEFAULTS = Object.freeze({ maxSpeakers: 8, maxPacket: 3828, maxPcmPacket: 11520,
  maxBufferedPackets: 16, readyMs: 14000, drainMs: 1500 });
const validId = id => typeof id === 'string' && /^\d{17,20}$/.test(id);
function createDecoder() {
  // Deliberately WASM, never native-addon auto-selection. Each consent owns state.
  const Opus = require('opusscript');
  const codec = new Opus(48000, 2, Opus.Application.AUDIO, { wasm: true });
  return { decode: packet => codec.decode(packet), close: () => codec.delete() };
}

class Audio {
  constructor({ client, guildId, channelId, now = Date.now, voice, decoderFactory = createDecoder, limits = {} }) {
    Object.assign(this, { client, guildId, channelId, now, voice, decoderFactory });
    this.limits = { ...DEFAULTS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Object.hasOwn(DEFAULTS, key) || !Number.isSafeInteger(value) || value <= 0 || value > DEFAULTS[key]) throw Error('AUDIO_LIMIT_INVALID');
    }
    if (!validId(guildId) || !validId(channelId)) throw Error('AUDIO_TARGET_INVALID');
  }
  async open({ sessionId, onPcm, onFault }) {
    if (this.active) throw Error('AUDIO_ALREADY_OPEN');
    if (typeof sessionId !== 'string' || typeof onPcm !== 'function' || typeof onFault !== 'function') throw Error('AUDIO_CALLBACK_INVALID');
    const handle = new CaptureHandle(this, onPcm, onFault);
    this.active = handle;
    try { await handle.ready(); return handle; }
    catch { await handle.close(); throw Error('AUDIO_OPEN_FAILED'); }
  }
}

class CaptureHandle {
  constructor(audio, onPcm, onFault) {
    this.audio = audio; this.onPcm = onPcm; this.onFault = onFault;
    this.consented = new Set(); this.speakers = new Map(); this.retired = new Map(); this.listeners = [];
  }
  listen(emitter, event, listener) {
    emitter.on(event, listener); this.listeners.push(() => emitter.off(event, listener));
  }
  fault(code) {
    if (this.halted) return;
    this.halted = true; this.consented.clear();
    try { this.onFault(code); } catch { /* Never propagate a private callback exception into voice. */ }
  }
  async ready() {
    const { audio } = this;
    const voice = audio.voice || require('@discordjs/voice'); this.voice = voice;
    const guild = audio.client.guilds.cache.get(audio.guildId);
    if (!guild?.voiceAdapterCreator) throw Error('AUDIO_GUILD_UNAVAILABLE');
    const guarded = code => () => { if (!this.closing) this.fault(code); };
    this.listen(audio.client, 'error', guarded('CLIENT_ERROR'));
    this.listen(audio.client, 'shardDisconnect', guarded('GATEWAY_DISCONNECT'));
    this.listen(audio.client, 'shardReconnecting', guarded('GATEWAY_RECONNECT'));
    this.listen(audio.client, 'voiceStateUpdate', (_old, next) => {
      if (next.guild?.id !== audio.guildId) return;
      if (next.id === audio.client.user?.id) {
        if (!this.closing && (next.channelId !== audio.channelId || next.selfDeaf || next.serverDeaf)) this.fault('BOT_MOVED_OR_DEAFENED');
      } else if (next.channelId !== audio.channelId) {
        // Revoke synchronously, including PCM queued before the lifecycle queue runs.
        void this.setConsented(next.id, false);
      }
    });
    this.connection = voice.joinVoiceChannel({ guildId: audio.guildId, channelId: audio.channelId,
      adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
    let wasReady = this.connection.state.status === voice.VoiceConnectionStatus.Ready;
    this.listen(this.connection, 'error', guarded('VOICE_ERROR'));
    this.listen(this.connection, 'stateChange', (_old, next) => {
      if (this.closing) return;
      if (next.status === voice.VoiceConnectionStatus.Ready) wasReady = true;
      else if (wasReady || next.status === voice.VoiceConnectionStatus.Destroyed || next.status === voice.VoiceConnectionStatus.Disconnected) this.fault('VOICE_DISCONTINUITY');
    });
    await voice.entersState(this.connection, voice.VoiceConnectionStatus.Ready, audio.limits.readyMs);
    if (this.halted || this.closing) throw Error('AUDIO_INTERRUPTED');
    this.receiver = this.connection.receiver;
    this.listen(this.receiver.speaking, 'start', id => this.subscribe(id));
    // No subscriptions until setConsented(true), even if speaking started in handshake.
  }
  async setConsented(userId, consent) {
    if (!validId(userId)) throw Error('AUDIO_USER_INVALID');
    if (typeof consent !== 'boolean') throw Error('AUDIO_CONSENT_INVALID');
    if (!consent) {
      this.consented.delete(userId); // Must execute before any await.
      const speaker = this.speakers.get(userId);
      if (speaker) {
        this.speakers.delete(userId);
        const retired = this.dispose(speaker);
        this.retired.set(userId, retired);
        void retired.then(() => { if (this.retired.get(userId) === retired) this.retired.delete(userId); });
        await retired;
      } else {
        await this.retired.get(userId);
      }
      return;
    }
    if (this.closing || this.halted) return;
    if (this.consented.has(userId)) return;
    const occupants = new Set([...this.consented, ...this.retired.keys()]);
    if (!occupants.has(userId) && occupants.size >= this.audio.limits.maxSpeakers) { this.fault('SPEAKER_LIMIT'); return; }
    this.consented.add(userId);
    // voice 0.19.2 removes its subscriptions Map entry on actual close. Never
    // subscribe a replacement before that callback can delete the old entry.
    await this.retired.get(userId);
    if (!this.closing && !this.halted && this.consented.has(userId)) this.subscribe(userId);
  }
  subscribe(userId) {
    if (this.closing || this.halted || !this.consented.has(userId) || this.retired.has(userId) || this.speakers.has(userId)) return;
    const speaker = { userId };
    this.speakers.set(userId, speaker);
    try {
      speaker.decoder = this.audio.decoderFactory();
      speaker.stream = this.receiver.subscribe(userId, { end: { behavior: this.voice.EndBehaviorType.Manual },
        highWaterMark: this.audio.limits.maxBufferedPackets });
      if (speaker.stream.destroyed || speaker.stream.readableEnded) throw Error('STALE_STREAM');
      speaker.data = packet => this.packet(speaker, packet);
      speaker.error = () => this.fault('RECEIVE_ERROR');
      speaker.end = () => { if (!this.closing && this.speakers.get(userId) === speaker) this.fault('UNEXPECTED_EOF'); };
      speaker.close = () => { if (!this.closing && this.speakers.get(userId) === speaker) this.fault('UNEXPECTED_STREAM_CLOSE'); };
      speaker.stream.on('data', speaker.data); speaker.stream.on('error', speaker.error);
      speaker.stream.on('end', speaker.end); speaker.stream.on('close', speaker.close);
    } catch { this.fault('SUBSCRIBE_OR_DECODER_FAILED'); }
  }
  packet(speaker, packet) {
    if (this.halted || !this.consented.has(speaker.userId) || this.speakers.get(speaker.userId) !== speaker) return;
    const { limits } = this.audio;
    if (speaker.stream.readableLength > limits.maxBufferedPackets) { this.fault('PACKET_QUEUE_LIMIT'); return; }
    if (!Buffer.isBuffer(packet) || !packet.length || packet.length > limits.maxPacket) { this.fault('PACKET_SIZE_LIMIT'); return; }
    let pcm;
    try { pcm = speaker.decoder.decode(packet); } catch { this.fault('DECODE_FAILED'); return; }
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 4 || pcm.length > limits.maxPcmPacket) { this.fault('PCM_FORMAT_OR_SIZE'); return; }
    try { this.onPcm({ userId: speaker.userId, pcm, atMs: this.audio.now() }); }
    catch { this.fault('PCM_HOOK_FAILED'); }
    // No retained PCM, packets, speaker history, or per-call timing arrays.
  }
  detachRouting(speaker) {
    try {
      const subscriptions = this.receiver?.subscriptions;
      // Compatibility only for injected non-UDP test adapters. Production and
      // any UDP-capable receiver must expose the pinned voice 0.19.2 Map seam.
      if (subscriptions === undefined && this.audio.voice && typeof this.receiver?.onUdpMessage !== 'function') return true;
      if (!(subscriptions instanceof Map)) throw Error('ROUTING_MAP_UNAVAILABLE');
      // A stale speaker must never detach another stream for the same user.
      if (subscriptions.get(speaker.userId) === speaker.stream) {
        subscriptions.delete(speaker.userId);
        if (subscriptions.get(speaker.userId) === speaker.stream) throw Error('ROUTING_DETACH_FAILED');
      }
      return true;
    } catch { this.fault('RECEIVER_ROUTING_DETACH_FAILED'); return false; }
  }
  async dispose(speaker) {
    const stream = speaker.stream;
    if (stream) {
      this.detachRouting(speaker);
      if (speaker.data) stream.off('data', speaker.data);
      if (speaker.end) stream.off('end', speaker.end);
      if (speaker.close) stream.off('close', speaker.close);
      // Keep the error handler through asynchronous destroy/close.
      await new Promise(resolve => {
        if (stream.closed) return resolve();
        let timer;
        const done = () => { clearTimeout(timer); stream.off('close', done); resolve(); };
        stream.once('close', done);
        timer = setTimeout(() => { this.fault('STREAM_CLOSE_TIMEOUT'); done(); }, this.audio.limits.drainMs);
        try { stream.destroy(); } catch { this.fault('STREAM_CLOSE_FAILED'); done(); }
      });
      if (speaker.error) stream.off('error', speaker.error);
    }
    try { speaker.decoder?.close(); } catch { this.fault('DECODER_CLOSE_FAILED'); }
  }
  async drain(speaker) {
    const stream = speaker.stream;
    if (!stream) return;
    // Stop UDP -> stream pushes before base EOF, without destroying the queued
    // Opus tail. Speaking events cannot resubscribe while closing. Reconsent
    // still waits for old close, whose pinned listener deletes its Map entry.
    if (!this.detachRouting(speaker)) return;
    if (stream.readableEnded || this.halted || !this.consented.has(speaker.userId) || this.speakers.get(speaker.userId) !== speaker) return;
    if (stream.destroyed) { this.fault('DRAIN_INCOMPLETE'); return; }
    await new Promise(resolve => {
      let timer;
      const done = ok => {
        clearTimeout(timer); stream.off('end', end); stream.off('close', close);
        if (!ok && this.speakers.get(speaker.userId) === speaker && this.consented.has(speaker.userId)) this.fault('DRAIN_INCOMPLETE');
        resolve();
      };
      const end = () => done(true), close = () => done(stream.readableEnded);
      stream.once('end', end); stream.once('close', close);
      timer = setTimeout(() => done(false), this.audio.limits.drainMs);
      try {
        // Pinned voice 0.19.2 Manual AudioReceiveStream.push(null) destroys on
        // nextTick, discarding paused queued packets. Base Readable EOF drains.
        Readable.prototype.push.call(stream, null); stream.resume();
      } catch { done(false); }
    });
  }
  close() {
    if (!this.closing) {
      this.closing = true; // Before any destroy can synchronously emit a move.
      this.finished = Promise.resolve().then(() => this.finish());
    }
    return this.finished;
  }
  async finish() {
    await Promise.all([...this.speakers.values()].map(speaker => this.drain(speaker)));
    this.consented.clear();
    await Promise.all([...this.speakers.values()].map(speaker => this.dispose(speaker)));
    this.speakers.clear();
    await Promise.all(this.retired.values()); this.retired.clear();
    try { this.connection?.destroy(); } catch { this.fault('VOICE_DESTROY_FAILED'); }
    for (const remove of this.listeners.splice(0)) remove();
    if (this.audio.active === this) this.audio.active = null;
  }
}
module.exports = { Audio, createDecoder, DEFAULTS };
