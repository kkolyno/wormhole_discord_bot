# Local meeting-transcription implementation verification

Date: 2026-10-15. Branch: `feat/rk3588-local-transcription`.

## Status and scope

The durable meeting feature is implemented and opt-in, **not published or deployed**. Oracle was left on the previously authorized one-shot image, whose test has finished. Its supervisor is designed to resume the original meeting feature afterward; this implementation phase did not independently recheck that application handoff. This change does not silently activate recording or rearm that test.

The user's actual microphone feedback was: “The transcription looks really good and basically realtime.” The allowlisted one-shot outcome records 3,271,680 accepted PCM bytes and four recognition jobs over approximately 30 seconds. Its recorded outcome is nevertheless **incomplete**, with `BOT_MOVED_OR_DEAFENED`; source inspection found that intentional disconnect could produce that issue. A guard and regression were added, but the historical result was not rewritten as clean. No private audio or transcript was copied into development or these artifacts. See `docs/evidence/oracle-microphone-outcome.json`.

The public RK3588 baseline remains the earlier measurement in `tools/oracle-test-image/evidence/rk3588-public.json`: 8 seconds of public input through the helper in 6.460 seconds, approximately 310 MiB reported peak. The new durable implementation adds synchronous fsync/spooling and different coordination; it has **not** been benchmarked on the target or in another live call.

## Final immutable local image

- Development-only tag: `local-transcription-dev:final-20261015`.
- Full image ID: `sha256:679ea01ee78e16482f7ab0a901d8d4afda77a784c4f103f3d2dd5ba70657c5b3`.
- Linux/ARM64; Node 22.22.0; UID1001; Tini; English CPU whisper.cpp/base.en baseline.
- Built and executed in a disposable **ARM64 development VM**, not the RK3588. Its inference timings are not target measurements.
- `image-source-hashes.txt` verifies all 48 copied runtime/test inputs against the final source after review fixes. The image is historical local evidence, not a registry digest or a production deployment.

## Checks actually passed

Evidence directory: `tools/local-transcription-image/evidence/`.

| Check | Result |
|---|---:|
| Final native Node22 image tests, including real ffmpeg | **159 passed; 0 failed; 0 skipped** |
| Outer worker Node24 source tests | 158 passed; 0 failed; 1 skipped (ffmpeg absent there) |
| New image/workflow static contracts | 5 passed |
| Existing Oracle image static contracts | 3 passed |
| Feasibility + one-shot Node regressions | 57 passed; 0 failed; 1 optional ffmpeg skip |
| Hardware-inventory Python tests | 5 passed |
| Fake Oracle-administration Python tests | 38 passed |
| Actionlint 1.7.7, SHA-256-verified Linux/ARM64 executable | passed |
| npm production dependency audit | zero reported vulnerabilities at check time |

The final image also passed network-disabled public English inference using the pinned JFK fixture, the actual new recognizer helper with resampling, model/hash/linkage checks, DAVE library load and synthetic Opus roundtrip, private-volume checks, and **two independent containers contending for the same kernel lock**. Public and synthetic test audio was removed afterward. DAVE library load is not new live receive/decryption evidence.

## Important regression coverage

- Explicit consent only; leave, revoke, interruption and restart invalidate capture. Shared-microphone consent remains the user's responsibility.
- Late voice readiness cannot restore revoked consent. End recording cuts off acceptance before queued lifecycle/HTTP work.
- Closing old runtimes remain reachable by invalidation; faults/rejected PCM attach to the originating session, even while a new session captures.
- Buffered EOF tails are preserved on ordinary close/shutdown while still consented; a later revocation/leave intentionally rejects them.
- Recognition runs during capture; a new meeting can start while an older one drains; one scheduler slot prevents normal native-job overlap.
- Final participant/duration/transcript publication waits for input sealing, accounting, and terminal jobs. Unknown occupancy never means empty; grace does not inflate ordinary end time. Coalesced periodic membership retries recover transient fetch failures without requiring another voice event.
- Atomic metadata/fsync, accepted PCM durability, simulated I/O failures, SIGKILL recovery, private file validation and global caps.
- Parent-owned open-file-description `flock`: acquiring helper exit does not unlock a live writer; parent death/release does. No PID namespace heuristics or lockfile deletion.
- A privacy-safe persistent hold survives pruning; expired abandoned speech is removed on recovery before recognition/publication.
- Durable outbox intents, exact inline-body reconciliation, stable nonce, concurrent-send exclusion, attachment ambiguity held for review, and no blind resend. This is not a distributed exactly-once claim.
- Late notice acknowledgements and their edits remain owned through shutdown. A real-lock integrated regression checks that old Store writes cannot outlive lock ownership.
- Strict attachment boolean approval; long output is held by default, never posted as a partial canonical summary.
- Opt-in error logging suppresses raw HTTP/native messages/stacks; legacy diagnostics remain unchanged when disabled.

Read-only reviews identified concrete races; subsequent fixes and final regressions cover them. Static review is not a proof of absence of defects. The accidentally host-run early worker check failed private-root checks and is not verification; all passing execution above occurred inside the disposable worker/images. Intermediate stale-image/negative-fixture attempts are not the final result.

## Still required before production activation

1. Approve the long-transcript delivery policy (`.txt` attachment is still off).
2. Review and publish a new immutable `transcription-<full40sha>` image; CI runs offline native tests and a fixed-hash public recognizer smoke **before** push.
3. Implement/review controlled deployment and exact-image rollback for this new mode. The existing one-shot `prepare` helper is not a production-meeting activation command.
4. Run a fresh consented end-to-end call test of the new meeting flow on Oracle, then representative duration/concurrency/backlog/thermal/storage tests on the RK3588.
5. Establish workload and accuracy/finalization/resource acceptance criteria. Eight-account and other caps are protective limits, **not measured capacity**.

Normal shutdown holds the writer lock through accepted-work checkpointing, native child settlement and owned publication callbacks. Abrupt native-descendant exclusion relies on the documented Tini/container lifecycle, with the old container fully stopped before replacement. Do not claim safe arbitrary same-container parent replacement or power-cut durability from these tests.
