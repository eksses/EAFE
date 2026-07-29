'use strict';

const config = require('../config');
const Logger = require('../logger');

function createChat(ctx) {
  let lastChatTimestamp = 0;

  function safeChat(msg) {
    if (!msg || typeof msg !== 'string') return;
    if (Date.now() - lastChatTimestamp < 4000) return;
    lastChatTimestamp = Date.now();
    try { ctx.bot.chat(msg.substring(0, 256)); } catch(_) {}
  }

  function ownerTell(msg) {
    if (!config.OWNER_USERNAME) return;
    if (!msg || typeof msg !== 'string') return;
    try { ctx.bot.whisper(config.OWNER_USERNAME, msg.substring(0, 256)); } catch(_) {}
  }

  function setPhase(p, msg) {
    ctx.state.phase = p;
    const line = msg ? `[${p}] ${msg}` : `[${p}]`;
    Logger.info(line);
    ownerTell(line);
  }

  function emergencyStop(reason) {
    ctx.state.phase = ctx.PHASE.IDLE;
    ctx.state.spatialClear = false;
    ctx.clearTimers();
    try { ctx.bot.pathfinder.stop(); } catch(_) {}
    ['sprint','forward','back','left','right','jump','sneak'].forEach(k => {
      try { ctx.bot.setControlState(k, false); } catch(_) {}
    });
    try { ctx.bot.setControlState('sneak', true); } catch(_) {}
    setTimeout(() => { try { ctx.bot.setControlState('sneak', false); } catch(_) {} }, 600);
    Logger.info(`STOP ${reason}`);
    ownerTell(`STOP: ${reason}`);
  }

  return { safeChat, setPhase, emergencyStop, ownerTell };
}

module.exports = { createChat };
