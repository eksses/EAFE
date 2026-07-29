<div align="center">

# EAFE

### Autonomous Elytra Flight Engine

```
         _____
        /     \
       / () () \      Protocol-level navigation for
      |  __A__  |     long-range autonomous flight
       \  ___  /      in Minecraft
        \_____/
       /||   ||\      v10.23
      / ||   || \
     /  ||   ||  \
        ||   ||
       _||_ _||_
      /________\
```

<br>

**Zero-to-landing autonomous elytra flight** powered by vanilla physics decomposition,
anti-spam chat safety, and precision 2x2 platform landing.

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Mineflayer](https://img.shields.io/badge/Mineflayer-4.x-FF6600?logo=minecraft&logoColor=white)](https://github.com/PrismarineJS/mineflayer)
[![Version](https://img.shields.io/badge/version-10.23-blueviolet)](elytraBot.js)
[![License](https://img.shields.io/badge/license-ISC-green)](LICENSE)

</div>

---

## What is EAFE?

EAFE is a **Minecraft bot** that flies elytra autonomously from point A to point B.
No human input needed mid-flight. It handles everything:

```
  PRE-FLIGHT AUDIT          TAKEOFF            CRUISE           LANDING
 ┌─────────────────┐    ┌───────────┐    ┌──────────────┐    ┌───────────┐
 │ Elytra dur check │───▶│ 150ms jump│───▶│ Rocket mgmt  │───▶│ Spiral    │
 │ Rocket count     │    │ apex rule │    │ Pitch control│    │ search    │
 │ Launch heading   │    │ elytraFly │    │ Terrain scan │    │ Flare     │
 │ Fuel calculation │    │ Rocket #1 │    │ 2s checkups  │    │ Touchdown │
 └─────────────────┘    └───────────┘    └──────────────┘    └───────────┘
```

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/eksses/EAFE.git
cd EAFE
npm install
```

### 2. Configure

Edit the top of `elytraBot.js`:

```javascript
const HOST       = '103.151.60.212';   // Server IP
const PORT       = 25565;              // Server port
const USERNAME   = 'test';             // Bot username
const DEFAULT_TARGET_X = 100;          // Default flight target X
const DEFAULT_TARGET_Z = 100;          // Default flight target Z
const CRUISE_ALT       = 180;          // Cruise altitude (Y=180)
```

### 3. Run

```bash
npm start
```

### 4. Fly

Open Minecraft, send a chat message to the bot:

```
f 500 -1200       ← fly to coordinates (500, -1200)
s                  ← emergency stop
m fast             ← switch to fast mode
status             ← show flight status
```

---

## Commands

| Command | Description |
|---------|-------------|
| `f [X Z]` | Fly to coordinates X Z (or use defaults) |
| `setgoal X Z` | Set target without taking off |
| `m fast` | High speed sprint mode (22 m/s, uses most rockets) |
| `m med` | Balanced glide mode (13 m/s, 50% fewer rockets) |
| `m low` | Efficient rocket-saver mode (10 m/s, 80% fuel savings) |
| `s` / `stop` | Emergency stop all flight |
| `status` | Display current phase, position, elytra health, rockets |
| `audit` | Pre-flight resource audit report |

---

## How It Works

### Architecture Overview

```
elytraBot.js
│
├── CONFIG ─────────────────────── Server, defaults, flight modes
│
├── PHASE STATE MACHINE ────────── 11 flight phases with transitions
│   IDLE → AUDIT → RELOCATING → TAKEOFF → CLIMBING → CRUISING
│   → WANDER_SCAN → DEAD_STICK → LANDING → FAILED
│
├── SAFETY SYSTEMS ─────────────── Hazard detection, anti-spam chat
│   ├── isHazardousBlock()        Water/lava/magma detection
│   ├── isSafeSolidBlock()        Safe landing surface check
│   └── safeChat()                4s anti-spam cooldown
│
├── ELYTRA ENGINE ──────────────── Unbreaking-aware durability tracking
│   ├── getUnbreakingLevel()      Detect enchantment level (0-3)
│   ├── calculateRequiredElytraDurability()  Pre-flight durability calc
│   ├── auditAndEquipElytra()     Auto-swap to best spare
│   └── checkMidFlightElytraSwap() In-flight durability monitor
│
├── ROCKET ENGINE ──────────────── Smart firework management
│   ├── countRockets()            Count non-explosive rockets
│   ├── autoEquipRocket()         Equip to off-hand slot 45
│   ├── fireRocketDirect()        Packet-based off-hand activation
│   └── shouldFireRocketDynamic() Physics-based fuel need check
│
├── FLIGHT PHYSICS ─────────────── Vanilla-accurate per-tick model
│   ├── isFlying()                Server + simulation state check
│   ├── scanFullRenderDistance()   Raycast obstacle detection
│   └── findBestLaunchHeading()   8-directional clearance scan
│
├── NAVIGATION ─────────────────── Multi-phase flight control
│   ├── startClimb()              Steep ascent to cruise altitude
│   ├── startCruise()             Level flight with periodic checks
│   ├── startWanderScan()         Ocean search with chunk memory
│   └── startLanding()            Spiral scan + flare touchdown
│
└── COMMAND PROCESSOR ──────────── Chat + terminal stdin input
```

### Vanilla Physics Model

EAFE implements the **exact 3-step velocity update loop** from Minecraft's decompiled `LivingEntity.travel()`, executed every 50ms tick:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PER-TICK VELOCITY UPDATE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  STEP 1: Kinetic Pitch Energy Exchange                          │
│  ├─ Nose UP (pitch < 0): Horizontal momentum → Vertical lift   │
│  └─ Nose DOWN (pitch > 0): Fall speed → Horizontal thrust      │
│                                                                  │
│  STEP 2: Impulse, Gravity & Passive Wing Lift                   │
│  ├─ + Rocket thrust impulse (if active)                         │
│  ├─ − Gravity (g = 0.08 blocks/tick²)                           │
│  └─ + Passive wing lift (cos²(pitch) × 0.06)                   │
│                                                                  │
│  STEP 3: Axis-Decoupled Drag Scaling                            │
│  ├─ Horizontal (X, Z) × 0.99                                    │
│  └─ Vertical (Y)     × 0.98  ← Critical: NOT the same!         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

> **Why axis-decoupled drag matters:** Using a unified 0.99 on all axes causes vertical
> position drift over long distances. The bot would descend slower than vanilla,
> accumulating error until it rubber-bands back. EAFE matches vanilla exactly.

### Flight Modes Compared

| Mode | Pitch | Speed | Fuel Efficiency | Use Case |
|------|-------|-------|-----------------|----------|
| **FAST** | +0.02 rad | 22 m/s | ~50m per rocket | Emergency transit, short hops |
| **MEDIUM** | −0.04 rad | 13 m/s | ~120m per rocket | Default balanced flight |
| **EFFICIENT** | −0.05 rad | 10 m/s | ~180m per rocket | Long-range, fuel-scarce |

The pitch values control the **L/D (lift-to-drag) glide ratio**:
- Nose-down pitches convert altitude into forward speed
- Nose-up pitches (post-boost) convert speed back into altitude
- The bot oscillates between these phases for optimal energy cruise

---

## Safety Systems

### Elytra Durability Management

```
┌────────────────────────────────────────────────────────────────┐
│  PRE-FLIGHT DURABILITY AUDIT                                    │
│                                                                 │
│  1. Scan equipped elytra (slot 6)                              │
│  2. If durability ≤ 10 → auto-swap to best spare              │
│  3. Sum durability across ALL elytras in inventory             │
│  4. Calculate required durability for flight distance          │
│     reqDur = ceil(distance / speed) × damageRate + 15 buffer  │
│  5. Block launch if insufficient                               │
│                                                                 │
│  MID-FLIGHT MONITOR (every tick)                               │
│  • If equipped elytra drops ≤ 10 dur → hot-swap spare          │
│  • Re-activate elytra fly + rocket boost after swap            │
│  • If no spares → emergency landing                            │
└────────────────────────────────────────────────────────────────┘
```

The **Unbreaking enchantment** is factored in:

| Unbreaking Level | Damage Rate | Effective Durability |
|-----------------|-------------|---------------------|
| None | 1.00 dur/sec | 432 ticks |
| I | 0.50 dur/sec | 864 ticks (2x) |
| II | 0.33 dur/sec | 1296 ticks (3x) |
| III | 0.25 dur/sec | 1728 ticks (4x) |

### Anti-Spam Chat Engine

```
bot.chat() calls are rate-limited to ONE message per 4 seconds.

  Thread:  safeChat("[EAFE] Climbing...")
           safeChat("[EAFE] Cruise")     ← BLOCKED (2.1s elapsed)
           ... 4.0s later ...
           safeChat("[EAFE] Cruise")     ← SENT
```

This completely eliminates **"Kicked for spamming"** server kicks during
status broadcasts and low-health alerts.

### Terrain Collision Avoidance

```
          scanFullRenderDistance()
                    │
         Cast ray along flight vector
         up to server render distance
                    │
            ┌───────┴───────┐
            │               │
        Hit detected    Clear path
            │               │
     Steepen pitch     Continue
     (+0.65 / +0.75)   level flight
     Fire rocket
     to climb over
```

The bot dynamically measures the server's **real-time render distance**
by auditing loaded chunk columns, then raycasts that full distance ahead.

---

## Landing System

### 3-Phase Landing Sequence

```
PHASE 1: ARRIVAL SCAN
  └─ Find nearest safe solid block within server render distance
     └─ Calculate geometric center of land mass (2x2+ platforms supported)

PHASE 2: DESCENT
  └─ If target is ocean → enter WANDER_SCAN (concentric ring ocean search)
     └─ Expanding rings around goal, chunk memory map tracks scanned areas

PHASE 3: TOUCHDOWN
  ├─ Y > ground+4: Nose DOWN glide (−0.30 rad)
  ├─ Y ≤ ground+4: Nose UP flare (+0.10 rad) + sneak
  └─ onGround = true: Mission complete
```

### Land Mass Center Detection

The `findLandMassCenter()` function maps the bounding box of any solid
platform (even 2x2 blocks) and calculates the **exact geometric centroid**
to ensure the bot lands in the middle, away from edges:

```
  ┌──────────┐
  │ ░░░░░░░░ │
  │ ░░░░░░░░ │     Scans 15 blocks in each direction
  │ ░░░╳░░░░ │  ←  ╳ = calculated center (Target X, Target Z)
  │ ░░░░░░░░ │
  │ ░░░░░░░░ │
  └──────────┘
     2x2 minimum supported!
```

---

## Ocean Search (Wander Scan)

When the destination is over water, EAFE enters a **concentric ring search**:

```
                    ╔═══════════════════╗
                    ║   DESTINATION     ║
                    ║   (X, Z)          ║
                    ╚═══════╤═══════════╝
                            │
              ┌─────────────┼─────────────┐
              │  RING 1: 40m radius      │
              │  Fly N → E → S → W      │
              │  Scan loaded chunks      │
              └─────────────┬─────────────┘
                            │ No land found
              ┌─────────────┼─────────────┐
              │  RING 2: +80m radius     │
              │  Expand search outward   │
              └─────────────┬─────────────┘
                            │
                         Continue...
```

**Chunk Memory Map** prevents re-scanning the same areas.
A **10% backtrack limit** reroutes to the last known safe coastline
if the bot flies too far from its starting position.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `mineflayer` | Minecraft bot framework (protocol-level) |
| `mineflayer-pathfinder` | A* ground pathfinding for relocation |
| `@nxg-org/mineflayer-physics-util` | Client-side physics simulation engine |

---

## Project Structure

```
EAFE/
├── elytraBot.js      ← Main bot (the entire flight engine)
├── package.json      ← Dependencies and metadata
├── package-lock.json ← Locked dependency versions
├── .gitignore        ← Ignores node_modules and logs
└── README.md         ← You are here
```

---

## How the Code is Organized

The single `elytraBot.js` file is structured in clear sections:

| Lines | Section | What It Does |
|-------|---------|-------------|
| 1–58 | Config & Modes | Server address, flight mode definitions |
| 60–78 | Phase State | 11-state FSM, hazard surface definitions |
| 89–126 | Utilities | `sleep()`, `isAir()`, `isHazardousBlock()`, `angleDiff()` |
| 128–168 | Bot Factory | `createBot()` — session state, timer cleanup |
| 170–196 | Chat & Stop | Anti-spam `safeChat()`, `emergencyStop()` |
| 206–237 | Render Distance | Dynamic server view distance detection |
| 239–288 | Inventory | Rocket counting, off-hand equip, `findRocket()` |
| 289–445 | Elytra Engine | Unbreaking audit, durability calc, mid-flight swap |
| 447–567 | Navigation | Yaw/pitch helpers, rocket firing, physics checks |
| 569–760 | Spatial Scan | Raycast, runway check, pathfinding, launch heading |
| 762–1015 | Flight Phases | Takeoff, climb, cruise with rocket management |
| 1141–1392 | Ocean Search | Wander scan, concentric rings, chunk memory |
| 1394–1486 | Landing | Spiral search, flare touchdown, retry mechanism |
| 1487–1566 | Commands | Chat/terminal command processor |
| 1568–1679 | Spawn & Init | Event listeners, auto-equip, disconnect handler |

---

## License

ISC

---

<div align="center">

*Built with vanilla physics decomposition.*
*Every tick, every block, every rocket — calculated.*

</div>
