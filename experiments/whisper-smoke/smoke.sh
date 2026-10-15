#!/usr/bin/env bash
# Run ONLY inside the supplied disposable Linux aarch64 container, from /ws.
# This is NOT an RK3588 benchmark or a call-audio feasibility test.
set -euo pipefail
[[ "$PWD" == /ws && "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] || {
  echo 'Run via docker exec -w /ws <sandbox-container> bash experiments/whisper-smoke/smoke.sh' >&2
  exit 2
}
ROOT=/ws/experiments/whisper-smoke
A="$ROOT/artifacts"
# Every invocation owns fresh source/build/evidence paths. Never reuse an
# extracted tree, build cache, or transcript from an earlier invocation.
mkdir -p "$A" "$ROOT/reproduction-evidence"
R=$(mktemp -d "$A/run-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
RUN_ID=${R##*/}
E="$ROOT/reproduction-evidence/$RUN_ID"
mkdir "$E" # Fail if this evidence path already exists; never overwrite it.
S="$R/whisper.cpp-d1be6fde11ac6e0407606b4e42fe72d34add8037"
B="$R/build"
[[ ! -e "$S" && ! -e "$B" && ! -e "$E/transcript.txt" ]]
export A R E S B
printf 'Fresh run: %s\nEvidence: %s\n' "$RUN_ID" "$E"
python3 - <<'PY'
import json, os, pathlib
paths = {k: os.environ[k] for k in ('R', 'S', 'B', 'E')}
paths.update(source_absent_before_extraction=True, build_absent_before_configure=True,
             transcript_absent_at_run_start=True)
(pathlib.Path(os.environ['E']) / 'fresh-paths.json').write_text(json.dumps(paths, indent=2) + '\n')
PY
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1
python3 - <<'PY'
import hashlib, json, os, pathlib, shutil, tarfile, urllib.request
A, R, E, source = (pathlib.Path(os.environ[k]) for k in ('A', 'R', 'E', 'S'))
source_commit = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
hf_commit = '5359861c739e955e79d9a303bcbc70fb988958b1'
openai_commit = '86098128c0b4f24f0e2aa2994de830614b474227'
sources = {}
def fetch(name, url, path):
    sources[name] = url
    with urllib.request.urlopen(url, timeout=120) as src, path.open('wb') as dst:
        shutil.copyfileobj(src, dst)
def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()
def verify(path, size, sha):
    if path.stat().st_size != size or digest(path) != sha:
        raise RuntimeError(f'Checksum/size mismatch, refusing use: {path}')
archive = R / 'source.tar.gz'
fetch('source_archive', f'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/{source_commit}', archive)
verify(archive, 9631456, '645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4')
assert not source.exists(), f'Refusing cached source: {source}'
with tarfile.open(archive) as t:
    t.extractall(R, filter='data')
audio = source / 'samples/jfk.wav'
verify(audio, 352078, '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e')
model = A / 'ggml-base.bin'
model_url = f'https://huggingface.co/ggerganov/whisper.cpp/resolve/{hf_commit}/ggml-base.bin'
sources['model'] = model_url
if not model.exists():
    fetch('model', model_url, model)
# Always verify, including cached models; MUST precede inference.
verify(model, 147951465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe')
(E / 'model-checksum-verified.txt').write_text(f'PASS BEFORE INFERENCE: {digest(model)}  ggml-base.bin (147951465 bytes)\n')
fetch('hf_metadata', f'https://huggingface.co/api/models/ggerganov/whisper.cpp/revision/{hf_commit}?blobs=true', E / 'hf-repository.json')
metadata = json.loads((E / 'hf-repository.json').read_text())
assert metadata['sha'] == hf_commit
entry = next(x for x in metadata['siblings'] if x['rfilename'] == 'ggml-base.bin')
assert entry['lfs']['sha256'] == digest(model) and entry['size'] == 147951465
fetch('model_card', f'https://huggingface.co/ggerganov/whisper.cpp/raw/{hf_commit}/README.md', E / 'model-card.md')
fetch('model_license', f'https://raw.githubusercontent.com/openai/whisper/{openai_commit}/LICENSE', E / 'model-upstream-LICENSE.txt')
fetch('model_license_statement', f'https://raw.githubusercontent.com/openai/whisper/{openai_commit}/README.md', E / 'model-upstream-README.md')
sources['code_license'] = f'https://github.com/ggml-org/whisper.cpp/blob/{source_commit}/LICENSE'
sources['audio'] = f'https://github.com/ggml-org/whisper.cpp/blob/{source_commit}/samples/jfk.wav'
shutil.copyfile(source / 'LICENSE', E / 'code-LICENSE.txt')
shutil.copyfile(source / 'samples/README.md', E / 'samples-README.md')
(E / 'source-urls.json').write_text(json.dumps(sources, indent=2) + '\n')
(E / 'hashes.json').write_text(json.dumps({name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for name, p in [('source.tar.gz', archive), ('ggml-base.bin', model), ('jfk.wav', audio)]}, indent=2) + '\n')
PY
[[ -x "$A/venv/bin/python" ]] || python3 -m venv "$A/venv"
"$A/venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir cmake==3.31.6 > "$E/cmake-install.log" 2>&1
CMAKE="$A/venv/bin/cmake"
{
  date -u +%FT%TZ; uname -srm; python3 --version; node --version
  gcc --version; g++ --version; "$CMAKE" --version; make --version
  ldd --version; git --version; "$A/venv/bin/python" -m pip --version
} > "$E/versions.txt" 2>&1
# B was absent at run creation; no previous CMake state is consumed.
[[ ! -e "$B" ]]
"$CMAKE" -S "$S" -B "$B" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=/usr/bin/gcc -DCMAKE_CXX_COMPILER=/usr/bin/g++ \
  -DWHISPER_BUILD_IS_DEV=OFF -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF -DWHISPER_CURL=OFF \
  -DWHISPER_COREML=OFF -DWHISPER_OPENVINO=OFF \
  -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8-a -DGGML_CPU=ON \
  -DGGML_CUDA=OFF -DGGML_VULKAN=OFF -DGGML_METAL=OFF \
  -DGGML_BLAS=OFF -DGGML_OPENMP=OFF -DGGML_CCACHE=OFF \
  > "$E/configure.log" 2>&1
set +e
"$CMAKE" --build "$B" --target whisper-cli --parallel 4 > "$E/build.log" 2>&1
code=$?
set -e
printf '%s\n' "$code" > "$E/build-exit-code.txt"
[[ "$code" == 0 ]] || exit "$code"
cp "$B/CMakeCache.txt" "$E/CMakeCache.txt"
ldd "$B/bin/whisper-cli" > "$E/runtime-linkage.txt"
"$B/bin/whisper-cli" --help > "$E/cli-help.txt" 2>&1
python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess, time, wave
A, B, E, S = (pathlib.Path(os.environ[k]) for k in ('A', 'B', 'E', 'S'))
model = A / 'ggml-base.bin'
with model.open('rb') as f:
    assert hashlib.file_digest(f, 'sha256').hexdigest() == '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
audio = S / 'samples/jfk.wav'
with wave.open(str(audio), 'rb') as w:
    metadata = dict(channels=w.getnchannels(), sample_width_bytes=w.getsampwidth(), sample_rate_hz=w.getframerate(), frames=w.getnframes(), duration_seconds=w.getnframes()/w.getframerate())
(E / 'audio-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
cmd = [str(B / 'bin/whisper-cli'), '-m', str(model), '-f', str(audio), '-t', '4', '-p', '1', '-l', 'en', '-ng', '-otxt', '-of', str(E / 'transcript')]
(E / 'inference-command.json').write_text(json.dumps(cmd, indent=2) + '\n')
transcript = E / 'transcript.txt'
assert not transcript.exists(), f'Refusing stale transcript: {transcript}'
(E / 'output-freshness.json').write_text(json.dumps(dict(transcript_path=str(transcript), absent_immediately_before_inference=True), indent=2) + '\n')
start = time.monotonic()
with (E / 'inference.stdout.log').open('x') as out, (E / 'inference.stderr.log').open('x') as err:
    result = subprocess.run(cmd, stdout=out, stderr=err)
(E / 'run.json').write_text(json.dumps(dict(exit_code=result.returncode, elapsed_seconds_smoke_only=time.monotonic()-start, not_rk3588=True, hardware_benchmark=False), indent=2) + '\n')
if result.returncode:
    raise SystemExit(result.returncode)
if not transcript.is_file() or not transcript.stat().st_size:
    raise SystemExit('Inference exited 0 without creating a nonempty fresh transcript')
print(transcript.read_text())
PY
