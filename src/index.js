'use strict';

const { EventEmitter } = require('events');
const { PHASE, MODES, HAZARD_SURFACES, CARDINAL_YAWS } = require('./constants');
const { sleep, isAir, isHazardousBlock, isSafeSolidBlock, angleDiff } = require('./utils');
const Logger = require('./logger');

// Module imports
const { countRockets, findRocket, autoEquipRocket } = require('./core/inventory');
const { getElytraSummary, auditAndEquipElytra, calculateRequiredElytraDurability, getUnbreakingLevel } = require('./core/elytra');
const { createRocketEngine } = require('./core/rockets');
const { createSpatialEngine } = require('./flight/spatial');
const { createFlightPhases } = require('./flight/phases');
const { createWanderEngine } = require('./flight/wander');
const { createLandingEngine } = require('./flight/landing');

const DEFAULTS = {
  cruiseAlt: 180,
  maxRetries: 3,
  ownerUsername: '',
  debug: false,

  // Feature toggles — set false to disable
  safety: true,
  pathfinding: true,
  chunkScan: true,
  autoRocket: true,
  elytraAudit: true,
  landing: true,
  wander: true,

  // Default target
  targetX: 0,
  targetZ: 0,

  // Default flight mode
  mode: 'MED',

  // Landing margin of error (blocks from edge of land mass)
  landingMargin: 2,
};

class ElytraFlight extends EventEmitter {
  constructor(bot, options = {}) {
    super();
    if (!bot) throw new Error('ElytraFlight requires a mineflayer bot instance');

    this.bot = bot;
    this.opts = { ...DEFAULTS, ...options };
    this.mode = MODES[this.opts.mode] || MODES.MEDIUM;

    // Session state
    this._phase = PHASE.IDLE;
    this._targetX = this.opts.targetX;
    this._targetZ = this.opts.targetZ;
    this._retries = 0;
    this._spatialClear = false;
    this._launchYaw = 0;
    this._lastTerrainWarn = 0;
    this._lastKnownSafeGround = null;
    this._flightStartPos = null;
    this._legStartPos = null;
    this._scannedChunks = new Set();

    // Timer handles
    this._flyLoop = null;
    this._verifyLoop = null;
    this._rocketLoop = null;
    this._climbLoop = null;

    // Logger
    this._logger = Logger;
    if (this.opts.debug) this._logger.setDebug(true);

    // Build context for internal modules
    this._buildCtx();

    // Initialize modules
    this._rockets = createRocketEngine(this._ctx);
    this._spatial = createSpatialEngine(this._ctx);
    this._wander = createWanderEngine(this._ctx);
    this._landing = createLandingEngine(this._ctx);
    this._phases = createFlightPhases(this._ctx);

    // Reset state on respawn (e.g. after /kill or death)
    this.bot.on('spawn', () => {
      if (this._phase !== PHASE.IDLE && this._phase !== PHASE.FAILED) {
        this._logger.warn(`respawn during ${this._phase} -- reset`);
        this._emergencyStop('respawn');
      }
    });
  }

  // ─── Public API ───────────────────────────────────────────

  get phase() { return this._phase; }
  get isFlying() { return this._ctx.isFlying(); }

  fly(x, z, opts = {}) {
    if (typeof x === 'object') { opts = x; x = opts.x; z = opts.z; }
    if (x !== undefined) this._targetX = x;
    if (z !== undefined) this._targetZ = z;
    if (opts.mode) this.mode = MODES[opts.mode] || this.mode;
    if (opts.cruiseAlt) this.opts.cruiseAlt = opts.cruiseAlt;

    this._retries = 0;
    this._spatialClear = false;
    this._phases.startFlight();
    return this;
  }

  stop(reason = 'user') {
    this._ctx.emergencyStop(reason);
    this.emit('stopped', reason);
    return this;
  }

  setTarget(x, z) {
    this._targetX = x;
    this._targetZ = z;
    return this;
  }

  setMode(mode) {
    this.mode = MODES[mode] || MODES.MEDIUM;
    return this;
  }

  setStatus(x, z) {
    const pos = this.bot.entity.position;
    const elytra = getElytraSummary(this.bot);
    const rockets = countRockets(this.bot);
    const dist = this._dist2D(x, z);
    return {
      phase: this._phase,
      mode: this.mode.name,
      pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      target: { x, z },
      dist: Math.round(dist),
      elytra: { dur: elytra.totalDurabilityAcrossAll, count: elytra.count, unbreaking: elytra.bestUnbreaking },
      rockets,
      flying: this.bot.entity.elytraFlying,
    };
  }

  preflight() {
    return this._doPreflight();
  }

  getLandingStats() {
    const p = this.bot.entity.position;
    return {
      goal: { x: this._targetX, z: this._targetZ },
      pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      dist: Math.round(this._dist2D(this._targetX, this._targetZ)),
      margin: this.opts.landingMargin,
    };
  }

