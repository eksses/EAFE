'use strict';

/**
 * Mock mineflayer bot for integration tests.
 *
 * - Real prismarine-world terrain (1.21) so block data (boundingBox, shapes)
 *   matches production.
 * - Faithful velocity units: `entity.velocity` in BLOCKS/TICK (as the real
 *   mineflayer reports), so EAFE's speed gates (blocks/tick) behave correctly.
 * - Elytra model: rocket boost decays, glide floor ~8 m/s, gravity, and
 *   ground contact stops the elytra (server behaviour).
 * - Records chat/whisper output and counts EAFE's blockAt calls (perf guard).
 */
const { Vec3 } = require('vec3');
const { EventEmitter } = require('events');
const minecraftData = require('minecraft-data');
const World = require('prismarine-world');
const Chunk = require('prismarine-chunk');
const BlockLib = require('prismarine-block');

const md = minecraftData('1.21');
const WorldCtor = World(md);
const ChunkCtor = Chunk(md);
const BlockCtor = BlockLib(md);

const GROUND = 64;
const TICKS_PER_SEC = 20;

function blockByName(name) {
  const b = md.blocksByName[name];
  if (!b) throw new Error(`unknown block in mock world: ${name}`);
  return b;
}

class MockBot extends EventEmitter {
  constructor({ startX = 0, startY = GROUND + 1, startZ = 0, rockets = 20, elytraDur = 432, unbreaking = 3, features = [] } = {}) {
    super();
    this.chatLog = [];
    this.whisperLog = [];
    this.eafeBlockAtCalls = 0; // only what EAFE asks for

    // ── world ─
    this.world = new WorldCtor(null, null).sync;
    this._buildFlatWorld(startX, startZ, 20);
    for (const f of features) this.setBlock(f.x, f.y, f.z, f.name);

    // ── entity ──
    this.entity = {
      id: 1,
      position: new Vec3(startX, startY, startZ),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      elytraFlying: false,
      isInWater: false,
      eyeHeight: 1.62,
    };
    this._speedMps = 0;      // internal speed in m/s
    this._rocketUntil = 0;
    this.jump = false;

    // ── player / inventory ──
    this.player = { ping: 20, entity: this.entity };
    this.players = {};
    this.inventory = {
      slots: new Array(46).fill(null),
      items() { return this.slots.filter(Boolean); },
    };
    this.inventory.slots[6] = {
      name: 'elytra', count: 1,
      maxDurability: 432, durabilityUsed: 432 - elytraDur,
      enchants: unbreaking > 0 ? [{ name: 'unbreaking', lvl: unbreaking }] : [],
    };
    this.inventory.slots[0] = rockets > 0 ? { name: 'firework_rocket', count: rockets } : null;

    // ── pathfinder (pre-set so EAFE skips plugin loading) ──
    this.pathfinder = {
      _goal: null,
      _moving: false,
      setMovements() {},
      setGoal(g) { this._goal = g; this._moving = false; },
      isMoving() { return this._moving; },
      stop() { this._moving = false; },
    };
    this.loadPlugin = () => { /* mock: plugins pre-set */ };
  }

  _buildFlatWorld(cx, cz, radiusChunks) {
    const stoneId = blockByName('stone').id;
    const airId = blockByName('air').id;
    for (let x = Math.floor(cx / 16) - radiusChunks; x < Math.floor(cx / 16) + radiusChunks; x++) {
      for (let z = Math.floor(cz / 16) - radiusChunks; z < Math.floor(cz / 16) + radiusChunks; z++) {
        const col = new ChunkCtor({ minY: -64, worldHeight: 320 });
        for (let y = -64; y <= GROUND; y++) {
          for (let lx = 0; lx < 16; lx++) {
            for (let lz = 0; lz < 16; lz++) {
              col.setBlockStateId(new Vec3(lx, y, lz), y === GROUND ? stoneId : airId);
            }
          }
        }
        this.world.setColumn(x, z, col);
      }
    }
  }

  /** Uncounted block read — mock internals (physics) only. */
  rawBlockAt(pos) {
    return this.world.getBlock(pos);
  }

  /** EAFE-facing block read (counted for the perf guard). */
  blockAt(pos) {
    this.eafeBlockAtCalls++;
    const b = this.world.getBlock(pos);
    if (b) b.position = pos.floored();
    return b;
  }

  /** Top of the walkable ground at (x, z): topmost collision block + 1. */
  groundY(x, z) {
    for (let y = 320; y >= 0; y--) {
      const b = this.rawBlockAt(new Vec3(x, y, z));
      if (b && b.boundingBox !== 'empty' && b.shapes && b.shapes.length > 0) return y + 1;
    }
    return GROUND + 1;
  }

  setBlock(x, y, z, name) {
    const col = this.world.getColumn(Math.floor(x / 16), Math.floor(z / 16));
    if (!col) throw new Error('column not built in mock world');
    const lx = ((x % 16) + 16) % 16;
    const lz = ((z % 16) + 16) % 16;
    col.setBlockStateId(new Vec3(lx, y, lz), blockByName(name).minStateId);
  }

