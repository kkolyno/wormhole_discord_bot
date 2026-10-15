# Local call transcription: feasibility evidence

Date: 2026-10-15. This is an experiment record, **not an approved implementation or deployment plan**. Read `HANDOFF.md` and `DEPLOYMENT.md` for requirements and operational boundaries. No rejected plan was used as evidence.

**Historical first, read-only/offline phase.** The safety statements and unknowns
below describe that earlier phase, not the later authorized live Oracle work.
For verified RK3588 hardware, actual public-sample local-recognition measurements,
the deployed consent-based one-shot microphone test and exact rollback, see
[`ORACLE_LIVE_TEST.md`](ORACLE_LIVE_TEST.md) and the current `HANDOFF.md`.

## Safety and scope

- No production image pull, restart, stack change, driver/package installation, bot login, or recording was performed.
- Production access was limited to OMV's existing read-only status/images/redacted-config queries and the read-only `System.getInformation` RPC. Only an allowlist of system fields was printed; no diagnostic dump was requested.
- Development execution used a new WarpDrive worker, `sb_913e9ec2`, with workspace `/Users/kasey/Documents/GitHub/_agent-sandbox/wormhole-rk3588-feasibility`, no vault, no MCPs, and no production credentials copied. The pre-existing worker mounted on the real repository was not used or changed.
- This development runtime is Linux **aarch64 on the Mac's Docker runtime**, not the OMV/RK3588 machine. A successful development smoke test is not a target-hardware benchmark.

## Read-only deployment observations

OMV currently reports:

| Field | Observation | Limit |
| --- | --- | --- |
| Service/container | `meeting-helper-bot` / `Oracle`, running | Management status, not a Discord behavior check |
| Image | `ghcr.io/kkolyno/wormhole_discord_bot:latest`, image ID `b44105db8c52` | Not pulled; source/image equivalence not established |
| Configuration | Existing production guild/channel/application IDs and 90-second grace remain as recorded in `DEPLOYMENT.md` | Token redacted; no changes |
| OMV | `7.7.7-1 (Sandworm)` | Does not establish full userspace/architecture |
| Kernel | `Linux 6.1.99` | NPU driver/runtime compatibility not established |
| Memory total | `8306573312` bytes (~7.74 GiB) | Host-visible memory, not a container allowance |
| Memory available | `4397498368` bytes (~4.10 GiB) | One snapshot, not an STT memory budget |
| CPU utilization | ~1.76% | One snapshot, not sustained headroom |
| Load averages | 0.10 / 0.27 / 0.33 | One snapshot |
| CPU model / cores / MHz | All returned null | Do not infer a validated RK3588 identification from this response |

Device-tree board/SoC identity, actual architecture, CPU topology/frequency policy, temperatures/cooling, NPU driver/runtime, usable device permissions, disk budget, and actual deployed Node version remain unknown. The historical CM3588/RK3588 identification is still historical. OMV's narrowly scoped helper is not a shell/benchmark runner; do not bypass its command allowlist to execute probes.

## Current upstream voice constraints

Checked against npm metadata and the versioned upstream README:

- `@discordjs/voice` **0.19.2** requires **Node >=22.12.0**. Root project `node >=18` is insufficient for a future voice implementation; `node:22-alpine` alone does not establish the running image's patch version.
- DAVE support is supplied by `@snazzah/davey`; the package declares native ARM64 GNU and musl variants. Declared targets are not proof they load on the production image, nor proof of successful DAVE receive/decrypt.
- Upstream explicitly warns that Discord audio receive is undocumented and stable support is not guaranteed. A live test on the target runtime is mandatory.
- Joining to receive needs `selfDeaf: false`; the listening bot can stay self-muted. Decode state must be per transmitting Discord user. A user ID identifies the transmitting account, not each person behind a shared microphone.
- No packet during silence is not a stream of silent PCM. WAV byte duration is not wall-clock call duration. Packet arrival timing cannot reconstruct RTP timing or prove lossless reception.

Sources:

- https://registry.npmjs.org/@discordjs/voice/0.19.2
- https://github.com/discordjs/discord.js/blob/%40discordjs/voice%400.19.2/packages/voice/README.md
- https://registry.npmjs.org/@snazzah/davey/0.1.12

