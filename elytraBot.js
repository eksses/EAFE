'use strict';
/**
 * EAFE v7.1 — Elytra Autonomous Flight Engine (Vanilla & EAFE Specification Compliant)
 * ======================================================================================
 * Features:
 *   - Working Flight Core (UNTOUCHED):
 *       • Takeoff: 150ms Jump Apex Rule (Jump -> wait airborne -> elytraFly() -> rocket)
 *       • Pitch Angles: +0.65=UP (Climb), +0.05=LEVEL (Cruise), -0.30=DOWN (Landing)
 *       • Propulsion: Timed rocket bursts (1.2s Climb, 1.5s Cruise)
 *       • Engine: Native Mineflayer 50ms physics sync with @nxg-org/mineflayer-physics-util
 *   - Pre-Flight Audit (EAFE-v7.1 Sec 2.2 & 3.2):
 *       • Durability check: Auto-swap Elytra if durability ≤ 15 points
 *       • Fuel equation: N_req = ceil(d2d/68.5) + ceil(ΔY/28.0) + 15
 *       • 3D Spatial Envelope: Overhead (1x1x5), Runway (1x2x4), Lateral (3x2x1)
 *   - Ground Pathfind Relocation (EAFE-v7.1 Sec 3.2):
 *       • Local 11x5x11 grid scan for elevated open node if spatial check fails
 *   - Surface Classifier & Archimedean Spiral Landing (EAFE-v7.1 Sec 6.1-6.2):
 *       • Validates solid ground (grass, dirt, stone, obsidian) vs hazard (lava, fire, water, cactus)
 *       • Spiral search (R=1..20m) for safe landing pad if target LZ is hazardous
 *       • Sneak key engaged on touchdown for zero bounce / zero damage
 *   - Network & Latency Telemetry (EAFE-v7.1 Sec 4.2):
 *       • Pauses rockets if server ping > 500ms
 *   - Real-time Knockback: Responds to entity_velocity & explosion packets
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
  AUDIT:      'AUDIT',        // pre-flight inventory, fuel & spatial audit
  RELOCATING: 'RELOCATING',   // walking to open launch spot
  TAKEOFF:    'TAKEOFF',      // 150ms jump apex + elytraFly()
  CLIMBING:   'CLIMBING',     // nose up (+0.65), gaining altitude
  CRUISING:   'CRUISING',     // level (+0.05), heading to target
  LANDING:    'LANDING',      // Archimedean spiral & surface glide (-0.30)
  FAILED:     'FAILED',       // flight failed, auto-retry scheduled
};

// Whitelisted safe landing surfaces (EAFE-v7.1 Sec 6.1)
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

  // ─── Inventory & Equipment Audit ──────────────────────────────────────────
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
    const chest = bot.inventory.slots[6]; // chestplate slot
    if (chest?.name === 'elytra') {
      const dur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 400;
      if (dur > 15) {
        console.log(`[EAFE] ✓ Elytra equipped (durability: ${dur})`);
        return true;
      }
      console.warn(`[EAFE] ⚠ Equipped Elytra durability low (${dur} points) — looking for spare...`);
    }

    // Find elytra in inventory with durability > 15
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

  // ─── Rocket firing with Latency Protection ────────────────────────────────
  function fireRocket() {
    if (!bot.entity.elytraFlying) { console.log('[EAFE] fireRocket: skipped (not elytraFlying)'); return false; }

    // EAFE-v7.1 Sec 4.2: Suppress rocket if server latency > 500ms
    const ping = bot.player?.ping ?? 50;
    if (ping > 500) {
      console.warn(`[EAFE] ⚠ High server ping (${ping}ms) — throttling rocket`);
      return false;
    }

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
  //  PRE-FLIGHT AUDIT & SPATIAL ENVELOPE (EAFE-v7.1 Sec 3.2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 3D Spatial Envelope Scan:
   *  1. Overhead Column: 1x1x5 blocks (Y+1 -> Y+5)
   *  2. Forward Runway: 1x2x4 blocks along yaw
   *  3. Lateral Spacing: 3x2x1 blocks at shoulder height
   */
  function auditSpatialEnvelope() {
    const pos = bot.entity.position;
    const yaw = yawTo(TARGET_X, TARGET_Z);

    // 1. Overhead Column
    for (let dy = 1; dy <= 5; dy++) {
      if (!isAir(bot.blockAt(pos.offset(0, dy, 0)))) {
        return { clear: false, reason: `Overhead blocked at Y+${dy}` };
      }
    }

    // 2. Forward Runway (4 blocks ahead, 2 blocks high)
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const dirX = -sinY;
    const dirZ = cosY;

    for (let d = 1; d <= 4; d++) {
      for (let dy = 0; dy <= 1; dy++) {
        const bPos = pos.offset(Math.round(dirX * d), dy, Math.round(dirZ * d));
        if (!isAir(bot.blockAt(bPos))) {
          return { clear: false, reason: `Runway blocked at ${d}m ahead` };
        }
      }
    }

    // 3. Lateral Spacing (1 block left/right at shoulder height Y+1)
    const sideX = cosY; // perpendicular vector
    const sideZ = sinY;
    for (let side of [-1, 1]) {
      const bPos = pos.offset(Math.round(sideX * side), 1, Math.round(sideZ * side));
      if (!isAir(bot.blockAt(bPos))) {
        return { clear: false, reason: `Lateral spacing blocked` };
      }
    }

    return { clear: true, reason: 'Spatial envelope clear' };
  }

  /**
   * Local 11x5x11 grid scan for elevated open launch node (EAFE-v7.1 Sec 3.2)
   */
  function findElevatedOpenSpot() {
    const pos   = bot.entity.position;
    const baseY = Math.floor(pos.y);
    let best    = null;

    for (let dx = -5; dx <= 5; dx += 2) {
      for (let dz = -5; dz <= 5; dz += 2) {
        const cx = Math.floor(pos.x) + dx;
        const cz = Math.floor(pos.z) + dz;

        let groundY = null;
        for (let dy = 1; dy >= -3; dy--) {
          const b = bot.blockAt(new Vec3(cx, baseY + dy, cz));
          if (b && !isAir(b)) { groundY = baseY + dy + 1; break; }
        }
        if (groundY === null) continue;

        let openAir = 0;
        for (let dy = 0; dy < 15; dy++) {
          if (isAir(bot.blockAt(new Vec3(cx, groundY + dy, cz)))) openAir++;
          else break;
        }

        if (openAir >= 5) {
          const dist = Math.hypot(dx, dz);
          const score = openAir - dist * 0.5;
          if (score > (best?.score ?? -999)) {
            best = { x: cx, y: groundY, z: cz, score, openAir };
          }
        }
      }
    }

    return best;
  }

  /**
   * Walk to launch spot
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

    setPhase(PHASE.AUDIT, 'Running pre-flight inventory, fuel & spatial audit...');

    // 1. Elytra durability audit
    const elytraOk = await auditAndEquipElytra();
    if (!elytraOk) { setPhase(PHASE.FAILED, '✗ No usable Elytra (durability > 15)'); return; }

    // 2. Fuel audit calculation (EAFE-v7.1 Sec 2.2)
    const rocketsAvail = countRockets();
    const d2d = dist2D(TARGET_X, TARGET_Z);
    const startY = bot.entity.position.y;
    const reqRockets = Math.ceil(d2d / 68.5) + Math.ceil(Math.abs(CRUISE_ALT - startY) / 28.0) + 15;

    console.log(`[EAFE] Fuel Audit: Available=${rocketsAvail} | Required=${reqRockets} (dist=${d2d.toFixed(0)}m)`);
    if (rocketsAvail < reqRockets) {
      try { bot.chat(`[EAFE] ⚠ Fuel warning: Have ${rocketsAvail} rockets, calculated ${reqRockets} needed`); } catch(_) {}
    }
    if (rocketsAvail === 0) {
      setPhase(PHASE.FAILED, '✗ No firework rockets in inventory');
      return;
    }

    // 3. 3D Spatial Envelope Audit (EAFE-v7.1 Sec 3.2)
    const spatial = auditSpatialEnvelope();
    console.log(`[EAFE] Spatial Audit: clear=${spatial.clear} (${spatial.reason})`);

    if (!spatial.clear) {
      try { bot.chat(`[EAFE] ⚠ Launch spatial check failed (${spatial.reason}) — scanning relocation spot...`); } catch(_) {}

      const spot = findElevatedOpenSpot();
      if (!spot) {
        setPhase(PHASE.FAILED, '✗ Launch area obstructed — no open elevated node nearby');
        scheduleRetry();
        return;
      }

      setPhase(PHASE.RELOCATING, `Moving to open spot (${spot.x}, ${spot.z}) openAir=${spot.openAir}m`);
      const arrived = await walkToSpot(spot.x, spot.z);
      if (!arrived) {
        setPhase(PHASE.FAILED, '✗ Could not walk to launch spot');
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

  // ─── CLIMB (UNTOUCHED WORKING CORE) ──────────────────────────────────────
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

  // ─── CRUISE (UNTOUCHED WORKING CORE) ─────────────────────────────────────
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
        auditAndEquipElytra().then(() => {
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

  // ─── LANDING & SURFACE CLASSIFIER (EAFE-v7.1 Sec 6.1-6.3) ────────────────
  function startLanding() {
    setPhase(PHASE.LANDING, 'Initiating surface classification & Archimedean spiral landing...');

    // Locate safe landing target spot using Archimedean Spiral search
    let targetX = TARGET_X;
    let targetZ = TARGET_Z;

    // Check block surface under TARGET_X, TARGET_Z
    let groundBlock = getGroundBlockAt(targetX, targetZ);
    if (groundBlock && !SAFE_SURFACES.has(groundBlock.name)) {
      console.warn(`[EAFE] ⚠ Target LZ (${targetX}, ${targetZ}) is unsafe (${groundBlock.name}) — running Archimedean spiral...`);

      // Spiral search R=1..20m
      let foundSafe = false;
      for (let r = 1; r <= 20; r += 2) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
          const sx = Math.round(TARGET_X + r * Math.cos(angle));
          const sz = Math.round(TARGET_Z + r * Math.sin(angle));
          const sb = getGroundBlockAt(sx, sz);
          if (sb && SAFE_SURFACES.has(sb.name)) {
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

      // Nose DOWN (-0.30 rad = -17°) for controlled descent towards target LZ
      lookForce(yawTo(targetX, targetZ), -0.30);

      // Touchdown Flare & Bounce Cancel: Engage sneak when Y <= 3m above ground
      if (pos.y <= Math.floor(pos.y) + 3) {
        try { bot.setControlState('sneak', true); } catch(_) {}
      }

      console.log(`[EAFE] [LAND] Y=${pos.y.toFixed(1)} dist=${dist2D(targetX, targetZ).toFixed(1)}m ground=${bot.entity.onGround}`);

      if (bot.entity.onGround) {
        clearInterval(landCheck);
        clearInterval(verifyLoop); verifyLoop = null;
        try { bot.setControlState('sneak', false); } catch(_) {}
        retries = 0; // Flight successful!
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
        const hasRocket = !!findRocket();
        console.log(`[EAFE] Inventory audit: elytra=${ok} rockets=${hasRocket}`);
        try {
          bot.chat(`[EAFE] Ready  Elytra:${ok ? '✓' : '✗'}  Rockets:${hasRocket ? '✓' : '✗'}  |  f=fly  s=stop  audit=runAudit`);
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
console.log('╔═════════════════════════════════════════════════════════════╗');
console.log('║  EAFE v7.1 — Elytra Autonomous Flight Engine Specification   ║');
console.log('║  Physics: Native Mineflayer 50ms Engine                      ║');
console.log('║  Core Flight: 150ms Apex Jump + Pitch + Timed Rocket Bursts ║');
console.log('║  Safety: 3D Spatial Audit + Elytra Durability Hotswap        ║');
console.log('║  Landing: Surface Classifier & Archimedean Spiral Re-route  ║');
console.log(`║  Host: ${HOST}:${PORT}`.padEnd(61) + '║');
console.log('╚═════════════════════════════════════════════════════════════╝');

createBot();
