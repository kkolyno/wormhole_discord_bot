# Offline feasibility test results

The reviewed remediation verification below supersedes earlier test-count and
native-DAVE claims. Loading the `DAVESession` export does **not** establish that a
native binding (rather than WASI fallback) was used. No new dependencies were
installed during remediation; the initial install details below are prior-run
provenance, not an installation rerun.

## Scope and execution environment

All installs and execution used only ready container
`20bf49927b6dea531168d47cc7a8ad0f66142b0ad410cd190f6df04d6ff93b13`, with the
throwaway workspace mounted at `/ws`. No Discord connection/login, real audio
recording or inspection, production access/change, credential-file read, STT
installation, driver load, or SBC access was performed. No commits were made.

Observed runtime (not the RK3588 target):

- Linux `aarch64` / Node `linux arm64`.
- Ubuntu 24.04.4 LTS; kernel `7.0.14-orbstack-00380-ga7e0a2dc9535`.
- Node `v24.18.0`, npm `11.16.0`, Python `3.12.3`.
- Prior implementation recorded Docker client version `29.1.3, build
  29.1.3-0ubuntu3~24.04.2`; not re-executed during remediation. The collector now
  always reports both Docker and Node command versions as `unknown/not_run` and
  does not discover or execute inherited PATH wrappers. Node/package versions are
  independently reported by the explicitly run package preflight.

## Reproduction commands actually run

Initial dependency versions/engine requirements were queried using `npm view`
inside this same container. Final clean lockfile installation:

```sh
docker exec -w /ws/tools/feasibility 20bf49927b6dea531168d47cc7a8ad0f66142b0ad410cd190f6df04d6ff93b13 npm ci --ignore-scripts --no-audit --no-fund
```

Result: **30 packages installed**, exit 0. No install/build scripts were run. The
first attempted `opusscript@0.1.1` installation failed with npm ERESOLVE because
prism-media 1.3.5 optionally peers on `opusscript ^0.0.8`. The final lock pins
0.0.8, resolves normally, and uses neither `--force` nor `--legacy-peer-deps`.

The final verification command (re-run after all source/test changes):

```sh
docker exec -w /ws/tools/feasibility 20bf49927b6dea531168d47cc7a8ad0f66142b0ad410cd190f6df04d6ff93b13 sh -c 'npm test && npm run test:hardware && npm run preflight && npm ls --depth=0'
```

The hardware collector CLI was also exercised against **the sandbox only**, with
its JSON parsed and a small allowlisted runtime subset printed:

```sh
docker exec -w /ws/tools/feasibility 20bf49927b6dea531168d47cc7a8ad0f66142b0ad410cd190f6df04d6ff93b13 sh -c 'python3 hardware.py | python3 -c '\''import json,sys; x=json.load(sys.stdin); print(json.dumps({"schema":x["schema"], "runtime":x["runtime"], "os":x["os"], "versions":x["versions"], "scope":x["scope"]}))'\'' '
```

Result: valid schema-1 JSON; scope `read_only_snapshot_not_performance_evidence`,
with runtime values above, and Node/Docker versions both `unknown/not_run`.
No target snapshot has been collected or saved.

## Results

| Check | Observed result |
| --- | --- |
| Node offline tests | **13/13 passed**, 0 failed/skipped/cancelled |
| Python stdlib collector tests | **5/5 passed** |
| Offline default preflight | Exit 0; `mode: offline_preflight`; no login |
| `npm ls --depth=0` | Exit 0; exact direct pins, no invalid peer resolution |
| DAVE module/API | `@snazzah/davey` 0.1.12 module loaded, `DAVESession` API available; implementation **unknown** (native vs WASI not proven); receive/decrypt verified **false** |
| Opus choice | opusscript 0.0.8 **WASM** decoder constructed and synthetic encode/decode passed |
| Native Opus | `@discordjs/opus` not installed, not attempted, not used, not validated |
| Transport | Node AES-256-GCM available; no optional XChaCha fallback installed; negotiation not tested |

Pinned direct dependency versions observed in both preflight and npm tree:

```text
@discordjs/voice  0.19.2  (requires Node >=22.12.0; runtime satisfies it)
@snazzah/davey   0.1.12  (satisfies voice's ^0.1.9 range)
discord.js      14.27.0
prism-media     1.3.5
opusscript      0.0.8
```

### Node coverage

1. Interleaved per-speaker isolation using distinct decoder state; variable PCM
   sizes, during-call file growth, WAV header lengths, JSONL counters/times, private
   file/directory modes.
2. Last buffered packet flushed on EOF/stop; repeated speaking start retains manual
   subscription; stop is idempotent, files/codecs close, start listener removed.