## Isolated checks executed

The separate `experiments/whisper-smoke/` experiment built **whisper.cpp v1.9.5**, source commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`, CPU only with portable `armv8-a` flags, and transcribed the upstream public 11-second JFK sample. Build and inference exited 0; the initial full reproduction also exited 0 and produced a byte-identical transcript. This is a software/model smoke test on the Mac's ARM64 Linux container, not a target benchmark or measured accuracy test.

The single tested model was multilingual, unquantized/f16 `ggml-base.bin`, 147,951,465 bytes, HF revision `5359861c739e955e79d9a303bcbc70fb988958b1`, SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. The hash was verified before inference. Source and audio hashes, code/model MIT license evidence, exact flags/commands, transcript, logs and limitations are in that experiment's `README.md`, `RESULTS.md`, and small evidence files. The public sample is not consented representative meeting audio; no rights grant for redistributing the fixture was independently established, and no audio/model/build artifacts are included in the repository deliverables.

`tools/feasibility/` contains an isolated hardware collector and development-only receive/decode probe, with a separate npm lockfile. Its `TEST-RESULTS.md` records offline tests and preflight. There has been **no live Discord login, receive, decryption or recording test**. Successful local drain is deliberately named `drained_observed_audio`, not complete recording; the probe cannot account for unobserved upstream loss. Recognition is not connected to this probe or the production bot.

Independent read-only review identified pre-login production-token safety, dependency-specific EOF/drain, REST shutdown, collector output bounds, DAVE implementation claims, and cached-source reproduction issues. Corrections and regression checks are recorded in the tool/experiment results. Final parent verification in the worker passed **13/13 Node tests**, **5/5 Python tests**, offline preflight and the exact dependency-tree check. The final smoke-script replay used freshly extracted, verified source plus new build/evidence/output paths; it exited 0 and matched the original transcript. The parent also checked script syntax and transcript equality. These checks are experimental scaffolding, not the full lifecycle/recovery test suite required for production.

The final preflight loaded DAVE's module/API but deliberately reports native-versus-WASI implementation **unknown** and receive/decrypt **unverified**. Synthetic Opus WASM encode/decode covered 2.5–60 ms packets. The real, exported voice `AudioReceiveStream` is used in the offline tail-drain regression; REST startup cancellation is tested with the real REST machinery and a fake transport. None of these tests connects to Discord.

## Minimal gate sequence

1. **Read-only target inventory.** Review the collector in `tools/feasibility`, then agree an access route and a nonproduction directory on OMV. Run it on the host without installing anything. Missing fields remain unknown; do not install/load NPU drivers to make the report pass. Compare host and development-container preflight information.
2. **Offline runtime preflight.** In an explicitly authorized separate development container on the target, install only the isolated feasibility package with its lockfile, check Node/DAVE/Opus compatibility and the synthetic codec test. No production token, imports, service mount, or container replacement. Test the intended libc/container base; the GNU ARM64 sandbox result does not establish Alpine/musl compatibility.
3. **Bounded, consented receive/decode.** Use a separate development bot in a separate test guild/channel. Obtain consent before starting; make the recording purpose/duration and stop command clear to both speakers. The probe writes private local audio and no Discord messages. Start with a <=120-second test: two users say distinguishable phrases separately, then overlap; include silence, short words, leave/rejoin, and a last word immediately before stop/disconnect. Test interrupted/reconnected transport in a separate run; an interruption must be reported incomplete, not silently passed. Inspect per-speaker WAVs and metadata locally. Stop and delete test audio after the agreed inspection window. Do not run the current probe in the production guild.
4. **Representative local recognition.** Only after capture is usable, use consented audio in the required languages/accents/vocabulary, including actual Discord codec artifacts and overlap. Pin source, model bytes/checksums/license, quantization, runtime, thread count, resampler, segmentation and configuration for each tested candidate. Properly resample 48 kHz stereo to the candidate's required mono sample rate; do not decimate by taking every third sample.
5. **Sustained concurrent test.** Agree representative participant count/duration and acceptance thresholds before accepting a model. Measure host/container RSS, queue age/size, tail latency, thermal/frequency behavior and host load over a long run, not just a clean sample. No approved limits or target performance numbers exist yet.

Measure compute RTF as recognition wall time / decoded input-audio duration, reporting warm/cold loading separately. Report overlap as summed speaker-audio seconds separately from elapsed call seconds. For the full pipeline, replay capture-time arrivals and measure backlog growth and finalization delay (last accepted audio until all accepted work is resolved), rather than inferring concurrency capacity from single-file RTF. Compare word/character error and names/domain terms to a human reference; silence hallucinations, speaker assignment, missing final words and incomplete-output labeling also matter.

## Small candidate set, not a selection

| Candidate | Evidence / proposed role | Open gate |
| --- | --- | --- |
| whisper.cpp CPU, multilingual `base`, unquantized baseline | Reproducible public-sample toolchain smoke test; no `.en` language assumption | Representative accuracy and RK3588 throughput; if inadequate, change configuration/model based on measurements |
| sherpa-onnx CPU, an appropriate model for the required languages | Official SenseVoice INT8 examples exist for Mandarin/English/Japanese/Korean/Cantonese; bounded utterance recognition is possible during calls without partial streaming | Required languages unknown. SenseVoice's model card points to a separate **model license**, not simply the sherpa runtime license. Review actual artifact license before use; choose a different sherpa model if language/license unsuitable. Not downloaded or tested |
| RKNN Whisper encoder/decoder base 20-second example | Rockchip explicitly lists RK3588 support; both encoder and decoder conversion paths exist | Actual driver/runtime/library match, model conversion, language/task handling, accuracy, concurrency, maintenance and measured end-to-end benefit. Not converted, installed or tested |

RKNN reference reviewed at model-zoo commit `837db8e992815ff8647eadb709f07067f4bc3a71`:
https://github.com/airockchip/rknn_model_zoo/blob/837db8e992815ff8647eadb709f07067f4bc3a71/examples/whisper/README.md

Other candidate references (unexecuted; no performance claims adopted):

- https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html
- https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- https://github.com/ggml-org/whisper.cpp

## Implementation boundary after feasibility

Capture and recognition must run **during** calls. Only the canonical final meeting-summary publication waits for all accepted audio to be accounted for. The probe is not integrated with the bot and does not claim durable capture, transcription, recovery or publication guarantees.

Do not bolt a second publisher onto the existing grace timer. A later implementation needs one lifecycle owner, independent closing/new sessions, bounded persistent work and shutdown, explicit incomplete outcomes, and durable publication reconciliation. Fake-boundary lifecycle tests from `HANDOFF.md` remain required. Unknown channel occupancy must not be treated as empty. Short inline transcript vs one attached text file, output channel, consent/stop semantics, session boundaries and retention still require agreement.

Privacy means local recognition without an additional external STT provider. Discord already transports calls; publishing transcripts uploads them to Discord.

## Development cleanup

Worker `sb_913e9ec2` (`wormhole-rk3588-feasibility`) was stopped, deleted, and verified
absent from WarpDrive's sandbox list. No orchestrator ran. No vault or production
credentials were supplied to the worker. Reviewed tools and small experiment
text/JSON/log evidence were copied into this checkout; no runtime bot source,
root dependencies, Dockerfile or Compose configuration changed. The user's
pre-existing uncommitted work was preserved.

The throwaway host workspace at
`/Users/kasey/Documents/GitHub/_agent-sandbox/wormhole-rk3588-feasibility` remains
with small source/docs/evidence only (~672 KiB). Its downloaded model, public WAV,
third-party source/build trees, isolated CMake environment, npm dependencies and
Python caches were explicitly removed after sandbox deletion. None of those
artifacts was copied into this repository. Future execution needs a new disposable
sandbox; the recorded container ID is historical.

## Still needed from the user

- An approved target-host access route and nonproduction test location. No target installs, containers, workloads or production changes are authorized by this record.
- A separately provisioned development bot/test guild and explicit participant consent for the bounded capture test. Configure credentials privately; do not paste tokens into chat.
- Required languages/accents/domain vocabulary, usual and maximum concurrent speakers/call duration, and acceptable finalization delay. Agree accuracy/resource/retention limits before running extended recording/benchmarks or selecting a production model.
