# Pinned whisper.cpp CPU recognition smoke test

> **Locally successful on a disposable Linux aarch64 container. This is NOT an
> RK3588 run, NOT a hardware benchmark, and NOT evidence of call-audio feasibility.**

This experiment builds whisper.cpp v1.9.5 at a fixed source commit and recognizes
its public `samples/jfk.wav` using exactly one model: multilingual, unquantized
`base` (`ggml-base.bin`). No model comparison, private/live audio, Discord,
production service, GPU/NPU inference, performance acceptance, or production
architecture decision is involved. See [RESULTS.md](RESULTS.md) for observed output.

## Reproduce only in an equivalent disposable ARM64 sandbox

Host throwaway workspace:
`/Users/kasey/Documents/GitHub/_agent-sandbox/wormhole-rk3588-feasibility`
mounted as `/ws`. The **historical container ID** used for the recorded runs is
`20bf49927b6dea531168d47cc7a8ad0f66142b0ad410cd190f6df04d6ff93b13`.
It is not a permanent execution target: the parent owns shutdown/deletion. After
that, recreate an equivalent disposable Linux **aarch64 / ARM64** sandbox mounting
this same throwaway workspace at `/ws`, and substitute its new Docker container
ID below. Do not run on the production host, mount the real project as `/ws`, or
reuse the previous real-project worker. Sandbox recreation is an operator action,
not something this script performs. Never use a host `/tmp` workspace.

```sh
# Substitute the currently running disposable ARM64 sandbox's Docker ID.
CONTAINER_ID=replace-with-current-disposable-container-id
docker exec -w /ws "$CONTAINER_ID" bash -n experiments/whisper-smoke/smoke.sh
docker exec -w /ws "$CONTAINER_ID" bash experiments/whisper-smoke/smoke.sh
```

All installation, configuration, builds, script checks and inference were executed
with `docker exec -w /ws`. There is no host installation or apt installation.
The equivalent sandbox must supply Python 3.12 (including venv/pip and tarfile's
`data` extraction filter), GCC/G++, Make, Node, Git and standard Linux utilities;
the exact observed versions are recorded in `RESULTS.md`. Python's isolated
`artifacts/venv` provides pinned CMake **3.31.6**; GCC/G++ and Make come from the
container. Public unauthenticated upstream HTTPS is used for source/model/license
downloads. No credentials are required.

### Fresh source, build and evidence on every invocation

The script was checked with `bash -n` and executed end-to-end successfully after
this procedure was introduced:

1. `mktemp -d` creates `artifacts/run-<UTC timestamp>-<random suffix>/` **inside
   `/ws/experiments/whisper-smoke`**, not `/tmp`. The corresponding
   `reproduction-evidence/run-<same ID>/` must not exist; exclusive `mkdir` fails
   instead of overwriting evidence. The script prints both run ID and evidence path.
2. Download the pinned archive into that new run directory, verify its exact size
   and SHA-256, then extract it there unconditionally. No cached extracted source
   directory is consulted. Configure/build in that run's previously nonexistent
   `build/`, never `artifacts/build` or `artifacts/reproduction-build`.
3. A cached `artifacts/ggml-base.bin` may be reused, but its exact size and SHA-256
   are always verified **before inference**, and the hash is checked again at the
   inference boundary. A mismatching model fails closed. The CMake venv may also
   be reused; it is not an extracted-source or build cache.
4. Write logs/argv and `transcript.txt` only under the new run's evidence directory.
   `fresh-paths.json` records the initially absent source/build/transcript paths;
   `output-freshness.json` records transcript absence immediately before inference.
   A nonzero inference exit fails; even exit 0 fails if a new nonempty transcript
   was not created. No stale transcript can satisfy the success check.

The original `evidence/` and the earlier successful replay's top-level files in
`reproduction-evidence/` are retained unchanged. Failed invocations may leave
partial new run directories for inspection; rerun normally to allocate new ones,
not by pointing at any previous source/build/output directory. The final reviewed
run is `reproduction-evidence/run-20261015T192903Z-b6hYGwet/`. Its
`replay-validation.json` records fresh paths, all 2,039 archived source files
byte-identical after build, all 43 compile-command entries using the fresh source,
exit 0, a transcript byte-identical to the original, and all 48 prior evidence
files unchanged (their digests are in `preserved-evidence-sha256.json`).

## Pins and build contract

- Source: `ggml-org/whisper.cpp`, v1.9.5,
  `d1be6fde11ac6e0407606b4e42fe72d34add8037`.
  Downloaded as a commit-addressed upstream codeload archive, not a Git checkout.
- Model repository: `ggerganov/whisper.cpp`, resolved commit
  `5359861c739e955e79d9a303bcbc70fb988958b1`.
  Download uses this immutable revision, **not** a `main` model URL.
