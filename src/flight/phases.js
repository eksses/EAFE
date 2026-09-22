'use strict';

const { ErrorCode } = require('../errors');

function createFlightPhases(ctx) {
  const { bot, state } = ctx;

  const canRocket = () => ctx.opts.autoRocket && ctx.countRockets(bot) > 0;

  async function startFlight() {
    if (state.phase !== ctx.PHASE.IDLE && state.phase !== ctx.PHASE.FAILED) {
      // Retargeting mid-cruise is safe (the cruise loop reads the target
      // live) — fly() handles that case before calling here.
      try { bot.chat('In flight -- use stop to abort'); } catch (_) { /* bot gone */ }
      return;
    }

    if (!bot.entity) {
      ctx.failFlight(ErrorCode.NO_ENTITY, 'bot not spawned');
      return;
    }

    state.flightStartPos = bot.entity.position.clone();
    state.lastKnownSafeGround = null;

    // Audit
    const rDist = ctx.spatial.getServerRenderDistance();
    ctx.setPhase(ctx.PHASE.AUDIT, `${state.currentMode.name} ${rDist.chunks}ch -> (${state.activeTargetX},${state.activeTargetZ})`);

    const elytraOk = await ctx.auditAndEquipElytra();
    if (!elytraOk) {
      ctx.failFlight(ErrorCode.NO_ELYTRA, 'no elytra dur>15');
      return;
    }

    if (ctx.opts.safety && ctx.opts.elytraAudit) {
      const d2d = ctx.dist2D(state.activeTargetX, state.activeTargetZ);
      const elytraInfo = ctx.getElytraSummary();
      const reqDur = ctx.calculateRequiredElytraDurability(d2d, state.currentMode.speedMps, elytraInfo.bestUnbreaking);

      ctx.logger.debug(`e: ${elytraInfo.totalDurabilityAcrossAll}/${reqDur} ${elytraInfo.count}x U${elytraInfo.bestUnbreaking}`);

      if (elytraInfo.totalDurabilityAcrossAll < reqDur) {
        ctx.failFlight(ErrorCode.ELYTRA_LOW, `need ${reqDur} dur, have ${elytraInfo.totalDurabilityAcrossAll}`);
        return;
      }
    }

    if (ctx.opts.safety) {
      if (ctx.opts.autoRocket) await ctx.autoEquipRocket();
      const rockets = ctx.countRockets();
      const startY = bot.entity.position.y;
      const reqRkt = ctx.calculateRequiredRockets(ctx.dist2D(state.activeTargetX, state.activeTargetZ), ctx.CRUISE_ALT - startY);

      ctx.logger.debug(`rkt: ${rockets}/${reqRkt}`);

      if (ctx.opts.autoRocket && rockets < reqRkt) {
        ctx.failFlight(ErrorCode.NO_ROCKETS, `need ${reqRkt} rkt, have ${rockets}`);
        return;
      }
    }

    ctx.logger.debug('audit PASS');

    // Find launch heading
    if (!state.spatialClear) {
      let heading = ctx.opts.chunkScan
        ? ctx.spatial.findBestLaunchHeading()
        : { yaw: ctx.yawTo(state.activeTargetX, state.activeTargetZ), headingName: 'direct', clear: true };
      ctx.logger.debug(`heading: ${heading.headingName}`);

      if (!heading.clear) {
        if (!ctx.opts.pathfinding) {
          ctx.failFlight(ErrorCode.NO_LAUNCH_SPOT, 'all headings blocked (pathfinding off)');
          return;
        }

        ctx.logger.warn('all blocked -- pathfinding');
        try { bot.chat('All headings blocked -- relocating'); } catch (_) { /* bot gone */ }

        const spot = ctx.spatial.findElevatedOpenSpot();
        if (!spot) {
          ctx.failFlight(ErrorCode.NO_LAUNCH_SPOT, 'no launch spot');
          return;
        }

        ctx.setPhase(ctx.PHASE.RELOCATING, `-> (${spot.x},${spot.y},${spot.z})`);
        const arrived = await ctx.spatial.pathfindToSpot(spot.x, spot.y, spot.z);
        if (!arrived) {
          ctx.failFlight(ErrorCode.PF_FAILED, 'pf failed');
          return;
        }

        heading = ctx.opts.chunkScan
          ? ctx.spatial.findBestLaunchHeading()
          : { yaw: ctx.yawTo(state.activeTargetX, state.activeTargetZ), headingName: 'direct', clear: true };
        if (!heading.clear) {
          ctx.failFlight(ErrorCode.NO_LAUNCH_SPOT, 'still blocked');
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

    ['sprint', 'forward', 'back', 'left', 'right', 'sneak'].forEach(k => {
      try { bot.setControlState(k, false); } catch (_) { /* bot gone */ }
    });

    if (ctx.opts.autoRocket) await ctx.autoEquipRocket();

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
      ctx.failFlight(ErrorCode.NO_FLIGHT_CONFIRM, 'jump fail');
      return;
    }

    ctx.logger.debug(`airborne Y=${bot.entity.position.y.toFixed(1)}`);

    try {
      await bot.elytraFly();
    } catch (e) {
      ctx.logger.error('elytraFly:', e.message);
      ctx.failFlight(ErrorCode.NO_FLIGHT_CONFIRM, 'elytraFly fail');
      return;
    }

    // Poll until a rocket actually leaves. fireRocketDirect self-gates on
    // yaw alignment and offhand contents, so the first boost goes toward
    // the launch heading (previously it fired immediately and could launch
    // the bot the wrong way). Break on `fired`, NOT on isFlying: at jump
    // apex an elytra is already "flying" (elytraFlying && !onGround) with
    // zero boost, so breaking on isFlying skipped the first fire whenever
    // the yaw gate blocked it (180° heading change at takeoff).
    let fired = false;
    let grounded = 0;
    for (let i = 0; i < 20 && !fired; i++) {
      fired = await ctx.fireRocketDirect(state.activeLaunchYaw);
      if (fired) break;
      grounded = bot.entity.onGround ? grounded + 1 : 0;
      if (grounded > 12) break; // ~1.2 s grounded without a boost → retry loop takes over
      await ctx.sleep(100);
    }

    if (!ctx.isFlying()) {
      ctx.failFlight(ErrorCode.NO_FLIGHT_CONFIRM, 'no flight confirm');
      return;
    }

    ctx.logger.debug('flight OK, climb');
    startClimb();
  }

  function startClimb() {
    ctx.setPhase(ctx.PHASE.CLIMBING, `-> Y=${ctx.CRUISE_ALT}`);

    let climbTicks = 0;

    ctx.lookForce(state.activeLaunchYaw, 0.45);

    if (ctx.rocketLoop) { clearInterval(ctx.rocketLoop); ctx.rocketLoop = null; }
    if (ctx.climbLoop) { clearInterval(ctx.climbLoop); ctx.climbLoop = null; }

    ctx.climbLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CLIMBING) { clearInterval(ctx.climbLoop); ctx.climbLoop = null; return; }

      climbTicks++;
      const pos = bot.entity.position;
      const targetYaw = ctx.yawTo(state.activeTargetX, state.activeTargetZ);

      ctx.checkMidFlightElytraSwap();

      // Out of fuel mid-climb: stop climbing toward altitude we can no
      // longer buy — hand off to the cruise loops in DEADSTICK. They
      // already run in DEADSTICK (no rockets, level glide) and steer to
      // the goal. Without this, a 1-rocket launch burns its only boost
      // at takeoff, stalls on the ground during climb, and dies with
      // GROUND_HIT before ever reaching the cruise altitude where
      // rocketLoop would have noticed the empty inventory.
      if (ctx.opts.autoRocket && ctx.countRockets() === 0 && climbTicks > 3) {
        clearInterval(ctx.climbLoop); ctx.climbLoop = null;
        ctx.setPhase(ctx.PHASE.DEAD_STICK, 'out of rkt');
        startCruise({ keepPhase: true });
        return;
      }

      // Track safe ground
      const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z), pos.y + 10);
      if (groundUnder && ctx.isSafeSolid(groundUnder)) {
        state.lastKnownSafeGround = { x: Math.round(pos.x), y: groundUnder.position?.y ?? Math.round(pos.y), z: Math.round(pos.z), blockName: groundUnder.name };
      }

      // Terrain scan with the current heading
      let pitch = climbTicks <= 4 ? 0.45 : 0.65;
      let terrainAhead = false;
      if (ctx.opts.chunkScan) {
        const currentYaw = pos.y >= 95 ? targetYaw : state.activeLaunchYaw;
        const scan = ctx.spatial.scanFullRenderDistance(currentYaw, pitch);
        terrainAhead = scan.hit;
        if (scan.hit) {
          if (Date.now() - state.lastTerrainWarn > 3000) {
            ctx.logger.warn(`terrain ${scan.block} d=${scan.dist}m -- climb steep`);
            state.lastTerrainWarn = Date.now();
          }
          pitch = 0.75;
        }
      }

      // Turn toward the target once high enough — or immediately when the
      // way is clear, instead of holding a detour heading until Y=95.
      const currentYaw = (pos.y >= 95 || !terrainAhead) ? targetYaw : state.activeLaunchYaw;

      // Rockets: only when slow and 2s+ since last
      const speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z);
      if (ctx.opts.autoRocket && speed < 0.65 && Date.now() - ctx.getBoostTime() > 2000 && canRocket()) {
        ctx.fireRocketDirect(currentYaw);
      }

      ctx.lookForce(currentYaw, pitch);

      // Any sustained ground contact during climb = failure (covers the old
      // "fell below launch point" case AND the ledge-stuck case where the
      // bot sat at Y just under cruise altitude forever).
      if (bot.entity.onGround && climbTicks > 10 && !ctx.isFlying()) {
        clearInterval(ctx.climbLoop); ctx.climbLoop = null;
        ctx.failFlight(ErrorCode.GROUND_HIT, `ground hit climb Y=${Math.round(pos.y)}`);
        return;
      }

      // Hard climb timeout (90s) as a safety net
      if (climbTicks > 450) {
        clearInterval(ctx.climbLoop); ctx.climbLoop = null;
        ctx.failFlight(ErrorCode.CLIMB_TIMEOUT, `stuck at Y=${Math.round(pos.y)}`);
        return;
      }

      // Lost flight
      if (!ctx.isFlying() && !bot.entity.onGround) {
        ctx.logger.warn('fly=false mid-climb');
        bot.elytraFly().catch(() => {});
        return;
      }

      // Reached cruise altitude
      if (pos.y >= ctx.CRUISE_ALT) {
        clearInterval(ctx.climbLoop); ctx.climbLoop = null;
        startCruise();
      }
    }, 200);
  }

  function startCruise(opts = {}) {
    if (!opts.keepPhase) {
      ctx.setPhase(ctx.PHASE.CRUISING, `-> (${state.activeTargetX},?,${state.activeTargetZ}) [${state.currentMode.name}]`);
    }

    // Rocket check loop — 3s interval
    if (ctx.rocketLoop) clearInterval(ctx.rocketLoop);
    ctx.rocketLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) { clearInterval(ctx.rocketLoop); ctx.rocketLoop = null; return; }
      if (ctx.opts.autoRocket && ctx.countRockets() === 0 && state.phase !== ctx.PHASE.DEAD_STICK) {
        ctx.setPhase(ctx.PHASE.DEAD_STICK, 'out of rkt');
      }
    }, 3000);

    // Main flight loop — 50ms
    if (ctx.flyLoop) clearInterval(ctx.flyLoop);
    ctx.flyLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) { clearInterval(ctx.flyLoop); ctx.flyLoop = null; return; }

      const pos = bot.entity.position;
      ctx.checkMidFlightElytraSwap();

      // Track safe ground
      const groundUnder = ctx.spatial.getGroundBlockAt(Math.round(pos.x), Math.round(pos.z), pos.y + 10);
      if (groundUnder && ctx.isSafeSolid(groundUnder)) {
        state.lastKnownSafeGround = { x: Math.round(pos.x), y: groundUnder.position?.y ?? Math.round(pos.y), z: Math.round(pos.z), blockName: groundUnder.name };
      }

      const d = ctx.dist2D(state.activeTargetX, state.activeTargetZ);

      // Ground height under the target (scan only near the bot's altitude —
      // a full 320-deep scan twice per 50ms tick was pure waste).
      const groundY = ctx.spatial.getGroundBlockAt(state.activeTargetX, state.activeTargetZ, pos.y + 30)?.position?.y ?? 60;
      const dV = Math.max(0, pos.y - groundY);

      // ── Approach geometry ──
      // Descent starts far enough out that the elytra's glide ratio can bring
      // the bot to dV<60 before it reaches the target. (The old "start
      // descending within 100m" rule made the trigger `d<40 && dV<50`
      // unreachable: the bot flew past the target still 90+ blocks up.)
      const descentStart = Math.max(100, (dV - 50) * 2.1 + 60);
      const inDescent = d < descentStart;
      const lowEnough = dV < 60;

      // Landing trigger
      if (lowEnough && inDescent) {
        clearInterval(ctx.flyLoop); ctx.flyLoop = null;
        clearInterval(ctx.rocketLoop); ctx.rocketLoop = null;
        if (ctx.verifyLoop) { clearInterval(ctx.verifyLoop); ctx.verifyLoop = null; }

        if (!ctx.opts.landing) {
          // No spot search — dive straight at the target column
          ctx.startLanding({ skipSpotSearch: true });
          return;
        }

        const spot = ctx.wander.findSafeLandingSpotAround(state.activeTargetX, state.activeTargetZ);
        if (spot.safe) {
          ctx.startLanding({ spot });
        } else if (ctx.opts.wander) {
          ctx.logger.info(`no spot at (${state.activeTargetX},${state.activeTargetZ}) -- wander`);
          ctx.startWanderScan();
        } else {
          ctx.failFlight(ErrorCode.NO_SAFE_SPOT, 'no landing spot (wander off)');
        }
        return;
      }

      // Cruise / descent pitch
      const yaw = ctx.yawTo(state.activeTargetX, state.activeTargetZ);
      let pitch;

      if (inDescent) {
        // Steady ~26° dive; no rockets — gravity does the work and the
        // dive builds speed on its own.
        pitch = -0.45;
      } else {
        const timeSinceBoost = Date.now() - ctx.getBoostTime();
        pitch = state.phase === ctx.PHASE.DEAD_STICK ? 0.02 : state.currentMode.pitch;
        if (state.phase === ctx.PHASE.CRUISING) {
          pitch = timeSinceBoost < 1000 ? 0.15 : -0.04;

          // Rockets: below cruise alt AND far from target
          if (ctx.opts.autoRocket && pos.y < ctx.CRUISE_ALT && d > 100) {
            ctx.smartFireRocket();
          }
        }
      }

      // Terrain avoidance
      if (ctx.opts.chunkScan) {
        const scan = ctx.spatial.scanFullRenderDistance(yaw, pitch);
        if (scan.hit && scan.dist < 60) {
          if (Date.now() - state.lastTerrainWarn > 3000) {
            ctx.logger.warn(`terrain ${scan.block} d=${scan.dist}m -- over`);
            state.lastTerrainWarn = Date.now();
          }
          pitch = 0.55;
          if (ctx.opts.autoRocket && canRocket()) ctx.fireRocketDirect(yaw);
        }
      }

      // Stall recovery
      const speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z);
      if (speed < 0.05 && pos.y > 60) {
        ctx.logger.warn('stall -- 180 boost');
        ctx.lookForce(yaw + Math.PI, 0.70);
        if (ctx.opts.autoRocket) ctx.fireRocketDirect();
        return;
      }

      ctx.lookForce(yaw, pitch);
    }, 50);

    // Drift verification — 2s interval
    if (ctx.verifyLoop) clearInterval(ctx.verifyLoop);
    let lastDist = ctx.dist2D(state.activeTargetX, state.activeTargetZ);

    ctx.verifyLoop = setInterval(() => {
      if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) { clearInterval(ctx.verifyLoop); ctx.verifyLoop = null; return; }

      const curDist = ctx.dist2D(state.activeTargetX, state.activeTargetZ);
      const prevDist = lastDist;
      lastDist = curDist;
      const targetYaw = ctx.yawTo(state.activeTargetX, state.activeTargetZ);

      if (curDist > prevDist + 5) {
        ctx.logger.warn(`drift -- realign`);
        ctx.lookForce(targetYaw, state.currentMode.pitch);
      }

      if (!ctx.isFlying() && !bot.entity.onGround) {
        ctx.logger.warn('fly=false cruise -- recover');
        ctx.auditAndEquipElytra().then(() => {
          if (state.phase !== ctx.PHASE.CRUISING && state.phase !== ctx.PHASE.DEAD_STICK) return;
          bot.elytraFly().catch(e => {
            ctx.failFlight(ErrorCode.LOST_FLIGHT, 'lost flight: ' + e.message);
          });
          if (ctx.opts.autoRocket && canRocket()) ctx.fireRocketDirect(targetYaw);
        });
        return;
      }
    }, 2000);
  }

  return { startFlight, startClimb, startCruise, executeTakeoff };
}

module.exports = { createFlightPhases };
