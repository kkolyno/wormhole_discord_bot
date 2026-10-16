#!/usr/bin/env python3
"""Bounded Oracle meeting deployment; see ORACLE-MEETING-OPERATIONS.md. Run with -B."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("oracle_one_shot_admin", ROOT / "scripts/oracle-transcription-admin.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
Blocked, require = base.Blocked, base.require
PrivateStore, StackLock = base.PrivateStore, base.StackLock
SERVICE, REPOSITORY = base.SERVICE, base.REPOSITORY
IMAGE_RE = re.compile(re.escape(REPOSITORY) + r":transcription-[0-9a-f]{40}\Z")
ORIGINAL_ID = "sha256:b44105db8c52b15918f068653f0c52eaa2d1c2e70cfc0220a2e3b72b9d379edc"
ONE_SHOT_ID = "sha256:f5222dab8309d1eea2d02125c940a161573427f199ae9ba51639c71e1c507d03"
VOLUME = "oracle-meeting-transcription-data"
COMMAND = ["node", "index.js"]
ENTRYPOINT = ["/sbin/tini", "--", "docker-entrypoint.sh"]
ENVIRONMENT = {"LOCAL_TRANSCRIPTION_ENABLED": "true", "LOCAL_TRANSCRIPTION_CONSENT_MODE": "channel",
               "LOCAL_TRANSCRIPT_ATTACHMENTS": "false", "LOCAL_TRANSCRIPTION_DATA_DIR": "/data/transcription"}
LEGACY_POLICY, IDLE_POLICY = "meeting-v1", "idle-v2"
IDLE_ENVIRONMENT = {**ENVIRONMENT, "LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS": "15",
                    "LOCAL_TRANSCRIPTION_IDLE_SECONDS": "300"}
ACTIONS = ("snapshot", "resume-snapshot", "snapshot-upgrade", "resume-snapshot-upgrade",
           "status", "prepare", "pull", "activate", "rollback", "verify")
MUTATIONS = {"prepare", "pull", "activate", "rollback"}
# Keep the OLD guard's fixed job vocabulary. Never add an unscanned mutation name.
PHASES = {"pull": "pull-test", "activate": "activate-test", "rollback": "rollback"}
LOGS = "logs --no-color --tail 100 " + SERVICE


def meeting_image(value):
    require(isinstance(value, str) and IMAGE_RE.fullmatch(value), "invalid_meeting_image")
    return value


class Admin(base.Admin):
    def record(self, name, value):
        if self.store.has(name):
            require(self.store.get(name) == value, "immutable_capture_changed")
        else:
            self.store.put(name, value)

    def inspect(self, name, reference=None):
        if isinstance(reference, str) and IMAGE_RE.fullmatch(reference):
            text = self.job(name, "doDockerImageCmd", {"command": "inspect", "id": reference})
            result = base.decode_document(text, list)
            require(len(result) == 1 and isinstance(result[0], dict), "unknown_inspect_shape")
            return result[0]
        return super().inspect(name, reference)

    @staticmethod
    def runtime(config, container, image, volume, meeting=False):
        """Reuse the reviewed env/process/user/network/restart contract, adding ONE mount."""
        service = base.Admin.validate_config(config)
        mounts = service.get("volumes")
        require(isinstance(mounts, list) and len(mounts) == 1, "unexpected_runtime_mount")
        mount = mounts[0]
        require(isinstance(mount, dict) and mount.get("type") == "volume"
                and mount.get("source") == volume and mount.get("target") == "/data"
                and set(mount) <= {"type", "source", "target", "volume", "read_only"}
                and mount.get("volume", {}) == {} and mount.get("read_only", False) is False,
                "unexpected_runtime_mount")
        actual = container.get("Mounts")
        require(isinstance(actual, list) and len(actual) == 1, "unexpected_runtime_mount")
        actual = actual[0]
        require(isinstance(actual, dict) and actual.get("Type") == "volume"
                and actual.get("Name") == volume and actual.get("Destination") == "/data"
                and actual.get("RW") is True and actual.get("Driver") == "local"
                and isinstance(actual.get("Source"), str) and actual["Source"].startswith("/"),
                "unexpected_runtime_mount")
        host = container.get("HostConfig", {})
        host_mounts, binds = host.get("Mounts"), host.get("Binds")
        if not host_mounts:
            # This deployed Compose serializes named volumes through Binds.
            # The actual Mounts entry above must still prove a local named volume.
            require(binds == [volume + ":/data:rw"], "unexpected_runtime_host_mount")
        else:
            require(not binds and isinstance(host_mounts, list) and len(host_mounts) == 1,
                    "unexpected_runtime_host_mount")
            host_mount = host_mounts[0]
            require(isinstance(host_mount, dict) and host_mount.get("Type") == "volume"
                    and host_mount.get("Source") == volume and host_mount.get("Target") == "/data"
                    and set(host_mount) <= {"Type", "Source", "Target", "ReadOnly", "VolumeOptions"}
                    and host_mount.get("ReadOnly", False) is False
                    and host_mount.get("VolumeOptions", {}) == {}, "unexpected_runtime_host_mount")
        clean_config, clean_container = copy.deepcopy(config), copy.deepcopy(container)
        clean_config["services"][SERVICE]["volumes"] = []
        clean_container["Mounts"] = []
        clean_container["HostConfig"]["Mounts"] = []
        clean_container["HostConfig"]["Binds"] = []
        if meeting:
            require(service.get("stop_grace_period") == "45s"
                    and container.get("Config", {}).get("StopTimeout") == 45,
                    "runtime_stop_timeout_mismatch")
            clean_config["services"][SERVICE].pop("stop_grace_period")
        base.Admin.runtime_equivalent(clean_config, clean_container, image)

    @staticmethod
    def check_image(image):
        identifier = base.image_id(image.get("Id"))
        require(identifier not in {ORIGINAL_ID, ONE_SHOT_ID}, "meeting_image_is_old_baseline")
        config = image.get("Config", {})
        # Dockerfile.transcription declares nodejs with UID/GID 1001. Inspect exposes
        # the named USER, not /etc/passwd; no container exec is permitted here.
        require(image.get("Architecture") == "arm64" and image.get("Os") == "linux"
                and config.get("User") == "nodejs" and config.get("Cmd") == COMMAND
                and config.get("WorkingDir") == "/app"
                and config.get("Entrypoint") == ENTRYPOINT and not config.get("Volumes"),
                "unexpected_meeting_image_contract")

    @staticmethod
    def identity(config, container, identifier):
        Admin.container_ok(container, identifier)
        require(container.get("State", {}).get("Running") is True, "oracle_not_running")
        require(isinstance(config.get("name"), str) and config["name"]
                and container.get("Config", {}).get("Labels", {}).get("com.docker.compose.project")
                == config["name"], "unexpected_compose_project")

    def running(self, config, identifier, image, volume=None, meeting=False):
        container = self.fresh_inspect("running-check")
        self.identity(config, container, identifier)
        if volume:
            self.runtime(config, container, image, volume, meeting)
        else:
            base.Admin.runtime_equivalent(config, container, image)
        return container

    def snapshot(self, previous_path):
        require(not self.store.has("deployment.json"), "snapshot_already_complete")
        self.record("capture-kind.json", {"kind": "one-shot"})
        previous_store = PrivateStore(previous_path)
        require(previous_store.path != self.store.path, "previous_backup_must_differ")
        self.record("previous-backup.json", {"path": str(previous_store.path)})
        previous = base.Admin(self.client, previous_store, self.deadline)
        saved = previous.saved()
        require(saved["old_id"] == ORIGINAL_ID, "unexpected_original_baseline")
        prepared = previous.prepared()  # Fresh exact source AND whole resolved config.
        require(prepared["file"] == base.Admin.make_test_file(saved, prepared["image"]),
                "previous_baseline_changed")
        require(previous_store.has("activate-test.done.json"), "previous_activation_incomplete")
        require(previous_store.get("pulled-image.json") == {"id": ONE_SHOT_ID},
                "unexpected_one_shot_baseline")
        previous.verify_pin(saved)
        pin_request = {"method": "doTag", "params": {"srcid": ORIGINAL_ID, "srcimg": "", "srctag": "",
            "tgtimg": "oracle-rollback", "tgttag": saved["rollback_tag"].split(":", 1)[1]}}
        require(previous_store.get("pin-rollback.request.json") == pin_request,
                "unexpected_original_pin_intent")
        # These names also make partial/new journals visible to the unchanged old guard.
        self.record("original-file.json", saved["file"])
        self.record("snapshot.json", saved)
        for name in ("pin-rollback.request.json", "pin-rollback.submitted.json", "pin-rollback.done.json"):
            self.record(name, previous_store.get(name))
        self.record("previous-prepared.json", prepared)
        self.record("previous-pulled.json", previous_store.get("pulled-image.json"))
        config = previous.fresh_config("meeting-baseline")
        base.Admin.verify_test_config(saved, config, prepared["image"])
        image = previous.fresh_inspect("meeting-baseline-image", ONE_SHOT_ID)
        require(base.image_id(image.get("Id")) == ONE_SHOT_ID, "one_shot_image_changed")
        require(base.image_id(previous.fresh_inspect("meeting-baseline-tag", prepared["image"]).get("Id"))
                == ONE_SHOT_ID, "one_shot_tag_changed")
        container = self.running(config, ONE_SHOT_ID, image, base.VOLUME)
        anchor = {"file": prepared["file"], "config": config, "image": image, "id": ONE_SHOT_ID}
        self.record("current-baseline.json", anchor)
        if not self.store.has("baseline-container.json"):
            self.store.put("baseline-container.json", container)
        # Fresh checks on *every* resume; never silently adapt a cached baseline.
        require(self.get_file() == anchor["file"], "stack_source_changed")
        require(self.fresh_config("snapshot-final-config") == config, "resolved_baseline_changed")
        final = self.running(config, ONE_SHOT_ID, image, base.VOLUME)
        previous.verify_pin(saved)
        require(self.get_file() == anchor["file"], "stack_source_changed")
        self.store.put("deployment.json", {"schema": 1, "baseline": anchor, "container": final})
        return {"snapshot_saved": True, "original_image_id": ORIGINAL_ID, "baseline_image_id": ONE_SHOT_ID}

    @staticmethod
    def completed(evidence, name, method, params):
        require(evidence[name + ".request.json"] == {"method": method, "params": params},
                "previous_phase_intent_changed")
        submitted, done = evidence[name + ".submitted.json"], evidence[name + ".done.json"]
        require(set(submitted) == {"filename"} and isinstance(submitted["filename"], str)
                and submitted["filename"] and set(done) == {"output"}
                and isinstance(done["output"], str) and "*** ERROR" not in done["output"],
                "previous_phase_incomplete")

    @staticmethod
    def first_baseline(saved, data, anchor, previous, pulled):
        require(data.get("schema") == 1 and set(data) == {"schema", "baseline", "container"},
                "unknown_deployment_schema")
        baseline = data["baseline"]
        require(saved["old_id"] == ORIGINAL_ID and baseline["id"] == ONE_SHOT_ID
                and base.image_id(baseline["image"].get("Id")) == ONE_SHOT_ID,
                "unexpected_original_baseline")
        require(baseline == anchor and baseline["file"] == previous["file"]
                and previous["file"] == base.Admin.make_test_file(saved, previous["image"])
                and pulled == {"id": ONE_SHOT_ID}, "previous_baseline_changed")
        base.Admin.verify_test_config(saved, baseline["config"], previous["image"])
        Admin.identity(baseline["config"], data["container"], ONE_SHOT_ID)
        Admin.runtime(baseline["config"], data["container"], baseline["image"], base.VOLUME)
        return baseline

    def previous_meeting(self, evidence):
        """Offline, immutable validation: never append observations to the old journal."""
        saved = self.saved()
        require(evidence["snapshot.json"] == saved
                and evidence["original-file.json"] == saved["file"], "previous_original_changed")
        self.first_baseline(saved, evidence["deployment.json"], evidence["current-baseline.json"],
                            evidence["previous-prepared.json"], evidence["previous-pulled.json"])
        prepared = evidence["prepared-file.json"]
        require(prepared["file"] == self.make_file(saved, prepared["image"], LEGACY_POLICY),
                "previous_prepared_changed")
        image = evidence["pulled-contract.json"]
        self.check_image(image)
        require(evidence["pulled-image.json"] == {"id": base.image_id(image.get("Id"))},
                "previous_pulled_changed")
        for name, command in (("pull-test", "pull " + SERVICE), ("activate-test", base.UP)):
            self.completed(evidence, name, "doCommand", {
                "uuid": base.STACK_UUID, "command": command, "command2": ""})
        self.completed(evidence, "pin-rollback", "doTag", {
            "srcid": ORIGINAL_ID, "srcimg": "", "srctag": "", "tgtimg": "oracle-rollback",
            "tgttag": saved["rollback_tag"].split(":", 1)[1]})
        for suffix in ("request", "submitted", "done"):
            name = "pin-rollback." + suffix + ".json"
            require(self.store.get(name) == evidence[name], "previous_original_pin_changed")
        return prepared, image

    def snapshot_upgrade(self, previous_path):
        require(not self.store.has("deployment.json"), "snapshot_already_complete")
        self.record("capture-kind.json", {"kind": "meeting-v1-to-idle-v2"})
        previous_store = PrivateStore(previous_path)
        require(previous_store.path != self.store.path, "previous_backup_must_differ")
        self.record("previous-backup.json", {"path": str(previous_store.path)})
        require(not any(previous_store.has("rollback-up." + suffix + ".json")
                        for suffix in ("request", "submitted", "done")), "previous_meeting_rolled_back")
        previous = Admin(self.client, previous_store, self.deadline)
        previous.baseline()  # Pure validation of the completed legacy meeting schema.
        names = ["snapshot.json", "original-file.json", "deployment.json", "current-baseline.json",
                 "previous-prepared.json", "previous-pulled.json", "prepared-file.json",
                 "pulled-image.json", "pulled-contract.json"]
        names += [phase + "." + suffix + ".json" for phase in
                  ("pin-rollback", "pull-test", "activate-test") for suffix in ("request", "submitted", "done")]
        evidence = {name: previous_store.get(name) for name in names}
        self.record("original-file.json", evidence["original-file.json"])
        self.record("snapshot.json", evidence["snapshot.json"])
        for suffix in ("request", "submitted", "done"):
            name = "pin-rollback." + suffix + ".json"
            self.record(name, evidence[name])
        self.record("previous-meeting.json", evidence)
        prepared, recorded_image = self.previous_meeting(evidence)
        require(self.get_file() == prepared["file"], "stack_source_changed")
        config = self.fresh_config("upgrade-baseline")
        self.verify_config(self.saved(), config, prepared["image"], LEGACY_POLICY)
        identifier = base.image_id(recorded_image.get("Id"))
        image = self.fresh_inspect("upgrade-baseline-image", identifier)
        require(image == recorded_image, "previous_meeting_image_changed")
        require(self.fresh_inspect("upgrade-baseline-tag", prepared["image"]) == image,
                "previous_meeting_tag_changed")
        self.verify_pin(self.saved())
        container = self.running(config, identifier, image, VOLUME, meeting=True)
        anchor = {"file": prepared["file"], "config": config, "image": image, "id": identifier}
        self.record("current-baseline.json", anchor)
        if not self.store.has("baseline-container.json"):
            self.store.put("baseline-container.json", container)
        require(self.get_file() == anchor["file"], "stack_source_changed")
        require(self.fresh_config("upgrade-final-config") == config, "resolved_baseline_changed")
        final = self.running(config, identifier, image, VOLUME, meeting=True)
        require(self.fresh_inspect("upgrade-final-tag", prepared["image"]) == image,
                "previous_meeting_tag_changed")
        self.verify_pin(self.saved())
        require(self.get_file() == anchor["file"], "stack_source_changed")
        self.store.put("deployment.json", {"schema": 2, "policy": IDLE_POLICY,
                                          "baseline": anchor, "container": final})
        return {"snapshot_saved": True, "original_image_id": ORIGINAL_ID, "baseline_image_id": identifier}

    def baseline(self):
        data = self.store.get("deployment.json")
        saved, baseline = self.saved(), data["baseline"]
        require(saved["old_id"] == ORIGINAL_ID and saved["old_image"].get("Id") == ORIGINAL_ID
                and self.store.get("original-file.json") == saved["file"], "unexpected_original_baseline")
        self.identity(saved["config"], saved["container"], ORIGINAL_ID)
        policy = self.policy()
        if policy == LEGACY_POLICY:
            return self.first_baseline(saved, data, self.store.get("current-baseline.json"),
                                       self.store.get("previous-prepared.json"),
                                       self.store.get("previous-pulled.json"))
        prepared, image = self.previous_meeting(self.store.get("previous-meeting.json"))
        require(baseline == self.store.get("current-baseline.json")
                and baseline["file"] == prepared["file"] and baseline["image"] == image
                and baseline["id"] == image["Id"], "previous_baseline_changed")
        self.verify_config(saved, baseline["config"], prepared["image"], LEGACY_POLICY)
        self.identity(baseline["config"], data["container"], baseline["id"])
        self.runtime(baseline["config"], data["container"], image, VOLUME, meeting=True)
        return baseline

    def policy(self):
        data = self.store.get("deployment.json")
        if data.get("schema") == 1:
            require(set(data) == {"schema", "baseline", "container"}, "unknown_deployment_policy")
            return LEGACY_POLICY
        require(data.get("schema") == 2 and data.get("policy") == IDLE_POLICY
                and set(data) == {"schema", "policy", "baseline", "container"},
                "unknown_deployment_policy")
        return IDLE_POLICY

    @staticmethod
    def environment(policy):
        require(policy in {LEGACY_POLICY, IDLE_POLICY}, "unknown_deployment_policy")
        return ENVIRONMENT if policy == LEGACY_POLICY else IDLE_ENVIRONMENT

    def baseline_running(self, baseline):
        upgrade = self.policy() == IDLE_POLICY
        if upgrade:
            tag = baseline["config"]["services"][SERVICE]["image"]
            require(self.fresh_inspect("check-upgrade-baseline-tag", tag) == baseline["image"],
                    "previous_meeting_tag_changed")
        return self.running(baseline["config"], baseline["id"], baseline["image"],
                            VOLUME if upgrade else base.VOLUME, meeting=upgrade)

    @staticmethod
    def make_file(saved, image, policy=LEGACY_POLICY):
        meeting_image(image)
        service = base.Admin.validate_config(saved["config"])
        require(not saved["file"]["override"].strip() and service.get("entrypoint") is None,
                "unsupported_original_override_or_entrypoint")
        require(service.get("user") in (None, "", "nodejs", "nodejs:nodejs", "1001", "1001:1001")
                and service.get("working_dir") in (None, "", "/app"),
                "original_user_or_workdir_overrides_meeting_contract")
        require(VOLUME not in saved["config"].get("volumes", {})
                and all(isinstance(v, dict) and v.get("name") != VOLUME
                        for v in saved["config"].get("volumes", {}).values()), "meeting_volume_already_declared")
        require(not service.get("volumes"), "existing_mounts_require_manual_plan")
        desired = copy.deepcopy(saved["file"])
        desired["override"] = base.OVERRIDE_COMMENT + json.dumps({"services": {SERVICE: {
            "image": image, "command": COMMAND, "environment": Admin.environment(policy),
            "volumes": [{"type": "volume", "source": VOLUME, "target": "/data"}],
            "stop_grace_period": "45s"}}, "volumes": {VOLUME: {"name": VOLUME}}}, sort_keys=True)
        return desired

    @staticmethod
    def verify_config(saved, config, image, policy=LEGACY_POLICY):
        meeting_image(image)
        expected = copy.deepcopy(saved["config"])
        service = base.Admin.validate_config(expected)
        actual = base.Admin.validate_config(config)
        service.update({"image": image, "command": COMMAND, "stop_grace_period": "45s"})
        service.setdefault("environment", {}).update(Admin.environment(policy))
        mounts = actual.get("volumes")
        require(isinstance(mounts, list) and len(mounts) == 1, "meeting_mount_not_resolved")
        mount = mounts[0]
        require(isinstance(mount, dict) and mount.get("type") == "volume"
                and mount.get("source") == VOLUME and mount.get("target") == "/data"
                and set(mount) <= {"type", "source", "target", "volume", "read_only"}
                and mount.get("volume", {}) == {} and mount.get("read_only", False) is False,
                "unexpected_meeting_mount_options")
        service["volumes"] = copy.deepcopy(mounts)
        expected.setdefault("volumes", {})[VOLUME] = {"name": VOLUME}
        require(config == expected, "resolved_config_changed_outside_allowlist")

    def prepared(self):
        self.baseline()
        data = self.store.get("prepared-file.json")
        require(data["file"] == self.make_file(self.saved(), data["image"], self.policy()), "prepared_intent_changed")
        require(self.get_file() == data["file"], "stack_source_changed")
        self.verify_config(self.saved(), self.fresh_config("check-meeting"), data["image"], self.policy())
        return data

    def prepare(self, image):
        baseline, saved = self.baseline(), self.saved()
        require(not self.store.has("activate-test.request.json")
                and not self.store.has("rollback-up.request.json"), "deployment_already_activated_or_rolled_back")
        self.verify_pin(saved)
        self.baseline_running(baseline)
        require(image != baseline["config"]["services"][SERVICE]["image"], "upgrade_image_must_differ")
        desired = self.make_file(saved, image, self.policy())
        self.record("prepared-file.json", {"file": desired, "image": image})
        if self.get_file() == baseline["file"]:
            require(self.fresh_config("prepare-baseline") == baseline["config"], "resolved_baseline_changed")
        self.set_file(desired, [baseline["file"]])
        self.prepared()
        return {"meeting_source_prepared": True, "container_recreated": False}

    def pull(self):
        baseline, prepared = self.baseline(), self.prepared()
        require(not self.store.has("activate-test.request.json")
                and not self.store.has("rollback-up.request.json"), "deployment_already_activated_or_rolled_back")
        self.verify_pin(self.saved())
        self.baseline_running(baseline)
        self.compose("pull-test", "pull")
        image = self.fresh_inspect("pulled-meeting-image", prepared["image"])
        self.check_image(image)
        require(image["Id"] != baseline["id"], "upgrade_image_must_differ")
        self.record("pulled-image.json", {"id": base.image_id(image["Id"])})
        self.record("pulled-contract.json", image)
        return {"meeting_image_pulled": True, "image_id": image["Id"]}

    def pulled(self):
        prepared = self.prepared()
        identifier = base.image_id(self.store.get("pulled-image.json")["id"])
        image = self.fresh_inspect("check-meeting-tag", prepared["image"])
        require(base.image_id(image.get("Id")) == identifier, "meeting_tag_changed")
        self.check_image(image)
        require(identifier != self.baseline()["id"], "upgrade_image_must_differ")
        return identifier, image

    def check_current(self, allow_original=False):
        """Reject external runtime drift before either recreation, even on retries."""
        baseline, saved = self.baseline(), self.saved()
        current = self.container_ok(self.fresh_inspect("current-id"))
        if current == baseline["id"]:
            return self.baseline_running(baseline)
        if current == ORIGINAL_ID:
            require(allow_original, "oracle_image_changed")
            return self.running(saved["config"], current, saved["old_image"])
        require(self.store.has("pulled-image.json")
                and current == self.store.get("pulled-image.json")["id"], "oracle_image_changed")
        image = self.fresh_inspect("current-image", current)
        self.check_image(image)
        prepared = self.store.get("prepared-file.json")
        # Derive the exact supported deployed config without using the live source.
        config = copy.deepcopy(saved["config"])
        service = config["services"][SERVICE]
        service.update({"image": prepared["image"], "command": COMMAND, "stop_grace_period": "45s",
                        "volumes": [{"type": "volume", "source": VOLUME, "target": "/data"}]})
        service.setdefault("environment", {}).update(self.environment(self.policy()))
        config.setdefault("volumes", {})[VOLUME] = {"name": VOLUME}
        return self.running(config, current, image, VOLUME, meeting=True)

    def activate(self):
        require(not self.store.has("rollback-up.request.json"), "deployment_already_rolled_back")
        prepared = self.prepared()
        self.verify_pin(self.saved())
        identifier, image = self.pulled()
        self.check_current()
        self.compose("activate-test", "up")
        config = self.fresh_config("activated-config")
        self.verify_config(self.saved(), config, prepared["image"], self.policy())
        self.running(config, identifier, image, VOLUME, meeting=True)
        return {"meeting_container_running": True, "image_id": identifier, "application_ready_verified": False}

    def rollback(self):
        baseline, saved = self.baseline(), self.saved()
        self.verify_pin(saved)
        self.check_current(allow_original=True)
        pinned = copy.deepcopy(saved["file"])
        pinned["override"] = base.OVERRIDE_COMMENT + json.dumps(
            {"services": {SERVICE: {"image": saved["old_id"]}}}, sort_keys=True)
        allowed = [baseline["file"], saved["file"], pinned]
        if self.store.has("prepared-file.json"):
            prepared = self.store.get("prepared-file.json")
            require(prepared["file"] == self.make_file(saved, prepared["image"], self.policy()), "prepared_intent_changed")
            allowed.append(prepared["file"])
        current_file = self.get_file()
        require(current_file in allowed, "stack_source_changed")
        # Validate the whole currently-resolved source BEFORE replacing its override.
        config = self.fresh_config("rollback-before-config")
        expected = copy.deepcopy(saved["config"])
        expected["services"][SERVICE]["image"] = saved["old_id"]
        if current_file == baseline["file"]:
            require(config == baseline["config"], "resolved_baseline_changed")
        elif current_file == saved["file"]:
            require(config == saved["config"], "resolved_baseline_changed")
        elif current_file == pinned:
            require(config == expected, "rollback_resolved_config_changed")
        else:
            self.verify_config(saved, config, prepared["image"], self.policy())
        self.set_file(pinned, allowed)
        require(self.fresh_config("rollback-config") == expected, "rollback_resolved_config_changed")
        self.compose("rollback-up", "up")
        self.running(expected, ORIGINAL_ID, saved["old_image"])
        original_image = saved["config"]["services"][SERVICE]["image"]
        require(base.image_id(self.fresh_inspect("rollback-source-image", original_image).get("Id"))
                == ORIGINAL_ID, "old_container_restored_source_stays_pinned_tag_drift")
        self.set_file(saved["file"], [pinned])
        require(self.fresh_config("rollback-original-config") == saved["config"], "original_config_not_restored")
        return {"old_container_running": True, "original_source_restored": True, "image_id": ORIGINAL_ID}

    def verify(self):
        # Logs are bounded, private, and never printed. These are hints, NOT health.
        self.baseline()
        text = self.job("verify-logs-" + uuid.uuid4().hex, "doCommand",
                        {"uuid": base.STACK_UUID, "command": LOGS, "command2": ""})
        return {"startup_marker_seen": "Starting Wormhole Bot..." in text,
                "ready_marker_seen": "Logged in as " in text,
                "login_error_count": text.count("DISCORD_LOGIN_FAILED"),
                "config_error_count": text.count("LOCAL_TRANSCRIPTION_CONFIG_INVALID"),
                "application_ready_verified": False}


def main(argv=None, client_factory=base.load_client):
    parser = base.SafeParser(description=__doc__)
    parser.add_argument("action", choices=ACTIONS)
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--previous-backup-dir", type=Path)
    parser.add_argument("--image")
    parser.add_argument("--authorize-live-change", action="store_true")
    parser.add_argument("--deadline-seconds", type=int, default=120, choices=range(1, 601), metavar="1..600")
    args = parser.parse_args(argv)
    require(args.action not in MUTATIONS or args.authorize_live_change,
            "explicit_live_change_authorization_required")
    require((args.action == "prepare") == (args.image is not None), "image_required_only_for_prepare")
    capture = args.action in {"snapshot", "resume-snapshot", "snapshot-upgrade", "resume-snapshot-upgrade"}
    upgrade = args.action in {"snapshot-upgrade", "resume-snapshot-upgrade"}
    require(capture == (args.previous_backup_dir is not None), "previous_backup_required_only_for_snapshot")
    if args.image is not None:
        meeting_image(args.image)
    with StackLock():
        store = PrivateStore(args.backup_dir, create=args.action in {"snapshot", "snapshot-upgrade"})
        instance = Admin(client_factory(), store, args.deadline_seconds)
        if args.action in MUTATIONS or upgrade:
            instance.guard_mutations(PHASES.get(args.action, args.action))
        if upgrade:
            result = instance.snapshot_upgrade(args.previous_backup_dir)
        elif capture:
            result = instance.snapshot(args.previous_backup_dir)
        elif args.action == "prepare":
            result = instance.prepare(args.image)
        else:
            result = getattr(instance, args.action)()
    print(json.dumps({"action": args.action, "ok": True, **result}, sort_keys=True))


def cli(argv=None, client_factory=base.load_client):
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
