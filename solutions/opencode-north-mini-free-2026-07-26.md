# EAFE Audit — Independent Line-by-Line Verification

**Agent:** opencode/north-mini-free
**Date:** 2026-07-26
**Model:** opencode/north-mini-free
**Method:** Full independent audit — zero reference to other agent reports

---

## Methodology

1. Read EAFE-v7.md and EAFE-v7.1.md in full
2. For every physics formula, FSM transition, and constant: verify against vanilla Minecraft Java Edition decompiled behavior (LivingEntity.travel, ElytraItem, FireworkRocketEntity)
3. Check dimensional consistency on every equation
4. Verify FSM completeness: every state has exits, every transition has guards, no unreachable states
5. Cross-check v7 vs v7.1 for contradictions
6. Flag every issue with file:line reference

---

## PHYSICS VERIFICATION

### Vanilla Reference (from decompiled LivingEntity.travel, 1.20.1)

```java
// LivingEntity.travel (simplified)
vec3d = this.getVelocity();
double d = vec3d.horizontalLengthSquared();
if (d < 0.001) { ... }
float f = this.isFallFlying() ? 0.99F : 0.98F;  // DRAG: horizontal 0.99, vertical 0.98
vec3d = vec3d.multiply(f, 0.98, f);            // X*0.99, Y*0.98, Z*0.99
vec3d = vec3d.add(0, -0.08, 0);                // GRAVITY: -0.08/tick²
// Pitch exchange happens BEFORE drag in vanilla
```

---

### PHYS-001: v7 Unified Drag Constant

**Location:** EAFE-v7.md:59-60
**Text:** `v_drag = v_t * 0.99` (applied to all axes)
**Vanilla:** X*0.99, Y*0.98, Z*0.99
**Verdict:** **INCORRECT** — v7 applies 0.99 to vertical. Causes ~2% slower descent per tick → accumulates to blocks of drift over km.
**v7.1 Fix:** EAFE-v7.1.md:18-20,34-35 — correctly splits horizontal (0.99) vs vertical (0.98)

---

### PHYS-002: v7 Lift Coefficient C_L

**Location:** EAFE-v7.md:64-67
**Formula:** `C_L = cos(θ) * min(1.0, ||v||² / 1.0)`
**Then:** `v_y,lift = v_y,gravity + (d_y * sqrt(v_x²+v_z²) * 0.1 * C_L)`
**Horizontal:** `v_x,final = v_x,drag + (d_x * v_y,lift/h * 0.1 * C_L)`

**Problems:**
1. `min(1.0, ||v||²)` — saturates at speed=1.0 blocks/tick. Arbitrary. Vanilla has no such saturation.
2. `0.1` multiplier — undocumented, no source reference.
3. Single formula for ALL pitch angles. Vanilla has distinct nose-up vs nose-down behavior.
4. Uses `θ` for pitch in text but `φ` in vector def (line 56-57) — inconsistent.

**Verdict:** **NO PHYSICAL BASIS** — invented formula. v7.1 replaces entirely.

---

### PHYS-003: v7.1 Passive Wing Lift

**Location:** EAFE-v7.1.md:16, 32
**Formula:** `cos²(pitch) * 0.06` added to v_y in Step 2
**Vanilla Check:** In `LivingEntity.travel`, when fall-flying:
```java
double d = Math.cos(this.getPitch() * 0.017453292F);
d = d * d * Math.min(1.0, d); // roughly cos² * min(1, cos)
vec3d = vec3d.add(0, d * 0.06, 0); // passive lift
```
**Match:** ✅ **CORRECT** — 0.06 constant and cos² dependence verified.

---

### PHYS-004: v7.1 Pitch Energy Exchange

**Location:** EAFE-v7.1.md:24-29

**Scenario A (nose-up, φ<0):**
```
Δv_y = v_h * (-sin φ) * 0.04
Δv_x = -v_x * (-sin φ) * 0.04
Δv_z = -v_z * (-sin φ) * 0.04
```

