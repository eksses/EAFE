'use strict';

const Logger = require('../logger');
const { isHazardousBlock, isSafeSolidBlock } = require('../utils');

function createLandingEngine(ctx) {
  const { bot, state } = ctx;

  function startLanding() {
    const rDist = ctx.spatial.getServerRenderDistance();
    ctx.setPhase(ctx.PHASE.LANDING, `scan ${rDist.chunks}ch (${state.activeTargetX},${state.activeTargetZ})`);

    const safeSpot = ctx.wander.findSafeLandingSpotAround(state.activeTargetX, state.activeTargetZ);

    let targetX = safeSpot.x;
    let targetZ = safeSpot.z;

    if (!safeSpot.safe) {
      if (state.phase !== ctx.PHASE.WANDER_SCAN) {
        Logger.warn(`ocean at (${state.activeTargetX},${state.activeTargetZ}) -- scanning`);
        ctx.startWanderScan();
      }
      return;
    }

    Logger.debug(`spot (${targetX},${targetZ}) [${safeSpot.blockName}]`);

    const landCheck = setInterval(() => {
      if (state.phase !== ctx.PHASE.LANDING) { clearInterval(landCheck); return; }

      const pos = bot.entity.position;
      const groundBlock = ctx.spatial.getGroundBlockAt(targetX, targetZ);
      const relY = pos.y - (groundBlock?.position?.y ?? 60);

      ctx.checkMidFlightElytraSwap();

      const currentBlockUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      const overLiquid = !currentBlockUnder || !isSafeSolidBlock(currentBlockUnder);

      if ((overLiquid || ctx.dist2D(targetX, targetZ) > 1.5) && pos.y < 65) {
        if (ctx.countRockets(bot) > 0) {
          Logger.debug('liquid -- rkt center');
          ctx.lookForce(ctx.yawTo(targetX, targetZ), 0.40);
          ctx.fireRocketDirect();
        } else {
          ctx.lookForce(ctx.yawTo(targetX, targetZ), 0.05);
        }
      } else if (relY <= 4.0) {
        ctx.lookForce(ctx.yawTo(targetX, targetZ), 0.10);
        try { bot.setControlState('sneak', true); } catch(_) {}
      } else {
        ctx.lookForce(ctx.yawTo(targetX, targetZ), -0.30);
      }

      if (bot.entity.onGround) {
        clearInterval(landCheck);
        clearInterval(ctx.verifyLoop); ctx.verifyLoop = null;
        try { bot.setControlState('sneak', false); } catch(_) {}
        state.retries = 0;
        state.spatialClear = false;

        const rRem = ctx.countRockets(bot);
        ctx.setPhase(ctx.PHASE.IDLE, `land (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}) ${currentBlockUnder?.name || 'ground'} rkt=${rRem}`);
      }
    }, 200);
  }

  return { startLanding };
}

module.exports = { createLandingEngine };
