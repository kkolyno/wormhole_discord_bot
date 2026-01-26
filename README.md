# Meeting Helper Bot

A Discord bot that detects when people join a voice channel and prompts for meeting notes using [NotesBot](https://notesbot.app/). Designed for one-click deployment via Portainer/OMV using a prebuilt GHCR image.

## Features

- 🎙️ **Voice Channel Monitoring** - Detects when humans join a specific voice channel
- 📋 **One-Click Prompts** - Posts a "Meeting detected" message with Start/No buttons
- 🤖 **NotesBot Integration** - Guides users to run NotesBot commands (`/join` and `/leave`)
- 🔄 **Anti-Spam Protection** - Grace timer prevents duplicate prompts during brief disconnects
- 📝 **Discord Logging** - Optional log channel for monitoring bot activity and errors
- 🛡️ **Graceful Failure** - Robust error handling keeps the bot running even when issues occur
- 🔌 **Restart Recovery** - Detects users already in voice channel on bot restart
- 🐳 **Docker-First** - No filesystem mounts needed, runs entirely from environment variables

## Quick Start (Portainer)

1. Create a Discord bot at the [Discord Developer Portal](https://discord.com/developers/applications)
2. Deploy using the Portainer stack below
3. Invite the bot to your server with required permissions

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `GUILD_ID` | Discord server (guild) ID |
| `VOICE_CHANNEL_ID` | Voice channel ID to monitor |
| `ALERTS_CHANNEL_ID` | Text channel ID for meeting prompts (tags users in VC) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_ROLE_ID` | - | Role ID to mention in prompts |
| `LOG_CHANNEL_ID` | - | Text channel ID for bot logs (errors, status updates) |
| `EMPTY_GRACE_SECONDS` | `90` | Seconds to wait before resetting after channel empties |
| `JOIN_GRACE_SECONDS` | `15` | Seconds to wait after first join before posting prompt |
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

### Session State Machine

```
┌─────────────┐     Human joins     ┌─────────────┐
│  INACTIVE   │ ─────────────────▶ │  PROMPTED   │
│             │                     │             │
│  (waiting)  │ ◀───────────────── │  (active)   │
└─────────────┘   Grace expires    └─────────────┘
                  & channel empty
```

1. **INACTIVE**: Bot is waiting for humans to join the voice channel
2. **PROMPTED**: A prompt has been posted; no new prompts until session resets
3. **Grace Timer**: When all humans leave, waits 90s (configurable) before resetting

### User Flow

1. First human joins the monitored voice channel
2. Bot posts "Meeting detected" prompt with **Start Notes** and **No** buttons
3. User clicks a button:
   - **Start Notes**: Bot posts instructions to run `/join` and `/leave`
   - **No**: Bot acknowledges and waits
4. When all humans leave and grace period expires, session resets
5. Next human to join triggers a new prompt

## Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export DISCORD_TOKEN=your_token
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