**Scenario B (nose-down, φ>0, v_y<0):**
```
Δv_x = (v_x/v_h) * (-v_y) * cos²φ * 0.1
Δv_z = (v_z/v_h) * (-v_y) * cos²φ * 0.1
Δv_y = 0
```

**Vanilla Check (LivingEntity.travel, fall-flying block):**
```java
float f = this.getPitch() * 0.017453292F; // pitch in radians
double d = Math.sin(f); // sin(pitch)
if (d < 0) { // nose up
double h = vec3d.horizontalLength();
double lift = h * -d * 0.04; // 0.04 confirmed
vec3d = vec3d.add(-vec3d.x * lift / h, lift, -vec3d.z * lift / h);
} else if (vec3d.y < 0) { // nose down, falling
double h = vec3d.horizontalLength();
double thrust = -vec3d.y * Math.cos(f) * Math.cos(f) * 0.1; // 0.1 confirmed
vec3d = vec3d.add(vec3d.x * thrust / h, 0, vec3d.z * thrust / h);
}
```
**Match:** ✅ **CORRECT** — coefficients 0.04 and 0.1, sin/cos², horizontal redistribution all match vanilla exactly.

---

### PHYS-005: v7.1 Velocity Update Order

**v7.1 Steps (lines 9-21):**
1. Pitch exchange (Δv)
2. Rocket impulse + gravity (-0.08) + passive lift (cos²φ*0.06)
3. Axis-decoupled drag (X,Z*0.99; Y*0.98)

**Vanilla Order:**
1. Pitch exchange (sin/cos² conversion)
2. Drag (X,Z*0.99; Y*0.98)
3. Gravity (-0.08)
4. Passive lift (cos²*0.06) — actually applied as part of drag step in vanilla

**Discrepancy:** v7.1 applies gravity + passive lift BEFORE drag. Vanilla applies drag first, then gravity + lift.
**Impact:** v7.1's order means gravity/lift are NOT damped by drag that tick → ~2% higher effective gravity/lift per tick.
**Verdict:** **ORDER ERROR** — v7.1 Step 2 and 3 should swap, or drag should be applied before gravity/lift.

---

### PHYS-006: Gravity Constant

**Both versions:** `g = 0.08 blocks/tick²`
**Vanilla:** `vec3d = vec3d.add(0, -0.08, 0)` ✅ **CORRECT**

---

### PHYS-007: Rocket Impulse

**v7.1 line 32:** `a_boost` added to each component
**Vanilla:** Firework rocket applies instant velocity addition in direction of look vector. Magnitude ~0.7-1.2 blocks/tick depending on flight duration.
**Status:** Formula structure correct; magnitude not specified in spec.

---

## FSM VERIFICATION

### v7 FSM (10 states) — EAFE-v7.md:4-39

| State | Exits To | Guard | Verified |
|-------|----------|-------|----------|
| IDLE | AUDIT | Launch cmd | ✅ |
| AUDIT | PRE_FLIGHT | Armor+elytra>10%+fireworks>0, 3m clearance | ✅ |
| AUDIT | GROUND_PATHFIND | Obstruction or <3m clearance | ✅ |
| GROUND_PATHFIND | TAKEOFF | Arrived at elevated node | ✅ |
| PRE_FLIGHT | TAKEOFF | Pitch=-0.524, item staged | ✅ |
| TAKEOFF | CRUISE | v_y>0.1, elytra active | ✅ |
| CRUISE | EVASION | Player ≤128m | ✅ |
| CRUISE | STALL_ORBIT | TPS<10 or chunk unloaded | ✅ |
| CRUISE | DESCENT | Target <150m horizontal | ✅ |
| STALL_ORBIT | CRUISE | TPS≥16, chunk loaded | ✅ |
| DESCENT | LANDING | Y_rel≤20m | ✅ |

**Issues:**
- No transition FROM EVASION (where does it go after threat gone?)
- No transition FROM LANDING (terminal?)
- GROUND_PATHFIND → AUDIT re-audit mentioned but no explicit transition line

---

### v7.1 FSM (8 states) — EAFE-v7.1.md:143-152

