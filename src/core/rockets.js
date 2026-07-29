'use strict';

const Logger = require('../logger');
const { angleDiff } = require('../utils');
const { countRockets, autoEquipRocket } = require('./inventory');

function createRocketEngine(ctx) {
  let dolphinBoostTime = 0;
  let lastSkipLog = 0;

  /**
   * Fire rocket directly. Returns true if fired.
   * @param {number|null} targetYawCheck - if set, aligns yaw before firing
   */
  function fireRocketDirect(targetYawCheck = null) {
    const { bot } = ctx;
    if (!bot.entity.elytraFlying) return false;

    // 1.5s cooldown between rockets
    if (Date.now() - dolphinBoostTime < 1500) return false;

    // Align yaw if needed
    if (targetYawCheck !== null) {
      const err = angleDiff(bot.entity.yaw, targetYawCheck);
      if (err > 0.26) {
        ctx.lookForce(targetYawCheck, ctx.state?.currentMode?.pitch ?? -0.04);
        return false;
      }
    }

    // Ensure rocket in offhand
    const offhand = bot.inventory.slots[45];
    if (offhand?.name !== 'firework_rocket') {
      autoEquipRocket(bot).catch(() => {});
    }

    try {
      bot.activateItem(true);
      dolphinBoostTime = Date.now();
      Logger.debug(`rocket Y=${bot.entity.position.y.toFixed(1)} rkt=${countRockets(bot) - 1}`);
      return true;
    } catch(e) {
      Logger.warn('rocket err:', e.message);
      return false;
    }
  }

  /**
   * Smart fire — respects speed gate and cooldown.
   */
  function smartFireRocket() {
    const { bot, state } = ctx;
    if (!bot.entity.elytraFlying) return false;

    const vel = bot.entity.velocity;
    const speed = Math.hypot(vel.x, vel.y, vel.z);

    // Skip if at speed gate
    if (speed >= state.currentMode.speedGate) {
      if (Date.now() - lastSkipLog > 5000) {
        Logger.debug(`rkt skip ${(speed * 20).toFixed(0)}m/s`);
        lastSkipLog = Date.now();
      }
      return false;
    }

    // Skip if high ping
    if ((bot.player?.ping ?? 50) > 500) return false;

    // 3s cooldown
    if (Date.now() - dolphinBoostTime < 3000) return false;

    return fireRocketDirect(ctx.yawTo(state.activeTargetX, state.activeTargetZ));
  }

  function getBoostTime() {
    return dolphinBoostTime;
  }

  return { fireRocketDirect, smartFireRocket, getBoostTime };
}

module.exports = { createRocketEngine };
