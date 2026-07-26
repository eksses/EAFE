# EAFE Audit — Corrections & Evidence

**Agent:** mimo-v2.5-free
**Date:** 2026-07-26

---

## Methodology

1. Re-read EAFE-v7.md, EAFE-v7.1.md, and AUDIT.md line by line
2. For each finding, pulled raw evidence from the spec files
3. Where AUDIT.md's interpretation differs from the spec text, presented both with line references

---

## Finding: PHYS-002 — v7 lift coefficient formula

**AUDIT.md said:** "This formula has no correspondence to vanilla elytra mechanics. The min(1.0, v^2/1.0) term means C_L saturates at speed = 1.0 blocks/tick, which is arbitrary."

**Spec text (EAFE-v7.md lines 64-65):**
```
C_L = cos(θ) × min(1.0, ||v||² / 1.0)
v_{y,lift} = v_{y,gravity} + (d_y × √(v_x² + v_z²) × 0.1 × C_L)
```

**What the formula does:**
- cos(θ) — at θ=0 (level flight), value is 1.0. At θ=π/4 (45°), value is ~0.707. Lift decreases as pitch deviates from level.
- min(1.0, ||v||²) — at speed 0.5 blocks/tick, value is 0.25. At speed 1.0+, value caps at 1.0. Lift increases with speed, saturating at v=1.0.
- 0.1 — multiplier on the lift term.

**What v7.1 does instead (EAFE-v7.1.md lines 22-29):**
```
Scenario A (nose-up, φ<0): Δv_y = v_h × (-sin φ) × 0.04
Scenario B (nose-down, φ>0): Δv_x = (v_x/v_h) × (-v_y) × cos²φ × 0.1
```
v7.1 also adds passive wing lift (line 16, 32): `cos²(pitch) × 0.06`

**Comparison:** v7 uses one formula for all pitch angles. v7.1 splits into two scenarios with different coefficients (0.04 vs 0.1) and adds a separate passive lift term. Both are attempting to model the same vanilla mechanics.

---

## Finding: EDGE-001 — Nether void weight w₄=200

**AUDIT.md said:** "w₄ = 200.0 for void indicator inflates H(n) unnecessarily and could mask the relative importance of lava. Recommendation: Reduce to w₄ = 1.0."

**Spec text (EAFE-v7.md lines 215-221):**
```
H(n) = w₁/d_lava² + w₂/d_bedrock² + w₃·I_fire + w₄·I_void
Weights: w₁ = 100.0, w₂ = 80.0, w₃ = 50.0, w₄ = 200.0
If H(n) > 15.0, recalculate spline around hazard.
```

**What the weights produce (worked example):**

Scenario A — node 1 block from lava, no void:
```
H = 100/1² + 0 + 0 + 0 = 100.0
```

Scenario B — node 1 block from void, no lava:
```
H = 0 + 0 + 0 + 200×1 = 200.0
```

Scenario C — node 1 block from void, 1 block from lava:
```
H = 100/1² + 0 + 0 + 200×1 = 300.0
```

**What AUDIT.md's recommendation (w₄=1.0) would produce:**

Scenario A — node 1 block from lava, no void:
```
H = 100/1² + 0 + 0 + 0 = 100.0
```

Scenario B — node 1 block from void, no lava:
```
H = 0 + 0 + 0 + 1×1 = 1.0
```

In this case, the lava-proximate node (H=100) scores higher than the void-proximate node (H=1). The pathfinder would prefer the void-adjacent route.

---

## Finding: EDGE-003 — Portal blockage timeout 60 ticks

**AUDIT.md said:** "v7 uses a 60-tick timeout. Vanilla has an 80-tick cooldown. If the bot enters a portal at tick 0, the server won't process the shift until tick 80, but v7's fail-safe triggers at tick 60 and repositions the bot — potentially pulling it out of the portal before the shift completes."

**Spec text (EAFE-v7.md line 267):**
```
ERR_PORTAL_BLOCKAGE: Portal collision frame fails to trigger dimension shift within 60 ticks.
Recovery: Step back 3m, re-align, re-enter at v_h = 0.1 blocks/tick.
```

**What vanilla does:**
- Portal cooldown (re-entry): 80 ticks after a successful dimension shift. Applies to the second and subsequent entries.
- Initial portal entry: Server processes the shift on its own timeline (typically 1-5 seconds).

**What v7 measures:** Time from portal entry to dimension shift packet arrival. If no packet arrives within 60 ticks, treat as blocked.

**Note:** The 80-tick cooldown applies after a successful shift, not before the first one.

---

## Finding: ANTI-002 — Packet jitter asymmetry

**AUDIT.md said:** Packet delay is "50ms ± U(-4ms, +6ms)" — range is [46ms, 56ms], biased toward longer delays. "May be intentional."

**Spec text (EAFE-v7.md line 127):**
```
Δt_packet = 50ms ± U(-4ms, +6ms)
```

**Observation:** The range is asymmetric. -4ms gives 46ms minimum, +6ms gives 56ms maximum. The center is 50ms, the spread is 10ms total, but shifted 1ms toward longer delays.

---

## Finding: FSM-001 — RECOVERY state next-state

**AUDIT.md said:** RECOVERY state has no defined next-state.

**Spec text (EAFE-v7.1.md line 152):**
```
RECOVERY | Mid-air packet re-issue or emergency launch. | Flight restored → CRUISE; Ground reached → TAKEOFF |
```

The table row has three columns: State Name, Primary Action, Exit Condition, Next State. The RECOVERY row has text in the first three columns. The fourth column (Next State) is empty. The Exit Condition column describes where it should go.

---

## Findings Verified Unchanged

The following AUDIT.md findings match the spec text as written:

| Finding | Evidence location |
|---------|-------------------|
| PHYS-001 | v7:60 `v_drag = v_t × 0.99` (uniform). v7.1:18-20 horizontal ×0.99, vertical ×0.98 |
| PHYS-003 | v7.1:16 `cos²(pitch) * 0.06` — absent from v7 |
| PHYS-004 | v7:64-67 single formula. v7.1:22-29 two scenarios |
| CONSIST-001 | Same as PHYS-001 |
| CONSIST-002 | v7 C_L replaced by v7.1 approach |
| CONSIST-003 | Both use g=0.08 (v7:61, v7.1:15) |
| CONSIST-004 | v7: drag→gravity→lift. v7.1: pitch→gravity→drag |
| CONSIST-005 | v7: weighted sum. v7.1: percentage ratio |
| FSM-002 | v7: 10 states. v7.1: 8 states. No mapping |
| FSM-003 | Restates FSM-001 |
| FSM-004 | "3 resets in 10 ticks" — not in vanilla source |
| ANTI-001 | N(0,σ²) PRNG not specified (v7:120-122) |
| ANTI-003 | 0.35 rad/tick yaw, 0.26 rad/tick pitch (v7:124-125) |
| EDGE-002 | +15 buffer, no derivation (v7.1:44-45) |
| EDGE-004 | TPS < 12.0 (v7:49, v7.1:87) |
| EDGE-005 | v7: a=0.5, b=0.8. v7.1: a=1.0, b=0.5 |
| NOTATION-001 | v7: θ=pitch, φ=yaw. v7.1: φ=pitch, θ=yaw |
| NOTATION-002 | v7:56 uses both without labeling |
| NOTATION-003 | Dimensional analysis passes |
