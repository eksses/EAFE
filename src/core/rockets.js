'use strict';

const Logger = require('../logger');
const { angleDiff } = require('../utils');
const { countRockets, autoEquipRocket } = require('./inventory');

function createRocketEngine(ctx) {
  let dolphinBoostTime = 0;
  let lastSkipLog = 0;

  function fireRocketDirect(targetYawCheck = null) {
    const { bot, state } = ctx;
    if (!bot.entity.elytraFlying) return false;

    if (Date.now() - dolphinBoostTime < 500) return false;

    if (targetYawCheck !== null) {
      const err = angleDiff(bot.entity.yaw, targetYawCheck);
      if (err > 0.26) {
        ctx.lookForce(targetYawCheck, state.currentMode.pitch);
        return false;
      }
    }

    const offhand = bot.inventory.slots[45];
    if (offhand?.name !== 'firework_rocket') {
      autoEquipRocket(bot).catch(() => {});
    }

    try {
      bot.activateItem(true);
      dolphinBoostTime = Date.now();
      const p = bot.entity.position;
      Logger.debug(`rocket Y=${p.y.toFixed(1)} rkt=${countRockets(bot) - 1}`);
      return true;
    } catch(e) {
      Logger.warn('rocket err:', e.message);
      return false;
    }
  }

  function shouldFireRocketDynamic(pos, vel, maxAltCeiling = 180) {
    const { bot } = ctx;
    if (!bot.entity.elytraFlying || countRockets(bot) === 0) return false;
    if (Date.now() - dolphinBoostTime < 3000) return false;
    if (pos.y >= maxAltCeiling) return false;

    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed < 0.40) return true;
    if (pos.y < maxAltCeiling - 30 && speed < 0.60) return true;
    return false;
  }

  function smartFireRocket() {
    const { bot, state } = ctx;
    if (!bot.entity.elytraFlying) return false;

    const vel = bot.entity.velocity;
    const speed = Math.hypot(vel.x, vel.y, vel.z);

    if (speed >= state.currentMode.speedGate) {
      if (Date.now() - lastSkipLog > 5000) {
        Logger.debug(`rkt skip ${(speed * 20).toFixed(0)}m/s`);
        lastSkipLog = Date.now();
      }
      return false;
    }

    const ping = bot.player?.ping ?? 50;
    if (ping > 500) {
      Logger.warn(`ping ${ping}ms -- throttle`);
      return false;
    }

    // Cooldown: 3 seconds between rockets
    if (Date.now() - dolphinBoostTime < 3000) return false;

    return fireRocketDirect(ctx.yawTo(state.activeTargetX, state.activeTargetZ));
  }

  function getBoostTime() {
    return dolphinBoostTime;
  }

  return { fireRocketDirect, shouldFireRocketDynamic, smartFireRocket, getBoostTime };
}

module.exports = { createRocketEngine };
