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
IDLE_ID = "sha256:" + "7" * 64
IDLE_IMAGE = meeting.REPOSITORY + ":transcription-" + "6" * 40


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

    def meeting_defaults(self, identifier):
        defaults = copy.deepcopy(self.new_defaults)
        if identifier == IDLE_ID:
            defaults["Env"] += ["LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS=15",
                                "LOCAL_TRANSCRIPTION_IDLE_SECONDS=300"]
        return defaults

    def container(self):
        original = self.defaults
        if self.running_id in {NEW, IDLE_ID}:
            self.defaults = self.meeting_defaults(self.running_id)
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
                tag = self.config()["services"][meeting.SERVICE]["image"]
                identifier = IDLE_ID if tag == IDLE_IMAGE else NEW
                self.images[tag] = identifier
                self.images[identifier] = identifier
                return self.submit(method, params, SECRET)
            if command == self.hold_command:
                self.hold_next = True
        if service == "Compose" and method == "doDockerImageCmd" and (
                meeting.IMAGE_RE.fullmatch(params["id"]) or params["id"] in {NEW, IDLE_ID}):
            assert params == {"command": "inspect", "id": params["id"]}
            defaults = self.meeting_defaults(self.images[params["id"]])
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

    def upgrade_cli(self, action, extra=(), expected=0, directory=None, previous=None):
        args = [action, "--backup-dir", str(directory or self.root / ".private/idle"), *extra]
        if action in {"snapshot-upgrade", "resume-snapshot-upgrade"}:
            args += ["--previous-backup-dir", str(previous or self.directory)]
        return self.invoke(meeting, args, expected)

    def upgrade(self, phase="activate"):
        self.activate()
        self.upgrade_cli("snapshot-upgrade")
        for action in ("prepare", "pull", "activate"):
            extra = ["--image", IDLE_IMAGE] if action == "prepare" else []
            self.upgrade_cli(action, ["--authorize-live-change", *extra])
            if action == phase:
                break
        return meeting.Admin(self.fake, meeting.PrivateStore(self.root / ".private/idle"))

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

    def test_upgrade_full_lifecycle_fresh_jobs_same_volume_and_exact_original(self):
        first = self.activate()
        previous_bytes = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        first_config = copy.deepcopy(self.fake.config())
        first_mount = copy.deepcopy(self.fake.container()["Mounts"])
        count = len(self.mutation_calls())
        self.upgrade_cli("snapshot-upgrade")
        instance = meeting.Admin(self.fake, meeting.PrivateStore(self.root / ".private/idle"))
        self.assertEqual(len(self.mutation_calls()), count)
        self.assertEqual(instance.policy(), meeting.IDLE_POLICY)
        self.assertEqual(instance.baseline()["id"], NEW)
        self.assertEqual(instance.baseline()["config"], first_config)
        self.assertEqual(instance.store.get("snapshot.json"), first.saved())
        self.assertEqual(instance.store.get("previous-meeting.json")["deployment.json"],
                         first.store.get("deployment.json"))
        for name in ("pull-test", "activate-test"):
            self.assertFalse(instance.store.has(name + ".request.json"))
            self.assertFalse(instance.store.has(name + ".done.json"))
        self.upgrade_cli("prepare", ["--authorize-live-change", "--image", IDLE_IMAGE])
        self.assertEqual(self.fake.running_id, NEW)
        self.assertEqual(self.fake.container()["Mounts"], first_mount)
        config = self.fake.config()
        self.assertEqual(config["services"]["unrelated"], self.original["services"]["unrelated"])
        target = config["services"][meeting.SERVICE]
        self.assertEqual(target["environment"], {
            **self.original["services"][meeting.SERVICE]["environment"], **meeting.IDLE_ENVIRONMENT})
        self.assertEqual(target["stop_grace_period"], "45s")
        self.assertEqual(config["volumes"], first_config["volumes"])
        self.assertNotIn(meeting.base.VOLUME, json.dumps(config))
        for field in meeting.base.FILE_FIELDS - {"override"}:
            self.assertEqual(self.fake.file[field], first.saved()["file"][field])
        self.upgrade_cli("pull", ["--authorize-live-change"])
        self.upgrade_cli("pull", ["--authorize-live-change"])
        self.upgrade_cli("activate", ["--authorize-live-change"])
        self.assertEqual(self.fake.running_id, IDLE_ID)
        self.assertEqual(self.fake.container()["Mounts"], first_mount)
        self.assertEqual(self.fake.container()["Config"]["StopTimeout"], 45)
        env = self.fake.container()["Config"]["Env"]
        self.assertIn("LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS=15", env)
        self.assertIn("LOCAL_TRANSCRIPTION_IDLE_SECONDS=300", env)
        self.upgrade_cli("rollback", ["--authorize-live-change"])
        self.assertEqual(self.fake.file, first.saved()["file"])
        self.assertEqual(self.fake.config(), self.original)
        self.assertEqual(self.fake.running_id, meeting.ORIGINAL_ID)
        self.assertEqual(self.fake.container()["Mounts"], [])
        self.assertEqual({p.name: p.read_bytes() for p in self.directory.iterdir()}, previous_bytes)
        self.assertEqual(sum(m == "doCommand" and p["command"] == meeting.base.UP
                             for s, m, p in self.fake.calls), 3)
        self.assertEqual(sum(m == "doCommand" and p["command"] == "pull " + meeting.SERVICE
                             for s, m, p in self.fake.calls), 2)
        self.assertFalse(any("volume" in m.lower() or "exec" in m.lower()
                             for s, m, p in self.fake.calls))

    def test_upgrade_cli_authorization_and_no_raw_flags(self):
        for action in meeting.MUTATIONS:
            extra = ["--image", IDLE_IMAGE] if action == "prepare" else []
            self.assertEqual(self.upgrade_cli(action, extra, expected=1)["code"],
                             "explicit_live_change_authorization_required")
        for args in (["snapshot-upgrade"], ["prepare", "--authorize-live-change", "--image", IDLE_IMAGE,
                                          "--previous-backup-dir", str(self.directory)],
                     ["snapshot-upgrade", "--previous-backup-dir", str(self.directory), "--command", "up"],
                     ["snapshot-upgrade", "--previous-backup-dir", str(self.directory), "--image", IDLE_IMAGE]):
            self.invoke(meeting, [*args, "--backup-dir", str(self.root / ".private/idle")], expected=1)
        self.assertEqual(self.fake.calls, [])

    def test_upgrade_requires_completed_meeting_not_one_shot_or_unknown_schema(self):
        self.upgrade_cli("snapshot-upgrade", previous=self.previous, expected=1)
        self.activate()
        self.upgrade_cli("resume-snapshot-upgrade", previous=self.directory, expected=1)
        # A fresh journal accepts the valid previous meeting, not a reused partial source.
        other = self.root / ".private/valid-idle"
        self.upgrade_cli("snapshot-upgrade", directory=other)
        data = json.loads((self.directory / "deployment.json").read_text())
        data["schema"] = 99
        (self.directory / "deployment.json").write_text(json.dumps(data))
        self.upgrade_cli("snapshot-upgrade", directory=self.root / ".private/invalid-idle", expected=1)
        self.assertFalse((self.root / ".private/invalid-idle/deployment.json").exists())

    def test_upgrade_rejects_prior_incomplete_or_rollback_evidence(self):
        self.activate()
        cases = [("activate-test.done.json", None), ("pull-test.done.json", {"output": "*** ERROR"}),
                 ("activate-test.request.json", {"method": "doCommand", "params": {"command": "up"}}),
                 ("rollback-up.done.json", {"output": ""}),
                 ("pin-rollback.request.json", {"method": "doTag", "params": {"srcid": NEW}}),
                 ("pulled-image.json", {"id": IDLE_ID})]
        for index, (name, replacement) in enumerate(cases):
            with self.subTest(name=name):
                path = self.directory / name
                original = path.read_bytes() if path.exists() else None
                if replacement is None:
                    path.unlink()
                elif original is None:
                    meeting.PrivateStore(self.directory).put(name, replacement)
                else:
                    path.write_text(json.dumps(replacement))
                self.fake.calls.clear()
                self.upgrade_cli("snapshot-upgrade", directory=self.root / f".private/bad-{index}", expected=1)
                self.assertEqual(self.mutation_calls(), [])
                if original is None:
                    path.unlink()
                else:
                    path.write_bytes(original)

    def test_upgrade_snapshot_rejects_source_resolved_env_tag_and_runtime_drift(self):
        self.activate()
        source = copy.deepcopy(self.fake.file)
        mutations = [lambda: self.fake.file.update(env=self.fake.file["env"] + "DRIFT=true\n"),
                     lambda: setattr(self.fake, "poison_config", True),
                     lambda: self.fake.images.update({IMAGE: IDLE_ID}),
                     lambda: setattr(self.fake, "runtime_mutator", lambda c: c["Config"].update(Env=[])),
                     lambda: setattr(self.fake, "runtime_mutator", lambda c: c["Config"].update(StopTimeout=10)),
                     lambda: setattr(self.fake, "runtime_mutator", lambda c: c["Mounts"][0].update(Name="other")),
                     lambda: setattr(self.fake, "runtime_mutator", lambda c: c["HostConfig"].update(Binds=["/host:/data:rw"]))]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                mutate()
                self.fake.calls.clear()
                self.upgrade_cli("snapshot-upgrade", directory=self.root / f".private/drift-{index}", expected=1)
                self.assertEqual(self.mutation_calls(), [])
                self.fake.file = copy.deepcopy(source)
                self.fake.poison_config = False
                self.fake.images[IMAGE] = NEW
                self.fake.runtime_mutator = lambda c: None

    def test_upgrade_snapshot_resume_fresh_and_previous_untouched(self):
        self.activate()
        previous_bytes = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        original_put = meeting.PrivateStore.put
        def interrupt(store, name, value):
            if name == "deployment.json":
                raise RuntimeError(SECRET)
            return original_put(store, name, value)
        with mock.patch.object(meeting.PrivateStore, "put", interrupt):
            self.upgrade_cli("snapshot-upgrade", expected=1)
        self.fake.file["body"] += "# drift\n"
        self.upgrade_cli("resume-snapshot-upgrade", expected=1)
        self.fake.file["body"] = self.fake.file["body"].removesuffix("# drift\n")
        self.upgrade_cli("resume-snapshot-upgrade")
        self.assertEqual({p.name: p.read_bytes() for p in self.directory.iterdir()}, previous_bytes)
        self.upgrade_cli("resume-snapshot-upgrade", expected=1)

    def test_upgrade_policy_does_not_reinterpret_legacy_prepared_source(self):
        first = self.activate()
        original_prepared = first.store.get("prepared-file.json")
        self.assertEqual(first.policy(), meeting.LEGACY_POLICY)
        self.assertEqual(first.prepared(), original_prepared)
        self.assertNotIn("LOCAL_TRANSCRIPTION_IDLE_SECONDS", original_prepared["file"]["override"])
        self.upgrade_cli("snapshot-upgrade")
        self.assertEqual(first.prepared(), original_prepared)
        # Neither injecting a new policy into schema 1 nor editing old prepared env migrates it.
        changed = copy.deepcopy(original_prepared)
        changed["file"] = first.make_file(first.saved(), IMAGE, meeting.IDLE_POLICY)
        (self.directory / "prepared-file.json").write_text(json.dumps(changed))
        self.upgrade_cli("snapshot-upgrade", directory=self.root / ".private/migrated", expected=1)

    def test_upgrade_prepare_requires_different_tag_and_pull_requires_different_id(self):
        self.activate()
        self.upgrade_cli("snapshot-upgrade")
        self.assertEqual(self.upgrade_cli("prepare", ["--authorize-live-change", "--image", IMAGE], expected=1)["code"],
                         "upgrade_image_must_differ")
        # A distinct full-SHA tag pointing at the old image is not a fresh upgrade.
        alias = meeting.REPOSITORY + ":transcription-" + "5" * 40
        self.upgrade_cli("prepare", ["--authorize-live-change", "--image", alias])
        self.assertEqual(self.upgrade_cli("pull", ["--authorize-live-change"], expected=1)["code"],
                         "upgrade_image_must_differ")
        self.assertFalse((self.root / ".private/idle/pulled-image.json").exists())

    def test_upgrade_environment_and_whole_config_are_exact(self):
        instance = self.upgrade("prepare")
        config = self.fake.config()
        instance.verify_config(instance.saved(), config, IDLE_IMAGE, meeting.IDLE_POLICY)
        mutations = [lambda c: c["services"][meeting.SERVICE]["environment"].pop("LOCAL_TRANSCRIPTION_IDLE_SECONDS"),
                     lambda c: c["services"][meeting.SERVICE]["environment"].update(LOCAL_TRANSCRIPTION_IDLE_SECONDS="301"),
                     lambda c: c["services"][meeting.SERVICE]["environment"].update(LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS="16"),
                     lambda c: c["services"][meeting.SERVICE]["environment"].update(ALERTS_CHANNEL_ID="other"),
                     lambda c: c["services"][meeting.SERVICE]["volumes"][0].update(source="another-volume"),
                     lambda c: c["services"][meeting.SERVICE].update(stop_grace_period="30s")]
        for mutate in mutations:
            altered = copy.deepcopy(config)
            mutate(altered)
            with self.assertRaises(meeting.Blocked):
                instance.verify_config(instance.saved(), altered, IDLE_IMAGE, meeting.IDLE_POLICY)
        self.fake.poison_config = True
        count = len(self.mutation_calls())
        self.upgrade_cli("pull", ["--authorize-live-change"], expected=1)
        self.assertEqual(len(self.mutation_calls()), count)

    def test_upgrade_interrupted_activation_resumes_and_blocks_all_other_journals(self):
        self.upgrade("pull")
        self.fake.hold_command = meeting.base.UP
        counter = itertools.count()
        with mock.patch.object(meeting.base.time, "sleep"), mock.patch.object(
                meeting.base.time, "monotonic", side_effect=lambda: next(counter) / 10):
            self.assertEqual(self.upgrade_cli("activate", ["--authorize-live-change", "--deadline-seconds", "1"],
                                              expected=1)["code"], "background_deadline_resume_same_phase")
        count = len(self.mutation_calls())
        for operation in (lambda: self.upgrade_cli("rollback", ["--authorize-live-change"], expected=1),
                          lambda: self.cli("rollback", ["--authorize-live-change"], expected=1),
                          lambda: self.old_cli("rollback", ["--authorize-live-change"], expected=1)):
            self.assertEqual(operation()["code"], "pending_mutation_resume_activate_test_same_backup")
        self.assertEqual(len(self.mutation_calls()), count)
        self.fake.hold = False
        self.fake.hold_command = None
        self.upgrade_cli("activate", ["--authorize-live-change"])
        self.upgrade_cli("activate", ["--authorize-live-change"])
        self.assertEqual(sum(m == "doCommand" and p["command"] == meeting.base.UP
                             for s, m, p in self.fake.calls), 2)
        self.upgrade_cli("prepare", ["--authorize-live-change", "--image", IDLE_IMAGE], expected=1)
        self.upgrade_cli("pull", ["--authorize-live-change"], expected=1)

    def test_upgrade_capture_and_mutations_block_pending_previous_or_one_shot(self):
        self.activate()
        request = {"method": "doCommand", "params": {
            "uuid": meeting.base.STACK_UUID, "command": meeting.base.UP, "command2": ""}}
        for previous in (self.previous, self.directory):
            with self.subTest(previous=previous.name):
                store = meeting.PrivateStore(previous)
                store.put("rollback-up.request.json", request)
                store.put("rollback-up.submitted.json", {"filename": "/private/not-polled"})
                target = self.root / (".private/pending-" + previous.name)
                count = len(self.mutation_calls())
                self.assertEqual(self.upgrade_cli("snapshot-upgrade", directory=target, expected=1)["code"],
                                 "pending_mutation_resume_rollback_same_backup")
                self.assertEqual(self.upgrade_cli("prepare", ["--authorize-live-change", "--image", IDLE_IMAGE],
                                                  directory=target, expected=1)["code"],
                                 "pending_mutation_resume_rollback_same_backup")
                self.assertEqual(len(self.mutation_calls()), count)
                (previous / "rollback-up.request.json").unlink()
                (previous / "rollback-up.submitted.json").unlink()

    def test_upgrade_accepts_exact_named_binds_and_retains_mount(self):
        def binds(container):
            if container["Mounts"]:
                container["HostConfig"]["Mounts"] = None
                container["HostConfig"]["Binds"] = [container["Mounts"][0]["Name"] + ":/data:rw"]
        self.fake.runtime_mutator = binds
        self.upgrade()
        self.assertEqual(self.fake.container()["HostConfig"]["Binds"], [meeting.VOLUME + ":/data:rw"])
        self.upgrade_cli("rollback", ["--authorize-live-change"])
        self.assertEqual(self.fake.container()["Mounts"], [])

    def test_upgrade_previous_tag_drift_after_capture_blocks_prepare(self):
        self.activate()
        self.upgrade_cli("snapshot-upgrade")
        self.fake.images[IMAGE] = IDLE_ID
        count = len(self.mutation_calls())
        self.assertEqual(self.upgrade_cli("prepare", ["--authorize-live-change", "--image", IDLE_IMAGE],
                                          expected=1)["code"], "previous_meeting_tag_changed")
        self.assertEqual(len(self.mutation_calls()), count)

    def test_upgrade_fresh_tag_drift_blocks_before_recreation(self):
        self.upgrade("pull")
        self.fake.images[IDLE_IMAGE] = NEW
        count = len(self.mutation_calls())
        self.assertEqual(self.upgrade_cli("activate", ["--authorize-live-change"], expected=1)["code"],
                         "meeting_tag_changed")
        self.assertEqual(len(self.mutation_calls()), count)

    def test_upgrade_post_up_env_timeout_and_rollback_runtime_are_verified(self):
        self.upgrade("pull")
        def drift(container):
            if container["Image"] == IDLE_ID:
                container["Config"]["Env"] = [v for v in container["Config"]["Env"]
                                             if not v.startswith("LOCAL_TRANSCRIPTION_IDLE_SECONDS=")]
        self.fake.runtime_mutator = drift
        self.assertEqual(self.upgrade_cli("activate", ["--authorize-live-change"], expected=1)["code"],
                         "runtime_environment_mismatch")
        count = len(self.mutation_calls())
        self.upgrade_cli("rollback", ["--authorize-live-change"], expected=1)
        self.assertEqual(len(self.mutation_calls()), count)
        self.fake.runtime_mutator = lambda c: c["Config"].update(StopTimeout=10) if c["Image"] == IDLE_ID else None
        self.assertEqual(self.upgrade_cli("activate", ["--authorize-live-change"], expected=1)["code"],
                         "runtime_stop_timeout_mismatch")
        self.fake.runtime_mutator = lambda c: None
        self.upgrade_cli("activate", ["--authorize-live-change"])
        self.assertEqual(sum(m == "doCommand" and p["command"] == meeting.base.UP
                             for s, m, p in self.fake.calls), 2)

    def test_upgrade_schema2_policy_and_baseline_cannot_silently_change(self):
        instance = self.upgrade("prepare")
        path = instance.store.path / "deployment.json"
        original = path.read_text()
        mutations = [lambda d: d.update(policy="meeting-v1"), lambda d: d.pop("policy"),
                     lambda d: d.update(schema=3), lambda d: d.update(unreviewed=True),
                     lambda d: d["baseline"].update(id=meeting.ONE_SHOT_ID),
                     lambda d: d["container"].update(Image=IDLE_ID)]
        for mutate in mutations:
            altered = json.loads(original)
            mutate(altered)
            path.write_text(json.dumps(altered))
            with self.assertRaises(meeting.Blocked):
                instance.baseline()
        path.write_text(original)
        instance.baseline()

    def test_upgrade_lost_prepare_response_no_duplicate_and_rollback_before_up(self):
        self.activate()
        self.upgrade_cli("snapshot-upgrade")
        before = len(self.mutation_calls())
        real_rpc = self.fake.rpc
        def lost(service, method, params):
            result = real_rpc(service, method, params)
            if method == "setFile":
                raise RuntimeError(SECRET)
            return result
        with mock.patch.object(self.fake, "rpc", lost):
            self.upgrade_cli("prepare", ["--authorize-live-change", "--image", IDLE_IMAGE], expected=1)
        self.upgrade_cli("prepare", ["--authorize-live-change", "--image", IDLE_IMAGE])
        self.assertEqual(len(self.mutation_calls()), before + 1)
        self.upgrade_cli("rollback", ["--authorize-live-change"])
        self.assertEqual(self.fake.running_id, meeting.ORIGINAL_ID)
        self.assertEqual(self.fake.container()["Mounts"], [])
        self.upgrade_cli("activate", ["--authorize-live-change"], expected=1)


if __name__ == "__main__":
    unittest.main()