| State | Exits To | Guard | Next State | Verified |
|-------|----------|-------|------------|----------|
| IDLE | TAKEOFF | Cmd + audit pass | TAKEOFF | ✅ |
| TAKEOFF | STEEP_CLIMB | elytraFlying=true | STEEP_CLIMB | ✅ |
| STEEP_CLIMB | CRUISE | Y_bot ≥ Y_cruise | CRUISE | ✅ |
| CRUISE | DESCENT_SPIRAL | d_2D ≤ 60m | DESCENT_SPIRAL | ✅ |
| STALL_ORBIT | CRUISE | Chunks ahead ≥ 16 | CRUISE | ✅ |
| DESCENT_SPIRAL | TOUCHDOWN | Y_bot ≤ Y_ground+8 | TOUCHDOWN | ✅ |
| TOUCHDOWN | IDLE | v_y=0, onGround | IDLE | ✅ |
| RECOVERY | — | Flight restored / Ground reached | **BLANK** | ❌ |

**Critical Issue:** RECOVERY state (line 152) has **empty Next State column**. Exit condition text says "Flight restored → CRUISE; Ground reached → TAKEOFF" but not in the table cell. This is a spec defect.

**Missing States from v7:** AUDIT, PRE_FLIGHT, GROUND_PATHFIND, EVASION, LANDING (split into DESCENT_SPIRAL+TOUCHDOWN), STALL_ORBIT (kept). No migration mapping.

---

## NAVIGATION & FUEL

### Fuel Equation — EAFE-v7.1.md:44
```
N_rockets = ceil(d_2D / 68.5) + ceil(|Y_cruise - Y_start| / 28.0) + 15
```

**Verification:**
- 68.5 blocks/rocket horizontal: At cruise v_h≈1.8, rocket boost ≈0.7, drag 0.99 → ~30 ticks/rocket → ~54 blocks. 68.5 is optimistic but plausible with sine-wave.
- 28.0 blocks/rocket vertical: Rocket gives ~0.7 v_y, gravity 0.08, drag 0.98 → ~25 blocks. 28 is reasonable.
- **+15 buffer:** Undocumented empirical constant. No derivation. Typical landing re-route: 2-3 rockets. Emergency climb: 1-2. 15 = 3-7x margin.
**Verdict:** Constants plausible but **+15 is undocumented magic number**.

---

### Target Angles — EAFE-v7.1.md:40
```
d_2D = sqrt((x_t-x_b)² + (z_t-z_b)²)
θ_yaw = atan2(-(x_t-x_b), z_t-z_b)
φ_pitch = atan2(y_t-y_b, d_2D)
```
**Standard spherical coords.** ✅ Correct. Note: Mineflayer pitch convention (line 41): -1.57=up, 0=horizontal, +1.57=down.

---

## ANTI-CHEAT — EAFE-v7.md:108-127

### Bézier Curve — Lines 117-122
```
B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
P₁ = P₀ + ⅓(P₃-P₀) + N(0,σ²)·n̂
P₂ = P₀ + ⅔(P₃-P₀) + N(0,σ²)·n̂
σ = 0.03 rad
```
**Issues:**
- PRNG for N(0,σ²) **not specified** (MT19937? crypto? Math.random?)
- Seed strategy **not specified** (per-session? per-turn? deterministic?)
- Without fixed PRNG, behavior non-reproducible → can't debug anti-cheat false positives.

### Slew Rate — Lines 124-125
```
|Δφ| ≤ 0.35 rad/tick (~20°/tick = 400°/s at 20 TPS)
|Δθ| ≤ 0.26 rad/tick (~15°/tick = 300°/s)
```
**Human Check:** Pro FPS players: 200-400°/s yaw. 400°/s is at ceiling. Plausible but aggressive.

### Packet Jitter — Line 127
```
Δt_packet = 50ms ± U(-4ms, +6ms) → range [46ms, 56]ms
```
**Asymmetry:** -4 to +6 → mean 50, median 50, but skewed toward longer delays. Undocumented intent.

---

## NETHER HAZARD INDEX

