# Handoff: robust local Discord call transcription on RK3588

## Start here

The user rejected the previous local model's transcription plan and requested a
clean restart. That plan has been deleted. Do not reconstruct it as an approved
design or treat its model choices, performance estimates, snippets, or guarantees
as evidence. This file is the requirements/context handoff, not a validated
implementation design.

**Current task:** complete the explicitly consented Oracle microphone test, then
use its evidence plus representative workload requirements to design the smallest
robust meeting-transcription integration. Target hardware and local public-sample
recognition are now verified; live microphone receive/decryption is not yet proven.
The user has authorized the bounded Oracle work described below; unrelated changes
and broader deployment still require their appropriate authorization.

**Earlier read-only 2026-10-15 feasibility phase:** see
[`docs/TRANSCRIPTION_FEASIBILITY.md`](docs/TRANSCRIPTION_FEASIBILITY.md). Read-only
OMV queries rechecked deployment status and a limited OS/RAM/load snapshot. The
isolated kit in `tools/feasibility/` passed 13 Node and 5 Python offline tests;
`experiments/whisper-smoke/` contains a pinned, successful public-sample CPU
recognition experiment. Neither ran on RK3588. No Discord login/capture or
production change occurred. The immediate next gates remain an approved target
hardware-collector run and a separately authorized, consented development-bot
receive/decode test on the target runtime. No production backend was selected.

## Live-test authorization and language (2026-10-15 follow-up)

The user has now explicitly authorized modifying the live Oracle deployment,
provided development stays on a new branch and the old functionality remains
available for rollback. The active branch is `feat/rk3588-local-transcription`;
`rollback/oracle-before-transcription` preserves original source commit `af358a4`.
American English is the intended language. The user can join for about 30 seconds
of test speech; arrange the actual recording window explicitly rather than
assuming they are already speaking.

The original live image has been preserved as
`oracle-rollback:before-transcription-20261015` (full image ID and private original
stack snapshot are recorded by the operator). Current target checks confirmed
FriendlyElec CM3588 / RK3588, ARM64, four A55 + four A76 cores, Node 22.22.0 on
Alpine 3.23.2, and rknpu driver 0.9.8. These checks supersede the earlier unknown
hardware fields, not the need for live capture and representative benchmarks.
Earlier production-access restrictions in this handoff describe the previous
authorization boundary; preserve operational safeguards and rollback for the now
authorized Oracle work. Do not touch unrelated services or expose credentials.

### Live one-shot test now deployed

See [`docs/ORACLE_LIVE_TEST.md`](docs/ORACLE_LIVE_TEST.md) for exact artifact IDs,
rollback command, private journal location, consent/retention, and measurements.
Both feature and rollback branches have been pushed; `main` is unchanged.
Native ARM64 image checks passed 57 audio/probe tests, real orphan-group handoff,
real ffmpeg/local recognition, and 38 separate administration fake tests.

The actual RK3588 recognized the fixed public English fixture. The real helper
processed 8 seconds of stereo/48 kHz input in 6.460 seconds (warm-cache RTF 0.808),
with reported one-off peak memory ~310 MiB and temperatures ~47→52°C. These are
short public-sample measurements, not sustained/multi-speaker capacity or private
call accuracy. CPU `base.en` is still a test baseline; no production model selected.

The feature image has replaced Oracle for its explicitly consented one-shot test.
The new consent notice was verified through Discord at **2026-10-15 20:33:15 UTC**:
https://discord.com/channels/1465125548379607094/1465216403241041981/1560390120241242215
The user was told it is ready. Waiting expires ten minutes after that notice.
Do not claim the user has clicked Start, audio was captured/decrypted, or private
speech was recognized until observing an actual test outcome. Raw private speech
must not be copied to agent workspaces. The test resumes unchanged legacy
`index.js` after bounded cleanup or idle expiry; it does not enable automatic
transcripts in ordinary meeting summaries. Restart does not rearm the one-shot.

