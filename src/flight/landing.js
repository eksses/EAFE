'use strict';

const { ErrorCode } = require('../errors');

function createLandingEngine(ctx) {
  const { bot } = ctx;

  /**
   * Spiral descent toward a landing spot.
   * Pitch adjusts by altitude: high → steep, low → shallow.
   * No rockets — gravity only (unless the bot touches a hazard and must
   * relocate, which needs a boost).
   *
   * @param {object} [options]
   * @param {{x:number,z:number,y:number,blockName?:string}|null} [options.spot]
   *        Pre-verified spot. When omitted, one is searched in the first
   *        three ticks (or the scan hands off to wander).
   * @param {boolean} [options.skipSpotSearch]  land directly at the target
   *        column (used when `landing: false`).
   */
  function startLanding(options = {}) {
    const { spot = null, skipSpotSearch = false } = options;

    if (ctx.rocketLoop) { clearInterval(ctx.rocketLoop); ctx.rocketLoop = null; }
    if (ctx.flyLoop) { clearInterval(ctx.flyLoop); ctx.flyLoop = null; }
    if (ctx.verifyLoop) { clearInterval(ctx.verifyLoop); ctx.verifyLoop = null; }
    if (ctx.climbLoop) { clearInterval(ctx.climbLoop); ctx.climbLoop = null; }
    if (ctx.landLoop) { clearInterval(ctx.landLoop); ctx.landLoop = null; }

    const rDist = ctx.spatial.getServerRenderDistance();
    ctx.setPhase(ctx.PHASE.LANDING, `scan ${rDist.chunks}ch (${ctx.state.activeTargetX},${ctx.state.activeTargetZ})`);

    let tx = ctx.state.activeTargetX;
    let tz = ctx.state.activeTargetZ;
    let tY = null;
    let spotFound = false;
    let tick = 0;
    let lastLog = 0;

    if (skipSpotSearch) {
      // Direct dive at the target column (no spot search / no wander)
      const g = ctx.spatial.getGroundBlockAt(tx, tz, bot.entity.position.y + 10);
      tY = (g?.position?.y ?? 60) + 1;
      spotFound = true;
    } else if (spot && spot.safe) {
      tx = spot.x;
      tz = spot.z;
      tY = spot.y;
      spotFound = true;
      ctx.logger.info(`goal (${tx},${tY},${tz}) [${spot.blockName}]`);
      try { bot.chat(`Landing at (${tx},${tY},${tz})`); } catch (_) { /* bot gone */ }
    }

    const MAX_TICKS = 2400; // 50ms ticks = 120s

    ctx.landLoop = setInterval(() => {
      if (ctx.state.phase !== ctx.PHASE.LANDING) { clearInterval(ctx.landLoop); ctx.landLoop = null; return; }
      tick++;

      const p = bot.entity.position;
      const v = bot.entity.velocity;
      const spd = Math.hypot(v.x, v.y, v.z);
      const dH = Math.hypot(p.x - tx, p.z - tz);
      const dV = tY !== null ? p.y - tY : 200;

      // Landing timeout
      if (tick > MAX_TICKS) {
        clearInterval(ctx.landLoop); ctx.landLoop = null;
        ctx.failFlight(ErrorCode.LANDING_TIMEOUT, `dV=${dV.toFixed(0)} dH=${dH.toFixed(0)}`);
        return;
      }

      // Keep elytra active
      if (!ctx.isFlying() && !bot.entity.onGround) {
        try { bot.elytraFly(); } catch (_) { /* already flying */ }
      }

      // FIND SPOT: first 3 ticks only (searches are expensive — never repeat
      // the full ring scan every tick)
      if (!spotFound) {
        ctx.lookForce(ctx.yawTo(ctx.state.activeTargetX, ctx.state.activeTargetZ), -0.10);

        if (tick <= 3) {
          const found = ctx.wander.findSafeLandingSpotAround(ctx.state.activeTargetX, ctx.state.activeTargetZ);
          if (found.safe) {
            tx = found.x;
            tz = found.z;
            tY = found.y;
            spotFound = true;
            ctx.logger.info(`goal (${tx},${tY},${tz}) [${found.blockName}]`);
            try { bot.chat(`Landing at (${tx},${tY},${tz})`); } catch (_) { /* bot gone */ }
          }
        }

        if (!spotFound && tick > 3) {
          clearInterval(ctx.landLoop); ctx.landLoop = null;
          if (ctx.opts.wander) {
            ctx.logger.info(`no spot at (${ctx.state.activeTargetX},${ctx.state.activeTargetZ}) -- wander`);
            ctx.startWanderScan();
          } else {
            ctx.failFlight(ErrorCode.NO_SAFE_SPOT, 'no landing spot (wander off)');
          }
          return;
        }

        return;
      }

      // LANDED
      if (bot.entity.onGround) {
        clearInterval(ctx.landLoop); ctx.landLoop = null;

        // Check if landed on safe ground
        const landedBlock = ctx.spatial.getGroundBlockAt(Math.round(p.x), Math.round(p.z), p.y + 10);
        if (!landedBlock || !ctx.isSafeSolid(landedBlock)) {
          // On a hazard (cactus, berry bush, powder snow, ...). The old code
          // just reset the search timer and looped forever standing on it.
          ctx.logger.warn(`landed on ${landedBlock?.name || 'hazard'} -- relocating`);
          if (ctx.opts.autoRocket && ctx.countRockets() > 0) {
            ctx.startWanderScan();
          } else {
            // Can't get airborne — retry the flight (may find a different spot)
            ctx.failFlight(ErrorCode.NO_SAFE_SPOT, `unsafe ground ${landedBlock?.name || 'hazard'}`);
          }
          return;
        }

        try { bot.setControlState('sneak', false); } catch (_) { /* bot gone */ }
        const errH = Math.hypot(p.x - tx, p.z - tz);

        ctx.logger.info(`landed (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) [${landedBlock.name}] err=${errH.toFixed(1)} rkt=${ctx.countRockets()}`);
        ctx.completeFlight();
        return;
      }

      // DEATH PROTECTION — descending fast and close to the spot: level out.
      // (A shallow 0.30 instead of 0.40: the old steep look-up traded hard
      // dives for permanent hover-orbits.)
      if (v.y < -0.15 && dV < 8) {
        ctx.lookForce(ctx.yawTo(tx, tz), 0.30);
        return;
      }

      // FINAL APPROACH — over the spot and almost on the ground: settle
      if (dV < 1.5 && dH < 2) {
        ctx.lookForce(ctx.yawTo(tx, tz), 0.10);
        return;
      }

      // GLIDE TO GOAL — aim straight at the spot. The aim point is the goal
      // itself (the old code orbited a point around the goal, which made a
      // fast bot circle the target and skim the ground far away from it).
      // Horizontal closure is always >= speed*cos(0.5), so this converges
      // from any distance the landing trigger can produce.
      const ideal = dH > 0.5 ? Math.atan2(-Math.min(dV, 40), dH) : -0.30;
      const pitch = Math.max(-0.5, Math.min(-0.02, ideal));
      ctx.lookForce(ctx.yawTo(tx, tz), pitch);

      if (tick - lastLog > 15) {
        ctx.logger.debug(`glide spd=${(spd * 20).toFixed(0)} dH=${dH.toFixed(1)} dV=${dV.toFixed(1)}`);
        lastLog = tick;
      }
    }, 50);
  }

  return { startLanding };
}

module.exports = { createLandingEngine };
