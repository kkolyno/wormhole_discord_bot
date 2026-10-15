#!/usr/bin/env python3
"""Read-only, bounded Linux snapshot. No identity, network, process or env dump."""
import argparse
import glob
import json
import os
from itertools import islice
from pathlib import Path
import re
import stat


def unknown(reason="missing"):
    return {"status": "unknown", "reason": reason}


class Snapshot:
    def __init__(self, root="/", runtime=None, commands=False):
        self.root = Path(root)
        self.runtime = runtime
        # commands is retained for fixture callers; executable discovery is never run.

    def path(self, name):
        return self.root / name.lstrip("/")

    def text(self, name):
        try:
            with self.path(name).open("rb") as f:
                data = f.read(65537)
            if len(data) > 65536:
                return unknown("oversize")
            return data.decode("utf-8", errors="replace").replace("\0", " ").strip()
        except PermissionError:
            return unknown("permission_denied")
        except OSError:
            return unknown()

    def paths(self, pattern, limit=256):
        # Only fixed shallow allowlisted patterns supplied by collect().
        return sorted(islice(glob.iglob(str(self.path(pattern))), limit))

    def field(self, name, keys):
        value = self.text(name)
        if not isinstance(value, str):
            return {k: value for k in keys}
        found = {}
        for line in value.splitlines():
            key, sep, val = line.partition(":")
            if sep and key in keys:
                found[key] = val.strip()
        return {k: found.get(k, unknown()) for k in keys}

    def version(self, command):
        if command not in ("docker", "node"):
            return unknown("not_allowlisted")
        # Host inventory must not execute inherited PATH wrappers. Run the package
        # preflight separately in an approved environment for Node/package evidence.
        return unknown("not_run")

    def collect(self):
        runtime = self.runtime
        if runtime is None and self.root == Path("/"):
            u = os.uname()
            runtime = {"arch": u.machine, "kernel": u.release}
        runtime = runtime or {"arch": unknown("fixture_not_supplied"),
                              "kernel": unknown("fixture_not_supplied")}
        release = self.text("/etc/os-release")
        os_info = {k: unknown() for k in ("ID", "VERSION_ID", "PRETTY_NAME")}
        if isinstance(release, str):
            for line in release.splitlines():
                key, sep, value = line.partition("=")
                if sep and key in os_info:
                    os_info[key] = value.strip('"\'')
        else:
            os_info = {k: release for k in os_info}
        cpuinfo = self.text("/proc/cpuinfo")
        types = []
        logical = 0
        if isinstance(cpuinfo, str):
            allowed = ("model name", "CPU implementer", "CPU architecture", "CPU part")
            for block in cpuinfo.split("\n\n")[:256]:
                fields = {}
                for line in block.splitlines():
                    key, sep, val = line.partition(":")
                    key = key.strip()
                    if sep and key == "processor":
                        logical += 1
                    if sep and key in allowed:
                        fields[key] = val.strip()
                if fields and fields not in types:
                    types.append(fields)
        cpus = []
        for item in self.paths("/sys/devices/system/cpu/cpu[0-9]*"):
            p = Path(item)
            if not re.fullmatch(r"cpu\d+", p.name):
                continue
            prefix = "/sys/devices/system/cpu/" + p.name + "/cpufreq/"
            cpus.append({"cpu": p.name, **{key: self.text(prefix + key) for key in (
                "scaling_cur_freq", "cpuinfo_max_freq", "scaling_governor")}})
        zones = []
        for item in self.paths("/sys/class/thermal/thermal_zone*", 64):
            p = Path(item)
            prefix = "/sys/class/thermal/" + p.name + "/"
            trips = []
            for t in self.paths(prefix + "trip_point_*_temp", 64):
                name = Path(t).name
                trips.append({"name": name, "temp_millidegrees_c": self.text(prefix + name),
                              "type": self.text(prefix + name.replace("_temp", "_type"))})
            zones.append({"zone": p.name, "type": self.text(prefix + "type"),
                          "temp_millidegrees_c": self.text(prefix + "temp"),
                          "trip_points": trips or unknown()})
        nodes = []
        for pattern in ("/dev/dri/renderD*", "/dev/rknpu*"):
            for item in self.paths(pattern, 32):
                p = Path(item)
                try:
                    s = p.stat()
                    nodes.append({"path": "/" + str(p.relative_to(self.root)),
                                  "mode": oct(stat.S_IMODE(s.st_mode)),
                                  "uid": s.st_uid, "gid": s.st_gid,
                                  "character_device": stat.S_ISCHR(s.st_mode),
                                  "major": os.major(s.st_rdev), "minor": os.minor(s.st_rdev)})
                except PermissionError:
                    nodes.append({"status": "unknown", "reason": "permission_denied"})
                except OSError:
                    nodes.append(unknown("stat_failed"))
        libs = {}
        for directory in ("/usr/lib", "/usr/lib64", "/usr/local/lib", "/lib",
                          "/usr/lib/aarch64-linux-gnu", "/lib/aarch64-linux-gnu"):
            # Existence only, not library loading or content/version inspection.
            path = directory + "/librknnrt.so"
            try:
                self.path(path).stat()
                libs[path] = True
            except FileNotFoundError:
                libs[path] = False
            except PermissionError:
                libs[path] = unknown("permission_denied")
            except OSError:
                libs[path] = unknown()
        load = self.text("/proc/loadavg")
        return {"schema": 1, "scope": "read_only_snapshot_not_performance_evidence",
                "model": self.text("/proc/device-tree/model"),
                "compatible": self.text("/proc/device-tree/compatible"),
                "runtime": runtime, "os": os_info,
                "memory_kib": self.field("/proc/meminfo", ("MemTotal", "MemAvailable")),
                "load_1_5_15": load.split()[:3] if isinstance(load, str) else load,
                "cpu": {"logical_count": logical or unknown(), "types": types or unknown(),
                        "frequency_khz_governor": cpus or unknown()},
                "thermal_zones": zones or unknown(),
                "rknpu_module_version": self.text("/sys/module/rknpu/version"),
                "device_nodes": nodes or unknown(), "rknnrt_candidates_exist": libs,
                "versions": {"docker": self.version("docker"), "node": self.version("node")},
                "caveat": "Container visibility may differ from host. No cooling, NPU usability or real-time inference conclusions."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="/", help="fixture root; substitutes allowlisted files")
    args = parser.parse_args()
    print(json.dumps(Snapshot(args.root).collect(), indent=2))
