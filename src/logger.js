'use strict';

const config = require('./config');

let _debug = config.DEBUG;

const Logger = {
  setDebug(on) { _debug = on; },
  isDebug() { return _debug; },

  debug(...args) {
    if (_debug) console.log('[E]', ...args);
  },

  info(...args) {
    console.log('[E]', ...args);
  },

  warn(...args) {
    console.warn('[E]', ...args);
  },

  error(...args) {
    console.error('[E]', ...args);
  },
};

module.exports = Logger;
