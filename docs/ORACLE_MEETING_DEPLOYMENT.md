# Oracle automatic meeting deployment — 2026-10-16

## Live artifact and policy

The user authorized updating Oracle and enabling company standing consent. The
operator published and activated the existing, reviewed application commit
`ea7ebe62ee5c8ba400599ac0888976809dc48b4f`; this is no longer source-only work.

- Image: `ghcr.io/kkolyno/wormhole_discord_bot:transcription-ea7ebe62ee5c8ba400599ac0888976809dc48b4f`
- Full local image ID: `sha256:3f606205611626ef1c44ba7011f819661ca131bd30cba3d2d5c84fad19918a4d`
- Registry digest: `sha256:2c927ffc10d6a67f91e7f847aac8d537a8d9da449495e8cd2ac0454beaa12c5f`
- Build: https://github.com/kkolyno/wormhole_discord_bot/actions/runs/38906692896
- Only stack/service/container: `d5e4c8ad-09c6-4a9b-8f8f-473355d75d76` / `meeting-helper-bot` / `Oracle`.
- Settings: `LOCAL_TRANSCRIPTION_ENABLED=true`,
  `LOCAL_TRANSCRIPTION_CONSENT_MODE=channel`,
  `LOCAL_TRANSCRIPTION_DATA_DIR=/data/transcription`,
  `LOCAL_TRANSCRIPT_ATTACHMENTS=false`.
- Separate local named volume `oracle-meeting-transcription-data` at `/data`;
  45-second stop grace; image Tini; `node index.js`.
- Original guild/voice/alerts settings preserved. Discord metadata freshly identifies
  the configured location as **Wormhole / water-cooler**. No voice channel with
  “meeting” in its name was found in that guild. Ask the user to confirm this is
  the room they mean; do not silently expand recording into another server/channel.

## Evidence and limits

The GitHub ARM64 build ran **209/209 tests**, offline native checks and fixed-hash
public English recognition before pushing the same tested image. The operator
compared the pulled full ID and RepoDigest with the successful build, not just a
SHA-shaped tag.

The new bounded operator helper passed **58 fake tests**, including 38 original
administration regressions and 20 meeting-deployment checks. Initial read-only
snapshot validation rejected the deployed Compose's named-volume representation:
`HostConfig.Binds=["oracle-transcription-data:/data:rw"]` rather than structured
`HostConfig.Mounts`. No source/container was changed by that rejection. A narrow
correction plus regression accepts exactly the expected named-volume serialization
while still requiring Docker's actual mount to be a local RW named volume. Extra,
read-only, host-path or conflicting mount declarations remain rejected. Explicit
`resume-snapshot` completed the same private journal.

Fresh source/config/runtime checks verified the exact previous one-shot baseline
and original rollback pin. Immediately before activation, global volume inventory
confirmed the new meeting volume did not exist. Only the bot service was pulled
and recreated; all original environment/source fields and unrelated stack settings
were compared against the exact allowlist. Full new runtime, image, command,
entrypoint, environment, mount, network/restart and stop timeout passed validation.

After activation:

- Oracle was running the expected full image ID.
- Private bounded log checks found startup and Discord login markers, with zero
  fixed login/config error markers. These are hints, not feature-health proof.
- An operator-only, read-only probe inside the existing container confirmed numeric
  UID/GID1001, private root mode0700 and an actually held kernel writer lock.
  It did not open PCM or recognition-job files, change controls, or start another
  Discord client. No private speech was copied to workers/repository/logs.
- The bounded session-metadata probe reported zero session records at that
  observation. Discord's GET bot voice state returned HTTP404 / code10065
  (unknown voice state), so **voice join/capture was not verified**. Do not claim
  the user is being recorded merely because the container logged in.

The user has clarified that typical meetings last one to two hours with multiple
speakers. The four-hour cap permits that duration; sustained multi-speaker
throughput, backlog, thermals and complete final delivery remain **unverified**.
Attachments are still unapproved/off; oversized canonical summaries are held,
not silently truncated. Source/native tests are not a long target meeting test.

## Private journal and exact-original rollback

New journal: `.private/oracle-meeting-live-ea7ebe62-20261016/`.
Previous journal remains `.private/oracle-transcription-live-20261015b/`.
All raw source/config/inspect/log evidence is private; do not publish these files.
The new journal preserves both the freshly checked prior one-shot deployment and
the exact original pre-transcription snapshot/pin.

Read [`../scripts/ORACLE-MEETING-OPERATIONS.md`](../scripts/ORACLE-MEETING-OPERATIONS.md)
and use **only the new helper** with this new journal:

```sh
python3 -B scripts/oracle-meeting-deploy.py status \
  --backup-dir "$PWD/.private/oracle-meeting-live-ea7ebe62-20261016"

# Only when the operator deliberately decides to restore the exact ORIGINAL bot:
python3 -B scripts/oracle-meeting-deploy.py rollback \
  --backup-dir "$PWD/.private/oracle-meeting-live-ea7ebe62-20261016" \
  --authorize-live-change
```

Exact original image remains
`sha256:b44105db8c52b15918f068653f0c52eaa2d1c2e70cfc0220a2e3b72b9d379edc`.
Rollback recreates only Oracle without the transcription mount, then restores the
exact original source if its local source reference still points to that ID.
Neither data volume is deleted. No one-shot marker was erased or rearmed, and
rollback does not restart one-shot test code. Keep all journals/images/volumes;
never reuse this completed activation job for another deployment.

## Development isolation

The helper/tests were developed and executed in credential-free worker
`sb_92cddad9`, workspace
`~/Documents/GitHub/_agent-sandbox/wormhole-meeting-deploy`. No vault, orchestrator,
production credentials or speech entered that workspace. Only the parent/operator
loaded credentials privately for live administration. Application code, packages,
legacy meeting source, original Dockerfile, main and rollback branch were not
changed by this deployment-helper work.
