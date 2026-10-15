# Deliberate Oracle transcription administration

`scripts/oracle-transcription-admin.py` is a stdlib-only, **parent/operator-run**
utility, not an unattended deployment agent. The implementation worker used only
fakes and public upstream source: no production credentials, hosts, OMV RPCs,
Discord logins, deployment, or image pulls were accessed/performed.
`scripts/omv-bot.py` is imported without its CLI and remains unchanged.

## Fixed scope and safety boundary

- Stack UUID: `d5e4c8ad-09c6-4a9b-8f8f-473355d75d76`.
- Only service `meeting-helper-bot`, existing container `Oracle`.
- Only test image reference accepted:
  `ghcr.io/kkolyno/wormhole_discord_bot:oracle-test-<full lowercase 40-hex SHA>`.
- Every live mutation needs `--authorize-live-change`, including preparation and
  rollback pinning. This is a deliberate confirmation, not an authorization system.
- There is no raw shell, RPC, command, URL, service, container, or credential-value
  argument. No exec, general restart/stop, socket mount, driver change, privileged
  workload, duplicate bot service, registry login, or main/latest pull is exposed.
- One operator, one test/rollback per journal. A Unix `fcntl.flock` per-stack lock
  serializes helper CLI processes on this checkout; a competing CLI fails before
  login/RPCs. Durable mutation intents across **all helper-owned journals** under
  `.private/` also block conflicting phases after a timeout/process exit. This does
  not coordinate external OMV/Docker operations, other checkouts, or other hosts.
  Do not edit the stack externally between phases or move/delete journals/locks.
- The production credential file is **only** `<repository>/.private/omv.json`.
  Only the parent/operator may use the real file. Never pass passwords/tokens as
  arguments, paste snapshots into chat, or enable HTTP/request tracing.
- Always run `python3 -B` to avoid import caches. The utility also disables Python
  bytecode writes before loading the read-only OMV helper. It never calls that
  helper's `compose()`/CLI; its own fixed RPC calls supply explicit parameters.

## Private evidence and public output

Every action requires `--backup-dir`, a **direct child** of repository `.private/`.
For `snapshot`, it must not exist; for later phases it must already exist.
`.private/` is ignored by this repository's existing `.gitignore`.

The utility creates directories as `0700` and records as `0600`; existing private
paths must have those exact modes, be owned by the operator, and not be symlinks.
It never silently chmods an existing directory or replaces an existing record.
Records are fsynced, then published using an atomic no-overwrite hard link on the
same filesystem. Use a local filesystem supporting hard links and directory fsync.
This is protection against accidental disclosure/overwrite, not a sandbox against
other processes with the same UID/root or malicious concurrent filesystem changes.

Private records include the **full original getFile response** (`body`, `env`,
`override`, metadata), resolved config, raw container/image inspect (including
credentials), original image ID/RepoDigests, fixed RPC requests, background status
filenames, polling positions/output, and phase outcomes. Treat **every file** in a
journal as sensitive, even requests/status files. `snapshot.json` has schema `1`;
previous parent-created snapshots are not assumed compatible. Create a new journal;
do not overwrite, convert, or combine an old backup.

Public output is a single allowlisted JSON summary. It does not print raw config,
environment, inspect, server responses, background filenames, arbitrary status
text, exception messages, or traceback. Failures return code `1` with a fixed safe
error code. Raw details needed for diagnosis remain private. Do not copy them into
public logs. Status exposes only fixed service/container names, validated image ID,
and a boolean running flag; it is **not** an application-health assertion.

## Supported stack shape (fail closed)

The reviewed `getFile` schema has exactly:
`uuid, name, description, body, showenv, env, showoverride, override`, with string
fields and boolean `showenv`/`showoverride`. Unknown/missing fields or other types
block before writing a stack. This deliberately does not guess at deployed OMV
versions; the parent may inspect **field names/types only** if it is blocked.

The target must resolve to container name `Oracle`, a single service instance,
without build/profiles/extends. Its supported resolved service keys are only
`image, container_name, environment, command, entrypoint, user, working_dir,
restart, volumes, networks`. Other runtime declarations require explicit review.
The running container's Compose service/project labels must match at snapshot time.

