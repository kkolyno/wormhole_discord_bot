#!/bin/sh
# Offline only: never starts index.js, boot.js, a Discord client, or STT provider.
set -eu
cd /app
test "$(id -u)" = 1001
test "$(uname -m)" = aarch64
test "$(node -p 'process.versions.node')" = 22.22.0
printf '\n== Runtime versions (container kernel is NOT the target RK3588) ==\n'
node --version
npm --version
cat /etc/alpine-release
uname -srm
ffmpeg -version
printf '\n== Build versions ==\n'
cat /usr/share/oracle-test-image/build-versions.txt
printf '\n== Shared library resolution ==\n'
ldd /usr/local/bin/whisper-cli
if ldd /usr/local/bin/whisper-cli 2>&1 | grep -E 'not found|Error loading|Error relocating'; then exit 1; fi
# The local recognizer deliberately sanitizes its subprocess environment.
# Verify linkage without relying on this image's LD_LIBRARY_PATH variable.
env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/local/bin/whisper-cli --help >/dev/null 2>&1
printf '\n== Verify English model before use ==\n'
test "$(wc -c < /opt/models/ggml-base.en.bin)" -eq 147964211
echo 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002  /opt/models/ggml-base.en.bin' | sha256sum -c -
printf '\n== Runtime package versions ==\n'
npm ls --omit=dev
npm ls --prefix tools/feasibility --omit=dev
printf '\n== Offline DAVE API / Opus WASM preflight (not receive/decryption proof) ==\n'
node tools/feasibility/probe.js
npm test --prefix tools/feasibility
printf '\n== Offline Oracle boot/storage/STT unit tests (mocked adapters, no login) ==\n'
node --test tools/oracle-test/test/*.test.js
printf '\n== Actual orphan process-group handoff under Tini (no bot login) ==\n'
node tools/oracle-test-image/boot-group-smoke.js
printf '\n== UID1001 private data directory contract ==\n'
node -e 'require("./tools/oracle-test/storage").privateDir(process.env.DATA_DIR)'
printf '\n== UID1001 data write and real ffmpeg resampling ==\n'
T=$(mktemp -d /data/oracle-test/image-preflight-XXXXXXXX)
trap 'rm -rf "$T"' EXIT HUP INT TERM
ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.1' -ac 2 -c:a pcm_s16le "$T/input.wav"
ffmpeg -nostdin -hide_banner -loglevel error -i "$T/input.wav" -ar 16000 -ac 1 -c:a pcm_s16le "$T/output.wav"
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of default=noprint_wrappers=1 "$T/output.wav" > "$T/format.txt"
cat "$T/format.txt"
grep -qx 'codec_name=pcm_s16le' "$T/format.txt"
grep -qx 'sample_rate=16000' "$T/format.txt"
grep -qx 'channels=1' "$T/format.txt"
printf '\nPASS: offline image preflight; no Discord login, live audio, NPU, or RK3588 benchmark.\n'
