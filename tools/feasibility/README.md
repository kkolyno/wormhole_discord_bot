# Isolated RK3588 / Discord receive feasibility kit

Development evidence only. **Not bot integration, a transcription system, or a
production deployment.** There are no production imports, messages/posts,
summaries, uploads, external STT calls, model downloads, or audio-recording actions
in the offline tests. Capture/decode/file writes happen **during** an explicitly
consented live run; only final manifest generation waits for receiver drain.

**Current blockers:** no RK3588 hardware run, no actual Discord receive/decrypt
confirmation, no representative STT benchmark. ARM64 sandbox compatibility is not
RK3588 performance evidence. This package does not install or select an STT backend;
the separate public-sample experiment is in `../../experiments/whisper-smoke/`.
SBC installation/start requires separate user approval and an agreed nonproduction
path. Do not access the deployment described in the copied handoffs using this kit.

## Files

| File | Purpose |
| --- | --- |
| `hardware.py` | Python standard-library, read-only, bounded hardware snapshot |
| `probe.js` | Offline default; explicitly gated development-only live entrypoint |
| `config.js` | Consent, test IDs, duration, and production-identity refusal |
| `capture.js` | Per-speaker synchronous decode/WAV writes and bounded final drain |
| `codec.js` | Explicit Opus WASM fallback and offline dependency/API checks |
| `package.json`, `package-lock.json` | Exact direct dependencies and full npm resolution |
| `test/*.test.js`, `test/test_hardware.py` | Offline boundary/codec/startup/collector tests |
| `TEST-RESULTS.md` | Commands, observed results, and unverified gates |

## Hardware collector: no install needed

Run on an **approved** Linux runtime with Python 3, not via a management API or a
shell on an unauthorized host:

```sh
python3 hardware.py
# Fixture root: no version commands or real uname are used
python3 hardware.py --root /path/to/fixture
```

The JSON allowlist is model/compatible (NUL-separated device-tree values rendered
as text), architecture/kernel release (not nodename), ID/VERSION_ID/PRETTY_NAME,
MemTotal/MemAvailable, three load averages (not the runnable-task/PID suffix),
logical CPUs and allowlisted type identifiers, current/max frequency in kHz,
governor, thermal zone type/current/trip temperatures in millidegrees C, readable
rknpu module version, render/rknpu node metadata, and existence of six fixed
`librknnrt.so` candidates. Candidates are not a comprehensive library search;
`false` does not prove the runtime is absent. Libraries/devices are not opened for
use. No `modprobe`, `modinfo`, package installation, sudo, serials, hostname,
process lists, network data, credentials, or environment dump.

No executables are discovered or invoked: Node/Docker versions are always
`unknown/not_run`, even if `commands=True` is passed to the compatibility API.
Inherited PATH wrappers are not trusted inventory sources. Run the package
preflight separately in an approved environment for Node/package evidence; Docker
is not required by this collector. Files have a 64 KiB read cap. Enumeration takes
at most 256 CPUs, 64 zones, 64 trips per zone, and 32 nodes per pattern before
sorting that bounded subset (not necessarily every match).
Missing/denied/oversize readings are explicitly `status: unknown`.
The importable `Snapshot(root, runtime=..., commands=...)` interface supports tests
without touching the real machine. Container visibility
can differ from the SBC host. **A snapshot cannot establish cooling adequacy, NPU
usability, or real-time inference speed.**

## Offline setup and tests

Use only an approved disposable environment. This package has no connection to the
parent application's dependencies. Node **>=22.12.0** is required by voice 0.19.2.

```sh
cd tools/feasibility
npm ci --ignore-scripts --no-audit --no-fund
npm run preflight                # same as node probe.js; NEVER logs in
npm test
npm run test:hardware
```

