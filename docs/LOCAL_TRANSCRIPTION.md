# Local meeting transcription (feature branch)

## Status and authorization

The user approved continued Oracle development after reporting that the consented
30-second microphone transcript was good and responsive. The actual target is an
RK3588 / FriendlyElec CM3588, ARM64 Node22.22.0 on Alpine3.23.2. Local CPU Whisper
base.en is the first integration baseline because it has now processed real Discord
speech usefully on target. No NPU or external speech-recognition service is needed.
This does not establish sustained or multiple-speaker throughput.

**The new meeting mode is OFF by default and is not yet deployed to Oracle.**
The unchanged legacy meetings feature remains the default; the two modes are
mutually exclusive. `main` and the exact original rollback image remain preserved.
The earlier one-shot image resumes legacy handling after its test and does not
add transcripts to normal meeting summaries.

**Delivery decision pending:** long-transcript attachments have been proposed,
not approved. The implementation supports them only with the explicit boolean
configuration below. Without that opt-in, oversized final output is durably held
for review; no blank/partial canonical summary is posted.

## Participant experience

When the first human joins the configured voice channel, Oracle creates a session
and posts a local-transcription notice in the alerts channel. A lone participant
can use it. The notice remains usable while that meeting stays active; there is
no ten-minute prototype test window.

- **I consent: record my mic:** only the clicking account's audio is subscribed.
  The account must be in the configured voice channel and use the current notice.
- **Stop my microphone:** revokes that account's consent and capture.
- **End recording:** ends capture for everyone for this session. No new recording
  session is automatically offered until a known empty room has been observed.
- Leaving, interruptions and restart invalidate consent. Rejoining requires a new
  click; no capture silently resumes from a stored consent flag.
- Consent must cover everyone audible through a shared microphone. Attribution is
  to the transmitting Discord account, not proof of a person's identity.

Participant presence/duration is tracked for all attendees, as with the old bot.
Only explicitly consented audio windows enter recognition. The normal final post
combines participant durations with the transcript and explicit gaps/incomplete
status when necessary. The bot suppresses mention notifications in recognized text
and summaries. Discord already transports voice and retains posted transcripts;
“local” means no additional external STT provider, not that nothing leaves the LAN.

## Lifecycle and processing

One coordinator owns each session's lifecycle and canonical publication. It does
not bolt a second publisher onto the old grace callback.

1. A known occupied room starts an isolated, durable session.
2. Explicit consent creates per-account manual Opus streams and independent WASM
   decoder state. Receive is not self-deafened; the bot remains self-muted.
3. Bounded private PCM chunks are persisted while capture proceeds. Recognition
   begins during the call at eight-second chunks or packet gaps; it does not wait
   for the call to finish. Packet absence is not inserted as synthetic silence.
4. One global native recognition slot covers every speaker AND old/new sessions.
   ffmpeg properly resamples stereo48kHz/s16le PCM to mono16kHz WAV. CPU whisper.cpp
   recognizes English using four threads, with private bounded output.
5. A continuously **known empty** room closes after the configured grace. One
   remaining human does not end the call. Unknown occupancy never means empty.
6. End freezes the old session, drains capture EOF and accounts for all accepted
   jobs. A new session can capture while an old one recognizes/publishes, without
   sharing participant or transcript buffers.
7. Only ready, terminal/accounted sessions can publish the canonical summary.
   Native, storage, queue, transport and restart gaps are explicit—not “complete”.

On restart, durable open/queued/running jobs are recovered; active capture ends
as interrupted, durations stop at the last durable observation, and consent is
not restored. Abandoned speech older than retention is deleted at startup before
recognition or publication, not replayed after an extended outage. A separate
private, identifier-free boolean preserves the wait-until-empty safety hold even
when session records expire. Async shutdown stops capture and checkpoints pending
work rather than waiting minutes for every queued recognition; it still awaits
owned late-publication continuations before releasing the writer lock. A real kernel `flock` provides
one writer across processes/containers sharing the data volume; PID guesses are
not used as a substitute. Use a local filesystem with verified fsync/rename/flock
semantics, not an unvalidated network filesystem.

## Publication and recovery limits

Before HTTP, the outbox durably records a stable nonce, payload identity and send
intent. Acknowledged delivery records its message ID. Recovered/ambiguous sends
are reconciled against bounded bot-authored history with exact inline content.
A missing history match is **not proof of failed delivery** and never triggers a
blind duplicate send. Attachment bytes cannot be verified through the content-only
history port; an ambiguous attachment send remains held for operator review.
This is not a distributed exactly-once guarantee.

