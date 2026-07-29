'use strict';

const Logger = require('../logger');
const { isAir, isHazardousBlock, isSafeSolidBlock } = require('../utils');

function createFlightPhases(ctx) {
  const { bot, state } = ctx;

  async function startFlight() {
    if (state.phase !== ctx.PHASE.IDLE && state.phase !== ctx.PHASE.FAILED) {
      try { bot.chat('In flight -- s to stop'); } catch(_) {}
      return;
    }

    state.flightStartPos = bot.entity.position.clone();
    state.lastKnownSafeGround = null;

    const rDist = ctx.spatial.getServerRenderDistance();
    ctx.setPhase(ctx.PHASE.AUDIT, `${state.currentMode.name} ${rDist.chunks}ch -> (${state.activeTargetX},${state.activeTargetZ})`);

    const elytraOk = await ctx.auditAndEquipElytra();
    if (!elytraOk) {
      ctx.setPhase(ctx.PHASE.FAILED, 'no elytra dur>15');
      return;
    }

    const d2d = ctx.dist2D(state.activeTargetX, state.activeTargetZ);
    const elytraInfo = ctx.getElytraSummary(bot);
    const reqElytraDur = ctx.calculateRequiredElytraDurability(d2d, state.currentMode.speedMps, elytraInfo.bestUnbreaking);

    Logger.debug(`e: ${elytraInfo.totalDurabilityAcrossAll}/${reqElytraDur} ${elytraInfo.count}x U${elytraInfo.bestUnbreaking}`);

    if (elytraInfo.totalDurabilityAcrossAll < reqElytraDur) {
      ctx.setPhase(ctx.PHASE.FAILED, `need ${reqElytraDur} dur, have ${elytraInfo.totalDurabilityAcrossAll}`);
      return;
    }

    await ctx.autoEquipRocket(bot);

    const rocketsAvail = ctx.countRockets(bot);
    const startY = bot.entity.position.y;
    const reqRockets = ctx.calculateRequiredRockets(d2d, ctx.CRUISE_ALT - startY);

    Logger.debug(`rkt: ${rocketsAvail}/${reqRockets}`);

    if (rocketsAvail < reqRockets) {
      ctx.setPhase(ctx.PHASE.FAILED, `need ${reqRockets} rkt, have ${rocketsAvail}`);
      return;
    }

    Logger.debug('audit PASS');

    if (!state.spatialClear) {
      let heading = ctx.spatial.findBestLaunchHeading();
      Logger.debug(`heading: ${heading.headingName}`);

      if (!heading.clear) {
        Logger.warn('all blocked -- pathfinding');
        try { bot.chat('All headings blocked -- relocating'); } catch(_) {}

        const spot = ctx.spatial.findElevatedOpenSpot();
        if (!spot) {
          ctx.setPhase(ctx.PHASE.FAILED, 'no launch spot');
          ctx.scheduleRetry();
          return;
        }

        ctx.setPhase(ctx.PHASE.RELOCATING, `-> (${spot.x},${spot.y},${spot.z})`);
        const arrived = await ctx.spatial.pathfindToSpot(spot.x, spot.y, spot.z);
        if (!arrived) {
          ctx.setPhase(ctx.PHASE.FAILED, 'pf failed');
          ctx.scheduleRetry();
          return;
        }

        heading = ctx.spatial.findBestLaunchHeading();
        if (!heading.clear) {
          ctx.setPhase(ctx.PHASE.FAILED, 'still blocked');
          ctx.scheduleRetry();
          return;
        }
      }

      state.activeLaunchYaw = heading.yaw;
      state.spatialClear = true;
    }

    await executeTakeoff();
  }

  async function executeTakeoff() {
    if (state.phase === ctx.PHASE.FAILED) return;
    ctx.setPhase(ctx.PHASE.TAKEOFF, 'jump+elytra');

    ['sprint','forward','back','left','right','sneak'].forEach(k => {
      try { bot.setControlState(k, false); } catch(_) {}
    });

    await ctx.autoEquipRocket(bot);
    ctx.lookForce(state.activeLaunchYaw, 0.5);

    bot.setControlState('jump', true);

    const airborne = await new Promise(resolve => {
      let t = 0;
      const chk = setInterval(() => {
        t++;
        if (!bot.entity.onGround) { clearInterval(chk); resolve(true); return; }
        if (t > 20) { clearInterval(chk); resolve(false); }
      }, 50);
    });

    bot.setControlState('jump', false);

    if (!airborne) {
      ctx.setPhase(ctx.PHASE.FAILED, 'jump fail');
      ctx.scheduleRetry();
      return;
    }

    Logger.debug(`airborne Y=${bot.entity.position.y.toFixed(1)}`);

    try {
      await bot.elytraFly();
    } catch(e) {
      Logger.error('elytraFly:', e.message);
      ctx.setPhase(ctx.PHASE.FAILED, 'elytraFly fail');
      ctx.scheduleRetry();
      return;
    }

    ctx.fireRocketDirect();

    await ctx.sleep(200);
    if (!ctx.isFlying()) {
      Logger.warn('fly=false post-launch -- retry');
      try { await bot.elytraFly(); } catch(_) {}
      ctx.fireRocketDirect();
      await ctx.sleep(250);
      if (!ctx.isFlying()) {
        ctx.setPhase(ctx.PHASE.FAILED, 'no flight confirm');
        ctx.scheduleRetry();
        return;
      }
    }

    Logger.debug('flight OK, climb');
    startClimb();
  }

  function startClimb() {
    ctx.setPhase(ctx.PHASE.CLIMBING, `-> Y=${ctx.CRUISE_ALT}`);

    let climbTicks = 0;
    const launchPosY = bot.entity.position.y;

    ctx.lookForce(state.activeLaunchYaw, 0.45);
    ctx.fireRocketDirect(null, 0);

    if (ctx.rocketLoop) { clearInterval(ctx.rocketLoop); ctx.rocketLoop = null; }

    if (ctx.climbLoop) clearInterval(ctx.climbLoop);
    ctx.climbLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CLIMBING) { clearInterval(ctx.climbLoop); ctx.climbLoop = null; return; }

      climbTicks++;
      const pos = bot.entity.position;
      const targetYaw = ctx.yawTo(state.activeTargetX, state.activeTargetZ);

      ctx.checkMidFlightElytraSwap();

      const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      if (groundUnder && isSafeSolidBlock(groundUnder)) {
        state.lastKnownSafeGround = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), blockName: groundUnder.name };
      }

      let currentYaw = state.activeLaunchYaw;
      if (pos.y >= 95) currentYaw = targetYaw;

      let climbPitch = (climbTicks <= 4) ? 0.45 : 0.65;
      const terrainScan = ctx.spatial.scanFullRenderDistance(currentYaw, climbPitch);
      if (terrainScan.hit) {
        if (Date.now() - state.lastTerrainWarn > 3000) {
          Logger.warn(`terrain ${terrainScan.block} d=${terrainScan.dist}m -- climb steep`);
          state.lastTerrainWarn = Date.now();
        }
        climbPitch = 0.75;
      }

      // Rockets only when speed drops below threshold — not every tick
      const vel = bot.entity.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      const timeSinceBoost = Date.now() - ctx.getBoostTime();

      if (speed < 0.65 && timeSinceBoost > 2000 && ctx.countRockets(bot) > 0) {
        ctx.fireRocketDirect(currentYaw);
      }

      ctx.lookForce(currentYaw, climbPitch);

      if (bot.entity.onGround && pos.y < ctx.CRUISE_ALT - 10 && climbTicks > 5 && (pos.y < launchPosY - 2.0)) {
        clearInterval(ctx.climbLoop); ctx.climbLoop = null;
        ctx.setPhase(ctx.PHASE.FAILED, 'ground hit climb');
        ctx.scheduleRetry();
        return;
      }

      if (!ctx.isFlying() && !bot.entity.onGround) {
        Logger.warn('fly=false mid-climb');
        bot.elytraFly().catch(() => {});
        ctx.fireRocketDirect(null, 1500);
        return;
      }

      if (pos.y >= ctx.CRUISE_ALT) {
        clearInterval(ctx.climbLoop); ctx.climbLoop = null;
        startCruise();
      }
    }, 200);
  }

  function startCruise() {
    ctx.setPhase(ctx.PHASE.CRUISING, `-> (${state.activeTargetX},?,${state.activeTargetZ}) [${state.currentMode.name}]`);

    if (ctx.rocketLoop) clearInterval(ctx.rocketLoop);
    ctx.rocketLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) { clearInterval(ctx.rocketLoop); ctx.rocketLoop = null; return; }

      if (ctx.countRockets(bot) === 0 && state.phase !== ctx.PHASE.DEAD_STICK) {
        ctx.setPhase(ctx.PHASE.DEAD_STICK, 'out of rkt');
      }
    }, 3000);

    if (ctx.flyLoop) clearInterval(ctx.flyLoop);
    ctx.flyLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) { clearInterval(ctx.flyLoop); ctx.flyLoop = null; return; }

      const pos = bot.entity.position;

      ctx.checkMidFlightElytraSwap();

      const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      if (groundUnder && isSafeSolidBlock(groundUnder)) {
        state.lastKnownSafeGround = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), blockName: groundUnder.name };
      }

      const d = ctx.dist2D(state.activeTargetX, state.activeTargetZ);
      const groundY = ctx.spatial.getGroundBlockAt(state.activeTargetX, state.activeTargetZ)?.position?.y ?? 60;
      const dV = pos.y - groundY;

      if (d < 40 && dV < 50) {
        clearInterval(ctx.flyLoop); ctx.flyLoop = null;
        clearInterval(ctx.rocketLoop); ctx.rocketLoop = null;
        clearInterval(ctx.verifyLoop); ctx.verifyLoop = null;

        // Check if landing spot exists at target before starting landing
        const spot = ctx.wander.findSafeLandingSpotAround(state.activeTargetX, state.activeTargetZ);
        if (spot.safe) {
          ctx.startLanding();
        } else {
          Logger.info(`no spot at (${state.activeTargetX},${state.activeTargetZ}) -- wander`);
          ctx.startWanderScan();
        }
        return;
      }

      const yaw = ctx.yawTo(state.activeTargetX, state.activeTargetZ);
      const vel = bot.entity.velocity;

      const timeSinceBoostMs = Date.now() - ctx.getBoostTime();
      let cruisePitch = (state.phase === ctx.PHASE.DEAD_STICK) ? 0.02 : state.currentMode.pitch;

      if (state.phase === ctx.PHASE.CRUISING) {
        cruisePitch = (timeSinceBoostMs < 1000) ? 0.15 : -0.04;

        // Descend faster when close horizontally but still high above target
        if (d < 100 && dV > 50) {
          cruisePitch = -0.20;
        } else if (d < 60 && dV > 30) {
          cruisePitch = -0.12;
        }

        // Rockets: only when below cruise alt AND far from target
        // Use pos.y directly, not dV (altitude above ground varies)
        if (pos.y < ctx.CRUISE_ALT && d > 100) {
          ctx.smartFireRocket();
        }
      }

      const terrainScan = ctx.spatial.scanFullRenderDistance(yaw, cruisePitch);
      if (terrainScan.hit && terrainScan.dist < 60) {
        if (Date.now() - state.lastTerrainWarn > 3000) {
          Logger.warn(`terrain ${terrainScan.block} d=${terrainScan.dist}m -- over`);
          state.lastTerrainWarn = Date.now();
        }
        cruisePitch = 0.55;
        if (ctx.countRockets(bot) > 0) ctx.fireRocketDirect(yaw);
      }

      if (Math.hypot(vel.x, vel.y, vel.z) < 0.05 && bot.entity.position.y > 60) {
        Logger.warn('stall -- 180 boost');
        ctx.lookForce(yaw + Math.PI, 0.70);
        ctx.fireRocketDirect();
        return;
      }

      ctx.lookForce(yaw, cruisePitch);
    }, 50);

    if (ctx.verifyLoop) clearInterval(ctx.verifyLoop);
    let lastDist = ctx.dist2D(state.activeTargetX, state.activeTargetZ);
    ctx.verifyLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) { clearInterval(ctx.verifyLoop); ctx.verifyLoop = null; return; }

      const pos = bot.entity.position;
      const curDist = ctx.dist2D(state.activeTargetX, state.activeTargetZ);
      const targetYaw = ctx.yawTo(state.activeTargetX, state.activeTargetZ);

      if (curDist > lastDist + 5) {
        Logger.warn(`drift ${lastDist.toFixed(0)}->${curDist.toFixed(0)}m -- realign`);
        ctx.lookForce(targetYaw, state.currentMode.pitch);
      }

      if (!ctx.isFlying() && !bot.entity.onGround) {
        Logger.warn('fly=false cruise -- recover');
        ctx.auditAndEquipElytra().then(() => {
          if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) return;
          bot.elytraFly().catch(e => {
            ctx.setPhase(ctx.PHASE.FAILED, 'lost flight: ' + e.message);
            ctx.scheduleRetry();
          });
          if (ctx.countRockets(bot) > 0) ctx.fireRocketDirect(targetYaw);
        });
        return;
      }

      lastDist = curDist;
    }, 2000);
  }

  return { startFlight, startClimb, startCruise, executeTakeoff };
}

module.exports = { createFlightPhases };
