# Offline implementation checks

Execution was confined to the designated ready worker container:

```text
cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4
/workspace mount: /ws
Node reported by the worker: v24.18.0
```

No production credential was read/supplied, no bot entrypoint was executed, no
Discord login occurred, no microphone recording occurred, and no host/deployment
operation or Git operation was performed by this implementation worker. Test
identity strings are deliberately nonauthentic locally constructed tokens.
Native/image files belong to the parent/other worker and were not changed here.
The review-fix worker changed only `tools/oracle-test/`, reused the existing
container/dependencies, and ran all checks through `docker exec -w /ws`.

## Review fixes verified offline

- `config.js`: canonical decode/reencode is required **only for the first token
  identity segment**. The two opaque auth segments need only be nonempty and
  URL-safe, within the existing total length/three-segment format limit. A
  synthetic regression accepts noncanonical trailing segments and still rejects
  a noncanonical identity encoding; no actual token was accessed or logged.
  Exact production identity/allowlist and authenticated post-login checks remain.
- `boot.js`: preserve the detached PGID after child close, send KILL, then poll
  group existence (25 ms intervals, 3-second maximum) before privacy cleanup or
  legacy spawn. Still-alive groups, EPERM/unknown verification and signal errors
  fail closed. Fake-group regressions cover delayed disappearance, timeout,
  signal failures and shutdown while verification is pending. Existing watchdog,
  signal and real isolated-child checks still enforce the single-login barrier.
  The image needs an orphan-reaping init; parent-owned `tini` integration/native
  image rebuild and retest are **not established by these tests**.
- `session.js`: immediately prime only the consenting owner's Manual Capture
  subscription after construction/readiness. The real-Capture/fake-receiver
  regression emits speaking-start during join, emits no later owner start, and
  verifies that the next packet is captured while other users remain unsubscribed.
  The recording timer still starts at readiness and defaults to 30 seconds.

## Commands actually run

Initial combined execution found the expected feasibility dependencies missing.
It reported 43 tests: 39 passed, 3 failed, 1 skipped. Failures were missing
`discord.js`/`@discordjs/voice`, not a live-network attempt. A dependency-free run
of the then-current new suite passed 31 tests with one optional ffmpeg skip.

Installed only the existing isolated lockfile, without scripts/audit/funding:

```sh
docker exec -w /ws/tools/feasibility cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4 npm ci --ignore-scripts --no-audit --no-fund
```

Result: exit 0, 30 packages added to ignored `tools/feasibility/node_modules`.
No root package/lockfile or feasibility manifest/lockfile was edited.

Post-review combined command (previous implementation baseline: 50 total,
49 passed, 0 failed, 1 skipped):

```sh
docker exec -w /ws cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4 node --test tools/oracle-test/test/*.test.js tools/feasibility/test/*.test.js
```

Observed post-review result: **57 tests, 56 passed, 0 failed, 1 skipped**, exit 0;
reported duration approximately **3.24 seconds**. This consists of the existing
13 feasibility tests plus 44 Oracle-test tests (43 pass, 1 skip), including seven
new regression tests. No feasibility source/tests were edited.

Focused regression command also passed: **30 tests, 30 passed, 0 failed**, exit 0
(approximately 1.11 seconds):

```sh
docker exec -w /ws cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4 node --test tools/oracle-test/test/config-boot.test.js tools/oracle-test/test/session.test.js tools/oracle-test/test/process.test.js
```

The one skipped check is the optional **actual synthetic ffmpeg resampling WAV
format test**: `/usr/bin/ffmpeg` is absent from this development worker. Fixed
conversion arguments, local paths/model/language, pipeline order, source WAV
format and deletion were tested through a fake subprocess boundary. The image
worker/parent must run the optional test in the native image to establish actual
ffmpeg output. No ffmpeg/whisper/model package was installed here.

Post-review syntax-only verification of every changed JavaScript file (exit 0,
`changed-file syntax checks passed`):

```sh
docker exec -w /ws cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4 sh -c 'for file in tools/oracle-test/config.js tools/oracle-test/boot.js tools/oracle-test/session.js tools/oracle-test/test/config-boot.test.js tools/oracle-test/test/session.test.js; do node --check "$file" || exit; done; printf "changed-file syntax checks passed\\n"'
```

The prior implementation's small offline string-length check, also through
`docker exec`, reported the
consent notice is **1017 characters**, below Discord's 2000-character limit.

## Covered boundaries

- Exact CLI authorization and all fixed production IDs; malformed/wrong token
  identity cannot construct the Discord adapter/login boundary. Actual
  authenticated application mismatch blocks target fetch/join. The original
  feasibility config still rejects production.
- Private directory/marker owner/mode/symlink gates, durable exclusive one-shot
  marker before spawning, restart skip and crash-audio cleanup namespace.
- Test close AND confirmed entire-group exit before legacy spawn on success/error;
  watchdog TERM/KILL without prematurely starting legacy; group confirmation
  timeout, delayed exit, unverifiable/EPERM state and group-signal failure;
  shutdown propagation and no legacy during shutdown/confirmation; spawn failure
  and fail-closed privacy-cleanup failure.
- One **real isolated fixture child** with persistent interval handles, stopped
  by the supervisor watchdog, actually closes before a separate legacy fixture
  starts. Neither fixture loads Discord or root `index.js`.
- Fake Discord adapter target fetch, real-ID validation, `selfDeaf:false` /
  `selfMute:true`, readiness and voice/gateway/owner-departure failure boundaries.
- Notice disclosures, exact interaction guild/channel/message/author/user/custom
  ID matching, in-channel consent, concurrent Start contention, no voice join or
  subscriptions before consent, consenting-user-only receiver filtering with
  interleaved other-speaker starts, owner-only Stop and waiting-only Cancel.
- Arming/startup/record duration bounds, recording timer beginning at readiness,
  no capture after late readiness during shutdown, reconnect incomplete results.
- Immediate Capture WAV writes and accepted-PCM hook metadata, buffered last PCM
  at EOF, hook-failure incomplete, existing real voice 0.19.2 EOF regression.
- During-call hard chunk recognition progress, quiet-absence segmentation without
  invented silence, final short EOF, stable ordered IDs, one recognizer,
  queue overload accounting, per-job error/timeout, total drain cancellation,
  late-result suppression, blank/oversize output and exact byte totals.
- Local fixed conversion/recognition argv, no shell or credential environment for
  native processes, bounded transcript stdout overflow, TERM then KILL and
  awaiting subprocess close, audio/temp deletion on success/failure.
- No result before accepted work drains; incomplete job markers; mention escaping
  and `allowedMentions`; one long-transcript attachment; minimal private outcome
  without participant/transcript; signal cancellation without transcript upload;
  publication failure without retained raw audio or retry/duplicate attempt.

## Not established

These are **offline software-boundary checks**, not a live test result or a
production-ready transcription implementation. Actual Discord login, consent
button UI permissions, voice receive/decrypt/DAVE, upstream loss, audio quality,
local English model execution/accuracy, native CLI stdout compatibility, actual
ffmpeg resampling in the native image, RK3588 timing/thermal/RAM behavior and
production legacy handoff have **not been exercised by this worker**. In
particular, no assertion of real-time capability or representative accuracy is
made. The native-image worker owns its independent artifacts/smoke evidence;
the parent owns final combined image verification and any approved deployment or
user-consented live microphone exercise.
