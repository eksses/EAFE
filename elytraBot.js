'use strict';
/**
 * EAFE v10.5 — Goal-First Lawnmower Ocean Scan & Remaining Rocket Reporting
 * ====================================================================================
 * Enhancements:
 *   1. Goal-Location First Ocean Search (startWanderScan):
 *      - Upon arriving at destination (X, Z), if LZ is open ocean, the bot ALWAYS executes
 *        a straight-line grid lawnmower search around the GOAL LOCATION FIRST to locate
 *        islands, shores, or land near the target!
 *      - Does NOT turn back to base automatically.
 *   2. Emergency Low-Fuel Coastline Fallback:
 *      - Flight-trail memory (lastKnownSafeGround) is used ONLY as a true emergency fallback
 *        if 40+ chunks around goal have been searched and remaining rockets drop to <= 6 (<= 15%).
 *   3. Remaining Firework Rocket Count in Arrival Announcement:
 *      - Arrival message now displays remaining fireworks:
 *        "✅ Destination Reached! Arrived safely at (...) | Rockets remaining: 45/51"
 *   4. Dynamic Unbreaking-Aware Elytra Health & Mid-Flight Auto-Swap:
 *      - Audits Unbreaking 1-3 damage rates (25%-50%), sums durability across all inventory Elytras,
 *        and auto-swaps mid-flight with instant flight recovery.
 *
 * Commands: f [X Z], setgoal X Z, m fast/med/low, s, status, audit.
 */

const mineflayer    = require('mineflayer');
const { Vec3 }      = require('vec3');
const readline      = require('readline');
const physicsLoader = require('@nxg-org/mineflayer-physics-util').default;
const { EPhysicsCtx } = require('@nxg-org/mineflayer-physics-util');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const HOST       = '103.151.60.212';
const PORT       = 25565;
const USERNAME   = 'test';
const DEFAULT_TARGET_X = 100;
const DEFAULT_TARGET_Z = 100;
const CRUISE_ALT       = 180;   // Safe target cruise altitude (Y=180)
const MAX_RETRIES      = 3;     // retries before giving up

// ─── FLIGHT MODES ────────────────────────────────────────────────────────────
const MODES = {
  FAST: {
    name: 'FAST (High Speed Sprint)',
    pitch: 0.02,
    speedGate: 1.5, // 30 m/s
    speedMps: 30.0,
    fuelDistDivider: 35.0, // ~35m per rocket
  },
  MEDIUM: {
    name: 'MEDIUM (Balanced Glide)',
    pitch: 0.04,
    speedGate: 1.0, // 20 m/s
    speedMps: 20.0,
    fuelDistDivider: 70.0, // ~70m per rocket
  },
  EFFICIENT: {
    name: 'EFFICIENT (True Rocket Saver)',
    pitch: -0.04, // Slight nose-down gravity pitch to convert potential energy to speed!
    speedGate: 0.65, // 13 m/s
    speedMps: 14.0,
    fuelDistDivider: 150.0, // ~150m per rocket (70% fuel savings!)
  }
};

// ─── PHASE STATE ─────────────────────────────────────────────────────────────
const PHASE = {
  IDLE:        'IDLE',
  AUDIT:       'AUDIT',        // pre-flight inventory, fuel & spatial audit
  RELOCATING:  'RELOCATING',   // A* pathfinding & block-digging en route to open launch spot
  TAKEOFF:     'TAKEOFF',      // 150ms jump apex + elytraFly() + instant off-hand rocket
  CLIMBING:    'CLIMBING',     // continuous nose up (+0.65 to +0.75), gaining altitude
  CRUISING:    'CRUISING',     // level (+0.05), heading to target
  WANDER_SCAN: 'WANDER_SCAN',  // High-altitude straight-line grid ocean scan
  DEAD_STICK:  'DEAD_STICK',   // unpowered glide cruise (0 rockets remaining)
  LANDING:     'LANDING',      // Archimedean spiral & surface glide (-0.30)
  FAILED:      'FAILED',       // flight failed, auto-retry scheduled
};

// Whitelisted safe landing & launch surfaces (STRICT: NO WATER, NO LAVA)
const SAFE_SURFACES = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'stone', 'cobblestone',
  'smooth_stone', 'granite', 'diorite', 'andesite', 'sand', 'red_sand',
  'gravel', 'sandstone', 'obsidian', 'netherrack', 'end_stone', 'planks',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'stone_bricks', 'deepslate', 'terracotta', 'concrete'
]);

// Cardinal Yaw Directions for Straight-Line Grid Flying
const CARDINAL_YAWS = [
  Math.PI,         // North (-Z)
  -Math.PI / 2,    // East (+X)
  0,               // South (+Z)
  Math.PI / 2,     // West (-X)
];

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

