'use strict';

const { EventEmitter } = require('events');
const { PHASE, MODES, HAZARD_SURFACES, CARDINAL_YAWS } = require('./constants');
const { sleep, isAir, isHazardousBlock, hasCollision, isSafeSolidBlock, isLandingSurface, angleDiff } = require('./utils');
const Logger = require('./logger');
const { createLogger } = Logger;
const { ErrorCode, ElytraFlightError, NON_RETRYABLE } = require('./errors');

const { countRockets, getRocketSummary, findRocket, autoEquipRocket } = require('./core/inventory');
const { getElytraSummary, auditAndEquipElytra, calculateRequiredElytraDurability, getUnbreakingLevel, getElytraDamageRate } = require('./core/elytra');
const { createRocketEngine } = require('./core/rockets');
const { createSpatialEngine } = require('./flight/spatial');
const { createFlightPhases } = require('./flight/phases');
const { createWanderEngine } = require('./flight/wander');
const { createLandingEngine } = require('./flight/landing');

const DEFAULTS = Object.freeze({
  cruiseAlt: 180,
  maxRetries: 3,
  ownerUsername: '',
  debug: false,
  mode: 'MED',
  landingMargin: 1,
  targetX: 0,
  targetZ: 0,

  // Module switches (all honoured):
  safety: true,         // pre-flight durability / rocket estimates
  elytraAudit: true,    // skip only the elytra-durability estimate
  autoRocket: true,     // false = fly with no rockets at all
  chunkScan: true,      // render-distance raycasts (terrain avoidance + headings)
  pathfinding: true,    // pathfind to a launch spot when blocked
  wander: true,         // wander for a safe landing spot when none at target
  landing: true,        // glide-to-goal landing with spot search (false = direct dive)
  wanderTimeoutMs: 120000, // give up (typed error + retry) after this long

  // Safety valves:
  relocationCanDig: false,       // allow the relocation pathfinder to dig (public servers: keep off)
  autoRocketCustomStars: false,  // count/use firework rockets with custom stars
  hazardCheck: null,             // custom (block) => boolean hazard override
});

