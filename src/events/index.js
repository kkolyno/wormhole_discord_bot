const ready = require('./ready');
const interactionCreate = require('./interactionCreate');
const { errorEvents, setupProcessHandlers } = require('./errors');

// Global events (not feature-specific)
const globalEvents = [ready, interactionCreate, ...errorEvents];

module.exports = { globalEvents, setupProcessHandlers };