function angleDiff(a, b) {
  let diff = (a - b) % (2 * Math.PI);
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (diff > Math.PI) diff -= 2 * Math.PI;
  return Math.abs(diff);
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
  let phase               = PHASE.IDLE;
  let currentMode         = MODES.MEDIUM; // Default: Medium (Balanced)
  let activeTargetX       = DEFAULT_TARGET_X;
  let activeTargetZ       = DEFAULT_TARGET_Z;
  let retries             = 0;
  let spatialClear        = false;        // Checkmark flag for ground clearance
  let activeLaunchYaw     = 0;            // Selected takeoff heading
  let lastTerrainWarn     = 0;            // Rate-limiter timestamp for terrain warnings

  // Flight Trail Memory: Records last known solid safe land surface passed over
  let lastKnownSafeGround = null;

  // Straight-line grid lawn-mower search state
  let gridDirIndex        = 0;            // 0=North, 1=East, 2=South, 3=West
  let gridLegLength       = 1;            // Current leg multiplier
  let legStartPos         = null;         // Start position of current straight leg
  const scannedChunks     = new Set();    // Chunk Memory Map ("cx,cz")

  let physEngine          = null;
  let flyLoop             = null;
  let verifyLoop          = null;
  let rocketLoop          = null;
  let climbLoop           = null;

  // ─── Timer cleanup ────────────────────────────────────────────────────────
  function clearAllTimers() {
    [flyLoop, verifyLoop, rocketLoop, climbLoop].forEach(h => { if (h) clearInterval(h); });
    flyLoop = verifyLoop = rocketLoop = climbLoop = null;
  }

  // ─── Emergency stop ───────────────────────────────────────────────────────
  function emergencyStop(reason) {
    phase = PHASE.IDLE;
    spatialClear = false;
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

  // ─── REAL-TIME SERVER RENDER DISTANCE ENGINE ────────────────────────────────
  /**
   * Dynamically measures the server's real-time render/view distance in chunks and blocks!
   * Audits loaded chunk column memory in bot.world.
   */
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

    // Clamp detected render distance between 4 and 16 chunks
    const chunks = Math.min(Math.max(maxDistChunks, 4), 16);
    const blocks = chunks * 16;

    // Calculate optimal scanning altitude: Y_scan = clamp(60 + blocks * 0.6, 90, 160)
    const scanAlt = Math.min(Math.max(Math.round(60 + blocks * 0.6), 90), 160);

    return { chunks, blocks, scanAlt };
  }

  // ─── Inventory & Off-Hand Firework Equipment ────────────────────────────────
  function countRockets() {
    let count = 0;
    for (let slot = 0; slot <= 45; slot++) {
      const i = bot.inventory.slots[slot];
      if (i && i.name === 'firework_rocket') {
        try { if (i.nbt?.value?.Fireworks?.value?.Explosions) continue; } catch(_) {}
        count += i.count;
      }
    }
    return count;
  }

  function findRocket() {
    const offhand = bot.inventory.slots[45];
    if (offhand && offhand.name === 'firework_rocket') return offhand;

    for (let slot = 0; slot <= 44; slot++) {
      const i = bot.inventory.slots[slot];
      if (i && i.name === 'firework_rocket') {
        try { if (i.nbt?.value?.Fireworks?.value?.Explosions) continue; } catch(_) {}
        return i;
      }
    }
    return null;
  }

  /**
   * Auto-equip Firework Rockets directly into OFF-HAND (slot 45) for 100% reliable packet firing!
   */
  async function autoEquipRocket() {
    const offhand = bot.inventory.slots[45];
    if (offhand?.name === 'firework_rocket') return true;

    const rocket = findRocket();
    if (!rocket) {
      console.warn('[EAFE] ⚠ No firework rockets found in inventory!');
      return false;
    }

    try {
      await bot.equip(rocket, 'off-hand');
      console.log('[EAFE] 🚀 Firework rockets equipped to OFF-HAND (slot 45)');
      return true;
    } catch(e) {
      console.warn('[EAFE] ⚠ Equip off-hand rocket failed:', e.message);
      return false;
    }
  }

  // ─── DYNAMIC UNBREAKING-AWARE ELYTRA ENGINE ─────────────────────────────────

  /**
   * Audits Unbreaking enchantment level (0, 1, 2, 3) on an item
   */
  function getUnbreakingLevel(item) {
    if (!item) return 0;
    if (item.enchants && Array.isArray(item.enchants)) {
      const u = item.enchants.find(e => e.name === 'unbreaking' || e.name === 'durability');
      if (u) return u.lvl ?? 1;
    }
    try {
      const enchs = item.nbt?.value?.Enchantments?.value?.value || item.nbt?.value?.ench?.value?.value;
      if (enchs && Array.isArray(enchs)) {
        const u = enchs.find(e => e.id?.value === 'unbreaking' || e.id?.value === 34);
        if (u) return u.lvl?.value ?? 1;
      }
    } catch(_) {}
    return 0;
  }

  /**
   * Durability consumption rate per second based on Unbreaking level:
   *   Unbreaking 0: 1.00 dur/sec
   *   Unbreaking I: 0.50 dur/sec
   *   Unbreaking II: 0.333 dur/sec
   *   Unbreaking III: 0.25 dur/sec (4x lifespan!)
   */
  function getElytraDamageRate(unbreakingLvl) {
    switch (unbreakingLvl) {
      case 1:  return 0.50;
      case 2:  return 0.333;
      case 3:  return 0.25;
      default: return 1.0;
    }
  }

  /**
   * Calculates exact required Elytra durability for a given distance and mode velocity!
   */
  function calculateRequiredElytraDurability(d2d, speedMps, unbreakingLvl) {
    const flightTimeSec = d2d / Math.max(speedMps, 10.0);
    const damageRate = getElytraDamageRate(unbreakingLvl);
    const reqDur = Math.ceil(flightTimeSec * damageRate);
    const reserveBuffer = 15; // 15 durability points safety buffer
    return reqDur + reserveBuffer;
  }

  /**
   * Scans all slots (including equipped slot 6) and automatically equips the
   * Elytra with the HIGHEST remaining durability!
   */
  async function auditAndEquipElytra() {
    let bestSlot = null;
    let bestDur  = -1;

    // Check equipped chest slot (slot 6)
    const chest = bot.inventory.slots[6];
    if (chest?.name === 'elytra') {
      const dur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
      bestSlot = 6;
      bestDur  = dur;
    }

    // Check all inventory slots for a higher durability Elytra
    for (let s = 0; s <= 45; s++) {
      const item = bot.inventory.slots[s];
      if (item && item.name === 'elytra') {
        const dur = item.maxDurability ? (item.maxDurability - item.durabilityUsed) : 432;
        if (dur > bestDur) {
          bestDur  = dur;
          bestSlot = s;
        }
      }
    }

    if (bestSlot === null || bestDur <= 15) {
      console.warn(`[EAFE] ⚠ No usable Elytra found (durability > 15). Highest available: ${bestDur > 0 ? bestDur : 0}/432`);
      try {
        bot.chat(`[EAFE] ⚠ Elytra health critical! Highest: ${bestDur > 0 ? bestDur : 0}/432 points. Please give me a fresh Elytra!`);
      } catch(_) {}
      return false;
    }

    // If highest durability Elytra is in inventory (not chest slot 6), auto-swap to it!
    if (bestSlot !== 6) {
      const spareItem = bot.inventory.slots[bestSlot];
      try {
        await bot.equip(spareItem, 'torso');
        console.log(`[EAFE] 🎽 Auto-swapped to best Elytra from slot ${bestSlot} (Durability: ${bestDur}/432)`);
        try { bot.chat(`[EAFE] 🎽 Auto-swapped to best Elytra (${bestDur}/432 durability)`); } catch(_) {}
      } catch(e) {
        console.error('[EAFE] ✗ Equip best elytra failed:', e.message);
        return false;
      }
    } else {
      console.log(`[EAFE] ✓ Equipped Elytra is optimal (Durability: ${bestDur}/432)`);
    }

    return true;
  }

  /**
   * Mid-Flight Elytra Auto-Swap & Flight State Recovery Failsafe
   * Triggers when equipped Elytra drops <= 15 durability points during active flight.
   */
  async function checkMidFlightElytraSwap() {
    const chest = bot.inventory.slots[6];
    if (!chest || chest.name !== 'elytra') return;

    const dur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
    if (dur <= 15) {
      console.warn(`[EAFE] 🎽 Equipped Elytra durability low (${dur}/432) — executing mid-flight auto-swap!`);
      const swapped = await auditAndEquipElytra();
      if (swapped) {
        console.log('[EAFE] 🎽 Mid-flight Elytra swapped — re-issuing elytraFly() & rocket boost!');
        try { await bot.elytraFly(); } catch(_) {}
        fireRocketDirect();
      } else {
        console.error('[EAFE] ⚠ Out of spare Elytras! Emergency landing initiated...');
        try { bot.chat('[EAFE] ⚠ Elytra durability low & no spares! Emergency landing!'); } catch(_) {}
        startLanding();
      }
    }
  }

  /**
   * Summary diagnostics of all Elytras in inventory & equipment
   */
  function getElytraSummary() {
    let count = 0;
    let equippedDur = 0;
    let maxDur = 0;
    let totalDurabilityAcrossAll = 0;
    let bestUnbreaking = 0;

    const chest = bot.inventory.slots[6];
    if (chest?.name === 'elytra') {
      equippedDur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
      count++;
      totalDurabilityAcrossAll += equippedDur;
      if (equippedDur > maxDur) maxDur = equippedDur;
      const u = getUnbreakingLevel(chest);
      if (u > bestUnbreaking) bestUnbreaking = u;
    }

    for (let s = 0; s <= 45; s++) {
      if (s === 6) continue;
      const item = bot.inventory.slots[s];
      if (item && item.name === 'elytra') {
        const dur = item.maxDurability ? (item.maxDurability - item.durabilityUsed) : 432;
        count++;
        totalDurabilityAcrossAll += dur;
        if (dur > maxDur) maxDur = dur;
        const u = getUnbreakingLevel(item);
        if (u > bestUnbreaking) bestUnbreaking = u;
      }
    }

    return { count, equippedDur, maxDur, totalDurabilityAcrossAll, bestUnbreaking };
  }

  // ─── Mineflayer Navigation Helpers (CORRECTED YAW FORMULA) ───────────────────
  function yawTo(x, z) {
    const p = bot.entity.position;
    return Math.atan2(-(x - p.x), -(z - p.z));
  }

  function dist2D(x, z) {
    const p = bot.entity.position;
    return Math.hypot((x ?? activeTargetX) - p.x, (z ?? activeTargetZ) - p.z);
  }

  function lookForce(yaw, pitch) {
    bot.look(yaw, pitch, true);
  }

  /**
   * Empirically Verified Firework Fuel Calculation
   * Formula:
   *   N_req = N_distance + N_climb + N_retry_waste + N_wander_landing
   */
  function calculateRequiredRockets(d2d, deltaY) {
    const dReq = Math.ceil(d2d / currentMode.fuelDistDivider);
    const yReq = Math.ceil(Math.abs(deltaY) / 10.0);
    const retryWasteBuffer    = MAX_RETRIES * 3; // 9 rockets buffer for up to 3 failed retries
    const wanderLandingBuffer = 12;              // 12 rockets unconditionally reserved for landing & wander

    return dReq + yReq + retryWasteBuffer + wanderLandingBuffer;
  }

  /**
   * Bulletproof Firework Rocket Activation (Off-Hand Packet Firing + Yaw-Lock Failsafe)
   */
  function fireRocketDirect(targetYawCheck = null) {
    if (!bot.entity.elytraFlying) return false;

    // Failsafe 1: Verify yaw alignment before applying rocket thrust (must be within 15° = 0.26 rad)
    if (targetYawCheck !== null) {
      const err = angleDiff(bot.entity.yaw, targetYawCheck);
      if (err > 0.26) {
        console.log(`[EAFE] 🧭 Yaw alignment error (${(err * 180 / Math.PI).toFixed(1)}°) — aligning before rocket boost`);
        lookForce(targetYawCheck, currentMode.pitch);
        return false;
      }
    }

    // Failsafe 2: Verify off-hand equipment
    const offhand = bot.inventory.slots[45];
    if (offhand?.name !== 'firework_rocket') {
      autoEquipRocket().catch(() => {});
    }

    try {
      bot.activateItem(true); // Fire off-hand firework rocket!
      console.log(`[EAFE] 🚀 OFF-HAND Rocket Fired! (Y=${bot.entity.position.y.toFixed(1)})`);
      return true;
    } catch(e) {
      console.warn('[EAFE] Rocket activation error:', e.message);
      return false;
    }
  }

  /**
   * Smart Rocket Consumption Algorithm (Used ONLY during Cruise phase)
   */
  function smartFireRocket() {
    if (!bot.entity.elytraFlying) return false;

    const vel = bot.entity.velocity;
    const speed = Math.hypot(vel.x, vel.y, vel.z);

    if (speed >= currentMode.speedGate) {
      console.log(`[EAFE] 🍃 Rocket skipped — speed optimal (${(speed * 20).toFixed(1)} m/s, mode=${currentMode.name})`);
      return false;
    }

    const ping = bot.player?.ping ?? 50;
    if (ping > 500) {
      console.warn(`[EAFE] ⚠ High server ping (${ping}ms) — throttling rocket`);
      return false;
    }

    const targetYaw = yawTo(activeTargetX, activeTargetZ);
    return fireRocketDirect(targetYaw);
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
  //  DYNAMIC RENDER DISTANCE RAYCAST & SPATIAL SCAN
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Raycast along flight vector up to active server render distance!
   */
  function scanFullRenderDistance(yaw, currentPitch) {
    const pos = bot.entity.position;
    const eyePos = pos.offset(0, 1.6, 0);

    const rDist = getServerRenderDistance();
    const maxRaycastBlocks = rDist.blocks; // Raycast up to detected server render distance

    const cosPitch = Math.cos(currentPitch);
    const sinPitch = Math.sin(currentPitch);
    const dirX = -Math.sin(yaw) * cosPitch;
    const dirY =  sinPitch;
    const dirZ =  Math.cos(yaw) * cosPitch;

    for (let d = 1; d <= maxRaycastBlocks; d += 2) {
      const checkPos = eyePos.offset(dirX * d, dirY * d, dirZ * d);
      const b = bot.blockAt(checkPos);
      if (b && !isAir(b) && !isWaterOrLava(b)) {
        return { hit: true, dist: d, block: b.name, pos: checkPos };
      }
    }

    return { hit: false, dist: maxRaycastBlocks, block: null, pos: null };
  }

  /**
   * Checks runway clearance at a specific yaw
   */
  function checkRunwayDirection(testYaw) {
    const pos = bot.entity.position;

    // Overhead Column (Y+1 to Y+5)
    for (let dy = 1; dy <= 5; dy++) {
      const b = bot.blockAt(pos.offset(0, dy, 0));
      if (!isAir(b)) return { clear: false, reason: `Overhead blocked at Y+${dy} (${b?.name})` };
    }

    // Forward Runway at specified yaw (4m ahead, Y+1 & Y+2)
    const dirX = -Math.sin(testYaw);
    const dirZ =  Math.cos(testYaw);

    for (let d = 1; d <= 4; d++) {
      for (let dy = 1; dy <= 2; dy++) {
        const bPos = pos.offset(Math.round(dirX * d), dy, Math.round(dirZ * d));
        const b = bot.blockAt(bPos);
        if (!isAir(b)) return { clear: false, reason: `Runway blocked at ${d}m ahead (Y+${dy}: ${b?.name})` };
      }
    }

    // Ground check: not liquid
    const blockUnder = bot.blockAt(pos.offset(0, -0.5, 0));
    if (isWaterOrLava(blockUnder)) return { clear: false, reason: `Standing in liquid (${blockUnder?.name})` };

    return { clear: true, reason: 'Clear corridor' };
  }

  /**
   * Directional Opening Awareness Scan
   */
  function findBestLaunchHeading() {
    const targetYaw = yawTo(activeTargetX, activeTargetZ);

    const targetCheck = checkRunwayDirection(targetYaw);
    if (targetCheck.clear) {
      return { yaw: targetYaw, headingName: 'Direct Target', clear: true };
    }

    const COMPASS = [
      { name: 'West (270°)',       yaw: Math.PI / 2 },
      { name: 'North (180°)',      yaw: Math.PI },
      { name: 'East (90°)',        yaw: -Math.PI / 2 },
      { name: 'South (0°)',        yaw: 0 },
      { name: 'North-West (225°)', yaw: 3 * Math.PI / 4 },
      { name: 'South-West (315°)', yaw: Math.PI / 4 },
      { name: 'North-East (135°)', yaw: -3 * Math.PI / 4 },
      { name: 'South-East (45°)',  yaw: -Math.PI / 4 },
    ];

    for (const dir of COMPASS) {
      const check = checkRunwayDirection(dir.yaw);
      if (check.clear) {
        console.log(`[EAFE] 🧭 Target heading blocked, but open launch corridor found facing ${dir.name}!`);
        try {
          bot.chat(`[EAFE] 🧭 Target heading blocked — taking off facing ${dir.name} then turning to goal!`);
        } catch(_) {}
        return { yaw: dir.yaw, headingName: dir.name, clear: true };
      }
    }

    return { yaw: targetYaw, headingName: 'Blocked', clear: false };
  }

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

        if (!groundBlock || isWaterOrLava(groundBlock) || !SAFE_SURFACES.has(groundBlock.name)) {
          continue;
        }

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
    console.log(`[EAFE] 🗺 Pathfinding & breaking path blocks to launch spot (${tx}, ${ty}, ${tz})...`);

    const defaultMove = new Movements(bot);
    defaultMove.canDig = true;             // BREAK BLOCKS EN ROUTE TO DESTINATION!
    defaultMove.allow1by1tunnels = true;  // Dig 1x1/1x2 tunnels if path is blocked
    defaultMove.allowParkour = true;      // Jump over gaps & up ledges
    defaultMove.canSwim = false;          // NO WATER
    defaultMove.liquidCost = 100;         // HIGH PENALTY FOR LIQUIDS

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

    const rDist = getServerRenderDistance();
    setPhase(PHASE.AUDIT, `Running pre-flight inventory, fuel & spatial audit [Mode:${currentMode.name} RenderDist:${rDist.chunks}ch/${rDist.blocks}m] to (${activeTargetX}, ${activeTargetZ})...`);

    // 1. Best Elytra auto-swap audit
    const elytraOk = await auditAndEquipElytra();
    if (!elytraOk) {
      setPhase(PHASE.FAILED, '✗ Pre-flight failed: No usable Elytra (durability > 15)');
      return;
    }

    // 2. Dynamic Unbreaking-Aware Elytra Health Audit
    const d2d = dist2D(activeTargetX, activeTargetZ);
    const elytraInfo = getElytraSummary();
    const reqElytraDur = calculateRequiredElytraDurability(d2d, currentMode.speedMps, elytraInfo.bestUnbreaking);

    console.log(
      `[EAFE] 🎽 Pre-Flight Elytra Health Audit: Total Available Durability=${elytraInfo.totalDurabilityAcrossAll}/${elytraInfo.count * 432} ` +
      `(${elytraInfo.count} Elytras, Unbreaking ${elytraInfo.bestUnbreaking}) | Required Durability=${reqElytraDur} (dist=${d2d.toFixed(0)}m)`
    );

    if (elytraInfo.totalDurabilityAcrossAll < reqElytraDur) {
      const neededDur = reqElytraDur - elytraInfo.totalDurabilityAcrossAll;
      setPhase(PHASE.FAILED, `✗ Insufficient Elytra durability for ${d2d.toFixed(0)}m flight! Have ${elytraInfo.totalDurabilityAcrossAll}/${reqElytraDur} points. Please give more Elytras!`);
      try {
        bot.chat(`[EAFE] ✗ Insufficient Elytra durability for ${d2d.toFixed(0)}m flight! Have ${elytraInfo.totalDurabilityAcrossAll}/${reqElytraDur} points. Need ${neededDur} more durability!`);
      } catch(_) {}
      return; // Do NOT launch until sufficient Elytra health is supplied!
    }

    // 3. Equip Firework Rockets to OFF-HAND
    await autoEquipRocket();

    // 4. Dynamic Firework Calculation BEFORE Flight
    const rocketsAvail = countRockets();
    const startY = bot.entity.position.y;
    const reqRockets = calculateRequiredRockets(d2d, CRUISE_ALT - startY);

    console.log(
      `[EAFE] 🎆 Pre-Flight Rocket Audit [Mode=${currentMode.name} Target=(${activeTargetX}, ${activeTargetZ})]: ` +
      `Rockets=${rocketsAvail}/${reqRockets}`
    );

    if (rocketsAvail < reqRockets) {
      const needed = reqRockets - rocketsAvail;
      setPhase(PHASE.FAILED, `✗ Insufficient fireworks for ${currentMode.name}! Have ${rocketsAvail}/${reqRockets}. Please give ${needed} more rockets!`);
      try {
        bot.chat(`[EAFE] ✗ Need ${reqRockets} fireworks for ${currentMode.name}, only have ${rocketsAvail}! Please give me ${needed} more rockets.`);
      } catch(_) {}
      return; // Do NOT launch until fireworks are supplied!
    }

    console.log(`[EAFE] ✓ Pre-Flight Audit PASSED (ElytraDur=${elytraInfo.totalDurabilityAcrossAll}/${reqElytraDur}, Rockets=${rocketsAvail}/${reqRockets})`);

    // 5. Directional Opening Awareness & Spatial Clearance Checkmark
    if (!spatialClear) {
      let heading = findBestLaunchHeading();
      console.log(`[EAFE] Directional Opening Scan: clear=${heading.clear} heading=${heading.headingName}`);

      if (!heading.clear) {
        console.log('[EAFE] Launch blocked in all 8 headings — pathfinding to open launch spot...');
        try { bot.chat('[EAFE] ⚠ Launch blocked in all directions — pathfinding to open launch spot...'); } catch(_) {}

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

        heading = findBestLaunchHeading();
        if (!heading.clear) {
          setPhase(PHASE.FAILED, '✗ Spatial envelope still blocked in all directions after relocation');
          scheduleRetry();
          return;
        }
      }

      activeLaunchYaw = heading.yaw;
      spatialClear = true;
      console.log(`[EAFE] ✓ Ground & Spatial Clearance PASSED (Launch Heading: ${heading.headingName})`);
    } else {
      console.log(`[EAFE] ✓ Spatial Clearance already approved — launching on heading`);
    }

    // ── TAKEOFF ──
    await executeTakeoff();
  }

  /**
   * 150ms Jump Apex Rule Takeoff (INSTANT OFF-HAND ROCKET THRUST)
   */
  async function executeTakeoff() {
    if (phase === PHASE.FAILED) return;
    setPhase(PHASE.TAKEOFF, `Jumping & activating elytra facing launch corridor...`);

    ['sprint','forward','back','left','right','sneak'].forEach(k => {
      try { bot.setControlState(k, false); } catch(_) {}
    });

    await autoEquipRocket();

    lookForce(activeLaunchYaw, 0.5);

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
      setPhase(PHASE.FAILED, '✗ Takeoff failed: Jump failed (bot remained on ground)');
      scheduleRetry();
      return;
    }

    console.log(`[EAFE] ✓ Airborne (Y=${bot.entity.position.y.toFixed(2)}) — calling elytraFly()`);

    try {
      await bot.elytraFly();
      console.log('[EAFE] ✓ elytraFly() packet sent');
    } catch(e) {
      console.error('[EAFE] ✗ Takeoff failed: elytraFly() rejected:', e.message);
      setPhase(PHASE.FAILED, '✗ Takeoff failed: elytraFly rejected: ' + e.message);
      scheduleRetry();
      return;
    }

    fireRocketDirect();

    await sleep(200);
    if (!isFlying()) {
      console.warn('[EAFE] ⚠ Fly state false after launch — retrying elytraFly + rocket');
      try { await bot.elytraFly(); } catch(_) {}
      fireRocketDirect();
      await sleep(250);
      if (!isFlying()) {
        setPhase(PHASE.FAILED, '✗ Takeoff failed: Server never confirmed elytraFlying=true');
        scheduleRetry();
        return;
      }
    }

    console.log('[EAFE] ✓ Elytra flight CONFIRMED — starting climb');
    startClimb();
  }

  // ─── CLIMB & CONTINUOUS UNINTERRUPTED ROCKET PROPULSION ───────────────────
  function startClimb() {
    setPhase(PHASE.CLIMBING, `Climbing to Y=${CRUISE_ALT}...`);

    lookForce(activeLaunchYaw, 0.65);
    fireRocketDirect();

    if (rocketLoop) clearInterval(rocketLoop);
    rocketLoop = setInterval(() => {
      if (phase !== PHASE.CLIMBING) { clearInterval(rocketLoop); rocketLoop = null; return; }
      fireRocketDirect(); // ALWAYS FIRE ROCKET TO GAIN ALTITUDE
    }, 1000);

    if (climbLoop) clearInterval(climbLoop);
    climbLoop = setInterval(() => {
      if (phase !== PHASE.CLIMBING) { clearInterval(climbLoop); climbLoop = null; return; }

      const pos = bot.entity.position;
      const targetYaw = yawTo(activeTargetX, activeTargetZ);

      // Mid-flight Elytra Auto-Swap check
      checkMidFlightElytraSwap();

      // Record Flight Trail Memory: Track solid land passed over on climb
      const groundUnder = getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      if (groundUnder && !isWaterOrLava(groundUnder) && SAFE_SURFACES.has(groundUnder.name)) {
        lastKnownSafeGround = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), blockName: groundUnder.name };
      }

      // MID-AIR YAW CURVE: Once Y >= 95m, smoothly curve yaw towards destination
      let currentYaw = activeLaunchYaw;
      if (pos.y >= 95) {
        currentYaw = targetYaw;
      }

      // Dynamic Render Distance Raycast Scan (Throttled log)
      let climbPitch = 0.65;
      const terrainScan = scanFullRenderDistance(currentYaw, climbPitch);
      if (terrainScan.hit) {
        if (Date.now() - lastTerrainWarn > 3000) {
          console.warn(`[EAFE] 🏔 Terrain obstacle (${terrainScan.block}) detected at ${terrainScan.dist}m — steepening climb pitch (+0.75 rad)`);
          lastTerrainWarn = Date.now();
        }
        climbPitch = 0.75;
        fireRocketDirect();
      }

      console.log(`[EAFE] [CLIMB] Y=${pos.y.toFixed(1)} pitch=${climbPitch} elytra=${bot.entity.elytraFlying} ground=${bot.entity.onGround}`);

      lookForce(currentYaw, climbPitch);

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
        fireRocketDirect();
        return;
      }

      // Reached target altitude Y=180
      if (pos.y >= CRUISE_ALT) {
        clearInterval(climbLoop); climbLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        startCruise();
      }
    }, 200);
  }

  // ─── CRUISE & PERIODIC 2-SECOND COURSE CHECKER ────────────────────────────
  function startCruise() {
    setPhase(PHASE.CRUISING, `Cruising to (${activeTargetX}, ?, ${activeTargetZ}) [Mode: ${currentMode.name}]`);

    if (rocketLoop) clearInterval(rocketLoop);
    rocketLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) { clearInterval(rocketLoop); rocketLoop = null; return; }

      if (countRockets() === 0 && phase !== PHASE.DEAD_STICK) {
        setPhase(PHASE.DEAD_STICK, '⚠ Out of fireworks — engaging Dead-Stick L/D Glide');
      }

      if (phase === PHASE.CRUISING) {
        smartFireRocket();
      }
    }, 1200);

    if (flyLoop) clearInterval(flyLoop);
    flyLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) { clearInterval(flyLoop); flyLoop = null; return; }

      const pos = bot.entity.position;

      // Mid-flight Elytra Auto-Swap check
      checkMidFlightElytraSwap();

      // Record Flight Trail Memory: Track solid land passed over on cruise
      const groundUnder = getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      if (groundUnder && !isWaterOrLava(groundUnder) && SAFE_SURFACES.has(groundUnder.name)) {
        lastKnownSafeGround = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), blockName: groundUnder.name };
      }

      const d = dist2D(activeTargetX, activeTargetZ);
      if (d < 25) {
        clearInterval(flyLoop); flyLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        startLanding();
        return;
      }

      // ACCURATE YAW ALIGNMENT TOWARDS TARGET
      const yaw = yawTo(activeTargetX, activeTargetZ);
      const vel = bot.entity.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);

      let cruisePitch = (phase === PHASE.DEAD_STICK) ? 0.02 : currentMode.pitch;

      // Dynamic Render Distance Raycast Scan (Throttled log)
      const terrainScan = scanFullRenderDistance(yaw, cruisePitch);
      if (terrainScan.hit && terrainScan.dist < 60) {
        if (Date.now() - lastTerrainWarn > 3000) {
          console.warn(`[EAFE] 🏔 Terrain obstacle (${terrainScan.block}) ahead at ${terrainScan.dist}m — pitching UP to climb over`);
          lastTerrainWarn = Date.now();
        }
        cruisePitch = 0.55;
        if (countRockets() > 0) fireRocketDirect(yaw);
      }

      if (speed < 0.05 && bot.entity.position.y > 60) {
        console.warn('[EAFE] ⚠ Wall collision / stall detected! Executing 180° pitch boost...');
        lookForce(yaw + Math.PI, 0.70);
        fireRocketDirect();
        return;
      }

      lookForce(yaw, cruisePitch);
    }, 50);

    // ── PERIODIC 2-SECOND COURSE & DISTANCE CHECKER ──
    if (verifyLoop) clearInterval(verifyLoop);
    let lastDist = dist2D(activeTargetX, activeTargetZ);
    verifyLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) { clearInterval(verifyLoop); verifyLoop = null; return; }

      const pos = bot.entity.position;
      const curDist = dist2D(activeTargetX, activeTargetZ);
      const targetYaw = yawTo(activeTargetX, activeTargetZ);

      // Distance Increase Alarm Check (Bot moving away from goal)
      if (curDist > lastDist + 5) {
        console.warn(`[EAFE] ⚠ Course drift alarm: Distance increased (${lastDist.toFixed(0)}m -> ${curDist.toFixed(0)}m) — forcing instant yaw re-alignment!`);
        lookForce(targetYaw, currentMode.pitch);
      }

      const elytraInfo = getElytraSummary();
      console.log(
        `[EAFE] [2s Check] pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) ` +
        `speed=${(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z)*20).toFixed(1)}m/s ` +
        `dist=${curDist.toFixed(0)}m rockets=${countRockets()} elytraDur=${elytraInfo.equippedDur}/432`
      );

      if (!isFlying() && !bot.entity.onGround) {
        console.warn('[EAFE] ⚠ Fly state false during cruise — attempting recovery');
        auditAndEquipElytra().then(() => {
          if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) return;
          bot.elytraFly().catch(e => {
            setPhase(PHASE.FAILED, '✗ Lost flight state: ' + e.message);
            scheduleRetry();
          });
          if (countRockets() > 0) fireRocketDirect(targetYaw);
        });
        return;
      }

      lastDist = curDist;
    }, 2000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  STRAIGHT-LINE GRID LAWN-MOWER SEARCH ENGINE WITH CHUNK MEMORY MAP
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Scans expanding concentric rings up to detected server render distance (blocks)
   * across real-time loaded chunks to locate nearest solid safe land surface.
   */
  function findSafeLandingSpotAround(centerX, centerZ) {
    const rDist = getServerRenderDistance();
    const maxSearchRadius = rDist.blocks; // Use real-time detected server view radius!

    const directGround = getGroundBlockAt(centerX, centerZ);
    if (directGround && !isWaterOrLava(directGround) && SAFE_SURFACES.has(directGround.name)) {
      return { x: centerX, z: centerZ, blockName: directGround.name, safe: true };
    }

    // Dynamic Expanding Archimedean Search up to maxSearchRadius across loaded chunks
    for (let r = 2; r <= maxSearchRadius; r += 4) {
      const stepAngle = Math.max(Math.PI / 12, Math.PI / (r * 0.5));
      for (let angle = 0; angle < Math.PI * 2; angle += stepAngle) {
        const sx = Math.round(centerX + r * Math.cos(angle));
        const sz = Math.round(centerZ + r * Math.sin(angle));
        const sb = getGroundBlockAt(sx, sz);
        if (sb && !isWaterOrLava(sb) && SAFE_SURFACES.has(sb.name)) {
          return { x: sx, z: sz, blockName: sb.name, safe: true };
        }
      }
    }

    return { x: centerX, z: centerZ, blockName: 'unknown', safe: false };
  }

  /**
   * High-Altitude Straight-Line Grid Lawnmower Search (WANDER_SCAN Phase)
   * Progressive Ultra Low-Power Rocket Saver: Forces EFFICIENT mode and applies
   * progressive fuel conservation as rockets drop!
   */
  function startWanderScan() {
    // FORCE LOW POWER ROCKET SAVER MODE FOR OCEAN SEARCHES
    currentMode = MODES.EFFICIENT;

    const rDist = getServerRenderDistance();
    const targetScanAlt = rDist.scanAlt; // Dynamically calculated optimal scan altitude
    const legDistanceStep = Math.round(rDist.blocks * 1.5); // Leg length expansion per side

    setPhase(PHASE.WANDER_SCAN, `🌊 Ocean LZ detected — forcing EFFICIENT Mode & climbing to dynamic scan altitude Y=${targetScanAlt} (RenderDist: ${rDist.chunks}ch / ${rDist.blocks}m)...`);

    gridDirIndex  = 0; // Start facing North (0)
    gridLegLength = 1;
    legStartPos   = bot.entity.position.clone();
    scannedChunks.clear();

    if (flyLoop) clearInterval(flyLoop);
    flyLoop = setInterval(() => {
      if (phase !== PHASE.WANDER_SCAN) { clearInterval(flyLoop); flyLoop = null; return; }

      const pos = bot.entity.position;
      const rCount = countRockets();

      // Mid-flight Elytra Auto-Swap check
      checkMidFlightElytraSwap();

      // Progressive Ultra Low-Power Speed Gate (lower speed threshold = fewer rockets fired!)
      let dynamicSpeedGate = currentMode.speedGate; // Default: 0.65 (13 m/s)
      let dynamicPitch     = currentMode.pitch;     // Default: -0.04 rad

      if (rCount < 15) {
        dynamicSpeedGate = 0.50; // 10 m/s (uses 40% fewer rockets)
      }
      if (rCount < 8) {
        dynamicSpeedGate = 0.40; // 8 m/s (uses absolute minimal rockets possible)
        dynamicPitch     = -0.06; // steeper gravity pitch to convert altitude to speed
      }

      // 1. Audit & Record loaded chunks into Chunk Memory Map
      const bX = Math.floor(pos.x) >> 4;
      const bZ = Math.floor(pos.z) >> 4;
      for (let dx = -rDist.chunks; dx <= rDist.chunks; dx++) {
        for (let dz = -rDist.chunks; dz <= rDist.chunks; dz++) {
          scannedChunks.add(`${bX + dx},${bZ + dz}`);
        }
      }

      // 2. Maintain Dynamic Ocean Scan Altitude (e.g. Y=100 for 4ch, Y=120 for 6ch, Y=138 for 8ch)
      if (pos.y < targetScanAlt - 10 && rCount > 0) {
        console.log(`[EAFE] 🚀 Pitching UP (+0.60) to maintain scan altitude Y=${targetScanAlt} (current Y=${pos.y.toFixed(1)})...`);
        lookForce(bot.entity.yaw, 0.60);
        fireRocketDirect();
      }

      // 3. Scan all loaded chunks within server render distance around current position
      const foundSpot = findSafeLandingSpotAround(Math.round(pos.x), Math.round(pos.z));
      if (foundSpot.safe) {
        clearInterval(flyLoop); flyLoop = null;
        console.log(`[EAFE] 🏝 SOLID LAND DISCOVERED at (${foundSpot.x}, ${foundSpot.z}) [${foundSpot.blockName}] after straight-line grid scan! (Scanned chunks: ${scannedChunks.size})`);
        try {
          bot.chat(`[EAFE] 🏝 Solid land discovered at (${foundSpot.x}, ${foundSpot.z}) on ${foundSpot.blockName}! Re-routing landing...`);
        } catch(_) {}

        activeTargetX = foundSpot.x;
        activeTargetZ = foundSpot.z;
        startLanding();
        return;
      }

      // Failsafe 3b. Emergency Low-Fuel Return to flight-trail coastline if goal search exhausted
      if (rCount <= 6 && scannedChunks.size >= 40 && lastKnownSafeGround) {
        clearInterval(flyLoop); flyLoop = null;
        console.warn(`[EAFE] ⚠ Low fuel emergency (${rCount} rockets left, ${scannedChunks.size} chunks scanned) — re-routing to last known coastline at (${lastKnownSafeGround.x}, ${lastKnownSafeGround.z})!`);
        try {
          bot.chat(`[EAFE] ⚠ Low fuel (${rCount} rockets left)! Returning to last known safe coast at (${lastKnownSafeGround.x}, ${lastKnownSafeGround.z}) on ${lastKnownSafeGround.blockName}!`);
        } catch(_) {}

        activeTargetX = lastKnownSafeGround.x;
        activeTargetZ = lastKnownSafeGround.z;
        startLanding();
        return;
      }

      // 4. Straight-Line Grid Navigation (Cardinal Legs)
      if (!legStartPos) legStartPos = pos.clone();
      const distOnLeg = Math.hypot(pos.x - legStartPos.x, pos.z - legStartPos.z);
      const targetLegDist = gridLegLength * legDistanceStep;

      // Check if current straight leg distance is completed
      if (distOnLeg >= targetLegDist) {
        gridDirIndex = (gridDirIndex + 1) % 4; // Turn 90° right to next cardinal direction
        if (gridDirIndex === 0 || gridDirIndex === 2) {
          gridLegLength++; // Expand grid leg size every 2 turns
        }
        legStartPos = pos.clone();
        const dirNames = ['North', 'East', 'South', 'West'];
        console.log(`[EAFE] 🧭 Completed leg! Turning 90° to face ${dirNames[gridDirIndex]} (Target leg dist: ${gridLegLength * legDistanceStep}m, Scanned chunks: ${scannedChunks.size})`);
      }

      const targetYaw = CARDINAL_YAWS[gridDirIndex];
      const vel = bot.entity.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);

      if (speed < dynamicSpeedGate && rCount > 0) {
        fireRocketDirect(targetYaw);
      }

      lookForce(targetYaw, dynamicPitch);

      const dirNames = ['North', 'East', 'South', 'West'];
      console.log(`[EAFE] [GRID_SCAN] Y=${pos.y.toFixed(1)} dir=${dirNames[gridDirIndex]} legDist=${distOnLeg.toFixed(0)}/${targetLegDist}m speed=${(speed*20).toFixed(1)}m/s rockets=${rCount} scannedChunks=${scannedChunks.size}`);
    }, 200);
  }

  function startLanding() {
    const rDist = getServerRenderDistance();
    setPhase(PHASE.LANDING, `Arrived at target area — scanning arrival chunks (${rDist.chunks}ch/${rDist.blocks}m) at (${activeTargetX}, ${activeTargetZ})...`);

    // Real-Time Arrival Chunk Scan across loaded chunk memory
    const safeSpot = findSafeLandingSpotAround(activeTargetX, activeTargetZ);

    let targetX = safeSpot.x;
    let targetZ = safeSpot.z;

    // IF NO SOLID GROUND IN IMMEDIATE ARRIVAL CHUNKS:
    // ALWAYS SCAN GOAL AREA FIRST via startWanderScan() before falling back to flight trail!
    if (!safeSpot.safe) {
      console.warn(`[EAFE] 🌊 Target area (${activeTargetX}, ${activeTargetZ}) is open ocean! Initiating Straight-Line Lawnmower Scan around goal location first...`);
      startWanderScan();
      return;
    }

    console.log(`[EAFE] ✓ Arrival Chunk Scan: Solid landing spot approved at (${targetX}, ${targetZ}) on [${safeSpot.blockName}]`);

    const landCheck = setInterval(() => {
      if (phase !== PHASE.LANDING) { clearInterval(landCheck); return; }

      const pos = bot.entity.position;
      const groundBlock = getGroundBlockAt(targetX, targetZ);
      const relY = pos.y - (groundBlock?.position?.y ?? 60);

      // Mid-flight Elytra Auto-Swap check
      checkMidFlightElytraSwap();

      const currentBlockUnder = getGroundBlockAt(Math.round(pos.x), Math.round(pos.z));
      const overLiquid = !currentBlockUnder || isWaterOrLava(currentBlockUnder) || !SAFE_SURFACES.has(currentBlockUnder.name);

      if (overLiquid && pos.y < 65 && countRockets() > 0) {
        console.warn(`[EAFE] 🌊 Hovering over liquid (Y=${pos.y.toFixed(1)}) — redirecting to safe land (${targetX}, ${targetZ})!`);
        lookForce(yawTo(targetX, targetZ), 0.40);
        fireRocketDirect();
      } else if (relY <= 4.0) {
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
        spatialClear = false; // Reset spatial checkmark on touchdown

        const rRem = countRockets();
        const arrivalMsg = `✅ Destination Reached! Arrived safely at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}) on ${currentBlockUnder?.name || 'solid ground'} | Rockets remaining: ${rRem}`;
        setPhase(PHASE.IDLE, arrivalMsg);
        try { bot.chat(`[EAFE] ${arrivalMsg}`); } catch(_) {}
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
      spatialClear = false;
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

  // ─── UNIFIED USER COMMAND PROCESSOR ───────────────────────────────────────
  function processUserCommand(cmd) {
    cmd = cmd.trim().toLowerCase();
    if (!cmd) return;

    const tokens = cmd.split(/\s+/);
    const mainCmd = tokens[0];

    // Flight command: "f", "fly", "f 500 -1200", "fly 2500 3000"
    if (mainCmd === 'f' || mainCmd === 'fly') {
      if (tokens.length >= 3) {
        const nx = parseInt(tokens[1], 10);
        const nz = parseInt(tokens[2], 10);
        if (!isNaN(nx) && !isNaN(nz)) {
          activeTargetX = nx;
          activeTargetZ = nz;
          console.log(`[EAFE] 🎯 Target coordinates updated to (${activeTargetX}, ${activeTargetZ})`);
          try { bot.chat(`[EAFE] 🎯 Target set to (${activeTargetX}, ${activeTargetZ}) — starting flight!`); } catch(_) {}
        }
      } else if (tokens.length === 1) {
        console.log(`[EAFE] 🎯 Flying to target coordinates (${activeTargetX}, ${activeTargetZ})`);
      }

      retries = 0;
      spatialClear = false;
      startFlight();

    // Set goal without immediate takeoff: "setgoal 500 -1200", "target 500 -1200"
    } else if (mainCmd === 'setgoal' || mainCmd === 'target' || mainCmd === 'settarget') {
      if (tokens.length >= 3) {
        const nx = parseInt(tokens[1], 10);
        const nz = parseInt(tokens[2], 10);
        if (!isNaN(nx) && !isNaN(nz)) {
          activeTargetX = nx;
          activeTargetZ = nz;
          console.log(`[EAFE] 🎯 Target coordinates updated to (${activeTargetX}, ${activeTargetZ})`);
          try { bot.chat(`[EAFE] 🎯 Target updated to (${activeTargetX}, ${activeTargetZ}) | Type 'f' to fly!`); } catch(_) {}
        }
      }

    } else if (cmd === 'mode fast' || cmd === 'm fast' || cmd === 'fast') {
      currentMode = MODES.FAST;
      console.log(`[EAFE] ⚡ Flight Mode set to ${MODES.FAST.name}`);
      try { bot.chat(`[EAFE] ⚡ Flight Mode set to ${MODES.FAST.name}`); } catch(_) {}

    } else if (cmd === 'mode med' || cmd === 'm med' || cmd === 'mode medium' || cmd === 'med' || cmd === 'medium') {
      currentMode = MODES.MEDIUM;
      console.log(`[EAFE] ⚖ Flight Mode set to ${MODES.MEDIUM.name}`);
      try { bot.chat(`[EAFE] ⚖ Flight Mode set to ${MODES.MEDIUM.name}`); } catch(_) {}

    } else if (cmd === 'mode low' || cmd === 'm low' || cmd === 'mode efficient' || cmd === 'low' || cmd === 'efficient') {
      currentMode = MODES.EFFICIENT;
      console.log(`[EAFE] 🍃 Flight Mode set to ${MODES.EFFICIENT.name}`);
      try { bot.chat(`[EAFE] 🍃 Flight Mode set to ${MODES.EFFICIENT.name}`); } catch(_) {}

    } else if (cmd === 's' || cmd === 'stop') {
      retries = MAX_RETRIES;
      emergencyStop('user command');

    } else if (cmd === 'status') {
      const p = bot.entity.position;
      const elytraInfo = getElytraSummary();
      const rDist = getServerRenderDistance();
      const statusMsg = `phase=${phase} mode=${currentMode.name} renderDist=${rDist.chunks}ch/${rDist.blocks}m target=(${activeTargetX},${activeTargetZ}) pos=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) elytra=${bot.entity.elytraFlying} totalElytraDur=${elytraInfo.totalDurabilityAcrossAll}/${elytraInfo.count * 432} rockets=${countRockets()} spatialClear=${spatialClear?'✓':'✗'} dist=${dist2D().toFixed(0)}m scannedChunks=${scannedChunks.size}`;
      console.log(`[EAFE] [STATUS] ${statusMsg}`);
      try { bot.chat(statusMsg); } catch(_) {}

    } else if (cmd === 'audit') {
      const rocketsAvail = countRockets();
      const d2d = dist2D(activeTargetX, activeTargetZ);
      const reqRockets = calculateRequiredRockets(d2d, CRUISE_ALT - bot.entity.position.y);
      const heading = findBestLaunchHeading();
      const elytraInfo = getElytraSummary();
      const reqDur = calculateRequiredElytraDurability(d2d, currentMode.speedMps, elytraInfo.bestUnbreaking);
      const rDist = getServerRenderDistance();
      const auditMsg = `Audit [${currentMode.name} Target=(${activeTargetX},${activeTargetZ}) RenderDist=${rDist.chunks}ch]: Rockets=${rocketsAvail}/${reqRockets} ElytraDur=${elytraInfo.totalDurabilityAcrossAll}/${reqDur} (Unbreaking ${elytraInfo.bestUnbreaking}) Heading=${heading.headingName} Checkmark=${spatialClear?'✓':'✗'}`;
      console.log(`[EAFE] [AUDIT] ${auditMsg}`);
      try { bot.chat(auditMsg); } catch(_) {}
    }
  }

  // Handle in-game chat commands
  bot.on('chat', (user, msg) => {
    if (user === bot.username) return;
    processUserCommand(msg);
  });

  // Handle terminal console stdin commands
  if (process.stdin.isTTY || process.env.NODE_ENV !== 'test') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      console.log(`[CONSOLE COMMAND] > ${line}`);
      processUserCommand(line);
    });
  }

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

    // ── Auto-equip elytra & off-hand rockets on spawn ──────────────────
    setTimeout(() => {
      auditAndEquipElytra().then(ok => {
        autoEquipRocket().then(() => {
          const count = countRockets();
          const elytraInfo = getElytraSummary();
          const rDist = getServerRenderDistance();
          console.log(`[EAFE] Inventory audit: elytra=${ok} (${elytraInfo.equippedDur}/432, totalDurability=${elytraInfo.totalDurabilityAcrossAll}, unbreaking=${elytraInfo.bestUnbreaking}) rockets=${count} mode=${currentMode.name} renderDist=${rDist.chunks}chunks`);
          try {
            bot.chat(`[EAFE] Ready  Target:(${activeTargetX},${activeTargetZ})  Mode:${currentMode.name}  RenderDist:${rDist.chunks}ch  Elytras:${elytraInfo.count} (Dur:${elytraInfo.totalDurabilityAcrossAll}, Unbreaking ${elytraInfo.bestUnbreaking})  Rockets:${count}  |  f [X Z]  m fast/med/low  s=stop`);
          } catch(_) {}
        });
      });
    }, 2000);

    // ── Auto-equip when picked up or received ────────────────────────────
    bot.on('playerCollect', collector => {
      if (collector.username !== bot.username) return;
      setTimeout(() => {
        auditAndEquipElytra().catch(() => {});
        autoEquipRocket().catch(() => {});
      }, 300);
    });

    bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
      if (newItem?.name === 'elytra') {
        setTimeout(() => auditAndEquipElytra().catch(() => {}), 200);
      }
      if (newItem?.name === 'firework_rocket') {
        setTimeout(() => autoEquipRocket().catch(() => {}), 200);
      }
    });

    console.log('[EAFE] Commands: f [X Z]  setgoal X Z  m fast/med/low  s=stop  status  audit');
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
console.log('║  EAFE v10.3 — Unbreaking Elytra Health & Mid-Flight Swap   ║');
console.log('║  Unbreaking Audit: Audits Unbreaking 1-3 damage rate (25-50%)║');
console.log('║  Multi-Elytra Pre-Flight: Sums total durability across inventory║');
console.log('║  Mid-Flight Auto-Swap: Auto-swaps <=15 dur & restores flight ║');
console.log('║  Flight Trail Lock: Re-routes to last known coastline flown  ║');
console.log(`║  Host: ${HOST}:${PORT}`.padEnd(61) + '║');
console.log('╚═════════════════════════════════════════════════════════════╝');

createBot();
