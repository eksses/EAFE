'use strict';

const { angleDiff } = require('../utils');
const { countRockets, autoEquipRocket } = require('./inventory');

function createRocketEngine(ctx) {
  let lastRocketTime = 0;
  let lastSkipLog = 0;

  /**
   * Fire rocket directly. Returns true if fired.
   * @param {number|null} targetYawCheck - if set, waits (returns false) until
   *        yaw is within 0.26 rad of the heading, so the boost goes the right
   *        way. The caller should retry on the next tick.
   */
  function fireRocketDirect(targetYawCheck = null) {
    const { bot } = ctx;
    if (!bot.entity.elytraFlying) return false;

    // 1.5s cooldown between rockets
    if (Date.now() - lastRocketTime < 1500) return false;

    // Align yaw if needed (never fire a boost in the wrong direction)
    if (targetYawCheck !== null) {
      const err = angleDiff(bot.entity.yaw, targetYawCheck);
      if (err > 0.26) {
        ctx.lookForce(targetYawCheck, ctx.state?.currentMode?.pitch ?? -0.04);
        return false;
      }
    }

    // Ensure rocket in offhand — never fire an empty offhand (the old code
    // fired anyway and consumed the cooldown)
    const offhand = bot.inventory.slots[45];
    if (offhand?.name !== 'firework_rocket') {
      autoEquipRocket(bot, { includeCustom: ctx.opts.autoRocketCustomStars }).catch(() => {});
      return false;
    }

    try {
      bot.activateItem(true);
      lastRocketTime = Date.now();
      ctx.logger.debug(`rocket Y=${bot.entity.position.y.toFixed(1)} rkt=${countRockets(bot) - 1}`);
      return true;
    } catch (e) {
      ctx.logger.warn('rocket err:', e.message);
      return false;
    }
  }

  /**
   * Smart fire — respects speed gate, high ping and cooldown.
   */
  function smartFireRocket() {
    const { bot, state } = ctx;
    if (!bot.entity.elytraFlying) return false;

    const vel = bot.entity.velocity;
    const speed = Math.hypot(vel.x, vel.y, vel.z);

    // Skip if at speed gate
    if (speed >= state.currentMode.speedGate) {
      if (Date.now() - lastSkipLog > 5000) {
        ctx.logger.debug(`rkt skip ${(speed * 20).toFixed(0)}m/s`);
        lastSkipLog = Date.now();
      }
      return false;
    }

    // Skip if high ping
    if ((bot.player?.ping ?? 50) > 500) return false;

    // 3s cooldown
    if (Date.now() - lastRocketTime < 3000) return false;

    return fireRocketDirect(ctx.yawTo(state.activeTargetX, state.activeTargetZ));
  }

  function getBoostTime() {
    return lastRocketTime;
  }

  return { fireRocketDirect, smartFireRocket, getBoostTime };
}

module.exports = { createRocketEngine };
