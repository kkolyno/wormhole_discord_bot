# Local meeting transcription implementation contract (2026-10-15)

This is a new implementation contract based on the working, consented RK3588
experiment, not the deleted/rejected plan. Implementation remains feature-gated
OFF by default; do not deploy or log in while developing. Parent coordinates Git
and production. The user reports the live transcript was good and near-real-time.
The private test outcome had 3,271,680 PCM bytes / four jobs / 30 s window; it also
had BOT_MOVED_OR_DEAFENED after duration_limit. The old adapter lacks an intentional
teardown guard in its VoiceStateUpdate listener: new code must distinguish this
from actual disconnect/deafen faults. No private audio/transcript enters workers.

## Ownership

- Core worker: `src/features/local-transcription/{store,scheduler,coordinator}.js`,
  `test/local-transcription/{store,scheduler,coordinator}*.test.js` only.
- Audio worker: `src/features/local-transcription/{audio,recognizer}.js`,
  `test/local-transcription/{audio,recognizer}*.test.js`, plus the old test adapter
  teardown guard in `tools/oracle-test/test.js` and its adapter regression tests.
- Integration/image worker: root `package*.json`, `index.js`, `src/events/errors.js`,
  `src/features/local-transcription/{index,config,lock}.js`, `Dockerfile.transcription`,
  `.github/workflows/docker-publish.yml`, `.env.transcription.example`,
  `test/local-transcription/{feature,config,lock,shutdown}*.test.js`, image test scripts.
- Parent owns `src/features/local-transcription/publisher.js`, publisher tests,
  documentation, evidence and final integration fixes after children finish.

## Behavior and scope

Preserve original meetings feature unchanged and select either it OR this feature
in root index using strict LOCAL_TRANSCRIPTION_ENABLED=true; never two summary
owners. Disabled is original behavior. Enabled: first known human in configured
voice channel creates a session and posts a notice. Joining alone is supported.
Only each account explicitly clicking consent while in that voice channel is
subscribed. Stop-own-microphone really revokes consent immediately. Leave/rejoin,
gateway/voice interruption and restart invalidate consent; no silent auto-resume.
Shared-mic consent warning required. No external STT and no private speech logs.

Use static button IDs local_transcription_consent, local_transcription_revoke,
local_transcription_end. Validate guild, alerts channel, bot message author, exact
current notice ID, human user and current voice membership. End stops capture for
this session, holds off new prompts until a known empty channel has been observed.
No misleading No-notes button. Status command explains recording, queue, draining,
incomplete or held publication without exposing transcript text.

End after continuously KNOWN empty channel for configured empty grace (default
90s); one person remaining does not end the call. Unknown occupancy is not empty.
Explicit end, max duration, capture fault/overload and restart mark appropriate
reasons; interruptions are explicit incomplete. Metadata tracks ALL participants
and accumulated durations. Recover active session durations only to last durable
lastSeenAt, not across an unknown outage. Rejoin within empty grace is same session
but requires fresh per-account consent. New sessions can capture while old ones
recognize/publish; no awaiting drain in the serialized lifecycle event queue.

## Shared data/API (coordinate deviations before changing)

CommonJS. Numeric times are wall-clock milliseconds, injected now() defaults
Date.now. Valid account IDs are 17–20 digit strings. Session IDs are randomUUIDs;
filenames use strictly validated safe IDs, never user display names.

Session record (store JSON):
{schema:1,id,startedAt,endedAt:null|number,lastSeenAt,phase:'active'|'draining'|
'ready'|'published',participants:{[id]:{id,name,joinedAt:null|number,durationMs,
consented:boolean,everConsented:boolean}},issues:[],stopReason:null|string,
notice:{state:'pending'|'sending'|'sent'|'uncertain'|'closed',id?:string},
publication:{state:'pending'|'sending'|'sent'|'uncertain'|'held',...}}
Additional bounded metadata fields may be added. Use store.patchSession(id,patch)
(read-current + shallow-patch synchronously) so publisher/coord never overwrite
one another's fields from stale async snapshots.

