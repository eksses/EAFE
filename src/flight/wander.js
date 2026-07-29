'use strict';

const { Vec3 } = require('vec3');
const Logger = require('../logger');
const { isAir, isSafeSolidBlock } = require('../utils');
const { MODES, CARDINAL_YAWS } = require('../constants');

function createWanderEngine(ctx) {
  const { bot, state } = ctx;

  function findLandMassCenter(anchorX, anchorZ) {
    let minX = anchorX, maxX = anchorX;
    let minZ = anchorZ, maxZ = anchorZ;
    const maxBound = 15;

    for (let dx = 1; dx <= maxBound; dx++) {
      const b = ctx.spatial.getGroundBlockAt(anchorX - dx, anchorZ);
      if (b && isSafeSolidBlock(b)) minX = anchorX - dx;
      else break;
    }
    for (let dx = 1; dx <= maxBound; dx++) {
      const b = ctx.spatial.getGroundBlockAt(anchorX + dx, anchorZ);
      if (b && isSafeSolidBlock(b)) maxX = anchorX + dx;
      else break;
    }
    for (let dz = 1; dz <= maxBound; dz++) {
      const b = ctx.spatial.getGroundBlockAt(anchorX, anchorZ - dz);
      if (b && isSafeSolidBlock(b)) minZ = anchorZ - dz;
      else break;
    }
    for (let dz = 1; dz <= maxBound; dz++) {
      const b = ctx.spatial.getGroundBlockAt(anchorX, anchorZ + dz);
      if (b && isSafeSolidBlock(b)) maxZ = anchorZ + dz;
      else break;
    }

    const midX = Math.round((minX + maxX) / 2);
    const midZ = Math.round((minZ + maxZ) / 2);
    const midBlock = ctx.spatial.getGroundBlockAt(midX, midZ);
    if (midBlock && isSafeSolidBlock(midBlock)) {
      return { x: midX, z: midZ, blockName: midBlock.name, safe: true };
    }

    const anchorBlock = ctx.spatial.getGroundBlockAt(anchorX, anchorZ);
    return { x: anchorX, z: anchorZ, blockName: anchorBlock?.name || 'stone', safe: true };
  }

  function findSafeLandingSpotAround(centerX, centerZ) {
    const rDist = ctx.spatial.getServerRenderDistance();
    const maxSearchRadius = Math.min(rDist.blocks, 50);
    const cx = Math.round(centerX);
    const cz = Math.round(centerZ);
    const margin = ctx.state?.landingMargin ?? 2;

    function hasOpenAir(x, y, z) {
      for (let dy = 1; dy <= 3; dy++) {
        const above = bot.blockAt(new Vec3(x, y + dy, z));
        if (above && !isAir(above)) return false;
      }
      return true;
    }

    function isMarginSafe(x, z) {
      for (let dx = -margin; dx <= margin; dx++) {
        for (let dz = -margin; dz <= margin; dz++) {
          const b = ctx.spatial.getGroundBlockAt(x + dx, z + dz);
          if (!b || !isSafeSolidBlock(b)) return false;
        }
      }
      return true;
    }

    function checkSpot(x, z) {
      const b = ctx.spatial.getGroundBlockAt(x, z);
      if (!b || !isSafeSolidBlock(b)) return null;
      const gy = (b.position?.y ?? 60) + 1;
      if (!hasOpenAir(x, gy, z)) return null;
      if (!isMarginSafe(x, z)) return null;
      return { x, z, y: gy, blockName: b.name, safe: true };
    }

    // Check exact target first
    const exact = checkSpot(cx, cz);
    if (exact) {
      Logger.debug(`exact (${cx},${exact.y},${cz}) [${exact.blockName}] margin=${margin}`);
      return exact;
    }

    // Fast ring search outward — nearest safe block with margin
    for (let r = 1; r <= maxSearchRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const spot = checkSpot(cx + dx, cz + dz);
          if (spot) {
            Logger.debug(`spot (${spot.x},${spot.y},${spot.z}) [${spot.blockName}] r=${r} margin=${margin}`);
            return spot;
          }
        }
      }
    }

    return { x: cx, z: cz, y: 64, blockName: 'unknown', safe: false };
  }

  function startWanderScan() {
    state.currentMode = MODES.EFFICIENT;

    const rDist = ctx.spatial.getServerRenderDistance();
    let scanTicks = 0;
    let ringLegIndex = 0;
    let ringSize = 40;

    const originX = state.activeTargetX;
    const originZ = state.activeTargetZ;

    ctx.setPhase(ctx.PHASE.WANDER_SCAN, `scan (${originX},${originZ}) [${rDist.chunks}ch]`);

    state.scannedChunks.clear();

    if (ctx.flyLoop) clearInterval(ctx.flyLoop);
    ctx.flyLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.WANDER_SCAN) { clearInterval(ctx.flyLoop); ctx.flyLoop = null; return; }

      scanTicks++;
      const pos = bot.entity.position;
      const rCount = ctx.countRockets(bot);

      ctx.checkMidFlightElytraSwap();

      if (bot.entity.onGround) {
        const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
        if (groundUnder && isSafeSolidBlock(groundUnder)) {
          clearInterval(ctx.flyLoop); ctx.flyLoop = null;
          clearInterval(ctx.verifyLoop); ctx.verifyLoop = null;
          state.retries = 0;
          state.spatialClear = false;

          ctx.setPhase(ctx.PHASE.IDLE, `land (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}) ${groundUnder.name} rkt=${ctx.countRockets(bot)}`);
          return;
        }
      }

      const bX = Math.floor(pos.x) >> 4;
      const bZ = Math.floor(pos.z) >> 4;
      for (let dx = -rDist.chunks; dx <= rDist.chunks; dx++) {
        for (let dz = -rDist.chunks; dz <= rDist.chunks; dz++) {
          state.scannedChunks.add(`${bX + dx},${bZ + dz}`);
        }
      }

      const foundSpot = findSafeLandingSpotAround(originX, originZ);
      if (foundSpot.safe) {
        clearInterval(ctx.flyLoop); ctx.flyLoop = null;
        Logger.info(`land (${foundSpot.x},${foundSpot.z}) [${foundSpot.blockName}]`);
        try { bot.chat(`Land at (${foundSpot.x},${foundSpot.z}) -- landing!`); } catch(_) {}

        state.activeTargetX = foundSpot.x;
        state.activeTargetZ = foundSpot.z;
        ctx.startLanding();
        return;
      }

      if (scanTicks > 25 && state.lastKnownSafeGround && state.flightStartPos) {
        const totalTripDist = Math.hypot(state.activeTargetX - state.flightStartPos.x, state.activeTargetZ - state.flightStartPos.z);
        const backtrackDist = Math.hypot(state.lastKnownSafeGround.x - pos.x, state.lastKnownSafeGround.z - pos.z);
        const maxBacktrackAllowed = Math.max(totalTripDist * 0.10, 40);

        if (backtrackDist <= maxBacktrackAllowed) {
          clearInterval(ctx.flyLoop); ctx.flyLoop = null;
          Logger.info(`backtrack ${backtrackDist.toFixed(0)}m -> (${state.lastKnownSafeGround.x},${state.lastKnownSafeGround.z})`);
          try { bot.chat(`Coast ${backtrackDist.toFixed(0)}m away! Landing at (${state.lastKnownSafeGround.x},${state.lastKnownSafeGround.z})`); } catch(_) {}

          state.activeTargetX = state.lastKnownSafeGround.x;
          state.activeTargetZ = state.lastKnownSafeGround.z;
          ctx.startLanding();
          return;
        }
      }

      const targetYaw = CARDINAL_YAWS[ringLegIndex % 4];

      if (!state.legStartPos) state.legStartPos = pos.clone();
      const distOnLeg = Math.hypot(pos.x - state.legStartPos.x, pos.z - state.legStartPos.z);

      if (distOnLeg >= ringSize) {
        ringLegIndex++;
        if (ringLegIndex % 2 === 0) {
          ringSize += Math.round(rDist.blocks * 0.8);
        }
        state.legStartPos = pos.clone();
        const dirs = ['N','E','S','W'];
        Logger.debug(`ring${ringLegIndex} r=${ringSize}m ${dirs[ringLegIndex % 4]}`);
      }

      const scanHeading = targetYaw ?? bot.entity.yaw;
      const terrainScan = ctx.spatial.scanFullRenderDistance(scanHeading, 0.20);
      const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      const groundY = groundUnder?.position?.y ?? 60;
      const minSafeY = groundY + 20;

      if (terrainScan.hit && terrainScan.dist < 80) {
        if (Date.now() - state.lastTerrainWarn > 2000) {
          Logger.warn(`hill ${terrainScan.block} d=${terrainScan.dist}m -- up`);
          state.lastTerrainWarn = Date.now();
        }
        ctx.lookForce(scanHeading, 0.65);
        if (rCount > 0) ctx.fireRocketDirect(scanHeading);
        return;
      }

      if (pos.y < minSafeY && rCount > 0 && !bot.entity.onGround) {
        ctx.lookForce(scanHeading, 0.50);
        ctx.fireRocketDirect(scanHeading);
        return;
      }

      const vel = bot.entity.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);

      if (speed < 0.05 && !bot.entity.onGround && pos.y > 60) {
        Logger.warn('stall -- 180 boost');
        ctx.lookForce(scanHeading + Math.PI, 0.65);
        if (rCount > 0) ctx.fireRocketDirect();
        return;
      }

      const timeSinceBoostMs = Date.now() - ctx.getBoostTime();
      let scanPitch = (timeSinceBoostMs < 1000 && pos.y < 100) ? 0.15 : -0.04;

      if (speed < 0.40 && pos.y < 82 && rCount > 0 && !bot.entity.onGround) {
        ctx.fireRocketDirect(targetYaw);
      }

      ctx.lookForce(targetYaw, scanPitch);
    }, 200);
  }

  return { findLandMassCenter, findSafeLandingSpotAround, startWanderScan };
}

module.exports = { createWanderEngine };
