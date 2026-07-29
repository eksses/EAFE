'use strict';

// ── GLOBAL CRASH GUARD ────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('[CRASH] Uncaught:', err.message));
process.on('unhandledRejection', r   => console.error('[CRASH] Reject:', r?.message ?? r));

/**
 * EAFE Elytra Bot v5
 *
 * Root cause from telemetry:
 *   - Server confirmed flight at Y=70 (ground level terrain)
 *   - Rocket fired HORIZONTAL → bot hit terrain → elytraFlying dropped
 *
 * Fix:
 *   1. Look to -1.4 rad (nearly straight UP) BEFORE jump + 250ms wait
 *   2. Fire rocket → bot goes almost straight up gaining 15-20 blocks altitude
 *   3. At safe altitude (>spawnY+12), transition to steep climb -0.65 rad
 *   4. Recovery loop has 3s cooldown — no more rapid re-issue spam
 *
 * Physics: vanilla-accurate PHYS-003/004/005
 *   Order: pitch_exchange → gravity+passive_lift → drag (X,Z×0.99, Y×0.98)
 * Commands: !fly <x> <y> <z>  |  !stop  |  !info
 */

const mineflayer = require('mineflayer');

const HOST     = '103.151.60.212';
const PORT     = 25565;
const USERNAME = 'test';
const VERSION  = '1.20.1';

// ── CHAT QUEUE ────────────────────────────────────────────────────────────────
const chatQ  = [];
let chatBusy = false;
let botRef   = null;
let botAlive = false;

function qChat(msg) {
  chatQ.push(String(msg).slice(0, 240));
  if (!chatBusy) pumpChat();
}
function pumpChat() {
  if (!chatQ.length || !botAlive || !botRef?.entity) { chatBusy = false; return; }
  chatBusy = true;
  try { botRef.chat(chatQ.shift()); } catch {}
  setTimeout(pumpChat, 1500);
}
function log(msg, toChat = false) {
  console.log(msg);
  if (toChat) qChat(msg);
}

// ── MATH ─────────────────────────────────────────────────────────────────────
const clamp  = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const dist2D = (a,b) => Math.sqrt((b.x-a.x)**2+(b.z-a.z)**2);
const dist3D = (a,b) => Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2+(b.z-a.z)**2);
const yawTo  = (f,t) => Math.atan2(-(t.x-f.x), t.z-f.z);
const pitchTo= (f,t) => Math.atan2(t.y-f.y, dist2D(f,t));

// ── STATE ─────────────────────────────────────────────────────────────────────
let target        = null;
let cruiseY       = 200;
let fsm           = 'IDLE'; // IDLE | LAUNCH_CLIMB | STEEP_CLIMB | CRUISE | DESCENT
let spawnY        = 70;     // updated on spawn
let hadFlight     = false;
let lastRocketMs  = 0;
let lastRecovery  = 0;
let tickBusy      = false;

// ── INVENTORY ────────────────────────────────────────────────────────────────
const hasElytra = bot => { const s=bot.inventory.slots[6]; return !!(s&&s.name==='elytra'); };
const findElytra= bot => bot.inventory.items().find(i=>i.name==='elytra');
const isExplosive= item => { try{return !!(item.nbt?.value?.Fireworks?.value?.Explosions);}catch{return false;} };
const getRockets= bot => bot.inventory.items().filter(i=>i.name==='firework_rocket'&&!isExplosive(i));
const nRockets  = bot => getRockets(bot).reduce((s,i)=>s+i.count,0);

async function equipElytra(bot) {
  if (hasElytra(bot)) { log('[EAFE] Elytra ✓', true); return true; }
  const item = findElytra(bot);
  if (!item) { log('[EAFE] No elytra!', true); return false; }
  log(`[EAFE] Equipping elytra slot=${item.slot}`, true);
  try { await bot.equip(item,'torso'); log('[EAFE] Elytra equipped!', true); return true; }
  catch(e) { log(`[EAFE] equip err: ${e.message}`, true); return false; }
}

async function stageRocket(bot) {
  const r = getRockets(bot)[0]; if (!r) return false;
  if (r.slot < 9) { bot.setQuickBarSlot(r.slot); return true; }
  try { await bot.inventory.move(r.slot,36,r.count); bot.setQuickBarSlot(0); }
  catch { bot.setQuickBarSlot(r.slot%9); }
  return true;
}