- Model: `ggml-base.bin`, 147,951,465 bytes, multilingual base, unquantized
  GGML f16 storage (`ftype=1`, `qntvr=0` in the runtime log; not a Q4/Q5/Q8 model).
- Audio: unchanged `samples/jfk.wav` from the pinned source archive; mono,
  16-bit PCM, 16 kHz, 176,000 frames / 11 seconds.
- Build target: `whisper-cli`, Release, GCC/G++ explicitly `/usr/bin/gcc` and
  `/usr/bin/g++`, at most **4** build workers.
- CPU portability: `GGML_NATIVE=OFF`, `GGML_CPU_ARM_ARCH=armv8-a`.
  This intentionally avoids tuning for the container CPU; it does not constitute
  a cross-build or validation for any RK3588 operating system/toolchain.
- CPU only: `GGML_CPU=ON`; CUDA, Vulkan, Metal, BLAS, OpenMP, Core ML,
  OpenVINO, ccache, server, tests and curl explicitly off. All exact CMake flags
  are in `smoke.sh`; observed resolved values are in `evidence/CMakeCache.txt`.
  Other accelerator options remain upstream OFF defaults; runtime reports one
  CPU backend and `use gpu = 0`.
- Inference: `-t 4 -p 1 -l en -ng -otxt`; one process, 4 inference threads,
  English transcription, GPU explicitly disabled. `OMP_NUM_THREADS=4` and
  `OPENBLAS_NUM_THREADS=1` are also set (those backends were disabled).
  Remaining decoder defaults are from the pinned CLI: observed 5 beams / best of
  5. The exact original argv is `evidence/inference-command.json`.

## Licenses and public sample provenance

Evidence URLs are stored in `evidence/source-urls.json` and copies alongside it:

1. **whisper.cpp code: MIT.**
   [Pinned LICENSE](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/LICENSE),
   copied as `evidence/code-LICENSE.txt` (ggml authors, 2023–2026).
2. **Converted model: MIT declaration in its pinned model card.**
   [Pinned HF README](https://huggingface.co/ggerganov/whisper.cpp/raw/5359861c739e955e79d9a303bcbc70fb988958b1/README.md),
   copied as `evidence/model-card.md`; metadata is in `hf-repository.json`.
   That metadata also supplies the LFS SHA-256 and byte count used for verification.
   The card contains upstream's catalog; this experiment used only base and did
   not survey or download other models. Its displayed SHA column is not used as
   a SHA-256 substitute.
3. **Original Whisper code and weights: MIT.** OpenAI's
   [pinned README license statement](https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/README.md#license)
   explicitly covers both code and model weights, with the corresponding
   [MIT LICENSE](https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE).
   Copies: `model-upstream-README.md` and `model-upstream-LICENSE.txt`.
4. **Audio provenance:** the repository's public
   [JFK WAV fixture](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav),
   not a recording acquired here. `evidence/samples-README.md` records upstream's
   description of samples as testing audio. The fixture is the familiar JFK
   speech excerpt. A separate audio rights grant/original recording chain was
   not established by this experiment; do not infer one from the code/model MIT
   licenses. No audio redistribution into the intended real-repo deliverables.

This short, clean, single-speaker public historical speech sample is **not** a
telephone/call workload or synthetic call simulation. It cannot establish
accuracy for noise, codecs, overlapping speech, streaming/VAD, speaker changes,
real-time deadlines, thermal behavior, or concurrent production load. Synthetic
or other clean public samples alone would not establish those either.

## Artifact boundary: what exists versus what to copy

**Small-copy allowlist, all relative to `experiments/whisper-smoke/`:**

- Essential docs/script: `README.md`, `RESULTS.md`, `smoke.sh`, `.gitignore`.
- Original evidence: `evidence/` (only the captured text/JSON/log files).
- Earlier successful replay: the existing top-level files of
  `reproduction-evidence/` (no `artifacts/` links or build trees).
- Final reviewed replay: the text/JSON/log files of
  `reproduction-evidence/run-20261015T192903Z-b6hYGwet/`, including the small
  validation and preservation manifests.

The parent copied only that allowlisted material (about **468 KiB** of evidence)
into the real repository after review. Later replay directories are not
automatically allowlisted. No commits were made.

**Cleanup completed:** the temporary sandbox `sb_913e9ec2` was stopped and deleted.
The parent then removed the throwaway workspace's approximately **374 MiB**
`artifacts/` directory, including the model, public WAV/source trees, build trees
and isolated CMake environment, plus the feasibility package's `node_modules` and
Python caches. Small source/docs/evidence remain at the recorded throwaway host
path. Stopping/deleting a sandbox alone does not remove bind-mounted files; the
artifact deletion was a separate explicit step.

No WAV, model binary, third-party source/build tree or virtual environment was
copied into the real repository. `.gitignore` excludes `artifacts/` for future
runs; use explicit copy allowlisting rather than relying on that exclusion.
