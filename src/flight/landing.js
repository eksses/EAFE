'use strict';

const Logger = require('../logger');
const { isSafeSolidBlock } = require('../utils');

function createLandingEngine(ctx) {
  const { bot, state } = ctx;

  /**
   * Spiral descent toward landing spot.
   * Pitch adjusts by altitude: high → steep, low → shallow.
   * No rockets — gravity only.
   */
  function startLanding() {
    if (ctx.rocketLoop) { clearInterval(ctx.rocketLoop); ctx.rocketLoop = null; }
    if (ctx.flyLoop) { clearInterval(ctx.flyLoop); ctx.flyLoop = null; }
    if (ctx.verifyLoop) { clearInterval(ctx.verifyLoop); ctx.verifyLoop = null; }
    if (ctx.climbLoop) { clearInterval(ctx.climbLoop); ctx.climbLoop = null; }

    const rDist = ctx.spatial.getServerRenderDistance();
    ctx.setPhase(ctx.PHASE.LANDING, `scan ${rDist.chunks}ch (${state.activeTargetX},${state.activeTargetZ})`);

    let tx = state.activeTargetX;
    let tz = state.activeTargetZ;
    let tY = null;
    let spotFound = false;
    let tick = 0;
    let lastLog = 0;
    let spiralAngle = 0;

    const landLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.LANDING) { clearInterval(landLoop); return; }
      tick++;

      const p = bot.entity.position;
      const v = bot.entity.velocity;
      const spd = Math.hypot(v.x, v.y, v.z);
      const dH = Math.hypot(p.x - tx, p.z - tz);
      const dV = tY !== null ? p.y - tY : 200;

      // Keep elytra active
      if (!ctx.isFlying() && !bot.entity.onGround) {
        try { bot.elytraFly(); } catch(_) {}
      }

      // FIND SPOT: first3 ticks only
      if (!spotFound) {
        ctx.lookForce(ctx.yawTo(state.activeTargetX, state.activeTargetZ), -0.10);

        if (tick <= 3) {
          const spot = ctx.wander.findSafeLandingSpotAround(state.activeTargetX, state.activeTargetZ);
          if (spot.safe) {
            tx = spot.x;
            tz = spot.z;
            tY = spot.y;
            spotFound = true;
            Logger.info(`goal (${tx},${tY},${tz}) [${spot.blockName}]`);
            try { bot.chat(`Landing at (${tx},${tY},${tz})`); } catch(_) {}
          }
        }

        if (!spotFound && tick > 3) {
          Logger.info(`no spot at (${state.activeTargetX},${state.activeTargetZ}) -- wander`);
          clearInterval(landLoop);
          ctx.startWanderScan();
          return;
        }

        return;
      }

      // LANDED
      if (bot.entity.onGround) {
        clearInterval(landLoop);
        try { bot.setControlState('sneak', false); } catch(_) {}
        state.retries = 0;
        state.spatialClear = false;
        const b = ctx.spatial.getGroundBlockAt(Math.round(p.x), Math.round(p.z));
        const errH = Math.hypot(p.x - tx, p.z - tz);

        Logger.info(`landed (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) [${b?.name || 'ground'}] err=${errH.toFixed(1)} rkt=${ctx.countRockets(bot)}`);
        ctx.setPhase(ctx.PHASE.IDLE, `land (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) ${b?.name || 'ground'} err=${errH.toFixed(1)}`);
        return;
      }

      // DEATH PROTECTION
      if (v.y < -0.15 && dV < 8) {
        ctx.lookForce(ctx.yawTo(tx, tz), 0.40);
        return;
      }

      // SPIRAL DESCENT
      if (dV > 5 || spd > 0.5) {
        const r = dV > 30 ? 3.0 : dV > 15 ? 2.0 : 1.2;
        spiralAngle += dV > 20 ? 0.08 : 0.12;

        const sx = tx + Math.cos(spiralAngle) * r;
        const sz = tz + Math.sin(spiralAngle) * r;
        const pitch = dV > 50 ? -0.25 : dV > 30 ? -0.15 : dV > 15 ? -0.08 : dV > 5 ? -0.03 : 0.0;

        ctx.lookForce(ctx.yawTo(sx, sz), pitch);

        if (tick - lastLog > 20) {
          Logger.debug(`spiral spd=${(spd * 20).toFixed(0)} dH=${dH.toFixed(0)} dV=${dV.toFixed(0)}`);
          lastLog = tick;
        }
        return;
      }

      // FINAL APPROACH
      if (dV < 1.5 && dH < 2) {
        ctx.lookForce(ctx.yawTo(tx, tz), 0.15);
        try { bot.setControlState('sneak', true); } catch(_) {}
      } else {
        const ideal = dH > 0.5 ? Math.atan2(-dV, dH) : -0.20;
        const cur = bot.entity.pitch;
        const err = ideal - cur;
        const pitch = Math.abs(err) > 0.1 ? cur + err * 0.15 : ideal;
        ctx.lookForce(ctx.yawTo(tx, tz), pitch);
      }

      if (tick - lastLog > 15) {
        Logger.debug(`final spd=${(spd * 20).toFixed(0)} dH=${dH.toFixed(1)} dV=${dV.toFixed(1)}`);
        lastLog = tick;
      }
    }, 50);
  }

  return { startLanding };
}

module.exports = { createLandingEngine };