async function fireRocket(bot) {
  if (!botAlive || !bot.entity?.elytraFlying) return;
  const n = nRockets(bot);
  if (n <= 0) { log('[EAFE] No rockets — dead glide', true); return; }
  await stageRocket(bot);
  try { bot.activateItem(); lastRocketMs = Date.now(); log(`[EAFE] Rocket! ${n-1} left`); }
  catch(e) { log(`[EAFE] Rocket err: ${e.message}`, true); }
}

async function safeLook(bot, yaw, pitch) {
  if (!botAlive || !bot.entity) return;
  try { await bot.look(yaw, pitch, false); } catch {}
}

// ── TAKEOFF ───────────────────────────────────────────────────────────────────
// Key insight from telemetry: rocket fires sideways → hits terrain → drops elytra.
// Fix: look ALMOST STRAIGHT UP (-1.4 rad) before jump so rocket sends bot
// vertically clear of terrain (gains ~15-20 blocks before descending).
async function doTakeoff(bot) {
  if (!botAlive) return false;

  const tgtYaw = target ? yawTo(bot.entity.position, target) : bot.entity.yaw;

  // STEP 0: Look nearly STRAIGHT UP (-1.4 rad ≈ -80°) before anything.
  //         Wait 300ms for look packet to register on server.
  //         At pitch=-1.4: cos=0.17 (horiz), sin=0.985 (vert)
  //         Rocket gives ~85% of impulse UPWARD → bot flies straight up ~15-20 blk
  log('[EAFE] Looking up (-80°) before jump...', true);
  await safeLook(bot, tgtYaw, -1.4);
  await sleep(300);
  if (!botAlive) return false;

  // STEP 1: Sprint-jump toward target
  log('[EAFE] Sprint jump...', true);
  bot.setControlState('sprint', true);
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);

  // Poll for apex (onGround=false), up to 700ms
  let apexMs = 0;
  for (let i = 0; i < 14; i++) {
    await sleep(50); apexMs += 50;
    if (!bot.entity.onGround) break;
  }

  bot.setControlState('jump', false);
  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);

  if (bot.entity.onGround) {
    log('[EAFE] Still on ground after jump — abort', true);
    return false;
  }
  log(`[EAFE] Apex at ${apexMs}ms onGround=${bot.entity.onGround}`, true);

  // STEP 2: START_FALL_FLYING
  try { bot.elytraFly(); log('[EAFE] START_FALL_FLYING sent', true); }
  catch(e) { log(`[EAFE] elytraFly err: ${e.message}`, true); return false; }

  // STEP 3: Fire rocket immediately — goes nearly straight up
  await sleep(40); // one tick for server to process
  if (!botAlive) return false;
  await fireRocket(bot);

  hadFlight = false;
  fsm       = 'LAUNCH_CLIMB';
  log(`[EAFE] Airborne — vertical launch to Y=${spawnY+15} then cruise climb to Y=${cruiseY}`, true);
  return true;
}

