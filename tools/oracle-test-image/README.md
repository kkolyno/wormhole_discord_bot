# Isolated Oracle test image (English, CPU only)

This image is **not** the production image and does not change the root application,
root dependencies or original `Dockerfile`. The feature branch adds an explicit
test-image input to the existing dispatchable publish workflow; `main` is untouched.
No tokens,
environment/secret configuration files, private audio, or transcripts are embedded. Only allowlisted
JavaScript, package manifests, and feasibility JavaScript tests are copied from
`tools/`; binaries/model/source build artifacts remain in temporary Docker layers,
not the checkout. The public test WAV is deliberately **not** baked into the image.

## Safe default and explicit activation

The image retains `CMD ["node", "index.js"]` (the original bot behavior). Merely
pulling it does nothing; starting it without a command override does **not** opt in
to recording. It may run the original bot if credentials are supplied. The parent
operator must independently approve the actual service configuration and supply:

```yaml
# Illustrative fragment only; parent owns deployment, secrets, target, rollback.
image: ghcr.io/kkolyno/wormhole_discord_bot:oracle-test-<FULL_40_CHARACTER_COMMIT_SHA>
command: ["node", "tools/oracle-test/boot.js", "--authorized-live-oracle-test"]
environment:
  DATA_DIR: /data/oracle-test
volumes:
  - oracle_test_data:/data
```

Use the published **registry digest** as well when selecting a deployment artifact.
No credential handling, production login, SSH, deployment, or rollback is performed
by these tools or the workflow. The boot module owns further exact target/token
identity checks and runtime authorization. Its presence alone is not authorization.
The Dockerfile copies flat `tools/oracle-test/*.js` modules; additions of nested
runtime modules or new isolated dependencies require an explicit image update.

Runtime UID/GID is **1001:1001**. `/data` and `/data/oracle-test` are owned by that
identity in the image; `/data/oracle-test` has mode **0700** to satisfy the boot
module's private-storage guard. A **new** named volume mounted at `/data` is seeded
with correct ownership and permissions. An existing volume or bind mount masks this ownership and must
be prepared by the parent operator; the image never chowns arbitrary mounted data
at startup. No `VOLUME` instruction creates surprise anonymous volumes.

## Pinned inputs and licenses

| Input | Pin / verification |
| --- | --- |
| Base image | `node:22.22.0-alpine3.23@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34` (multi-platform index; build only `linux/arm64`) |
| whisper.cpp | v1.9.5 commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` |
| Source archive | `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/d1be6fde11ac6e0407606b4e42fe72d34add8037`, **9,631,456 bytes**, SHA-256 `645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4` |
| English model | `ggerganov/whisper.cpp`, HF revision `5359861c739e955e79d9a303bcbc70fb988958b1`, `ggml-base.en.bin`, **147,964,211 bytes**, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| Public JFK WAV | same whisper.cpp commit, `samples/jfk.wav`, **352,078 bytes**, SHA-256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e` |
| Node dependencies | existing root and `tools/feasibility/package-lock.json`; both `npm ci --omit=dev --ignore-scripts` |

Authoritative model metadata (revision, size, LFS SHA-256, `license: mit`) is recorded
in [`evidence/model-metadata.txt`](evidence/model-metadata.txt). Model URL:
`https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin`.
Both size and SHA-256 are verified **before** use; a truncated or different download
fails the build. The offline preflight verifies the baked model again.

