#!/bin/sh
# Offline-only; never execute index.js or construct/log in a Discord client.
set -eu
umask 077
cd /app
test -z "${DISCORD_TOKEN:-}"
test "$(id -u)" = 1001
test "$(uname -m)" = aarch64
test "$(node -p 'process.versions.node')" = 22.22.0
test "${LOCAL_TRANSCRIPTION_ENABLED:-false}" != true
printf '\n== Runtime and inherited native build evidence ==\n'
node --version
npm --version
uname -srm
cat /etc/alpine-release
cat /usr/share/transcription-image/build-versions.txt
/usr/bin/flock --version | grep util-linux
ffmpeg -version
ldd /usr/local/bin/whisper-cli
if ldd /usr/local/bin/whisper-cli 2>&1 | grep -E 'not found|Error loading|Error relocating'; then exit 1; fi
env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/local/bin/whisper-cli --help >/dev/null 2>&1
test "$(wc -c < /opt/models/ggml-base.en.bin)" -eq 147964211
echo 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002  /opt/models/ggml-base.en.bin' | sha256sum -c -
printf '\n== Exact dependency versions and offline native codec load ==\n'
npm ls --omit=dev
node - <<'NODE'
const assert = require('node:assert/strict');
const expected = { 'discord.js': '14.27.0', '@discordjs/voice': '0.19.2', '@snazzah/davey': '0.1.12', opusscript: '0.0.8' };
for (const [name, version] of Object.entries(expected)) assert.equal(require('./package.json').dependencies[name], version);
const dave = require('@snazzah/davey');
assert.equal(typeof dave.DAVESession, 'function');
const Opus = require('opusscript'), codec = new Opus(48000, 2, Opus.Application.AUDIO);
try { assert.equal(codec.decode(codec.encode(Buffer.alloc(960 * 4), 960)).length, 960 * 4); } finally { codec.delete(); }
const fs = require('node:fs'), stat = fs.lstatSync('/data/transcription');
assert.equal(stat.uid, 1001); assert.equal(stat.mode & 0o777, 0o700);
assert.equal(stat.isSymbolicLink(), false);
console.log('PASS: DAVE native load and Opus synthetic roundtrip (not real DAVE receive proof)');
NODE
printf '\n== Fake/synthetic unit contracts, real OS lock, bounded shutdown ==\n'
# Permission-negative fixtures deliberately mkdir(0755); do not narrow that
# fixture with the smoke shell's private-audio umask. Store sets its own modes.
(umask 022; node --test test/local-transcription/*.test.js)
printf '\n== Actual ffmpeg resampling, no private audio ==\n'
T=$(mktemp -d /data/transcription/image-preflight-XXXXXXXX)
trap 'rm -rf "$T"' EXIT HUP INT TERM
ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.1' -ac 2 -c:a pcm_s16le -f s16le "$T/input.pcm"
ffmpeg -nostdin -hide_banner -loglevel error -f s16le -ar 48000 -ac 2 -i "$T/input.pcm" -ar 16000 -ac 1 -c:a pcm_s16le "$T/output.wav"
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of default=noprint_wrappers=1 "$T/output.wav" > "$T/format.txt"
cat "$T/format.txt"
grep -qx 'sample_rate=16000' "$T/format.txt"
grep -qx 'channels=1' "$T/format.txt"
grep -qx 'codec_name=pcm_s16le' "$T/format.txt"
printf '\nPASS: offline image preflight, no bot login/live audio/deployment.\n'
