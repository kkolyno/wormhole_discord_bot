# Oracle meeting deployment — operator-only, bounded helper

`scripts/oracle-meeting-deploy.py` installs the reviewed production meeting image
on **the existing Oracle only**. It imports the unchanged
`oracle-transcription-admin.py` for `PrivateStore`, `StackLock`, the background job
journal, error handling, mutation guard, original runtime validation, and bounded
OMV RPC plumbing. Keep both files together. No application changes or public status
endpoint are included. Implementation/tests used credential-free fakes only; no
production credentials, OMV, Discord, registry pull, or live deployment was used.

Read [the original operations guide](ORACLE-TEST-OPERATIONS.md) for the underlying
RPC, locking, private storage, timeout, and original rollback contract. This guide
supersedes its **one-shot** phase instructions for the new journal.

## Fixed deployment and consent policy

- Fixed stack `d5e4c8ad-09c6-4a9b-8f8f-473355d75d76`, service
  `meeting-helper-bot`, container `Oracle`; no duplicate bot/service.
- Only `ghcr.io/kkolyno/wormhole_discord_bot:transcription-<40 lowercase hex>`
  is accepted. No main/latest pull, arbitrary image, shell/exec/RPC escape hatch,
  credential argument, volume operation, or generic restart is available.
- New override is derived from the **original** baseline, replacing, not merging
  with, the one-shot override. Original body/env/metadata/booleans remain exact.
  All original service environment, including the existing bot token and channel
  settings, is preserved privately, with only these explicit changes:

  ```text
  LOCAL_TRANSCRIPTION_ENABLED=true
  LOCAL_TRANSCRIPTION_CONSENT_MODE=channel
  LOCAL_TRANSCRIPT_ATTACHMENTS=false
  LOCAL_TRANSCRIPTION_DATA_DIR=/data/transcription
  ```

  Channel consent is the standing company/channel-consent mode expressly requested
  by the operator, not a silent change to manual consent. Confirm company policy,
  existing authorized guild/channel scope, participant notices, and stop/withdrawal
  procedures before live activation. This CLI does not grant Discord permissions
  or independently establish consent. It does not alter guild/channel identifiers.
- Command is exactly `["node", "index.js"]`, stop grace exactly `45s`. The new
  image supplies Tini `["/sbin/tini", "--", "docker-entrypoint.sh"]`. Pull checks
  Linux/ARM64, `USER nodejs`, command, entrypoint, and no image-declared volumes.
  `Dockerfile.transcription` defines that named user/group as UID/GID 1001; image
  inspect exposes the name, **not** `/etc/passwd`. Numeric identity depends on the
  separately reviewed build. This helper never execs a UID probe or changes users.
  An original explicit entrypoint (even `[]`) blocks preparation rather than
  suppressing inherited Tini. Original user/workdir overrides are accepted only
  when they retain UID/GID 1001 (`nodejs` or equivalent) and `/app`.
- Exactly one RW, local named volume `oracle-meeting-transcription-data` at
  `/data`; the image also defaults `LOCAL_TRANSCRIPTION_DATA_DIR` to
  `/data/transcription`. No old one-shot mount survives the new override.
- **Never mount, erase, or rearm `oracle-transcription-data`.** It stays retained
  and untouched. Rollback also retains the new volume and never restarts one-shot
  boot code. There are no volume-delete or speech-file-read operations.

## Preconditions / limits requiring parent review

1. Confirm GitHub run `38906692896` published the reviewed app
   `ea7ebe62ee5c8ba400599ac0888976809dc48b4f` and ARM64 image. A SHA-shaped tag is
   not registry immutability or provenance. After pulling, the helper binds to the
   locally observed full image ID and rejects subsequent local tag drift.
2. The successful prior journal must remain at
   `.private/oracle-transcription-live-20261015b`, directly under `.private`, owned
   by the operator, directory mode `0700`, files `0600`, no symlinks. Its original
   image must be
   `sha256:b44105db8c52b15918f068653f0c52eaa2d1c2e70cfc0220a2e3b72b9d379edc`;
   its pulled one-shot image must be
   `sha256:f5222dab8309d1eea2d02125c940a161573427f199ae9ba51639c71e1c507d03`.
   It needs original schema-1 snapshot, prepared/pulled records, successful
   activation, and immutable original rollback pin request/submission/completion.
   Oracle must still run that one-shot image with its exact configured runtime.
3. Independently confirm the one-shot finished marker/legacy handoff if needed;
   this helper deliberately does not read the old volume or any speech data.
4. **Confirm globally that `oracle-meeting-transcription-data` does not already
   exist or belong to another stack before the first activation.** The helper
   rejects collisions declared in the original stack but does not list global
   volumes or inspect their contents. Freshness/ownership is an operator
   precondition, not an inference from the new name. Never delete an existing
   volume to get past this precondition. Confirm image copy-up makes `/data`
   writable by UID 1001; the helper neither chowns nor initializes data itself.
