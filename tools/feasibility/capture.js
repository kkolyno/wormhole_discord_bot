'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Readable } = require('node:stream');
const { createDecoder } = require('./codec');

function wavHeader(bytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}
const DEFAULTS = Object.freeze({ maxSpeakers: 4, maxPcmPerSpeaker: 16 * 1024 * 1024,
  maxPcmTotal: 48 * 1024 * 1024, maxDisk: 64 * 1024 * 1024,
  maxDurationMs: 120000, maxPackets: 24000, maxPacket: 3828, maxPcmPacket: 11520, drainMs: 1500 });
const MANIFEST_RESERVE = 16384;

class Capture {
  constructor({ out, receiver, manualEnd = 0, decoderFactory = createDecoder, io = fs,
    limits = {}, now = () => performance.now(), wall = () => new Date().toISOString(), onFault = () => {}, onPcm = null }) {
    this.io = io; this.out = path.resolve(out); this.receiver = receiver; this.manualEnd = manualEnd;
    this.decoderFactory = decoderFactory; this.limits = { ...DEFAULTS, ...limits };
    this.now = now; this.wall = wall; this.onFault = onFault; this.onPcm = onPcm;
    this.started = now(); this.startedAt = wall();
    this.speakers = new Map(); this.notes = new Set(); this.diskBytes = 0; this.pcmBytes = 0;
    this.packets = 0; this.rejected = 0; this.closing = false; this.halted = false;
    this.io.mkdirSync(this.out, { mode: 0o700 }); // No recursive mkdir; EEXIST fails closed.
    this.startListener = (id) => this.subscribe(id);
    receiver.speaking.on('start', this.startListener);
  }
  fault(code) {
    this.notes.add(code);
    if (!this.halted) { this.halted = true; setImmediate(() => this.onFault(code)); }
  }
  open(name) {
    return this.io.openSync(path.join(this.out, name), fs.constants.O_CREAT | fs.constants.O_EXCL |
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  }
  write(fd, data, position = null, reserve = true) {
    if (this.diskBytes + data.length > this.limits.maxDisk - (reserve ? MANIFEST_RESERVE : 0)) throw new Error('DISK_LIMIT');
    let offset = 0;
    while (offset < data.length) {
      const n = this.io.writeSync(fd, data, offset, data.length - offset, position === null ? null : position + offset);
      if (n <= 0) throw new Error('WRITE_FAILED');
      offset += n; this.diskBytes += n;
    }
  }
  subscribe(id) {
    if (this.closing || this.halted) return;
    if (!/^\d{1,20}$/.test(id)) { this.fault('SPEAKER_ID_INVALID'); return; }
    let s = this.speakers.get(id);
    if (s?.stream && !s.stream.destroyed && !s.stream.readableEnded) return; // Repeat utterances retain manual stream.
    if (!s) {
      if (this.speakers.size >= this.limits.maxSpeakers) { this.fault('SPEAKER_LIMIT'); return; }
      s = { id, bytes: 0, packets: 0, frames: 0, subscriptions: 0, wav: null, timing: null, decoder: null };
      this.speakers.set(id, s);
      try {
        s.decoder = this.decoderFactory(); // Distinct codec state for each transmitting user.
        s.wav = this.open(`speaker-${id}.wav`);
        this.write(s.wav, wavHeader(0));
        s.timing = this.open(`speaker-${id}.jsonl`);
      } catch { this.fault('OUTPUT_OR_DECODER_INIT_FAILED'); return; }
    }
    try {
      const stream = this.receiver.subscribe(id, { end: { behavior: this.manualEnd }, highWaterMark: 16 });
      s.stream = stream; s.subscriptions++;
      stream.on('data', (packet) => this.packet(s, packet));
      stream.on('error', () => this.fault('RECEIVE_ERROR'));
      stream.once('end', () => { if (!this.closing) this.notes.add('UNEXPECTED_EOF'); });
      stream.once('close', () => { if (!this.closing) this.notes.add('UNEXPECTED_STREAM_CLOSE'); });
    } catch { this.fault('SUBSCRIBE_FAILED'); }
  }
  packet(s, packet) {
    if (this.halted) { this.rejected++; return; }
    const at = this.wall(), relativeMs = Math.max(0, this.now() - this.started);
    if (relativeMs > this.limits.maxDurationMs) { this.rejected++; this.fault('DURATION_LIMIT'); return; }
    if (!Buffer.isBuffer(packet) || packet.length === 0 || packet.length > this.limits.maxPacket) {
      this.rejected++; this.fault('PACKET_SIZE_LIMIT'); return;
    }
    if (this.packets >= this.limits.maxPackets) { this.rejected++; this.fault('PACKET_COUNT_LIMIT'); return; }
    let pcm;
    try { pcm = s.decoder.decode(packet); } catch { this.rejected++; this.fault('DECODE_FAILED'); return; }
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 4 || pcm.length > this.limits.maxPcmPacket) {
      this.rejected++; this.fault('PCM_FORMAT_OR_SIZE'); return;
    }
    if (s.bytes + pcm.length > this.limits.maxPcmPerSpeaker || this.pcmBytes + pcm.length > this.limits.maxPcmTotal) {
      this.rejected++; this.fault('PCM_BYTE_LIMIT'); return;
    }
    const row = Buffer.from(JSON.stringify({ packet: s.packets, capturedAt: at, relativeMs,
      pcmFrameOffset: s.frames, pcmFrames: pcm.length / 4, pcmBytes: pcm.length }) + '\n');
    try {
      // Synchronous small writes: no unbounded application queue; process during the call.
      // Disk latency can still cause upstream network loss: this is not a lossless pipeline.
      this.write(s.wav, pcm);
      this.write(s.timing, row);
      s.bytes += pcm.length; s.frames += pcm.length / 4; s.packets++;
      this.pcmBytes += pcm.length; this.packets++;
    } catch { this.rejected++; this.fault('WRITE_OR_DISK_LIMIT'); return; }
    // Optional synchronous observer of accepted PCM; consumers must copy if retaining.
    // It cannot change capture counters or the existing file/production safety gates.
    try { this.onPcm?.({ id: s.id, pcm, relativeMs, pcmFrameOffset: s.frames - pcm.length / 4 }); }
    catch { this.fault('PCM_HOOK_FAILED'); }
  }
  stop(reason = 'duration') {
    if (!this.stopping) this.stopping = this.finish(reason);
    return this.stopping;
  }
  async finish(reason) {
    this.closing = true;
    this.receiver.speaking.off('start', this.startListener);
    const drained = await Promise.all([...this.speakers.values()].map(s => new Promise(resolve => {
      const stream = s.stream;
      if (!stream || stream.readableEnded) { resolve(true); return; }
      if (stream.destroyed) { this.notes.add('DESTROYED_BEFORE_DRAIN'); resolve(false); return; }
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true; clearTimeout(timer); stream.off('end', end); stream.off('close', close); resolve(ok);
      };
      const end = () => done(true), close = () => done(stream.readableEnded);
      const timer = setTimeout(() => { this.notes.add('DRAIN_TIMEOUT'); done(false); stream.destroy(); }, this.limits.drainMs);
      stream.once('end', end); stream.once('close', close);
      try {
        // Version-pinned seam for voice 0.19.2 Manual AudioReceiveStream: its push(null)
        // override schedules nextTick destroy(), losing a paused buffered tail. The base
        // Readable EOF preserves that queue; resume drains before normal autoDestroy.
        // Manual mode has no end timer to cancel; no new subscriptions are accepted.
        Readable.prototype.push.call(stream, null); stream.resume();
      } catch { this.notes.add('EOF_SIGNAL_FAILED'); done(false); stream.destroy(); }
    })));
    if (drained.some(x => !x)) this.notes.add('DRAIN_INCOMPLETE');
    this.halted = true;
    for (const s of this.speakers.values()) {
      try { if (s.wav !== null) this.write(s.wav, wavHeader(s.bytes), 0); }
      catch { this.notes.add('WAV_FINALIZE_FAILED'); }
      for (const fd of [s.wav, s.timing]) {
        if (fd !== null) { try { this.io.closeSync(fd); } catch { this.notes.add('CLOSE_FAILED'); } }
      }
      try { s.decoder?.close(); } catch { this.notes.add('DECODER_CLOSE_FAILED'); }
    }
    if (!this.packets) this.notes.add('NO_AUDIO_OBSERVED');
    const manifest = { schema: 1, outcome: this.notes.size ? 'incomplete' : 'drained_observed_audio',
      reason, startedAt: this.startedAt, stoppedAt: this.wall(), durationMs: this.now() - this.started,
      format: { sampleRate: 48000, channels: 2, encoding: 's16le', container: 'WAV', gapSilenceInserted: false },
      packets: this.packets, pcmBytes: this.pcmBytes, pcmFrames: this.pcmBytes / 4,
      rejectedPackets: this.rejected, issues: [...this.notes].sort(), limits: this.limits,
      speakers: [...this.speakers.values()].map(s => ({ id: s.id, packets: s.packets, pcmBytes: s.bytes,
        pcmFrames: s.frames, subscriptions: s.subscriptions })),
      loss: { upstreamPacketLoss: 'unknown', daveDiscardedPackets: 'unknown',
        caveat: 'No RTP sequence/timestamps exposed here. Arrival times are post-decrypt, not sender clock. Packet absence is not silent PCM. Drained does not assert complete or DAVE-verified capture.' } };
    let fd;
    try {
      fd = this.open('.manifest.pending.json');
      this.write(fd, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), null, false);
      this.io.closeSync(fd); fd = undefined;
      // Publish only after close succeeds; hard-link creation refuses an existing final path.
      this.io.linkSync(path.join(this.out, '.manifest.pending.json'), path.join(this.out, 'manifest.json'));
      try { this.io.unlinkSync(path.join(this.out, '.manifest.pending.json')); }
      catch { /* A redundant private hard link is harmless; not a capture failure. */ }
    }
    catch { manifest.outcome = 'incomplete'; manifest.issues.push('MANIFEST_WRITE_OR_PUBLISH_FAILED'); }
    finally { if (fd !== undefined) { try { this.io.closeSync(fd); } catch { manifest.outcome = 'incomplete'; manifest.issues.push('MANIFEST_CLOSE_FAILED'); } } }
    return manifest;
  }
}
module.exports = { Capture, wavHeader, DEFAULTS };