Snapshot compares the **complete effective environment** (image defaults plus all
resolved Compose declarations) with the running container, rejecting missing,
changed, or unexpected keys without printing names/values. Image-inherited base
environment, `USER nodejs`, command `node index.js`, and the image entrypoint are
accepted when they match. Command/entrypoint must be resolved arrays or null, not
shell strings; user/working directory must be strings. Command, entrypoint, user,
working directory, restart policy, and the single default-network attachment must
match the effective configuration. An explicit non-null entrypoint discards the
image's default command, as Compose specifies. Only an ordinary default network
with a resolved name and optionally an empty normalized `ipam: {}` is supported;
custom network schemas or
retry-count restart syntax fail closed. **No existing target mounts** (including
image-declared volumes, binds, or tmpfs) are supported. The test volume is added
only in the prepared override and mounted by activation.

Snapshot performs fresh final config/container/source-image observations, even on
`resume-snapshot`, and rejects changes against its original observations before
publishing. These are sequential observations, not an atomic production snapshot.
An older schema-1 capture must also satisfy the recorded-runtime checks before
mutation. This is a narrow check of the supported stack settings, not proof that
every Docker/kernel option, application state, or external resource is equivalent.

Production's image source must be the fixed repository, its `:latest`, or its full `@sha256:` digest, with the local source
reference resolving to the running full image ID. Other original tag shapes need
an explicit implementation review, not a looser/raw command flag.

Snapshot/status are read-only and can capture an existing override. Preparation
and automated rollback require the original override to be empty/whitespace.
**An existing override, even a comments-only override, is a blocker for mutation.**
A nonempty Compose entrypoint can be captured/compared read-only but still blocks
test preparation, preserving the reviewed boot-command boundary.
The original source YAML is never parsed or rewritten. Preparation sends the full
captured object to `Compose.setFile`, changing **only its override string** to a
YAML-comment-prefixed JSON document (the comment prevents OMV from coercing the
string to an object before schema validation)
(valid Compose YAML). It preserves the original body, env, metadata, and booleans.
It does not append YAML documents or attempt an unsafe hand-written YAML merge.

The test override contains only:

- target image and command
  `node tools/oracle-test/boot.js --authorized-live-oracle-test`;
- `DATA_DIR=/data/oracle-test` (exact allowlist in `tools/oracle-test/config.js`);
- one named-volume mount at `/data`, with explicit volume name
  `oracle-transcription-data` (not an anonymous or accidental project-prefixed name).

An existing `DATA_DIR`, target mount, or reserved volume declaration
(including another volume key with the same explicit name) blocks preparation.
All other services, environment values (including alerts destination), and source
fields stay unchanged. Before any pull/up, freshly resolved
config must equal the original except for these allowlisted changes. Mount order
or Compose normalization differences outside the supported empty/default mount
options block; they are not silently accepted. No stop-grace setting is changed,
and the helper does not add `init: true`; the parent feature image supplies tini as
PID 1. The parent must independently verify the supervisor's 8-second drain plus
bounded process-group teardown (at most 2 seconds), and account for runtime/host
scheduling overhead within the original stop grace. This is not an extensive
production durability or shutdown guarantee. If a longer grace is needed, stop
and extend the bounded override/check with reviewed tests rather than slipping an
unverified change through.

## Parent/operator prerequisites

1. Independently review the intended full commit/image build and boot/test code.
   A SHA-shaped registry tag is an identifier, **not cryptographic immutability**.
   The utility records the pulled local full ID and rejects a changed local test
   tag before activation, but does not attest registry contents or run/sign images.
2. Confirm the feature image actually contains the boot/test code, required local
   recognition binaries/models, and a writable `/data` for its non-root user.
   The utility does not build images, change image users, chown mounts, or install
   dependencies. A new named volume's ownership depends on the image/runtime.
3. Independently verify the boot opt-in scope: existing authorized production guild,
   voice channel, bot application, and existing alerts destination only. The
   utility preserves all original values and cannot validate Discord health.
4. Confirm the deployed OMV plugin supports the reviewed RPC contract and Compose
   flags. No live version/schema/flag compatibility has been tested by the worker.
5. Keep the full old image and rollback tag locally. Do not prune images/volumes,
   retag latest, pull main/latest, or operate another bot with the same token.
   Private source backups alone cannot recover a deleted old image offline.
6. Confirm the globally named `oracle-transcription-data` volume is not already
   used by another stack/unrelated data. The utility checks this stack's declared
   volumes, not all Docker volumes. It intentionally never erases a prior one-shot
   marker or deletes the volume; any preexisting contents require parent review.

## Named phases (examples for the parent, NOT executed by the worker)

Run from the repository root. Choose a fresh private directory and the actual
reviewed full test-image SHA; the variables below contain only public metadata.
Do not execute these examples until the prerequisites and live change are approved.

