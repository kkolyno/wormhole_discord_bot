# Authorized, one-shot Oracle microphone test

**Not a production transcription coordinator.** This separate entrypoint is only
for the expressly authorized **30-second, American-English microphone test**.
`index.js`, root packages, root image/deployment configuration, and the existing
meeting implementation are unchanged. The feasibility kit still rejects every
production ID; its only code extension is an optional synchronous accepted-PCM
observer in `capture.js`.

No live login/recording was performed during implementation. See
[`TEST-RESULTS.md`](TEST-RESULTS.md) for offline evidence and remaining gates.
Native/image artifacts are maintained separately; this runner expects fixed local
paths and never downloads models, installs tools, starts a server, uses Docker,
executes Discord-supplied commands, or sends audio to external STT.

## Runtime contract (operator/parent only; NOT an instruction to deploy now)

Linux, Node >=22.12.0, the exact dependencies/lockfile in
`../feasibility/package.json` (voice **0.19.2**, discord.js **14.27.0**), and:

- `/usr/bin/ffmpeg`, executable;
- `/usr/local/bin/whisper-cli`, executable, supporting whisper.cpp CLI flags below;
- `/opt/models/ggml-base.en.bin`, readable/nonempty, independently verified by the
  native-image build (this runner checks presence, **not** artifact hashes);
- a durable, writable `/data/oracle-test` directory owned by the runtime UID,
  mode **0700**. Its parent `/data` must already exist. Run without root/host
  privileges, host sockets or device access. The image also needs an init/reaper
  (such as `tini` as PID 1) so killed orphan descendants can be reaped; image
  integration and rebuild verification belong to the parent.

All credentials come from the existing **runtime environment**. No dotenv/env
file is loaded by these files; no env dump or token is logged. The test requires
these exact values and refuses overrides:

| Variable | Required value |
| --- | --- |
| `GUILD_ID` | `1465125548379607094` |
| `VOICE_CHANNEL_ID` | `1465125550036090883` |
| `CLIENT_ID` | `1465236568536252527` |
| `ALERTS_CHANNEL_ID` | `1465216403241041981` |
| `DATA_DIR` | `/data/oracle-test` (also the default if unset) |
| `DISCORD_TOKEN` | Existing Oracle token supplied privately at runtime only |

The only enabling command, after an operator has stopped the old instance and
provided the approved image/volume/runtime environment, is:

```text
node tools/oracle-test/boot.js --authorized-live-oracle-test
```

**Do not run it concurrently with any other instance of Oracle.** Neither the
branch nor the flag grants permission for an assistant to log in or record.
The exact single flag and every ID/token-identity guard pass before constructing
a client. Exactly three nonempty URL-safe token segments are required, with the
existing 256-character total limit. **Only the first identity segment** must be
canonical unpadded base64url and decode to the exact allowlisted application ID.
The trailing two segments are opaque authentication material: no decode/reencode
canonicality requirement is imposed on them. This is a local identity safety
guard, **not authentication or a cryptographic guarantee**. After login,
Discord's actual bot user AND application IDs are checked again before target
fetches/voice join. Malformed/unsupported tokens, wrong IDs or unexpected CLI
arguments fail closed without starting either test or legacy.

Local executables/model existence are checked before constructing the Discord
adapter/login. Discord intents are Guilds and GuildVoiceStates only. The bot
needs ViewChannel/Connect in the exact voice channel, and
ViewChannel/SendMessages/AttachFiles in the exact ordinary guild text alerts
channel. It never self-unmutes (`selfMute:true`, `selfDeaf:false`).

## One process/login at a time; one-shot restart behavior

1. `boot.js` checks config, verifies private storage and removes only its
   `session-*` crash leftovers. It exclusively creates/fsyncs **`attempted.json`
   BEFORE spawning the test child**, then fsyncs the containing directory.
   The filename intentionally means **attempted, not successful**. A crash,
   failed login or restart never silently rearms recording. Existing markers
   are never overwritten. Directory/marker symlinks, wrong owners or loose
   permissions are refused.
2. The test runs in a **separate process group**. The parent does not create a
   Discord client. Local ffmpeg/whisper descendants inherit the test group, but
   receive only fixed PATH/LANG, **not the token/environment credentials**.
3. On completion, errors or timeout, the test bounds cleanup and exits. The
   parent waits for the child's **actual `close`**, sends group KILL using the
   preserved process-group ID, and polls `kill(-pgid, 0)` for **up to 3 seconds**
   (25 ms intervals) to confirm that the entire group is gone. Only then does it
   remove raw crash leftovers and start original `index.js` with exactly the
   same runtime environment. Legacy gets no test flag. A still-live group,
   permission/verification error or failed group signal exits boot nonzero,
   **without cleanup or legacy launch**; KILL delivery alone is not exit proof.
4. The parent's hard test deadline is **800 seconds**, then TERM and an
   **8-second** grace before group KILL. Even a stuck native/client handle cannot
   authorize a second login before test-child exit AND confirmed group exit.
   KILL must actually take effect; if the OS never reports child exit, the parent
   will not risk a second login. Normal client destroy has a 3-second bound and the child explicitly
   exits rather than waiting forever on dependency handles.
