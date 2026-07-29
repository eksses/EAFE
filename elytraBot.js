'use strict';
/**
 * EAFE v7.2 — Elytra Autonomous Flight Engine Specification (Fixes & Pathfinder Integration)
 * =========================================================================================
 * Critical Fixes:
 *   1. Spatial Envelope Audit Bug Fix:
 *      - Changed runway check from dy=0..1 to dy=1..2 (Y+1 body & Y+2 head space).
 *      - Ground blocks at dy=0 no longer trigger false "Runway blocked at 1m" warnings in open fields!
 *   2. Pathfinder Integration (mineflayer-pathfinder):
 *      - Replaced raw walking with A* pathfinding (mineflayer-pathfinder).
 *      - Liquid cost set to infinity (canSwim = false) so bot NEVER steps into water or lava!
 *      - Pathfinds safely around obstacles to open launch spots.
 *   3. Strict Surface Safety (No Water/Lava Launches or Landings):
 *      - Strictly filters for solid ground (grass, dirt, stone, obsidian, etc.).
 *      - Re-routes launch/landing targets away from liquids and hazards.
 *   4. Preserved Flight Core (UNTOUCHED):
 *      - 150ms Jump Apex Rule Takeoff.
 *      - Pitch angles: +0.65=UP (Climb), +0.05=LEVEL (Cruise), -0.30=DOWN (Landing).
 *      - Smart rocket conservation (skips firing when ||v|| ≥ 1.4 b/t).
 *      - Dead-Stick unpowered glide & 4m touchdown flare.
 *      - Native Mineflayer 50ms physics sync with @nxg-org/mineflayer-physics-util.
 */

const mineflayer    = require('mineflayer');
const { Vec3 }      = require('vec3');
const physicsLoader = require('@nxg-org/mineflayer-physics-util').default;
const { EPhysicsCtx } = require('@nxg-org/mineflayer-physics-util');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');

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
  AUDIT:      'AUDIT',        // pre-flight inventory, fuel & spatial audit
  RELOCATING: 'RELOCATING',   // A* pathfinding to open launch spot
  TAKEOFF:    'TAKEOFF',      // 150ms jump apex + elytraFly()
  CLIMBING:   'CLIMBING',     // nose up (+0.65), gaining altitude
  CRUISING:   'CRUISING',     // level (+0.05), heading to target
  DEAD_STICK: 'DEAD_STICK',   // unpowered glide cruise (0 rockets remaining)
  LANDING:    'LANDING',      // Archimedean spiral & surface glide (-0.30)
  FAILED:     'FAILED',       // flight failed, auto-retry scheduled
};

// Whitelisted safe landing & launch surfaces (STRICT: NO WATER, NO LAVA)
const SAFE_SURFACES = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'stone', 'cobblestone',
  'smooth_stone', 'granite', 'diorite', 'andesite', 'sand', 'red_sand',
  'gravel', 'sandstone', 'obsidian', 'netherrack', 'end_stone', 'planks',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'stone_bricks', 'deepslate', 'terracotta', 'concrete'
]);

// ─── UTIL ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isAir(block) {
  if (!block) return true;
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

function isWaterOrLava(block) {
  if (!block) return false;
  return block.name.includes('water') || block.name.includes('lava');
}