**21:06 UTC update:** The first window expired at 20:43 UTC with `not_recorded`,
`arming_expired`, no consenting account and zero PCM. After the user explicitly
replied “ready”, the operator stopped Oracle, verified the private outcome had
zero PCM/jobs/issues and only its two metadata files remained, archived that
expired directory under `/data/oracle-test-expired-20261015210556`, and created a
fresh private test directory. The same verified image was recreated; no code,
image, or Compose source change was needed. Audit records are in the existing
private journal with prefix `rearm-20261015210556`.
Fresh enabled notice (verified through Discord), expires **21:16:05 UTC**:
https://discord.com/channels/1465125548379607094/1465216403241041981/1560398382244036720
The old notice remains disabled. No new consent/capture outcome has been observed.
Do not repeat this reset on any nonempty/ambiguous run; rearming required the
user's fresh readiness and explicit zero-audio expiry checks with the service stopped.

## User's clarified goal

- The bot listens to calls in the configured Discord voice channel.
- A speech-to-text model runs on the user's Rockchip RK3588 hardware.
- CPU, NPU, or a combination is acceptable. NPU was an initial preference, not a
  requirement. Choose based on measured quality, performance, and maintainability.
- Capture and transcription should proceed during the call. **Only publication
  of the final call summary waits for transcription to finish.** Do not defer all
  processing until the call ends or introduce a wait-to-start feature.
- The existing call/meeting summary post should include the transcript, alongside
  useful existing participant/duration information.
- A transcript is the required output. An LLM-generated condensed summary, live
  transcript edits, and other AI features are not required.
- Robustness matters more than preserving the previous architecture or minimizing
  changes to the existing implementation.

For long transcripts, propose one completed summary message with the full
transcript attached as a text file rather than flooding the channel with chunks.
This is a recommendation, not a user-approved output-format decision. Short
transcripts can be inline. No blank/partial canonical summary while work drains.
A recording notice or a clearly separate failure notice is not that final summary.

## Scope and unresolved product choices

Resolve only choices that materially affect implementation:

- Language is now confirmed as American English. Representative domain vocabulary
  and expected meeting size/duration remain open; do not assume a two-speaker maximum.
- Recording notice/consent, access to transcripts, and a clear stop/disable control.
  Do not retain a "No notes" button that allows capture to continue misleadingly.
- Exact session boundary behavior, especially a lone participant, brief empty
  periods, and people rejoining while an earlier session is finalizing. Existing
  prompt timers are not an approved specification for recording behavior.
- Acceptable delay after a call ends, and audio/transcript retention policy.
- Whether the existing alerts channel is the correct summary destination and
  whether a full-transcript attachment is acceptable.

The privacy promise is **local speech recognition without an additional external
STT provider**. Discord already transports the call, and posting the transcript
uploads it to Discord. Do not claim that nothing leaves the LAN.

## What exists in this checkout

Source inspection, not a claim about the currently deployed image:

- Node/CommonJS + discord.js v14; modular feature registration in `index.js` and
  `src/core/registry.js`.
- `src/features/meetings/` watches voice occupancy, prompts for manual NotesBot
  commands, tracks participant durations in memory, and sends a duration-only
  summary. It does not join voice or transcribe audio.
- `src/features/meetings/state.js` currently owns summary publication and reset.
- `src/events/errors.js` contains process shutdown handling.
- `Dockerfile` uses `node:22-alpine` and runs as non-root UID 1001.
- `docker-compose.yml` targets ARM64 but is not the actual production stack.
- `package.json` has no test script or voice/STT dependencies. No transcription
  implementation or benchmark exists in this checkout.

Read `DEPLOYMENT.md` before any host access. It preserves prior deployment/access
observations; they were **not revalidated during this cleanup**. It records an OMV
stack/container named Oracle, a GHCR image deployment, and historical identification
of the board as FriendlyElec CM3588 / RK3588. Confirm live details rather than
assuming the checkout, deployed image, and historical hardware record all match.

