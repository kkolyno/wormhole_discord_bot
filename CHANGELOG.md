# Changelog

All notable changes to Oracle will be documented in this file.

## [Unreleased]

### Added
- Clean handoff for robust local RK3588 call transcription: process during calls,
  publish the final meeting summary only after transcription completes.

### Changed
- Clarified current helper behavior, required client ID, and deployment-document
  provenance; no runtime behavior or production deployment changed.

### Removed
- Rejected transcription plan and stale coding guidance that prescribed incorrect
  credential storage.

## [0.0.3] - 2026-01-26

### Fixed
- Docker build now includes `src/` directory (was causing "Cannot find module" errors)

## [0.0.2] - 2026-01-26

### Changed
- Meeting prompts now appear immediately when 2+ users join voice channel (removed join grace timer delay)

## [0.0.1] - 2026-01-26

### Added
- Voice channel monitoring
- Meeting detection prompts with Start/No buttons
- NotesBot integration
- Role pinging for alerts
- Grace timer to prevent spam on brief disconnects
- Session recovery on bot restart
- Docker support with GHCR publishing
- Configurable environment variables for all settings
