#!/usr/bin/env python3
"""Deliberate, bounded Oracle transcription administration. Run with python3 -B.

No raw shell/RPC interface. Raw Compose, environment and inspect data stay private.
See ORACLE-TEST-OPERATIONS.md before use. Importing this module does not log in.
"""
import argparse
import copy
import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
STACK_UUID = "d5e4c8ad-09c6-4a9b-8f8f-473355d75d76"
SERVICE = "meeting-helper-bot"
CONTAINER = "Oracle"
REPOSITORY = "ghcr.io/kkolyno/wormhole_discord_bot"
VOLUME = "oracle-transcription-data"
DATA_DIR = "/data/oracle-test"  # tools/oracle-test/config.js's exact allowlisted path.
BOOT = ["node", "tools/oracle-test/boot.js", "--authorized-live-oracle-test"]
# OMV coerces JSON-shaped request values into structured data before string
# validation. A YAML comment keeps this field text; the following JSON is YAML.
OVERRIDE_COMMENT = "# Oracle controlled override: retain as YAML text in OMV RPC.\n"
IMAGE_RE = re.compile(re.escape(REPOSITORY) + r":oracle-test-[0-9a-f]{40}\Z")
ID_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
ACTIONS = ("snapshot", "resume-snapshot", "status", "pin-rollback", "prepare-test", "pull-test",
           "activate-test", "rollback")
MUTATIONS = set(ACTIONS) - {"snapshot", "resume-snapshot", "status"}
FILE_FIELDS = {"uuid", "name", "description", "body", "showenv", "env",
               "showoverride", "override"}
UP = "up -d --no-deps --force-recreate --pull never " + SERVICE
COMMANDS = {"config": "config --format json", "pull": "pull " + SERVICE, "up": UP}
MUTATION_PHASES = {"pin-rollback": "pin-rollback", "pull-test": "pull-test",
                   "activate-test": "activate-test", "rollback-up": "rollback"}


class Blocked(Exception):
    """Only fixed, non-sensitive codes may cross the public error boundary."""


def require(condition, code):
    if not condition:
        raise Blocked(code)


def image_id(value):
    require(isinstance(value, str) and ID_RE.fullmatch(value), "unknown_image_id")
    return value


def test_image(value):
    require(isinstance(value, str) and IMAGE_RE.fullmatch(value), "invalid_test_image")
    return value


