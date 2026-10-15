#!/usr/bin/env python3
"""Approved ARM64 worker only: offline nested images, pinned public JFK fixture.
Never builds, publishes, logs in, reads private audio, or mounts credentials.
"""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import time
import urllib.request

URL = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav'
SHA = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'

def docker(*args, capture=False):
    return subprocess.run(['docker', *args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='local-transcription-dev:local')
    parser.add_argument('--evidence', default='tools/local-transcription-image/evidence')
    args = parser.parse_args()
    if Path.cwd() != Path('/ws') or platform.system() != 'Linux' or platform.machine() != 'aarch64':
        parser.error('Run only via docker exec -w /ws <approved-worker> python3 tools/local-transcription-image/smoke.py')
    evidence = Path(args.evidence); evidence.mkdir(parents=True, exist_ok=True)
    name = f'transcription-smoke-{os.getpid()}'
    fixture_volume, data_volume = f'{name}-fixture', f'{name}-data'
    loader, runner, holder = f'{name}-loader', f'{name}-runner', f'{name}-holder'
    try:
        docker('volume', 'create', fixture_volume); docker('volume', 'create', data_volume)
        with tempfile.TemporaryDirectory(prefix='transcription-public-', dir='/tmp') as tmp:
            fixture = Path(tmp) / 'jfk.wav'
            with urllib.request.urlopen(URL, timeout=120) as response:
                audio = response.read(352079)
            assert len(audio) == 352078 and hashlib.sha256(audio).hexdigest() == SHA
            fixture.write_bytes(audio); fixture.chmod(0o644)
            (evidence / 'fixture.txt').write_text(f'{URL}\n{SHA}  jfk.wav\n352078 bytes; public fixture only, not private call audio.\n')
            docker('create', '--name', loader, '--network', 'none', '--user', '0', '--mount',
                   f'type=volume,source={fixture_volume},target=/fixtures', '--entrypoint', 'sh', args.image, '-c', 'true')
            docker('cp', str(fixture), f'{loader}:/fixtures/jfk.wav'); docker('rm', loader)
        command = r'''
set -eu
umask 077
sh tools/local-transcription-image/preflight.sh
T=$(mktemp -d /data/transcription/public-full-XXXXXXXX)
trap 'rm -rf "$T"' EXIT HUP INT TERM
whisper-cli -m /opt/models/ggml-base.en.bin -f /fixtures/jfk.wav -t 4 -p 1 -l en -ng -otxt -of "$T/transcript"
test -s "$T/transcript.txt"
cat "$T/transcript.txt"
grep -qi 'ask not what your country' "$T/transcript.txt"
node tools/local-transcription-image/public-helper.js
printf '\nPASS: fresh public English fixture + actual helper; not call accuracy/hardware-capacity proof.\n'
'''
        common = ['--platform', 'linux/arm64', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev',
                  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', f'type=volume,source={data_volume},target=/data']
        with (evidence / 'offline-smoke.txt').open('w') as out:
            subprocess.run(['docker', 'run', '--rm', '--name', runner, *common, '--mount',
                            f'type=volume,source={fixture_volume},target=/fixtures,readonly', '--entrypoint',
                            '/sbin/tini', args.image, '--', 'sh', '-c', command], check=True, stdout=out, stderr=subprocess.STDOUT)
        # Two actual independent container PID namespaces share one private volume.
        module = 'const {WriterLock}=require("./src/features/local-transcription/lock");'
        acquire = module + 'const lock=new WriterLock({root:"/data/transcription"});lock.acquire().then(()=>{console.log("LOCKED");setInterval(()=>{},1000)}).catch(()=>process.exit(2));'
        docker('run', '-d', '--name', holder, *common, '--entrypoint', '/sbin/tini', args.image, '--', 'node', '-e', acquire)
        for _ in range(100):
            if 'LOCKED' in docker('logs', holder, capture=True): break
            time.sleep(0.05)
        else: raise AssertionError('Cross-container holder failed')
        busy = module + 'const lock=new WriterLock({root:"/data/transcription"});lock.acquire().then(async()=>{await lock.release();process.exitCode=1}).catch(e=>{if(e.code!=="WRITER_LOCK_BUSY")process.exitCode=2;else console.log("PASS: second container excluded by OS flock")});'
        output = docker('run', '--rm', *common, '--entrypoint', 'node', args.image, '-e', busy, capture=True)
        docker('stop', '--time', '5', holder); docker('rm', holder)
        released = module + 'const lock=new WriterLock({root:"/data/transcription"});lock.acquire().then(async()=>{await lock.release();console.log("PASS: next container acquired after holder stopped")}).catch(()=>process.exit(2));'
        output += docker('run', '--rm', *common, '--entrypoint', 'node', args.image, '-e', released, capture=True)
        (evidence / 'cross-container-lock.txt').write_text(output)
        metadata = docker('image', 'inspect', args.image, '--format', '{{.Id}} {{.Os}}/{{.Architecture}} user={{.Config.User}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}', capture=True)
        (evidence / 'image.txt').write_text(metadata)
        print('PASS: offline image/public fixture/helper and actual cross-container flock; evidence:', evidence)
    finally:
        for container in (runner, loader, holder):
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for volume in (fixture_volume, data_volume):
            subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == '__main__':
    main()
