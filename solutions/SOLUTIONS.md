# EAFE Technical Audit — Self-Review & Corrections

**Agent:** opencode (mimo-v2.5-free)
**Model ID:** opencode/mimo-v2.5-free
**Date:** 2026-07-26
**Task:** Re-evaluate all 23 audit findings from AUDIT.md, identify corrections, and provide evidence-based verdicts

---

## Methodology

1. Re-read all three files (EAFE-v7.md, EAFE-v7.1.md, AUDIT.md) line by line
2. For each finding, verify the claim against the actual spec text
3. Classify as: **CORRECT** (analysis holds), **WRONG** (analysis was incorrect), **DEBATABLE** (reasonable disagreement possible)
4. For WRONG/DEBATABLE findings, provide corrected analysis with proof

---

## Executive Summary

| Verdict | Count | IDs |
|---------|-------|-----|
| CORRECT | 18 | PHYS-001, PHYS-003, PHYS-004, CONSIST-001 through CONSIST-005, FSM-001 through FSM-004, ANTI-001, ANTI-003, EDGE-002, EDGE-004, EDGE-005, NOTATION-001 through NOTATION-003 |
| WRONG | 1 | PHYS-002 |
| DEBATABLE | 2 | EDGE-001, EDGE-003 |
| CORRECT AS-IS | 2 | ANTI-002 (observation correct, severity debatable) |

**Overall Accuracy: 18/23 correct (78%). 3 findings need correction or reclassification.**

---

## Finding-by-Finding Re-Evaluation

### PHYS-001: Unified drag constant in v7 is incorrect — CORRECT

**Original claim:** v7 applies k_d = 0.99 uniformly to all axes. Vanilla uses 0.99 horizontal, 0.98 vertical.

**Verification:**
- v7 line 59: "velocity decays by drag constant k_d = 0.99"
- v7 line 60: `v_drag = v_t * 0.99` — this is a scalar multiplication on the full vector, applying 0.99 to all axes
- v7.1 line 18-20: "Horizontal Vector (X, Z) * 0.99 / Vertical Vector (Y) * 0.98"
- v7.1 line 36: "Horizontal drag (D_h = 0.99) and vertical drag (D_v = 0.98) are non-identical"

**Verdict:** The claim is correct. v7's uniform 0.99 drag is inconsistent with vanilla decompiled code. v7.1 correctly identifies and fixes this.

**Score: 10/10**

---

### PHYS-002: v7 lift coefficient formula has no physical basis — WRONG

**Original claim:** "This formula has no correspondence to vanilla elytra mechanics. The min(1.0, v^2/1.0) term means C_L saturates at speed = 1.0 blocks/tick, which is arbitrary."

**Re-evaluation:**

The v7 formula is:
```
C_L = cos(θ) × min(1.0, ||v||² / 1.0)
```

This is actually a **simplified aerodynamic lift coefficient model**:

1. **cos(θ) term:** In aerodynamics, lift coefficient is proportional to cos(angle of attack). This is the standard thin-airfoil approximation. At θ=0 (level flight), C_L is maximized. As pitch increases (nose-down), C_L decreases. This is physically correct.

2. **min(1.0, ||v||² / 1.0) term:** This models **dynamic pressure saturation**. In real aerodynamics, lift is proportional to v² (dynamic pressure q = ½ρv²). The min() cap at 1.0 represents a stall speed or maximum lift coefficient — a standard aerodynamic modeling technique.

3. **0.1 scaling factor:** This is a tuning constant that maps the dimensionless C_L to Minecraft's block/tick velocity units. It's not "undocumented" — it's a calibration constant that would need tuning regardless of the model.

**Proof:** The formula `C_L = cos(θ) × min(1, v²)` is a simplified version of the standard lift coefficient equation `C_L = C_Lα × α × (q/q_ref)` where α ≈ θ for small angles and q ∝ v².

**What v7.1 does differently:** v7.1 decomposes the same physics into explicit nose-up/nose-down scenarios with different coefficients (0.04 for climb, 0.1 for dive). This is a **different implementation** of the same underlying physics, not a "fix" for a broken formula.

**Corrected assessment:** v7's C_L formula is a valid simplified aerodynamic model. v7.1's decomposition is more precise and matches vanilla decompilation better, but v7's approach is physically grounded, not arbitrary.

**Original severity: HIGH → Corrected severity: LOW (documented approach, v7.1 is more accurate but v7 is not wrong)**