Exact direct pins: `@discordjs/voice` 0.19.2, `discord.js` 14.27.0,
`prism-media` 1.3.5, `@snazzah/davey` 0.1.12 (satisfies voice's ^0.1.9), and
`opusscript` 0.0.8. This deliberately uses **WASM**, not `@discordjs/opus` or
prism's automatic decoder selection. opusscript 0.1.1 conflicts with prism 1.3.5's
optional peer range; no forced/legacy peer install was used. No FFmpeg is needed.
DAVE module/API load is checked, but its implementation is reported as **unknown**:
`DAVESession` may be provided by a native binding or transparent WASI fallback.
An exported constructor does not prove native loading. No DAVE session or handshake
is created in preflight. AES-256-GCM is available in the tested Node build; no optional
XChaCha library is installed. Actual transport negotiation remains unverified.

## Future live test — NOT authorized by creating this kit

Obtain approval for a specific nonproduction target/path and a maximum duration.
Use a **separate development application/bot/token**, never the production token.
Arrange informed consent from every person who might join; a CLI acknowledgement
is the operator's assertion, **not** Discord-side consent enforcement. Use an
access-restricted test guild/channel. The probe does not send a recording notice:
announce recording and the stop control yourself before starting.

Grant the dev bot only View Channel and Connect in that channel. No Administrator,
Send Messages, message-content/member privileged intent, or ability to speak is
needed. Gateway intents are Guilds and GuildVoiceStates. Join parameters are
`selfDeaf: false`, `selfMute: true`. The probe accepts ordinary guild voice
channels, not Stage channels. Do not grant host/device privileges or install
additional drivers for this test.

After authorization, install/test the isolated package at the agreed path using
the commands above. Supply credentials interactively or through an approved
secret mechanism; never put a token in argv, source, shell history, or a report.
For example, **in a Bash shell on that approved runtime**, not executed here:

```bash
umask 077
mkdir -m 700 recordings                 # parent must exist; use a fresh session path below
read -r -s -p 'Development token: ' DEV_DISCORD_TOKEN; printf '\n'
export DEV_DISCORD_TOKEN
export TEST_APPLICATION_ID='YOUR_NONPRODUCTION_APPLICATION_ID'
export TEST_GUILD_ID='YOUR_NONPRODUCTION_GUILD_ID'
export TEST_VOICE_CHANNEL_ID='YOUR_NONPRODUCTION_VOICE_CHANNEL_ID'
node probe.js --record --consent-ack --seconds 60 --out recordings/trial-001
unset DEV_DISCORD_TOKEN
```

No dotenv or env-file is loaded by the kit. Default/preflight mode ignores token
presence and never logs in. Missing either explicit flag, token, valid test IDs
(including required `TEST_APPLICATION_ID`), or a 1–120 integer duration fails closed
before reaching the live entrypoint. Production guild `1465125548379607094` and
channel `1465125550036090883` are rejected. Before any login, the token must have
three nonempty URL-safe segments; the first must be canonical unpadded base64url
and decode to a 17–20 digit bot ID matching the expected nonproduction application ID.
Malformed/unsupported formats are refused; production application
`1465236568536252527` is refused both as configured ID and decoded token identity,
even with unrelated guild/channel IDs. No token or decoded payload is printed.
**Token decoding is a safety guard, not authentication or cryptographic validation**;
a forged identity segment cannot establish who the server will authenticate.
After login, actual bot user/application identities must both match the expected ID
and must not be production **before joining voice**. Never supply a production token. SIGINT/Ctrl-C or SIGTERM initiates bounded drain/cleanup and marks the
session interrupted/incomplete. No automatic reconnect is attempted or validated.

### Minimum acceptance exercise on the actual target runtime

1. Save an allowlisted hardware snapshot and offline preflight output. Record Node,
   OS/runtime and install results. Verify the private output location and both
   users' explicit consent before starting. Do not treat successful preflight as
   receive success.
2. With two consenting users, speak distinct known phrases one at a time, repeat
   after silence, then overlap. Include short/long speech, join/leave/rejoin, and
   silence. Keep each run at most 120 seconds; bounds may stop it earlier as
   incomplete (16 MiB per speaker is about 87 seconds of continuous PCM).
   Observe output file sizes increasing
   **during** the call without inspecting audio on the agent's behalf.
3. End speech just before the time cap; check final-word retention. The **user**
   privately inspects each speaker WAV after consent: attribution, phrase content,
   separation, stereo/48 kHz format, short/long frames, and no cross-speaker bleed.
   Compare PCM frame/byte totals with the timing JSONL and WAV header. Audible
   phrases under the actual E2EE call are needed for receive/decrypt evidence;
   binary load alone is not evidence.
4. In a separate run, interrupt networking or trigger a reconnect/move/deafen.
   Expect stop, explicit incomplete/issues and no continuing-success claim. Start
   a new consented run after recovery, with a fresh output path. Never assume
   outage audio can be recovered. Test Ctrl-C/SIGTERM and receiver/permissions
   failures as well. Record failure codes without credentials or audio payloads.
5. Record observed loss/uncertainty honestly. No audio or transcript should be
   uploaded by this kit. Agree a local retention/deletion policy and delete private
   outputs when no longer needed. Do not feed them to an external STT service.

## Output, bounds, and interpretation

A new output directory is created `0700`; existing paths are refused. Each file
uses exclusive/no-follow creation and mode `0600` (umask may further restrict).
For each transmitting Discord user, `speaker-<id>.wav` contains separate **48 kHz,
stereo signed 16-bit little-endian PCM**, and `speaker-<id>.jsonl` records accepted
packet capture wall time, monotonic session-relative milliseconds, PCM offsets,
frame and byte counts. These IDs and timing are private data. No speech payloads,
credentials, raw exceptions, or IDs are logged to the console. A transmitting
Discord account does not prove who is physically behind a shared microphone.

There is one WASM decoder handler per speaker and a manual receive subscription
kept across speaking start/end cycles. Variable PCM lengths are counted, not
assumed to be 960 frames. Pinned opusscript supports at most 60 ms per packet;
2.5, 5, 10, 20, 40 and 60 ms were tested offline. Oversize/unsupported/failed packets
make the run incomplete; this is not full support for all possible Opus framing.

Hardcoded live limits: four **unique** speakers over the whole run, 16 MiB PCM per
speaker, 48 MiB total PCM, 64 MiB conservatively accounted file writes (including
metadata, header rewrites, and manifest reserve), 24,000 packets, 3,828 encoded
bytes/packet, 11,520 decoded bytes/packet, and at most 120 seconds of capture.
120 seconds is a maximum, not a guaranteed recording length: 16 MiB per speaker
at 192,000 PCM bytes/second allows about **87.4 seconds** of continuous decoded
stereo audio; total PCM, disk, speaker, packet and other bounds can stop earlier
with `incomplete`. A duration timer plus a monotonic per-packet guard enforce the
time cap. Manifest space is reserved. Limits/decode/file/receive faults halt capture and mark incomplete.
No ever-growing PCM/packet/timing array is retained. Small packet writes/decode
are synchronous, so there is no asynchronous application write queue. Receive
streams use a 16-packet high-water mark; UDP itself cannot be backpressured.
Blocking CPU/disk work can cause **unknown upstream loss**, not a lossless guarantee
or a tested SBC throughput bound. This bounds application buffering, not total
Node/DAVE/WASM runtime memory or all dependency internals.

At stop, new subscriptions cease. The voice **0.19.2 Manual-mode** drain seam uses
`Readable.prototype.push.call(stream, null)` plus `resume()`: the package override
of `push(null)` schedules next-tick destruction and can discard a paused buffered
tail. The base Readable EOF preserves that queue and normal auto-destroy follows
`end`; Manual mode has no end timer to cancel. This seam is pinned and regression
tested with the actual exported `AudioReceiveStream`; re-review it on upgrades.
Already-buffered packets are consumed and drain is awaited for up to 1.5 seconds. Each synchronous decode has already emitted its PCM; no
last decoder window is held for later inference. WAV lengths are patched, files
and decoder handlers closed, then the manifest is written/closed privately and
published as `manifest.json` using an exclusive hard link (no overwrite). A failed
write/close/publish leaves no newly published final manifest; any
`.manifest.pending.json` is untrusted and may be partial. Client cleanup has
a separate two-second wait bound. Startup has a 20-second deadline. Public REST
`makeRequest` composes shutdown/request abort signals with a three-second HTTP
and response-body deadline, disables retries, and rejects rate-limit queuing.
Shutdown aborts HTTP rather than only racing an await; after each target fetch the
abort state is checked before proceeding (no channel fetch after stopped guild
fetch). No forced process exit is used to abandon drain.

`drained_observed_audio` means only that locally observed packets drained without
a reported local failure. It **does not mean complete recording, no packet loss,
DAVE verified, or successful transcription**. `incomplete` covers no audio, limits,
unexpected EOF/close, receive/decode/write failures, interrupted/failed joins and
observed disconnect/reconnect. Some upstream DAVE decrypt discards do not surface
as stream errors; their count and RTP/network packet loss remain `unknown`.
There is no RTP sequence/timestamp accounting, reorder/replay recovery, packet-loss
concealment, silence insertion, durable recovery, or tested reconnect support.

Packet absence is **not silent PCM**. WAVs concatenate observed decoded audio,
while JSONL provides post-decrypt arrival timing, not exact sender/capture clocks.
Do not treat WAV sample offsets as a continuous call timeline or perfectly align
overlap from them. Crash/power loss can leave a stale WAV header or missing/partial
manifest; no fsync/recovery guarantee is provided. Output/manifest write failures
are reported to the console and nonzero exit, not hidden as completion. A failure
before capture initialization may have no manifest.

No resampling or STT is done. Preserve the 48 kHz stereo source for a future,
properly tested resampling/channel strategy once a recognition backend is chosen.
Only a future **canonical summary publication** should wait for all processing;
capture/decoding must continue during calls. None of that production publication
or recognition lifecycle is implemented by this feasibility kit.