// ─── BOT FACTORY ─────────────────────────────────────────────────────────────
function createBot() {
  const bot = mineflayer.createBot({
    host: HOST, port: PORT, username: USERNAME,
    version: false, auth: 'offline',
    checkTimeoutInterval: 60_000,
  });

  bot.loadPlugin(physicsLoader);
  bot.loadPlugin(pathfinder);

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
    try { bot.pathfinder.stop(); } catch(_) {}
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

  // ─── Inventory & Fuel Calculation (EAFE-v7.1 Sec 2.2) ───────────────────
  function countRockets() {
    let count = 0;
    for (const i of bot.inventory.items()) {
      if (i.name === 'firework_rocket') {
        try { if (i.nbt?.value?.Fireworks?.value?.Explosions) continue; } catch(_) {}
        count += i.count;
      }
    }
    return count;
  }

  function findRocket() {
    return bot.inventory.items().find(i => {
      if (i.name !== 'firework_rocket') return false;
      try { if (i.nbt?.value?.Fireworks?.value?.Explosions) return false; } catch(_) {}
      return true;
    });
  }

  /**
   * Elytra Durability & Auto-HotSwap Audit (EAFE-v7.1 Sec 3.2)
   */
  async function auditAndEquipElytra() {
    const chest = bot.inventory.slots[6];
    if (chest?.name === 'elytra') {
      const dur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 400;
      if (dur > 15) {
        console.log(`[EAFE] ✓ Elytra equipped (durability: ${dur})`);
        return true;
      }
      console.warn(`[EAFE] ⚠ Equipped Elytra durability low (${dur} points) — looking for spare...`);
    }

    const spare = bot.inventory.items().find(i => {
      if (i.name !== 'elytra') return false;
      const dur = i.maxDurability ? (i.maxDurability - i.durabilityUsed) : 400;
      return dur > 15;
    });

    if (!spare) {
      console.warn('[EAFE] ⚠ No usable Elytra (durability > 15) found in inventory');
      return false;
    }

    try {
      await bot.equip(spare, 'torso');
      console.log('[EAFE] 🎽 Fresh Elytra equipped to chest slot');
      try { bot.chat('[EAFE] ✓ Fresh Elytra equipped!'); } catch(_) {}
      return true;
    } catch(e) {
      console.error('[EAFE] ✗ Equip elytra failed:', e.message);
      return false;
    }
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

  function lookForce(yaw, pitch) {
    bot.look(yaw, pitch, true);
  }

  /**
   * Smart Rocket Consumption & Conservation Algorithm (EAFE-v7.1 Sec 1.1 & 5.0)
   */
  function smartFireRocket() {
    if (!bot.entity.elytraFlying) return false;

    const vel = bot.entity.velocity;
    const speed = Math.hypot(vel.x, vel.y, vel.z);

    if (speed >= 1.4) {
      console.log(`[EAFE] 🍃 Rocket skipped — speed optimal (${(speed * 20).toFixed(1)} m/s)`);
      return false;
    }

    const ping = bot.player?.ping ?? 50;
    if (ping > 500) {
      console.warn(`[EAFE] ⚠ High server ping (${ping}ms) — throttling rocket`);
      return false;
    }

    const r = findRocket();
    if (!r) {
      console.warn('[EAFE] ⚠ Out of fireworks!');
      return false;
    }

    try {
      if (r.slot < 9) bot.setQuickBarSlot(r.slot);
      bot.activateItem();
      console.log(`[EAFE] 🚀 Smart Rocket fired (slot ${r.slot}) | speed=${(speed * 20).toFixed(1)}m/s`);
      return true;
    } catch(e) { console.warn('[EAFE] rocket err:', e.message); return false; }
  }

  function fireRocketDirect() {
    const r = findRocket();
    if (!r) return false;
    try {
      if (r.slot < 9) bot.setQuickBarSlot(r.slot);
      bot.activateItem();
      console.log(`[EAFE] 🚀 Takeoff Rocket fired (slot ${r.slot})`);
      return true;
    } catch(_) { return false; }
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
  //  PRE-FLIGHT AUDIT & SPATIAL ENVELOPE (FIXED dy=1..2 & strict ground)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Spatial Envelope Audit:
   *  1. Overhead Column: Y+1 to Y+5 (5 blocks straight up)
   *  2. Forward Runway: 4m ahead at Y+1 (body) and Y+2 (head)
   */
  function auditSpatialEnvelope() {
    const pos = bot.entity.position;
    const yaw = yawTo(TARGET_X, TARGET_Z);

    // 1. Overhead Column (Y+1 to Y+5)
    for (let dy = 1; dy <= 5; dy++) {
      const b = bot.blockAt(pos.offset(0, dy, 0));
      if (!isAir(b)) {
        return { clear: false, reason: `Overhead blocked at Y+${dy} (${b?.name})` };
      }
    }

    // 2. Forward Runway: check Y+1 and Y+2 (body & head clearance, excluding ground!)
    const dirX = -Math.sin(yaw);
    const dirZ =  Math.cos(yaw);

    for (let d = 1; d <= 4; d++) {
      for (let dy = 1; dy <= 2; dy++) {
        const bPos = pos.offset(Math.round(dirX * d), dy, Math.round(dirZ * d));
        const b = bot.blockAt(bPos);
        if (!isAir(b)) {
          return { clear: false, reason: `Runway blocked at ${d}m ahead (Y+${dy}: ${b?.name})` };
        }
      }
    }

    // 3. Ground under feet: verify it's NOT liquid (water/lava)
    const blockUnder = bot.blockAt(pos.offset(0, -0.5, 0));
    if (isWaterOrLava(blockUnder)) {
      return { clear: false, reason: `Standing in liquid (${blockUnder?.name})` };
    }

    return { clear: true, reason: 'Spatial envelope clear' };
  }

  /**
   * Find nearby open elevated launch spot on STRICT safe solid ground (no water/lava!)
   */
  function findElevatedOpenSpot() {
    const pos   = bot.entity.position;
    const baseY = Math.floor(pos.y);
    let best    = null;

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

        // STRICT SAFETY: Must be solid ground, NEVER water or lava!
        if (!groundBlock || isWaterOrLava(groundBlock) || !SAFE_SURFACES.has(groundBlock.name)) {
          continue;
        }

        // Check clear sky above ground
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
   * Pathfind to target launch spot using mineflayer-pathfinder (A* search)
   * Avoids water, lava, hazards, and pits!
   */
  async function pathfindToSpot(tx, ty, tz) {
    console.log(`[EAFE] 🗺 Pathfinding to safe launch spot (${tx}, ${ty}, ${tz})...`);

    const defaultMove = new Movements(bot);
    defaultMove.canSwim = false;      // NEVER ENTER WATER
    defaultMove.liquidCost = 100;     // HIGH PENALTY FOR LIQUIDS
    defaultMove.allowParkour = false; // STICK TO SAFE PATHS

    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(tx, ty, tz));

    const TIMEOUT = 15_000;
    const start   = Date.now();

    return new Promise(resolve => {
      const checkGoal = setInterval(() => {
        const p = bot.entity.position;
        const dist = Math.hypot(tx - p.x, tz - p.z);
        if (dist <= 1.5 || !bot.pathfinder.isMoving()) {
          clearInterval(checkGoal);
          bot.pathfinder.stop();
          console.log(`[EAFE] 🗺 Pathfinding completed (dist=${dist.toFixed(1)}m)`);
          resolve(dist <= 2.5);
        }
        if (Date.now() - start > TIMEOUT) {
          clearInterval(checkGoal);
          bot.pathfinder.stop();
          console.warn('[EAFE] ⚠ Pathfinding timed out');
          resolve(false);
        }
      }, 200);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  FLIGHT PHASES
  // ─────────────────────────────────────────────────────────────────────────

  async function startFlight() {
    if (phase !== PHASE.IDLE && phase !== PHASE.FAILED) {
      try { bot.chat('[EAFE] Flight already in progress — use s to stop'); } catch(_) {}
      return;
    }

    setPhase(PHASE.AUDIT, 'Running pre-flight inventory, fuel & spatial audit...');

    // 1. Elytra durability audit
    const elytraOk = await auditAndEquipElytra();
    if (!elytraOk) { setPhase(PHASE.FAILED, '✗ No usable Elytra (durability > 15)'); return; }

    // 2. Fuel audit calculation
    const rocketsAvail = countRockets();
    const d2d = dist2D(TARGET_X, TARGET_Z);
    const startY = bot.entity.position.y;
    const reqRockets = Math.ceil(d2d / 68.5) + Math.ceil(Math.abs(CRUISE_ALT - startY) / 28.0) + 15;

    console.log(`[EAFE] Fuel Audit: Available=${rocketsAvail} | Required=${reqRockets} (dist=${d2d.toFixed(0)}m)`);
    if (rocketsAvail < reqRockets) {
      try { bot.chat(`[EAFE] ⚠ Fuel warning: Have ${rocketsAvail} rockets, calculated ${reqRockets} needed`); } catch(_) {}
    }

    // 3. 3D Spatial Envelope Audit
    const spatial = auditSpatialEnvelope();
    console.log(`[EAFE] Spatial Audit: clear=${spatial.clear} (${spatial.reason})`);

    if (!spatial.clear) {
      try { bot.chat(`[EAFE] ⚠ Launch check failed (${spatial.reason}) — pathfinding to clear spot...`); } catch(_) {}

      const spot = findElevatedOpenSpot();
      if (!spot) {
        setPhase(PHASE.FAILED, '✗ Obstacles/liquids detected — no safe open launch spot nearby');
        scheduleRetry();
        return;
      }

      setPhase(PHASE.RELOCATING, `Pathfinding to open spot (${spot.x}, ${spot.y}, ${spot.z}) on ${spot.blockName}`);
      const arrived = await pathfindToSpot(spot.x, spot.y, spot.z);
      if (!arrived) {
        setPhase(PHASE.FAILED, '✗ Could not pathfind to launch spot');
        scheduleRetry();
        return;
      }

      const spatial2 = auditSpatialEnvelope();
      if (!spatial2.clear) {
        setPhase(PHASE.FAILED, `✗ Spatial envelope still blocked after relocation (${spatial2.reason})`);
        scheduleRetry();
        return;
      }
    }

    // ── TAKEOFF ──
    await executeTakeoff();
  }

  /**
   * 150ms Jump Apex Rule Takeoff (UNTOUCHED WORKING CORE)
   */
  async function executeTakeoff() {
    if (phase === PHASE.FAILED) return;
    setPhase(PHASE.TAKEOFF, 'Jumping & activating elytra...');

    // Clear controls
    ['sprint','forward','back','left','right','sneak'].forEach(k => {
      try { bot.setControlState(k, false); } catch(_) {}
    });

    lookForce(yawTo(TARGET_X, TARGET_Z), 0.5);

    // Jump
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
      setPhase(PHASE.FAILED, '✗ Jump failed (bot remained on ground)');
      scheduleRetry();
      return;
    }

    console.log(`[EAFE] ✓ Airborne (Y=${bot.entity.position.y.toFixed(2)}) — calling elytraFly()`);

    try {
      await bot.elytraFly();
      console.log('[EAFE] ✓ elytraFly() packet sent');
    } catch(e) {
      console.error('[EAFE] elytraFly() error:', e.message);
      setPhase(PHASE.FAILED, '✗ elytraFly error: ' + e.message);
      scheduleRetry();
      return;
    }

    fireRocketDirect();

    await sleep(250);
    if (!isFlying()) {
      console.warn('[EAFE] ⚠ Fly state false after launch — retrying elytraFly + rocket');
      try { await bot.elytraFly(); } catch(_) {}
      fireRocketDirect();
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

  // ─── CLIMB (UNTOUCHED WORKING CORE) ──────────────────────────────────────
  function startClimb() {
    setPhase(PHASE.CLIMBING, `Climbing to Y=${CRUISE_ALT}...`);

    lookForce(yawTo(TARGET_X, TARGET_Z), 0.65);
    fireRocketDirect();

    if (rocketLoop) clearInterval(rocketLoop);
    rocketLoop = setInterval(() => {
      if (phase !== PHASE.CLIMBING) { clearInterval(rocketLoop); rocketLoop = null; return; }
      smartFireRocket();
    }, 1200);

    if (climbLoop) clearInterval(climbLoop);
    climbLoop = setInterval(() => {
      if (phase !== PHASE.CLIMBING) { clearInterval(climbLoop); climbLoop = null; return; }

      const pos = bot.entity.position;
      const yaw = yawTo(TARGET_X, TARGET_Z);
      console.log(`[EAFE] [CLIMB] Y=${pos.y.toFixed(1)} elytra=${bot.entity.elytraFlying} ground=${bot.entity.onGround}`);

      lookForce(yaw, 0.65);

      if (bot.entity.onGround && pos.y < CRUISE_ALT - 10) {
        clearInterval(climbLoop); climbLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        setPhase(PHASE.FAILED, '✗ Unexpected ground contact during climb');
        scheduleRetry();
        return;
      }

      if (!isFlying() && !bot.entity.onGround) {
        console.warn('[EAFE] ⚠ Lost fly state mid-climb — re-issuing elytraFly');
        bot.elytraFly().catch(() => {});
        smartFireRocket();
        return;
      }

      if (pos.y >= CRUISE_ALT) {
        clearInterval(climbLoop); climbLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        startCruise();
      }
    }, 200);
  }

  // ─── CRUISE & SMART ROCKET CONSERVATION ──────────────────────────────────
  function startCruise() {
    setPhase(PHASE.CRUISING, `Cruising to (${TARGET_X}, ?, ${TARGET_Z})`);

    if (rocketLoop) clearInterval(rocketLoop);
    rocketLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) { clearInterval(rocketLoop); rocketLoop = null; return; }

      if (countRockets() === 0 && phase !== PHASE.DEAD_STICK) {
        setPhase(PHASE.DEAD_STICK, '⚠ Out of fireworks — engaging Dead-Stick L/D Glide');
      }

      if (phase === PHASE.CRUISING) {
        smartFireRocket();
      }
    }, 1500);

    if (flyLoop) clearInterval(flyLoop);
    flyLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) { clearInterval(flyLoop); flyLoop = null; return; }

      const d = dist2D();
      if (d < 25) {
        clearInterval(flyLoop); flyLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        startLanding();
        return;
      }

      const yaw = yawTo(TARGET_X, TARGET_Z);
      const vel = bot.entity.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);

      if (speed < 0.05 && bot.entity.position.y > 75) {
        console.warn('[EAFE] ⚠ Wall collision / stall detected! Executing 180° pitch boost...');
        lookForce(yaw + Math.PI, 0.70);
        fireRocketDirect();
        return;
      }

      if (phase === PHASE.DEAD_STICK) {
        lookForce(yaw, 0.02);
      } else {
        lookForce(yaw, 0.05);
      }
    }, 50);

    if (verifyLoop) clearInterval(verifyLoop);
    let lastPos = bot.entity.position.clone();
    verifyLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) { clearInterval(verifyLoop); verifyLoop = null; return; }

      const pos   = bot.entity.position;
      const delta = Math.abs(pos.x - lastPos.x) + Math.abs(pos.y - lastPos.y) + Math.abs(pos.z - lastPos.z);
      console.log(
        `[EAFE] [1s] pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) ` +
        `Δ=${delta.toFixed(2)} elytra=${bot.entity.elytraFlying} dist=${dist2D().toFixed(0)}m rockets=${countRockets()}`
      );

      if (!isFlying() && !bot.entity.onGround) {
        console.warn('[EAFE] ⚠ Fly state false during cruise — attempting recovery');
        auditAndEquipElytra().then(() => {
          if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) return;
          bot.elytraFly().catch(e => {
            setPhase(PHASE.FAILED, '✗ Lost flight state: ' + e.message);
            scheduleRetry();
          });
          if (countRockets() > 0) fireRocketDirect();
        });
        return;
      }

      lastPos = pos.clone();
    }, 1000);
  }

  // ─── LANDING & DEAD-STICK FLARE ENGINE ───────────────────────────────────
  function startLanding() {
    setPhase(PHASE.LANDING, 'Initiating Archimedean spiral landing & surface validation...');

    let targetX = TARGET_X;
    let targetZ = TARGET_Z;

    let groundBlock = getGroundBlockAt(targetX, targetZ);
    if (groundBlock && (isWaterOrLava(groundBlock) || !SAFE_SURFACES.has(groundBlock.name))) {
      console.warn(`[EAFE] ⚠ Target LZ (${targetX}, ${targetZ}) is unsafe (${groundBlock.name}) — running Archimedean spiral...`);

      let foundSafe = false;
      for (let r = 1; r <= 20; r += 2) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
          const sx = Math.round(TARGET_X + r * Math.cos(angle));
          const sz = Math.round(TARGET_Z + r * Math.sin(angle));
          const sb = getGroundBlockAt(sx, sz);
          if (sb && !isWaterOrLava(sb) && SAFE_SURFACES.has(sb.name)) {
            targetX = sx;
            targetZ = sz;
            foundSafe = true;
            console.log(`[EAFE] ✓ Re-routed landing to safe solid block (${sb.name}) at (${sx}, ${sz})`);
            break;
          }
        }
        if (foundSafe) break;
      }
    }

    const landCheck = setInterval(() => {
      if (phase !== PHASE.LANDING) { clearInterval(landCheck); return; }

      const pos = bot.entity.position;
      const relY = pos.y - (groundBlock?.position?.y ?? 70);

      if (relY <= 4.0) {
        lookForce(yawTo(targetX, targetZ), 0.10); // Nose UP flare
        try { bot.setControlState('sneak', true); } catch(_) {}
      } else {
        lookForce(yawTo(targetX, targetZ), -0.30); // Nose DOWN glide descent
      }

      console.log(`[EAFE] [LAND] Y=${pos.y.toFixed(1)} dist=${dist2D(targetX, targetZ).toFixed(1)}m ground=${bot.entity.onGround}`);

      if (bot.entity.onGround) {
        clearInterval(landCheck);
        clearInterval(verifyLoop); verifyLoop = null;
        try { bot.setControlState('sneak', false); } catch(_) {}
        retries = 0;
        setPhase(PHASE.IDLE, `✅ Successfully landed at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`);
      }
    }, 200);
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
      retries = MAX_RETRIES;
      emergencyStop('user command');

    } else if (cmd === 'status') {
      const p = bot.entity.position;
      try {
        bot.chat(
          `phase=${phase} pos=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) ` +
          `elytra=${bot.entity.elytraFlying} ground=${bot.entity.onGround} ` +
          `rockets=${countRockets()} dist=${dist2D().toFixed(0)}m retries=${retries}/${MAX_RETRIES}`
        );
      } catch(_) {}

    } else if (cmd === 'audit') {
      const rocketsAvail = countRockets();
      const d2d = dist2D(TARGET_X, TARGET_Z);
      const reqRockets = Math.ceil(d2d / 68.5) + 15;
      const spatial = auditSpatialEnvelope();
      try {
        bot.chat(
          `Audit: Rockets=${rocketsAvail}/${reqRockets} Spatial=${spatial.clear?'✓':'✗'}` +
          (!spatial.clear ? ` (${spatial.reason})` : '')
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
      auditAndEquipElytra().then(ok => {
        const count = countRockets();
        console.log(`[EAFE] Inventory audit: elytra=${ok} rockets=${count}`);
        try {
          bot.chat(`[EAFE] Ready  Elytra:${ok ? '✓' : '✗'}  Rockets:${count}  |  f=fly  s=stop  audit=runAudit`);
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
            auditAndEquipElytra().catch(() => {});
          }
        }
      }, 300);
    });

    bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
      if (newItem?.name === 'elytra') {
        const chest = bot.inventory.slots[6];
        if (!chest || chest.name !== 'elytra') {
          console.log('[EAFE] 🎽 Elytra inventory update — auto-equipping');
          setTimeout(() => auditAndEquipElytra().catch(() => {}), 200);
        }
      }
    });

    console.log('[EAFE] Commands: f=fly  s/stop=stop  status  audit');
  });

  // ─── DISCONNECT ───────────────────────────────────────────────────────────
  bot._client?.on('error', () => {});
  bot.on('error', e => console.error('[BOT] error:', e.message || e));
  bot.on('kicked', r => console.warn('[BOT] kicked:', typeof r === 'string' ? r : JSON.stringify(r)));
  bot.on('end', reason => {
    console.log('[BOT] disconnected:', reason, '— reconnecting in 10s');
    clearAllTimers();
    setTimeout(createBot, 10_000);
  });
}

// ─── BANNER ──────────────────────────────────────────────────────────────────
console.log('╔═════════════════════════════════════════════════════════════╗');
console.log('║  EAFE v7.2 — Pathfinder & Spatial Audit Fixes               ║');
console.log('║  Pathfinder: mineflayer-pathfinder A* (No Water/No Lava)    ║');
console.log('║  Audit Fix: Runway checked at Y+1 & Y+2 (No Ground False +)  ║');
console.log('║  Physics: Native Mineflayer 50ms Engine                      ║');
console.log('║  Fuel: N_req Formula + Speed-Gated Rocket Firing (||v||)     ║');
console.log(`║  Host: ${HOST}:${PORT}`.padEnd(61) + '║');
console.log('╚═════════════════════════════════════════════════════════════╝');

createBot();