  // ─── Internal Context Builder ─────────────────────────────

  _buildCtx() {
    const self = this;

    this._ctx = {
      bot: this.bot,
      get state() {
        return {
          get phase() { return self._phase; },
          set phase(v) { self._phase = v; self.emit('phase', v); },
          currentMode: self.mode,
          get activeTargetX() { return self._targetX; },
          set activeTargetX(v) { self._targetX = v; },
          get activeTargetZ() { return self._targetZ; },
          set activeTargetZ(v) { self._targetZ = v; },
          retries: 0,
          get spatialClear() { return self._spatialClear; },
          set spatialClear(v) { self._spatialClear = v; },
          activeLaunchYaw: 0,
          lastTerrainWarn: 0,
          lastKnownSafeGround: null,
          flightStartPos: null,
          legStartPos: null,
          scannedChunks: new Set(),
        };
      },
      PHASE,
      get CRUISE_ALT() { return self.opts.cruiseAlt; },
      get MAX_RETRIES() { return self.opts.maxRetries; },

      clearTimers: () => self._clearTimers(),
      yawTo: (x, z) => self._yawTo(x, z),
      dist2D: (x, z) => self._dist2D(x, z),
      lookForce: (yaw, pitch) => { self._smoothLook(yaw, pitch); },
      sleep,
      countRockets,
      autoEquipRocket,
      getElytraSummary,
      calculateRequiredElytraDurability,
      getElytraSummary: () => getElytraSummary(self.bot),

      calculateRequiredRockets: (d2d, deltaY) => {
        const dReq = Math.ceil(d2d / self.mode.fuelDistDivider);
        const yReq = Math.ceil(Math.abs(deltaY) / 10.0);
        return dReq + yReq + self.opts.maxRetries * 3 + 12;
      },

      isFlying: () => {
        const e = self.bot.entity;
        if (!e) return false;
        return (e.elytraFlying || e.fallFlying) && !e.onGround;
      },

      scheduleRetry: () => self._scheduleRetry(),

      safeChat: (msg) => {
        if (!msg || typeof msg !== 'string') return;
        try { self.bot.chat(msg.substring(0, 256)); } catch(_) {}
      },

      setPhase: (p, msg) => {
        self._phase = p;
        const line = msg ? `[${p}] ${msg}` : `[${p}]`;
        self._logger.info(line);
        self.emit('phase', p, msg);
        if (self.opts.ownerUsername) {
          try { self.bot.whisper(self.opts.ownerUsername, line); } catch(_) {}
        }
      },

      emergencyStop: (reason) => self._emergencyStop(reason),

      fireRocketDirect: null,
      shouldFireRocketDynamic: null,
      smartFireRocket: null,
      getBoostTime: null,

      spatial: null,
      wander: null,
      startWanderScan: null,
      startLanding: null,
      startFlight: null,
      startClimb: null,
      startCruise: null,
      checkMidFlightElytraSwap: null,
      auditAndEquipElytra: () => auditAndEquipElytra(self._ctx),
    };

    // Wire up rocket module after ctx is built
    const rocketMod = createRocketEngine(this._ctx);
    this._ctx.fireRocketDirect = rocketMod.fireRocketDirect;
    this._ctx.shouldFireRocketDynamic = rocketMod.shouldFireRocketDynamic;
    this._ctx.smartFireRocket = rocketMod.smartFireRocket;
    this._ctx.getBoostTime = rocketMod.getBoostTime;

    // Wire up spatial
    this._spatial = createSpatialEngine(this._ctx);
    this._ctx.spatial = this._spatial;

    // Wire up wander
    this._wander = createWanderEngine(this._ctx);
    this._ctx.wander = this._wander;
    this._ctx.startWanderScan = this._wander.startWanderScan;

    // Wire up landing
    this._landing = createLandingEngine(this._ctx);
    this._ctx.startLanding = this._landing.startLanding;

    // Wire up flight phases
    this._phases = createFlightPhases(this._ctx);
    this._ctx.startFlight = this._phases.startFlight;
    this._ctx.startClimb = this._phases.startClimb;
    this._ctx.startCruise = this._phases.startCruise;

    // Mid-flight elytra swap
    this._ctx.checkMidFlightElytraSwap = async () => {
      if (!this.opts.safety) return;
      const chest = this.bot.inventory.slots[6];
      if (!chest || chest.name !== 'elytra') return;
      const dur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
      if (dur <= 10) {
        this._logger.warn(`elytra dur=${dur}/432 -- swap`);
        const swapped = await auditAndEquipElytra(this._ctx);
        if (swapped) {
          try { await this.bot.elytraFly(); } catch(_) {}
          this._ctx.fireRocketDirect();
        } else {
          this._logger.error('no spare elytras -- land');
          this._ctx.startLanding();
        }
      }
    };

    // Schedule retry helper
    this._ctx.scheduleRetry = () => self._scheduleRetry();
  }