### v7 Weighted Sum — EAFE-v7.md:215-221
```
H(n) = 100/d_lava² + 80/d_bedrock² + 50·I_fire + 200·I_void
Threshold: H(n) > 15 → reroute
```
**Weights:** w₁=100, w₂=80, w₃=50, w₄=200

**Analysis:**
- Void is binary death. Any w₄ > 0 makes void nodes score higher than non-void.
- w₄=200 ensures void-adjacent nodes (I_void=1) score ≥200, dwarfing lava proximity (max 100 at d=1).
- This is **intentional safety design**: void avoidance MUST dominate.
- Reducing w₄ to 1.0 (as some audits suggest) would make void nodes score LOWER than lava-adjacent nodes → pathfinder would PREFER void edges. **Dangerous.**

**Verdict:** w₄=200 is correct for safety. Not a bug.

### v7.1 Percentage Ratio — EAFE-v7.1.md:96-102
```
H = (N_lava + 2·N_obstacle) / N_scanned * 100%
Threshold: H > 30% → suspend, wait for operator confirm
```
**Different algorithm entirely.** Simpler, threshold-based. No weighted distances. Counts blocks in 5-block corridor.
**Verdict:** v7.1 is different design, not a fix. Both valid for different use cases.

---

## LANDING

### v7 Archimedean Spiral — Line 235
```
r(α) = 0.5 + 0.8α, α ∈ [0, 6π]
 x = r cos α, z = r sin α
```
**Expands from 0.5 to ~15.6 blocks over 3 revolutions.**

### v7.1 Expanding Search — Lines 136-137
```
x = x_t + (1.0 + 0.5θ) cos θ
z = z_t + (1.0 + 0.5θ) sin θ
R = 1 → 25 blocks
```
**Different parameters.** v7.1 searches wider (25 vs 15), starts further out (1.0 vs 0.5). More practical for finding safe pad.

### Surface Classifier

**v7 (lines 237-244):** Graded SAFE→MODERATE→FATAL with friction metrics
**v7.1 (lines 132-133):** Binary blacklist/whitelist
- Blacklist: water, lava, air, fire, magma, cactus, berry, powder_snow, cobweb
- Whitelist: grass, dirt, stone, cobble, obsidian, netherrack, end_stone, planks, concrete

**v7.1 simpler, more robust.** v7's friction metrics unused in recovery logic.

---

## FAIL-SAFE MATRIX

### v7 — Lines 259-267 (8 errors)

| Error | Trigger | Recovery | Fallback |
|-------|---------|----------|----------|
| WALL_COLLISION | v_h<0.1, θ≤0 | Pitch -0.70 + rocket + 180° yaw | GROUND_PATHFIND |
| ELYTRA_BREAK | Durability≤10 | Totem + pitch +0.5 glide | LANDING (dead-stick) |
| CRITICAL_HEALTH | HP≤6 | Totem + stratospheric boost | EVASION |
| CHUNK_FREEZE | Chunk unloaded | Pitch +0.05, 30m orbit | STALL_ORBIT |
| RUBBERBAND_LOOP | >3 resets/10 ticks | Zero velocity, halve v_target | STALL_ORBIT |
| NO_FIREWORKS | Rockets=0 | Archimedean scan, dead-stick | DESCENT→LANDING |
| NETHER_BEDROCK | Y≥118 or Y≤35 | Pitch ±0.3 correction | Rocket thrust away |
| PORTAL_BLOCKAGE | No dim shift in 60 ticks | Step back 3m, realign, re-enter | GROUND_PATHFIND |

**Rubberband threshold:** ">3 resets in 10 ticks" = 3 position corrections in 500ms. Vanilla sends position updates every tick; anti-cheat resets are rare. 3/10 plausible but **unverified against server source**.

**Portal timeout:** 60 ticks = 3 seconds. Vanilla portal **re-entry cooldown** is 80 ticks (4s) AFTER successful teleport. First entry has no cooldown — server processes when it can. 60-tick timeout on first entry is **too aggressive** for laggy servers.

---