def decode_document(text, expected_type):
    # showcmd and Compose warnings may precede JSON; never print either.
    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\[{]", text):
        try:
            value, end = decoder.raw_decode(text[match.start():])
        except ValueError:
            continue
        if isinstance(value, expected_type) and not text[match.start() + end:].strip():
            return value
    raise Blocked("unrecognized_private_output")


class PrivateStore:
    """No symlinks, exact private modes, atomic no-overwrite immutable records."""

    def __init__(self, path, create=False):
        private = ROOT / ".private"
        require(path is not None, "backup_dir_required")
        path = Path(os.path.abspath(path))
        require(path.parent == private and path.name not in {"", ".", ".."},
                "backup_must_be_direct_private_child")
        if not private.exists():
            require(create, "private_directory_missing")
            private.mkdir(mode=0o700)
        self.check(private, 0o700, directory=True)
        if create:
            path.mkdir(mode=0o700)  # Deliberately fails if a backup already exists.
        self.check(path, 0o700, directory=True)
        self.path = path

    @staticmethod
    def check(path, mode, directory=False):
        info = path.lstat()
        require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
                and stat.S_IMODE(info.st_mode) == mode and info.st_uid == os.getuid(),
                "unsafe_private_permissions_or_owner")

    def has(self, name):
        require(re.fullmatch(r"[a-z0-9.-]+", name), "invalid_private_record")
        target = self.path / name
        if target.is_symlink():
            raise Blocked("unsafe_private_permissions_or_owner")
        return target.exists()

    def get(self, name):
        require(self.has(name), "required_private_record_missing")
        target = self.path / name
        self.check(target, 0o600)
        return json.loads(target.read_text())

    def put(self, name, value):
        require(not self.has(name), "private_record_already_exists")
        temporary = self.path / ("tmp-" + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(value, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            # Hard link is an atomic no-replace publication on this filesystem.
            os.link(temporary, self.path / name)
            directory = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)


class StackLock:
    """One local process per stack; durable job intents guard after lock release."""

    def __enter__(self):
        private = ROOT / ".private"
        private.mkdir(mode=0o700, exist_ok=True)
        PrivateStore.check(private, 0o700, directory=True)
        path = private / ("oracle-stack-" + STACK_UUID + ".lock")
        self.fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            PrivateStore.check(path, 0o600)
            require(os.fstat(self.fd).st_ino == path.lstat().st_ino, "unsafe_stack_lock")
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Blocked("stack_locked_retry_after_other_cli_exits") from None
        except Exception:
            os.close(self.fd)
            raise
        return self

    def __exit__(self, *_):
        os.close(self.fd)


class Admin:
    def __init__(self, client, store=None, deadline=120):
        self.client, self.store, self.deadline = client, store, deadline

    def guard_mutations(self, action):
        """Scan all helper journals, not just the requested backup. Never cancel jobs.

        A conflicting phase must be resumed by the operator in its original backup.
        Ambiguous/failed jobs intentionally need manual reconciliation, not a retry.
        The CLI holds StackLock throughout this scan and all subsequent RPCs.
        """
        for path in (ROOT / ".private").iterdir():
            if not path.is_dir():
                continue
            # Immutable snapshot/original-file records and fixed mutation intents
            # identify helper-owned backups, including partial older captures.
            if not any((path / name).exists() for name in
                       ["snapshot.json", "original-file.json"] +
                       [name + ".request.json" for name in MUTATION_PHASES]):
                continue
            journal = PrivateStore(path)
            for record in path.glob("*.request.json"):
                request = journal.get(record.name)
                method, params = request.get("method"), request.get("params", {})
                if not (method == "doTag" or (method == "doCommand" and
                        params.get("command") in {COMMANDS["pull"], UP})):
                    continue
                name = record.name.removesuffix(".request.json")
                if journal.has(name + ".done.json"):
                    continue
                require(journal.has(name + ".submitted.json"),
                        "ambiguous_submission_do_not_retry")
                phase = MUTATION_PHASES.get(name)
                require(phase is not None, "pending_mutation_manual_reconciliation_required")
                require(journal.path == self.store.path and action == phase,
                        "pending_mutation_resume_" + phase.replace("-", "_") + "_same_backup")
                # Reconcile before any new phase work, including setFile. job() uses
                # the durable filename/position and cannot resubmit this request.
                self.job(name, method, params)

    def rpc(self, service, method, params):
        # All callers below use literal service/methods and bounded parameters.
        return self.client.rpc(service, method, params)

    def job(self, name, method, params):
        """Resume only our stored fixed jobs; never accept a filename from argv.

        OMV getOutput throws on background exceptions and deletes terminal state.
        Compose doCommand additionally embeds *** ERROR for nonzero exit status.
        """
        store = self.store
        done = name + ".done.json"
        request = {"method": method, "params": params}
        if store.has(done):
            require(store.get(name + ".request.json") == request, "job_request_changed")
            return store.get(done)["output"]
        request_name = name + ".request.json"
        submitted = name + ".submitted.json"
        if store.has(request_name):
            require(store.get(request_name) == request, "job_request_changed")
            require(store.has(submitted), "ambiguous_submission_do_not_retry")
            filename = store.get(submitted)["filename"]
        else:
            store.put(request_name, request)  # Intent is durable BEFORE submission.
            filename = self.rpc("Compose", method, params)
            require(isinstance(filename, str) and filename and len(filename) < 4096,
                    "unknown_background_filename")
            store.put(submitted, {"filename": filename})
        position, chunks, number = 0, [], 0
        while store.has(f"{name}.poll-{number:06d}.json"):
            result = store.get(f"{name}.poll-{number:06d}.json")
            position = result["pos"]
            chunks.append(result["output"])
            number += 1
            if not result["running"] and not result["pendingOutput"]:
                return self.finish_job(done, chunks, result)
        end = time.monotonic() + self.deadline
        while time.monotonic() < end:
            result = self.rpc("Exec", "getOutput", {"filename": filename, "pos": position})
            require(isinstance(result, dict) and isinstance(result.get("output"), str)
                    and type(result.get("pos")) is int and result["pos"] >= position
                    and type(result.get("running")) is bool
                    and type(result.get("pendingOutput")) is bool,
                    "unknown_background_status")
            store.put(f"{name}.poll-{number:06d}.json", result)
            number += 1
            position = result["pos"]
            chunks.append(result["output"])
            if not result["running"] and not result["pendingOutput"]:
                return self.finish_job(done, chunks, result)
            time.sleep(0.25)
        raise Blocked("background_deadline_resume_same_phase")

    def finish_job(self, done, chunks, status):
        output = "".join(chunks)
        require("*** ERROR" not in output and not status.get("error")
                and status.get("exitStatus", 0) == 0 and status.get("exitstatus", 0) == 0,
                "background_command_failed")
        self.store.put(done, {"output": output})
        return output

    def compose(self, name, operation):
        require(operation in COMMANDS, "command_not_allowed")
        return self.job(name, "doCommand", {
            "uuid": STACK_UUID, "command": COMMANDS[operation], "command2": ""})

    def inspect(self, name, reference=None):
        if reference is None:
            text = self.job(name, "doDockerCmd", {"cmd": "inspect", "cmd2": "", "id": CONTAINER})
        else:
            require(ID_RE.fullmatch(reference) or IMAGE_RE.fullmatch(reference)
                    or re.fullmatch(r"oracle-rollback:before-transcription-[0-9a-f-]+", reference)
                    or reference in {REPOSITORY, REPOSITORY + ":latest"}
                    or re.fullmatch(re.escape(REPOSITORY) + r"@sha256:[0-9a-f]{64}", reference),
                    "image_reference_not_allowed")
            text = self.job(name, "doDockerImageCmd", {"command": "inspect", "id": reference})
        result = decode_document(text, list)
        require(len(result) == 1 and isinstance(result[0], dict), "unknown_inspect_shape")
        return result[0]

    def fresh_inspect(self, prefix, reference=None):
        # Fresh observations must not reuse a historical completed inspect job.
        return self.inspect(prefix + "-" + uuid.uuid4().hex, reference)

    def get_file(self):
        result = self.rpc("Compose", "getFile", {"uuid": STACK_UUID})
        require(isinstance(result, dict) and set(result) == FILE_FIELDS
                and result["uuid"] == STACK_UUID
                and all(isinstance(result[k], str) for k in FILE_FIELDS - {"showenv", "showoverride"})
                and all(type(result[k]) is bool for k in {"showenv", "showoverride"}),
                "unknown_stack_file_schema")
        return result

    def fresh_config(self, prefix):
        return decode_document(self.compose(prefix + "-" + uuid.uuid4().hex, "config"), dict)

    @staticmethod
    def container_ok(container, expected_id=None):
        labels = container.get("Config", {}).get("Labels", {})
        require(container.get("Name") == "/" + CONTAINER
                and labels.get("com.docker.compose.service") == SERVICE,
                "unexpected_oracle_container")
        found = image_id(container.get("Image"))
        if expected_id:
            require(found == expected_id, "oracle_image_changed")
        return found

    @staticmethod
    def validate_config(config):
        services = config.get("services")
        require(isinstance(services, dict) and isinstance(services.get(SERVICE), dict),
                "unknown_resolved_stack_shape")
        service = services[SERVICE]
        require(service.get("container_name") == CONTAINER and "build" not in service
                and not service.get("profiles") and not service.get("extends")
                and service.get("scale", 1) == 1
                and service.get("deploy", {}).get("replicas", 1) == 1,
                "unsupported_target_service")
        return service

    @staticmethod
    def runtime_equivalent(config, container, image):
        """Narrow original-stack contract, not a generalized Compose interpreter."""
        service = Admin.validate_config(config)
        require(set(service) <= {"image", "container_name", "environment", "command",
                "entrypoint", "user", "working_dir", "restart", "volumes", "networks"},
                "unsupported_target_runtime_schema")
        defaults, actual = image.get("Config"), container.get("Config")
        host = container.get("HostConfig")
        require(isinstance(defaults, dict) and isinstance(actual, dict)
                and isinstance(host, dict), "unknown_runtime_inspect_schema")

        def environment(values):
            require(isinstance(values, list), "unsupported_runtime_environment_schema")
            result = {}
            for value in values:
                require(isinstance(value, str) and "=" in value,
                        "unsupported_runtime_environment_schema")
                key, val = value.split("=", 1)
                require(key and key not in result, "unsupported_runtime_environment_schema")
                result[key] = val
            return result

        declared = service.get("environment", {})
        require(isinstance(declared, dict) and all(isinstance(k, str) and k
                and isinstance(v, str) for k, v in declared.items()),
                "unsupported_compose_environment_schema")
        expected_env = environment(defaults.get("Env"))
        expected_env.update(declared)
        require(environment(actual.get("Env")) == expected_env, "runtime_environment_mismatch")
        for field, key in (("Entrypoint", "entrypoint"), ("Cmd", "command")):
            baseline = defaults.get(field)
            expected = service.get(key)
            if expected is None:
                # Compose ignores image CMD when entrypoint is explicitly non-null.
                expected = [] if key == "command" and service.get("entrypoint") is not None else baseline
            require((baseline is None or isinstance(baseline, list)
                     and all(isinstance(v, str) for v in baseline))
                    and (expected is None or isinstance(expected, list)
                         and all(isinstance(v, str) for v in expected))
                    and (actual.get(field) is None or isinstance(actual[field], list)),
                    "unsupported_runtime_process_schema")
            require((actual.get(field) or []) == (expected or []),
                    "runtime_" + key + "_mismatch")
        for field, key in (("User", "user"), ("WorkingDir", "working_dir")):
            declared_value = service.get(key, "")
            require(isinstance(declared_value, str), "unsupported_runtime_process_schema")
            expected = declared_value or defaults.get(field)
            require(isinstance(expected, str) and isinstance(actual.get(field), str),
                    "unsupported_runtime_process_schema")
            require(actual[field] == expected, "runtime_" + key + "_mismatch")
        require(not service.get("volumes") and container.get("Mounts") == []
                and not defaults.get("Volumes") and not host.get("Binds")
                and not host.get("Mounts") and not host.get("Tmpfs"),
                "existing_mounts_require_manual_plan")
        restart = service.get("restart", "no")
        require(restart in {"no", "always", "unless-stopped", "on-failure"},
                "unsupported_restart_policy")
        require(host.get("RestartPolicy") == {"Name": restart, "MaximumRetryCount": 0},
                "runtime_restart_mismatch")
        networks = service.get("networks", {"default": None})
        require(networks == {"default": None} or networks == {"default": {}},
                "unsupported_target_network_schema")
        definition = config.get("networks", {}).get("default")
        require(isinstance(definition, dict) and "name" in definition
                and set(definition) <= {"name", "ipam"}
                and definition.get("ipam", {}) == {},
                "unsupported_target_network_schema")
        network = definition["name"]
        require(isinstance(network, str) and network, "unsupported_target_network_schema")
        require(host.get("NetworkMode") == network
                and set(container.get("NetworkSettings", {}).get("Networks", {})) == {network},
                "runtime_network_mismatch")

    def snapshot(self):
        require(not self.store.has("snapshot.json"), "snapshot_already_complete")
        if self.store.has("original-file.json"):
            original = self.store.get("original-file.json")
        else:
            original = self.get_file()
            self.store.put("original-file.json", original)
        config = decode_document(self.compose("snapshot-config", "config"), dict)
        service = self.validate_config(config)
        container = self.inspect("snapshot-container")
        old_id = self.container_ok(container)
        require(isinstance(config.get("name"), str) and config["name"]
                and container.get("Config", {}).get("Labels", {}).get("com.docker.compose.project")
                == config["name"], "unexpected_compose_project")
        require(container.get("State", {}).get("Running") is True, "oracle_not_running")
        require(service.get("image") in {REPOSITORY, REPOSITORY + ":latest"}
                or (isinstance(service.get("image"), str) and re.fullmatch(
                    re.escape(REPOSITORY) + r"@sha256:[0-9a-f]{64}", service["image"])),
                "unexpected_production_image_reference")
        old_image = self.inspect("snapshot-image", old_id)
        require(image_id(old_image.get("Id")) == old_id, "old_image_mismatch")
        # Check that the source's current local reference really is the running image.
        local = self.inspect("snapshot-source-image", service["image"])
        require(image_id(local.get("Id")) == old_id, "source_image_not_running_image")
        self.runtime_equivalent(config, container, old_image)
        # A resumed snapshot may have cached successful observations from before an
        # interruption. Reobserve everything mutable before publishing the baseline.
        require(self.get_file() == original, "stack_source_changed")
        require(self.fresh_config("snapshot-final-config") == config, "resolved_baseline_changed")
        final_container = self.fresh_inspect("snapshot-final-container")
        self.container_ok(final_container, old_id)
        require(final_container.get("State", {}).get("Running") is True, "oracle_not_running")
        require(final_container.get("Config", {}).get("Labels", {}).get("com.docker.compose.project")
                == config["name"], "unexpected_compose_project")
        self.runtime_equivalent(config, final_container, old_image)
        require(image_id(self.fresh_inspect("snapshot-final-source", service["image"]).get("Id"))
                == old_id, "source_image_not_running_image")
        require(self.get_file() == original, "stack_source_changed")
        snapshot = {"schema": 1, "file": original, "config": config, "container": final_container,
                    "old_image": old_image, "old_id": old_id,
                    "rollback_tag": "oracle-rollback:before-transcription-" +
                    datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S%f") +
                    "-" + uuid.uuid4().hex}
        self.store.put("snapshot.json", snapshot)
        return {"snapshot_saved": True, "old_image_id": old_id}

    def saved(self):
        snapshot = self.store.get("snapshot.json")
        require(snapshot.get("schema") == 1, "unknown_snapshot_schema")
        image_id(snapshot.get("old_id"))
        self.validate_config(snapshot["config"])
        # Older schema-1 captures are usable only if their recorded runtime also
        # satisfies the now-reviewed contract; an old journal is not a bypass.
        self.runtime_equivalent(snapshot["config"], snapshot["container"], snapshot["old_image"])
        return snapshot

    def status(self):
        container = self.fresh_inspect("status")
        found = self.container_ok(container)
        return {"container": CONTAINER, "service": SERVICE, "image_id": found,
                "running": container.get("State", {}).get("Running") is True}

    def pin_rollback(self):
        saved = self.saved()
        require(self.get_file() == saved["file"], "stack_source_changed")
        self.container_ok(self.fresh_inspect("pin-current"), saved["old_id"])
        self.job("pin-rollback", "doTag", {"srcid": saved["old_id"], "srcimg": "", "srctag": "",
            "tgtimg": "oracle-rollback", "tgttag": saved["rollback_tag"].split(":", 1)[1]})
        self.verify_pin(saved)
        return {"rollback_image_pinned": True, "old_image_id": saved["old_id"]}

    def verify_pin(self, saved):
        require(self.store.has("pin-rollback.done.json"), "pin_rollback_first")
        pinned = self.fresh_inspect("verify-pin", saved["rollback_tag"])
        require(image_id(pinned.get("Id")) == saved["old_id"], "rollback_tag_changed")

    def set_file(self, desired, allowed):
        current = self.get_file()
        if current == desired:
            return  # Also recovers a lost synchronous setFile response safely.
        require(current in allowed, "stack_source_changed")
        # A fresh getFile on retry determines whether submission applied; no raw retry.
        result = self.rpc("Compose", "setFile", copy.deepcopy(desired))
        require(result == desired and self.get_file() == desired, "setfile_verification_failed")

    @staticmethod
    def make_test_file(saved, image):
        require(not saved["file"]["override"].strip(), "nonempty_override_requires_manual_plan")
        config = saved["config"]
        service = Admin.validate_config(config)
        require(not service.get("entrypoint"), "custom_entrypoint_requires_manual_plan")
        require(VOLUME not in config.get("volumes", {})
                and all(isinstance(v, dict) and v.get("name") != VOLUME
                        for v in config.get("volumes", {}).values()), "data_volume_already_declared")
        require(isinstance(service.get("environment", {}), dict)
                and "DATA_DIR" not in service.get("environment", {}), "existing_data_dir_requires_manual_plan")
        require(isinstance(service.get("volumes", []), list)
                and all(isinstance(v, dict) and isinstance(v.get("target"), str)
                        and v["target"] not in {"/", "/data"}
                        and not v["target"].startswith("/data/")
                        for v in service.get("volumes", [])), "existing_data_mount_requires_manual_plan")
        desired = copy.deepcopy(saved["file"])
        desired["override"] = OVERRIDE_COMMENT + json.dumps({"services": {SERVICE: {
            "image": test_image(image), "command": BOOT, "environment": {"DATA_DIR": DATA_DIR},
            "volumes": [{"type": "volume", "source": VOLUME, "target": "/data"}]}},
            "volumes": {VOLUME: {"name": VOLUME}}}, sort_keys=True)
        return desired

    @staticmethod
    def verify_test_config(saved, config, image):
        expected = copy.deepcopy(saved["config"])
        original = Admin.validate_config(expected)
        actual = Admin.validate_config(config)
        require(actual.get("image") == image and actual.get("command") == BOOT,
                "test_image_or_command_not_resolved")
        original["image"], original["command"] = image, BOOT
        original.setdefault("environment", {})["DATA_DIR"] = DATA_DIR
        mounts = copy.deepcopy(actual.get("volumes", []))
        additions = [v for v in mounts if v.get("target") == "/data"]
        require(len(additions) == 1, "data_mount_not_resolved")
        mount = additions[0]
        require(mount.get("type") == "volume" and mount.get("source") == VOLUME
                and set(mount) <= {"type", "source", "target", "volume", "read_only"}
                and mount.get("volume", {}) == {} and mount.get("read_only", False) is False,
                "unexpected_data_mount_options")
        mounts.remove(mount)
        require(mounts == original.get("volumes", []), "existing_mounts_changed")
        original["volumes"] = actual["volumes"]
        expected.setdefault("volumes", {})[VOLUME] = {"name": VOLUME}
        require(config == expected, "resolved_config_changed_outside_allowlist")

    def prepared(self):
        data = self.store.get("prepared-file.json")
        test_image(data["image"])
        require(self.get_file() == data["file"], "stack_source_changed")
        self.verify_test_config(self.saved(), self.fresh_config("check-test"), data["image"])
        return data

    def prepare_test(self, image):
        image = test_image(image)
        saved = self.saved()
        self.verify_pin(saved)
        self.container_ok(self.fresh_inspect("prepare-current"), saved["old_id"])
        desired = self.make_test_file(saved, image)
        if self.store.has("prepared-file.json"):
            require(self.store.get("prepared-file.json") == {"file": desired, "image": image},
                    "prepared_image_cannot_change")
        else:
            self.store.put("prepared-file.json", {"file": desired, "image": image})
        if self.get_file() == saved["file"]:
            require(self.fresh_config("prepare-baseline") == saved["config"],
                    "resolved_baseline_changed")
        self.set_file(desired, [saved["file"]])
        self.prepared()
        return {"test_source_prepared": True, "container_recreated": False}

    def pull_test(self):
        saved, prepared = self.saved(), self.prepared()
        self.verify_pin(saved)
        self.container_ok(self.fresh_inspect("pull-current"), saved["old_id"])
        self.compose("pull-test", "pull")
        pulled = image_id(self.fresh_inspect("pulled-image", prepared["image"]).get("Id"))
        if self.store.has("pulled-image.json"):
            require(self.store.get("pulled-image.json")["id"] == pulled, "test_tag_changed")
        else:
            self.store.put("pulled-image.json", {"id": pulled})
        return {"test_image_pulled": True, "image_id": pulled}

    def activate_test(self):
        saved, prepared = self.saved(), self.prepared()
        self.verify_pin(saved)
        pulled = image_id(self.store.get("pulled-image.json")["id"])
        require(image_id(self.fresh_inspect("activate-image", prepared["image"]).get("Id")) == pulled,
                "test_tag_changed")
        current = self.container_ok(self.fresh_inspect("activate-current"))
        require(current in {saved["old_id"], pulled}, "oracle_image_changed")
        self.compose("activate-test", "up")
        container = self.fresh_inspect("activated-container")
        self.container_ok(container, pulled)
        require(container.get("State", {}).get("Running") is True, "test_container_not_running")
        return {"test_container_running": True, "image_id": pulled}

    def rollback(self):
        saved = self.saved()
        self.verify_pin(saved)
        require(not saved["file"]["override"].strip(), "nonempty_override_requires_manual_plan")
        pinned = copy.deepcopy(saved["file"])
        pinned["override"] = OVERRIDE_COMMENT + json.dumps({"services": {SERVICE: {"image": saved["old_id"]}}}, sort_keys=True)
        allowed = [saved["file"], pinned]
        if self.store.has("prepared-file.json"):
            allowed.append(self.store.get("prepared-file.json")["file"])
        self.set_file(pinned, allowed)
        expected = copy.deepcopy(saved["config"])
        expected["services"][SERVICE]["image"] = saved["old_id"]
        require(self.fresh_config("rollback-config") == expected, "rollback_resolved_config_changed")
        self.compose("rollback-up", "up")
        container = self.fresh_inspect("rollback-container")
        self.container_ok(container, saved["old_id"])
        require(container.get("State", {}).get("Running") is True, "rollback_container_not_running")
        # Never restore an unpinned source reference if the local tag has drifted.
        original_image = saved["config"]["services"][SERVICE]["image"]
        require(image_id(self.fresh_inspect("rollback-source-image", original_image).get("Id"))
                == saved["old_id"], "old_container_restored_source_stays_pinned_tag_drift")
        self.set_file(saved["file"], [pinned])
        require(self.fresh_config("rollback-original-config") == saved["config"],
                "original_config_not_restored")
        return {"old_container_running": True, "original_source_restored": True,
                "image_id": saved["old_id"]}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise Blocked("invalid_arguments")


def load_client():
    # No username/password/URL CLI flags. Never import the helper's CLI entrypoint.
    spec = importlib.util.spec_from_file_location("oracle_readonly_omv", ROOT / "scripts/omv-bot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    credentials = json.loads((ROOT / ".private/omv.json").read_text())
    return module.OMV(credentials)


def main(argv=None, client_factory=load_client):
    parser = SafeParser(description=__doc__)
    parser.add_argument("action", choices=ACTIONS)
    parser.add_argument("--backup-dir", type=Path, required=True,
                        help="Fresh snapshot directory, or existing journal, directly under .private")
    parser.add_argument("--image", help="Only oracle-test- followed by a full lowercase 40-hex commit")
    parser.add_argument("--authorize-live-change", action="store_true")
    parser.add_argument("--deadline-seconds", type=int, default=120, choices=range(1, 601),
                        metavar="1..600")
    args = parser.parse_args(argv)
    require(args.action not in MUTATIONS or args.authorize_live_change,
            "explicit_live_change_authorization_required")
    require((args.action == "prepare-test") == (args.image is not None),
            "image_required_only_for_prepare_test")
    if args.image is not None:
        test_image(args.image)
    # Snapshot creation never overwrites; explicit resume-snapshot reuses a partial journal.
    with StackLock():
        store = PrivateStore(args.backup_dir, create=args.action == "snapshot")
        admin = Admin(client_factory(), store, args.deadline_seconds)
        if args.action in MUTATIONS:
            admin.guard_mutations(args.action)
        if args.action == "prepare-test":
            result = admin.prepare_test(args.image)
        elif args.action == "resume-snapshot":
            result = admin.snapshot()
        else:
            result = getattr(admin, args.action.replace("-", "_"))()
    print(json.dumps({"action": args.action, "ok": True, **result}, sort_keys=True))


def cli(argv=None, client_factory=load_client):
    try:
        main(argv, client_factory)
        return 0
    except Blocked as error:
        print(json.dumps({"ok": False, "code": str(error)}), file=sys.stderr)
    except Exception:
        print(json.dumps({"ok": False, "code": "operation_failed_details_suppressed"}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(cli())
