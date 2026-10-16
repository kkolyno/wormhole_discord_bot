# Standing channel consent: authorized automation extension

User clarification (2026-10-15): this is a private company channel; all employees have consented. Recording must be automatic even for one person/solo brain dumps. Consent behavior must be an administrator-modifiable setting. This supersedes per-meeting click requirements ONLY when the operator deliberately enables the new channel policy. No production deployment is included in this development task.

## Configuration/API

- `LOCAL_TRANSCRIPTION_ENABLED=true` still selects the new feature; default remains disabled/legacy.
- `LOCAL_TRANSCRIPTION_CONSENT_MODE=manual|channel`, default `manual`. Reject every other value, including empty/whitespace/misspellings. No truthiness booleans.
- `channel` is an explicit operator attestation of valid standing consent for ALL human accounts admitted to the configured private channel, including anyone audible through shared microphones. No global/other-channel recording. Guests without consent require manual mode or separate channel/access controls. Do not infer consent from employment in manual mode.
- Coordinator constructor adds `consentMode='manual'`, strict enum validation; feature passes cfg.consentMode. Coordinator.status includes the fixed mode and bounded automatic-optout count.
- Store.createSession({startedAt,consentMode='manual'}) persists policy; old records lacking policy mean manual. Publisher reads SESSION policy, never current environment, so recovery does not reinterpret prior notices or summaries.
- No changes to one-shot activation/markers or legacy feature sources. No workflow dispatch, publication, deployment or production credentials.

## Channel policy behavior

1. A KNOWN snapshot with >=1 human automatically opens capture and subscribes all eligible humans, including lone occupants, initial startup with occupied room, later joins and rejoin. No notice-button or notice-send acknowledgement dependency; an asynchronously posted notice explains company standing-consent automatic recording. Bot presence/notice are still visible.
2. Empty room and bots only do not open capture. Unknown occupancy synchronously removes gates; it never counts as empty. Once occupancy is trustworthy again, automatic grants can resume under standing policy (manual still requires fresh button).
3. Normal restart ends/recover-drains prior session, then automatically starts a new session for known nonempty room under current channel policy. Persisted explicit End/safety holds and personal optouts MUST survive restart; do not clear them merely because mode is channel.
4. Gateway-interruption stop may recover automatically in channel mode after gateway is ready and occupancy known. DO NOT bypass safety holds for overload/disk/native faults, deliberate bot move/deafen, explicit End, capacity limit or configured maximum duration. These remain visible operator/safety stops; automatic mode is not an unbounded retry loop. Document the four-hour configured max-session stop and other caps, not unlimited uninterrupted recording.
5. Stop my microphone pauses just that account until it explicitly uses Resume my microphone on the current notice OR a KNOWN empty channel is observed. It must not be regranted by polling, another join, leave/rejoin, unknown occupancy, restart, metadata pruning, or pending voice readiness. End recording pauses session-wide until known empty. Explicit resume must not clear a later Stop or stale-notice epoch.
6. A Stop request cuts off gates AND records the automatic suppression before any interaction/snapshot HTTP await. Feature calls coordinator.revoke immediately after validating exact active bot-owned notice/guild/channel/user, observes returned promise, then acknowledges; validation must not require a successful later fetch to preserve own stop. End already has synchronous cutoff.
7. All automatic grants use same gated/subscription/lifecycle safety checks as manual grant. Avoid calling an enqueued consent method while holding the lifecycle queue (deadlock). Use a shared internal grant helper. Recheck runtime identity, known current membership, optout state, mode, epoch, stopping/end state after every async boundary. Bounded coalescing; no unbounded polling queue or detached Store writers after lock release.
8. Auto mode cannot silently subscribe only first eight of nine eligible people: exceeding maxConsenting stops/refuses explicitly with incomplete/safety hold. Protective caps are not capacity claims.

## Durable control and policy metadata

Extend the existing private .control.json compatibly with OPTIONAL `automaticOptOuts:[accountId,...]`, max32 unique validated IDs. Old {holdUntilEmpty:bool} remains valid and getControl's old shape can remain unchanged when no suppressions exist, to preserve existing tests/APIs. New Store methods `getAutomaticOptOuts()` and `setAutomaticOptOut(userId,paused)` and `clearAutomaticOptOuts()` may encapsulate this. setHoldUntilEmpty must PRESERVE optouts. Unknown extra fields/invalid/duplicate/over-cap entries fail closed. Atomic JSON+directory fsync, 0600, no-follow, no audio/names/transcripts in control. Bounded optout IDs persist beyond transcript/session retention only until empty/resume; explicitly document this exception to the earlier identifier-free boolean design. If suppression cannot be stored, immediately stop acceptance and surface a sanitized failure, do not claim durable success or automatically regrant. If optout list is full, fail closed rather than silently ignoring Stop.

Persist session consentMode and validate it when present. Per-participant everConsented remains true when capture was authorized by standing channel consent; final publication should explain consent source and not falsely say buttons were clicked. Manual records/default notices remain manual. No untrusted text in status.

## UI and docs

- Channel-mode notice: automatic recording under administrator-confirmed company consent, starts with one person, restart/reconnect behavior and safety stops; Stop my microphone, Resume my microphone, End recording. Use existing static IDs; label only differs by session policy.
- Manual notice retains explicit click instructions and no-auto-restart behavior.
- Closed notices and status must be mode-correct. Status includes fixed policy and suppressed count, no account IDs.
- .env.transcription.example documents both choices and restart/recreate required for config changes (not hot-reloaded/Discord-toggle). No slash command allowing ordinary employees to alter administrator policy.
- Keep long attachments off; user has NOT approved .txt delivery. Retain exact rollback and original default behavior.
- Historical 159-test image evidence remains historical, not proof for new code. Parent will save fresh native evidence separately after final review.

## Required regressions

Default/manual unchanged; invalid enum; auto lone person (without click and before/during failed/uncertain notice HTTP); startup occupied; later joins/rejoin; bots only; unknown and gateway recovery; held End across restart; Stop before stalled HTTP; polling/rejoin/restart/pruning preserves personal optout; explicit resume and known-empty reset; revoke/leave/End during pending audio readiness; auto capacity limit; auto jobs recognized during call and canonical only terminal; old/new policy correct notices/status/finals; .control old-file migration/privacy validation and fsync behavior; shutdown/late callback ownership remains valid. All execution ONLY via docker exec in the approved worker.
