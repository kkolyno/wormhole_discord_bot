# Authorized Oracle one-shot microphone test

## Later microphone outcome and guarded integration

The fresh 21:06 UTC run captured approximately 30 seconds, 3,271,680 PCM bytes and
four recognition jobs; it finished at `2026-10-15T21:06:47.739Z`. The user reported
very good, basically realtime transcription. The recorded outcome is still
`incomplete` with `BOT_MOVED_OR_DEAFENED`: the prototype lacked a guard around
intentional disconnect. That guard now has a regression; historical evidence was
not changed. Only bounded metadata was read, not private speech.

A subsequent opt-in durable meeting feature is implemented and tested but **not
published/deployed**. See [`LOCAL_TRANSCRIPTION.md`](LOCAL_TRANSCRIPTION.md) and
[`LOCAL_TRANSCRIPTION_RESULTS.md`](LOCAL_TRANSCRIPTION_RESULTS.md). That later
feature deliberately extends root wiring/dependencies; the preservation claims
below describe the earlier one-shot runtime, not all later feature-branch work.

## Scope and rollback

The user authorized experimenting with live **Oracle** on a new branch, provided
old functionality stays available. Intended language is **American English**;
the offered sample is approximately **30 seconds**. This is a feasibility test,
not the durable meeting-transcription integration.

- Feature branch: `feat/rk3588-local-transcription`.
- Remote rollback branch: `rollback/oracle-before-transcription` at `af358a4`.
- At the one-shot stage, `main`, original `Dockerfile`, root dependencies and
  original application source were unchanged. The 20 deployed application/package
  files were checked against the original checkout by SHA-256. Later guarded
  integration extends root wiring/dependencies while retaining main, original
  meeting-feature sources, original Dockerfile and exact-image rollback.
- Original exact local image:
  `sha256:b44105db8c52b15918f068653f0c52eaa2d1c2e70cfc0220a2e3b72b9d379edc`.
  It is retained under the fixed local tag
  `oracle-rollback:before-transcription-20261015` and a helper-journal rollback tag.
- Original registry digest:
  `ghcr.io/kkolyno/wormhole_discord_bot@sha256:4b0fe01d60bb4984b9fcb43dcf1b6fa286ac6a224d2ebab95657d3f84fe486a0`.
- The initial uncommitted documentation/cleanup changes were preserved in the
  feature branch; `.private/` and the local MCP configuration were not committed.

The original Compose source/environment/container inspection are backed up with
0700/0600 permissions under `.private/oracle-before-transcription-20261015T194233Z/`.
The successfully prepared deployment journal is
`.private/oracle-transcription-live-20261015b/`. The earlier journal without `b`
records rejected, non-applied override attempts; retain it as diagnostic evidence.
Never publish these private directories: they contain production credentials.

## Published runtime artifact

- Runtime-source commit: `8ed32db99c0698b9a7493fed06b992573bf70bbd`.
- Successful ARM64 workflow:
  <https://github.com/kkolyno/wormhole_discord_bot/actions/runs/38800534706>.
- Test tag:
  `ghcr.io/kkolyno/wormhole_discord_bot:oracle-test-8ed32db99c0698b9a7493fed06b992573bf70bbd`.
- Pulled image ID:
  `sha256:f5222dab8309d1eea2d02125c940a161573427f199ae9ba51639c71e1c507d03`.
- Pulled registry digest:
  `ghcr.io/kkolyno/wormhole_discord_bot@sha256:b281ad7f705f13fb2998c8cb5ee536a1a4beac2f26c894e8a7baff3d9adf650a`.

Only the feature branch's explicitly dispatched test image was published. No
`latest` tag, main merge, or production-source replacement was used. Subsequent
helper/documentation/public-checker fixes do not change the tested image runtime.
The standalone public checker was passed explicitly to the one-off container;
it is not claimed to be included in the earlier image.

## Actual RK3588 check — 2026-10-15

Target: FriendlyElec CM3588/RK3588, four A55 + four A76 cores, about 8 GiB RAM,
Linux 6.1.99, rknpu driver 0.9.8. Runtime is ARM64 Node 22.22.0 / Alpine 3.23.2.
No NPU inference was used or required. Node's `os.cpus().model` reports A55 for
all eight entries; that API output is not a topology reassessment.

A separate `compose run --rm --no-deps` container used the pulled test image,
with `DISCORD_TOKEN` explicitly blank. It did not start the bot, join Discord,
consume the recording marker, or capture anyone. The fixed public JFK fixture
and English model were verified against the pinned SHA-256 values before use.
See `tools/oracle-test-image/evidence/rk3588-public.json` for the allowlisted
measurements and exact standalone-checker source hash.