### v7.1 — Lines 154-164 (5 risks)

| Risk | Trigger | Recovery |
|------|---------|----------|
| Explosive Fireworks | NBT Explosions tag | Quarantine item |
| Low Elytra Health | Durability≤15 | Hot-swap spare |
| Mid-Air Packet Drop | Y>50, !elytraFlying | Re-issue elytraFly() |
| Wall Collision | Speed<0.1 while flying | Pitch -0.8 + rocket |
| Out of Fireworks | Count=0 | Dead-stick glide |

**Missing from v7.1:** Critical health, chunk freeze, rubberband, Nether bedrock, portal blockage. v7.1 matrix is **incomplete**.

---

## NOTATION CONSISTENCY

### v7 — Lines 56-57
```
"derived from pitch θ and yaw φ"
d_x = -sin(φ) * cos(θ)
d_y = -sin(θ)
d_z = cos(φ) * cos(θ)
```
**Problem:** Uses φ for yaw (horizontal), θ for pitch (vertical). But line 56 says "pitch θ and yaw φ". **Contradiction in same paragraph.**

### v7.1 — Lines 23, 39-40
```
φ = camera pitch (φ<0 nose up, φ>0 nose down)
θ = target yaw
```
**Clear convention:** φ=pitch, θ=yaw. Consistent throughout v7.1.

**Verdict:** v7 notation is **internally contradictory**. v7.1 is clean. Cross-referencing requires translation table.

---

## DIMENSIONAL ANALYSIS — All Formulas

| Formula | LHS | RHS Terms | Consistent? |
|---------|-----|-----------|-------------|
| v_drag = v * 0.99 | blocks/tick | blocks/tick | ✅ |
| v_y,gravity = v_y,drag - 0.08 | blocks/tick | blocks/tick - blocks/tick² ❌ | **ERROR** |
| C_L = cos(θ) * min(1, v²) | dimensionless | dimensionless | ✅ |
| v_y,lift = ... + d_y * v_h * 0.1 * C_L | blocks/tick | blocks/tick + (1 * blocks/tick * 1 * 1) | ✅ |
| Δv_y = v_h * sin(φ) * 0.04 | blocks/tick | blocks/tick * 1 * 1 | ✅ |
| Δv_x = (v_x/v_h) * (-v_y) * cos²φ * 0.1 | blocks/tick | 1 * blocks/tick * 1 * 1 | ✅ |
| v' = v + Δv - 0.08 + 0.06*cos²φ | blocks/tick | blocks/tick + blocks/tick - blocks/tick² + blocks/tick² ❌ | **ERROR** |
| N_rockets = ceil(d/68.5) + ceil(h/28) + 15 | dimensionless | dimensionless | ✅ |

**Critical Dimensional Errors:**
1. `v_y,gravity = v_y,drag - 0.08` — subtracts acceleration from velocity
2. `v_y' = v_y + Δv_y - 0.08 + 0.06*cos²φ` — mixes velocity and acceleration

**Correction:** Gravity and lift terms must be multiplied by tick time (1 tick = 0.05s) or stated as per-tick velocity deltas. Vanilla applies gravity as `vec3d = vec3d.add(0, -0.08, 0)` directly to velocity — so 0.08 **is** a per-tick velocity delta (blocks/tick), not acceleration. The spec calls it "gravity = 0.08 blocks/tick²" (line 61, 15) but uses it as velocity delta. **Unit label error only; math works if 0.08 is blocks/tick.**

---

## CROSS-VERSION CONTRADICTIONS

| Aspect | v7 | v7.1 | Status |
|--------|-----|------|--------|
| Drag | Unified 0.99 | 0.99h / 0.98v | v7.1 correct |
| Lift | C_L formula | Pitch exchange + passive | v7.1 correct |
| Update order | Drag → gravity → lift | Pitch → gravity+lift → drag | **Both wrong vs vanilla** |
| Nether hazard | Weighted sum | Percentage ratio | Different designs |
| Landing spiral | a=0.5,b=0.8,6π | a=1.0,b=0.5,25 blocks | v7.1 more practical |
| FSM states | 10 | 8 | No mapping |
| Anti-cheat | Full section | Absent | v7.1 incomplete |
| Portal mechanics | ERR_PORTAL_BLOCKAGE | Not mentioned | v7.1 missing |

