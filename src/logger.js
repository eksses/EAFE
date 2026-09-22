'use strict';

/**
 * Lightweight prefixed logger.
 *
 * Use {@link createLogger} for per-instance loggers (recommended — multiple
 * ElytraFlight instances no longer share global debug state):
 *
 *   const log = createLogger({ debug: true, prefix: '[E:Scout1]' });
 *
 * The default singleton (module export) is kept for backward compatibility.
 */
function createLogger({ debug = false, prefix = '[E]', console: sink = console } = {}) {
  let _debug = debug;
  return {
    setDebug(on) { _debug = Boolean(on); },
    isDebug() { return _debug; },
    debug(...args) { if (_debug) sink.log(prefix, ...args); },
    info(...args) { sink.log(prefix, ...args); },
    warn(...args) { sink.warn(prefix, ...args); },
    error(...args) { sink.error(prefix, ...args); },
  };
}

const Logger = createLogger({ debug: false });

module.exports = Logger;
module.exports.Logger = Logger;
module.exports.createLogger = createLogger;
