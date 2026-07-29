'use strict';

module.exports = {
  // Server connection (used by examples only, not the library)
  HOST: 'localhost',
  PORT: 25565,
  USERNAME: 'Bot',

  // Default flight settings
  DEFAULT_TARGET_X: 0,
  DEFAULT_TARGET_Z: 0,
  CRUISE_ALT: 180,
  MAX_RETRIES: 3,

  // Owner: receives important whispers (set to '' to disable)
  OWNER_USERNAME: '',

  // Debug logging (set to false for production)
  DEBUG: false,
};