A closed notice explicitly says recording stopped rather than merely graying its
buttons. Stale/wrong-guild/wrong-channel/foreign-author/old-session interactions
cannot grant consent. The `/transcription-status` command exposes bounded state,
not transcript text, credentials, raw exceptions or private file paths.

Raw PCM is private (0700 directory, 0600 files), retained while pending durable
processing/recovery and deleted after a terminal outcome. Conversion output is an
anonymous private inode inherited by native children, avoiding crash-left scratch
files. Normal transcript/metadata retention is 24 hours after the session ends;
crashes or unavailable storage can delay cleanup and require operator intervention.
Do not promise a deletion deadline on a machine that is offline or cannot write.
Never copy private call recordings into development workers or routine logs.

## Configuration and safety caps

See `.env.transcription.example`. Important settings:

```dotenv
LOCAL_TRANSCRIPTION_ENABLED=false
LOCAL_TRANSCRIPT_ATTACHMENTS=false
LOCAL_TRANSCRIPTION_DATA_DIR=/data/transcription
LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS=90
LOCAL_TRANSCRIPTION_MAX_SESSION_SECONDS=14400
LOCAL_TRANSCRIPTION_MAX_DRAIN_SECONDS=300
```

`LOCAL_TRANSCRIPTION_ENABLED=true` selects the new feature instead of legacy.
Only literal `true` enables it. Only literal `true` enables long-output attachments.
The usual DISCORD_TOKEN/CLIENT_ID/GUILD_ID/VOICE_CHANNEL_ID/ALERTS_CHANNEL_ID still
apply; provision them privately, never in this repository or worker sandboxes.

Default protective caps: 256MiB outstanding PCM, 128 pending jobs, eight-second
utterances, eight concurrent consenting accounts, 32 distinct participants,
four-hour sessions, 4MiB retained transcript text, 64 retained sessions, and bounded
recognition/drain/native-output limits. These are failure/resource caps, **not**
a claim that RK3588 can transcribe eight simultaneous talkers in real time.
Exceeding capacity stops/marks incomplete rather than silently dropping accepted
speech. Expected meeting size, duration and acceptable finalization delay still
need representative target measurements.

## Image, deployment and rollback

`Dockerfile.transcription` inherits the pinned, verified ARM64 CPU runtime/model
artifact from `docs/ORACLE_LIVE_TEST.md`, then installs the locked runtime packages
and util-linux flock. It keeps UID1001 and Tini, creates private durable storage,
and defaults to the unchanged legacy behavior unless explicitly enabled.

The existing publishing workflow has a separate, explicit feature-branch dispatch
mode `local_transcription=true`, mutually exclusive with `oracle_test`. It uses
native ARM64 and a `transcription-<full40commitsha>` tag, never `latest` or a short
SHA. The loaded image must pass offline native preflight and fixed-hash public
English inference before push; the same tested bytes are pushed without rebuild.
Publishing/deploying is an operator step after review, not done by workers.

A future Oracle activation needs a separately reviewed override: the immutable new
image, explicit enable/attachment policy, dedicated durable volume, and adequate
stop grace (at least35s). The existing one-shot administration helper intentionally
does not accept this new mode; do not loosen its allowlist or reuse its cached
activation job as if it were a new deployment.

The original rollback branch is `rollback/oracle-before-transcription` at
`af358a4`. Exact original image:
`sha256:b44105db8c52b15918f068653f0c52eaa2d1c2e70cfc0220a2e3b72b9d379edc`.
The current private original-source/deployment journal and old-image rollback
procedure remain described in `docs/ORACLE_LIVE_TEST.md` and
`scripts/ORACLE-TEST-OPERATIONS.md`. Keep them private and do not prune the old image.

## Verification

New tests use synthetic PCM, fake Discord/voice/recognition boundaries and public
English fixture audio only. Native-image checks must additionally exercise actual
ffmpeg/Whisper, anonymous-fd inheritance, process cancellation, UID1001 storage,
OS lock contention and model hashes with no network or bot credentials.

See `docs/LOCAL_TRANSCRIPTION_RESULTS.md` for final reviewed test counts, exact
source/image evidence and remaining gates. Source-only tests are not target-load
or sustained multi-speaker evidence. No deployment readiness is inferred merely
from a running Docker container.