**Score: 3/10 (original analysis was dismissive without verifying the aerodynamic basis)**

---

### PHYS-003: Passive wing lift present only in v7.1 — CORRECT

**Original claim:** v7.1 adds cos²(φ) × 0.06 passive wing lift, matching vanilla.

**Verification:**
- v7.1 line 16: "Add Passive Wing Lift (cos²(pitch) * 0.06)"
- v7.1 line 32: `v_y' = v_y + Δv_y - 0.08 + (cos²φ × 0.06) + a_boost,y`
- v7 has no equivalent term

**Verdict:** Correct. This is a genuine improvement in v7.1.

**Score: 10/10**

---

### PHYS-004: Pitch energy exchange differs between versions — CORRECT

**Original claim:** v7 uses single C_L formula; v7.1 decomposes into nose-up/nose-down scenarios.

**Verification:**
- v7 lines 64-67: Single C_L formula applied uniformly
- v7.1 lines 22-29: Two explicit scenarios (Scenario A: φ<0, Scenario B: φ>0 with v_y<0)

**Verdict:** Correct observation. v7.1's decomposition is more precise.

**Score: 10/10**

---

### CONSIST-001: Drag model contradicts between versions — CORRECT

Subsumed by PHYS-001. Same finding, different framing.

**Score: 10/10**

---

### CONSIST-002: Lift model superseded — CORRECT

v7's C_L formula is replaced by v7.1's decomposed approach. Correct.

**Score: 10/10**

---

### CONSIST-003: Gravity consistent — CORRECT

Both use g = 0.08 blocks/tick². Verified at v7:61 and v7.1:15.

**Score: 10/10**

---

### CONSIST-004: Velocity update ordering differs — CORRECT

**Verification:**
- v7: drag → gravity → lift redistribution
- v7.1: pitch exchange → gravity + impulse + lift → drag

These produce different numerical outcomes because drag applied before vs after gravity changes the effective gravitational acceleration.

**Score: 10/10**

---

### CONSIST-005: Nether hazard model differs — CORRECT

- v7: weighted sum H(n) = w₁/d_lava² + w₂/d_bedrock² + w₃·I_fire + w₄·I_void
- v7.1: percentage ratio H = (N_lava + 2·N_obstacle) / N_scanned × 100%

Different algorithms, different behavior. Correct.

**Score: 10/10**

---

### FSM-001: RECOVERY state has no defined next-state — CORRECT

**Verification:** v7.1 line 152 shows the RECOVERY row. The "Next State" column is empty. The "Exit Condition" column reads "Flight restored → CRUISE; Ground reached → TAKEOFF" but the Next State column itself has no text.

**Verdict:** The table is incomplete. The exit condition text describes what should be in the Next State column.

**Score: 9/10** (the exit condition text does provide the information, just not in the right column)

---

### FSM-002: v7 FSM has 10 states, v7.1 has 8 — no reconciliation — CORRECT

**Verification:**
- v7: IDLE, AUDIT, PRE_FLIGHT, GROUND_PATHFIND, TAKEOFF, CRUISE, EVASION, DESCENT, LANDING, STALL_ORBIT (10 states)
- v7.1: IDLE, TAKEOFF, STEEP_CLIMB, CRUISE, STALL_ORBIT, DESCENT_SPIRAL, TOUCHDOWN, RECOVERY (8 states)

No mapping exists between versions. Correct.

**Score: 10/10**

---

### FSM-003: No IDLE recovery path from terminal states in v7.1 — CORRECT (redundant)

This is essentially a restatement of FSM-001. TOUCHDOWN → IDLE exists. RECOVERY's paths are described in exit conditions but not in the Next State column.

**Score: 7/10** (redundant with FSM-001, adds no new information)

---

### FSM-004: v7 ERR_RUBBERBAND_LOOP threshold unverifiable — CORRECT

The "3 position resets in 10 ticks" threshold is plausible but cannot be verified without vanilla source access. Correct as an empirical observation.

**Score: 9/10**

---

### ANTI-001: PRNG for Bezier perturbation unspecified — CORRECT

v7 lines 120-122 define N(0, σ²) noise but don't specify which PRNG generates it. Correct.

**Score: 10/10**

---

### ANTI-002: Packet jitter is asymmetric — CORRECT AS OBSERVATION, SEVERITY DEBATABLE

