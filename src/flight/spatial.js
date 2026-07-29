'use strict';

const { Vec3 } = require('vec3');
const { Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Logger = require('../logger');
const { isAir, isHazardousBlock, isSafeSolidBlock } = require('../utils');

function createSpatialEngine(ctx) {
  const { bot } = ctx;

  function getServerRenderDistance() {
    if (!bot.entity || !bot.world) return { chunks: 6, blocks: 96, scanAlt: 120 };

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
    } catch(_) {}

    const chunks = Math.min(Math.max(maxDistChunks, 4), 16);
    const blocks = chunks * 16;
    const scanAlt = Math.min(Math.max(Math.round(60 + blocks * 0.6), 90), 160);

    return { chunks, blocks, scanAlt };
  }

  function scanFullRenderDistance(yaw, currentPitch) {
    const pos = bot.entity.position;
    const eyePos = pos.offset(0, 1.6, 0);
    const rDist = getServerRenderDistance();
    const maxRaycastBlocks = rDist.blocks;

    const cosPitch = Math.cos(currentPitch);
    const sinPitch = Math.sin(currentPitch);
    const dirX = -Math.sin(yaw) * cosPitch;
    const dirY = sinPitch;
    const dirZ = Math.cos(yaw) * cosPitch;

    for (let d = 1; d <= maxRaycastBlocks; d += 2) {
      const checkPos = eyePos.offset(dirX * d, dirY * d, dirZ * d);
      const b = bot.blockAt(checkPos);
      if (b && !isAir(b) && !isHazardousBlock(b)) {
        return { hit: true, dist: d, block: b.name, pos: checkPos };
      }
    }

    return { hit: false, dist: maxRaycastBlocks, block: null, pos: null };
  }

  function checkRunwayDirection(testYaw) {
    const pos = bot.entity.position;

    for (let dy = 1; dy <= 5; dy++) {
      const b = bot.blockAt(pos.offset(0, dy, 0));
      if (!isAir(b)) return { clear: false, reason: `overhead Y+${dy} ${b?.name}` };
    }

    const dirX = -Math.sin(testYaw);
    const dirZ = Math.cos(testYaw);

    for (let d = 1; d <= 4; d++) {
      for (let dy = 1; dy <= 2; dy++) {
        const bPos = pos.offset(Math.round(dirX * d), dy, Math.round(dirZ * d));
        const b = bot.blockAt(bPos);
        if (!isAir(b)) return { clear: false, reason: `ahead ${d}m Y+${dy} ${b?.name}` };
      }
    }

    const blockUnder = bot.blockAt(pos.offset(0, -0.5, 0));
    if (isHazardousBlock(blockUnder)) return { clear: false, reason: `liquid ${blockUnder?.name}` };

    return { clear: true, reason: 'clear' };
  }

  function findBestLaunchHeading() {
    const targetYaw = ctx.yawTo(ctx.state.activeTargetX, ctx.state.activeTargetZ);
    const targetCheck = checkRunwayDirection(targetYaw);
    if (targetCheck.clear) {
      return { yaw: targetYaw, headingName: 'direct', clear: true };
    }

    const COMPASS = [
      { name: 'W', yaw: Math.PI / 2 },
      { name: 'N', yaw: Math.PI },
      { name: 'E', yaw: -Math.PI / 2 },
      { name: 'S', yaw: 0 },
      { name: 'NW', yaw: 3 * Math.PI / 4 },
      { name: 'SW', yaw: Math.PI / 4 },
      { name: 'NE', yaw: -3 * Math.PI / 4 },
      { name: 'SE', yaw: -Math.PI / 4 },
    ];

    for (const dir of COMPASS) {
      const check = checkRunwayDirection(dir.yaw);
      if (check.clear) {
        try { bot.chat(`Target blocked -- heading ${dir.name}`); } catch(_) {}
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

        for (let dy = 1; dy >= -4; dy--) {
          const b = bot.blockAt(new Vec3(cx, baseY + dy, cz));
          if (b && !isAir(b)) {
            groundBlock = b;
            groundY = baseY + dy + 1;
            break;
          }
        }

        if (!groundBlock || !isSafeSolidBlock(groundBlock)) continue;

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

  async function pathfindToSpot(tx, ty, tz) {
    Logger.debug(`pf -> (${tx},${ty},${tz})`);

    const defaultMove = new Movements(bot);
    defaultMove.canDig = true;
    defaultMove.allow1by1tunnels = true;
    defaultMove.allowParkour = true;
    defaultMove.canSwim = false;
    defaultMove.liquidCost = 100;

    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(tx, ty, tz));

    const TIMEOUT = 15_000;
    const start = Date.now();

    return new Promise(resolve => {
      const checkGoal = setInterval(() => {
        const p = bot.entity.position;
        const dist = Math.hypot(tx - p.x, tz - p.z);
        if (dist <= 1.5 || !bot.pathfinder.isMoving()) {
          clearInterval(checkGoal);
          bot.pathfinder.stop();
          Logger.debug(`pf done d=${dist.toFixed(1)}m`);
          resolve(dist <= 2.5);
        }
        if (Date.now() - start > TIMEOUT) {
          clearInterval(checkGoal);
          bot.pathfinder.stop();
          Logger.warn('pf timeout');
          resolve(false);
        }
      }, 200);
    });
  }

  function getGroundBlockAt(x, z) {
    const pos = bot.entity.position;
    const baseY = Math.floor(pos.y);
    for (let dy = 5; dy >= -15; dy--) {
      const b = bot.blockAt(new Vec3(x, baseY + dy, z));
      if (b && !isAir(b)) return b;
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
