# Idle disconnect implementation and verification results

## Scope and artifact identity

- Work performed in the seeded credential-free worker `sb_df91079a`; every install, test, image build and image smoke command ran through:
  ```sh
  docker exec -w /ws 8ea17536464c557f99a889d65ff3bf559dad273b0b070198ac2cbe14b8fa28bb ...
  ```
- Supplied application baseline: `db08ca5`; supplied deployed image revision: `ea7ebe62`. These are context supplied by the task, not a deployment claim. No Git operations were used to establish a new revision.
- Built local task tag: **`local-transcription-dev:idle-20261016`**.
- Final image ID: **`sha256:36ffb423696853c63d0b5950fec157fb3ccd537869f5755ce93e9271a6f6090b`**.
- Runtime: native `linux/arm64`, Node **22.22.0**, nonroot `nodejs`/UID1001, existing tini entrypoint. Worker test Node: **24.18.0**.
- SHA-256 of `source-hashes.txt`: **`7ae6a4c94911b03cee50773d0d4d48dbcfaa8a4dd12c020d0d862713103d917b`**. This manifest hashes every `src/` file plus `index.js`, `package.json`, and `package-lock.json` in sorted path order. It is a reproducible content identity, not a Git commit hash.
- SHA-256 of `test-hashes.txt`: **`6ee694b362136bcff9785aeb5ef5c982abf877a0cd0bb23bbb4789afa6d45f07`**. It identifies every local-transcription test copied into the image.
- Every app-source/package/index hash and every local-transcription test hash was independently read from the final image and compared byte-for-byte with the worker manifest: **match**. `build-input-hashes.txt` additionally identifies Dockerfile, ignore file, tests, and copied preflight/helper inputs.
- Original legacy meeting source and original Dockerfile were not edited. Final reference hashes are retained in `legacy-preservation-reference.txt`; this is a content reference, not a baseline Git comparison.

## Implemented contracts

See `IDLE_DISCONNECT_CONTRACT.md` for the full behavior and safety boundaries.

- 15-second known-empty default; strict bounded `LOCAL_TRANSCRIPTION_IDLE_SECONDS` with 300-second default.
- Monotonic-clock inactivity and known-empty deadlines (separate from persisted wall timestamps), with nonnegative/publishable final wall-duration clamping under rollback. Existing explicit-End freeze and EOF semantics are preserved. Activity is based only on accepted valid authorized nonzero decoded PCM, including never-spoke and all-paused/no-consent cases. Exact-zero handling is not semantic VAD/noise filtering.
- Distinct inactivity close, durable bounded idle-wait independent of End/safety holds and personal optouts, fail-closed interrupted wake intent recovery before retention.
- Fresh trustworthy member arrival/rejoin wake; no occupied polling, unknown-to-known, startup, restart or gateway-recovery idle rejoin loop.
- Authenticated latest-eligible closed-notice Start, preserving personal Stops and manual consent requirements. Adapter/core epochs fence slow snapshot, interaction acknowledgement, receiver readiness and subscription work against later Stop/End/unknown/safety decisions.
- Closed notice rendering/recovery and late POST/PATCH handling never restore active consent controls; a newer session/hold disables old Start, and failed corrective edits remain retryable. Stale/deleted notices remain rejected even if Discord presentation cannot be updated.
- Existing singleton recognition, old/new physical receiver-close barrier, EOF drain and accepted-work final accounting retained. Attachments remain unapproved/OFF by default; no attachment policy was changed.

## Checks actually run

Evidence directory: **`tools/local-transcription-image/evidence/idle-disconnect/`**.

| Check | Result | Evidence |
|---|---|---|
| Worker `npm ci --omit=dev --ignore-scripts` | 31 packages installed; audit found 0 vulnerabilities | `npm-ci.txt` |
| Worker `node --test test/local-transcription/*.test.js` | **282 total: 281 pass, 0 fail, 1 skip** (ffmpeg unavailable in worker) | `worker-unit.txt` |
| Native image offline preflight, including the same full suite | **282 pass, 0 fail, 0 skip**; real ffmpeg conversion, native DAVE load, synthetic Opus roundtrip, model/native checks, real OS/process tests | `offline-smoke.txt` |
| `python3 tools/local-transcription-image/test_contract.py` | **5/5 pass**; read-only Dockerfile/workflow/static safety checks | `image-contract.txt` |
| `docker build --platform linux/arm64 -f Dockerfile.transcription -t local-transcription-dev:idle-20261016 .` | **Pass**, native ARM64; pinned native artifacts reused | `build.txt`, `image.txt` |
| `python3 tools/local-transcription-image/smoke.py --image local-transcription-dev:idle-20261016 --evidence tools/local-transcription-image/evidence/idle-disconnect` | **Pass**; fresh fixed-hash public recognition + actual recognizer helper + independent-container lock exclusion/reacquisition | `smoke-driver.txt`, `offline-smoke.txt`, `cross-container-lock.txt`, `fixture.txt` |
| Final image/source and image/test manifest comparison | **Exact match** | `source-verification.txt`, `source-hashes.txt`, `image-source-hashes.txt`, `test-hashes.txt`, `image-test-hashes.txt` |