class ElytraFlight extends EventEmitter {
  constructor(bot, options = {}) {
    super();
    if (!bot) throw new Error('ElytraFlight requires a mineflayer bot instance');

    this.bot = bot;
    this.opts = { ...DEFAULTS, ...options };
    this.mode = MODES[this.opts.mode] || MODES.MEDIUM;

    // Per-instance logger (multiple flights no longer share debug state)
    this._logger = this.opts.logger || createLogger({ debug: Boolean(this.opts.debug), prefix: this.opts.logPrefix || '[E]' });
    if (this.opts.debug) this._logger.setDebug(true);

    // Session state
    this._phase = PHASE.IDLE;
    this._targetX = this.opts.targetX;
    this._targetZ = this.opts.targetZ;
    this._retries = 0;
    this._spatialClear = false;

    // One stable state object shared by all modules (previously every
    // `ctx.state` access returned a fresh object, so writes like
    // `state.retries = 0` landed in throwaway copies).
    const self = this;
    this._state = {
      get phase() { return self._phase; },
      set phase(v) { self._phase = v; self.emit('phase', v); },
      get currentMode() { return self.mode; },
      get activeTargetX() { return self._targetX; },
      set activeTargetX(v) { self._targetX = v; },
      get activeTargetZ() { return self._targetZ; },
      set activeTargetZ(v) { self._targetZ = v; },
      get spatialClear() { return self._spatialClear; },
      set spatialClear(v) { self._spatialClear = v; },
      get retries() { return self._retries; },
      set retries(v) { self._retries = v; },
      activeLaunchYaw: 0,
      lastTerrainWarn: 0,
      lastKnownSafeGround: null,
      flightStartPos: null,
      legStartPos: null,
      scannedChunks: new Set(),
    };

    // Pending fly() promise
    this._pending = null;

    // Timer handles
    this._retryTimer = null;
    this._sneakTimer = null;

    // Pathfinding: EAFE depends on mineflayer-pathfinder — load it if the
    // user hasn't (the old code assumed the user knew to, silently).
    try {
      if (!bot.pathfinder) bot.loadPlugin(require('mineflayer-pathfinder').pathfinder);
    } catch (e) {
      this._logger.warn('pathfinder unavailable (relocation disabled):', e.message);
    }

    // Block classification (custom hooks honoured — examples can override)
    this._isHazardous = this.opts.hazardCheck || isHazardousBlock;
    this._isSafeSolid = (b) => {
      if (!b || isAir(b) || this._isHazardous(b)) return false;
      return hasCollision(b);
    };

    this._buildCtx();

    // Create modules with full ctx
    this._rockets = createRocketEngine(this._ctx);
    this._spatial = createSpatialEngine(this._ctx);
    this._wander = createWanderEngine(this._ctx);
    this._landing = createLandingEngine(this._ctx);
    this._phases = createFlightPhases(this._ctx);

    // Wire module methods into ctx
    this._ctx.fireRocketDirect = this._rockets.fireRocketDirect;
    this._ctx.smartFireRocket = this._rockets.smartFireRocket;
    this._ctx.getBoostTime = this._rockets.getBoostTime;
    this._ctx.spatial = this._spatial;
    this._ctx.wander = this._wander;
    this._ctx.startWanderScan = this._wander.startWanderScan;
    this._ctx.startLanding = this._landing.startLanding;
    this._ctx.startFlight = this._phases.startFlight;
    this._ctx.startClimb = this._phases.startClimb;
    this._ctx.startCruise = this._phases.startCruise;

    // Mid-flight elytra swap
    this._ctx.checkMidFlightElytraSwap = this._checkMidFlightElytraSwap.bind(this);

    // Reset state on respawn
    this.bot.on('spawn', () => {
      if (this._phase !== PHASE.IDLE && this._phase !== PHASE.FAILED) {
        this._logger.warn(`respawn during ${this._phase} -- reset`);
        this._emergencyStop('respawn', ErrorCode.RESPAWN);
      }
    });
    this.bot.once('end', () => {
      this._emergencyStop('disconnected', ErrorCode.DISCONNECTED);
    });
  }

  // ─── Public API ───────────────────────────────────────────

  get phase() { return this._phase; }
  get isFlying() { return this._ctx.isFlying(); }
  get targetX() { return this._targetX; }
  get targetZ() { return this._targetZ; }
  get state() { return this._state; }

  /**
   * Fly to (x, z). Returns a Promise that:
   *  - resolves `{ landedAt: {x,y,z} }` when the bot lands
   *  - rejects with an ElytraFlightError (err.code) on failure/stop/respawn
   *
   * While in CRUISE/DEADSTICK, calling fly() retargets the in-progress
   * flight and returns its existing promise.
   */
  fly(x, z, opts = {}) {
    if (typeof x === 'object' && x !== null) { opts = x; x = opts.x; z = opts.z; }
    if ((x !== undefined && !Number.isFinite(x)) || (z !== undefined && !Number.isFinite(z))) {
      const err = new ElytraFlightError(ErrorCode.INTERNAL, 'fly(x, z) expects finite numbers');
      this._emitError(err);
      return Promise.reject(err);
    }

    const p = this._phase;
    if (p === PHASE.CRUISING || p === PHASE.DEAD_STICK) {
      // Retarget mid-cruise — the cruise loop reads the target live.
      // (Applied BEFORE the in-flight check: a rejected call must not
      // silently retarget the active flight.)
      if (x !== undefined) this._targetX = x;
      if (z !== undefined) this._targetZ = z;
      if (opts.mode) this.setMode(opts.mode);
      if (opts.cruiseAlt !== undefined && Number.isFinite(opts.cruiseAlt) && opts.cruiseAlt > 0) {
        this.opts.cruiseAlt = opts.cruiseAlt;
      }
      if (this._pending) return this._pending.promise;
    }
    if (p !== PHASE.IDLE && p !== PHASE.FAILED) {
      const err = new ElytraFlightError(ErrorCode.IN_FLIGHT, `in ${p} -- stop() first`);
      this._emitError(err);
      return Promise.reject(err);
    }

    // New flight from IDLE/FAILED — target + per-call options apply.
    if (x !== undefined) this._targetX = x;
    if (z !== undefined) this._targetZ = z;
    if (opts.mode) this.setMode(opts.mode);
    if (opts.cruiseAlt !== undefined) {
      if (Number.isFinite(opts.cruiseAlt) && opts.cruiseAlt > 0) this.opts.cruiseAlt = opts.cruiseAlt;
    }

    this._retries = 0;
    this._spatialClear = false;
    const pending = {};
    this._pending = pending;
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    const promise = pending.promise;

    this._phases.startFlight().catch(err => {
      if (!this._pending) return;
      this._logger.error('startFlight error:', err.message);
      this._ctx.setPhase(PHASE.FAILED, `error: ${err.message}`);
      this._rejectPending(new ElytraFlightError(ErrorCode.INTERNAL, err.message));
      this._emitError(new ElytraFlightError(ErrorCode.INTERNAL, err.message));
    });

    return promise;
  }

