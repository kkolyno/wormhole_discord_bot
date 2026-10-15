'use strict';
// Deliberate WASM fallback, not a native-addon auto-selection. No FFmpeg/STT.
function createDecoder() {
  const Opus = require('opusscript');
  const codec = new Opus(48000, 2, Opus.Application.AUDIO, { wasm: true });
  return { decode: (packet) => codec.decode(packet), close: () => codec.delete() };
}
function preflight() {
  const fs = require('node:fs');
  const path = require('node:path');
  function version(name) {
    let dir = path.dirname(require.resolve(name));
    while (dir !== path.dirname(dir)) {
      const p = path.join(dir, 'package.json');
      if (fs.existsSync(p)) { const info = JSON.parse(fs.readFileSync(p)); if (info.name === name) return info.version; }
      dir = path.dirname(dir);
    }
    throw new Error('VERSION_UNKNOWN');
  }
  require('@discordjs/voice'); // Check the actual module can load on this runtime too.
  const dave = require('@snazzah/davey'); // API may be native or WASI; no session/network.
  const decoder = createDecoder();
  decoder.close();
  return { mode: 'offline_preflight', node: process.version, platform: process.platform, arch: process.arch,
    versions: Object.fromEntries(['@discordjs/voice', '@snazzah/davey', 'discord.js', 'prism-media', 'opusscript'].map(n => [n, version(n)])),
    dave: { moduleLoaded: true, sessionApiAvailable: typeof dave.DAVESession === 'function',
      implementation: 'unknown', version: dave.VERSION, receiveDecryptVerified: false },
    opus: { choice: 'opusscript WASM', decoderConstructed: true, nativeAddonUsed: false },
    transport: { aes256gcmAvailable: require('node:crypto').getCiphers().includes('aes-256-gcm'),
      xchachaFallbackInstalled: false, negotiatedModeVerified: false },
    caveat: 'No Discord login, receive, decryption, hardware performance, or STT verification.' };
}
module.exports = { createDecoder, preflight };
