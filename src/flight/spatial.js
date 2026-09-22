'use strict';

const { Vec3 } = require('vec3');
const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const { isAir } = require('../utils');

function createSpatialEngine(ctx) {
  const { bot } = ctx;

  // ── Render distance (cached — iterating every loaded column on each 50ms
  //    raycast tick was a steady GC/CPU drain on large worlds) ──
  let rdistCache = null;
  let rdistCacheTime = 0;
  const RDIST_CACHE_MS = 5000;

  function getServerRenderDistance(force = false) {
    if (!force && rdistCache && Date.now() - rdistCacheTime < RDIST_CACHE_MS) return rdistCache;

    if (!bot.entity || !bot.world) return { chunks: 6, blocks: 96 };

    const bX = Math.floor(bot.entity.position.x) >> 4;
    const bZ = Math.floor(bot.entity.position.z) >> 4;
    let maxDistChunks = 0;

    try {
      const columns = bot.world.getColumns();
      for (const col of columns) {
        if (!col) continue;
        const dx = Math.abs(col.chunkX - bX);
        const dz = Math.abs(col.chunkZ - bZ);
        const dist = Math.max(dx, dz);
        if (dist > maxDistChunks) maxDistChunks = dist;
      }
    } catch (_) { /* world not ready */ }

    rdistCache = { chunks: Math.min(Math.max(maxDistChunks, 4), 16) };
    rdistCache.blocks = rdistCache.chunks * 16;
    rdistCacheTime = Date.now();
    return rdistCache;
  }

  /**
   * Raycast from the eye along (yaw, pitch).
   * 1-block steps within 40 m (thin structures can no longer be tunneled
   * through), 2-block steps beyond.
   */
  function scanFullRenderDistance(yaw, currentPitch) {
    const pos = bot.entity.position;
    const eyePos = pos.offset(0, 1.6, 0);
    const maxRaycastBlocks = getServerRenderDistance().blocks;

    const cosPitch = Math.cos(currentPitch);
    const sinPitch = Math.sin(currentPitch);
    const dirX = -Math.sin(yaw) * cosPitch;
    const dirY = sinPitch;
    const dirZ = Math.cos(yaw) * cosPitch;

    for (let d = 1; d <= maxRaycastBlocks; d += d <= 40 ? 1 : 2) {
      const checkPos = eyePos.offset(dirX * d, dirY * d, dirZ * d);
      const b = bot.blockAt(checkPos);
      if (b && !isAir(b) && !ctx.isHazardous(b)) {
        return { hit: true, dist: d, block: b.name, pos: checkPos };
      }
    }

    return { hit: false, dist: maxRaycastBlocks, block: null, pos: null };
  }

  /**
   * Check the launch corridor: 5 blocks overhead and 16 blocks ahead at foot
   * and head level. Returns { clear, reason }.
   */
  function checkRunwayDirection(testYaw) {
    const pos = bot.entity.position;

    for (let dy = 1; dy <= 5; dy++) {
      const b = bot.blockAt(pos.offset(0, dy, 0));
      if (!isAir(b)) return { clear: false, reason: `overhead Y+${dy} ${b?.name}` };
    }

    const dirX = -Math.sin(testYaw);
    const dirZ = Math.cos(testYaw);

    for (let d = 1; d <= 16; d++) {
      for (let dy = 1; dy <= 2; dy++) {
        const bPos = pos.offset(dirX * d, dy, dirZ * d);
        const b = bot.blockAt(bPos);
        if (!isAir(b)) return { clear: false, reason: `ahead ${d}m Y+${dy} ${b?.name}` };
      }
    }

    const blockUnder = bot.blockAt(pos.offset(0, -0.5, 0));
    if (ctx.isHazardous(blockUnder)) return { clear: false, reason: `liquid ${blockUnder?.name}` };

    return { clear: true, reason: 'clear' };
  }

  const COMPASS = [
    { name: 'S', yaw: 0 },
    { name: 'E', yaw: -Math.PI / 2 },
    { name: 'N', yaw: Math.PI },
    { name: 'W', yaw: Math.PI / 2 },
    { name: 'SE', yaw: -Math.PI / 4 },
    { name: 'NE', yaw: -3 * Math.PI / 4 },
    { name: 'SW', yaw: Math.PI / 4 },
    { name: 'NW', yaw: 3 * Math.PI / 4 },
  ];

  /**
   * Pick the best clear launch heading, preferring directions closest to the
   * target (the old code always tried W, N, E, S first and could launch the
   * bot 90-180 degrees away from where it was going).
   */
  function findBestLaunchHeading() {
    const targetYaw = ctx.yawTo(ctx.state.activeTargetX, ctx.state.activeTargetZ);
    const targetCheck = checkRunwayDirection(targetYaw);
    if (targetCheck.clear) {
      return { yaw: targetYaw, headingName: 'direct', clear: true };
    }

    const ordered = [...COMPASS]
      .map(dir => ({ ...dir, diff: Math.abs(((dir.yaw - targetYaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) }))
      .sort((a, b) => a.diff - b.diff);

    for (const dir of ordered) {
      if (checkRunwayDirection(dir.yaw).clear) {
        ctx.logger.warn(`target blocked -- heading ${dir.name}`);
        return { yaw: dir.yaw, headingName: dir.name, clear: true };
      }
    }

    return { yaw: targetYaw, headingName: 'blocked', clear: false };
  }

  function findElevatedOpenSpot() {
    const pos = bot.entity.position;
    const baseY = Math.floor(pos.y);
    let best = null;

    for (let dx = -7; dx <= 7; dx += 2) {
      for (let dz = -7; dz <= 7; dz += 2) {
        const cx = Math.floor(pos.x) + dx;
        const cz = Math.floor(pos.z) + dz;

        let groundBlock = null;
        let groundY = null;

        // Look a few blocks up as well — the old code only checked down and
        // could "arrive" at the base of a wall it could never launch from.
        for (let dy = 4; dy >= -4; dy--) {
          const b = bot.blockAt(new Vec3(cx, baseY + dy, cz));
          if (b && !isAir(b)) {
            groundBlock = b;
            groundY = baseY + dy + 1;
            break;
          }
        }

        if (!groundBlock || !ctx.isSafeSolid(groundBlock)) continue;

        let openAir = 0;
        for (let dy = 0; dy < 15; dy++) {
          if (isAir(bot.blockAt(new Vec3(cx, groundY + dy, cz)))) openAir++;
          else break;
        }

        if (openAir >= 5) {
          const dist = Math.hypot(dx, dz);
          const score = openAir - dist * 0.5;
          if (score > (best?.score ?? -999)) {
            best = { x: cx, y: groundY, z: cz, score, openAir, blockName: groundBlock.name };
          }
        }
      }
    }

    return best;
  }

  /**
   * Pathfind to a launch spot. Refuses gracefully when the pathfinder plugin
   * is unavailable. Digging is OFF by default (old code tunneled through
   * players' builds); opt in with `relocationCanDig: true`.
   */
  async function pathfindToSpot(tx, ty, tz) {
    ctx.logger.debug(`pf -> (${tx},${ty},${tz})`);

    if (!bot.pathfinder) {
      ctx.logger.warn('pathfinder plugin unavailable -- cannot relocate');
      return false;
    }

    const defaultMove = new Movements(bot);
    defaultMove.canDig = Boolean(ctx.opts.relocationCanDig);
    defaultMove.allow1by1tunnels = Boolean(ctx.opts.relocationCanDig);
    defaultMove.allowParkour = true;
    defaultMove.canSwim = false;
    defaultMove.liquidCost = 100;

    try {
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalNear(tx, ty, tz, 2));
    } catch (e) {
      ctx.logger.warn('pathfinder goal fail:', e.message);
      return false;
    }

    const TIMEOUT = 15_000;
    const start = Date.now();

    return new Promise(resolve => {
      const checkGoal = setInterval(() => {
        const p = bot.entity.position;
        const dist = Math.hypot(tx - p.x, tz - p.z);
        if (dist <= 1.5 || !bot.pathfinder.isMoving()) {
          clearInterval(checkGoal);
          bot.pathfinder.stop();
          ctx.logger.debug(`pf done d=${dist.toFixed(1)}m`);
          resolve(dist <= 2.5);
          return;
        }
        if (Date.now() - start > TIMEOUT) {
          clearInterval(checkGoal);
          bot.pathfinder.stop();
          ctx.logger.warn('pf timeout');
          resolve(false);
        }
      }, 200);
    });
  }

  /**
   * Topmost collision block at (x, z), scanning DOWN from `maxY` (default
   * 256). Pass the bot's altitude to skip the hundreds of calls spent in the
   * sky every tick.
   */
  function getGroundBlockAt(x, z, maxY = 256) {
    for (let y = Math.min(Math.floor(maxY), 320); y >= 0; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b && !isAir(b) && b.boundingBox !== 'empty' && b.shapes && b.shapes.length > 0) return b;
    }
    return null;
  }

  return {
    getServerRenderDistance,
    scanFullRenderDistance,
    checkRunwayDirection,
    findBestLaunchHeading,
    findElevatedOpenSpot,
    pathfindToSpot,
    getGroundBlockAt,
  };
}

module.exports = { createSpatialEngine };