  /**
   * Emergency stop. Emits 'stopped' (exactly once) and phase IDLE.
   * A pending fly() promise rejects with code 'STOPPED'.
   */
  stop(reason = 'user') {
    this._emergencyStop(reason, ErrorCode.STOPPED);
    return this;
  }

  setTarget(x, z) {
    if (Number.isFinite(x)) this._targetX = x;
    if (Number.isFinite(z)) this._targetZ = z;
    return this;
  }

  setMode(mode) {
    const m = MODES[mode];
    if (!m) {
      this._logger.warn(`unknown mode '${mode}' -- keeping ${this.mode.name}`);
      return this;
    }
    this.mode = m;
    return this;
  }

  /**
   * Status snapshot (get-style name kept for API compatibility).
   */
  setStatus(x, z) {
    const pos = this.bot.entity ? this.bot.entity.position : { x: 0, y: 0, z: 0 };
    const elytra = getElytraSummary(this.bot);
    const rockets = countRockets(this.bot, { includeCustom: this.opts.autoRocketCustomStars });
    const dist = this._dist2D(x, z);
    return {
      phase: this._phase,
      mode: this.mode.name,
      pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      target: { x: x ?? this._targetX, z: z ?? this._targetZ },
      dist: Math.round(dist),
      elytra: { dur: elytra.totalDurabilityAcrossAll, count: elytra.count, unbreaking: elytra.bestUnbreaking },
      rockets,
      flying: this.bot.entity ? this.bot.entity.elytraFlying : false,
    };
  }