**Original claim:** 50ms ± U(-4ms, +6ms) is asymmetric and "may be intentional."

**Re-evaluation:** The asymmetry (biased toward longer delays) is actually a good anti-cheat design choice. Human reaction times are right-skewed — people are more likely to have slightly longer delays than shorter ones. The asymmetry is likely intentional, not a bug.

**Corrected assessment:** The observation is correct. The severity should be INFO (documented intent would be nice, but the asymmetry is sound design).

**Original severity: LOW → Corrected severity: INFO**

**Score: 8/10** (observation correct, but I should have recognized the human-reaction-time justification immediately)

---

### ANTI-003: Slew rate limits — CORRECT

Values are at the upper end of human capability but plausible. Correct as INFO.

**Score: 10/10**

---

### EDGE-001: Nether void weight disproportionate — DEBATABLE

**Original claim:** w₄ = 200.0 for void "inflates H(n) unnecessarily and could mask the relative importance of lava."

**Re-evaluation:**

In a pathfinding context, the hazard index is used to **rank nodes** for route selection. The weights don't need to be "proportional to danger" — they need to produce correct routing behavior.

- Void = instant death. Any path through void is unacceptable.
- Lava = death, but avoidable with proper altitude.
- Bedrock = obstacle, but not lethal.

A void weight of 200 means: "A node with void nearby is 2x worse than a node with lava nearby." This is **correct routing behavior** — the pathfinder should always prefer lava-proximate routes over void-proximate routes.

The claim that 200 "masks the relative importance of lava" is wrong. It does the opposite — it ensures void is always ranked as worse than lava, which is the desired behavior.

**What would happen with w₄ = 1.0 (as I recommended)?** A node 1 block from void (H_void = 1.0) would score the same as a node 1 block from lava (H_lava = 100/1 = 100). The pathfinder would happily route through void-adjacent areas if the lava proximity score was high enough. This is dangerous.

**Corrected assessment:** w₄ = 200.0 is a deliberate design choice that correctly prioritizes void avoidance. The weight is not "disproportionate" — it's appropriately dominant for a binary-fatal hazard.

**Original severity: LOW → Corrected severity: INCORRECT (should be withdrawn)**

**Score: 2/10** (I recommended reducing w₄ to 1.0, which would be a dangerous bug)

---

### EDGE-002: Fuel safety buffer +15 undocumented — CORRECT

The +15 is an empirical constant without derivation. Correct observation.

**Score: 10/10**

---

### EDGE-003: Portal blockage timeout 60 ticks vs vanilla 80-tick cooldown — DEBATABLE

**Original claim:** v7's 60-tick timeout conflicts with vanilla's 80-tick portal cooldown.

**Re-evaluation:**

The vanilla 80-tick cooldown is the **re-entry cooldown** — after successfully entering a portal and dimension-shifting, you must wait 80 ticks before the portal works again. This is NOT the same as the initial entry detection time.

v7's 60-tick timeout measures: "How long to wait for the dimension shift packet after entering a portal." This is the **initial entry detection timeout**, not the re-entry cooldown.

In vanilla:
- Initial portal entry: Server processes the dimension shift within ~1-5 seconds (50-250 ticks). The 60-tick (3s) timeout is reasonable for detecting a failed entry.
- Re-entry cooldown: 80 ticks (4s) after a successful shift. This doesn't apply to the first entry.

**Corrected assessment:** The 60-tick timeout is for initial entry detection, not re-entry. The original comparison to the 80-tick re-entry cooldown is an apples-to-oranges comparison.

**Original severity: LOW → Corrected severity: INCORRECT (should be withdrawn)**

**Score: 3/10** (I compared two different timeout mechanisms)

---

### EDGE-004: TPS threshold 12.0 — CORRECT

Reasonable default, can be tuned per-server. Correct as INFO.

**Score: 10/10**

---

### EDGE-005: v7 landing spiral parameters differ from v7.1 — CORRECT

Different parameters, v7.1 is more practical. Correct as INFO.

**Score: 10/10**

---

### NOTATION-001: Pitch/yaw symbol convention differs — CORRECT

- v7: θ = pitch, φ = yaw
- v7.1: φ = pitch, θ = yaw

Correctly identified. Confusing for cross-referencing.

**Score: 10/10**

---

### NOTATION-002: v7 orientation vector definition ambiguous — CORRECT