`scripts/omv-bot.py` provides narrowly scoped read-only status, image, and redacted
configuration queries via OMV. It is not a general shell or benchmark runner.
Do not assume OMV SSH works or that a separate agent machine is the RK3588 host.

## Known integration hazards from source review

These are reasons to redesign/test boundaries, not to abandon the project:

1. **One lifecycle owner is needed.** The current grace callback already sends a
   summary and clears shared state. A separate transcription publisher bolted onto
   it can publish too soon, duplicate the summary, or lose participant metadata.
2. **Current timers are not the documented ideal.** `startJoinGraceTimer()` is
   defined/imported but never called. The grace timer starts at one or zero humans;
   it is not necessarily a full empty-channel grace period. Startup with people
   present posts a fresh prompt rather than recovering durable session state.
3. **Async races exist.** Voice handlers are not serialized. A grace callback can
   check an empty channel, await network work, and then clear state after someone
   rejoins. Clearing a timer cannot cancel an already-running callback.
4. **Unknown occupancy is mistaken for empty.** `fetchChannel()` returns null on
   errors; `getHumanCount(null)` returns zero. Lookup failure must not end a call.
5. **Shutdown does not await cleanup.** It invokes callbacks, destroys the client,
   and exits. Async drain/checkpoint work would be abandoned.
6. **There is no durable meeting state.** JSONL transcript lines alone would not
   recover session identity, pending audio, missing results, or publication progress.
   No persistent writable data volume is currently configured.
7. **Compose/config mismatch:** local Compose supplies `NOTES_TEXT_CHANNEL_ID`,
   while source requires `ALERTS_CHANNEL_ID`. Core config also requires `CLIENT_ID`.
   Do not blindly deploy the local Compose example to production.

## Architecture is open; evidence comes first

A separate local STT process/service is a reasonable candidate for isolating
native dependencies from the bot, but not a mandatory architecture. Separate
Compose containers use service networking, not a shared localhost by default.
Moving audio across hosts also requires a transport/security/failure policy.

Compare a small number of concrete candidates, not an exhaustive model survey:

- A suitable sherpa-onnx CPU model.
- A suitable whisper.cpp CPU model/configuration.
- An RKNN/NPU path if the actual OS/driver/runtime and model support make it
  practical. Neither require NPU use nor defer it automatically without evidence.

Pin model artifacts, versions, quantization, and licenses/checksums for whichever
candidate is tested. Do not infer real-time capability from CPU specifications or
"6 TOPS." Confirm actual RAM, OS, cooling, runtime compatibility, and host load.

Continuous capture does not require streaming recognition. Transcribing bounded
utterances during the call may be simpler than partial-result streaming. Choose
based on measured performance and correctness, not terminology. Do not implement
progressive summary editing unless separately requested.

## Feasibility gates before substantial implementation

### A. Capture on the target runtime

Use a separate development bot/token and test channels, or explicitly coordinate
an authorized production stop. Prove receive/decrypt/decode with two users,
join/leave, silence, and reconnects on the actual ARM64 container/runtime.

Check current upstream voice-receive limitations, DAVE/E2EE support, Node version,
and native/WASM dependencies. Do not rely on the deleted plan's "validated" label.
For reference, the reviewed @discordjs/voice 0.19.2 package required Node >=22.12.0;
recheck whichever version is selected. Receive support is not a stable documented
Discord API guarantee.

Use `selfDeaf: false`; unmuting the bot is not necessary just to listen. Isolate
codec and recognition state per speaker. Validate actual decoded sample formats
and packet sizes; implement proper resampling/framing rather than assuming every
buffer matches a model window. Attribute speech to the transmitting Discord user;
that is not proof of an individual identity behind a shared microphone.

### B. Recognition on representative audio

Measure accuracy and names/technical vocabulary, concurrent throughput, backlog,
finalization delay, RAM, and sustained thermal/load behavior. Include silence,
short utterances, overlapping speakers, and long sessions. Synthetic clean WAVs
alone are insufficient; use appropriately consented representative audio.

