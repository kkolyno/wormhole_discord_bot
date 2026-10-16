# Idle disconnect lifecycle contract

Scope: opt-in `src/features/local-transcription/` only. The legacy meeting feature and original Dockerfile are unchanged. This does not authorize deployment, live Discord testing, private audio use, or transcript attachments.

## Timeouts and activity

- Core and environment/config defaults: known-empty grace **15 seconds**, inactivity **300 seconds**.
- `LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS`: strict integer seconds, 1–3600.
- `LOCAL_TRANSCRIPTION_IDLE_SECONDS`: strict integer seconds, 1–14400. No whitespace, fractions, suffixes, zero, negative, null or out-of-range values. Configuration is fixed at process startup.
- Existing maximum session duration (at most four hours), drain bounds, capacity limits, safety holds and fixed `manual|channel` consent policy remain in force.
- A session's initial inactivity clock begins when the session is created; its first actual microphone authorization starts the capture clock. This covers manual sessions with no consent, channels where everyone is paused, and authorized sessions where nobody ever speaks. A slow voice handshake cannot spend the new capture's entire inactivity budget before authorization.
- Only a **fully accepted, structurally valid, authorized decoded PCM packet containing any nonzero byte** advances inactivity, using `coordinator.elapsedNow()`. Production defaults to monotonic `performance.now()`; known-empty grace uses the same elapsed clock. Packet `atMs` remains a segmentation/offset input, never an inactivity clock authority.
- Exact-zero PCM can be accepted/accounted/transcribed as exact-zero but does not advance inactivity. This is **not semantic VAD, a speech detector, or noise filtering**: any accepted nonzero noise can keep a session alive.
- Rejected/invalid packets, unauthorized or personally paused microphones, revoked/left/unknown accounts, and old/closing runtimes cannot refresh the current session's inactivity clock. Existing valid EOF-tail acceptance is preserved for its own old runtime.
- Wall timestamps remain presentation/persistence values. A sealed `endedAt` is clamped to at least `startedAt`, so rollback cannot create a negative duration or make a final payload unpublishable. Explicit End still freezes its request-time cutoff before queue/EOF awaits; the clamp never extends that cutoff to the later queue time. Participant duration increments remain nonnegative. Wall rollback can under-report displayed durations/offsets; this is not a reconstruction of real elapsed call duration. Existing maximum-session, scheduler/recovery, retention and drain clocks are otherwise unchanged (not a general wall-clock refactor).
- Tests may inject `now` and `elapsedNow` independently. For compatibility, an injected custom `now` also drives elapsed time unless `elapsedNow` is supplied; the production default does **not** use wall-clock subtraction for inactivity or empty grace.
- At the boundary (`>=`), a known-occupied inactive session stops with distinct reason `inactivity`. Known-empty uses its own exact grace boundary; unknown is neither empty nor an inactivity completion trigger and resets empty grace. Any observed unknown during capture remains an explicit `OCCUPANCY_UNKNOWN` issue; faults are not converted into successful quiet completion.

## Stop, draining, and publication

Idle shutdown durably commits idle-wait **before** detaching current capture, initiating receiver close, or posting closed status. It then follows the existing close/EOF/drain path:

1. Close receiver; accept only already-authorized buffered EOF work under the runtime's remaining gates.
2. Seal input, queue remaining accepted work and durable intents, checkpoint byte counts.
3. Preserve the physical-close barrier even if logical EOF times out. A new native receiver may not overlap an unresolved old close.
4. Run the existing **singleton** recognition scheduler across old/new sessions. An idle-woken meeting can exist while the old meeting's results drain, but not bypass the shared native slot.
5. Publish the canonical final only after sealed input, terminal job accounting and accepted/received/accounted byte checks. Close faults, rejected packets, timeout/cancellation and accounting discrepancies remain explicit incomplete issues.

A closed recording-status notice is not the canonical final. It can be posted before recognition completes; it explicitly explains that recording stopped and results may still drain. Attachments remain unapproved/default OFF, including oversized output held by the existing publisher policy.

## Durable idle-wait and wake provenance

`.control.json` adds one optional bounded boolean, `idleWait` (legacy absence means false), independent of `holdUntilEmpty` and the existing maximum-32 `automaticOptOuts` array. No idle membership-ID history or unbounded join log is stored. Status exposes a fixed idle-wait boolean, not control account IDs or transcript text.

Idle-wait survives restart, gateway recovery and metadata retention deletion. Occupied polling, startup snapshots, changed polling snapshots, and unknown-to-known recovery snapshots **do not** count as fresh joins and cannot form an idle rejoin loop.

Core membership API:

```js
const token = coordinator.prepareArrival(userId); // synchronous gateway event time
membership(members /* array or null */, { arrivals: token ? [token] : [] })
```

