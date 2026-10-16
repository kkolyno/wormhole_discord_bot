"""Credential-free, fake RPC-only meeting deploy tests; never load the real client."""
import contextlib
import copy
import importlib.util
import io
import itertools
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


meeting = load("meeting_deploy", ROOT / "scripts/oracle-meeting-deploy.py")
fixture = load("meeting_old_fixture", ROOT / "tools/oracle-admin-test/test_admin.py")
SECRET = fixture.SECRET
NEW = "sha256:" + "9" * 64
IMAGE = meeting.REPOSITORY + ":transcription-" + "ea7ebe62ee5c8ba400599ac0888976809dc48b4f"


class FakeOMV(fixture.FakeOMV):
    def __init__(self):
        super().__init__()
        self.new_defaults = copy.deepcopy(self.defaults)
        self.new_defaults.update({"Entrypoint": meeting.ENTRYPOINT, "Cmd": meeting.COMMAND})
        self.new_defaults["Env"].append("LOCAL_TRANSCRIPTION_DATA_DIR=/data/transcription")
        self.architecture = "arm64"
        self.image_user = "nodejs"
        self.runtime_mutator = lambda result: None
        self.hold_command = None
        self.logs = "Starting Wormhole Bot...\nLogged in as " + SECRET + "\nDISCORD_LOGIN_FAILED\n"

    def container(self):
        original = self.defaults
        if self.running_id == NEW:
            self.defaults = self.new_defaults
        try:
            result = super().container()
        finally:
            self.defaults = original
        mounts = self.runtime_config["services"][meeting.SERVICE].get("volumes", [])
        result["Mounts"] = [{"Type": "volume", "Name": m["source"], "Destination": m["target"],
            "Source": "/var/lib/docker/volumes/" + m["source"] + "/_data", "Driver": "local", "RW": True}
            for m in mounts]
        result["HostConfig"]["Mounts"] = [{"Type": "volume", "Source": m["source"],
            "Target": m["target"], "ReadOnly": False, "VolumeOptions": {}} for m in mounts]
        service = self.runtime_config["services"][meeting.SERVICE]
        result["Config"]["StopTimeout"] = 45 if service.get("stop_grace_period") == "45s" else 10
        self.runtime_mutator(result)
        return result

    def submit(self, method, params, text):
        self.calls.append(("Compose", method, copy.deepcopy(params)))
        filename = "/private/omv-bg-" + str(len(self.jobs))
        self.jobs[filename] = text
        if params.get("command") == self.hold_command:
            self.hold = True
        return filename

    def rpc(self, service, method, params):
        if service == "Compose" and method == "doCommand":
            command = params["command"]
            if command == meeting.LOGS:
                assert params == {"uuid": meeting.base.STACK_UUID, "command": meeting.LOGS, "command2": ""}
                return self.submit(method, params, self.logs)
            if command == "pull " + meeting.SERVICE and meeting.IMAGE_RE.fullmatch(
                    self.config()["services"][meeting.SERVICE]["image"]):
                assert params == {"uuid": meeting.base.STACK_UUID, "command": command, "command2": ""}
                self.images[self.config()["services"][meeting.SERVICE]["image"]] = NEW
                self.images[NEW] = NEW
                return self.submit(method, params, SECRET)
            if command == self.hold_command:
                self.hold_next = True
        if service == "Compose" and method == "doDockerImageCmd" and (
                meeting.IMAGE_RE.fullmatch(params["id"]) or params["id"] == NEW):
            assert params == {"command": "inspect", "id": params["id"]}
            defaults = copy.deepcopy(self.new_defaults)
            defaults["User"] = self.image_user
            return self.submit(method, params, json.dumps([{"Id": self.images[params["id"]],
                "Config": defaults, "Architecture": self.architecture, "Os": "linux"}]))
        return super().rpc(service, method, params)


class MeetingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [mock.patch.object(fixture, "OLD", meeting.ORIGINAL_ID),
            mock.patch.object(fixture, "NEW", meeting.ONE_SHOT_ID),
            mock.patch.object(fixture.admin, "ROOT", self.root),
            mock.patch.object(meeting.base, "ROOT", self.root), mock.patch.object(meeting, "ROOT", self.root)]
        for patch in self.patches:
            patch.start()
        self.fake = FakeOMV()
        self.previous = self.root / ".private/previous"
        self.directory = self.root / ".private/meeting"
        self.old_cli("snapshot")
        for action in ["pin-rollback", "prepare-test", "pull-test", "activate-test"]:
            extra = ["--image", fixture.IMAGE] if action == "prepare-test" else []
            self.old_cli(action, ["--authorize-live-change", *extra])
        self.original = copy.deepcopy(self.fake.base_config)
        self.previous_file = copy.deepcopy(self.fake.file)
        self.fake.calls.clear()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def invoke(self, module, args, expected=0):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = module.cli(args, lambda: self.fake)
        output = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(SECRET, output)
        self.assertNotIn("/private/omv-bg", output)
        self.assertEqual(code, expected, output)
        return json.loads(stdout.getvalue() if code == 0 else stderr.getvalue())

    def old_cli(self, action, extra=(), expected=0, directory=None):
        return self.invoke(fixture.admin, [action, "--backup-dir", str(directory or self.previous), *extra], expected)

    def cli(self, action, extra=(), expected=0, directory=None):
        args = [action, "--backup-dir", str(directory or self.directory), *extra]
        if action in {"snapshot", "resume-snapshot"}:
            args += ["--previous-backup-dir", str(self.previous)]
        return self.invoke(meeting, args, expected)

    def snapshot(self):
        self.cli("snapshot")
        return meeting.Admin(self.fake, meeting.PrivateStore(self.directory))

    def prepare(self):
        instance = self.snapshot()
        self.cli("prepare", ["--authorize-live-change", "--image", IMAGE])
        return instance

    def pull(self):
        instance = self.prepare()
        self.cli("pull", ["--authorize-live-change"])
        return instance

    def activate(self):
        instance = self.pull()
        self.cli("activate", ["--authorize-live-change"])
        return instance

    def mutation_calls(self):
        return [(m, p) for s, m, p in self.fake.calls if m == "setFile" or m == "doTag"
                or m == "doCommand" and p["command"] in {meeting.base.UP, "pull " + meeting.SERVICE}]

    def test_lifecycle_preserves_unrelated_and_exact_original_rollback(self):
        instance = self.activate()
        current = self.fake.config()
        self.assertEqual(current["services"]["unrelated"], self.original["services"]["unrelated"])
        service = current["services"][meeting.SERVICE]
        self.assertEqual(service["command"], ["node", "index.js"])
        self.assertEqual(service["stop_grace_period"], "45s")
        self.assertEqual(service["environment"], {**self.original["services"][meeting.SERVICE]["environment"],
                                               **meeting.ENVIRONMENT})
        self.assertEqual(current["volumes"], {meeting.VOLUME: {"name": meeting.VOLUME}})
        self.assertNotIn(meeting.base.VOLUME, json.dumps(current))
        for key in meeting.base.FILE_FIELDS - {"override"}:
            self.assertEqual(self.fake.file[key], instance.saved()["file"][key])
        self.assertEqual(instance.store.get("previous-prepared.json")["file"], self.previous_file)
        self.assertEqual(instance.store.get("snapshot.json")["old_id"], meeting.ORIGINAL_ID)
        self.cli("rollback", ["--authorize-live-change"])
        self.assertEqual(self.fake.file, instance.saved()["file"])
        self.assertEqual(self.fake.config(), self.original)
        self.assertEqual(self.fake.container()["Mounts"], [])
        self.assertEqual(self.fake.running_id, meeting.ORIGINAL_ID)
        self.assertEqual(sum(m == "doCommand" and p["command"] == meeting.base.UP
                             for s, m, p in self.fake.calls), 2)
        # Read-only verification never returns log text or identities.
        hints = self.cli("verify")
        self.assertTrue(hints["startup_marker_seen"])
        self.assertTrue(hints["ready_marker_seen"])
        self.assertEqual(hints["login_error_count"], 1)
        self.assertFalse(hints["application_ready_verified"])

    def test_authorization_and_strict_cli_before_login(self):
        for action in meeting.MUTATIONS:
            extra = ["--image", IMAGE] if action == "prepare" else []
            self.assertEqual(self.cli(action, extra, expected=1)["code"],
                             "explicit_live_change_authorization_required")
        for value in [IMAGE.upper(), IMAGE[:-1], IMAGE + ";" + SECRET,
                      meeting.REPOSITORY + ":latest", fixture.IMAGE, "x/other:transcription-" + "a" * 40]:
            self.assertEqual(self.cli("prepare", ["--authorize-live-change", "--image", value], expected=1)["code"],
                             "invalid_meeting_image")
        for action in ["exec", "rpc", "restart", SECRET]:
            self.assertEqual(self.cli(action, expected=1)["code"], "invalid_arguments")
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.directory.exists())

    def test_private_modes_and_immutable_original_evidence(self):
        self.snapshot()
        for path in [self.directory.parent, self.directory]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for path in self.directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertIn(SECRET, (self.directory / "snapshot.json").read_text())
        self.cli("snapshot", expected=1)
        self.cli("resume-snapshot", expected=1)

    def test_snapshot_rejects_source_and_resolved_drift(self):
        self.fake.file["body"] += "# unreviewed edit\n"
        self.assertEqual(self.cli("snapshot", expected=1)["code"], "stack_source_changed")
        self.assertEqual(self.mutation_calls(), [])
        self.fake.file = copy.deepcopy(self.previous_file)
        self.fake.poison_config = True
        self.assertEqual(self.cli("resume-snapshot", expected=1)["code"],
                         "resolved_config_changed_outside_allowlist")
        self.assertEqual(self.mutation_calls(), [])

    def test_prepare_drift_blocks_before_setfile(self):
        self.snapshot()
        self.fake.poison_config = True
        self.assertEqual(self.cli("prepare", ["--authorize-live-change", "--image", IMAGE], expected=1)["code"],
                         "resolved_baseline_changed")
        self.assertEqual(self.mutation_calls(), [])

    def test_whole_config_allowlist(self):
        instance = self.prepare()
        config = self.fake.config()
        mutations = [lambda c: c["services"]["unrelated"].update(image="evil"),
                     lambda c: c["services"][meeting.SERVICE].update(command=["sh"]),
                     lambda c: c["services"][meeting.SERVICE].update(stop_grace_period="10s"),
                     lambda c: c["services"][meeting.SERVICE]["environment"].update(EXTRA_SECRET="changed"),
                     lambda c: c["services"][meeting.SERVICE]["volumes"][0].update(source=meeting.base.VOLUME),
                     lambda c: c["services"][meeting.SERVICE]["volumes"][0].update(read_only=True)]
        for mutate in mutations:
            altered = copy.deepcopy(config)
            mutate(altered)
            with self.assertRaises(meeting.Blocked):
                instance.verify_config(instance.saved(), altered, IMAGE)

    def test_original_override_cannot_suppress_tini_or_nonroot_identity(self):
        instance = self.snapshot()
        for field, value in [("entrypoint", []), ("entrypoint", ["sh"]), ("user", "root"),
                             ("user", "1001:0"), ("working_dir", "/other")]:
            saved = copy.deepcopy(instance.saved())
            saved["config"]["services"][meeting.SERVICE][field] = value
            with self.assertRaises(meeting.Blocked):
                instance.make_file(saved, IMAGE)
        self.assertEqual(self.mutation_calls(), [])

    def test_actual_runtime_mismatches_snapshot_and_activation(self):
        def alter(field, value):
            return lambda c: c["Config"].update({field: value})
        mutations = [alter("Cmd", ["sh"]), alter("Env", ["DISCORD_TOKEN=" + SECRET]),
                     alter("User", "root"), alter("Entrypoint", ["sh"]),
                     lambda c: c["HostConfig"].update(NetworkMode="other"),
                     lambda c: c["HostConfig"].update(RestartPolicy={"Name": "always", "MaximumRetryCount": 0}),
                     lambda c: c["Mounts"][0].update(Name=meeting.VOLUME),
                     lambda c: c["HostConfig"]["Mounts"][0].update(ReadOnly=True)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.fake.runtime_mutator = mutate
                action = "resume-snapshot" if self.directory.exists() else "snapshot"
                self.cli(action, expected=1)
        self.fake.runtime_mutator = lambda c: None
        self.cli("resume-snapshot")
        self.cli("prepare", ["--authorize-live-change", "--image", IMAGE])
        self.cli("pull", ["--authorize-live-change"])
        self.fake.runtime_mutator = alter("Cmd", ["sh"])
        self.cli("activate", ["--authorize-live-change"], expected=1)
        self.assertFalse(any(p.get("command") == meeting.base.UP for m, p in self.mutation_calls()))

    def test_named_volume_binds_representation_and_rejects_extra_mounts(self):
        instance = self.snapshot()
        baseline = instance.baseline()
        config, image = baseline["config"], baseline["image"]
        container = self.fake.container()
        container["HostConfig"]["Mounts"] = None
        container["HostConfig"]["Binds"] = [meeting.base.VOLUME + ":/data:rw"]
        instance.runtime(config, container, image, meeting.base.VOLUME)
        for binds in [[], [meeting.base.VOLUME + ":/data:ro"], ["/host/path:/data:rw"],
                      [meeting.base.VOLUME + ":/data:rw", "extra:/elsewhere:rw"]]:
            altered = copy.deepcopy(container)
            altered["HostConfig"]["Binds"] = binds
            with self.assertRaises(meeting.Blocked):
                instance.runtime(config, altered, image, meeting.base.VOLUME)
        altered = copy.deepcopy(container)
        altered["HostConfig"]["Mounts"] = self.fake.container()["HostConfig"]["Mounts"]
        with self.assertRaises(meeting.Blocked):
            instance.runtime(config, altered, image, meeting.base.VOLUME)
        altered = copy.deepcopy(container)
        altered["Mounts"][0]["Type"] = "bind"
        with self.assertRaises(meeting.Blocked):
            instance.runtime(config, altered, image, meeting.base.VOLUME)

    def test_pulled_image_contract_and_tag_drift(self):
        self.prepare()
        self.fake.architecture = "amd64"
        self.assertEqual(self.cli("pull", ["--authorize-live-change"], expected=1)["code"],
                         "unexpected_meeting_image_contract")
        self.fake.architecture = "arm64"
        self.cli("pull", ["--authorize-live-change"])
        self.fake.images[IMAGE] = "sha256:" + "8" * 64
        self.assertEqual(self.cli("activate", ["--authorize-live-change"], expected=1)["code"], "meeting_tag_changed")
        self.assertEqual(sum(m == "doCommand" and p["command"] == "pull " + meeting.SERVICE
                             for s, m, p in self.fake.calls), 1)

    def test_image_user_entrypoint_command_and_known_old_ids_rejected(self):
        instance = self.prepare()
        image = {"Id": NEW, "Config": copy.deepcopy(self.fake.new_defaults),
                 "Architecture": "arm64", "Os": "linux"}
        instance.check_image(image)
        for field, value in [("User", "root"), ("Entrypoint", ["sh"]), ("Cmd", ["sh"]),
                             ("Volumes", {"/data": {}})]:
            altered = copy.deepcopy(image)
            altered["Config"][field] = value
            with self.assertRaisesRegex(meeting.Blocked, "unexpected_meeting_image_contract"):
                instance.check_image(altered)
        for identifier in [meeting.ORIGINAL_ID, meeting.ONE_SHOT_ID]:
            altered = copy.deepcopy(image)
            altered["Id"] = identifier
            with self.assertRaisesRegex(meeting.Blocked, "meeting_image_is_old_baseline"):
                instance.check_image(altered)

    def test_snapshot_checks_running_image_and_old_rollback_pin(self):
        self.fake.running_id = NEW
        self.assertEqual(self.cli("snapshot", expected=1)["code"], "oracle_image_changed")
        self.fake.running_id = meeting.ONE_SHOT_ID
        previous = fixture.admin.PrivateStore(self.previous)
        rollback_tag = previous.get("snapshot.json")["rollback_tag"]
        self.fake.images[rollback_tag] = NEW
        self.assertEqual(self.cli("resume-snapshot", expected=1)["code"], "rollback_tag_changed")
        self.assertEqual(self.mutation_calls(), [])

    def test_prepare_lost_setfile_response_recovers_without_duplicate_write(self):
        self.snapshot()
        real_rpc = self.fake.rpc
        def lost(service, method, params):
            result = real_rpc(service, method, params)
            if method == "setFile":
                raise RuntimeError(SECRET)
            return result
        with mock.patch.object(self.fake, "rpc", lost):
            self.cli("prepare", ["--authorize-live-change", "--image", IMAGE], expected=1)
        self.cli("prepare", ["--authorize-live-change", "--image", IMAGE])
        self.assertEqual(sum(m == "setFile" for s, m, p in self.fake.calls), 1)

    def test_rollback_tag_drift_restores_old_runtime_but_keeps_source_pinned(self):
        instance = self.activate()
        source = instance.saved()["config"]["services"][meeting.SERVICE]["image"]
        self.fake.images[source] = NEW
        self.assertEqual(self.cli("rollback", ["--authorize-live-change"], expected=1)["code"],
                         "old_container_restored_source_stays_pinned_tag_drift")
        self.assertEqual(self.fake.running_id, meeting.ORIGINAL_ID)
        self.assertEqual(self.fake.config()["services"][meeting.SERVICE]["image"], meeting.ORIGINAL_ID)
        self.assertEqual(self.fake.container()["Mounts"], [])
        self.fake.images[source] = meeting.ORIGINAL_ID
        self.cli("rollback", ["--authorize-live-change"])
        self.assertEqual(sum(m == "doCommand" and p["command"] == meeting.base.UP
                             for s, m, p in self.fake.calls), 2)
        self.assertEqual(self.fake.file, instance.saved()["file"])

    def test_post_activate_runtime_stop_timeout_is_verified(self):
        self.pull()
        def mutate(container):
            if container["Image"] == NEW:
                container["Config"]["StopTimeout"] = 10
        self.fake.runtime_mutator = mutate
        self.assertEqual(self.cli("activate", ["--authorize-live-change"], expected=1)["code"],
                         "runtime_stop_timeout_mismatch")

    def test_rollback_checks_actual_environment_and_retains_volume(self):
        self.activate()
        self.fake.runtime_mutator = lambda c: c["Config"].update(User="root")
        count = len(self.mutation_calls())
        self.assertEqual(self.cli("rollback", ["--authorize-live-change"], expected=1)["code"], "runtime_user_mismatch")
        self.assertEqual(len(self.mutation_calls()), count)
        self.fake.runtime_mutator = lambda c: None
        self.cli("rollback", ["--authorize-live-change"])
        self.assertFalse(any("volume" in m.lower() for s, m, p in self.fake.calls))
        self.cli("activate", ["--authorize-live-change"], expected=1)
        self.cli("prepare", ["--authorize-live-change", "--image", IMAGE], expected=1)

    def test_snapshot_interruption_fresh_resume_and_no_adaptation(self):
        original_put = meeting.PrivateStore.put
        def interrupt(store, name, value):
            if name == "deployment.json":
                raise RuntimeError(SECRET)
            return original_put(store, name, value)
        with mock.patch.object(meeting.PrivateStore, "put", interrupt):
            self.assertEqual(self.cli("snapshot", expected=1)["code"], "operation_failed_details_suppressed")
        self.fake.file["env"] += "DRIFT=" + SECRET
        self.assertEqual(self.cli("resume-snapshot", expected=1)["code"], "stack_source_changed")
        self.fake.file = copy.deepcopy(self.previous_file)
        self.cli("resume-snapshot")

    def test_interrupted_activation_guard_and_resume_without_duplicate(self):
        self.pull()
        self.fake.hold_command = meeting.base.UP
        counter = itertools.count()
        with mock.patch.object(meeting.base.time, "sleep"), mock.patch.object(
                meeting.base.time, "monotonic", side_effect=lambda: next(counter) / 10):
            result = self.cli("activate", ["--authorize-live-change", "--deadline-seconds", "1"], expected=1)
        self.assertEqual(result["code"], "background_deadline_resume_same_phase")
        count = len(self.mutation_calls())
        self.assertEqual(self.cli("rollback", ["--authorize-live-change"], expected=1)["code"],
                         "pending_mutation_resume_activate_test_same_backup")
        # The unchanged helper sees this new journal and blocks its own rollback.
        self.assertEqual(self.old_cli("rollback", ["--authorize-live-change"], expected=1)["code"],
                         "pending_mutation_resume_activate_test_same_backup")
        # A different valid new journal cannot bypass the cross-journal guard.
        other = self.directory.parent / "other"
        meeting.PrivateStore(other, create=True).put("original-file.json", {})
        self.assertEqual(self.cli("rollback", ["--authorize-live-change"], expected=1, directory=other)["code"],
                         "pending_mutation_resume_activate_test_same_backup")
        self.assertEqual(len(self.mutation_calls()), count)
        self.fake.hold = False
        self.fake.hold_command = None
        self.cli("activate", ["--authorize-live-change"])
        self.cli("activate", ["--authorize-live-change"])
        self.assertEqual(sum(m == "doCommand" and p["command"] == meeting.base.UP
                             for s, m, p in self.fake.calls), 1)

    def test_old_pending_mutation_blocks_new_helper(self):
        self.snapshot()
        previous_store = fixture.admin.PrivateStore(self.previous)
        previous_store.put("rollback-up.request.json", {"method": "doCommand", "params": {
            "uuid": meeting.base.STACK_UUID, "command": meeting.base.UP, "command2": ""}})
        previous_store.put("rollback-up.submitted.json", {"filename": "/private/not-polled"})
        self.assertEqual(self.cli("prepare", ["--authorize-live-change", "--image", IMAGE], expected=1)["code"],
                         "pending_mutation_resume_rollback_same_backup")
        self.assertEqual(self.mutation_calls(), [])

    def test_ambiguous_submission_never_retried(self):
        self.prepare()
        real_rpc = self.fake.rpc
        def fail(service, method, params):
            if method == "doCommand" and params["command"] == "pull " + meeting.SERVICE:
                raise RuntimeError(SECRET)
            return real_rpc(service, method, params)
        with mock.patch.object(self.fake, "rpc", fail):
            self.cli("pull", ["--authorize-live-change"], expected=1)
        self.assertEqual(self.cli("pull", ["--authorize-live-change"], expected=1)["code"],
                         "ambiguous_submission_do_not_retry")


if __name__ == "__main__":
    unittest.main()
