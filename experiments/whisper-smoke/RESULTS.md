# Observed result — local smoke only, NOT RK3588

**PASS for this narrowly scoped recognition smoke test.** The pinned CPU-only
build succeeded and the public JFK fixture produced a sensible transcript with
process exit code **0**. The same test was replayed through the earlier
`smoke.sh`, then replayed again after fixing source/output freshness; both replays
built and exited **0**. The final replay used newly extracted verified source,
a new build directory and a new evidence directory. These are three executions
of the same fixture/model/configuration, not a model survey or benchmark suite. No RK3588 was involved and no target performance,
call feasibility, performance acceptance, or architecture conclusion follows.

## Environment actually observed

Original evidence capture timestamp (container clock): `2026-10-15T19:17:39Z`.

| Component | Observed value |
|---|---|
| Execution environment | Disposable WarpDrive Docker container, Linux **aarch64**, **not RK3588** |
| Kernel | `7.0.14-orbstack-00380-ga7e0a2dc9535` |
| Python | 3.12.3 |
| Node | v24.18.0 (not part of recognition runtime) |
| GCC / G++ | Ubuntu `13.3.0-6ubuntu2~24.04.1`, compiler 13.3.0 |
| CMake | 3.31.6, installed only in experiment's Python venv |
| Make | GNU Make 4.3 |
| libc | Ubuntu GLIBC `2.39-0ubuntu8.7`, 2.39 |
| Git | 2.43.0 (source acquired as commit-addressed archive) |
| pip | 24.0 in isolated venv |
| whisper.cpp | v1.9.5, pinned commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` |
| ggml | 0.26.0, bundled with that source archive |
| CPU backend | NEON=1, ARM_FMA=1, REPACK=1; one backend, GPU disabled |

Full version output: `evidence/versions.txt`; dynamic linkage:
`evidence/runtime-linkage.txt`. Linked libraries include libwhisper, libggml,
libggml-base, libggml-cpu, libstdc++, libm, libgcc_s and libc. No GPU library is
shown. Configuration resolved `-march=armv8-a`; native detection/tuning was off.
Exact flags/argv: `smoke.sh`, `evidence/CMakeCache.txt`, and
`evidence/inference-command.json`.

## Integrity verified before inference

| Input | Bytes | Actual SHA-256 |
|---|---:|---|
| Source archive, pinned commit | 9,631,456 | `645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4` |
| `ggml-base.bin` | 147,951,465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| Upstream `samples/jfk.wav` | 352,078 | `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e` |

Model hash and byte count matched the expected HF LFS object **before use**;
`evidence/model-checksum-verified.txt` records the successful gate. Full integrity
manifest: `evidence/hashes.json`. HF repository revision resolved before download:
`5359861c739e955e79d9a303bcbc70fb988958b1`; model downloads were revision-pinned.
The base model is multilingual and unquantized (`ftype=1`, `qntvr=0`, 99 languages
reported), not base.en and not a reduced-bit quantization. No quantization was run.

## Output and exit codes

Exact `evidence/transcript.txt` text:

```text
And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.
```

- Original configure: successful; build: **0** (`evidence/build-exit-code.txt`).
- Original recognition process: **0** (`evidence/run.json`).
- `bash -n experiments/whisper-smoke/smoke.sh`: **0**.
- Earlier end-to-end `smoke.sh` reproduction: **0**, with identical transcript
  (`reproduction-evidence/transcript.txt`); replay build also **0**. Its evidence
  is retained unchanged, but that older script reused an extracted source tree.
- Final reviewed replay: **0**, under
  `reproduction-evidence/run-20261015T192903Z-b6hYGwet/`; capture timestamp
  `2026-10-15T19:29:07Z`. Build and inference both **0**. This replay used the new
  fresh-source/fresh-build/fresh-evidence procedure described in `README.md`.
- Final `cmp` of original versus final replay transcripts: **0** (byte-identical).
  Python assertions additionally confirmed all 2,039 regular archive members
  remained byte-identical in the fresh source tree after building, all 43 compile
  commands referenced that fresh tree/new build, CMake used that source root,
  and inference argv referenced the new binary, fresh WAV and new output path.
  The initially absent source/build/transcript paths and transcript absence at
  the inference boundary are recorded in `fresh-paths.json` and
  `output-freshness.json`; no old source/build/output path was used.
- Final assertions confirmed identical input hashes to the original and all
  **48** original/earlier replay evidence files unchanged against a pre-run
  SHA-256 snapshot. The final run's `replay-validation.json` and
  `preserved-evidence-sha256.json` retain those results. All syntax checks, the
  full replay and validation assertions ran via `docker exec -w /ws` in the
  supplied disposable container; no host build/test/inference was performed.

No WER scoring, reference-transcript accuracy assertion, unit suite, or
performance acceptance was run. Transcript assessment above is a manual sanity
check, not measured recognition accuracy.

Raw timestamped transcript/stdout is in `evidence/inference.stdout.log`; model
loading, CPU configuration and upstream timings are in `inference.stderr.log`.
The earlier replay has top-level `reproduction-evidence/` logs and the final
reviewed replay has its own run-specific subdirectory there. Upstream's internal
timing output and recorded wall elapsed values are retained only as **smoke
telemetry from this non-target container**. They are not RK3588 measurements;
no RTF or extrapolation is reported or justified.

## Non-blocking diagnostics and limitations

- CMake emitted a minimum-version deprecation warning.
- Because the permitted compressed-source approach was used, upstream's Git
  metadata probes emitted `fatal: not a git repository` diagnostic text while
  configuration still succeeded. ggml reports build commit `unknown`; the
  exact source identity is established by the pinned URL and archive digest,
  not an embedded Git string. No upstream source patch was needed.
- No compiler/build failure, dependency blocker or source flag workaround beyond
  explicit `GGML_NATIVE=OFF` / `GGML_CPU_ARM_ARCH=armv8-a` occurred.
- All inference used the unchanged public 11-second sample, not live/private
  audio. Public fixture provenance and code/model MIT evidence are documented
  separately in `README.md`; sample rights were not independently established.
- This validates that this pinned software/model pair can build, load and
  transcribe that fixture on **this Linux aarch64 sandbox** only. It validates
  neither an RK3588 deployment nor calls, streaming behavior, thermals, system
  resource budgets, integration readiness, or production suitability.

No blockers remain for this smoke assignment. The parent may collect the small
allowlisted deliverables and stop the sandbox; large artifacts are local-only.
