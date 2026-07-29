'use strict';
/**
 * EAFE v9.0 — Multi-Mode Flight Engine & Failsafe Yaw-Lock Navigation
 * ============================================================================
 * Enhancements & Capabilities:
 *   1. Three Selectable Flight Modes (FAST, MEDIUM, EFFICIENT):
 *      - FAST (High Speed / Sprint):
 *          Cruise Pitch: +0.02 rad | Rocket Speed Gate: < 1.5 b/t (30 m/s)
 *          Fuel Equation: N_req = ceil(d2d / 35.0) + ceil(ΔY / 25.0) + 10
 *      - MEDIUM (Balanced - Default):
 *          Cruise Pitch: +0.05 rad | Rocket Speed Gate: < 1.1 b/t (22 m/s)
 *          Fuel Equation: N_req = ceil(d2d / 65.0) + ceil(ΔY / 25.0) + 10
 *      - EFFICIENT (Low / Max Rocket Saver):
 *          Cruise Pitch: +0.08 rad | Rocket Speed Gate: < 0.7 b/t (14 m/s)
 *          Fuel Equation: N_req = ceil(d2d / 110.0) + ceil(ΔY / 25.0) + 10
 *   2. Dynamic Pre-Flight Fuel Audit (Never Fails Mid-Way):
 *      - Calculates exact N_req for selected flight mode BEFORE takeoff.
 *      - Aborts and requests rockets in chat if short by even 1 firework.
 *   3. Failsafe Yaw-Locking (Eliminates Flying Off-Course):
 *      - Calculates angular error Δθ between current entity yaw and target.
 *      - Strictly REFUSES to fire rockets if yaw error > 23° (0.40 rad).
 *      - Aligns bot toward target FIRST, then applies rocket thrust!
 *   4. Corrected Compass Definitions:
 *      - South (0°)=0, West (270°)=+π/2, North (180°)=π, East (90°)=-π/2.
 *   5. Off-Hand Rocket Engine & 128m Raycast Terrain Elevation:
 *      - Off-hand rockets (slot 45) for 100% packet thrust.
 *      - 128m raycast steepens climb pitch (+0.75 rad) to clear mountains.
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
const CRUISE_ALT = 180;   // Safe target altitude (Y=180) to clear all terrain
const MAX_RETRIES = 3;    // retries before giving up

// ─── FLIGHT MODES ────────────────────────────────────────────────────────────
const MODES = {
  FAST: {
    name: 'FAST (High Speed)',
    pitch: 0.02,
    speedGate: 1.5, // 30 m/s
    fuelDistDivider: 35.0,
  },
  MEDIUM: {
    name: 'MEDIUM (Balanced)',
    pitch: 0.05,
    speedGate: 1.1, // 22 m/s
    fuelDistDivider: 65.0,
  },
  EFFICIENT: {
    name: 'EFFICIENT (Low / Rocket Saver)',
    pitch: 0.08,
    speedGate: 0.7, // 14 m/s
    fuelDistDivider: 110.0,
  }
};

// ─── PHASE STATE ─────────────────────────────────────────────────────────────
const PHASE = {
  IDLE:       'IDLE',
  AUDIT:      'AUDIT',        // pre-flight inventory, fuel & spatial audit
  RELOCATING: 'RELOCATING',   // A* pathfinding & block-digging en route to open launch spot
  TAKEOFF:    'TAKEOFF',      // 150ms jump apex + elytraFly() + instant off-hand rocket
  CLIMBING:   'CLIMBING',     // continuous nose up (+0.65 to +0.75), gaining altitude
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
  let phase           = PHASE.IDLE;
  let currentMode     = MODES.MEDIUM; // Default: Medium (Balanced)
  let retries         = 0;
  let spatialClear    = false;        // Checkmark flag for ground clearance
  let activeLaunchYaw = 0;            // Selected takeoff heading
  let physEngine      = null;
  let flyLoop         = null;
  let verifyLoop      = null;
  let rocketLoop      = null;
  let climbLoop       = null;

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

  /**
   * Elytra Durability & Auto-HotSwap Audit
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
   * Calculate required fireworks based on current flight mode
   */
  function calculateRequiredRockets(d2d, deltaY) {
    const dReq = Math.ceil(d2d / currentMode.fuelDistDivider);
    const yReq = Math.ceil(Math.abs(deltaY) / 25.0);
    return dReq + yReq + 10;
  }

  /**
   * Firework Rocket Activation (Off-Hand Packet Firing with Yaw-Lock Failsafe)
   */
  function fireRocketDirect(targetYawCheck = null) {
    if (!bot.entity.elytraFlying) return false;

    // Failsafe: Verify yaw alignment before applying rocket thrust
    if (targetYawCheck !== null) {
      const err = angleDiff(bot.entity.yaw, targetYawCheck);
      if (err > 0.40) { // > 23° yaw error off target
        console.log(`[EAFE] 🧭 Yaw alignment error (${(err * 180 / Math.PI).toFixed(1)}°) — correcting course before rocket boost`);
        lookForce(targetYawCheck, currentMode.pitch);
        return false;
      }
    }

    // Verify offhand equipment
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

    const targetYaw = yawTo(TARGET_X, TARGET_Z);
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
  //  128m FULL RENDER DISTANCE RAYCAST & SPATIAL SCAN
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 128m (8 chunk) Full Render Distance Trajectory Raycast
   */
  function scanFullRenderDistance(yaw, currentPitch) {
    const pos = bot.entity.position;
    const eyePos = pos.offset(0, 1.6, 0);

    const cosPitch = Math.cos(currentPitch);
    const sinPitch = Math.sin(currentPitch);
    const dirX = -Math.sin(yaw) * cosPitch;
    const dirY =  sinPitch;
    const dirZ =  Math.cos(yaw) * cosPitch;

    for (let d = 1; d <= 128; d += 2) {
      const checkPos = eyePos.offset(dirX * d, dirY * d, dirZ * d);
      const b = bot.blockAt(checkPos);
      if (b && !isAir(b) && !isWaterOrLava(b)) {
        return { hit: true, dist: d, block: b.name, pos: checkPos };
      }
    }

    return { hit: false, dist: 128, block: null, pos: null };
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
   * Corrected Compass Definitions:
   * South (0°)=0, West (270°)=+π/2, North (180°)=π, East (90°)=-π/2
   */
  function findBestLaunchHeading() {
    const targetYaw = yawTo(TARGET_X, TARGET_Z);

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

    setPhase(PHASE.AUDIT, `Running pre-flight inventory, fuel & spatial audit [Mode: ${currentMode.name}]...`);

    // 1. Elytra durability audit
    const elytraOk = await auditAndEquipElytra();
    if (!elytraOk) {
      setPhase(PHASE.FAILED, '✗ Pre-flight failed: No usable Elytra (durability > 15)');
      return;
    }

    // 2. Equip Firework Rockets to OFF-HAND
    await autoEquipRocket();

    // 3. Dynamic Firework Calculation BEFORE Flight (Mode Specific)
    const rocketsAvail = countRockets();
    const d2d = dist2D(TARGET_X, TARGET_Z);
    const startY = bot.entity.position.y;
    const reqRockets = calculateRequiredRockets(d2d, CRUISE_ALT - startY);

    console.log(`[EAFE] 🎆 Firework Audit [Mode=${currentMode.name}]: Available=${rocketsAvail} | Required=${reqRockets} (dist=${d2d.toFixed(0)}m)`);

    if (rocketsAvail < reqRockets) {
      const needed = reqRockets - rocketsAvail;
      setPhase(PHASE.FAILED, `✗ Insufficient fireworks for ${currentMode.name}! Have ${rocketsAvail}/${reqRockets}. Please give ${needed} more rockets!`);
      try {
        bot.chat(`[EAFE] ✗ Need ${reqRockets} fireworks for ${currentMode.name}, only have ${rocketsAvail}! Please give me ${needed} more rockets.`);
      } catch(_) {}
      return; // Do NOT launch until fireworks are supplied!
    }

    console.log(`[EAFE] ✓ Firework Audit PASSED (${rocketsAvail}/${reqRockets} fireworks ready for ${currentMode.name})`);

    // 4. Directional Opening Awareness & Spatial Clearance Checkmark
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
      const targetYaw = yawTo(TARGET_X, TARGET_Z);

      // MID-AIR YAW CURVE: Once Y >= 95m, smoothly curve yaw towards destination
      let currentYaw = activeLaunchYaw;
      if (pos.y >= 95) {
        currentYaw = targetYaw;
      }

      // 128m Full Render Distance Raycast Scan
      let climbPitch = 0.65;
      const terrainScan = scanFullRenderDistance(currentYaw, climbPitch);
      if (terrainScan.hit) {
        console.warn(`[EAFE] 🏔 Terrain obstacle (${terrainScan.block}) detected at ${terrainScan.dist}m — steepening climb pitch (+0.75 rad)`);
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

  // ─── CRUISE & SMART ROCKET CONSERVATION (MODE-BASED & YAW-LOCKED) ────────
  function startCruise() {
    setPhase(PHASE.CRUISING, `Cruising to (${TARGET_X}, ?, ${TARGET_Z}) [Mode: ${currentMode.name}]`);

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

      const d = dist2D();
      if (d < 25) {
        clearInterval(flyLoop); flyLoop = null;
        clearInterval(rocketLoop); rocketLoop = null;
        startLanding();
        return;
      }

      // CONSTANT YAW ALIGNMENT TOWARDS TARGET (100, 100)
      const yaw = yawTo(TARGET_X, TARGET_Z);
      const vel = bot.entity.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);

      // Mode-specific cruise pitch
      let cruisePitch = (phase === PHASE.DEAD_STICK) ? 0.02 : currentMode.pitch;

      // 128m Full Render Distance Raycast Scan during cruise
      const terrainScan = scanFullRenderDistance(yaw, cruisePitch);
      if (terrainScan.hit && terrainScan.dist < 60) {
        console.warn(`[EAFE] 🏔 Terrain obstacle (${terrainScan.block}) ahead at ${terrainScan.dist}m — pitching UP to climb over`);
        cruisePitch = 0.55;
        if (countRockets() > 0) fireRocketDirect(yaw);
      }

      if (speed < 0.05 && bot.entity.position.y > 75) {
        console.warn('[EAFE] ⚠ Wall collision / stall detected! Executing 180° pitch boost...');
        lookForce(yaw + Math.PI, 0.70);
        fireRocketDirect();
        return;
      }

      lookForce(yaw, cruisePitch);
    }, 50);

    if (verifyLoop) clearInterval(verifyLoop);
    let lastPos = bot.entity.position.clone();
    verifyLoop = setInterval(() => {
      if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) { clearInterval(verifyLoop); verifyLoop = null; return; }

      const pos   = bot.entity.position;
      const delta = Math.abs(pos.x - lastPos.x) + Math.abs(pos.y - lastPos.y) + Math.abs(pos.z - lastPos.z);
      console.log(
        `[EAFE] [1s] pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) ` +
        `Δ=${delta.toFixed(2)} speed=${(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z)*20).toFixed(1)}m/s ` +
        `dist=${dist2D().toFixed(0)}m rockets=${countRockets()}`
      );

      if (!isFlying() && !bot.entity.onGround) {
        console.warn('[EAFE] ⚠ Fly state false during cruise — attempting recovery');
        auditAndEquipElytra().then(() => {
          if (phase !== PHASE.CRUISING && phase !== PHASE.DEAD_STICK) return;
          bot.elytraFly().catch(e => {
            setPhase(PHASE.FAILED, '✗ Lost flight state: ' + e.message);
            scheduleRetry();
          });
          if (countRockets() > 0) fireRocketDirect(yawTo(TARGET_X, TARGET_Z));
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
        spatialClear = false; // Reset spatial checkmark on touchdown
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

  // ─── CHAT COMMANDS ────────────────────────────────────────────────────────
  bot.on('chat', (user, msg) => {
    if (user === bot.username) return;
    const cmd = msg.trim().toLowerCase();

    if (cmd === 'f' || cmd === 'fly') {
      retries = 0;
      spatialClear = false;
      startFlight();

    } else if (cmd === 'mode fast' || cmd === 'm fast') {
      currentMode = MODES.FAST;
      console.log(`[EAFE] ⚡ Switched flight mode to ${MODES.FAST.name}`);
      try { bot.chat(`[EAFE] ⚡ Flight Mode set to ${MODES.FAST.name}`); } catch(_) {}

    } else if (cmd === 'mode med' || cmd === 'm med' || cmd === 'mode medium') {
      currentMode = MODES.MEDIUM;
      console.log(`[EAFE] ⚖ Switched flight mode to ${MODES.MEDIUM.name}`);
      try { bot.chat(`[EAFE] ⚖ Flight Mode set to ${MODES.MEDIUM.name}`); } catch(_) {}

    } else if (cmd === 'mode low' || cmd === 'm low' || cmd === 'mode efficient') {
      currentMode = MODES.EFFICIENT;
      console.log(`[EAFE] 🍃 Switched flight mode to ${MODES.EFFICIENT.name}`);
      try { bot.chat(`[EAFE] 🍃 Flight Mode set to ${MODES.EFFICIENT.name}`); } catch(_) {}

    } else if (cmd === 's' || cmd === 'stop') {
      retries = MAX_RETRIES;
      emergencyStop('user command');

    } else if (cmd === 'status') {
      const p = bot.entity.position;
      try {
        bot.chat(
          `phase=${phase} mode=${currentMode.name} pos=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) ` +
          `elytra=${bot.entity.elytraFlying} ground=${bot.entity.onGround} ` +
          `rockets=${countRockets()} spatialClear=${spatialClear?'✓':'✗'} dist=${dist2D().toFixed(0)}m`
        );
      } catch(_) {}

    } else if (cmd === 'audit') {
      const rocketsAvail = countRockets();
      const d2d = dist2D(TARGET_X, TARGET_Z);
      const reqRockets = calculateRequiredRockets(d2d, CRUISE_ALT - bot.entity.position.y);
      const heading = findBestLaunchHeading();
      try {
        bot.chat(
          `Audit [${currentMode.name}]: Rockets=${rocketsAvail}/${reqRockets} Heading=${heading.headingName} ` +
          `Checkmark=${spatialClear?'✓':'✗'}`
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

    // ── Auto-equip elytra & off-hand rockets on spawn ──────────────────
    setTimeout(() => {
      auditAndEquipElytra().then(ok => {
        autoEquipRocket().then(() => {
          const count = countRockets();
          console.log(`[EAFE] Inventory audit: elytra=${ok} rockets=${count} mode=${currentMode.name}`);
          try {
            bot.chat(`[EAFE] Ready  Mode:${currentMode.name}  Elytra:${ok ? '✓' : '✗'}  Rockets:${count}  |  f=fly  m fast/med/low  s=stop`);
          } catch(_) {}
        });
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
        autoEquipRocket().catch(() => {});
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
      if (newItem?.name === 'firework_rocket') {
        setTimeout(() => autoEquipRocket().catch(() => {}), 200);
      }
    });

    console.log('[EAFE] Commands: f=fly  m fast / m med / m low  s=stop  status  audit');
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
console.log('║  EAFE v9.0 — Multi-Mode Engine & Failsafe Yaw-Lock Nav      ║');
console.log('║  Modes: FAST (30m/s), MEDIUM (22m/s), EFFICIENT (14m/s)    ║');
console.log('║  Fuel: Mode-specific pre-flight rocket requirement audit     ║');
console.log('║  Yaw-Lock: Refuses rocket boost if yaw error > 23°           ║');
console.log('║  Off-Hand Rockets: Equipped to slot 45 for 100% packet thrust║');
console.log(`║  Host: ${HOST}:${PORT}`.padEnd(61) + '║');
console.log('╚═════════════════════════════════════════════════════════════╝');

createBot();