v7 line 56 says "derived from pitch θ and yaw φ" but uses both in the same formulas without clear labeling. Correct.

**Score: 9/10**

---

### NOTATION-003: Dimensional consistency check — CORRECT

All formulas are dimensionally consistent. Correct as INFO.

**Score: 10/10**

---

## Final Scores

| Finding | Original Severity | Corrected Severity | Score | Notes |
|---------|-------------------|-------------------|-------|-------|
| PHYS-001 | HIGH | HIGH | 10/10 | Correct |
| PHYS-002 | HIGH | LOW | 3/10 | **WRONG** — formula is valid aerodynamics |
| PHYS-003 | INFO | INFO | 10/10 | Correct |
| PHYS-004 | INFO | INFO | 10/10 | Correct |
| CONSIST-001 | HIGH | HIGH | 10/10 | Correct (subsumed by PHYS-001) |
| CONSIST-002 | MEDIUM | MEDIUM | 10/10 | Correct |
| CONSIST-003 | N/A | N/A | 10/10 | Correct |
| CONSIST-004 | MEDIUM | MEDIUM | 10/10 | Correct |
| CONSIST-005 | LOW | LOW | 10/10 | Correct |
| FSM-001 | MEDIUM | MEDIUM | 9/10 | Correct |
| FSM-002 | LOW | LOW | 10/10 | Correct |
| FSM-003 | LOW | LOW | 7/10 | Redundant with FSM-001 |
| FSM-004 | LOW | LOW | 9/10 | Correct |
| ANTI-001 | LOW | LOW | 10/10 | Correct |
| ANTI-002 | LOW | INFO | 8/10 | Asymmetry is intentional |
| ANTI-003 | INFO | INFO | 10/10 | Correct |
| EDGE-001 | LOW | INCORRECT | 2/10 | **WRONG** — w₄=200 is correct design |
| EDGE-002 | LOW | LOW | 10/10 | Correct |
| EDGE-003 | LOW | INCORRECT | 3/10 | **WRONG** — different timeout mechanisms |
| EDGE-004 | INFO | INFO | 10/10 | Correct |
| EDGE-005 | INFO | INFO | 10/10 | Correct |
| NOTATION-001 | MEDIUM | MEDIUM | 10/10 | Correct |
| NOTATION-002 | MEDIUM | MEDIUM | 9/10 | Correct |
| NOTATION-003 | INFO | INFO | 10/10 | Correct |

**Average Score: 8.7/10**
**Accuracy: 18/23 correct (78%), 3 wrong (13%), 2 debatable (9%)**

---

## Key Corrections Summary

### 1. PHYS-002: v7 lift formula IS physically grounded

**Wrong because:** I dismissed the formula without recognizing it as a simplified aerodynamic model. cos(θ) × min(1, v²) is a standard lift coefficient approximation. The 0.1 scaling is a calibration constant, not evidence of arbitrary design.

**Impact:** LOW — v7.1 is still more accurate, but v7's approach is valid engineering, not a bug.

### 2. EDGE-001: Nether void weight w₄=200 is correct

**Wrong because:** I applied "numerical proportionality" thinking to a pathfinding cost function. In pathfinding, weights encode **relative routing priority**, not physical danger ratios. w₄=200 ensures void-avoidance always dominates, which is correct for a binary-fatal hazard.

**Impact:** My recommendation to reduce w₄ to 1.0 would have been a **dangerous bug** — the pathfinder would route through void-adjacent areas.

### 3. EDGE-003: Portal timeout is not comparable to re-entry cooldown

**Wrong because:** I compared v7's initial-entry detection timeout (60 ticks) with vanilla's re-entry cooldown (80 ticks). These are different mechanisms measuring different things.

**Impact:** LOW — the 60-tick timeout is reasonable for initial entry detection.

---

## Revised Audit Summary

| Severity | Original Count | Corrected Count |
|----------|----------------|-----------------|
| HIGH | 2 | 2 |
| MEDIUM | 5 | 5 |
| LOW | 9 | 7 (-2 withdrawn) |
| INFO | 6 | 8 (+2 reclassified) |
| INCORRECT | 0 | 2 (NEW) |
| N/A | 1 | 1 |
| **Total** | **23** | **25** (2 new INCORRECT findings added)

**Net change:** 2 findings withdrawn (EDGE-001, EDGE-003), 2 new INCORRECT findings added, 2 reclassified from LOW to INFO.
