'use strict';

const Logger = require('../logger');
const { isSafeSolidBlock } = require('../utils');

const SPIRAL_R = 1.5;

function createLandingEngine(ctx) {
  const { bot, state } = ctx;

  function startLanding() {
    if (ctx.rocketLoop) { clearInterval(ctx.rocketLoop); ctx.rocketLoop = null; }
    if (ctx.flyLoop) { clearInterval(ctx.flyLoop); ctx.flyLoop = null; }
    if (ctx.verifyLoop) { clearInterval(ctx.verifyLoop); ctx.verifyLoop = null; }
    if (ctx.climbLoop) { clearInterval(ctx.climbLoop); ctx.climbLoop = null; }

    const rDist = ctx.spatial.getServerRenderDistance();
    ctx.setPhase(ctx.PHASE.LANDING, `scan ${rDist.chunks}ch (${state.activeTargetX},${state.activeTargetZ})`);

    const spot = ctx.wander.findSafeLandingSpotAround(state.activeTargetX, state.activeTargetZ);
    if (!spot.safe) {
      if (state.phase !== ctx.PHASE.WANDER_SCAN) ctx.startWanderScan();
      return;
    }

    const tx = spot.x;
    const tz = spot.z;
    const tY = spot.y;
    const margin = ctx.state?.landingMargin ?? 2;

    Logger.info(`goal    (${tx},${tY},${tz}) [${spot.blockName}] margin=${margin}`);
    Logger.info(`search  (${state.activeTargetX},${state.activeTargetZ}) -> (${tx},${tY},${tz})`);
    try { bot.chat(`Landing at (${tx},${tY},${tz})`); } catch(_) {}

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
      const dV = p.y - tY;

      // Keep elytra active during landing
      if (!ctx.isFlying() && !bot.entity.onGround) {
        try { bot.elytraFly(); } catch(_) {}
      }

      ctx.checkMidFlightElytraSwap();

      // ── LANDED ──
      if (bot.entity.onGround) {
        clearInterval(landLoop);
        try { bot.setControlState('sneak', false); } catch(_) {}
        state.retries = 0;
        state.spatialClear = false;
        const b = ctx.spatial.getGroundBlockAt(Math.round(p.x), Math.round(p.z));
        const landX = Math.round(p.x);
        const landZ = Math.round(p.z);
        const landY = Math.round(p.y);
        const errX = Math.abs(landX - tx);
        const errZ = Math.abs(landZ - tz);
        const errH = Math.hypot(p.x - tx, p.z - tz);
        const errV = Math.abs(landY - tY);

        Logger.info(`goal    (${tx},${tY},${tz})`);
        Logger.info(`landed  (${landX},${landY},${landZ}) [${b?.name || 'ground'}]`);
        Logger.info(`error   dx=${errX} dz=${errZ} dh=${errH.toFixed(1)} dv=${errV} margin=${margin}`);
        Logger.info(`result  ${errH <= margin ? 'PASS' : 'MISS'} err=${errH.toFixed(1)} margin=${margin} rkt=${ctx.countRockets(bot)}`);

        ctx.setPhase(ctx.PHASE.IDLE, `land (${landX},${landY},${landZ}) ${b?.name || 'ground'} err=${errH.toFixed(1)} rkt=${ctx.countRockets(bot)}`);
        return;
      }

      // ── DEATH PROTECTION: falling fast near ground — look up to convert speed to altitude ──
      if (v.y < -0.15 && dV < 8) {
        ctx.lookForce(ctx.yawTo(tx, tz), 0.40);
        return;
      }

      // ── FAR: glide toward target, no rockets — pure gravity descent ──
      if (dH > 8 || dV > 30) {
        const ideal = Math.atan2(-dV, Math.max(dH, 1));
        const pitch = Math.max(-0.30, Math.min(-0.02, ideal));
        ctx.lookForce(ctx.yawTo(tx, tz), pitch);

        if (tick - lastLog > 25) {
          Logger.debug(`approach spd=${(spd * 20).toFixed(0)} dH=${dH.toFixed(0)} dV=${dV.toFixed(0)} p=${pitch.toFixed(2)}`);
          lastLog = tick;
        }
        return;
      }

      // ── CLOSE + FAST: spiral brake (no rockets — bleed speed by gliding) ──
      if (spd > 0.5 || dV > 8) {
        spiralAngle += 0.12;
        const sx = tx + Math.cos(spiralAngle) * SPIRAL_R;
        const sz = tz + Math.sin(spiralAngle) * SPIRAL_R;

        const pitch = dV > 15 ? -0.06 : (dV > 5 ? -0.03 : 0.0);
        ctx.lookForce(ctx.yawTo(sx, sz), pitch);

        if (tick - lastLog > 15) {
          Logger.debug(`spiral spd=${(spd * 20).toFixed(0)} dH=${dH.toFixed(0)} dV=${dV.toFixed(0)}`);
          lastLog = tick;
        }
        return;
      }

      // ── FINAL: slow, land on exact block ──
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
