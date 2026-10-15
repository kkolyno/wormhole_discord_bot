# Image validation results

All installation/build/test execution used `docker exec -w /ws` in approved worker
`cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4`.
No production host, registry push, Discord login, credentials, or live audio used.

## Tested snapshot

- Build command: `docker build --platform linux/arm64 -f Dockerfile.oracle-test -t oracle-test-image-dev:local .` — **PASS**.
- Tested local image ID: `sha256:e49e898af15ab0830a05540e064383e96c81531fc876224ece7785cf2d470a2b`.
  This is a **local image ID**, not a published GHCR manifest digest.
- Image configuration: `linux/arm64`, user `nodejs` (UID/GID 1001), default
  `CMD ["node", "index.js"]`.
- `python3 tools/oracle-test-image/test_contract.py` — **3/3 PASS**.
- `rhysd/actionlint:1.7.7` against `.github/workflows/oracle-test.yml` — **PASS**,
  executed as a temporary network-disabled container with the workflow on stdin.
- `python3 tools/oracle-test-image/smoke.py --image oracle-test-image-dev:local` —
  **PASS** with network disabled, no capabilities, read-only root, read-only public
  fixture volume, temporary `/tmp`, and a fresh named `/data` volume.
- Feasibility offline Node tests: **13 passed, 0 failed**.
- Oracle offline Node tests in the tested snapshot: **36 passed, 0 failed**
  (includes boot/storage, local STT and mocked session tests; no actual login).
- DAVE module/API load, Opus WASM decoder/roundtrip, AES-256-GCM availability —
  **PASS**. DAVE receive/decrypt and transport negotiation remain **unverified**.
- `ldd` resolves whisper/ggml/musl/libstdc++/libgcc; CLI also executes in a clean
  environment containing only PATH and LANG, matching the local recognizer.
- English model size/hash checked during build and again before offline inference.
- Fresh named volume: UID1001 data writes and Oracle mode-0700 private-directory
  guard **PASS**. No marker/production state touched.
- Actual distro ffmpeg conversion: 48 kHz stereo -> PCM s16le, 16 kHz, mono —
  **PASS**, checked with ffprobe.
- Pinned public JFK input -> fresh English output containing
  “ask not what your country” — **PASS**. Transcript starts “And so my fellow
  Americans…” and ends “…what you can do for your country.”
- Actual `recognizeLocal` helper with receiver-style public 48 kHz stereo PCM —
  **PASS**, including conversion, sanitized subprocess environment, bounded local
  English output and temporary audio cleanup.

The full allowlisted output is in [`evidence/offline-smoke.txt`](evidence/offline-smoke.txt).
Exact tested source checksums are in
[`evidence/image-source-hashes.txt`](evidence/image-source-hashes.txt). Other evidence
contains the model metadata, licenses, fixed CMake options, fixture identity,
static checks and image configuration. There are no model/audio/binary artifacts
in this directory.

## Versions and target differences

| Component | Observed in test image |
| --- | --- |
| Node | **22.22.0** |
| npm | **10.9.4** |
| Alpine | **3.23.3**, not target 3.23.2 |
| ffmpeg | **8.0.1** (Alpine package 8.0.1-r1 at build time) |
| GCC / G++ | **15.2.0** |
| CMake | **4.1.3** |
| Root packages | discord.js 14.25.1, dotenv 17.2.3 |
| Isolated kit packages | voice 0.19.2, davey 0.1.12, discord.js 14.27.0, opusscript 0.0.8, prism-media 1.3.5 |
| Container kernel | Linux 7.0.14-orbstack-00380-ga7e0a2dc9535 aarch64 (**not** target kernel) |

Base digest is recorded in the Dockerfile/README. Both npm installs used original
lockfiles and `--ignore-scripts`; no root package/source changes were made. The
native whisper build uses portable ARMv8-A, four build workers, no OpenMP/BLAS or
GPU/NPU backend. Alpine's distro ffmpeg includes unrelated hardware/codec support;
no hardware device is provided or requested during testing.

## Limits / parent handoff

The other worker edits `tools/oracle-test/` concurrently. The image above is a
**tested snapshot**, not proof that subsequent workspace edits have been tested.
An immediate post-test comparison already observed `session.js` changing after
this image was built. Parent **must rebuild and rerun smoke after that worker
finishes**, compare `evidence/image-source-hashes.txt` with the final files, and
refresh this evidence if publishing a different snapshot.

An earlier intermediate image caught missing versioned shared-library aliases;
packaging now copies them with dereferencing and passes linkage checks. Another
intermediate test snapshot caught inconsistent local-STT code/tests while that
worker was updating both; the subsequently rebuilt snapshot passes all 36 tests.
The final result is not based on ignoring those failures.

There is no RK3588 performance, latency, RTF, call-audio accuracy, DAVE decryption,
NPU acceleration, actual target-kernel compatibility, successful GHCR publication,
or live deployment claim. The parent owns final ref selection, immutable published
digest, registry policy, deployment config, secrets, rollback and live consent.

All named `oracle-test-image-dev-<pid>-*` temporary containers/volumes were cleaned
by the smoke runner; a failed build's intermediate container was explicitly removed.
The parent worker remains running. The temporary image tag
`oracle-test-image-dev:local` and Docker build cache remain for parent revalidation;
source/model/build binaries exist only in Docker layers, not the checkout. The
small worker-only build log is `/tmp/oracle-test-image-dev/build.txt`.

## Final parent revalidation after review fixes

The parent rebuilt after all runtime-worker edits finished and after adding Tini,
token-format compatibility, an explicit process-group-exit barrier, and immediate
owner-only receive subscription. Final tested local image:
`sha256:d9a10d818778d6226ff631f8c4ad14b1cfb9e748a6b61744f3cb44dbf7e053b2`.
The original evidence above remains historical; **`evidence/final/`** records this
newer successful snapshot, including exact final source hashes.

- Image contracts: **3/3 passed**.
- Feature branch's single existing-workflow test publisher passed Actionlint 1.7.7.
- Final native ARM64/musl image: **13/13 feasibility tests + 44/44 Oracle tests**,
  no failures or skipped tests (real ffmpeg available).
- Actual orphaned process-group integration under Tini passed: legacy substitute
  could start only after the test group disappeared; no application login occurred.
- Fresh private volume, UID1001 storage guard, shared-library checks, model digest,
  proper ffmpeg resampling, network-disabled public English inference, and actual
  local-recognizer conversion/recognition/audio cleanup all passed again.
- No Discord login, private audio or RK3588 execution was involved in these checks.

The duplicate new workflow was removed. Publication uses the existing
`docker-publish.yml` with explicit `oracle_test=true` on this feature branch;
it cannot publish test `latest`, refuses a previously published commit tag, and
does not require merging anything into `main`. See the README's current command.