| Measurement | Observed |
|---|---:|
| Full public fixture CLI wall time | 7.150 s |
| Actual helper, warm-cache 8 s stereo/48 kHz input including resampling | 6.460 s |
| Helper real-time factor | 0.808 |
| One-off cgroup reported peak memory | 325,345,280 bytes (~310 MiB) |
| Sampled SoC temperature, before / after | 47.153°C / 51.769°C |

The expected public English text was recognized. The helper removed its source
and converted WAVs, and the standalone checker removed its private work directory.
DAVE session API and Opus WASM load succeeded on target; AES-256-GCM is available.
**Actual Discord receive/decryption and microphone accuracy remain unproven.**
This is one short, mostly clean public clip—not a sustained, noisy, overlapping,
multiple-speaker, thermal-throttling or meeting-finalization benchmark. It does
not select the production backend or establish capacity for multiple speakers.

A second one-off check inherited the actual service environment but only invoked
the pure local token/application-ID checks and private-storage guard. It made no
Discord/API login and confirmed that the one-shot marker was still absent.

## Runtime safety and participant procedure

`node tools/oracle-test/boot.js --authorized-live-oracle-test` is the only test
entrypoint. Default image command remains the unchanged original application.
Tini is PID 1. The supervisor runs a separate test child/process group, then starts
legacy `index.js` only after that group is confirmed gone. A persistent marker
prevents a restart from recording twice. Startup, idle, capture, recognition/drain
and process cleanup are bounded; incomplete outcomes must be identified as such.

The test posts a **noncanonical test notice** in the configured alerts channel.
The participant must first join the configured voice channel and click the consent
button. Only the clicking participant is subscribed/captured. Speak naturally for
about 30 seconds, with a few pauses. Stop/cancel controls remain available. Other
people are not subscribed or recorded by this test. The test transcript goes to
Discord only after local accepted work finishes or receives an explicit incomplete
outcome. Raw session audio is deleted; a bounded metadata outcome/one-shot marker
remains. The Discord test notice/transcript follow Discord's message retention.
No private audio is sent to an external speech-recognition provider.

Normal meeting handling is paused during the one-shot test and resumes afterward
or after its ten-minute waiting expiry. The test does **not** add automatic
transcripts to ordinary meeting summaries. That requires the later durable
capture/work/publication coordinator and representative workload validation.

## Activation and readiness observed

Oracle was recreated with the test image after both target checks passed. Its
running image ID was verified against the pulled ID above. A newly posted notice
with an enabled consent button was independently read through Discord:

- Posted at **2026-10-15 20:33:15 UTC**, with a ten-minute waiting window.
- <https://discord.com/channels/1465125548379607094/1465216403241041981/1560390120241242215>

The user was notified that it is ready. This proves test startup/login/notice
publication, **not** consent, successful voice receive/decryption, or microphone
recognition. Do not infer any of those without an actual test outcome. The
original image remains pinned; ordinary legacy handling automatically resumes
after the one-shot child terminates. Restart will not silently rearm recording.

## Operator recovery

Read `scripts/ORACLE-TEST-OPERATIONS.md` first. Exact helper rollback command:

```sh
python3 -B scripts/oracle-transcription-admin.py rollback \
  --backup-dir "$PWD/.private/oracle-transcription-live-20261015b" \
  --authorize-live-change
```

Rollback recreates only Oracle using the full original image ID and no test data
mount, verifies it, then restores the exact original source fields. It does not
pull `latest`, remove the saved image, or delete retained private data. Ambiguous
or pending mutation jobs deliberately block conflicting operations; reconcile or
resume the recorded phase instead of bypassing the journal lock.

The helper's final **38 fake tests** include pending-job races, runtime-equivalent
snapshot checks, empty normalized default IPAM, and OMV's JSON-string coercion.
A YAML comment before each JSON override keeps it text for OMV's schema validator
while remaining valid Compose YAML. Image runtime verification is recorded in
`tools/oracle-test-image/RESULTS.md` (57 native offline tests and real local smokes).

## Development cleanup

The isolated worker `sb_cac01407` was stopped and deleted; absence from the API
and absence of its Docker container were verified. Its final local test-image tag
and scratch npm dependencies were removed without pruning shared Docker caches.
The disposable source/docs/evidence workspace remains at
`/Users/kasey/Documents/GitHub/_agent-sandbox/wormhole-rk3588-live` (~1.2 MiB).
It has no production credentials or captured private call audio. Deleting this
worker does not affect Oracle on the separately managed RK3588 host.
