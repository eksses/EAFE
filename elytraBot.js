'use strict';
/**
 * EAFE v5 — Elytra Autonomous Flight Engine
 * ==========================================
 * Fixes:
 *   - Correct Pitch System (Mineflayer / prismarine-physics):
 *       POSITIVE pitch (+0.65 rad) = LOOKING UP / CLIMBING
 *       ZERO pitch     ( 0.00 rad) = HORIZON / LEVEL
 *       NEGATIVE pitch (-0.30 rad) = LOOKING DOWN / DESCENDING
 *   - Native Physics enabled (bot.physicsEnabled = true) with 50ms sync.
 *   - Reliable Takeoff: Jump -> wait airborne -> elytraFly() -> IMMEDIATELY fire rocket with pitch +0.5.
 *   - Timed Rocket Propulsion: Fires rocket on schedule during climb (1.2s) & cruise (1.5s).
 *   - Raycast & Path Scan: Checks 20m ceiling & 30m climb trajectory before takeoff.
 *   - Relocation: Scans 15x15 grid for open sky & walks to launch spot if blocked.
 *   - State Machine: Track IDLE, SCANNING, RELOCATING, TAKEOFF, CLIMBING, CRUISING, LANDING, FAILED.
 *   - FAILED status reporting & multi-stage auto-retry mechanism.
 *   - Knockback: Responds in real-time to entity_velocity & explosion packets.
 */

const mineflayer    = require('mineflayer');
const { Vec3 }      = require('vec3');
const physicsLoader = require('@nxg-org/mineflayer-physics-util').default;
const { EPhysicsCtx } = require('@nxg-org/mineflayer-physics-util');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const HOST       = '103.151.60.212';
const PORT       = 25565;
const USERNAME   = 'test';
const TARGET_X   = 100;
const TARGET_Z   = 100;
const CRUISE_ALT = 160;   // Y altitude to reach before heading toward destination
const MAX_RETRIES = 3;    // retries before giving up

// ─── PHASE STATE ─────────────────────────────────────────────────────────────
const PHASE = {
  IDLE:       'IDLE',
  SCANNING:   'SCANNING',     // raycasting launch area
  RELOCATING: 'RELOCATING',   // walking to better launch spot
  TAKEOFF:    'TAKEOFF',      // jump + elytraFly()
  CLIMBING:   'CLIMBING',     // nose up (+0.65), gaining altitude
  CRUISING:   'CRUISING',     // level (+0.05), heading to target
  LANDING:    'LANDING',      // glide descent (-0.30)
  FAILED:     'FAILED',       // flight failed, auto-retry scheduled
};

// ─── UTIL ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isAir(block) {
  if (!block) return true;
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