5. On later restarts **with the flag still present**, the durable marker means
   immediate legacy mode after crash-audio cleanup; no new notice, consent or
   login from the test. Preserve the data volume across container recreation.
   An ephemeral/missing marker volume defeats this one-shot contract.
6. SIGTERM/SIGINT to boot are forwarded to the active process group. Shutdown
   never launches legacy. After the 8-second grace the parent KILLs a wedged
   child and waits for close plus confirmed group exit, including if shutdown
   arrives during that confirmation. During test shutdown, audio is marked incomplete,
   recognition is cancelled/drained briefly, no transcript is uploaded, private
   audio is removed, and a minimal outcome is written when possible. A forced
   kill/power loss may leave only the attempted marker, not a final outcome;
   next boot removes raw session leftovers.

No flags (`node tools/oracle-test/boot.js`) means **legacy immediately**, not an
offline preflight. Never invoke `test.js` directly for deployment: the one-shot
marker, watchdog, descendant cleanup and legacy handoff belong to `boot.js`.
Storage/marker verification or raw-audio cleanup failures fail closed rather
than proceeding with unsafe permissions/retention. A parent boot failure before
child launch therefore needs operator intervention or the rollback below;
ordinary test errors resume legacy only after child close, confirmed group exit
and successful privacy cleanup.

## User-visible consent and recording flow

- Login posts one clearly labeled **NONCANONICAL 30-second microphone test**
  notice to the fixed alerts channel with Start/Stop/Cancel buttons. It states
  that STT is local, Discord will receive the completed transcript, only the
  Start clicker's microphone is subscribed, and temporary audio is deleted.
- Waiting lasts **10 minutes**, with **20 seconds** for login/target/notice
  startup. There are **no voice joins, receiver subscriptions or audio packets
  before explicit Start consent**. No background recording of other occupants.
- Interaction guild/channel/message/author, session-specific custom ID and a
  nonbot Discord user must match. A current target-channel voice-state cache
  check is required before accepting Start, then checked again after the reply.
  Simultaneous Start attempts can select only one owner. That account ID is
  attribution to the transmitting account, **not proof of every physical person
  behind a shared microphone**.
- After consent the voice join has a **15-second maximum startup**. The
  **30-second recording timer starts at voice readiness**, not the button click
  or beginning of login. Start acknowledges that capture begins immediately at
  readiness. The receiver facade filters both speaking events AND subscribe
  calls to the consenting account. Immediately after constructing Capture, it
  primes **only the owner's Manual subscription**, even if their speaking-start
  event already fired during the handshake. Continuing speech does not need a
  second speaking-start event. Other users are not subscribed, decoded or written.
- Only the owner can Stop; anyone with a matching notice interaction may Cancel
  while still waiting. Cancel takes effect before any acknowledgement await and
  never starts recording. Other users cannot stop an active recording. There is
  no special operator override command; process shutdown remains available.
- Owner departure, bot move/deafening, gateway/voice reconnect/error, capture
  limits, decoding errors and recognizer failures stop and mark the test
  **incomplete**. No reconnect/replay is claimed. The legacy bot starts only
  after the separate test client has been destroyed/process exited.

## Audio, local STT, accounting and publication

`Capture` immediately writes the sole consenting speaker's observed **48 kHz,
stereo s16le WAV** and private per-packet timing/counters. Its accepted-PCM hook
feeds a single bounded utterance worker during recording. The hook is synchronous
and copies retained data, observes only successfully written/counted PCM, and a
hook failure marks capture incomplete. Existing capture semantics and feasibility
production-rejection gates are unchanged.

Packet absence of **850 ms** flushes an utterance; **8 seconds of decoded PCM**
hard-flushes uninterrupted speech while recording is still active. EOF flushes
the final short utterance. No packet absence is misrepresented as silent PCM.
**This simple test segmentation may split words; it is NOT a selected production
chunker, endpoint detector, continuous timeline or final architecture.**

One local recognizer is active. At most **12 jobs total** are accepted (including
completed jobs), with stable random-session/sequence IDs and capture-order
results. Each job has a **60-second** conversion+recognition deadline. After a
job failure/timeout the worker cancels queued work rather than overlapping a
possibly still-terminating recognizer. Overload explicitly counts unqueued PCM
bytes and ends the test incomplete; it never silently drops audio and claims
success. Every received hook byte is either in a terminal job or explicitly
counted rejected. Capture PCM totals are cross-checked against worker totals.

For each job, the runner writes a private 48 kHz stereo WAV, then launches:

```text
/usr/bin/ffmpeg -nostdin -hide_banner -loglevel error -i <private-source.wav> -ar 16000 -ac 1 -c:a pcm_s16le -t 8 -fs 524288 -f wav -n <private-16k.wav>
/usr/local/bin/whisper-cli -m /opt/models/ggml-base.en.bin -f <private-16k.wav> -l en -t 4 --no-gpu -nt -np
```

