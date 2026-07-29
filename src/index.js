'use strict';

const mineflayer = require('mineflayer');
const readline = require('readline');
const physicsLoader = require('@nxg-org/mineflayer-physics-util').default;
const { EPhysicsCtx } = require('@nxg-org/mineflayer-physics-util');
const { pathfinder } = require('mineflayer-pathfinder');

const config = require('./config');
const { PHASE, MODES } = require('./constants');
const { sleep, isAir } = require('./utils');
const Logger = require('./logger');
const { createChat } = require('./core/chat');
const { countRockets, autoEquipRocket } = require('./core/inventory');
const { getElytraSummary, auditAndEquipElytra, calculateRequiredElytraDurability } = require('./core/elytra');
const { createRocketEngine } = require('./core/rockets');
const { createSpatialEngine } = require('./flight/spatial');
const { createFlightPhases } = require('./flight/phases');
const { createWanderEngine } = require('./flight/wander');
const { createLandingEngine } = require('./flight/landing');
const { createCommandProcessor } = require('./commands');

function createBot() {
  const bot = mineflayer.createBot({
    host: config.HOST,
    port: config.PORT,
    username: config.USERNAME,
    version: false,
    auth: 'offline',
    checkTimeoutInterval: 60_000,
  });

  bot.loadPlugin(physicsLoader);
  bot.loadPlugin(pathfinder);

  const state = {
    phase: PHASE.IDLE,
    currentMode: MODES.MEDIUM,
    activeTargetX: config.DEFAULT_TARGET_X,
    activeTargetZ: config.DEFAULT_TARGET_Z,
    retries: 0,
    spatialClear: false,
    activeLaunchYaw: 0,
    lastTerrainWarn: 0,
    lastKnownSafeGround: null,
    flightStartPos: null,
    legStartPos: null,
    scannedChunks: new Set(),
  };

  let flyLoop = null;
  let verifyLoop = null;
  let rocketLoop = null;
  let climbLoop = null;

  function clearTimers() {
    [flyLoop, verifyLoop, rocketLoop, climbLoop].forEach(h => { if (h) clearInterval(h); });
    flyLoop = verifyLoop = rocketLoop = climbLoop = null;
  }

  function yawTo(x, z) {
    const p = bot.entity.position;
    return Math.atan2(-(x - p.x), -(z - p.z));
  }

  function dist2D(x, z) {
    const p = bot.entity.position;
    return Math.hypot((x ?? state.activeTargetX) - p.x, (z ?? state.activeTargetZ) - p.z);
  }

  function lookForce(yaw, pitch) {
    bot.look(yaw, pitch, true);
  }

  function calculateRequiredRockets(d2d, deltaY) {
    const dReq = Math.ceil(d2d / state.currentMode.fuelDistDivider);
    const yReq = Math.ceil(Math.abs(deltaY) / 10.0);
    const retryWasteBuffer = config.MAX_RETRIES * 3;
    const wanderLandingBuffer = 12;
    return dReq + yReq + retryWasteBuffer + wanderLandingBuffer;
  }

  let physEngine = null;

  function isFlying() {
    const e = bot.entity;
    if (!e) return false;
    const server = e.elytraFlying === true || e.fallFlying === true;
    let sim = false;
    if (physEngine) {
      try { const ctx = EPhysicsCtx.FROM_BOT(physEngine, bot); sim = ctx.state.fallFlying === true; } catch(_) {}
    }
    return (server || sim) && !e.onGround;
  }

  function scheduleRetry() {
    if (state.retries >= config.MAX_RETRIES) {
      ctx.setPhase(PHASE.FAILED, `FAIL after ${config.MAX_RETRIES} retries`);
      state.spatialClear = false;
      return;
    }
    state.retries++;
    const delay = state.retries * 3000;
    Logger.warn(`retry ${state.retries}/${config.MAX_RETRIES} in ${delay / 1000}s`);
    setTimeout(() => {
      state.phase = PHASE.IDLE;
      ctx.startFlight();
    }, delay);
  }

  const ctx = {
    bot,
    state,
    PHASE,
    CRUISE_ALT: config.CRUISE_ALT,
    MAX_RETRIES: config.MAX_RETRIES,
    clearTimers,
    yawTo,
    dist2D,
    lookForce,
    calculateRequiredRockets,
    isFlying,
    scheduleRetry,
    sleep,
    countRockets,
    autoEquipRocket,
    getElytraSummary,
    auditAndEquipElytra: (botRef) => auditAndEquipElytra(ctx, botRef || bot),
    calculateRequiredElytraDurability,
    get flyLoop() { return flyLoop; },
    set flyLoop(v) { flyLoop = v; },
    get verifyLoop() { return verifyLoop; },
    set verifyLoop(v) { verifyLoop = v; },
    get rocketLoop() { return rocketLoop; },
    set rocketLoop(v) { rocketLoop = v; },
    get climbLoop() { return climbLoop; },
    set climbLoop(v) { climbLoop = v; },
  };

  const chat = createChat(ctx);
  ctx.safeChat = chat.safeChat;
  ctx.setPhase = chat.setPhase;
  ctx.emergencyStop = chat.emergencyStop;

  const rockets = createRocketEngine(ctx);
  ctx.fireRocketDirect = rockets.fireRocketDirect;
  ctx.shouldFireRocketDynamic = rockets.shouldFireRocketDynamic;
  ctx.smartFireRocket = rockets.smartFireRocket;
  ctx.getBoostTime = rockets.getBoostTime;

  const spatial = createSpatialEngine(ctx);
  ctx.spatial = spatial;

  const wander = createWanderEngine(ctx);
  ctx.wander = wander;
  ctx.startWanderScan = wander.startWanderScan;

  const landing = createLandingEngine(ctx);
  ctx.startLanding = landing.startLanding;

  const phases = createFlightPhases(ctx);
  ctx.startFlight = phases.startFlight;
  ctx.startClimb = phases.startClimb;
  ctx.startCruise = phases.startCruise;

  const commands = createCommandProcessor(ctx);

  ctx.auditAndEquipElytra = () => auditAndEquipElytra(ctx);

  ctx.checkMidFlightElytraSwap = async () => {
    const chest = bot.inventory.slots[6];
    if (!chest || chest.name !== 'elytra') return;

    const dur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
    if (dur <= 10) {
      Logger.warn(`elytra dur=${dur}/432 -- swapping`);
      const swapped = await auditAndEquipElytra(ctx);
      if (swapped) {
        Logger.debug('elytra swapped mid-flight');
        try { await bot.elytraFly(); } catch(_) {}
        ctx.fireRocketDirect();
      } else {
        Logger.error('no spare elytras -- emergency land');
        ctx.safeChat('Elytra dead, no spares! Emergency landing!');
        ctx.startLanding();
      }
    }
  };

  bot.once('spawn', () => {
    Logger.info('spawned');

    if (bot.physicsUtil) {
      physEngine = bot.physicsUtil.engine;
    }

    bot._client.on('entity_velocity', packet => {
      if (!bot.entity || packet.entityId !== bot.entity.id) return;
      bot.entity.velocity.x = packet.velocity.x / 8000;
      bot.entity.velocity.y = packet.velocity.y / 8000;
      bot.entity.velocity.z = packet.velocity.z / 8000;
    });

    bot._client.on('explosion', expl => {
      if (!bot.entity) return;
      if (expl.playerKnockback) {
        bot.entity.velocity.x += expl.playerKnockback.x;
        bot.entity.velocity.y += expl.playerKnockback.y;
        bot.entity.velocity.z += expl.playerKnockback.z;
      } else if ('playerMotionX' in expl) {
        bot.entity.velocity.x += expl.playerMotionX;
        bot.entity.velocity.y += expl.playerMotionY;
        bot.entity.velocity.z += expl.playerMotionZ;
      }
    });

    setTimeout(() => {
      auditAndEquipElytra(ctx).then(ok => {
        autoEquipRocket(bot).then(() => {
          const r = countRockets(bot);
          const e = getElytraSummary(bot);
          const rd = spatial.getServerRenderDistance();
          Logger.info(`ready elytra=${ok} dur=${e.totalDurabilityAcrossAll} U${e.bestUnbreaking} rockets=${r} mode=${state.currentMode.name} render=${rd.chunks}ch`);
          try {
            bot.chat(`Ready T=(${state.activeTargetX},${state.activeTargetZ}) M=${state.currentMode.name} R=${rd.chunks}ch E=${e.count}(dur:${e.totalDurabilityAcrossAll},U${e.bestUnbreaking}) Rk=${r} | f [X Z] m fast/med/low s=stop`);
          } catch(_) {}
        });
      });
    }, 2000);

    bot.on('playerCollect', collector => {
      if (collector.username !== bot.username) return;
      if (state.phase !== PHASE.IDLE) return;
      setTimeout(() => {
        auditAndEquipElytra(ctx).catch(() => {});
        autoEquipRocket(bot).catch(() => {});
      }, 300);
    });

    bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
      if (state.phase !== PHASE.IDLE) return;
      if (newItem?.name === 'elytra') {
        setTimeout(() => auditAndEquipElytra(ctx).catch(() => {}), 200);
      }
      if (newItem?.name === 'firework_rocket') {
        setTimeout(() => autoEquipRocket(bot).catch(() => {}), 200);
      }
    });
  });

  bot.on('chat', (user, msg) => {
    if (user === bot.username) return;
    commands.processUserCommand(msg);
  });

  if (process.stdin.isTTY || process.env.NODE_ENV !== 'test') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      commands.processUserCommand(line);
    });
  }

  bot._client?.on('error', () => {});
  bot.on('error', e => Logger.error('bot error:', e.message || e));
  bot.on('kicked', r => Logger.warn('kicked:', typeof r === 'string' ? r : JSON.stringify(r)));
  bot.on('end', reason => {
    Logger.info(`disconnect: ${reason} -- reconnect 10s`);
    clearTimers();
    setTimeout(createBot, 10_000);
  });
}

console.log('EAFE v10.23 | ' + config.HOST + ':' + config.PORT);
createBot();
