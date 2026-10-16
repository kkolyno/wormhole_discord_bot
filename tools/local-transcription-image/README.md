# Credential-free ARM64 image checks

See `docs/LOCAL_TRANSCRIPTION_RESULTS.md` for final scope, counts and limitations.
These helpers do not authorize deployment, bot login, or recording. The latest
standing-company-consent checks are recorded separately in
`docs/STANDING_CONSENT_RESULTS.md` and `evidence/channel-consent/`; the parent
folder's 159-test image is a historical manual-policy snapshot.

Run installations/builds/checks **inside an approved disposable Linux/ARM64
worker**, with source at `/ws`, no production credentials or private audio:

```sh
python3 -B tools/local-transcription-image/test_contract.py
node --test test/local-transcription/*.test.js
docker build --platform linux/arm64 -f Dockerfile.transcription \
  -t local-transcription-dev:reviewed .
python3 -B tools/local-transcription-image/smoke.py \
  --image local-transcription-dev:reviewed \
  --evidence tools/local-transcription-image/evidence/reviewed-run
```

The smoke driver fetches only the fixed public JFK fixture from pinned
whisper.cpp commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` and validates its
352,078-byte length and SHA-256. Fixture rights have not been independently
established; no fixture audio is committed. Actual inference containers have
network disabled, read-only root, UID1001, dropped capabilities, no credentials
or Docker socket, and disposable private data volumes. The driver—not the
inference container—needs Docker access to create its owned containers/volumes.
It removes those resources and public/synthetic audio in `finally`.

`preflight.sh` checks pinned runtime/model/linkage, native codec loading, synthetic
Opus, all local-transcription tests and real ffmpeg conversion without app login.
`public-helper.js` invokes the actual new recognizer on verified public speech;
it never constructs a Discord client. `smoke.py` also proves kernel-lock exclusion
between two container PID namespaces, keeping the parent Node process alive after
its short-lived acquiring helper exits.

`evidence/` contains **development-VM** results, not private microphone transcripts
or RK3588 capacity measurements. The final `results.json`, `offline-smoke.txt`,
`image.txt`, and `image-source-hashes.txt` supersede earlier snapshots. The older
`offline-smoke-initial.txt` documents an intermediate permission-fixture/umask
failure, not a passing image. `integration-unit.txt` is the final outer-worker
suite. Public sample timing in the log must not be presented as a target benchmark.

The GitHub workflow separately requires explicit feature-branch
`local_transcription=true`; it builds/loads, checks offline, performs fixed-hash
public inference, and only then pushes `transcription-<full40sha>`. No publication
or deployment was performed during this development phase. Do not substitute
`latest`, rearm the one-shot, prune rollback artifacts, or mount production data
into this test tooling.
