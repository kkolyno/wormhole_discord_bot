"""Fake-only tests: no helper import, credentials, network, Docker or Discord access."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("oracle_admin", ROOT / "scripts/oracle-transcription-admin.py")
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)
SECRET = "NEVER_PRINT_THIS_DISCORD_TOKEN_OR_ENV"
OLD = "sha256:" + "a" * 64
NEW = "sha256:" + "b" * 64
DRIFT = "sha256:" + "c" * 64
IMAGE = admin.REPOSITORY + ":oracle-test-" + "d" * 40


class FakeOMV:
    """Independent tiny Compose fixture; reject all unrecognized RPCs/parameters."""

    def __init__(self):
        self.calls = []
        self.file = {"uuid": admin.STACK_UUID, "name": "bot-stack", "description": "keep comments",
                     "body": "# original production YAML\nservices:\n  meeting-helper-bot: {}\n",
                     "env": "DISCORD_TOKEN=" + SECRET + "\n", "showenv": False,
                     "showoverride": False, "override": ""}
        self.base_config = {"name": "bot-stack", "services": {
            admin.SERVICE: {"container_name": "Oracle", "image": admin.REPOSITORY + ":latest",
                "restart": "unless-stopped", "environment": {"DISCORD_TOKEN": SECRET,
                "ALERTS_CHANNEL_ID": "unchanged-alerts", "EXTRA_SECRET": SECRET},
                "volumes": [], "networks": {"default": None}},
            "unrelated": {"image": "unrelated:latest", "environment": {"SECRET": SECRET}}},
            "networks": {"default": {"name": "bot-stack_default"}}}
        self.defaults = {"Env": ["PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=22", "YARN_VERSION=1"],
                         "Cmd": ["node", "index.js"], "Entrypoint": ["docker-entrypoint.sh"],
                         "User": "nodejs", "WorkingDir": "/app", "Volumes": None}
        self.runtime_config = copy.deepcopy(self.base_config)
        self.images = {admin.REPOSITORY + ":latest": OLD, admin.REPOSITORY: OLD, OLD: OLD}
        self.running_id = OLD
        self.jobs = {}
        self.running = True
        self.poison_config = False
        self.fail_submit = False
        self.hold_next = False
        self.hold = False
        self.nonzero = False
        self.marker = False

    def config(self):
        result = copy.deepcopy(self.base_config)
        if self.file["override"].strip():
            override = json.loads(self.file["override"].removeprefix(admin.OVERRIDE_COMMENT))
            for name, changes in override.get("services", {}).items():
                for key, value in changes.items():
                    target = result["services"][name]
                    if key == "environment":
                        target.setdefault(key, {}).update(value)
                    elif key == "volumes":
                        target.setdefault(key, []).extend(value)
                    else:
                        target[key] = value
            if "volumes" in override:
                result.setdefault("volumes", {}).update(override["volumes"])
        if self.poison_config:
            result["services"]["unrelated"]["image"] = "unexpected:changed"
        return result

    def container(self):
        service = self.runtime_config["services"][admin.SERVICE]
        config = copy.deepcopy(self.defaults)
        env = dict(value.split("=", 1) for value in config["Env"])
        env.update(service.get("environment", {}))
        config["Env"] = [key + "=" + value for key, value in env.items()]
        for field, key in [("Cmd", "command"), ("Entrypoint", "entrypoint"),
                           ("User", "user"), ("WorkingDir", "working_dir")]:
            if key in service:
                config[field] = service[key]
        config["Labels"] = {"com.docker.compose.project": "bot-stack",
                            "com.docker.compose.service": admin.SERVICE}
        return {"Name": "/Oracle", "Image": self.running_id, "Config": config,
                "Mounts": copy.deepcopy(service.get("volumes", [])),
                "HostConfig": {"RestartPolicy": {"Name": service.get("restart", "no"),
                                                "MaximumRetryCount": 0},
                               "NetworkMode": "bot-stack_default", "Binds": None},
                "NetworkSettings": {"Networks": {"bot-stack_default": {}}},
                "State": {"Running": self.running}, "Secret": SECRET}

    @staticmethod
    @contextlib.contextmanager
    def _json_string_must_not_decode():
        try:
            yield
        except json.JSONDecodeError:
            return
        raise AssertionError("Override would be coerced to structured data by OMV")

    def rpc(self, service, method, params):
        self.calls.append((service, method, copy.deepcopy(params)))
        if (service, method) == ("Compose", "getFile"):
            assert params == {"uuid": admin.STACK_UUID}
            return copy.deepcopy(self.file)
        if (service, method) == ("Compose", "setFile"):
            assert set(params) == admin.FILE_FIELDS
            assert params["uuid"] == admin.STACK_UUID
            # OMV recursively decodes JSON-shaped string fields before schema
            # validation: our YAML comment must prevent override becoming an object.
            if params["override"]:
                assert params["override"].startswith(admin.OVERRIDE_COMMENT)
                with self._json_string_must_not_decode():
                    json.loads(params["override"])
            self.file = copy.deepcopy(params)
            return copy.deepcopy(self.file)
        if (service, method) == ("Exec", "getOutput"):
            assert set(params) == {"filename", "pos"}
            text = self.jobs[params["filename"]]
            if self.hold:
                return {"running": True, "pendingOutput": False, "pos": params["pos"], "output": ""}
            result = {"filename": params["filename"], "running": False, "pendingOutput": False,
                      "pos": len(text), "output": text[params["pos"]:]}
            if self.nonzero:
                result["exitStatus"] = 23
            return result
        assert service == "Compose", (service, method)
        if self.fail_submit:
            raise RuntimeError(SECRET)
        text = ""
        if method == "doCommand":
            assert set(params) == {"uuid", "command", "command2"}
            assert params["uuid"] == admin.STACK_UUID and params["command2"] == ""
            command = params["command"]
            assert command in admin.COMMANDS.values(), command
            if command == "config --format json":
                text = "warning: " + SECRET + "\n" + json.dumps(self.config())
            elif command == "pull " + admin.SERVICE:
                image = self.config()["services"][admin.SERVICE]["image"]
                assert admin.IMAGE_RE.fullmatch(image), "Never pull main/latest or other services"
                self.images[image] = NEW
                self.images[NEW] = NEW
                text = "pulled " + SECRET
            elif command == admin.UP:
                image = self.config()["services"][admin.SERVICE]["image"]
                self.running_id = self.images.get(image, image)
                self.runtime_config = self.config()
                text = "recreated Oracle " + SECRET
        elif method == "doDockerCmd":
            assert params == {"cmd": "inspect", "cmd2": "", "id": "Oracle"}
            text = json.dumps([self.container()])
        elif method == "doDockerImageCmd":
            assert set(params) == {"command", "id"} and params["command"] == "inspect"
            assert params["id"] in self.images
            text = "docker image inspect\n" + json.dumps([{"Id": self.images[params["id"]],
                "RepoDigests": [admin.REPOSITORY + "@sha256:" + "e" * 64],
                "Config": copy.deepcopy(self.defaults)}])
        elif method == "doTag":
            assert set(params) == {"srcid", "srcimg", "srctag", "tgtimg", "tgttag"}
            assert params["srcid"] == OLD and params["srcimg"] == params["srctag"] == ""
            assert params["tgtimg"] == "oracle-rollback"
            assert params["tgttag"].startswith("before-transcription-")
            target = params["tgtimg"] + ":" + params["tgttag"]
            assert target not in self.images, "Do not overwrite a preexisting rollback tag"
            self.images[target] = OLD
            text = SECRET
        else:
            raise AssertionError((service, method, params))
        if self.marker:
            text += "\n*** ERROR #1 ***\n" + SECRET
        filename = "/private/omv-bg-" + str(len(self.jobs))
        self.jobs[filename] = text
        if self.hold_next:
            self.hold, self.hold_next = True, False
        return filename


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = mock.patch.object(admin, "ROOT", self.root)
        self.patch.start()
        self.private = self.root / ".private"
        self.private.mkdir(mode=0o700)
        self.directory = self.private / "capture"
        self.fake = FakeOMV()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def run_cli(self, action, extra=(), expected=0):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = admin.cli([action, "--backup-dir", str(self.directory), *extra], lambda: self.fake)
        self.assertEqual(code, expected, stderr.getvalue())
        self.assertNotIn(SECRET, stdout.getvalue() + stderr.getvalue())
        self.assertNotIn("/private/omv-bg", stdout.getvalue() + stderr.getvalue())
        return json.loads(stdout.getvalue() if code == 0 else stderr.getvalue())

    def snapshot(self):
        self.run_cli("snapshot")
        return admin.Admin(self.fake, admin.PrivateStore(self.directory))

    def pinned(self):
        instance = self.snapshot()
        self.run_cli("pin-rollback", ["--authorize-live-change"])
        return instance

    def prepared(self):
        instance = self.pinned()
        self.run_cli("prepare-test", ["--authorize-live-change", "--image", IMAGE])
        return instance

    def activated(self):
        instance = self.prepared()
        self.run_cli("pull-test", ["--authorize-live-change"])
        self.run_cli("activate-test", ["--authorize-live-change"])
        return instance

    def test_complete_lifecycle_exact_source_and_image_rollback(self):
        original = copy.deepcopy(self.fake.file)
        original_config = copy.deepcopy(self.fake.base_config)
        self.activated()
        self.assertEqual(self.fake.running_id, NEW)
        self.assertEqual(self.fake.file["body"], original["body"])
        self.assertEqual(self.fake.file["env"], original["env"])
        for field in admin.FILE_FIELDS - {"override"}:
            self.assertEqual(self.fake.file[field], original[field])
        self.assertEqual(self.fake.config()["services"]["unrelated"], original_config["services"]["unrelated"])
        self.assertEqual(self.fake.config()["services"][admin.SERVICE]["environment"]["DATA_DIR"], "/data/oracle-test")
        self.run_cli("rollback", ["--authorize-live-change"])
        self.assertEqual(self.fake.running_id, OLD)
        self.assertEqual(self.fake.file, original)
        self.assertEqual(self.fake.config(), original_config)
        ups = [p for s, m, p in self.fake.calls if m == "doCommand" and p["command"] == admin.UP]
        self.assertEqual(len(ups), 2)
        self.assertTrue(all("--pull never" in p["command"] and p["command"].endswith(admin.SERVICE) for p in ups))

    def test_all_mutations_require_authorization_before_client_or_files(self):
        for action in admin.MUTATIONS:
            extra = ["--image", IMAGE] if action == "prepare-test" else []
            result = self.run_cli(action, extra, expected=1)
            self.assertEqual(result["code"], "explicit_live_change_authorization_required")
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.directory.exists())

    def test_image_and_argument_allowlist_before_login(self):
        for image in [admin.REPOSITORY, admin.REPOSITORY + ":latest", IMAGE[:-1],
                      IMAGE + ";whoami", IMAGE.upper(), "evil/repo:oracle-test-" + "d" * 40]:
            result = self.run_cli("prepare-test", ["--authorize-live-change", "--image", image], expected=1)
            self.assertEqual(result["code"], "invalid_test_image")
        for action in ["exec", "shell", "restart", "stop", "rpc", SECRET]:
            result = self.run_cli(action, expected=1)
            self.assertEqual(result["code"], "invalid_arguments")
        self.assertEqual(self.fake.calls, [])

    def test_backup_is_private_atomic_and_no_overwrite(self):
        self.snapshot()
        snapshot = (self.directory / "snapshot.json").read_text()
        self.assertIn(SECRET, snapshot)  # Raw evidence intentionally PRIVATE.
        self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        for path in self.directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertFalse(path.name.startswith("tmp-"))
        store = admin.PrivateStore(self.directory)
        with self.assertRaisesRegex(admin.Blocked, "private_record_already_exists"):
            store.put("snapshot.json", {"bad": True})
        self.run_cli("snapshot", expected=1)
        self.assertEqual((self.directory / "snapshot.json").read_text(), snapshot)

    def test_rejects_unsafe_private_path_modes_and_symlinks(self):
        self.private.chmod(0o755)
        self.run_cli("snapshot", expected=1)
        self.assertEqual(self.fake.calls, [])
        self.private.chmod(0o700)
        other = self.root / "other"
        other.mkdir(mode=0o700)
        self.directory.symlink_to(other, target_is_directory=True)
        self.run_cli("status", expected=1)
        self.assertEqual(self.fake.calls, [])
        self.directory.unlink()
        with self.assertRaisesRegex(admin.Blocked, "backup_must_be_direct_private_child"):
            admin.PrivateStore(other)

    def test_status_is_non_sensitive_allowlist(self):
        self.snapshot()
        value = self.run_cli("status")
        self.assertEqual(set(value), {"action", "ok", "container", "service", "image_id", "running"})
        self.assertEqual(value["image_id"], OLD)
        self.assertTrue(value["running"])

    def test_errors_are_sanitized_and_submission_is_not_repeated(self):
        instance = self.snapshot()
        self.fake.fail_submit = True
        result = self.run_cli("pin-rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "operation_failed_details_suppressed")
        # Error occurs during fresh read-only inspect; separately exercise fixed mutation journal.
        with self.assertRaises(RuntimeError):
            instance.job("submission-test", "doTag", {"fixed": True})
        calls = len(self.fake.calls)
        with self.assertRaisesRegex(admin.Blocked, "ambiguous_submission_do_not_retry"):
            instance.job("submission-test", "doTag", {"fixed": True})
        self.assertEqual(len(self.fake.calls), calls)

    def test_background_deadline_resumes_filename_without_resubmission(self):
        instance = self.snapshot()
        self.fake.hold_next = True
        instance.deadline = 0.005
        with mock.patch.object(admin.time, "sleep", lambda _: None):
            with self.assertRaisesRegex(admin.Blocked, "background_deadline_resume_same_phase"):
                instance.compose("resume-test", "config")
        submits = len([c for c in self.fake.calls if c[1] == "doCommand"])
        submitted = instance.store.get("resume-test.submitted.json")
        self.assertIn("filename", submitted)
        self.fake.hold = False
        instance.deadline = 1
        result = instance.compose("resume-test", "config")
        self.assertIn(SECRET, result)
        self.assertEqual(len([c for c in self.fake.calls if c[1] == "doCommand"]), submits)
        self.assertEqual(instance.compose("resume-test", "config"), result)

    def test_explicit_resume_snapshot(self):
        self.fake.hold_next = True
        with mock.patch.object(admin.time, "monotonic", side_effect=[0, 0, 10]), \
             mock.patch.object(admin.time, "sleep", lambda _: None):
            self.run_cli("snapshot", ["--deadline-seconds", "1"], expected=1)
        self.fake.hold = False
        self.run_cli("resume-snapshot")
        self.assertTrue((self.directory / "snapshot.json").exists())

    def test_failed_exit_status_or_compose_error_marker_blocks(self):
        for mode in ["nonzero", "marker"]:
            with self.subTest(mode=mode):
                instance = self.snapshot() if not self.directory.exists() else admin.Admin(
                    self.fake, admin.PrivateStore(self.directory))
                setattr(self.fake, mode, True)
                with self.assertRaisesRegex(admin.Blocked, "background_command_failed"):
                    instance.compose("failure-" + mode, "config")
                setattr(self.fake, mode, False)
                self.assertFalse(instance.store.has("failure-" + mode + ".done.json"))

    def test_unknown_schema_and_nonempty_override_refused(self):
        self.fake.file["unknown_private_field"] = SECRET
        result = self.run_cli("snapshot", expected=1)
        self.assertEqual(result["code"], "unknown_stack_file_schema")
        self.assertFalse(any(c[1] == "setFile" for c in self.fake.calls))

    def test_existing_override_data_dir_or_mount_refused_before_setfile(self):
        saved = {"file": copy.deepcopy(self.fake.file), "config": copy.deepcopy(self.fake.base_config)}
        for field in ["override", "entrypoint", "env", "mount", "nested-mount", "volume", "volume-alias"]:
            value = copy.deepcopy(saved)
            if field == "override":
                value["file"]["override"] = "# unknown existing override\n"
            elif field == "entrypoint":
                value["config"]["services"][admin.SERVICE]["entrypoint"] = ["custom-entrypoint"]
            elif field == "env":
                value["config"]["services"][admin.SERVICE]["environment"]["DATA_DIR"] = "/something"
            elif field in {"mount", "nested-mount"}:
                value["config"]["services"][admin.SERVICE]["volumes"].append({
                    "type": "bind", "source": "/existing",
                    "target": "/data" if field == "mount" else "/data/oracle-test"})
            elif field == "volume-alias":
                value["config"]["volumes"] = {"another-key": {"name": admin.VOLUME}}
            else:
                value["config"]["volumes"] = {admin.VOLUME: {}}
            with self.subTest(field=field), self.assertRaises(admin.Blocked):
                admin.Admin.make_test_file(value, IMAGE)

    def test_resolved_config_drift_blocks_before_prepare_mutation(self):
        self.pinned()
        self.fake.poison_config = True
        result = self.run_cli("prepare-test", ["--authorize-live-change", "--image", IMAGE], expected=1)
        self.assertEqual(result["code"], "resolved_baseline_changed")
        self.assertFalse(any(c[1] == "setFile" for c in self.fake.calls))

    def test_change_outside_target_service_blocks_pull(self):
        self.prepared()
        self.fake.poison_config = True
        result = self.run_cli("pull-test", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "resolved_config_changed_outside_allowlist")
        self.assertFalse(any(c[1] == "doCommand" and c[2]["command"].startswith("pull") for c in self.fake.calls))

    def test_changed_test_tag_blocks_activation(self):
        self.prepared()
        self.run_cli("pull-test", ["--authorize-live-change"])
        self.fake.images[IMAGE] = DRIFT
        result = self.run_cli("activate-test", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "test_tag_changed")
        self.assertEqual(self.fake.running_id, OLD)

    def test_rollback_restores_old_id_but_keeps_pinned_source_if_latest_drifted(self):
        self.activated()
        self.fake.images[admin.REPOSITORY + ":latest"] = DRIFT
        result = self.run_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "old_container_restored_source_stays_pinned_tag_drift")
        self.assertEqual(self.fake.running_id, OLD)
        self.assertEqual(json.loads(self.fake.file["override"].removeprefix(
            admin.OVERRIDE_COMMENT))["services"][admin.SERVICE]["image"], OLD)

    def test_changed_rollback_tag_or_source_refuses_mutation(self):
        instance = self.pinned()
        saved = instance.saved()
        self.fake.images[saved["rollback_tag"]] = DRIFT
        result = self.run_cli("prepare-test", ["--authorize-live-change", "--image", IMAGE], expected=1)
        self.assertEqual(result["code"], "rollback_tag_changed")
        self.assertFalse(any(c[1] == "setFile" for c in self.fake.calls))
        self.fake.images[saved["rollback_tag"]] = OLD
        self.fake.file["env"] += "EXTERNAL_CHANGE=true\n"
        result = self.run_cli("prepare-test", ["--authorize-live-change", "--image", IMAGE], expected=1)
        self.assertEqual(result["code"], "stack_source_changed")

    def test_no_pull_or_activate_without_prerequisites(self):
        self.snapshot()
        self.run_cli("pull-test", ["--authorize-live-change"], expected=1)
        self.run_cli("activate-test", ["--authorize-live-change"], expected=1)
        self.assertFalse(any(c[1] == "doCommand" and c[2]["command"] != "config --format json"
                             for c in self.fake.calls))

    def test_nonempty_override_blocks_prepare_and_rollback_without_stack_write(self):
        self.fake.file["override"] = "{}"
        self.pinned()
        result = self.run_cli("prepare-test", ["--authorize-live-change", "--image", IMAGE], expected=1)
        self.assertEqual(result["code"], "nonempty_override_requires_manual_plan")
        result = self.run_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "nonempty_override_requires_manual_plan")
        self.assertFalse(any(c[1] == "setFile" for c in self.fake.calls))

    def test_wrong_project_blocks_snapshot_and_keeps_original_evidence(self):
        self.fake.base_config["name"] = "other-project"
        result = self.run_cli("snapshot", expected=1)
        self.assertEqual(result["code"], "unexpected_compose_project")
        self.fake.base_config["name"] = "bot-stack"
        # Resume correctly reuses its original observation and refuses; never recapture
        # a baseline by replacing private evidence underneath a partial snapshot.
        result = self.run_cli("resume-snapshot", expected=1)
        self.assertEqual(result["code"], "unexpected_compose_project")
        self.assertFalse(any(c[1] == "setFile" for c in self.fake.calls))

    def test_terminal_pending_output_is_drained_before_success(self):
        instance = self.snapshot()
        real_rpc = self.fake.rpc
        polls = iter([
            {"running": False, "pendingOutput": True, "pos": 4, "output": "part"},
            {"running": False, "pendingOutput": False, "pos": 8, "output": "done"},
        ])
        positions = []
        def rpc(service, method, params):
            if (service, method) == ("Exec", "getOutput"):
                positions.append(params["pos"])
                return next(polls)
            return real_rpc(service, method, params)
        with mock.patch.object(self.fake, "rpc", side_effect=rpc), \
             mock.patch.object(admin.time, "sleep", lambda _: None):
            self.assertEqual(instance.compose("drain-test", "config"), "partdone")
        self.assertEqual(positions, [0, 4])
        self.assertTrue(instance.store.has("drain-test.poll-000001.json"))

    def test_changed_config_after_setfile_is_not_activated(self):
        self.pinned()
        real_rpc = self.fake.rpc
        def rpc(service, method, params):
            result = real_rpc(service, method, params)
            if method == "setFile":
                self.fake.poison_config = True
            return result
        with mock.patch.object(self.fake, "rpc", side_effect=rpc):
            result = self.run_cli("prepare-test", ["--authorize-live-change", "--image", IMAGE], expected=1)
        self.assertEqual(result["code"], "resolved_config_changed_outside_allowlist")
        self.assertTrue(self.fake.file["override"])
        self.assertEqual(self.fake.running_id, OLD)
        self.assertFalse(any(c[1] == "doCommand" and c[2]["command"] != "config --format json"
                             for c in self.fake.calls))

    def test_build_service_is_unsupported_even_with_empty_build_object(self):
        self.fake.base_config["services"][admin.SERVICE]["build"] = {}
        result = self.run_cli("snapshot", expected=1)
        self.assertEqual(result["code"], "unsupported_target_service")

    def stalled_activation(self):
        instance = self.prepared()
        self.run_cli("pull-test", ["--authorize-live-change"])
        self.fake.hold_next = True
        instance.deadline = 0.005
        with mock.patch.object(admin.time, "sleep", lambda _: None):
            with self.assertRaisesRegex(admin.Blocked, "background_deadline_resume_same_phase"):
                instance.compose("activate-test", "up")
        return instance

    def test_stalled_activation_blocks_rollback_until_explicit_resume_terminal(self):
        self.stalled_activation()
        count = len(self.fake.calls)
        result = self.run_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "pending_mutation_resume_activate_test_same_backup")
        self.assertEqual(len(self.fake.calls), count)  # No setFile, up, or even fresh reads.
        self.fake.hold = False
        self.run_cli("activate-test", ["--authorize-live-change"])
        ups = [c for c in self.fake.calls if c[1] == "doCommand" and c[2]["command"] == admin.UP]
        self.assertEqual(len(ups), 1)  # Existing submitted activation, not a second up.
        self.run_cli("rollback", ["--authorize-live-change"])
        self.assertEqual(self.fake.running_id, OLD)

    def test_other_backup_cannot_bypass_pending_activation(self):
        instance = self.stalled_activation()
        other = self.private / "other-capture"
        other_store = admin.PrivateStore(other, create=True)
        other_store.put("snapshot.json", instance.saved())
        original_directory = self.directory
        self.directory = other
        count = len(self.fake.calls)
        result = self.run_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "pending_mutation_resume_activate_test_same_backup")
        self.assertEqual(len(self.fake.calls), count)
        self.directory = original_directory

    def test_ambiguous_activation_submission_blocks_rollback_across_backups(self):
        instance = self.prepared()
        self.run_cli("pull-test", ["--authorize-live-change"])
        self.fake.fail_submit = True
        with self.assertRaises(RuntimeError):
            instance.compose("activate-test", "up")
        self.fake.fail_submit = False
        count = len(self.fake.calls)
        result = self.run_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "ambiguous_submission_do_not_retry")
        self.assertEqual(len(self.fake.calls), count)
        other = admin.PrivateStore(self.private / "another", create=True)
        other.put("snapshot.json", instance.saved())
        self.directory = other.path
        result = self.run_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "ambiguous_submission_do_not_retry")
        self.assertEqual(len(self.fake.calls), count)

    def test_competing_cli_process_cannot_acquire_stack_lock(self):
        self.snapshot()
        # Child uses only the fake-root lock path and cannot load a client: locking
        # must fail before credential loading, backup creation or any RPC.
        script = ("import importlib.util, pathlib; "
                  f"s=importlib.util.spec_from_file_location('a', {str(ROOT / 'scripts/oracle-transcription-admin.py')!r}); "
                  "a=importlib.util.module_from_spec(s); s.loader.exec_module(a); "
                  f"a.ROOT=pathlib.Path({str(self.root)!r}); "
                  f"raise SystemExit(a.cli(['status','--backup-dir',{str(self.directory)!r}]))")
        with admin.StackLock():
            result = subprocess.run([sys.executable, "-B", "-c", script],
                                    capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr)["code"], "stack_locked_retry_after_other_cli_exits")
        self.assertEqual(result.stdout, "")
        self.run_cli("status")  # Process exit releases the lock.

    def test_named_mutation_phases_do_not_resubmit_when_repeated(self):
        self.snapshot()
        phases = [("pin-rollback", []), ("prepare-test", ["--image", IMAGE]),
                  ("pull-test", []), ("activate-test", []), ("rollback", [])]
        for phase, extra in phases:
            with self.subTest(phase=phase):
                self.run_cli(phase, ["--authorize-live-change", *extra])
                before = len([c for c in self.fake.calls if c[1] in {"setFile", "doTag"}
                              or c[1] == "doCommand" and c[2]["command"] != admin.COMMANDS["config"]])
                self.run_cli(phase, ["--authorize-live-change", *extra])
                after = len([c for c in self.fake.calls if c[1] in {"setFile", "doTag"}
                             or c[1] == "doCommand" and c[2]["command"] != admin.COMMANDS["config"]])
                # Rollback may reapply/restore its temporary exact-ID override,
                # but never submits up twice. Other phases make no new mutations.
                self.assertEqual(after - before, 2 if phase == "rollback" else 0)
        self.assertEqual(len([c for c in self.fake.calls if c[1] == "doCommand"
                              and c[2]["command"] == admin.UP]), 2)

    def test_failed_activation_terminal_output_keeps_rollback_blocked(self):
        instance = self.prepared()
        self.run_cli("pull-test", ["--authorize-live-change"])
        self.fake.marker = True
        with self.assertRaisesRegex(admin.Blocked, "background_command_failed"):
            instance.compose("activate-test", "up")
        self.fake.marker = False
        count = len(self.fake.calls)
        result = self.run_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "pending_mutation_resume_activate_test_same_backup")
        self.assertEqual(len(self.fake.calls), count)
        result = self.run_cli("activate-test", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "background_command_failed")
        self.assertEqual(len(self.fake.calls), count)

    def test_old_snapshot_recorded_runtime_mismatch_cannot_bypass_validation(self):
        saved = {"schema": 1, "old_id": OLD, "config": self.fake.config(),
                 "container": self.fake.container(), "old_image": {"Config": self.fake.defaults}}
        saved["container"]["Config"]["User"] = "root"
        store = admin.PrivateStore(self.directory, create=True)
        store.put("snapshot.json", saved)
        result = self.run_cli("pin-rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(result["code"], "runtime_user_mismatch")
        self.assertEqual(self.fake.calls, [])

    def test_snapshot_accepts_empty_default_ipam_but_rejects_custom_ipam(self):
        self.fake.base_config["networks"]["default"]["ipam"] = {}
        admin.Admin.runtime_equivalent(self.fake.config(), self.fake.container(),
                                      {"Config": self.fake.defaults})
        self.fake.base_config["networks"]["default"]["ipam"] = {"driver": "custom"}
        with self.assertRaisesRegex(admin.Blocked, "unsupported_target_network_schema"):
            admin.Admin.runtime_equivalent(self.fake.config(), self.fake.container(),
                                          {"Config": self.fake.defaults})

    def test_snapshot_accepts_inherited_image_defaults_and_matching_explicit_config(self):
        for key, value in [("command", ["node", "index.js"]),
                           ("entrypoint", ["docker-entrypoint.sh"]), ("user", "nodejs")]:
            self.fake.base_config["services"][admin.SERVICE][key] = value
        self.snapshot()
        saved = admin.PrivateStore(self.directory).get("snapshot.json")
        self.assertEqual(saved["container"]["Config"]["User"], "nodejs")
        self.assertEqual(saved["old_image"]["Config"]["Cmd"], ["node", "index.js"])

    def test_explicit_entrypoint_ignores_default_image_command(self):
        self.fake.base_config["services"][admin.SERVICE]["entrypoint"] = ["custom-entrypoint"]
        self.fake.runtime_config = copy.deepcopy(self.fake.base_config)
        self.fake.runtime_config["services"][admin.SERVICE]["command"] = []
        self.snapshot()

    def test_snapshot_rejects_unapplied_environment_process_and_mount_settings(self):
        cases = [("environment", {"DISCORD_TOKEN": "different-private-value"}, "runtime_environment_mismatch"),
                 ("command", ["node", "other.js"], "runtime_command_mismatch"),
                 ("entrypoint", ["other-entrypoint"], "runtime_entrypoint_mismatch"),
                 ("user", "root", "runtime_user_mismatch"),
                 ("working_dir", "/elsewhere", "runtime_working_dir_mismatch"),
                 ("volumes", [{"type": "bind", "source": "/x", "target": "/x"}],
                  "existing_mounts_require_manual_plan"),
                 ("restart", "always", "runtime_restart_mismatch")]
        original = copy.deepcopy(self.fake.base_config)
        for index, (key, value, code) in enumerate(cases):
            with self.subTest(key=key):
                self.directory = self.private / ("mismatch-" + str(index))
                self.fake.base_config = copy.deepcopy(original)
                self.fake.base_config["services"][admin.SERVICE][key] = value
                result = self.run_cli("snapshot", expected=1)
                self.assertEqual(result["code"], code)
                self.assertFalse((self.directory / "snapshot.json").exists())
        self.assertFalse(any(c[1] == "setFile" for c in self.fake.calls))

    def test_snapshot_rejects_unexpected_container_env_and_mounts(self):
        for index, field in enumerate(["env", "mounts"]):
            self.directory = self.private / ("actual-mismatch-" + str(index))
            original_container = self.fake.container
            def container():
                value = original_container()
                if field == "env":
                    value["Config"]["Env"].append("UNDECLARED=" + SECRET)
                else:
                    value["Mounts"] = [{"Type": "bind", "Source": "/x", "Destination": "/x"}]
                return value
            with mock.patch.object(self.fake, "container", side_effect=container):
                result = self.run_cli("snapshot", expected=1)
            self.assertEqual(result["code"], "runtime_environment_mismatch" if field == "env"
                             else "existing_mounts_require_manual_plan")

    def test_snapshot_rejects_ambiguous_compose_runtime_schema(self):
        for index, (key, value) in enumerate([("command", "node index.js"),
                ("environment", {"DISCORD_TOKEN": None}), ("init", True)]):
            self.directory = self.private / ("unsupported-" + str(index))
            original = copy.deepcopy(self.fake.base_config)
            self.fake.base_config["services"][admin.SERVICE][key] = value
            self.run_cli("snapshot", expected=1)
            self.assertFalse((self.directory / "snapshot.json").exists())
            self.fake.base_config = original

    def test_resumed_snapshot_requires_fresh_final_runtime_config_and_source(self):
        # Stop after the historical baseline observations have been persisted.
        for index, drift in enumerate(["runtime", "config", "source-image", "source-file", "stopped"]):
            with self.subTest(drift=drift):
                self.directory = self.private / ("resume-drift-" + str(index))
                self.fake = FakeOMV()
                with mock.patch.object(admin.Admin, "fresh_config", side_effect=RuntimeError(SECRET)):
                    self.run_cli("snapshot", expected=1)
                if drift == "runtime":
                    self.fake.runtime_config["services"][admin.SERVICE]["command"] = ["node", "drift.js"]
                elif drift == "config":
                    self.fake.poison_config = True
                elif drift == "source-image":
                    self.fake.images[admin.REPOSITORY + ":latest"] = DRIFT
                elif drift == "source-file":
                    self.fake.file["env"] += "DRIFT=true\n"
                else:
                    self.fake.running = False
                self.run_cli("resume-snapshot", expected=1)
                self.assertFalse((self.directory / "snapshot.json").exists())

    def test_public_error_boundary_suppresses_os_and_rpc_details(self):
        with mock.patch.object(admin, "PrivateStore", side_effect=RuntimeError(SECRET)):
            result = self.run_cli("snapshot", expected=1)
            self.assertEqual(result["code"], "operation_failed_details_suppressed")


if __name__ == "__main__":
    unittest.main()