5. Keep original and one-shot images, original source tag, and rollback tag local;
   do not prune/pull/retag those references. The helper re-verifies the saved
   original rollback pin before mutations. Original source is restored only if
   its original local image reference still resolves to the original full ID.
6. No live OMV/schema/platform compatibility or Discord readiness was tested here.
   Custom service keys/networks/mount options fail closed rather than being
   guessed. Original runtime schema is intentionally narrow. Only the new
   `stop_grace_period: 45s` and exact volume are added. Runtime checks cover full
   effective env, command/entrypoint, user/workdir, network/restart, named RW
   mount, image/running/project identity, and `Config.StopTimeout == 45`.
  Docker may serialize the one named mount through structured `HostConfig.Mounts`
  or exactly `["<expected-volume>:/data:rw"]` in `HostConfig.Binds`; the latter
  was freshly observed on this deployment. Actual `Mounts` must still identify
  the expected local RW named volume. Extra/host-path/read-only/conflicting
  declarations are rejected.
7. One checkout/host/operator; do not run external Compose/OMV changes concurrently.
   Sequential fresh observations are not an atomic server-side transaction.
   Same-UID/root filesystem interference is outside the storage safety boundary.

## Exact invocation sequence (parent only; not run by the worker)

Run from the credential-bearing operator repository **after reviewing these new
files**, not from the credential-free worker. The only credential location is the
existing `.private/omv.json` read by the original helper's `load_client`; never
pass or print credentials. Select a fresh deployment journal. These commands use
only public metadata in argv:

```sh
umask 077
PREVIOUS="$PWD/.private/oracle-transcription-live-20261015b"
BACKUP="$PWD/.private/oracle-meeting-live-ea7ebe62-20261016"
IMAGE='ghcr.io/kkolyno/wormhole_discord_bot:transcription-ea7ebe62ee5c8ba400599ac0888976809dc48b4f'

python3 -B scripts/oracle-meeting-deploy.py snapshot --backup-dir "$BACKUP" --previous-backup-dir "$PREVIOUS"
python3 -B scripts/oracle-meeting-deploy.py status --backup-dir "$BACKUP"
python3 -B scripts/oracle-meeting-deploy.py prepare --backup-dir "$BACKUP" --image "$IMAGE" --authorize-live-change
python3 -B scripts/oracle-meeting-deploy.py pull --backup-dir "$BACKUP" --authorize-live-change
python3 -B scripts/oracle-meeting-deploy.py activate --backup-dir "$BACKUP" --authorize-live-change
python3 -B scripts/oracle-meeting-deploy.py status --backup-dir "$BACKUP"
python3 -B scripts/oracle-meeting-deploy.py verify --backup-dir "$BACKUP"

# Only if the parent decides to restore the EXACT ORIGINAL deployment:
python3 -B scripts/oracle-meeting-deploy.py rollback --backup-dir "$BACKUP" --authorize-live-change
python3 -B scripts/oracle-meeting-deploy.py status --backup-dir "$BACKUP"
```

Each prepare/pull/activate/rollback needs `--authorize-live-change`. Image is
required **only** for prepare; previous journal is required **only** for
snapshot/resume-snapshot. No authorization flag is needed for snapshot, status,
or bounded log verification. `--deadline-seconds 1..600` defaults to 120 per job;
an in-flight RPC may exceed that by the transport timeout.

## Evidence, validation, phases

All journals must be direct children of `.private`; no public dumps. Full source,
config, image/container inspect, environments, logs, RPC intents, returned job
filenames, polls/positions/output and outcomes are sensitive. Directories are
`0700`, records `0600`, atomic/fsynced/no-overwrite. Existing wrong permissions or
symlinks block; nothing is automatically chmodded or overwritten. Public stdout
is one allowlisted JSON object; errors contain only fixed codes, never raw server
responses, log lines, filenames, secret values, or exceptions.

- **snapshot / resume-snapshot**: fresh `previous.saved()`/`previous.prepared()`
  validation checks complete original rollback/runtime and exact current
  one-shot source/config. It also requires the prepared source to be the precise
  old helper-derived override, successful prior activation, expected full IDs,
  still-valid original pin, fresh one-shot tag/image, running/project identity,
  actual full environment/process/user/network/restart and exact old named mount.
  It saves the **original** `snapshot.json` and `original-file.json`, copies the
  completed original pin records (no retag), and retains `previous-prepared.json`,
  `previous-pulled.json`, `current-baseline.json`, `baseline-container.json`, and
  final `deployment.json` with fresh source/config/image/container evidence.
  Repeated capture never silently changes an anchored baseline. Fresh final
  source/config/container/pin checks run even on resume.