// ── FLIGHT TICK ───────────────────────────────────────────────────────────────
async function onTick(bot) {
  if (!botAlive || !bot.entity || !target) return;

  const pos    = bot.entity.position;
  const vel    = bot.entity.velocity;
  const flying = bot.entity.elytraFlying;
  const onGnd  = bot.entity.onGround;
  const now    = Date.now();
  const hSpd   = Math.sqrt(vel.x**2+vel.z**2);  // blocks/tick
  const curYaw = bot.entity.yaw;
  const curPit = bot.entity.pitch;

  // Track server-confirmed flight
  if (flying && !hadFlight) {
    hadFlight = true;
    log(`[EAFE] Flight confirmed Y=${Math.round(pos.y)}`, true);
  }

  // ── FAIL-SAFE: lost flight while airborne ────────────────────────────────
  // Only if we HAD confirmed flight AND now we're not on ground (falling)
  // Rate-limited to every 3s to prevent rapid re-issue spam
  if (hadFlight && !flying && !onGnd && now-lastRecovery > 3000) {
    lastRecovery = now;
    log(`[EAFE] RECOVERY: lost flight at Y=${Math.round(pos.y)}`, true);
    if (!hasElytra(bot)) {
      log('[EAFE] Re-equipping elytra', true);
      try { await equipElytra(bot); await sleep(200); } catch {}
    }
    if (hasElytra(bot) && !bot.entity.onGround) {
      try { bot.elytraFly(); log('[EAFE] elytraFly re-issued', true); }
      catch(e) { log(`[EAFE] re-issue fail: ${e.message}`, true); }
    }
    return;
  }

  if (!flying) return;

  const d2D    = dist2D(pos, target);
  const tgtYaw = yawTo(pos, target);

  // ── FSM TRANSITIONS ─────────────────────────────────────────────────────
  if (fsm === 'LAUNCH_CLIMB') {
    // Vertical escape phase: wait until bot is 12+ blocks above spawn Y
    if (pos.y >= spawnY + 12) {
      fsm = 'STEEP_CLIMB';
      log(`[EAFE] Escape altitude reached Y=${Math.round(pos.y)} → STEEP_CLIMB`, true);
    }
  } else if (fsm === 'STEEP_CLIMB') {
    if (pos.y >= cruiseY) {
      fsm = 'CRUISE';
      log(`[EAFE] Cruise altitude Y=${Math.round(pos.y)}`, true);
    }
  } else if (fsm === 'CRUISE') {
    if (d2D <= 60) {
      fsm = 'DESCENT';
      log(`[EAFE] Descent — ${Math.round(d2D)}m to target`, true);
    }
  }

  // ── PITCH SELECTION ──────────────────────────────────────────────────────
  let wantPitch;

  if (fsm === 'LAUNCH_CLIMB') {
    // Vertical escape: stay steep up while near ground
    wantPitch = -1.2;

  } else if (fsm === 'STEEP_CLIMB') {
    // EAFE-v7.1 §7.1: STEEP_CLIMB = -0.65 rad
    wantPitch = -0.65;

  } else if (fsm === 'CRUISE') {
    // Sine-wave energy cruise (EAFE-v7 §5):
    //   v_h < 0.8 blk/tick  → pitch -0.15 (nose-up, exchange h-speed for altitude)
    //   v_h 0.8–1.6          → pitch -0.08 (flat after rocket boost)
    //   v_h >= 1.6           → pitch +0.18 (nose-down, exchange altitude for speed)
    if (hSpd < 0.8)       wantPitch = -0.15;
    else if (hSpd < 1.6)  wantPitch = -0.08;
    else                   wantPitch = +0.18;

  } else if (fsm === 'DESCENT') {
    wantPitch = clamp(pitchTo(pos, target), -0.3, 0.45);

  } else {
    wantPitch = 0.0;
  }

  // Slew-rate limited look (ANTI-003: ≤0.35 pitch, ≤0.26 yaw per tick)
  const dp  = clamp(wantPitch - curPit, -0.35, 0.35);
  let rawDY = tgtYaw - curYaw;
  while (rawDY >  Math.PI) rawDY -= 2*Math.PI;
  while (rawDY < -Math.PI) rawDY += 2*Math.PI;
  const dy = clamp(rawDY, -0.26, 0.26);
  await safeLook(bot, curYaw+dy, curPit+dp);

  // ── ROCKET SCHEDULING ────────────────────────────────────────────────────
  const rockets  = nRockets(bot);
  const totalSpd = Math.sqrt(vel.x**2+vel.y**2+vel.z**2);

  // Fire conditions:
  //  - LAUNCH_CLIMB: fire every 600ms (rapid initial climb)
  //  - STEEP_CLIMB:  fire every 1500ms
  //  - CRUISE:       fire when total speed < 0.6 blk/tick (low energy)
  //  - DESCENT:      no rockets
  let fireInterval = Infinity;
  if      (fsm === 'LAUNCH_CLIMB') fireInterval = 600;
  else if (fsm === 'STEEP_CLIMB')  fireInterval = 1500;
  else if (fsm === 'CRUISE')       fireInterval = totalSpd < 0.6 ? 1000 : Infinity;

  if (rockets > 0 && now-lastRocketMs > fireInterval) {
    await fireRocket(bot);
  }

  // ── WALL COLLISION (v_h < 0.05 while cruising) ───────────────────────────
  if (hSpd < 0.05 && (fsm === 'CRUISE' || fsm === 'STEEP_CLIMB') && now-lastRocketMs > 1500) {
    log('[EAFE] Wall collision — yaw flip + pitch up + rocket', true);
    await safeLook(bot, curYaw+Math.PI, -0.8);
    await sleep(50);
    if (rockets > 0) await fireRocket(bot);
    return;
  }

  // ── ARRIVAL ──────────────────────────────────────────────────────────────
  if (d2D < 5 && Math.abs(target.y - pos.y) < 10) {
    log(`[EAFE] ARRIVED! (${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)})`, true);
    target=null; fsm='IDLE'; hadFlight=false;
  }
}