// ─── BOT FACTORY ─────────────────────────────────────────────────────────────
function createBot() {
  const bot = mineflayer.createBot({
    host: HOST, port: PORT, username: USERNAME,
    version: false, auth: 'offline',
    checkTimeoutInterval: 60_000,
  });

  bot.loadPlugin(physicsLoader);

  // ── session state ──
  let phase       = PHASE.IDLE;
  let retries     = 0;
  let physEngine  = null;
  let flyLoop     = null;
  let verifyLoop  = null;
  let rocketLoop  = null;
  let climbLoop   = null;

  // ─── Timer cleanup ────────────────────────────────────────────────────────
  function clearAllTimers() {
    [flyLoop, verifyLoop, rocketLoop, climbLoop].forEach(h => { if (h) clearInterval(h); });
    flyLoop = verifyLoop = rocketLoop = climbLoop = null;
  }

  // ─── Emergency stop ───────────────────────────────────────────────────────
  function emergencyStop(reason) {
    phase = PHASE.IDLE;
    clearAllTimers();
    ['sprint','forward','back','left','right','jump','sneak'].forEach(k => {
      try { bot.setControlState(k, false); } catch(_) {}
    });
    try { bot.setControlState('sneak', true); } catch(_) {}
    setTimeout(() => { try { bot.setControlState('sneak', false); } catch(_) {} }, 600);
    console.log(`[EAFE] ⛔ STOP — ${reason}`);
    try { bot.chat(`[EAFE] ⛔ Stopped: ${reason}`); } catch(_) {}
  }

  // ─── Set phase (logs + chat) ──────────────────────────────────────────────
  function setPhase(p, msg) {
    phase = p;
    const line = `[EAFE] [${p}] ${msg || ''}`;
    console.log(line);
    try { bot.chat(line.substring(0, 256)); } catch(_) {}
  }

  // ─── Inventory helpers ────────────────────────────────────────────────────
  function findRocket() {
    return bot.inventory.items().find(i => {
      if (i.name !== 'firework_rocket') return false;
      try { if (i.nbt?.value?.Fireworks?.value?.Explosions) return false; } catch(_) {}
      return true;
    });
  }

  async function autoEquipElytra() {
    const chest = bot.inventory.slots[6];
    if (chest?.name === 'elytra') { console.log('[EAFE] ✓ Elytra equipped'); return true; }
    const item = bot.inventory.items().find(i => i.name === 'elytra');
    if (!item) { console.warn('[EAFE] ⚠ No elytra in inventory'); return false; }
    try { await bot.equip(item, 'torso'); console.log('[EAFE] 🎽 Elytra equipped'); return true; }
    catch(e) { console.error('[EAFE] ✗ equip failed:', e.message); return false; }
  }

  // ─── Navigation helpers ───────────────────────────────────────────────────
  function yawTo(x, z) {
    const p = bot.entity.position;
    return Math.atan2(-(x - p.x), z - p.z);
  }

  function dist2D(x, z) {
    const p = bot.entity.position;
    return Math.hypot((x ?? TARGET_X) - p.x, (z ?? TARGET_Z) - p.z);
  }

  /**
   * Set yaw & pitch with force=true so look updates immediately for physics
   * PITCH CONVENTION:
   *   +0.65 rad (+37°) = LOOKING UP / CLIMBING
   *    0.00 rad (  0°) = LEVEL FLIGHT
   *   -0.30 rad (-17°) = LOOKING DOWN / DESCENDING
   */
  function lookForce(yaw, pitch) {
    bot.look(yaw, pitch, true);
  }

  // ─── Rocket firing ────────────────────────────────────────────────────────
  function fireRocket() {
    if (!bot.entity.elytraFlying) { console.log('[EAFE] fireRocket: skipped (not elytraFlying)'); return false; }
    const r = findRocket();
    if (!r) { console.warn('[EAFE] ⚠ No rockets!'); try { bot.chat('[EAFE] ⚠ No rockets!'); } catch(_) {} return false; }
    try {
      if (r.slot < 9) bot.setQuickBarSlot(r.slot);
      bot.activateItem();
      console.log(`[EAFE] 🚀 Rocket fired (slot ${r.slot})`);
      return true;
    } catch(e) { console.warn('[EAFE] rocket err:', e.message); return false; }
  }

  // ─── Fly state verification ───────────────────────────────────────────────
  function isFlying() {
    const e = bot.entity;
    if (!e) return false;
    const server = e.elytraFlying === true || e.fallFlying === true;
    let sim = false;
    if (physEngine) {
      try { const ctx = EPhysicsCtx.FROM_BOT(physEngine, bot); sim = ctx.state.fallFlying === true; }
      catch(_) {}
    }
    return (server || sim) && !e.onGround;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  RAYCAST / AREA SCAN
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Raycast scanning:
   * 1. 20 blocks straight up
   * 2. 30 blocks along climb vector (+0.65 pitch = nose UP)
   */
  function scanLaunchArea() {
    const pos    = bot.entity.position;
    const yaw    = yawTo(TARGET_X, TARGET_Z);
    const pitch  = 0.65; // NOSE UP in Mineflayer

    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const dirX     = -Math.sin(yaw) * cosPitch;
    const dirY     =  sinPitch;
    const dirZ     =  Math.cos(yaw) * cosPitch;

    // 1. Check sky straight up
    let clearAbove = true;
    for (let dy = 1; dy <= 20; dy++) {
      const b = bot.blockAt(pos.offset(0, dy, 0));
      if (!isAir(b)) { clearAbove = false; break; }
    }

    // 2. Check 30m climb trajectory
    let clearPath = true;
    let hitDist   = 0;
    let hitBlock  = null;
    const eyePos  = pos.offset(0, 1.6, 0);
    for (let d = 1; d <= 30; d++) {
      const checkPos = eyePos.offset(dirX * d, dirY * d, dirZ * d);
      const b = bot.blockAt(checkPos);
      if (!isAir(b)) { clearPath = false; hitDist = d; hitBlock = b?.name; break; }
    }

    return { clearAbove, clearPath, hitDist, hitBlock };
  }

  /**
   * Area scan: 15x15 grid around player for spot with max open sky
   */
  function findBestLaunchSpot() {
    const pos   = bot.entity.position;
    const baseY = Math.floor(pos.y);
    let best    = null;

    for (let dx = -7; dx <= 7; dx += 2) {
      for (let dz = -7; dz <= 7; dz += 2) {
        const cx = Math.floor(pos.x) + dx;
        const cz = Math.floor(pos.z) + dz;

        let groundY = null;
        for (let dy = 0; dy >= -5; dy--) {
          const b = bot.blockAt(new Vec3(cx, baseY + dy, cz));
          if (!isAir(b)) { groundY = baseY + dy + 1; break; }
        }
        if (groundY === null) continue;

        let score = 0;
        for (let dy = 0; dy < 25; dy++) {
          const b = bot.blockAt(new Vec3(cx, groundY + dy, cz));
          if (!isAir(b)) break;
          score++;
        }

        if (score > (best?.score ?? 0)) {
          best = { x: cx, z: cz, score };
        }
      }
    }

    return (best?.score >= 12) ? best : null;
  }

  /**
   * Walk to coordinates (tx, tz) without library
   */
  async function walkToSpot(tx, tz) {
    const TIMEOUT = 10_000;
    const start   = Date.now();

    console.log(`[EAFE] 🚶 Walking to open launch spot (${tx}, ${tz})...`);
    bot.setControlState('sprint', true);

    while (Date.now() - start < TIMEOUT) {
      const p = bot.entity.position;
      const d = Math.hypot(tx - p.x, tz - p.z);
      if (d < 1.8) {
        bot.setControlState('sprint', false);
        bot.setControlState('forward', false);
        console.log('[EAFE] 🚶 Arrived at launch spot');
        return true;
      }
      bot.entity.yaw = Math.atan2(-(tx - p.x), tz - p.z);
      bot.setControlState('forward', true);
      await sleep(100);
    }

    bot.setControlState('sprint', false);
    bot.setControlState('forward', false);
    console.warn('[EAFE] ⚠ Walk timed out');
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  FLIGHT PHASES
  // ─────────────────────────────────────────────────────────────────────────

  async function startFlight() {
    if (phase !== PHASE.IDLE && phase !== PHASE.FAILED) {
      try { bot.chat('[EAFE] Flight already in progress — use s to stop'); } catch(_) {}
      return;
    }

    // ── Equipment check ──
    const elytraOk = await autoEquipElytra();
    if (!elytraOk) { setPhase(PHASE.FAILED, '✗ No elytra in inventory'); return; }

    if (!findRocket()) { setPhase(PHASE.FAILED, '✗ No firework rockets'); return; }

    // ── SCAN launch area ──
    setPhase(PHASE.SCANNING, 'Raycasting launch area & trajectory...');
    await sleep(100);

    const scan = scanLaunchArea();
    console.log(`[EAFE] Scan: clearAbove=${scan.clearAbove} clearPath=${scan.clearPath}` +
                (scan.hitBlock ? ` hitAt=${scan.hitDist}m (${scan.hitBlock})` : ''));

    if (!scan.clearAbove || !scan.clearPath) {
      try { bot.chat(`[EAFE] ⚠ Launch path blocked at ${scan.hitDist}m (${scan.hitBlock}) — scanning area...`); } catch(_) {}

      const spot = findBestLaunchSpot();
      if (!spot) {
        setPhase(PHASE.FAILED, '✗ Obstacles detected — no open launch spot nearby');
        scheduleRetry();
        return;
      }

      setPhase(PHASE.RELOCATING, `Moving to open spot (${spot.x}, ${spot.z}) score=${spot.score}`);
      const arrived = await walkToSpot(spot.x, spot.z);
      if (!arrived) {
        setPhase(PHASE.FAILED, '✗ Could not walk to launch spot');
        scheduleRetry();
        return;
      }

      const scan2 = scanLaunchArea();
      if (!scan2.clearAbove || !scan2.clearPath) {
        setPhase(PHASE.FAILED, `✗ Path still blocked after relocation (${scan2.hitBlock} at ${scan2.hitDist}m)`);
        scheduleRetry();
        return;
      }
    }

    // ── TAKEOFF ──
    await executeTakeoff();
  }

  async function executeTakeoff() {
    if (phase === PHASE.FAILED) return;
    setPhase(PHASE.TAKEOFF, 'Jumping & activating elytra...');

    // Clear controls
    ['sprint','forward','back','left','right','sneak'].forEach(k => {
      try { bot.setControlState(k, false); } catch(_) {}
    });

    // Face target + NOSE UP (+0.5 rad) BEFORE takeoff
    lookForce(yawTo(TARGET_X, TARGET_Z), 0.5);

    // Jump
    bot.setControlState('jump', true);

    // Wait until airborne (onGround === false), max 1s
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
      setPhase(PHASE.FAILED, '✗ Jump failed (bot remained on ground)');
      scheduleRetry();
      return;
    }

    console.log(`[EAFE] ✓ Airborne (Y=${bot.entity.position.y.toFixed(2)}) — calling elytraFly()`);

    // Call elytraFly() packet while airborne
    try {
      await bot.elytraFly();
      console.log('[EAFE] ✓ elytraFly() packet sent');
    } catch(e) {
      console.error('[EAFE] elytraFly() error:', e.message);
      setPhase(PHASE.FAILED, '✗ elytraFly error: ' + e.message);
      scheduleRetry();
      return;
    }

    // Fire rocket IMMEDIATELY on takeoff to launch upward!
    fireRocket();

    // Verify fly state after 250ms
    await sleep(250);
    if (!isFlying()) {
      console.warn('[EAFE] ⚠ Fly state false after launch — retrying elytraFly + rocket');
      try { await bot.elytraFly(); } catch(_) {}
      fireRocket();
      await sleep(250);
      if (!isFlying()) {
        setPhase(PHASE.FAILED, '✗ Elytra fly state never confirmed by server');
        scheduleRetry();
        return;
      }
    }

    console.log('[EAFE] ✓ Elytra flight CONFIRMED — starting climb');
    startClimb();
  }

  // ─── CLIMB ────────────────────────────────────────────────────────────────
  // Pitch = +0.65 rad (NOSE UP) → ascends toward CRUISE_ALT (Y=160)
  function startClimb() {
    setPhase(PHASE.CLIMBING, `Climbing to Y=${CRUISE_ALT}...`);

    // Point NOSE UP (+0.65 rad) and fire rocket
    lookForce(yawTo(TARGET_X, TARGET_Z), 0.65);
    fireRocket();

    // Rockets every 1.2s during climb
    if (rocketLoop) clearInterval(rocketLoop);
    rocketLoop = setInterval(() => {
      if (phase !== PHASE.CLIMBING) { clearInterval(rocketLoop); rocketLoop = null; return; }
      fireRocket();
    }, 1200);

    // Climb poll every 200ms
    if (climbLoop) clearInterval(climbLoop);
    climbLoop = setInterval(() => {
      if (phase !== PHASE.CLIMBING) { clearInterval(climbLoop); climbLoop = null; return; }

      const pos = bot.entity.position;
      const yaw = yawTo(TARGET_X, TARGET_Z);
      console.log(`[EAFE] [CLIMB] Y=${pos.y.toFixed(1)} elytra=${bot.entity.elytraFlying} ground=${bot.entity.onGround}`);

      // Maintain NOSE UP pitch (+0.65 rad)
      lookForce(yaw, 0.65);

      // Unexpected ground contact
      if (bot.entity.onGround && pos.y < CRUISE_ALT - 10) {
        clearInterval(climbLoop); climbLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        setPhase(PHASE.FAILED, '✗ Unexpected ground contact during climb');
        scheduleRetry();
        return;
      }

      // Lost fly state mid-air — recover
      if (!isFlying() && !bot.entity.onGround) {
        console.warn('[EAFE] ⚠ Lost fly state mid-climb — re-issuing elytraFly');
        bot.elytraFly().catch(() => {});
        fireRocket();
        return;
      }

      // Reached target altitude
      if (pos.y >= CRUISE_ALT) {
        clearInterval(climbLoop); climbLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        startCruise();
      }
    }, 200);
  }

  // ─── CRUISE ───────────────────────────────────────────────────────────────
  // Pitch = +0.05 rad (slight nose up / level) → holds cruise speed at altitude
  function startCruise() {
    setPhase(PHASE.CRUISING, `Cruising to (${TARGET_X}, ?, ${TARGET_Z})`);

    // Rockets every 1.5s
    if (rocketLoop) clearInterval(rocketLoop);
    rocketLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING) { clearInterval(rocketLoop); rocketLoop = null; return; }
      fireRocket();
    }, 1500);

    // Steering tick every 50ms
    if (flyLoop) clearInterval(flyLoop);
    flyLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING) { clearInterval(flyLoop); flyLoop = null; return; }

      const d = dist2D();
      if (d < 25) {
        clearInterval(flyLoop); flyLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        startLanding();
        return;
      }

      // Level pitch (+0.05) to hold altitude & cruise toward target
      lookForce(yawTo(TARGET_X, TARGET_Z), 0.05);
    }, 50);

    // 1s verification loop
    if (verifyLoop) clearInterval(verifyLoop);
    let lastPos = bot.entity.position.clone();
    verifyLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING) { clearInterval(verifyLoop); verifyLoop = null; return; }

      const pos   = bot.entity.position;
      const delta = Math.abs(pos.x - lastPos.x) + Math.abs(pos.y - lastPos.y) + Math.abs(pos.z - lastPos.z);
      console.log(
        `[EAFE] [1s] pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) ` +
        `Δ=${delta.toFixed(2)} elytra=${bot.entity.elytraFlying} dist=${dist2D().toFixed(0)}m`
      );

      // Recovery if flight state drops mid-air
      if (!isFlying() && !bot.entity.onGround) {
        console.warn('[EAFE] ⚠ Fly state false during cruise — attempting recovery');
        autoEquipElytra().then(() => {
          if (phase !== PHASE.CRUISING) return;
          bot.elytraFly().catch(e => {
            setPhase(PHASE.FAILED, '✗ Lost flight state: ' + e.message);
            scheduleRetry();
          });
          fireRocket();
        });
        return;
      }

      // Fire rocket if stalled at altitude
      if (delta < 0.5 && pos.y > CRUISE_ALT - 20) {
        console.warn('[EAFE] ⚠ Speed stalled — firing extra rocket');
        fireRocket();
      }

      lastPos = pos.clone();
    }, 1000);
  }

  // ─── LANDING ──────────────────────────────────────────────────────────────
  // Pitch = -0.30 rad (NOSE DOWN) → smooth glide descent to ground
  function startLanding() {
    setPhase(PHASE.LANDING, 'Initiating glide descent...');

    const landCheck = setInterval(() => {
      if (phase !== PHASE.LANDING) { clearInterval(landCheck); return; }

      const pos = bot.entity.position;

      // Nose DOWN (-0.30 rad = -17°) for controlled descent
      lookForce(yawTo(TARGET_X, TARGET_Z), -0.30);

      console.log(`[EAFE] [LAND] Y=${pos.y.toFixed(1)} dist=${dist2D().toFixed(1)}m ground=${bot.entity.onGround}`);

      if (bot.entity.onGround) {
        clearInterval(landCheck);
        clearInterval(verifyLoop); verifyLoop = null;
        retries = 0; // Flight successful!
        setPhase(PHASE.IDLE, `✅ Successfully landed at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`);
      }
    }, 200);
  }

  // ─── RETRY MECHANISM ─────────────────────────────────────────────────────
  function scheduleRetry() {
    if (retries >= MAX_RETRIES) {
      setPhase(PHASE.FAILED, `✗ FLIGHT FAILED permanently after ${MAX_RETRIES} attempts`);
      return;
    }
    retries++;
    const delay = retries * 3000;
    console.log(`[EAFE] Auto-retry ${retries}/${MAX_RETRIES} in ${delay / 1000}s...`);
    try { bot.chat(`[EAFE] Auto-retry ${retries}/${MAX_RETRIES} in ${delay / 1000}s`); } catch(_) {}
    setTimeout(() => {
      phase = PHASE.IDLE;
      startFlight();
    }, delay);
  }

  // ─── CHAT COMMANDS ────────────────────────────────────────────────────────
  bot.on('chat', (user, msg) => {
    if (user === bot.username) return;
    const cmd = msg.trim().toLowerCase();

    if (cmd === 'f') {
      retries = 0;
      startFlight();

    } else if (cmd === 's' || cmd === 'stop') {
      retries = MAX_RETRIES; // Cancel retries
      emergencyStop('user command');

    } else if (cmd === 'status') {
      const p = bot.entity.position;
      try {
        bot.chat(
          `phase=${phase} pos=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) ` +
          `elytra=${bot.entity.elytraFlying} ground=${bot.entity.onGround} ` +
          `dist=${dist2D().toFixed(0)}m retries=${retries}/${MAX_RETRIES}`
        );
      } catch(_) {}

    } else if (cmd === 'scan') {
      const s = scanLaunchArea();
      const spot = findBestLaunchSpot();
      try {
        bot.chat(
          `Scan: above=${s.clearAbove} path=${s.clearPath}` +
          (s.hitBlock ? ` hit=${s.hitBlock}@${s.hitDist}m` : '') +
          ` | bestSpot=${spot ? `(${spot.x},${spot.z}) score=${spot.score}` : 'none'}`
        );
      } catch(_) {}
    }
  });

  // ─── SPAWN & PACKET LISTENERS ──────────────────────────────────────────────
  bot.once('spawn', () => {
    console.log('[EAFE] ✓ Spawned');

    if (bot.physicsUtil) {
      physEngine = bot.physicsUtil.engine;
      console.log('[EAFE] ✓ physicsUtil engine initialized');
    }

    // ── Knockback: entity_velocity packet ────────────────────────────────
    bot._client.on('entity_velocity', packet => {
      if (!bot.entity || packet.entityId !== bot.entity.id) return;
      const vx = packet.velocity.x / 8000;
      const vy = packet.velocity.y / 8000;
      const vz = packet.velocity.z / 8000;
      bot.entity.velocity.x = vx;
      bot.entity.velocity.y = vy;
      bot.entity.velocity.z = vz;
      console.log(`[EAFE] ⚡ Velocity packet: (${vx.toFixed(3)}, ${vy.toFixed(3)}, ${vz.toFixed(3)})`);
    });

    // ── Knockback: explosion packet ──────────────────────────────────────
    bot._client.on('explosion', expl => {
      if (!bot.entity) return;
      if (expl.playerKnockback) {
        bot.entity.velocity.x += expl.playerKnockback.x;
        bot.entity.velocity.y += expl.playerKnockback.y;
        bot.entity.velocity.z += expl.playerKnockback.z;
        console.log('[EAFE] 💥 Explosion knockback applied');
      } else if ('playerMotionX' in expl) {
        bot.entity.velocity.x += expl.playerMotionX;
        bot.entity.velocity.y += expl.playerMotionY;
        bot.entity.velocity.z += expl.playerMotionZ;
        console.log('[EAFE] 💥 Explosion knockback applied (legacy)');
      }
    });

    // ── Auto-equip elytra on spawn ───────────────────────────────────────
    setTimeout(() => {
      autoEquipElytra().then(ok => {
        const hasRocket = !!findRocket();
        console.log(`[EAFE] Inventory check: elytra=${ok} rockets=${hasRocket}`);
        try {
          bot.chat(`[EAFE] Ready  Elytra:${ok ? '✓' : '✗'}  Rockets:${hasRocket ? '✓' : '✗'}  |  f=fly  s=stop  scan=scanArea`);
        } catch(_) {}
      });
    }, 2000);

    // ── Auto-equip when picked up or received ────────────────────────────
    bot.on('playerCollect', collector => {
      if (collector.username !== bot.username) return;
      setTimeout(() => {
        const chest = bot.inventory.slots[6];
        if (!chest || chest.name !== 'elytra') {
          if (bot.inventory.items().find(i => i.name === 'elytra')) {
            console.log('[EAFE] 🎽 Elytra picked up — auto-equipping');
            autoEquipElytra().catch(() => {});
          }
        }
      }, 300);
    });

    bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
      if (newItem?.name === 'elytra') {
        const chest = bot.inventory.slots[6];
        if (!chest || chest.name !== 'elytra') {
          console.log('[EAFE] 🎽 Elytra inventory update — auto-equipping');
          setTimeout(() => autoEquipElytra().catch(() => {}), 200);
        }
      }
    });

    console.log('[EAFE] Commands: f=fly  s/stop=stop  status  scan');
  });

  // ─── DISCONNECT ───────────────────────────────────────────────────────────
  bot._client?.on('error', () => {}); // silence raw socket error output during reconnect
  bot.on('error', e => console.error('[BOT] error:', e.message || e));
  bot.on('kicked', r => console.warn('[BOT] kicked:', typeof r === 'string' ? r : JSON.stringify(r)));
  bot.on('end', reason => {
    console.log('[BOT] disconnected:', reason, '— reconnecting in 10s');
    clearAllTimers();
    setTimeout(createBot, 10_000);
  });
}

// ─── BANNER ──────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════╗');
console.log('║  EAFE v5 — Elytra Autonomous Flight Engine   ║');
console.log('║  Physics: Native Mineflayer 50ms engine      ║');
console.log('║  Knockback: entity_velocity + explosion      ║');
console.log('║  Raycast: area scan + auto-relocation        ║');
console.log('║  Pitch: +0.65=UP, 0=Level, -0.30=DOWN        ║');
console.log(`║  Host: ${HOST}:${PORT}`.padEnd(46) + '║');
console.log('╚══════════════════════════════════════════════╝');

createBot();
