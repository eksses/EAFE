'use strict';

const { Vec3 } = require('vec3');
const Logger = require('../logger');
const { isAir, isSafeSolidBlock } = require('../utils');

function createWanderEngine(ctx) {
  const { bot, state } = ctx;

  /**
   * Find safe landing spot near coordinates.
   * Scans Y from bot altitude downward, checks 2 air blocks above.
   * No margin check — faster scan, safe for delivery bots.
   */
  function findSafeLandingSpotAround(centerX, centerZ) {
    const cx = Math.round(centerX);
    const cz = Math.round(centerZ);
    const botY = Math.round(bot.entity.position.y);

    function hasOpenAir(x, y, z) {
      const a1 = bot.blockAt(new Vec3(x, y + 1, z));
      const a2 = bot.blockAt(new Vec3(x, y + 2, z));
      return (!a1 || isAir(a1)) && (!a2 || isAir(a2));
    }

    function checkSpot(x, z) {
      const maxY = Math.min(botY + 10, 256);
      for (let y = maxY; y >= 0; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && !isAir(b)) {
          if (!isSafeSolidBlock(b)) return null;
          const gy = y + 1;
          if (!hasOpenAir(x, gy, z)) return null;
          // Margin: 1 block in each cardinal direction
          for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nb = bot.blockAt(new Vec3(x + dx, gy - 1, z + dz));
            if (!nb || !isSafeSolidBlock(nb)) return null;
          }
          return { x, z, y: gy, blockName: b.name, safe: true };
        }
      }
      return null;
    }

    // 1. Exact target
    const exact = checkSpot(cx, cz);
    if (exact) return exact;

    // 2. Expanding ring — 8 positions per radius, up to 30 radii
    for (let r = 1; r <= 30; r++) {
      const spots = [
        [cx + r, cz], [cx - r, cz], [cx, cz + r], [cx, cz - r],
        [cx + r, cz + r], [cx - r, cz - r], [cx + r, cz - r], [cx - r, cz + r],
      ];
      for (const [sx, sz] of spots) {
        const spot = checkSpot(sx, sz);
        if (spot) return spot;
      }
    }

    // 3. Fallback — bot position
    const bx = Math.round(bot.entity.position.x);
    const bz = Math.round(bot.entity.position.z);
    const fb = checkSpot(bx, bz);
    if (fb) return fb;

    return { x: cx, z: cz, y: 64, blockName: 'unknown', safe: false };
  }

  /**
   * Wander scan — fly toward target, check ground below every tick.
   * Land when safe ground found. Rockets only for survival.
   */
  function startWanderScan() {
    const originX = state.activeTargetX;
    const originZ = state.activeTargetZ;
    let scanTicks = 0;

    ctx.setPhase(ctx.PHASE.WANDER_SCAN, `scan (${originX},${originZ})`);
    state.scannedChunks.clear();

    if (ctx.flyLoop) clearInterval(ctx.flyLoop);
    ctx.flyLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.WANDER_SCAN) {
        clearInterval(ctx.flyLoop);
        ctx.flyLoop = null;
        return;
      }

      scanTicks++;
      const pos = bot.entity.position;

      ctx.checkMidFlightElytraSwap();

      // On ground — check if safe, land
      if (bot.entity.onGround) {
        const ground = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
        if (ground && isSafeSolidBlock(ground)) {
          clearInterval(ctx.flyLoop);
          ctx.flyLoop = null;
          clearInterval(ctx.verifyLoop);
          ctx.verifyLoop = null;
          state.retries = 0;
          state.spatialClear = false;
          ctx.setPhase(ctx.PHASE.IDLE, `land (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}) ${ground.name}`);
          return;
        }
      }

      // Check ground below — land if safe (with margin)
      const groundBelow = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      if (groundBelow && isSafeSolidBlock(groundBelow)) {
        const gy = (groundBelow.position?.y ?? 60) + 1;
        const a1 = bot.blockAt(new Vec3(Math.round(pos.x), gy, Math.round(pos.z)));
        const a2 = bot.blockAt(new Vec3(Math.round(pos.x), gy + 1, Math.round(pos.z)));
        if ((!a1 || isAir(a1)) && (!a2 || isAir(a2))) {
          // Check 1-block margin
          let marginOk = true;
          for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nb = bot.blockAt(new Vec3(Math.round(pos.x) + dx, gy - 1, Math.round(pos.z) + dz));
            if (!nb || !isSafeSolidBlock(nb)) { marginOk = false; break; }
          }
          if (marginOk) {
            clearInterval(ctx.flyLoop);
            ctx.flyLoop = null;
            state.activeTargetX = Math.round(pos.x);
            state.activeTargetZ = Math.round(pos.z);
            ctx.startLanding();
            return;
          }
        }
      }

      // Glide toward target
      const targetYaw = Math.atan2(-(originX - pos.x), -(originZ - pos.z));
      const speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z);

      // Stall — look up to regain speed
      if (speed < 0.05 && !bot.entity.onGround && pos.y > 60) {
        ctx.lookForce(targetYaw + Math.PI, 0.50);
        return;
      }

      // Too low — rocket to survive
      const groundY = groundBelow?.position?.y ?? 60;
      if (pos.y < groundY + 20 && !bot.entity.onGround && ctx.countRockets(bot) > 0) {
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