3. Unexpected EOF is incomplete; resubscription accepts later utterances without
   replacing the speaker's codec/output.
4. Speaker, per-speaker/total PCM, packet-count/input-size/decoded-size limits.
5. Disk budget, partial/failed file writes, decoder errors, receive errors, and
   sanitized issue codes rather than raw exception details.
6. Bounded drain timeout, no-audio incomplete outcome, exclusive no-overwrite paths.
7. Missing consent/token/IDs (including required expected application ID),
   malformed/unsupported locally constructed tokens, production identities and
   invalid duration cannot reach the injected live/login boundary. In particular,
   a production-ID fake token with a false nonproduction expected ID and unrelated
   guild/channel IDs is refused **before login**. Actual postlogin identities must
   match the expected ID before join. Token decoding is a safety guard, not auth
   validation; no tokens or decoded payloads are printed.
8. Actual DAVE module load and real offline WASM Opus synthetic encode/decode at
   **120, 240, 480, 960, 1920, 2880 frames** (2.5–60 ms) with expected byte lengths.
9. The actual voice 0.19.2 `AudioReceiveStream`, paused with a confirmed final
   buffered packet, drains through base `Readable.prototype.push` EOF plus resume,
   bypassing the destructive overridden `push(null)`. Packet/PCM counters and clean
   drain are asserted. No Discord connection is involved.
10. Monotonic duration guard and manifest open/close/publish failure cannot return
    drained success; the final manifest is absent after failed close, and an
    existing final file is preserved rather than overwritten.
11. Real pinned REST request machinery with a fake transport: stopping during guild
    fetch aborts the underlying HTTP signal (not merely a raced await), never
    starts channel fetch, and refuses requests after shutdown. REST retries are
    zero, timeout three seconds, rate-limit queues rejected.
12. A delayed guild resolution that ignores cancellation still cannot start channel
    fetch after shutdown (including cache path).
13. A stalled fake REST transport is actually aborted at the three-second deadline,
    with only one attempt; no network call or login occurs.

### Collector coverage

- Root/runtime fixtures for model/compatible, OS, memory/load, distinct CPU types,
  cpufreq, thermal/trip data, module version, device metadata, library existence.
- CPU serials, nonallowlisted OS/memory fields and loadavg PID/task suffix excluded.
- Empty/missing fixtures are explicitly unknown; fixture commands never execute.
- Permission-denied and oversize reads; even host-root `commands=True` cannot
  discover or execute Node/Docker wrappers (mocked discovery/subprocess throw).
- Enumeration consumes only the capped number of matches before sorting.

Tests write only synthetic/fake data to private temporary sandbox directories and
remove it afterward. They do not produce retained call recordings. There is no
build step, hardware benchmark, accuracy benchmark, or production test suite here.

## Unverified gates / remaining work

- **RK3588/CM3588** hardware/OS/cooling/load/driver/runtime readings and sustained
  performance remain unknown. This ARM64 sandbox is not that board.
- **Discord/DAVE actual receive/decrypt** and transport-mode negotiation remain
  unconfirmed. Module/API load cannot establish native implementation or receive
  success; native versus WASI selection has not been independently proven.
- Two real consenting users, overlap, silence, short final utterances, join/leave,
  permissions failure, moved/deafened bot, reconnect and actual OS signals/network
  shutdown paths still require the separately authorized target live exercise in
  `README.md`. Core shutdown/drain is tested; the Discord network lifecycle is not.
- Reconnect deliberately stops/incompletes instead of claiming recovery. No RTP
  packet-loss accounting, reorder/replay, timeline reconstruction, dependency-memory
  hard limit, durable crash recovery or fsync guarantee is implemented. CPU/disk
  stalls and unreported DAVE discards can lose unknown upstream audio. Client cleanup
  is awaited with a timeout, not a guarantee all dependency handles exit on time.
- A successful local drain is named `drained_observed_audio`, never complete
  recording/transcription. Empty/failed/limited/interrupted runs are incomplete.
  The 120-second maximum is not guaranteed duration: the 16 MiB per-speaker cap
  permits about 87.4 seconds of continuous 48 kHz stereo s16 PCM, and other limits
  can stop earlier. This remains bounded feasibility capture, not durable capture.
- No representative STT benchmark, models, resampler, transcription/publication
  integration, or retained user audio exists. Future proper resampling must start
  from the 48 kHz stereo source and account for missing timeline gaps.
- SBC installation/start, a dev bot/token, consent policy, retention policy and an
  agreed nonproduction output path require separate user authorization.
