'use strict';

const config = require('./config');
const { MODES } = require('./constants');
const Logger = require('./logger');

function createCommandProcessor(ctx) {
  const { bot, state } = ctx;

  function processUserCommand(cmd) {
    cmd = cmd.trim().toLowerCase();
    if (!cmd) return;

    const tokens = cmd.split(/\s+/);
    const mainCmd = tokens[0];

    if (mainCmd === 'f' || mainCmd === 'fly') {
      if (tokens.length >= 3) {
        const nx = parseInt(tokens[1], 10);
        const nz = parseInt(tokens[2], 10);
        if (!isNaN(nx) && !isNaN(nz)) {
          state.activeTargetX = nx;
          state.activeTargetZ = nz;
          Logger.info(`target (${state.activeTargetX},${state.activeTargetZ})`);
          try { bot.chat(`Target: (${state.activeTargetX},${state.activeTargetZ})`); } catch(_) {}
        }
      } else if (tokens.length === 1) {
        Logger.info(`fly -> (${state.activeTargetX},${state.activeTargetZ})`);
      }

      state.retries = 0;
      state.spatialClear = false;
      ctx.startFlight();

    } else if (mainCmd === 'setgoal' || mainCmd === 'target' || mainCmd === 'settarget') {
      if (tokens.length >= 3) {
        const nx = parseInt(tokens[1], 10);
        const nz = parseInt(tokens[2], 10);
        if (!isNaN(nx) && !isNaN(nz)) {
          state.activeTargetX = nx;
          state.activeTargetZ = nz;
          Logger.info(`target (${state.activeTargetX},${state.activeTargetZ})`);
          try { bot.chat(`Target: (${state.activeTargetX},${state.activeTargetZ}) -- f to fly`); } catch(_) {}
        }
      }

    } else if (cmd === 'mode fast' || cmd === 'm fast' || cmd === 'fast') {
      state.currentMode = MODES.FAST;
      Logger.info(`mode ${MODES.FAST.name}`);
      try { bot.chat(`Mode: ${MODES.FAST.fullName}`); } catch(_) {}

    } else if (cmd === 'mode med' || cmd === 'm med' || cmd === 'mode medium' || cmd === 'med' || cmd === 'medium') {
      state.currentMode = MODES.MEDIUM;
      Logger.info(`mode ${MODES.MEDIUM.name}`);
      try { bot.chat(`Mode: ${MODES.MEDIUM.fullName}`); } catch(_) {}

    } else if (cmd === 'mode low' || cmd === 'm low' || cmd === 'mode efficient' || cmd === 'low' || cmd === 'efficient') {
      state.currentMode = MODES.EFFICIENT;
      Logger.info(`mode ${MODES.EFFICIENT.name}`);
      try { bot.chat(`Mode: ${MODES.EFFICIENT.fullName}`); } catch(_) {}

    } else if (cmd === 's' || cmd === 'stop') {
      state.retries = ctx.MAX_RETRIES;
      ctx.emergencyStop('user cmd');

    } else if (cmd === 'debug on' || cmd === 'debug') {
      Logger.setDebug(true);
      Logger.info('debug ON');

    } else if (cmd === 'debug off') {
      Logger.setDebug(false);
      Logger.info('debug OFF');

    } else if (cmd === 'status') {
      const p = bot.entity.position;
      const elytraInfo = ctx.getElytraSummary(bot);
      const rDist = ctx.spatial.getServerRenderDistance();
      const status = `phase=${state.phase} m=${state.currentMode.name} r=${rDist.chunks}ch t=(${state.activeTargetX},${state.activeTargetZ}) pos=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) fly=${bot.entity.elytraFlying} e=${elytraInfo.totalDurabilityAcrossAll} rkt=${ctx.countRockets(bot)}`;
      Logger.info(status);
      try { bot.chat(status); } catch(_) {}

    } else if (cmd === 'audit') {
      const rocketsAvail = ctx.countRockets(bot);
      const d2d = ctx.dist2D(state.activeTargetX, state.activeTargetZ);
      const reqRockets = ctx.calculateRequiredRockets(d2d, ctx.CRUISE_ALT - bot.entity.position.y);
      const heading = ctx.spatial.findBestLaunchHeading();
      const elytraInfo = ctx.getElytraSummary(bot);
      const reqDur = ctx.calculateRequiredElytraDurability(d2d, state.currentMode.speedMps, elytraInfo.bestUnbreaking);
      const rDist = ctx.spatial.getServerRenderDistance();
      const audit = `audit [${state.currentMode.name} ${rDist.chunks}ch]: rkt=${rocketsAvail}/${reqRockets} e=${elytraInfo.totalDurabilityAcrossAll}/${reqDur} U${elytraInfo.bestUnbreaking} hdg=${heading.headingName}`;
      Logger.info(audit);
      try { bot.chat(audit); } catch(_) {}
    }
  }

  return { processUserCommand };
}

module.exports = { createCommandProcessor };