Set explicit acceptance thresholds with the user. Define RTF and concurrency
measurements clearly. Record results and limitations; do not report estimates as
benchmarks or call unexecuted snippets tested.

## Reliability requirements for the implementation design

- One authoritative session coordinator with stable session IDs and explicit
  capture, draining, completed, failed/incomplete, and publication states.
- A session closing must not block capture for a new session or share mutable
  participant/transcript buffers with it. Define rejoin behavior explicitly.
- Specify silence/utterance handling and EOF. Discord packet absence is not
  continuous silent PCM. Do not strip silence and then assume recognizer endpoint
  detection will see it. Flush final audio and signal input completion correctly.
- Preserve capture-time ordering and speaker identity, not result-arrival order.
- Bound queues, memory, disk use, retries, and finalization time. Define overload
  behavior and backpressure; never silently drop speech and label output complete.
- For a service boundary, define audio/result IDs, format, sequence/acknowledgment,
  end-of-input, drain completion, reconnect/replay, and duplicate-result behavior.
- Persist session and publication state in writable durable storage. Decide which
  audio must be retained temporarily for recovery; respect a bounded retention
  policy and delete it when no longer required.
- Startup recovery must work even when the voice channel is now empty. Await
  bounded shutdown/checkpoint work and provide adequate container stop grace.
- Prevent normal duplicate publication and reconcile ambiguous sends across crashes.
  An in-memory enum alone cannot provide exactly-once Discord delivery.
- Publish the normal final summary only after all accepted audio is accounted for.
  If audio was lost or recognition failed, surface an explicit failure/incomplete
  outcome according to the agreed policy, never a silently "complete" transcript.
  Audio never received during an outage cannot be recovered by software promises.
- Escape/control Discord mentions from recognized text, restrict transcript access,
  and avoid storing speech or credentials in routine logs.
- Use least-privilege runtime/device access; privileged containers are not an
  automatic prerequisite for NPU operation.

Automate lifecycle/protocol tests with fake audio/recognizer/Discord boundaries.
Exercise sidecar death, bot restart, shutdown, packet gaps, last-word-at-disconnect,
rejoin during drain, channel-fetch failure, disk/queue limits, Discord send failure,
and crash after a successful send. A happy-path demo is not robustness evidence.

## Working-tree and operational safety

- This cleanup changed documentation only. No host was contacted, no bot started,
  no dependencies installed, and no runtime source/configuration changed.
- Removed the rejected `TRANSCRIPTION_PLAN.md` and stale
  `.github/copilot-instructions.md` (which incorrectly prescribed `config.json`
  credential storage).
- Preserved prior uncommitted work: credential exclusions in `.gitignore` and
  `.dockerignore`, `.mcp.json`, deployment documentation, and `scripts/omv-bot.py`.
  Check `git status` before edits; do not blindly reset or delete these files.
- `.private/omv.json` and `.env.local` contain credentials. Do not print, commit,
  place in handoffs, or upload them into workers. Do not start a duplicate bot
  with the production token. The application does not automatically load `.env.local`.
- Isolate dependency installation/builds/tests and substantial development from
  the production host and the user's working tree. Follow the available development
  sandbox policy. Hardware benchmarks need a separately agreed target-host path;
  an arbitrary development sandbox does not prove RK3588 behavior.
- No production image pull, restart, stack change, driver installation, or privileged
  workload without explicit authorization. Preserve rollback information.

## Suggested opening for the next conversation

"Read HANDOFF.md and DEPLOYMENT.md. Build toward robust local RK3588 transcription
for this Discord bot. Capture and process audio during calls; only the final
summary publication waits for the completed transcript. The prior plan was
rejected. Start by identifying what can be verified safely and the minimum
hardware/audio feasibility tests. Keep implementation decisions evidence-based,
and do not alter production without permission."
