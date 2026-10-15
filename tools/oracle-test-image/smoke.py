#!/usr/bin/env python3
"""Run inside the approved /ws worker; all nested containers are temporary/offline.
Only the public, pinned JFK fixture is fetched. No credentials or live audio.
"""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import urllib.request

SAMPLE_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav"
SAMPLE_SHA = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e"


def docker(*args, capture=False):
    return subprocess.run(["docker", *args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="oracle-test-image-dev:local")
    parser.add_argument("--evidence", default="tools/oracle-test-image/evidence")
    args = parser.parse_args()
    if Path.cwd() != Path("/ws") or platform.system() != "Linux" or platform.machine() != "aarch64":
        parser.error("Run via docker exec -w /ws <approved-worker> python3 tools/oracle-test-image/smoke.py")
    evidence = Path(args.evidence)
    evidence.mkdir(parents=True, exist_ok=True)
    name = f"oracle-test-image-dev-{os.getpid()}"
    fixture_volume, data_volume = f"{name}-fixture", f"{name}-data"
    loader, runner = f"{name}-loader", f"{name}-runner"
    try:
        docker("volume", "create", fixture_volume)
        docker("volume", "create", data_volume)
        with tempfile.TemporaryDirectory(prefix="oracle-test-image-", dir="/tmp") as tmp:
            fixture = Path(tmp) / "jfk.wav"
            with urllib.request.urlopen(SAMPLE_URL, timeout=120) as source:
                audio = source.read(352079)
            assert len(audio) == 352078 and hashlib.sha256(audio).hexdigest() == SAMPLE_SHA
            fixture.write_bytes(audio)
            fixture.chmod(0o644)
            (evidence / "fixture.txt").write_text(f"{SAMPLE_URL}\n{SAMPLE_SHA}  jfk.wav\n352078 bytes\nPublic fixture only; not private call audio.\n")
            docker("create", "--name", loader, "--network", "none", "--user", "0",
                   "--mount", f"type=volume,source={fixture_volume},target=/fixtures",
                   "--entrypoint", "sh", args.image, "-c", "true")
            docker("cp", str(fixture), f"{loader}:/fixtures/jfk.wav")
            docker("rm", loader)
        command = r'''
set -eu
sh tools/oracle-test-image/preflight.sh
T=$(mktemp -d /data/oracle-test/public-smoke-XXXXXXXX)
trap 'rm -rf "$T"' EXIT HUP INT TERM
# Fixed English model, CPU only, <=4 inference threads. Network disabled by Docker.
whisper-cli -m /opt/models/ggml-base.en.bin -f /fixtures/jfk.wav -t 4 -p 1 -l en -ng -otxt -of "$T/transcript"
test -s "$T/transcript.txt"
cat "$T/transcript.txt"
grep -qi 'ask not what your country' "$T/transcript.txt"
# Exercise the actual local helper too: receiver-style 48 kHz stereo PCM,
# ffmpeg conversion, sanitized child environment, recognition, and audio cleanup.
ffmpeg -nostdin -hide_banner -loglevel error -i /fixtures/jfk.wav -ar 48000 -ac 2 -c:a pcm_s16le -f s16le "$T/fixture.pcm"
node -e '
const fs = require("node:fs"), path = require("node:path");
const { recognizeLocal } = require("./tools/oracle-test/local-stt");
const dir = process.argv[1];
recognizeLocal({ id: "public-helper", pcm: fs.readFileSync(path.join(dir, "fixture.pcm")),
  dir, signal: AbortSignal.timeout(60000) }).then(text => {
  if (!/ask not what your country/i.test(text)) throw Error("PUBLIC_OUTPUT_SANITY_FAILED");
  if (fs.readdirSync(dir).some(name => name.startsWith("public-helper"))) throw Error("HELPER_AUDIO_CLEANUP_FAILED");
  console.log("PASS: actual local helper public-fixture conversion/recognition/cleanup");
}).catch(() => { console.error("PUBLIC_HELPER_SMOKE_FAILED"); process.exitCode = 1; });
' "$T"
printf '\nPASS: fresh English public-fixture output sanity only; NOT accuracy, latency, or RK3588 RTF proof.\n'
'''
        with (evidence / "offline-smoke.txt").open("w") as out:
            subprocess.run(["docker", "run", "--rm", "--name", runner,
                            "--platform", "linux/arm64", "--network", "none",
                            "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev",
                            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                            "--mount", f"type=volume,source={fixture_volume},target=/fixtures,readonly",
                            "--mount", f"type=volume,source={data_volume},target=/data",
                            "--entrypoint", "/sbin/tini", args.image, "--", "sh", "-c", command],
                           check=True, stdout=out, stderr=subprocess.STDOUT)
        # Allowlisted metadata only: do not dump container environments.
        result = docker("image", "inspect", args.image, "--format",
                        '{{.Id}} {{.Os}}/{{.Architecture}} user={{.Config.User}} cmd={{json .Config.Cmd}}', capture=True)
        (evidence / "image.txt").write_text(result)
        print("PASS: image preflight/public-English smoke; evidence:", evidence)
    finally:
        # Only names created by this invocation; never touch the parent worker.
        for container in (runner, loader):
            subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for volume in (fixture_volume, data_volume):
            subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