This is **real ffmpeg resampling/downmixing**, not sample-dropping. No shell,
user-controlled arguments, external STT, or outbound audio service is involved.
Native stderr is discarded; transcript stdout is held privately in memory with
an enforced **64 KiB/job** cap (overflow terminates/fails the job), never logged
or written to an unbounded native text file. Total recognized text is capped at
256 KiB. A blank recognition is explicit incomplete, not a blank summary.

Capture accepts at most **6 MiB PCM**, one speaker, 12,000 packets and a **16 MiB
capture-write budget** including timing metadata; the ordinary 30-second PCM
maximum is 5,760,000 bytes. Temporary job source is at most 1,536,044 bytes and
ffmpeg output has an additional 512 KiB size limit. Only one job writes files at
a time. Thus application-managed temporary test disk use stays well under the
**64 MiB** requirement (normally under 20 MiB), excluding read-only installed
models/tools, the container filesystem/runtime, and unrelated legacy data.
All directories/files are 0700/0600 (`umask 077` in the test child); exclusive,
no-follow source/manifest creation and a private owned directory are required.

Stop first drains the Capture EOF (bounded at 2 seconds including its own
1.5-second receiver drain), disconnects voice and flushes the worker, then waits
for all accepted jobs to become recognized/failed/cancelled, or explicitly
accounts them incomplete at a **120-second total drain deadline** (including
capture drain). On process shutdown the drain budget is 3 seconds instead.
Only then can one separate noncanonical test-result notice be posted. It includes
consenting account ID as plain text (no ping), recording duration, byte
accounting, explicit issues, capture/segmentation caveats and transcript/gaps in
capture order. Long transcripts use **one `.txt` attachment**, not message
flooding. All messages have `allowedMentions: {parse:[]}`; recognized text and
attachments escape mentions/control characters. A result is never a canonical
meeting summary and is never labeled a lossless recording.

Post failure/timeout is recorded as incomplete/unknown and **not retried**: this
one-shot test does not claim crash-safe exactly-once Discord publication. A
crash/forced kill may leave the initial notice without a result; no result does
not mean success. Buttons are disabled during final cleanup when transport is
available. Discord permission/HTTP failures cannot be fixed by this runner.

## Retention and rollback

Source/converted job WAVs are deleted after recognition (also on failure). The
entire session directory, including Capture WAVs/timing/manifest, is removed
after finalization, even on incomplete/publication failure. No audio/transcript
is intentionally retained locally after the test. Boot removes `session-*`
leftovers from a prior crash before any opt-in login. No forensic retention or
post-crash retranscription is implemented.

Only two small private durable records remain:

- `attempted.json`: schema and attempt timestamp, consumed before test begins;
- `outcome.json` when possible: outcome/reason/duration/counts/issues/timestamp,
  **no token, participant ID, recognized text or audio**.

Discord retains the posted result under its normal/user-managed policies; local
file deletion is not Discord-message deletion. Ordinary unlink/rm is not secure
erasure against storage forensic recovery. Cleanup failures require operator
intervention; abrupt host loss cannot guarantee deletion until next startup.

**Rollback (parent/operator owns all Git/image/host operations):** restore the
saved pre-test Oracle image/startup configuration, or run the unchanged original
`node index.js` in the compatible image. Stop/wait for the test/boot process group
before starting legacy—never overlap two Oracle logins. Keep the durable attempted
marker so a later flagged restart cannot accidentally rearm. Remove any raw
`session-*` leftovers privately if abandoning boot rather than restarting it.
Removing the flag alone makes boot run legacy; it does not delete old crash data.
Deleting the marker/volume is **not** rollback: it explicitly rearms another live
test and requires fresh authorization/consent. The unchanged legacy source is
the functionality fallback, not a promise that an incompatible image can run it.

## Offline checks

Only in the approved worker/container, without any production environment or
secrets, install the existing isolated lockfile if needed and run:

```sh
npm --prefix tools/feasibility ci --ignore-scripts --no-audit --no-fund
node --test tools/oracle-test/test/*.test.js tools/feasibility/test/*.test.js
```

The review-fix verification reused the existing dependencies in the designated
container (no installs or native-image execution) and ran:

```sh
docker exec -w /ws cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4 node --test tools/oracle-test/test/*.test.js tools/feasibility/test/*.test.js
```

Result: **57 tests, 56 passed, 0 failed, 1 optional ffmpeg skip**. Regressions
cover opaque/noncanonical URL-safe trailing token segments, bounded confirmed
group disappearance before legacy handoff (including failure and signal races),
and owner-already-speaking capture without a second speaking-start event.
Detailed commands and unverified image/live gates are in `TEST-RESULTS.md`.

The tests use fake Discord/voice/recognizer/subprocess boundaries, synthetic PCM,
and an isolated real child-process fixture; they never invoke boot/test CLI with
live configuration, connect to Discord or capture a microphone. An optional
synthetic ffmpeg-format test runs only when `/usr/bin/ffmpeg` exists. Actual
Discord/DAVE receive, final-word preservation over the network, whisper accuracy,
RK3588 throughput/thermal behavior and end-to-end UI behavior remain live gates
for the separately authorized operator/user exercise. There is no representative
accuracy or real-time performance claim here.
