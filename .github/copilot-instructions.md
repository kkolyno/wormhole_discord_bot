# Wormhole Discord Bot

## Project Overview
This is a Discord bot built with Discord.js v14 and Node.js.

## Project Structure
- `src/` - Main source code
  - `commands/` - Slash command handlers
  - `events/` - Discord event handlers
  - `utils/` - Utility functions
- `config.json` - Bot configuration (token, client ID)
- `index.js` - Main entry point

## Development Guidelines
- Use ES6+ JavaScript features
- Follow Discord.js v14 patterns for slash commands
- Store sensitive data (bot token) in config.json (gitignored)
- Use proper error handling for Discord API calls

## Commands
Commands are organized in the `src/commands/` folder with each command as a separate file exporting:
- `data` - SlashCommandBuilder definition
- `execute` - Async function to handle the command

## Events
Events are in `src/events/` folder, each file exports:
- `name` - Event name (e.g., 'ready', 'interactionCreate')
- `once` - Boolean for one-time events
- `execute` - Async function to handle the event

## Changelog
When making changes, update `CHANGELOG.md` following the format in `.github/CHANGELOG_INSTRUCTIONS.md`.