```sh
umask 077
BACKUP="$PWD/.private/oracle-transcription-UNIQUE-OPERATOR-RUN"
TEST_IMAGE='ghcr.io/kkolyno/wormhole_discord_bot:oracle-test-REPLACE_WITH_FULL_40_HEX_SHA'

python3 -B scripts/oracle-transcription-admin.py snapshot --backup-dir "$BACKUP"
python3 -B scripts/oracle-transcription-admin.py status --backup-dir "$BACKUP"
python3 -B scripts/oracle-transcription-admin.py pin-rollback --backup-dir "$BACKUP" --authorize-live-change
python3 -B scripts/oracle-transcription-admin.py prepare-test --backup-dir "$BACKUP" --image "$TEST_IMAGE" --authorize-live-change
python3 -B scripts/oracle-transcription-admin.py pull-test --backup-dir "$BACKUP" --authorize-live-change
python3 -B scripts/oracle-transcription-admin.py activate-test --backup-dir "$BACKUP" --authorize-live-change

# Later, after independent observation, or to restore the original image:
python3 -B scripts/oracle-transcription-admin.py rollback --backup-dir "$BACKUP" --authorize-live-change
python3 -B scripts/oracle-transcription-admin.py status --backup-dir "$BACKUP"
```

- `snapshot`: records original source/resolved config, running Oracle inspect,
  old-image inspect (including RepoDigests), and local source-reference inspect.
  Verifies source did not change while capturing. Does not mutate the service.
- `pin-rollback`: tags the captured **full image ID**, not a movable source tag,
  as `oracle-rollback:before-transcription-<UTC timestamp>-<random suffix>` using
  `Compose.doTag`. It verifies the resulting full ID. The suffix makes collision
  unlikely; Docker tags are not intrinsically immutable/no-clobber. Treat the tag
  as operator-reserved; every later mutation re-verifies it. The full saved ID is
  authoritative. A completed tag job is not repeated on retry.
- `prepare-test`: verifies baseline/config/container/pin, writes the controlled
  override, then verifies freshly resolved config. **No container recreation**.
  A failed post-write verification may leave the prepared source in place; do not
  run external generic `up`. Use reviewed rollback/recovery instead.
- `pull-test`: verifies the prepared source/config, old running Oracle, and pin;
  invokes only `pull meeting-helper-bot`, records/inspects the resulting local ID.
  It cannot pull other services or main/latest.
- `activate-test`: re-verifies source/config/pin/local image ID, then only
  `up -d --no-deps --force-recreate --pull never meeting-helper-bot`. This recreates
  the existing Oracle, not a duplicate service. It verifies its image/running flag.
  Boot handles one-shot test execution and resumes the image's legacy index after
  the child ends. **That is not a rollback to the old image.** The durable volume
  marker is not erased or rearmed by this utility; a later test needs review.
- `rollback`: first installs a temporary override pinning the original service to
  the saved old full image ID, with all original source/env otherwise intact. It
  verifies resolved config, runs the same single-service `up ... --pull never`,
  and verifies old ID/running state. Only then, after confirming the original local
  image reference still points to the old ID, restores the **entire exact original
  getFile object** and verifies the original resolved config. No second up/pull is
  run. If original latest/reference drifted, old Oracle is still restored, but the
  source stays pinned and the safe error is
  `old_container_restored_source_stays_pinned_tag_drift`. Parent review is required;
  never "fix" this by pulling latest. The new volume is not deleted.

## Deadlines, errors, and recovery limits

Each background job stores intent before submission, returned filename, every
poll response/position and raw output, and completion, all privately/no-overwrite.
`Exec.getOutput` handles OMV background exceptions; accumulated `*** ERROR` markers
and any supplied nonzero `exitStatus`/`exitstatus` are rejected. There is no general
remote exit-status RPC here. Upstream Compose reports nonzero `doCommand` exit
through the marker; the utility does not assume a made-up status field exists.
Terminal output is drained (`running=false`, `pendingOutput=false`) before success.

Default polling deadline: 120 seconds; `--deadline-seconds 1..600` can be specified
per invocation. An in-flight HTTP call has the imported helper's 20-second timeout,
so wall-clock time may exceed the polling deadline by a call. A local deadline or
process interruption does **not** cancel the remote operation. The local lock alone
cannot make rollback safe after the polling process exits: the durable guard scans
all helper-owned direct-child backup directories before **every mutation**.

A pending submitted pin/pull/activation/rollback command blocks other phases with
`pending_mutation_resume_<phase>_same_backup` (hyphens become underscores). For
example, stalled activation makes rollback return
`pending_mutation_resume_activate_test_same_backup` **before any setFile/up**.
Resume `activate-test` in its original backup, with live-change authorization and
optionally a longer deadline; its stored job is reconciled to terminal before new
phase work. Only then retry rollback. A different/new backup cannot bypass this.
The guard deliberately does not auto-cancel or auto-rollback an in-flight job.
`stack_locked_retry_after_other_cli_exits` means another local helper still holds
the lock; wait for its exit, then follow the pending-job/resume result.

