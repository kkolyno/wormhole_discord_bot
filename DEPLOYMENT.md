# Oracle deployment and recovered Hermes context

> **Historical deployment/access record, not a transcription design.** This file
> records a prior recovery session's observations; the documentation cleanup did
> not contact the host or independently revalidate those observations. Confirm live
> status, hardware, and configuration before using them for implementation or
> deployment. See [HANDOFF.md](HANDOFF.md) for current transcription requirements.

The prior recovery session recorded verification on **2026-10-15** for the deployed
`wormhole_discord_bot`, rather than the placeholder configuration in the general
README. The observations below describe that verification, not a fresh host check.

## Deployment identity

| Item | Value |
| --- | --- |
| Bot container | `Oracle` |
| Compose service | `meeting-helper-bot` |
| Compose project | `wormholediscordbot` |
| OMV stack display name | `wormhole discord bot` |
| OMV stack UUID | `d5e4c8ad-09c6-4a9b-8f8f-473355d75d76` |
| Host | `192.168.1.100` (saved mDNS hostname also verified) |
| Management API | `http://192.168.1.100/rpc.php` |
| Image | `ghcr.io/kkolyno/wormhole_discord_bot:latest` |
| Running image ID at verification | `b44105db8c52` |
| Restart policy | `unless-stopped` |
| Build target | `linux/arm64` (see `.github/workflows/docker-publish.yml`) |
| Historical hardware identification | FriendlyElec CM3588 / Rockchip RK3588, from Hermes history |

The live `ps`, `images`, and resolved Compose configuration were checked through
OMV. The container was running. No restart, image pull, deployment, or application
source changes were performed during recovery.

**Access correction:** Hermes's successful management route was the OMV web/RPC
API. Its history contains failed SSH attempts to the OMV host. SSH to Hermes at
`kasey@192.168.1.241` works, but that is a different machine; do not assume OMV SSH
access works or that its web-admin password is an SSH credential.

## Files available on this checkout

| File | Purpose | Handling |
| --- | --- | --- |
| `scripts/omv-bot.py` | Standard-library Python read-only management helper | Safe to track |
| `DEPLOYMENT.md` | Deployment identity, access, and update procedure | Safe to track; contains LAN/channel identifiers |
| `.private/omv.json` | OMV URL and recovered admin login | Git/Docker ignored, mode `0600`, parent `0700` |
| `.env.local` | Bot environment recovered from **live** Compose config | Git/Docker ignored, mode `0600` |

The OMV login is an **administrator credential**, not a bot-scoped credential.
Never paste either private file into issues/chat, commit them, or include them in
build contexts. These files are plaintext locally, not encrypted storage. They
are deliberately not included when cloning the repository elsewhere. Prefer a
password manager for long-term credential storage.

The API uses HTTP on the LAN, as in the existing deployment; credentials are not
TLS-protected on that hop. Use only on the trusted LAN. The helper bypasses HTTP
proxy environment variables so LAN credentials aren't sent to an external proxy.

## Read-only access from this Mac

No Hermes runtime, Node dependencies, or additional Python packages are required:

```bash
cd /Users/kasey/Documents/GitHub/wormhole_discord_bot
python3 scripts/omv-bot.py status
python3 scripts/omv-bot.py images
python3 scripts/omv-bot.py config  # sensitive environment values are redacted
```

If mDNS fails, use the verified IP override:

```bash
python3 scripts/omv-bot.py status --base-url http://192.168.1.100
```

To recover the environment again after intentionally moving/removing the previous
`.env.local`:

```bash
python3 scripts/omv-bot.py export-env
```

This writes a new `0600` file and **refuses to overwrite an existing file**. It does
not print the Discord token or start the bot. The helper intentionally exposes no
restart, deploy, arbitrary-command, or raw-config action.

### Verified non-secret live environment

```dotenv
ALERTS_CHANNEL_ID=1465216403241041981
CLIENT_ID=1465236568536252527
EMPTY_GRACE_SECONDS=90
GUILD_ID=1465125548379607094
VOICE_CHANNEL_ID=1465125550036090883
# DISCORD_TOKEN is only in the ignored .env.local file.
```