  /**
   * Pre-flight check without flying. Pure (no equipping side effects) and
   * always returns the documented shape:
   * { ok, reason, elytra: {have, need, equipped, count, unbreaking}, rockets: {have, need} }
   */
  async preflight() {
    if (!this.bot.entity) {
      return {
        ok: false, reason: 'not spawned',
        elytra: { have: 0, need: 0, equipped: 0, count: 0, unbreaking: 0 },
        rockets: { have: 0, need: 0 },
      };
    }

    const elytra = getElytraSummary(this.bot);
    const hasElytra = await auditAndEquipElytra(this._ctx, { equip: false });
    const rockets = countRockets(this.bot, { includeCustom: this.opts.autoRocketCustomStars });
    const d2d = this._dist2D(this._targetX, this._targetZ);
    const reqDur = calculateRequiredElytraDurability(d2d, this.mode.speedMps, elytra.bestUnbreaking);
    const reqRockets = this._ctx.calculateRequiredRockets(d2d, this.opts.cruiseAlt - this.bot.entity.position.y);

    const elytraOk = elytra.totalDurabilityAcrossAll >= reqDur;
    const rocketsOk = this.opts.autoRocket ? rockets >= reqRockets : true;

    return {
      ok: hasElytra && elytraOk && rocketsOk,
      reason: !hasElytra ? 'no elytra' : !elytraOk ? 'elytra low' : !rocketsOk ? 'no rockets' : null,
      elytra: {
        have: elytra.totalDurabilityAcrossAll,
        need: reqDur,
        equipped: elytra.equippedDur,
        count: elytra.count,
        unbreaking: elytra.bestUnbreaking,
      },
      rockets: { have: rockets, need: reqRockets },
    };
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

  // ─── Context Builder ──────────────────────────────────────

  _buildCtx() {
    const self = this;
    const includeCustom = () => self.opts.autoRocketCustomStars;

    this._ctx = {
      bot: this.bot,
      opts: this.opts,
      logger: this._logger,
      state: this._state,
      PHASE,
      get CRUISE_ALT() { return self.opts.cruiseAlt; },
      get MAX_RETRIES() { return self.opts.maxRetries; },

      isHazardous: (b) => self._isHazardous(b),
      isSafeSolid: (b) => self._isSafeSolid(b),

      clearTimers: () => self._clearTimers(),
      yawTo: (x, z) => self._yawTo(x, z),
      dist2D: (x, z) => self._dist2D(x, z),
      lookForce: (yaw, pitch) => { self._smoothLook(yaw, pitch); },
      sleep,

      countRockets: () => countRockets(self.bot, { includeCustom: includeCustom() }),
      autoEquipRocket: () => autoEquipRocket(self.bot, { includeCustom: includeCustom() }),
      getElytraSummary: () => getElytraSummary(self.bot),
      auditAndEquipElytra: (options) => auditAndEquipElytra(self._ctx, options),
      calculateRequiredElytraDurability,
      getUnbreakingLevel,

      calculateRequiredRockets: (d2d, deltaY) => {
        const dReq = Math.ceil(d2d / self.mode.fuelDistDivider);
        const yReq = Math.ceil(Math.abs(deltaY) / 10.0);
        return dReq + yReq + self.opts.maxRetries * 3 + 12;
      },

      isFlying: () => {
        const e = self.bot.entity;
        if (!e) return false;
        return e.elytraFlying && !e.onGround;
      },

      safeChat: (msg) => {
        if (!msg || typeof msg !== 'string') return;
        try { self.bot.chat(msg.substring(0, 256)); } catch (_) { /* bot gone */ }
      },

      setPhase: (p, msg) => {
        self._phase = p;
        const line = msg ? `[${p}] ${msg}` : `[${p}]`;
        self._logger.info(line);
        self.emit('phase', p, msg);
        if (self.opts.ownerUsername) {
          try { self.bot.whisper(self.opts.ownerUsername, line); } catch (_) { /* bot gone */ }
        }
      },

      /** Phase FAILED + retry (or final failure with typed error). */
      failFlight: (code, msg) => {
        self._logger.warn(`FAIL ${msg}`);
        self._ctx.setPhase(PHASE.FAILED, msg);
        self._scheduleRetry(code, msg);
      },

      /** Successful landing: reset, phase IDLE, resolve pending fly(). */
      completeFlight: (details = {}) => {
        self._retries = 0;
        self._spatialClear = false;
        const p = self.bot.entity ? self.bot.entity.position : { x: 0, y: 0, z: 0 };
        const msg = details.msg || `land (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
        self._ctx.setPhase(PHASE.IDLE, msg);
        const pending = self._pending;
        self._pending = null;
        if (pending) {
          pending.resolve({
            phase: PHASE.IDLE,
            landedAt: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
          });
        }
      },

      // Module references — populated after module creation
      fireRocketDirect: null,
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
    };
  }

  async _checkMidFlightElytraSwap() {
    if (!this.opts.safety) return;
    const chest = this.bot.inventory.slots[6];
    if (!chest || chest.name !== 'elytra') return;
    const dur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
    if (dur <= 10) {
      this._logger.warn(`elytra dur=${dur}/432 -- swap`);
      const swapped = await auditAndEquipElytra(this._ctx);
      if (swapped) {
        try { await this.bot.elytraFly(); } catch (_) { /* already flying */ }
        this._ctx.fireRocketDirect();
      } else {
        this._logger.error('no spare elytras -- land');
        this._ctx.startLanding({});
      }
    }
  }

  // ─── Internal Helpers ─────────────────────────────────────

  _rejectPending(err) {
    const pending = this._pending;
    this._pending = null;
    if (pending) pending.reject(err);
  }

  /**
   * Emit 'error' only when a listener is attached. EventEmitter semantics
   * make a bare emit('error') THROW synchronously when no 'error' listener
   * exists — which would turn a cleanly-rejectable fly() into a raw throw
   * the caller's .catch() can never see. The promise rejection remains the
   * primary error channel; this is an observability side-channel.
   */
  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  /**
   * Clears the REAL interval handles (stored on ctx by the flight modules)
   * plus the retry/sneak timeouts. The old implementation cleared instance
   * fields that were never set, so stop() relied on phase checks alone.
   */
  _clearTimers() {
    const c = this._ctx;
    for (const key of ['flyLoop', 'verifyLoop', 'rocketLoop', 'climbLoop', 'landLoop']) {
      if (c && c[key]) {
        clearInterval(c[key]);
        c[key] = null;
      }
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._sneakTimer) {
      clearTimeout(this._sneakTimer);
      this._sneakTimer = null;
    }
  }

  _yawTo(x, z) {
    const p = this.bot.entity.position;
    const dx = x - p.x;
    const dz = z - p.z;
    // Near the target column: the bearing is numerically unstable —
    // position jitter of a fraction of a block flips it up to 180° tick
    // to tick, which made the bot spin in circles (and never fire a
    // rocket, whose yaw gate then never passed). Within 3 m of the
    // column the bearing is noise; hold the current heading. (3 m is
    // negligible for flight geometry — the landing logic settles the
    // final blocks on its own.)
    if (Math.hypot(dx, dz) < 3) return this.bot.entity.yaw;
    return Math.atan2(-dx, -dz);
  }

  _smoothLook(targetYaw, targetPitch) {
    const bot = this.bot;
    if (!bot.entity) return;

    const curYaw = bot.entity.yaw;
    const curPitch = bot.entity.pitch;

    let dy = targetYaw - curYaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;

    const dp = targetPitch - curPitch;
    // Adaptive lerp: big heading corrections (takeoff alignment, hazard
    // avoidance, 180° turns) converge in 2-3 ticks; small corrections
    // (cruise trim, landing glide) stay smooth. The old flat 15-25%/tick
    // took ~0.8 s to close 90°, which is longer than jump airtime — the
    // bot used to land before its first takeoff rocket could be fired.
    const lerp = 0.30 + Math.random() * 0.10 + Math.min(0.40, Math.abs(dy) * 0.30);
    const jitterY = (Math.random() - 0.5) * 0.008;
    const jitterP = (Math.random() - 0.5) * 0.005;

    const newYaw = curYaw + dy * lerp + jitterY;
    const newPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, curPitch + dp * lerp + jitterP));

    try { bot.look(newYaw, newPitch, false); } catch (_) { /* bot gone */ }
  }

  _dist2D(x, z) {
    if (!this.bot.entity) return 0;
    const p = this.bot.entity.position;
    return Math.hypot((x ?? this._targetX) - p.x, (z ?? this._targetZ) - p.z);
  }

  _emergencyStop(reason, code = ErrorCode.STOPPED) {
    const wasInFlight = this._phase !== PHASE.IDLE && this._phase !== PHASE.FAILED;
    this._spatialClear = false;
    this._clearTimers();
    try { this.bot.pathfinder && this.bot.pathfinder.stop(); } catch (_) { /* bot gone */ }
    ['sprint', 'forward', 'back', 'left', 'right', 'jump', 'sneak'].forEach(k => {
      try { this.bot.setControlState(k, false); } catch (_) { /* bot gone */ }
    });
    try { this.bot.setControlState('sneak', true); } catch (_) { /* bot gone */ }
    this._sneakTimer = setTimeout(() => {
      this._sneakTimer = null;
      try { this.bot.setControlState('sneak', false); } catch (_) { /* bot gone */ }
    }, 600);
    this._logger.info(`STOP ${reason}`);

    // Emit phase IDLE so event consumers don't hang waiting for it
    this._phase = PHASE.IDLE;
    this.emit('phase', PHASE.IDLE, reason);

    this.emit('stopped', reason);
    if (wasInFlight || this._pending) {
      this._rejectPending(new ElytraFlightError(code, reason));
    }
  }

  _scheduleRetry(finalCode, finalMsg) {
    // Deterministic pre-flight precondition failures (no entity, no
    // elytra, not enough rockets, ...) can't change outcome on retry —
    // fail fast with the specific code instead of burning the retry
    // budget and masking the cause behind RETRIES_EXHAUSTED.
    if (NON_RETRYABLE.has(finalCode)) {
      const err = new ElytraFlightError(finalCode, finalMsg || finalCode);
      this._logger.error(err.message);
      this._rejectPending(err);
      this._emitError(err);
      return;
    }
    if (this._retries >= this.opts.maxRetries) {
      // The final rejection is always RETRIES_EXHAUSTED (the engine-level
      // "gave up"); the last failure's code travels in the message and as
      // `err.cause` so automation can branch on the real reason.
      const err = new ElytraFlightError(
        ErrorCode.RETRIES_EXHAUSTED,
        `Flight failed after ${this._retries} retries${finalMsg ? ` (${finalMsg})` : ''}`
      );
      err.cause = finalCode;
      this._logger.error(err.message);
      this._rejectPending(err);
      this._emitError(err);
      return;
    }
    this._retries++;
    const delay = this._retries * 3000;
    this._logger.warn(`retry ${this._retries}/${this.opts.maxRetries} in ${delay / 1000}s`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      // Only retry if we're still failed (stop()/fly() changed phase since)
      if (this._phase !== PHASE.FAILED) return;
      this._phases.startFlight().catch(err => {
        if (!this._pending) return;
        this._logger.error('startFlight error:', err.message);
        this._ctx.setPhase(PHASE.FAILED, `error: ${err.message}`);
        this._rejectPending(new ElytraFlightError(ErrorCode.INTERNAL, err.message));
        this._emitError(new ElytraFlightError(ErrorCode.INTERNAL, err.message));
      });
    }, delay);
  }
}

module.exports = ElytraFlight;
module.exports.ElytraFlight = ElytraFlight;
module.exports.MODES = MODES;
module.exports.PHASE = PHASE;
module.exports.HAZARD_SURFACES = HAZARD_SURFACES;
module.exports.CARDINAL_YAWS = CARDINAL_YAWS;
module.exports.Logger = Logger;
module.exports.createLogger = createLogger;
module.exports.ErrorCode = ErrorCode;
module.exports.ElytraFlightError = ElytraFlightError;
module.exports.countRockets = countRockets;
module.exports.getRocketSummary = getRocketSummary;
module.exports.findRocket = findRocket;
module.exports.autoEquipRocket = autoEquipRocket;
module.exports.getElytraSummary = getElytraSummary;
module.exports.auditAndEquipElytra = auditAndEquipElytra;
module.exports.calculateRequiredElytraDurability = calculateRequiredElytraDurability;
module.exports.getUnbreakingLevel = getUnbreakingLevel;
module.exports.getElytraDamageRate = getElytraDamageRate;
module.exports.isAir = isAir;
module.exports.isHazardousBlock = isHazardousBlock;
module.exports.hasCollision = hasCollision;
module.exports.isSafeSolidBlock = isSafeSolidBlock;
module.exports.isLandingSurface = isLandingSurface;
module.exports.angleDiff = angleDiff;
module.exports.sleep = sleep;