For `background_deadline_resume_same_phase`, repeat the **same** phase with the same
journal/image and authorization, optionally a longer deadline. Submitted mutations
resume the saved filename/position instead of being submitted again. A partial
initial snapshot uses the explicit read-only `resume-snapshot` action on the same
directory, not `snapshot` (which refuses to overwrite it). Fresh observational
inspect/config jobs may be reissued; old filenames/progress are still retained.

If submission failed/crashed after durable intent but before saving the returned
filename, the utility reports `ambiguous_submission_do_not_retry`. It cannot know
whether the mutation was accepted and refuses blind resubmission. Such a mutation
intent blocks **all** conflicting mutations across backups, including rollback.
A terminal failed job also remains fail-closed: replay of its saved terminal poll
fails without resubmission; manual operator reconciliation is required. Parent
must independently reconcile actual state, using private evidence. There is no
CLI force/unlock/clear-ambiguity command. Do not delete journal records or rename
backup directories to bypass this guard. OMV removes terminal background status during
`getOutput`; a crash between terminal response and local persistence may also need
manual reconciliation. This is not an exactly-once distributed transaction.
Synchronous setFile retry is reconciled by fresh exact getFile comparison; an
unknown third-party source change blocks instead of being overwritten.

Unknown schemas, nonempty overrides, unsafe permissions, local/source drift,
failed/nonzero commands, or missing prerequisite records all stop the phase.
Unexpected exceptions expose only `operation_failed_details_suppressed`.
No success summary promises application readiness, delivery of notices, recognition
quality, automatic eventual rollback, or recovery from a host failure.

## Public upstream evidence and offline verification

Reviewed public source (upstream `master`, **not proof of the deployed version**):

- [Compose RPC](https://github.com/OpenMediaVault-Plugin-Developers/openmediavault-compose/blob/master/usr/share/openmediavault/engined/rpc/compose.inc):
  `getFile` / `setFile`, `doDockerCmd`, `doDockerImageCmd`, `doTag`, `doCommand`;
  `doCommand` consumes `command` and `command2` and embeds `*** ERROR #... ***`.
- [File model](https://github.com/OpenMediaVault-Plugin-Developers/openmediavault-compose/blob/master/usr/share/openmediavault/datamodels/conf.service.compose.file.json)
  and [RPC schema](https://github.com/OpenMediaVault-Plugin-Developers/openmediavault-compose/blob/master/usr/share/openmediavault/datamodels/rpc.compose.json).
- [OMV Exec RPC](https://github.com/openmediavault/openmediavault/blob/master/deb/openmediavault/usr/share/openmediavault/engined/rpc/exec.inc):
  `getOutput` returns filename/running/output/pos/pendingOutput, raises background
  errors, and deletes terminal status. There is no documented exit code in that
  response; no invented `Exec.getStatus` call is used.

Fake-only checks run through the supplied development container (no real API):

```sh
docker exec -w /ws cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4 \
  python3 -B -m unittest discover -s tools/oracle-admin-test -v
docker exec -w /ws cd6db7666af27e18b39eaf12dcb3b95961ea743b681974b438f83ce61a4abce4 \
  python3 -B scripts/oracle-transcription-admin.py --help
```

Corrective verification results: **38 fake tests passed** (including empty default
IPAM normalization and the OMV JSON-string wire guard; final rerun `Ran 38 tests in
5.296s`, `OK`); CLI `--help` exited **0** and displayed only the bounded arguments.
Both commands ran in the container above. CLI help does not load credentials or
log in. No live deployment/API verification or production snapshot was performed.

Tests inject a rejecting fake RPC client; they never load the credential file,
import/run the real OMV helper, contact the network/Discord, or run Docker actions.
They cover full lifecycle, exact source rollback, old-ID restoration despite latest
source drift, authorization and image/command allowlists, permissions/no-overwrite,
private raw evidence/public sanitized summaries, missing prerequisites/schema
blockers, disallowed source/config/tag changes, and background retry/error handling.
They also cover submitted/ambiguous activation versus rollback, cross-backup guards,
a real competing CLI subprocess lock, inherited image defaults, unapplied runtime
environment/command/user/entrypoint/mounts/restart settings, unexpected environment,
unsupported Compose forms, and fresh final observations on snapshot resume.