Code MIT evidence: the pinned whisper.cpp
[`LICENSE`](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/LICENSE)
is copied from the verified archive to `/usr/share/licenses/whisper.cpp/LICENSE`.
Model MIT evidence: OpenAI Whisper's pinned
[`README.md` License section](https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/README.md#license)
explicitly states **code and model weights are released under the MIT License**.
That README (SHA-256 `38c180c2a8d8ba628a3e131ad42bf06c8a51bb681efb30fbe28d5a0f4b65f288`)
and accompanying MIT LICENSE (SHA-256
`b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d`)
are verified and installed in `/usr/share/licenses/whisper-model/`. HF model metadata
independently declares MIT. This does not relabel the distro ffmpeg or its codecs
as MIT; Alpine packages retain their own licenses and distribution obligations.

## Runtime/build contract

- `/usr/local/bin/whisper-cli`, `/opt/models/ggml-base.en.bin`, `/usr/bin/ffmpeg`.
- Tini is PID 1, forwarding shutdown and reaping orphaned test recognizers. Boot
  must confirm the test process group is gone before starting legacy behavior.
- Native portable ARMv8-A CPU backend: `GGML_NATIVE=OFF`,
  `GGML_CPU_ARM_ARCH=armv8-a`, at most **four build workers**.
- Whisper server, tests, curl, CoreML, OpenVINO, BLAS, OpenMP, CUDA, Vulkan, and Metal
  are disabled. No GPU/NPU device or host driver is required or requested.
- Shared libraries, including versioned SONAME aliases, are copied to
  `/usr/local/lib`; the runtime stage checks `ldd` and CLI execution. Offline tests
  also execute with a sanitized environment, matching the local recognizer.
- Distro ffmpeg performs actual 48 kHz stereo -> **16 kHz mono PCM s16le** conversion;
  ffprobe checks the result. Distro ffmpeg may include unused hardware/codec
  support; this does not enable a whisper GPU/NPU backend.
- Original dependencies are separate from the feasibility kit; the latter requires
  Node **>=22.12.0** and includes pinned voice/DAVE API/Opus WASM dependencies.
- Model is English-only and inference uses `-l en`. This is appropriate for the
  requested American English baseline, not a separate accent-specific model.
- The Node base digest is immutable, but `apk` repository package revisions are not
  snapshot-pinned. Downloaded source/model and npm locks are fixed; this is **not**
  a claim of byte-for-byte reproducible images across future Alpine repo updates.

## Local validation (only inside the approved worker)

From the host, prefix every command below with
`docker exec -w /ws <approved-worker-container>`. Do not run builds on a production
host. In this task the approved worker is
`cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4`.

```sh
python3 tools/oracle-test-image/test_contract.py
docker build --platform linux/arm64 -f Dockerfile.oracle-test -t oracle-test-image-dev:local .
python3 tools/oracle-test-image/smoke.py --image oracle-test-image-dev:local
```

`smoke.py` downloads only the pinned public WAV into worker `/tmp`, validates its
size/hash, copies it through a temporary helper into a unique volume, mounts that
volume **read-only**, and runs the image with **network disabled**, read-only root,
no capabilities, a writable `/tmp`, and a fresh data volume. All named containers
and volumes it creates are cleaned in `finally`; the parent worker is untouched.
Evidence is limited to small `.txt` files (no audio/binaries/model in the checkout).
The preflight invokes offline feasibility and Oracle boot/storage/STT JS tests,
checks the Oracle private-data-directory contract, checks DAVE module/API load and
synthetic Opus WASM roundtrips, validates UID/data ownership and resampling, then
runs fresh English inference, then exercises the real local recognizer helper
with public receiver-format 48 kHz stereo PCM, including its sanitized subprocess
environment and temporary audio cleanup. It never launches the boot/test entrypoint
or logs into Discord (offline unit tests import modules with mocked adapters).

DAVE API loading is **not** proof of successful live DAVE receive/decryption. A
public JFK transcript sanity check is **not** an accuracy benchmark, call-audio
validation, latency claim, or RK3588 real-time-factor measurement. The development
container's kernel/CPU/RAM differ from the Oracle target. Actual target details
(Node 22.22.0, Alpine 3.23.2, Linux ARM64 kernel 6.1.99, 7.74 GiB RAM,
`rknpu` 0.9.8) are context only; NPU is unused.

## Manual GHCR publication

The single test-image publisher is the feature branch's existing
`.github/workflows/docker-publish.yml`, dispatched with **`oracle_test=true`**.
The existing workflow already exists on the default branch, so GitHub can dispatch
its feature-ref definition without merging a new workflow into `main`.

The explicit input defaults to false. Test-image requests on `main` are refused;
feature test requests use a native ARM64 runner, `Dockerfile.oracle-test`,
`contents: read` / `packages: write`, and standard OCI source/revision labels.
Only this full-commit test tag is published in that mode:

`ghcr.io/kkolyno/wormhole_discord_bot:oracle-test-<full github.sha>`

Test mode disables the normal `latest` and short-SHA tags. Normal main-push builds
retain the original Dockerfile/tag behavior. The duplicate `oracle-test.yml` was
removed so two publishers cannot race on the same tag. Test publication is
serialized per commit and refuses a pre-existing tag. GHCR tags are technically
mutable; retain the resulting manifest digest and local image ID for deployment
identity and use a new commit for changed images. No deployment or production
credentials are handled by CI.

Parent handles branch publication and this explicit dispatch:

```sh
gh workflow run docker-publish.yml --ref feat/rk3588-local-transcription -f oracle_test=true
```

The worker did not dispatch a workflow or access production.
