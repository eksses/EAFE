'use strict';

const { Vec3 } = require('vec3');
const Logger = require('../logger');
const { isAir, isSafeSolidBlock } = require('../utils');

function createWanderEngine(ctx) {
  const { bot, state } = ctx;

  function findSafeLandingSpotAround(centerX, centerZ) {
    const cx = Math.round(centerX);
    const cz = Math.round(centerZ);
    const margin = ctx.state?.landingMargin ?? 2;

    function hasOpenAir(x, y, z) {
      for (let dy = 1; dy <= 2; dy++) {
        const above = bot.blockAt(new Vec3(x, y + dy, z));
        if (above && !isAir(above)) return false;
      }
      return true;
    }

    function checkSpot(x, z) {
      for (let y = Math.min(Math.round(bot.entity.position.y) + 10, 256); y >= 0; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && !isAir(b)) {
          if (!isSafeSolidBlock(b)) return null;
          const gy = (b.position?.y ?? 60) + 1;
          if (!hasOpenAir(x, gy, z)) return null;
          // Margin: check 1 block in each cardinal direction
          for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nb = bot.blockAt(new Vec3(x + dx, gy - 1, z + dz));
            if (!nb || !isSafeSolidBlock(nb)) return null;
          }
          return { x, z, y: gy, blockName: b.name, safe: true };
        }
      }
      return null;
    }

    // 1. Check exact target
    const exact = checkSpot(cx, cz);
    if (exact) {
      Logger.debug(`exact (${cx},${exact.y},${cz}) [${exact.blockName}]`);
      return exact;
    }

    // 2. Quick scan — 20 positions in expanding squares (fast, no ring overhead)
    for (let r = 1; r <= 30; r++) {
      // Check corners and midpoints only — 8 positions per radius
      const checks = [
        [cx + r, cz], [cx - r, cz], [cx, cz + r], [cx, cz - r],
        [cx + r, cz + r], [cx - r, cz - r], [cx + r, cz - r], [cx - r, cz + r],
      ];
      for (const [sx, sz] of checks) {
        const spot = checkSpot(sx, sz);
        if (spot) {
          Logger.debug(`spot (${spot.x},${spot.y},${spot.z}) [${spot.blockName}] r=${r}`);
          return spot;
        }
      }
    }

    // 3. Fallback — land at nearest safe ground below bot
    const bx = Math.round(bot.entity.position.x);
    const bz = Math.round(bot.entity.position.z);
    const fallback = checkSpot(bx, bz);
    if (fallback) {
      Logger.debug(`fallback (${fallback.x},${fallback.y},${fallback.z}) [${fallback.blockName}]`);
      return fallback;
    }

    return { x: cx, z: cz, y: 64, blockName: 'unknown', safe: false };
  }

  function startWanderScan() {
    state.currentMode = MODES.EFFICIENT;

    let scanTicks = 0;

    const originX = state.activeTargetX;
    const originZ = state.activeTargetZ;

    ctx.setPhase(ctx.PHASE.WANDER_SCAN, `scan (${originX},${originZ})`);

    state.scannedChunks.clear();

    if (ctx.flyLoop) clearInterval(ctx.flyLoop);
    ctx.flyLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.WANDER_SCAN) { clearInterval(ctx.flyLoop); ctx.flyLoop = null; return; }

      scanTicks++;
      const pos = bot.entity.position;

      ctx.checkMidFlightElytraSwap();

      if (bot.entity.onGround) {
        const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
        if (groundUnder && isSafeSolidBlock(groundUnder)) {
          clearInterval(ctx.flyLoop); ctx.flyLoop = null;
          clearInterval(ctx.verifyLoop); ctx.verifyLoop = null;
          state.retries = 0;
          state.spatialClear = false;
          ctx.setPhase(ctx.PHASE.IDLE, `land (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}) ${groundUnder.name}`);
          return;
        }
      }

      // Check ground directly below — land if safe
      const groundBelow = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      if (groundBelow && isSafeSolidBlock(groundBelow)) {
        const gy = (groundBelow.position?.y ?? 60) + 1;
        const air1 = bot.blockAt(new Vec3(Math.round(pos.x), gy, Math.round(pos.z)));
        const air2 = bot.blockAt(new Vec3(Math.round(pos.x), gy + 1, Math.round(pos.z)));
        if ((!air1 || isAir(air1)) && (!air2 || isAir(air2))) {
          // Check 1-block margin
          let marginOk = true;
          for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nb = bot.blockAt(new Vec3(Math.round(pos.x) + dx, gy - 1, Math.round(pos.z) + dz));
            if (!nb || !isSafeSolidBlock(nb)) { marginOk = false; break; }
          }
          if (marginOk) {
            clearInterval(ctx.flyLoop); ctx.flyLoop = null;
            state.activeTargetX = Math.round(pos.x);
            state.activeTargetZ = Math.round(pos.z);
            ctx.startLanding();
            return;
          }
        }
      }

      // Glide toward target — rockets only for survival
      const targetYaw = Math.atan2(-(originX - pos.x), -(originZ - pos.z));
      const vel = bot.entity.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);

      // Stall — look up, no rocket (has speed from falling)
      if (speed < 0.05 && !bot.entity.onGround && pos.y > 60) {
        ctx.lookForce(targetYaw + Math.PI, 0.50);
        return;
      }

      // Too low — rocket ONLY to survive, not for speed
      const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      const groundY = groundUnder?.position?.y ?? 60;
      if (pos.y < groundY + 20 && !bot.entity.onGround && ctx.countRockets(bot) > 0) {
        ctx.lookForce(targetYaw, 0.40);
        ctx.fireRocketDirect(targetYaw);
        return;
      }

      // Normal glide — descend toward target, no rockets
      ctx.lookForce(targetYaw, -0.04);
    }, 200);
  }

  function findLandMassCenter(anchorX, anchorZ) {
    return { x: anchorX, z: anchorZ, blockName: 'ground', safe: true };
  }

  return { findLandMassCenter, findSafeLandingSpotAround, startWanderScan };
}

module.exports = { createWanderEngine };
