# Meeting Helper Bot

A Discord bot that detects when people join a voice channel and prompts for meeting notes using [NotesBot](https://notesbot.app/). Designed for one-click deployment via Portainer/OMV using a prebuilt GHCR image.

## Local Transcription Work — Start Here

See [HANDOFF.md](HANDOFF.md) for the current requirements and next steps for robust
RK3588 call transcription. The previous transcription plan was rejected and removed.
**Transcription is not implemented yet.** The behavior below describes the legacy
NotesBot-helper code, not the intended transcription feature.

## Existing Oracle Deployment

For recorded OMV deployment context, read-only management commands, and the
production update procedure, see [DEPLOYMENT.md](DEPLOYMENT.md). Recheck live status
before relying on historical observations; the local Compose file is not the
production stack.
Local credentials are kept in Git-ignored `.private/omv.json` and `.env.local`;
never commit them or run a duplicate bot using the production token.

## Features

- 🎙️ **Voice Channel Monitoring** - Detects when humans join a specific voice channel
- 📋 **One-Click Prompts** - Posts a "Meeting detected" message with Start/No buttons
- 🤖 **NotesBot Integration** - Guides users to run NotesBot commands (`/join` and `/leave`)
- 🔄 **Prompt Grace Timer** - Delays session reset; see current lifecycle limitations below
- 📝 **Discord Logging** - Optional log channel for monitoring bot activity and errors
- 🔌 **Startup Occupancy Check** - Posts a fresh prompt when humans are present; does not restore a previous session
- 🐳 **Docker Deployment** - Current helper uses environment variables and in-memory state; durable transcription storage is not implemented

## Quick Start (Portainer)

1. Create a Discord bot at the [Discord Developer Portal](https://discord.com/developers/applications)
2. Deploy using the Portainer stack below
3. Invite the bot to your server with required permissions

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Bot application/client ID |
| `GUILD_ID` | Discord server (guild) ID |
| `VOICE_CHANNEL_ID` | Voice channel ID to monitor |
| `ALERTS_CHANNEL_ID` | Text channel ID for meeting prompts (tags users in VC) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_ROLE_ID` | - | Role ID to mention in prompts |
| `LOG_CHANNEL_ID` | - | Text channel ID for bot logs (errors, status updates) |
| `EMPTY_GRACE_SECONDS` | `90` | Grace timer duration; current code starts it at one or zero humans and checks for emptiness on expiry |
| `JOIN_GRACE_SECONDS` | `15` | Legacy setting; the join-grace timer is not invoked by the current voice handler |
| `NOTESBOT_START_COMMAND` | `/join` | Command to start NotesBot recording |
| `NOTESBOT_STOP_COMMAND` | `/leave` | Command to stop NotesBot and generate notes |
| `NOTES_START_HINT` | - | Custom message for "notes started" follow-up |
| `PROMPT_TEXT` | - | Custom "meeting detected" prompt text |

## Getting Discord IDs

1. Enable **Developer Mode** in Discord:
   - User Settings → App Settings → Advanced → Developer Mode
2. Right-click on any server, channel, or role
3. Click **Copy ID**

## Discord Developer Portal Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to **Bot** section:
   - Click **Reset Token** and copy the token (this is your `DISCORD_TOKEN`)
   - Under **Privileged Gateway Intents**, ensure **Server Members Intent** is OFF (not needed)
4. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `View Channels`, `Send Messages`
5. Copy the generated URL and open it to invite the bot to your server

### Required Bot Permissions

The bot needs these permissions in the notes text channel:
- View Channel
- Send Messages

The bot does **not** need:
- Voice permissions (it doesn't join voice channels)
- Message Content intent (it only reads button interactions)
- Presence or Members intents

## Portainer Stack (Docker Compose)

Create a new stack in Portainer with this configuration:

```yaml
version: "3.8"

services:
  meeting-helper-bot:
    image: ghcr.io/YOUR_USERNAME/wormhole_discord_bot:latest
    container_name: meeting-helper-bot
    restart: unless-stopped
    environment:
      # Required
      - DISCORD_TOKEN=your_bot_token_here
      - CLIENT_ID=123456789012345678
      - GUILD_ID=123456789012345678
      - VOICE_CHANNEL_ID=123456789012345678
      - ALERTS_CHANNEL_ID=123456789012345678
      # Optional
      - PING_ROLE_ID=123456789012345678
      - LOG_CHANNEL_ID=123456789012345678
      - EMPTY_GRACE_SECONDS=90
      - JOIN_GRACE_SECONDS=15
      # - NOTESBOT_START_COMMAND=/join
      # - NOTESBOT_STOP_COMMAND=/leave
```

Replace:
- `YOUR_USERNAME` with your GitHub username (lowercase)
- `your_bot_token_here` with the bot token from Discord Developer Portal
- All ID values with actual Discord IDs

## How It Works

### Current Legacy Behavior

1. While inactive, a voice update with two or more humans triggers a meeting prompt.
   Startup also posts a fresh prompt if any humans are already present. A lone join
   during normal operation does not invoke the unused join-grace timer.
2. **Start Notes** provides instructions for manually running NotesBot commands;
   this bot does not start recording. **No** declines the prompt, and **Wait for
   More** waits for another join before prompting again.
3. For prompted/waiting sessions, dropping to one or zero humans starts the grace
   timer. At expiry, a zero-human result triggers the participant-duration summary
   and reset. This is not necessarily a full grace interval after the last leave.
4. Session state and participant tracking are in memory and are lost on restart.

Known timer, concurrency, fetch-failure, and shutdown limitations are documented
in [HANDOFF.md](HANDOFF.md). This lifecycle must be reviewed before adding capture
and durable transcript publication.

## Local Development

```bash
# Install dependencies
npm install

# Use a separate development bot, never a duplicate production instance.
export DISCORD_TOKEN=your_development_token
export CLIENT_ID=your_client_id
export GUILD_ID=your_guild_id
export VOICE_CHANNEL_ID=your_voice_channel_id
export ALERTS_CHANNEL_ID=your_alerts_channel_id

# Run the bot
npm start
```

## Building Docker Image Locally

```bash
docker build -t meeting-helper-bot .

docker run -e DISCORD_TOKEN=xxx \
  -e CLIENT_ID=xxx \
  -e GUILD_ID=xxx \
  -e VOICE_CHANNEL_ID=xxx \
  -e ALERTS_CHANNEL_ID=xxx \
  meeting-helper-bot
```

## GitHub Actions

The repository includes a GitHub Actions workflow that automatically:
- Builds the Docker image on push to `main`
- Publishes to GitHub Container Registry (GHCR)
- Tags as `latest` and with the git commit SHA

After pushing to `main`, the image will be available at:
```
ghcr.io/YOUR_USERNAME/wormhole_discord_bot:latest
```

### Making the Package Public

By default, GHCR packages are private. To allow Portainer to pull without authentication:

1. Go to your GitHub profile → Packages
2. Find the `wormhole_discord_bot` package
3. Go to Package Settings → Danger Zone → Change visibility → Public

## Troubleshooting

### Bot doesn't respond to voice events
- Ensure the bot has **View Channel** permission on the voice channel
- Verify `VOICE_CHANNEL_ID` is correct (use Developer Mode to copy ID)

### Prompt not appearing
- Check `ALERTS_CHANNEL_ID` is correct
- Ensure bot has **Send Messages** permission in the alerts channel

### Container exits immediately
- Check logs: `docker logs meeting-helper-bot`
- Verify all required environment variables are set
- Ensure the Discord token is valid

### "Missing Access" errors
- Re-invite the bot with correct permissions
- Check channel-specific permission overrides

## License

MIT