  // ─── Internal Helpers ─────────────────────────────────────

  _clearTimers() {
    [this._flyLoop, this._verifyLoop, this._rocketLoop, this._climbLoop].forEach(h => {
      if (h) clearInterval(h);
    });
    this._flyLoop = this._verifyLoop = this._rocketLoop = this._climbLoop = null;
  }

  _yawTo(x, z) {
    const p = this.bot.entity.position;
    return Math.atan2(-(x - p.x), -(z - p.z));
  }

  _smoothLook(targetYaw, targetPitch) {
    const bot = this.bot;
    if (!bot.entity) return;

    const curYaw = bot.entity.yaw;
    const curPitch = bot.entity.pitch;

    // Normalize angle difference to [-PI, PI]
    let dy = targetYaw - curYaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;

    const dp = targetPitch - curPitch;

    // Lerp factor: 0.15-0.25 = human-like mouse speed (not instant)
    const lerp = 0.15 + Math.random() * 0.10;

    // Add small jitter to look natural (human hand tremor)
    const jitterY = (Math.random() - 0.5) * 0.008;
    const jitterP = (Math.random() - 0.5) * 0.005;

    const newYaw = curYaw + dy * lerp + jitterY;
    const newPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, curPitch + dp * lerp + jitterP));

    try { bot.look(newYaw, newPitch, false); } catch(_) {}
  }

  _dist2D(x, z) {
    const p = this.bot.entity.position;
    return Math.hypot((x ?? this._targetX) - p.x, (z ?? this._targetZ) - p.z);
  }

  _emergencyStop(reason) {
    this._phase = PHASE.IDLE;
    this._spatialClear = false;
    this._clearTimers();
    try { this.bot.pathfinder.stop(); } catch(_) {}
    ['sprint','forward','back','left','right','jump','sneak'].forEach(k => {
      try { this.bot.setControlState(k, false); } catch(_) {}
    });
    try { this.bot.setControlState('sneak', true); } catch(_) {}
    setTimeout(() => { try { this.bot.setControlState('sneak', false); } catch(_) {} }, 600);
    this._logger.info(`STOP ${reason}`);
    this.emit('stopped', reason);
  }

  _scheduleRetry() {
    if (this._retries >= this.opts.maxRetries) {
      this._ctx.setPhase(PHASE.FAILED, `FAIL after ${this.opts.maxRetries} retries`);
      this._spatialClear = false;
      this.emit('error', new Error(`Flight failed after ${this.opts.maxRetries} retries`));
      return;
    }
    this._retries++;
    const delay = this._retries * 3000;
    this._logger.warn(`retry ${this._retries}/${this.opts.maxRetries} in ${delay / 1000}s`);
    setTimeout(() => {
      this._phase = PHASE.IDLE;
      this._ctx.startFlight();
    }, delay);
  }

  async _doPreflight() {
    const elytraOk = await auditAndEquipElytra(this._ctx);
    if (!elytraOk) return { ok: false, reason: 'no elytra' };

    const rockets = countRockets(this.bot);
    const d2d = this._dist2D(this._targetX, this._targetZ);
    const elytra = getElytraSummary(this.bot);
    const reqDur = calculateRequiredElytraDurability(d2d, this.mode.speedMps, elytra.bestUnbreaking);
    const reqRockets = this._ctx.calculateRequiredRockets(d2d, this.opts.cruiseAlt - this.bot.entity.position.y);

    return {
      ok: elytra.totalDurabilityAcrossAll >= reqDur && rockets >= reqRockets,
      elytra: { have: elytra.totalDurabilityAcrossAll, need: reqDur },
      rockets: { have: rockets, need: reqRockets },
    };
  }
}

// ─── Exports ────────────────────────────────────────────

module.exports = ElytraFlight;
module.exports.ElytraFlight = ElytraFlight;
module.exports.MODES = MODES;
module.exports.PHASE = PHASE;
module.exports.HAZARD_SURFACES = HAZARD_SURFACES;
module.exports.CARDINAL_YAWS = CARDINAL_YAWS;
module.exports.Logger = Logger;
module.exports.countRockets = countRockets;
module.exports.findRocket = findRocket;
module.exports.autoEquipRocket = autoEquipRocket;
module.exports.getElytraSummary = getElytraSummary;
module.exports.auditAndEquipElytra = auditAndEquipElytra;
module.exports.calculateRequiredElytraDurability = calculateRequiredElytraDurability;
module.exports.getUnbreakingLevel = getUnbreakingLevel;
module.exports.isAir = isAir;
module.exports.isHazardousBlock = isHazardousBlock;
module.exports.isSafeSolidBlock = isSafeSolidBlock;
module.exports.angleDiff = angleDiff;
module.exports.sleep = sleep;
