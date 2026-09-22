'use strict';

const { Vec3 } = require('vec3');
const { isAir } = require('../utils');
const { ErrorCode } = require('../errors');

function createWanderEngine(ctx) {
  const { bot } = ctx;

  /**
   * Check one column for a landing spot:
   *  - topmost collision block from `botY + 10` downward
   *  - not hazardous, has collision
   *  - 2 air blocks above
   *  - `landingMargin` blocks of safe solid in every surrounding direction
   */
  function checkSpotColumn(x, z) {
    const botY = Math.round(bot.entity.position.y);
    const margin = Math.max(1, ctx.opts.landingMargin | 0);
    const maxY = Math.min(botY + 10, 320);

    for (let y = maxY; y >= 0; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b || isAir(b)) continue;
      if (!ctx.isSafeSolid(b)) continue; // first collision block is the ground

      const gy = y + 1;
      const a1 = bot.blockAt(new Vec3(x, gy, z));
      const a2 = bot.blockAt(new Vec3(x, gy + 1, z));
      if ((a1 && !isAir(a1)) || (a2 && !isAir(a2))) return null;

      for (let dx = -margin; dx <= margin; dx++) {
        for (let dz = -margin; dz <= margin; dz++) {
          if (dx === 0 && dz === 0) continue;
          const nb = bot.blockAt(new Vec3(x + dx, gy - 1, z + dz));
          if (!nb || !ctx.isSafeSolid(nb)) return null;
        }
      }

      return { x, z, y: gy, blockName: b.name, safe: true };
    }
    return null;
  }

  /**
   * Find a safe landing spot near (centerX, centerZ).
   * 1) exact target, 2) expanding rings (8 positions, up to 30 radii),
   * 3) fallback to the bot's own column.
   */
  function findSafeLandingSpotAround(centerX, centerZ) {
    const cx = Math.round(centerX);
    const cz = Math.round(centerZ);

    const exact = checkSpotColumn(cx, cz);
    if (exact) return exact;

    for (let r = 1; r <= 30; r++) {
      const spots = [
        [cx + r, cz], [cx - r, cz], [cx, cz + r], [cx, cz - r],
        [cx + r, cz + r], [cx - r, cz - r], [cx + r, cz - r], [cx - r, cz + r],
      ];
      for (const [sx, sz] of spots) {
        const spot = checkSpotColumn(sx, sz);
        if (spot) return spot;
      }
    }

    const fb = checkSpotColumn(Math.round(bot.entity.position.x), Math.round(bot.entity.position.z));
    if (fb) return fb;

    return { x: cx, z: cz, y: 64, blockName: 'unknown', safe: false };
  }

  /**
   * Wander scan — glide toward the target, check the ground below each tick,
   * land when safe ground is found. Rockets only for survival.
   * Times out after 120 s (the old version could loop forever over hostile
   * terrain, draining the elytra).
   */
  function startWanderScan() {
    const originX = ctx.state.activeTargetX;
    const originZ = ctx.state.activeTargetZ;
    let scanTicks = 0;
    const MAX_TICKS = Math.max(10, Math.round((ctx.opts.wanderTimeoutMs || 120000) / 200));

    ctx.setPhase(ctx.PHASE.WANDER_SCAN, `scan (${originX},${originZ})`);

    if (ctx.flyLoop) clearInterval(ctx.flyLoop);
    ctx.flyLoop = setInterval(() => {
      if (ctx.state.phase !== ctx.PHASE.WANDER_SCAN) {
        clearInterval(ctx.flyLoop);
        ctx.flyLoop = null;
        return;
      }

      scanTicks++;
      const pos = bot.entity.position;

      ctx.checkMidFlightElytraSwap();

      // Wander timeout — no safe spot found
      if (scanTicks > MAX_TICKS) {
        clearInterval(ctx.flyLoop);
        ctx.flyLoop = null;
        ctx.failFlight(ErrorCode.NO_SAFE_SPOT, 'wander timeout');
        return;
      }

      // On ground — check if safe, land
      if (bot.entity.onGround) {
        const ground = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z), pos.y + 10);
        if (ground && ctx.isSafeSolid(ground)) {
          clearInterval(ctx.flyLoop);
          ctx.flyLoop = null;
          if (ctx.verifyLoop) { clearInterval(ctx.verifyLoop); ctx.verifyLoop = null; }
          ctx.logger.info(`landed (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}) [${ground.name}]`);
          ctx.completeFlight();
          return;
        }
      }

      // Check ground below — land if safe (with margin)
      const spot = checkSpotColumn(Math.round(pos.x), Math.round(pos.z));
      if (spot) {
        clearInterval(ctx.flyLoop);
        ctx.flyLoop = null;
        ctx.state.activeTargetX = spot.x;
        ctx.state.activeTargetZ = spot.z;
        ctx.startLanding({ spot });
        return;
      }

      // Glide toward target
      const targetYaw = Math.atan2(-(originX - pos.x), -(originZ - pos.z));
      const speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z);

      // Stall — look up to regain speed (rocket if available, like cruise)
      if (speed < 0.05 && !bot.entity.onGround && pos.y > 60) {
        ctx.logger.warn('wander stall -- boost');
        ctx.lookForce(targetYaw + Math.PI, 0.50);
        if (ctx.opts.autoRocket && ctx.countRockets() > 0) ctx.fireRocketDirect();
        return;
      }

      // Too low — rocket to survive
      const groundBelow = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z), pos.y + 10);
      const groundY = groundBelow?.position?.y ?? 60;
      if (pos.y < groundY + 20 && !bot.entity.onGround && ctx.opts.autoRocket && ctx.countRockets() > 0) {
        ctx.lookForce(targetYaw, 0.40);
        ctx.fireRocketDirect(targetYaw);
        return;
      }

      // Normal glide
      ctx.lookForce(targetYaw, -0.04);
    }, 200);
  }

  return { findSafeLandingSpotAround, startWanderScan };
}

module.exports = { createWanderEngine };