// ── BOT BOOTSTRAP ─────────────────────────────────────────────────────────────
function start() {
  console.log(`[BOT] Connecting → ${HOST}:${PORT} as "${USERNAME}" (MC ${VERSION})`);

  const bot = mineflayer.createBot({
    host:HOST, port:PORT, username:USERNAME,
    version:VERSION, auth:'offline', checkTimeoutInterval:30000,
  });
  botRef = bot;

  bot.on('login', () => { botAlive=true; console.log('[BOT] Logged in!'); });

  // Auth plugin
  bot.on('message', msg => {
    const t = msg.toString().toLowerCase();
    if (t.includes('/login')||t.includes('please login')||t.includes('/register')) {
      console.log('[AUTH] Login prompt → sending /login');
      setTimeout(()=>{ try{bot.chat('/login test123');}catch{} }, 800);
      setTimeout(()=>{ try{bot.chat('/register test123 test123');}catch{} }, 2500);
    }
  });

  bot.on('spawn', () => {
    botRef=bot; botAlive=true;
    spawnY = bot.entity.position.y; // remember ground level
    const p=bot.entity.position;
    log(`[EAFE] Spawned (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) groundY=${Math.round(spawnY)}`, true);
    log('[EAFE] !fly <x> <y> <z>  |  !stop  |  !info', true);

    setTimeout(()=>{
      const r=nRockets(bot), e=hasElytra(bot), eb=findElytra(bot);
      log(`[EAFE] Elytra=${e?'EQUIPPED':(eb?'slot'+eb.slot:'NONE')} Rockets=${r}`, true);
    }, 1500);

    // ── LIVE TELEMETRY every 2s ─────────────────────────────────────────
    setInterval(()=>{
      if (fsm==='IDLE'||!bot.entity) return;
      const p=bot.entity.position, v=bot.entity.velocity;
      const hS=(Math.sqrt(v.x**2+v.z**2)*20).toFixed(1);
      const vS=(v.y*20).toFixed(1);
      const fly=bot.entity.elytraFlying, gnd=bot.entity.onGround, r=nRockets(bot);
      // Full console
      console.log(`[POS] X=${Math.round(p.x)} Y=${Math.round(p.y)} Z=${Math.round(p.z)} hS=${hS} vS=${vS} fly=${fly} gnd=${gnd} ${fsm} r=${r}`);
      // Rate-limited chat
      qChat(`[POS] Y=${Math.round(p.y)} h=${hS} v=${vS} fly=${fly} ${fsm} r=${r}`);
    }, 2000);

    // ── 50ms flight tick ────────────────────────────────────────────────
    setInterval(()=>{
      if (tickBusy||fsm==='IDLE'||!target) return;
      tickBusy=true;
      onTick(bot).catch(e=>console.error('[TICK]',e.message)).finally(()=>{tickBusy=false;});
    }, 50+(Math.random()*10-4));
  });

  // ── Auto-equip on pickup ──────────────────────────────────────────────
  bot.on('playerCollect', collector=>{
    if (collector.username!==bot.username) return;
    setTimeout(async()=>{
      if (findElytra(bot)&&!hasElytra(bot)) {
        log('[EAFE] Picked up elytra — equipping', true);
        await equipElytra(bot);
      }
      const r=nRockets(bot), prev=bot._pr??0;
      if (r>prev) log(`[EAFE] Rockets: ${r}`, true);
      bot._pr=r;
    }, 300);
  });

  // ── Nearby item drop: look + walk ─────────────────────────────────────
  bot.on('entitySpawn', entity=>{
    if (entity.name!=='item'||fsm!=='IDLE') return;
    const pos=bot.entity?.position; if (!pos) return;
    if (dist3D(pos,entity.position)>6) return;
    setTimeout(async()=>{
      if (fsm!=='IDLE') return;
      const d=dist3D(bot.entity.position, entity.position); if (d>6) return;
      log(`[EAFE] Item ${d.toFixed(1)}m away — collecting`, true);
      try { await bot.lookAt(entity.position, false); } catch {}
      await sleep(100);
      bot.setControlState('forward', true);
      for (let i=0;i<30;i++) {
        await sleep(50);
        if (dist3D(bot.entity.position,entity.position)<1.5) break;
      }
      bot.setControlState('forward', false);
    }, 200);
  });

  // ── CHAT COMMANDS ─────────────────────────────────────────────────────
  bot.on('chat', async(username, message)=>{
    if (username===bot.username||!message.startsWith('!')) return;
    const args=message.trim().slice(1).split(/\s+/);
    const cmd=args[0].toLowerCase();

    if (cmd==='info') {
      const p=bot.entity.position, v=bot.entity.velocity;
      const hS=(Math.sqrt(v.x**2+v.z**2)*20).toFixed(1);
      const r=nRockets(bot), e=hasElytra(bot), eb=findElytra(bot);
      const tgt=target?`(${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)}) ${Math.round(dist2D(p,target))}m`:'none';
      log(`[INFO] Pos:(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) hSpd:${hS}m/s`, true);
      log(`[INFO] fly:${bot.entity.elytraFlying} state:${fsm} groundY:${Math.round(spawnY)}`, true);
      log(`[INFO] Elytra:${e?'EQUIPPED':(eb?'bag':'NONE')} Rockets:${r}`, true);
      log(`[INFO] Target:${tgt}`, true);
    }

    else if (cmd==='fly') {
      const [x,y,z]=args.slice(1).map(Number);
      if ([x,y,z].some(isNaN)) { log('[EAFE] Usage: !fly <x> <y> <z>', true); return; }
      if (fsm!=='IDLE') { log('[EAFE] Already flying! !stop first', true); return; }

      target  = {x,y,z};
      cruiseY = Math.max(spawnY+100, y+30, 200);

      log(`[EAFE] Target=(${Math.round(x)},${Math.round(y)},${Math.round(z)}) dist=${Math.round(dist2D(bot.entity.position,target))}m cruiseY=${cruiseY} rockets=${nRockets(bot)}`, true);
      const ok = await equipElytra(bot);
      if (!ok) { target=null; return; }
      const launched = await doTakeoff(bot);
      if (!launched) { target=null; fsm='IDLE'; }
    }

    else if (cmd==='stop') {
      if (fsm==='IDLE') { log('[EAFE] Not flying', true); return; }
      log('[EAFE] STOP — dead-stick glide', true);
      target=null; fsm='IDLE'; hadFlight=false;
    }

    else { log(`[EAFE] Unknown: !${cmd}  try !fly !stop !info`, true); }
  });

  bot.on('error', err=>{
    if (!err.message.includes('ECONNRESET')&&!err.message.includes('ECONNREFUSED'))
      console.error('[BOT]',err.message);
  });
  bot.on('kicked', r=>{ let s=r; try{s=JSON.parse(r)?.translate??JSON.parse(r)?.text??r;}catch{} console.warn('[BOT] Kicked:',s); });
  bot.on('end', reason=>{
    console.log(`[BOT] Disconnected: ${reason} — retry 15s`);
    botAlive=false; botRef=null;
    target=null; fsm='IDLE'; hadFlight=false;
    setTimeout(start, 15000);
  });
}

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║  EAFE Elytra Bot v5  |  Vertical launch escape fix    ║');
console.log('║  pitch=-1.4rad before jump → rocket goes straight UP  ║');
console.log(`║  ${HOST}:${PORT}  user=${USERNAME}`.padEnd(57)+'║');
console.log('╚════════════════════════════════════════════════════════╝');
console.log('  !fly <x> <y> <z>  |  !stop  |  !info\n');
start();