Job record:
{schema:1,id,sessionId,userId,sequence,startMs,bytes,state:'recording'|'queued'|
'running'|'recognized'|'no_speech'|'failed'|'cancelled',text?:string,issue?:string}
sequence is session-wide allocation order; output sorted by startMs then sequence,
NOT completion order. startMs is offset relative to session start. PCM is 48kHz,
stereo, s16le, four bytes/frame. Gap absence is not synthetic silence.

Store constructor: new Store({root, limits={}}). Public publisher-compatible API:
getSession(id), patchSession(id,patch), listSessions(), listJobs(sessionId).
Core may add createSession/job/audio methods. Private root 0700 UID-owned no
symlink; files 0600 exclusive/no-follow; bounded atomic JSON writes with fsync,
rename and parent fsync. PCM job metadata is durable BEFORE audio creation;
append PCM to a per-job file, never an ever-growing whole-call WAV. fsync accepted
PCM before returning acceptance (or explicitly document/test a durable batch
protocol). Never rewrite all historical jobs/transcripts per packet. Recover open
PCM via actual validated/aligned file size; mark interruption, don't assert
lossless audio. Commit terminal result before deleting its PCM; idempotent cleanup.
Default max spool 256 MiB, max queued/running jobs 128, max utterance 8*192000 B,
max session 4h, max concurrent consenting accounts 8, max distinct participants32,
max transcript bytes4MiB, max retained sessions64, metadata/transcript retention24h.
These are protective caps, NOT measured multi-speaker capacity claims. Refuse/fault
clearly rather than silently discard or exceed caps. Delete raw PCM on terminal
recognition/failure/cancellation; keep only bounded recovery data while needed.
Store also exposes getControl()/setHoldUntilEmpty(bool); private .control.json
contains only this safety boolean so retention cannot erase a wait-until-empty
hold. Startup recovery expires abandoned data before any recognition/publication.

new Coordinator({store,audio,recognize,publisher,now,limits})
- async init(): recover durable jobs/sessions even with empty current channel;
  interrupted active sessions end/invalidate consent; no restart capture.
- async membership(members|null): members [{id,name}], known snapshot; null unknown.
- invalidate(userId): SYNCHRONOUS consent gate removal, called immediately on leave
  BEFORE any awaited lifecycle queue; subsequent PCM must not be accepted.
- async consent(userId,noticeId), async revoke(userId,noticeId), async end(noticeId)
- async fault(code), async tick(), async shutdown(); status() returns bounded metadata.
- lifecycle methods serialized internally; capture callbacks do synchronous bounded
  durable writes, guarded by session object/consent gate, never mutable next session.
- tick called every250ms by feature. Flush PCM at 8s or >850ms packet gap, while
  capture continues. Empty-grace/session deadlines checked without async races.
- finalization background-owned: after capture EOF and every accepted job terminal,
  mark ready and call publisher.publish(sessionId). max drain default300s; timeouts
  cancel and explicitly mark incomplete, accounting for accepted work. Shutdown
  checkpoints/requeues rather than waiting minutes; recovery handles pending jobs.
- don't expose raw exception messages/text through events/status/logs.

Audio port: new Audio({client,guildId,channelId,now=Date.now,...injectable deps})
async open({sessionId,onPcm,onFault}) -> handle
handle async setConsented(userId,bool), async close(). Prime ONLY consenting
owner immediately after ready (speaking.start may have occurred during handshake).
onPcm({userId,pcm,atMs}) is synchronous; only bounded decoded frames. Per-speaker
codec/stream; bounded packets and PCM; no whole-call WAV/timing retention. Ignore
intentional close/move events during teardown. Unexpected disconnect, bot moved,
self/server deafen, receive/decode failure -> safe fixed code onFault. Use voice
0.19.2 Manual stream base Readable.push EOF regression seam to drain buffered tail;
no new subscriptions during close. Remove listeners/codecs deterministically.