  chat(msg) { this.chatLog.push(msg); }
  whisper(user, msg) { this.whisperLog.push({ user, msg }); }
  setControlState(k, v) { this[k] = Boolean(v); }
  look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch; }

  async elytraFly() {
    const e = this.entity;
    if (e.elytraFlying) throw new Error('Already elytra flying');
    if (e.onGround) throw new Error('Unable to fly from ground');
    if (e.isInWater) throw new Error('Unable to elytra fly while in water');
    const chest = this.inventory.slots[6];
    if (!chest || chest.name !== 'elytra') throw new Error('Elytra must be equip to start flying');
    e.elytraFlying = true;
  }

  async equip(item, destination) {
    const destSlot = destination === 'torso' ? 6 : destination === 'off-hand' ? 45 : null;
    if (destSlot === null) throw new Error('bad equip slot ' + destination);
    const slots = this.inventory.slots;
    const fromSlot = slots.indexOf(item);
    if (fromSlot === -1) throw new Error('item not in inventory');
    if (fromSlot !== destSlot) {
      const tmp = slots[destSlot];
      slots[destSlot] = item;
      slots[fromSlot] = tmp;
    }
  }

  activateItem() {
    const offhand = this.inventory.slots[45];
    if (offhand && offhand.name === 'firework_rocket') {
      offhand.count--;
      if (offhand.count <= 0) this.inventory.slots[45] = null;
      this._rocketUntil = Date.now() + 2500;
      this._speedMps = Math.min(this._speedMps + 20, 48);
    }
  }

  /**
   * Advance mock physics by dt seconds (real time). EAFE's own loops run on
   * real timers and read entity state on their 50/200 ms ticks.
   */
  step(dt) {
    const e = this.entity;
    const now = Date.now();
    const ticks = dt * TICKS_PER_SEC;

    if (this.jump && e.onGround) {
      e.velocity.y = 0.42; // blocks/tick, like the server
      e.onGround = false;
    }

    if (e.elytraFlying) {
      const g = this.groundY(Math.round(e.position.x), Math.round(e.position.z));
      if (e.position.y <= g) {
        e.position.y = g;
        e.onGround = true;
        e.elytraFlying = false;
        e.velocity = new Vec3(0, 0, 0);
        this._speedMps = 0;
        return;
      }

      const boosting = now < this._rocketUntil;
      const targetSpeed = boosting ? 24 : 12;
      this._speedMps += (targetSpeed - this._speedMps) * Math.min(1, dt * (boosting ? 4 : 0.8));
      if (boosting) this._speedMps = Math.min(this._speedMps, 26);

      const vT = this._speedMps / TICKS_PER_SEC; // blocks/tick
      const cp = Math.cos(e.pitch);
      const sp = Math.sin(e.pitch);
      // mineflayer convention (verified against mineflayer's own lookAt and
      // mineflayer-pathfinder: yaw = atan2(-dx, -dz) to face (dx, dz)):
      // forward(yaw) = (-sin(yaw), -cos(yaw)) in (x, z).
      let tvx = -Math.sin(e.yaw) * cp * vT;
      let tvz = -Math.cos(e.yaw) * cp * vT;
      let tvy;
      if (boosting) {
        tvy = sp * vT; // rocket: full thrust along view
      } else if (sp > 0.05) {
        // pointing up without a rocket = stall: no sustained climb,
        // sink ~2 m/s, slow drift
        tvy = -0.10;
        tvx *= 0.5;
        tvz *= 0.5;
      } else {
        // level or diving: healthy glide. Sink follows the pitch plus
        // ~0.8 m/s induced drag — a real elytra glides ~15:1 around
        // 12 m/s, it does not deep-stall at 8 m/s.
        tvy = sp * vT - 0.04 - 0.04 * Math.abs(sp);
      }
      const k = Math.min(1, dt * 6);
      e.velocity.x += (tvx - e.velocity.x) * k;
      e.velocity.y += (tvy - e.velocity.y) * k;
      e.velocity.z += (tvz - e.velocity.z) * k;
      e.position = e.position.plus(e.velocity.scaled(ticks));
    } else if (!e.onGround) {
      e.velocity = e.velocity.plus(new Vec3(0, -0.08 * ticks, 0));
      e.position = e.position.plus(e.velocity.scaled(ticks));
      const g = this.groundY(Math.round(e.position.x), Math.round(e.position.z));
      if (e.position.y <= g) {
        e.position.y = g;
        e.onGround = true;
        e.velocity = new Vec3(0, 0, 0);
      }
    } else {
      e.velocity = new Vec3(0, 0, 0);
    }
  }

  /** Run physics in real time until cond() or timeout. Returns success. */
  async stepUntil(cond, timeoutMs = 30000, { dt = 0.02, interval = 20 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.step(dt);
      if (cond()) return true;
      await new Promise(r => setTimeout(r, interval));
    }
    return false;
  }
}

module.exports = { MockBot, md, BlockCtor, GROUND };