Other optional settings are absent from the live Compose environment and use
application defaults. The live resolved configuration has no application bind
mount or published port; deployment consumes a prebuilt image, not a source
checkout on OMV.

## Using the recovered bot settings locally

**Do not run a second instance using the production token while Oracle is
running.** It can cause duplicate events/messages and conflicting bot behavior.
Use a separate development bot/token and test channels, or explicitly coordinate
a production stop before testing with the recovered token. No local bot was
started during recovery.

The application does not load `.env.local` automatically. With dependencies
installed and a Node version supporting `--env-file`, an intentionally authorized
run can use:

```bash
node --env-file=.env.local index.js
```

There is an existing configuration mismatch in the repository: `docker-compose.yml`
passes `NOTES_TEXT_CHANNEL_ID`, but the current application reads
`ALERTS_CHANNEL_ID` in `src/features/meetings/config.js`. The live OMV configuration
correctly uses `ALERTS_CHANNEL_ID`. Do not blindly deploy the repository's local
Compose file as the production stack. Also, Compose's `--env-file` only supplies
interpolation values; it does not automatically pass every value to the container.
The local Compose file builds source and names the container `meeting-helper-bot`,
whereas production pulls the GHCR image and names the container `Oracle`.

## Updating production (only when explicitly requested)

1. Push changes to `main`.
2. Wait for `.github/workflows/docker-publish.yml` to successfully build and
   publish the ARM64 image to GHCR. The workflow publishes `latest` and a commit
   SHA tag; a push alone is not proof the image is available.
3. In OMV's Compose management UI, select **wormhole discord bot**, not PlexStack
   or another stack. Pull its image, then recreate/up the bot service.
4. Check status, image identity, and bot behavior after deployment.

The equivalent commands, **on the deployment host with the correct production
Compose file selected**, are:

```bash
docker compose pull meeting-helper-bot
docker compose up -d --no-deps --force-recreate meeting-helper-bot
```

Do not run those commands against this checkout's different local Compose file.
A plain restart reuses the existing image; it does **not** fetch a new `latest`.
Record the old image/digest and preserve the current stack configuration before
an update so rollback remains possible.

### OMV RPC mechanics for future automation

The helper contains the tested login and background-output polling implementation.
The API uses JSON POST requests to `/rpc.php` with
`{"service": ..., "method": ..., "params": ...}`:

- `Session.login`: `username` and `password`; retain the
  `OPENMEDIAVAULT-SESSIONID` cookie/session ID, never log it.
- `Compose.enumerateFiles` with `{}` lists stack names and UUIDs.
- `Compose.getFileList` requires pagination parameters such as
  `{"start": 0, "limit": 100}` on this installation.
- `Compose.getContainers` with `{}` lists containers.
- `Compose.doCommand` with `{"uuid": "<stack UUID>", "command": "ps"}` returns
  a background execution filename. Commands are **Compose subcommands**, not
  arbitrary host shell commands. Use the bot's UUID above.
- `Exec.getOutput` with `{"filename": "<returned filename>", "pos": 0}` returns
  output, a next `pos`, and `running` / `pendingOutput`. Advance `pos` and poll
  until both flags are false. Raw `config` output contains the production token.

For a future explicitly authorized update, the same `Compose.doCommand` mechanism
can submit `pull meeting-helper-bot`, followed only after confirmed success by
`up -d --no-deps --force-recreate meeting-helper-bot`. The provided helper refuses
these mutating commands by design; use the UI or deliberate reviewed automation.

## Provenance and limits

Relevant history was read from Hermes's SQLite database in read-only mode:

- Host: `kasey@192.168.1.241`
- Database: `/home/kasey/.hermes/state.db`
- Bot/deployment discussion: session `20260619_143516_3d115e7f`, notably messages
  `633`–`647` (API access, stack identity, resolved configuration, update semantics).
- Later working API login example: session `20261010_190609_6dc2e8f9`, message
  `1335`; credentials were extracted without executing historical tool calls or
  printing the password.

The credentials were then tested directly from this checkout, and bot environment
values were obtained afresh from OMV rather than trusting an old saved token.
Only bot-related context and the necessary OMV login were retained, not Hermes's
whole database, unrelated service credentials, memories, or SSH private keys.
No production source filesystem was copied: this deployment uses the GHCR image.