- **prepare**: fresh checks current baseline runtime, source/config and original
  pin, writes only the derived override, verifies full resolved config equals
  **original baseline plus exact listed changes**, including all unrelated
  services/top-level fields. Preparation does not recreate the container. A
  failed post-write check may leave the prepared source; don't run external up.
- **pull**: rechecks source/config, baseline running runtime and pin; runs only
  `pull meeting-helper-bot`. Fresh image inspect enforces the image contract;
  saves `pulled-image.json` ID and `pulled-contract.json` privately. The completed
  pull isn't repeated on a retry; a changed resulting tag is rejected.
- **activate**: fresh prepared config/pin/tag/image/runtime validation; only
  `up -d --no-deps --force-recreate --pull never meeting-helper-bot`. Fresh final
  full config and actual runtime checks include new mount and 45-second timeout.
  Running is **not application-ready**; public output explicitly says so.
- **rollback**: rechecks actual known runtime and whole currently resolved source
  before writing. It derives the original exact source plus temporary override
  pinning **the original full image ID**, validates full config, runs the same
  single-service up with `--pull never`, verifies original runtime/no mounts,
  then verifies original local source reference and restores the exact entire
  original source/config. No second up is needed. If original source tag drifted,
  the old container is restored but source remains pinned; safe code
  `old_container_restored_source_stays_pinned_tag_drift` requires parent review,
  never a latest pull. It never restores or runs the previous one-shot image.
- **status**: fixed names, validated image ID, running boolean only; not health.
- **verify**: fixed `logs --no-color --tail 100 meeting-helper-bot`, stored wholly
  privately in a fresh observation job. Public output only boolean startup/ready
  markers and numeric counts of two fixed login/config error markers. No lines,
  usernames, speech, arbitrary error text, or captured matched strings leave the
  private journal. Marker presence may be historical or spoofed by arbitrary log
  content; absent markers can mean tail truncation. `application_ready_verified`
  is always false. The parent must independently establish Discord connectivity,
  correct channel/consent behavior, voice/session readiness, and sustained health
  without exposing private content. No public health endpoint is added.

## Recovery and cross-journal safety

**Use only `oracle-meeting-deploy.py` on a meeting journal, never the one-shot
helper.** The original `snapshot.json`/`original-file.json` names are retained for
old guard recognition, not to permit old phase semantics on a new journal.
Every new deployment needs a fresh journal; no completed activation/rollback job
is reused to deploy again. Prepare/pull are blocked after activation begins;
activation/prepare are blocked after rollback begins. Rollback can also recover
an interrupted preparation before activation.

The unchanged old guard scans all helper journals before mutations. To preserve
compatibility, new pull/activate/rollback actions use its existing durable phase
names `pull-test`, `activate-test`, `rollback-up` respectively; the copied
`pin-rollback` is already terminal. No mutation gets an unscanned new job name.
The new CLI maps actions to old guard names, so an error such as
`pending_mutation_resume_activate_test_same_backup` means **repeat `activate`
with the new CLI, same meeting journal, and authorization**, not old activate-test.
An old journal's unfinished phase must instead be resumed by the original helper
on that old journal. The guards see conflicts in **both directions**.

A deadline/interruption never cancels the remote operation. Submitted jobs resume
saved filename/poll position and aren't duplicated. Pending/failed/ambiguous jobs
block conflicting mutations before even setFile, including from other journals.
`ambiguous_submission_do_not_retry` means the request was durably recorded but
submission outcome is unknown; do not delete intents or resubmit. Terminal remote
exceptions, nonzero exit statuses, or `*** ERROR` markers remain blocked for manual
reconciliation. Never delete/move/edit journals to bypass a guard.

Partial read-only capture is resumed explicitly (the prior journal must match):

```sh
python3 -B scripts/oracle-meeting-deploy.py resume-snapshot --backup-dir "$BACKUP" --previous-backup-dir "$PREVIOUS"
```

Repeat a timed-out mutation with the same action/journal/image (prepare only) and
perhaps a longer deadline. Retain every original/previous/new private journal,
image and both data volumes for operator-directed recovery and retention policy.

## Fake-only checks

```sh
python3 -B -m unittest discover -s tools/oracle-admin-test -p 'test*.py' -v
```

Tests synthesize the prior successful one-shot journal through its original fake
client, then fake every live API. They cover strict images/authorization, source
and resolved/runtime drift, unrelated fields, exact volume/command/env/stop grace,
ARM64 image contract/tag drift, original rollback, immutable/private evidence,
snapshot and job interruption/resume, ambiguous submission, both-direction
cross-journal guards, no duplicate up/pull, and public output redaction.
