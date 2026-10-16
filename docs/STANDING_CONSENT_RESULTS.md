# Automatic recording under standing company consent

User clarification: this private company channel contains employees who have already consented. Recording/transcription should start automatically with even one human present, including solo brain dumps. This extension implements that configurable policy; it does not require collecting another button click for every meeting.

## Configuration

For this company's intended deployment:

```dotenv
LOCAL_TRANSCRIPTION_ENABLED=true
LOCAL_TRANSCRIPTION_CONSENT_MODE=channel
```

`LOCAL_TRANSCRIPTION_CONSENT_MODE=manual` restores per-account, per-session click consent. Manual is the backward-compatible default; other values, including empty/whitespace/misspellings, are rejected. The feature itself remains off unless enabled. These are administrator environment/Compose settings applied on process restart/container recreation, not a hot-reloaded or employee-accessible Discord toggle.

**Not deployed:** no workflow dispatch, image publication, Oracle stack change or one-shot rearm occurred during this extension. Existing live behavior has not been turned into automatic meeting recording yet.

## Behavior

- Known nonempty room: automatically join/subscribe all eligible human accounts, including one person, occupants at startup, later joins and rejoin. Recording does not wait for the notice POST or a button acknowledgement.
- A visible notice explains administrator-confirmed company standing consent. Stored session policy—not a later environment setting—controls notices and final consent-source wording.
- Empty/bots-only rooms do not start capture. Unknown occupancy immediately cuts off gates and is never treated as empty. Trustworthy occupancy and allowlisted gateway recovery can resume automation.
- Normal restart automatically begins a fresh channel-policy session for a known occupied room, while recovering accepted old work. Personal Stop and session-wide End/safety holds are preserved.
- **Stop my microphone** persists that account's pause until deliberate **Resume my microphone** on the current notice or a known empty room. Polling, another join, nonempty leave/rejoin, restart and metadata pruning cannot undo it. Stop cuts off all existing capture-runtime gates before HTTP.
- **End recording** holds automation until known empty. Capacity, storage/native failures, deliberate bot move/deafen and the configured maximum session duration remain protective stops, not automatic retry loops. The default maximum is four hours; this is not a claim of unlimited uninterrupted recording.
- Local recognition during calls and terminal/accounted final-summary publication remain unchanged. Long `.txt` attachments remain unapproved/off; oversized finals are held rather than partially posted.

The channel policy is the administrator's attestation that all admitted humans, including guests and people audible through shared microphones, have consented. The bot cannot verify company employment or the validity of that consent. Use manual mode or separate access/channel arrangements for nonconsenting guests.

## Durable control/privacy

`.control.json` remains private/atomic/fsynced and backward-compatible with the old boolean-only record. Its optional `automaticOptOuts` holds at most 32 unique validated account IDs, no names/audio/transcripts. These minimal identifiers intentionally survive transcript/session retention until empty/resume; otherwise a restart or pruning could override a person's Stop. Invalid/over-cap/private-file failures fail closed. Hold writes preserve the pauses, and status shows only their count.

## Final verification

Executed in disposable Linux/ARM64 worker `sb_8ff8b2b1`, with no vault, orchestrator, production credentials or private recordings. Evidence: `tools/local-transcription-image/evidence/channel-consent/`.

- **209/209 passed**, zero failures/skips, in the final Node22.22.0 ARM64 image, including real ffmpeg.
- Outer worker Node24.18.0: 208 passed, zero failed, one optional real-ffmpeg skip.
- New image/workflow static contracts: five passed.
- Existing feasibility/one-shot regressions: 57 passed, zero failed, one optional ffmpeg skip.
- Network-disabled pinned public English Whisper inference, actual new recognizer helper/resampling, model/linkage/codec checks, and actual two-container kernel-lock exclusion/release passed.
- Full local image ID: `sha256:95ec8530411a46da786ffa2e14d7f6511f0759b03dd170c25ade012e23ded72a`.
- `image-source-hashes.txt` verifies all **51** copied source/test inputs match the final image. Older 159-test evidence in the parent directory is historical, not verification of these new policy changes.

Six real feature/Store/Coordinator/Publisher/OS-lock integration cases cover a solo brain dump before notice acknowledgement, bots-only room, unchanged manual behavior, gateway recovery, End across occupied restart followed by known-empty reset, and personal Stop across stalled acknowledgement/polling/rejoin/restart followed by explicit Resume.

Read-only review found three further races/boundary issues. Parent fixes plus regressions cover current-notice Stop against older draining runtimes, an old queued Resume for an observed-but-not-accounted member attempting to erase a later Stop, and nonparticipants attempting to consume private pause slots. A bounded in-memory authorization fence rejects stale queued Resumes without retaining an unbounded identifier map. Conservative rejection during a concurrent membership/Stop race may require clicking Resume again.

## Cleanup

Worker `sb_8ff8b2b1` was stopped/deleted and verified absent in authenticated API
inventory and Docker. The task-owned development image tag and installed
workspace dependencies were removed without pruning shared caches. The retained
`~/Documents/GitHub/_agent-sandbox/wormhole-standing-consent` workspace is about
2.0 MiB of credential/audio-free source/docs/evidence. No orchestrator was loaded;
future execution needs a new approved worker. The user's `.mcp.json` was preserved.

These are development-VM/synthetic/public-fixture checks, **not** new RK3588 timing, sustained company-call capacity, private-call accuracy or actual live Discord tests of the new automation. Controlled immutable deployment/rollback and a consented target end-to-end check are still required. Main, original meeting sources/Dockerfile, exact rollback artifacts and private live journals remain preserved. The one-shot marker was not changed.