Recognize port: exported async recognize(job,{signal}), job contains absolute
validated `path` to its private raw PCM plus bytes etc. Real ffmpeg resamples input
48k stereo s16le ->16k mono WAV; whisper-cli base.en / four CPU threads / no GPU,
English, plain transcript stdout privately bounded64KiB. Sanitized child env, no
shell. Use unique private conversion file, clean it on all paths, never delete
source PCM (store owns). Abort TERM then KILL, await actual close; bound command
runtime; never overlap a timed-out native process with the next job. Exact zero
PCM may return {text:'',noSpeech:true} without running recognition. Nonzero PCM
returns a string, including '' when the model yields no words; that is not proof
of silence. Don't remove quiet speech with an unmeasured energy threshold. Scheduler sole global single recognizer slot;
limits/backlog are global across speakers AND old/new sessions.

Publisher port implemented by parent:
new Publisher({store,transport,allowAttachments=false,now})
async notice(sessionId), async closeNotice(sessionId), async publish(sessionId),
async drain(). Shutdown awaits drain after lifecycle background work; every late
send acknowledgement/notice edit remains owned until no Store writes can follow.
transport async send(payload)->{id}; async edit(id,payload);
async history({limit,before})->[{id,authorId,content,createdTimestamp}].
transport has botUserId. All sends bounded at transport layer with AbortSignal/
REST timeout; ambiguous sends never blindly retried. publisher patches only notice
and publication fields (phase published only after acknowledged/reconciled send).
Notice uses three static buttons and states consent/stop/end/retention/coverage.
Canonical publication is ONE completed message: participant durations + transcript
inline, or attachment ONLY if LOCAL_TRANSCRIPT_ATTACHMENTS=true (defaultfalse).
Long text without approval -> durable held publication, no blank canonical post.
Fail/incomplete jobs explicit in transcript/header; no false completeness or pings.
Persist outbox sending intent BEFORE HTTP; stable nonce + enforceNonce and unique
session/content marker; uncertain or recovered sending reconciles bounded history,
matching bot author and exact expected inline body, not merely a marker/hash.
Attachment ambiguity remains held for byte-level review.
Not-found/insufficient history is HELD uncertain,
not automatic resend. Cannot promise distributed exactly-once Discord delivery.

OS writer lock: integration owns lock.js, use actual util-linux flock (not PID
heuristics across containers). The parent keeps an open descriptor; a short-lived
flock helper acquires on the same inherited open-file description. The parent
keeps the kernel lock after helper exit and releases it only after cleanup or
parent death. A persistent helper's death must not unlock an old live writer.
Single writer across volume/namespaces. No speech or credentials in lock metadata.
Startup waits for lock before coordinator recovery; loss stops capture. Shutdown
awaits cleanup callbacks with a bounded global shutdown deadline; feature pauses/aborts native work, checkpoints and releases lock
before client destroy. Adequate container stop grace documented (>=35s).

## Verification / operations

Use only supplied worker via docker exec -w /ws CONTAINER ... for execution/tests,
installs and builds. No Git or live access in workers. Credentials absent. Unit
coverage: restart/open/queued/running/result persistence, missing/corrupt PCM,
disk/queue bounds, silence/final words, leave/rejoin and consent races, unknown
occupancy, rejoin during drain, multi-speaker global serialization/fairness,
finalization deadline, shutdown cancellation, failed/ambiguous send + crash after
successful send, mention escaping, long-output hold/attachment opt-in, async
shutdown timeout, true OS lock contention, intentional teardown versus real faults.
Native image preflight + public sample inference and actual ffmpeg helper tests;
never use private call recordings in workers. Build/test before parent integrates.
Publish only via explicit feature-branch dispatch with a new transcription-<full
commit SHA> tag, no latest/main override. Parent will decide deployment separately.