The adapter obtains a token only for an actual gateway voice-channel arrival while gateway continuity is known. Core requires idle-wait eligibility **at event time**, continuously known previous occupancy where that account was absent, and a fresh current snapshot where it is present. The adapter retains at most 32 pending account/token pairs across superseded snapshot fetches, so mute/deafen or another same-guild voice event cannot silently discard a new arrival. Only a generation-current snapshot consumes the pending evidence; absent arrivals cannot wake. Direct synchronous core callers may still use `{ arrivalId }` as shorthand for preparing a token at the membership call, but asynchronous adapters must prepare before awaiting. A trusted gateway departure synchronously removes that account from the already-bounded observed set (and revokes its gates), so a fast leave/rejoin still works if the older leave snapshot is blocked or superseded; it does not invent a known-empty snapshot or reset personal optouts. Thus a new member, or an account leaving and rejoining while others remain, can wake an idle meeting. A poll or initial/recovery snapshot alone never supplies this authority. Gateway epochs discard fetch results superseded by later events without discarding still-valid pending arrival tokens. Core control epochs invalidate tokens across inactivity stop, Stop, End, unknown occupancy and faults; gateway discontinuity also clears adapter evidence. An arrival observed **before** inactivity cannot replay when a slow fetch completes after the stop. Empty/unknown barriers and pending arrival authorization are retained in bounded coalescing; a later unknown/Stop/End invalidates older wake authority.

A trustworthy known-empty observation clears idle-wait through the ordered lifecycle path; the next occupied observation may start normally. Its reset token captures observation-time authority: a queued/coalesced empty older than a later authenticated End or safety fault cannot clear that newer durable hold, create even an interim runtime, open a receiver or subscribe a microphone. A newer valid empty observed after End/fault still resets normally, including when lifecycle work is blocked. Unknown and personal Stop invalidate older reset authority too; personal optouts are still cleared synchronously at the valid empty observation, never by a stale queued reset. Existing known-empty release semantics otherwise remain unchanged. **An occupied idle wake or Start never releases an explicit End, safety or duration hold.**

Wake transactions persist a session `idleWakePending` intent before opening audio. The control clear is committed before the intent is cleared. Recovery upgrades an interrupted intent back to idle-wait **before pruning** can remove session evidence. Completed cancellation clears its intent only through a durable stop checkpoint; it cannot become a permanent tombstone after a later known empty. Idle-control write failure stops acceptance immediately, fails the lifecycle operation and attempts a durable global fallback hold. Arbitrary persistent disk failure cannot guarantee a new write; in-process failure remains closed and corrupt/unrecoverable metadata refuses startup.

A bounded session `lifecycleOrder` provides latest-notice ordering even for equal timestamps; it is not user-controlled content or an account-ID history.

## Start recording again

Static component ID: `local_transcription_start`.

- Visible as **Start recording again** on appropriate closed `inactivity`/`known_empty` notices. Other microphone/End controls are disabled in the closed display. Active notices show Start disabled.
- Eligible only for the latest retained eligible bot-authored notice, in the configured guild and alerts channel, with known current presence of the authenticated nonbot account in the configured voice room. Wrong room/guild/author, outsiders, stale/deleted notices, existing current capture, unknown occupancy, and End/safety/duration holds are rejected.
- It starts a **new session under the existing fixed policy**, not a policy edit, consent click, or Resume operation. Channel policy automatically authorizes only eligible unpaused occupants. Manual policy opens no microphone until a fresh explicit consent click on the new notice. Personal optout records are not erased by Start or idle stop.
- Both adapter and core validate synchronously before asynchronous fetch/interaction acknowledgement and revalidate epochs after awaits. Bounded pending controls prevent old Start HTTP from undoing a later Stop/End/leave/unknown/safety event. Slow voice readiness and per-account subscription are fenced too.
- Authenticated privacy Stop/End requests on the latest closed source may conservatively cancel an in-flight Start, despite their disabled presentation. Personal Stop remains permitted for an already-accounted participant even if occupancy is unknown. These controls cannot affect an independently active later meeting through an old notice.
- Notice close intent is durable before outstanding POST acknowledgement. Closing or late acknowledgement never restores active consent controls. Old Start is disabled when a new session starts or a hold wins; a slow closed PATCH is followed by a corrective disabled PATCH if eligibility changed, and failed correction remains retryable. HTTP failure cannot grant authority: durable/core checks reject stale controls even when remote presentation cannot be corrected.
- Retention deletion rejects old button requests safely; leaving/rejoining (or a trustworthy subsequent new arrival) remains the fallback. No new unbounded notice or membership index is retained.

## Verification boundaries

Tests use fake Discord/audio/inference ports, real Store/Coordinator/Publisher integration, real OS lock/process tests, and synthetic PCM. Native image preflight additionally uses real ffmpeg, Opus/DAVE native loading and the pinned public JFK fixture only. These establish local lifecycle/ordering contracts, not real gateway/DAVE receiving, production account permissions, private-call recognition accuracy, sustained speaker capacity or target-device timing. See `IDLE_DISCONNECT_RESULTS.md` and the sanitized evidence directory for actual run results.