The original 209 tests remain represented and pass in-image; only assertions intentionally affected by the 15-second default and added fourth static control were updated. **73 additional tests** (56 initial implementation tests plus 17 review regression/guard tests) cover boundaries, trusted/zero/excluded/invalid/rejected PCM, never-spoke clocks, both policies, new arrivals/rejoins with others staying (including a fast rejoin whose older leave snapshot is still blocked, and new arrivals whose fetch is superseded by a mute/update), polling/recovery/restart/retention, paused accounts, pending controls and slow readiness/HTTP, commit interruption/failure, closed notice correction, EOF/result drain and physical-close barriers.

The first build invocation used unsupported `--progress plain` with this worker's legacy Docker CLI and failed before building. Retrying without that flag succeeded; no Dockerfile or dependency workaround was needed. The sanitized CLI failure is retained in `build-cli-retry.txt`. Later source/test changes were rebuilt and the complete image smoke rerun; the image ID above is the final verified artifact, not the earlier intermediate image.

## Parent-review blockers reproduced and fixed

The initial focused regression run failed **6 tests** against the unfixed worker source: **64 total, 58 pass, 6 fail** (`review-regressions-before.txt`). Two further rollback tests were run against the original supplied final image **`sha256:6418f8e8cc61959a73471653e24c1d43a25c1c57b3661a2ef8afc2c18e2b1f5b`**, with only the updated test file copied into a disposable network-disabled test container: **2 total, 0 pass, 2 fail** (`review-rollback-before.txt`). No application source was reverted for that check. All corresponding tests now pass; the final focused run is **75/75** (`review-regressions-after.txt`).

| Finding | Failure demonstrated before fix | Narrow fix and passing guards |
|---|---|---|
| P1: older coalesced empty erases later idle End/safety hold | Both `end(closedNotice)` and `fault('VOICE_ERROR')` repros opened a second receiver despite a synchronously persisted hold | Observation-time empty-reset authority is invalidated by later End/fault/Stop/unknown. Both repros assert no new runtime, receiver or subscription and a reloaded durable hold. A genuinely newer empty after queued End/fault still resets normally. |
| P2: new arrival lost by superseding mute/update | Fresh arrival followed by a newer mute snapshot never woke idle; conversely a delayed **pre-idle** arrival incorrectly woke after inactivity | Coordinator prepares epoch-bound eligibility synchronously at the gateway event; adapter retains at most 32 tokens across discarded fetches and validates against the generation-current known membership. Both repros pass. Additional Stop/End/safety/unknown/disconnect and absent-final-member guards pass. Existing blocked-leave/fast-rejoin test remains passing. |
| P2: wall-clock rollback | Separate elapsed-clock inactivity and empty-boundary tests both missed their deadlines. Original-image accepted-PCM rollback produced `TRANSCRIPTION_NOT_READY`; rollback End retained an end before the start | Production defaults to `performance.now()` for inactivity/empty elapsed clocks, while custom test wall clocks remain compatible or can inject separate `elapsedNow`. Final end is clamped to the session wall start without moving End to later queue/EOF time. Deadline, final-payload, frozen-End and production-default-clock tests pass. |

Only `src/features/local-transcription/coordinator.js`, `src/features/local-transcription/index.js`, the two local regression test files, `docs/IDLE_DISCONNECT_{CONTRACT,RESULTS}.md`, and idle-disconnect evidence were changed during this fix pass. No scripts, oracle-admin-test files, image recipe, dependency/package files or legacy source were edited. Final legacy reference hashes were checked successfully (`legacy-preservation-check.txt`).

## Public recognition evidence

Only the public JFK WAV from the pinned whisper.cpp sample revision was downloaded:

- URL: `https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav`
- SHA-256: `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`
- Size: 352078 bytes.
- Full CLI recognition contained the expected “ask not what your country” phrase.
- Actual helper processed 1536000 bytes (8 seconds) of decoded PCM; final run helper wall time **1326 ms**. This is worker smoke timing, not target-device capacity evidence.
- Recognition containers ran without network, read-only rootfs, dropped capabilities and `no-new-privileges`; only disposable public-fixture/private-data volumes were mounted. The smoke driver removed its own containers/volumes afterward.

## Remaining limits / parent handoff

- No deployment, production credentials, OMV access, real Discord requests/login, private audio, Git/gh operation, commit, push, or sandbox lifecycle operation was performed. The local image/tag remains available for parent verification; no registry artifact was published.
- Helper-upgrade files owned by the other agent, `scripts/`, `tools/oracle-admin-test/`, HANDOFF/DEPLOYMENT/current live reports, and the original Dockerfile were not edited.
- Fake Discord/audio integration proves application authorization and ordering, not actual Discord gateway event delivery, live permissions, real DAVE receive behavior, privacy of third-party platforms, or call recognition accuracy. Native DAVE load/Opus roundtrip is explicitly not real DAVE receive proof.
- Public helper success does not establish sustained multivoice capacity, RK3588 timing, or target production hardware safety. A separately approved deployment/live verification remains parent-owned.
- Remote message edit failure can leave stale presentation, but cannot authorize Start/consent. Retained core state is authoritative; once deleted, stale buttons fail safely and a real leave/rejoin/new arrival is required.
- This fix uses monotonic clocks only for inactivity/known-empty deadlines. Wall rollback may under-report displayed call/participant durations and offsets; existing maximum-session, scheduler/recovery, drain and retention clocks were deliberately not broadly refactored.
- No claim is made that arbitrary persistent disk failure can durably commit a new safety record; in-process fail-closed handling, retained wake intent, fallback hold attempts and startup metadata validation are the safeguards.