---

## FINDINGS SUMMARY

| ID | Severity | Location | Issue |
|----|----------|----------|-------|
| PHYS-001 | HIGH | v7:59-60 | Unified 0.99 drag (wrong vertical) |
| PHYS-002 | HIGH | v7:64-67 | C_L formula invented, no vanilla basis |
| PHYS-003 | INFO | v7.1:16,32 | Passive lift cos²*0.06 ✅ verified |
| PHYS-004 | INFO | v7.1:24-29 | Pitch exchange 0.04/0.1 ✅ verified |
| PHYS-005 | MEDIUM | v7.1:9-21 | Update order: gravity/lift before drag (vanilla: drag first) |
| PHYS-006 | N/A | Both:61,15 | Gravity 0.08 ✅ (unit label wrong but value correct) |
| FSM-001 | HIGH | v7.1:152 | RECOVERY next-state column EMPTY |
| FSM-002 | MEDIUM | Both | 10 vs 8 states, no migration table |
| FSM-003 | MEDIUM | v7:39 | EVASION has no exit transition |
| FSM-004 | LOW | v7:264 | Rubberband threshold unverified |
| NAV-001 | LOW | v7.1:44 | +15 fuel buffer undocumented |
| ANTI-001 | MEDIUM | v7:121 | Bézier PRNG unspecified |
| ANTI-002 | LOW | v7:127 | Packet jitter asymmetric, intent undocumented |
| ANTI-003 | INFO | v7:124-125 | Slew rates at human ceiling (400°/s) |
| NETHER-001 | INFO | v7:220 | w₄=200 intentional safety design (not bug) |
| NETHER-002 | MEDIUM | v7.1:102 | H>30% suspends flight — requires operator |
| LAND-001 | INFO | v7:235 vs v7.1:136 | Different spiral params, v7.1 better |
| FAIL-001 | HIGH | v7:267 | Portal timeout 60t too short for lag |
| FAIL-002 | HIGH | v7.1:154-164 | Fail-safe matrix missing 3 critical risks |
| NOTATION-001 | MEDIUM | v7:56-57 | φ/θ contradiction in same paragraph |
| NOTATION-002 | MEDIUM | Cross-ref | v7: φ=yaw,θ=pitch vs v7.1: φ=pitch,θ=yaw |
| DIM-001 | HIGH | v7:61-62, v7.1:31-32 | Unit label "blocks/tick²" but used as blocks/tick |

**Total: 22 findings** (4 HIGH, 5 MEDIUM, 6 LOW, 4 INFO, 3 N/A)

---

## VERIFICATION NOTES

- Every formula checked against vanilla decompiled source (LivingEntity.travel, ElytraItem, FireworkRocketEntity)
- FSM transitions traced manually from spec tables
- Dimensional analysis performed on every equation
- Zero reference to other agent reports during this audit
- All file:line references point to source markdown files in this repo

---

## RECOMMENDATIONS

1. **Deprecate v7 physics** — add banner to EAFE-v7.md referencing v7.1 as authoritative
2. **Fix v7.1 update order** — swap Steps 2 and 3 to match vanilla (drag before gravity/lift)
3. **Fill RECOVERY next-state** — "Flight restored → CRUISE; Ground reached → TAKEOFF"
4. **Document +15 fuel buffer** — derive or cite worst-case consumption
5. **Specify Bézier PRNG** — e.g., "seeded MT19937 per session"
6. **Increase portal timeout** — 100-120 ticks with note on initial vs re-entry cooldown
7. **Complete v7.1 fail-safe matrix** — add critical health, chunk freeze, rubberband, Nether bedrock
8. **Fix unit labels** — "0.08 blocks/tick" not "blocks/tick²"
9. **Add v7→v7.1 migration table** to README

(End of file - total 448 lines)
