# EAFE Specification Analysis — Agent Comparison Report

**Agent:** opencode/nemotron-3-ultra-free
**Date:** 2026-07-26
**Model Version:** nemotron-3-ultra-free
**Task:** Analyze EAFE-v7, EAFE-v7.1, AUDIT.md, and mimo-v2.5-free's corrections report for accuracy, consistency, and completeness.

---

## Executive Summary

This report analyzes the EAFE (Autonomous Elytra Flight Engine) specification documents and the associated audit/corrections. I have reviewed:

1. **EAFE-v7.md** — Master Architecture Specification (267 lines)
2. **EAFE-v7.1.md** — Engineering Specification beta (164 lines)
3. **AUDIT.md** — Full Technical Audit (240 lines)
4. **mimo-v2.5-free-2026-07-26.md** — Agent corrections & evidence (156 lines)

---

## Document Relationships

```
EAFE-v7.md (reference/design)
    │
    ├── Superseded by physics in v7.1
    ├── Contains: FSM (10 states), anti-cheat, portal mechanics, Nether weighted hazards
    └── Referenced by AUDIT.md

EAFE-v7.1.md (production/authoritative)
    │
    ├── Physics: axis-decoupled drag (0.99h/0.98v), pitch energy exchange, passive wing lift
    ├── FSM: 8 states (RECOVERY incomplete)
    ├── Nether: percentage-based hazard index
    ├── Landing: expanding spiral search
    └── Referenced by AUDIT.md

AUDIT.md
    │
    ├── 23 findings total (2 HIGH, 5 MEDIUM, 9 LOW, 6 INFO, 1 N/A)
    ├── Categories: Physics, Consistency, FSM, Anti-Cheat, Edge Cases, Notation
    └── Cross-reference table mapping v7 issues → v7.1 status

mimo-v2.5-free report
    │
    ├── Re-verified 4 disputed findings with worked evidence
    ├── Confirmed 19 findings match spec text
    └── Focus: PHYS-002, EDGE-001, EDGE-003, ANTI-002, FSM-001
```

---

## Detailed Finding-by-Finding Analysis

### PHYS-001: Unified drag constant in v7 is incorrect

**AUDIT.md verdict:** HIGH — v7 applies 0.99 uniformly; vanilla uses 0.99 (X,Z) and 0.98 (Y)

**My verification:**
- **EAFE-v7.md line 60:** `v_drag = v_t * 0.99` (uniform)
- **EAFE-v7.1.md lines 18-20:** Horizontal ×0.99, Vertical ×0.98
- **EAFE-v7.1.md line 36:** "Critical Distinction: Horizontal drag (D_h = 0.99) and vertical drag (D_v = 0.98) are non-identical"

**Conclusion:** ✅ **AUDIT.md CORRECT** — v7.1 explicitly documents this as a correction to v7.

---

### PHYS-002: v7 lift coefficient formula has no physical basis

**AUDIT.md verdict:** HIGH — `C_L = cos(θ) * min(1.0, ||v||²/1.0)` is arbitrary; 0.1 scaling undocumented

**mimo-v2.5-free analysis:** Provided detailed breakdown showing v7's single formula vs v7.1's two scenarios (nose-up 0.04, nose-down 0.1) + passive lift `cos²φ × 0.06`

**My verification:**
- **EAFE-v7.md lines 64-67:** Single C_L formula feeding into lift redistribution
- **EAFE-v7.1.md lines 22-29:** Two explicit scenarios with different coefficients
- **EAFE-v7.1.md line 16:** "Add Passive Wing Lift (cos²(pitch) * 0.06)"
- **EAFE-v7.1.md line 32:** `v_y' = v_y + Δv_y - 0.08 + (cos²φ · 0.06) + a_boost,y`

**Conclusion:** ✅ **AUDIT.md CORRECT** — v7.1 supersedes with decomposed model matching vanilla decompilation. mimo-v2.5-free's evidence is thorough and accurate.

---

### PHYS-003: Passive wing lift present only in v7.1

**AUDIT.md verdict:** INFO — v7.1 adds `cos²φ × 0.06`, absent from v7

**My verification:** Confirmed — v7 has no passive lift term; v7.1 has it in Step 2 (line 16) and Step 2 equation (line 32).

**Conclusion:** ✅ **AUDIT.md CORRECT** — This is a correctness improvement in v7.1.

---

### PHYS-004: Pitch energy exchange differs between versions

**AUDIT.md verdict:** INFO — v7 uses single C_L; v7.1 splits nose-up (0.04) vs nose-down (0.1)

**My verification:** Matches spec text exactly.

**Conclusion:** ✅ **AUDIT.md CORRECT** — Documented difference, not a bug.

---

### CONSIST-001: Drag model contradicts between versions

**AUDIT.md verdict:** HIGH (subsumed by PHYS-001)

**Conclusion:** ✅ **AUDIT.md CORRECT** — Same finding as PHYS-001.

---

### CONSIST-002: Lift model superseded

**AUDIT.md verdict:** MEDIUM — v7 C_L replaced by v7.1 decomposed pitch exchange + passive lift

**Conclusion:** ✅ **AUDIT.md CORRECT** — Consistent with PHYS-002/PHYS-004.

---

### CONSIST-003: Gravity consistent

**AUDIT.md verdict:** N/A — Both use g = 0.08 blocks/tick²

**My verification:**
- **EAFE-v7.md line 61:** `g = 0.08 blocks/tick²`
- **EAFE-v7.1.md line 15:** `g = 0.08`

**Conclusion:** ✅ **AUDIT.md CORRECT**

---

### CONSIST-004: Velocity update ordering differs

**AUDIT.md verdict:** MEDIUM — v7: drag→gravity→lift; v7.1: pitch exchange→gravity+impulse+lift→drag

**My verification:**
- **EAFE-v7.md lines 59-67:** Drag first, then gravity, then lift redistribution
- **EAFE-v7.1.md lines 5-21:** 3-step loop — pitch exchange, then gravity+impulse+lift, then axis-decoupled drag

**Conclusion:** ✅ **AUDIT.md CORRECT** — Different order produces different numerical results even with same coefficients.

---

### CONSIST-005: Nether hazard model differs

**AUDIT.md verdict:** LOW — v7: weighted sum H(n) with w₁..w₄; v7.1: percentage ratio `(N_lava + 2·N_obstacle)/N_scanned × 100%`

**My verification:**
- **EAFE-v7.md lines 216-221:** `H(n) = w₁/d_lava² + w₂/d_bedrock² + w₃·I_fire + w₄·I_void`
- **EAFE-v7.1.md lines 96-102:** `H = (N_lava + 2·N_obstacle)/N_scanned × 100%`, threshold H > 30%

**Conclusion:** ✅ **AUDIT.md CORRECT** — Different algorithms, different behavior. v7.1 is simpler and threshold-based.

---

### FSM-001: RECOVERY state has no defined next-state

**AUDIT.md verdict:** MEDIUM — Next State column blank, exit condition text describes transitions but column empty

**mimo-v2.5-free evidence:** Line 152 shows table with 4 columns; RECOVERY row has text in Exit Condition but empty Next State cell.

**My verification:**
- **EAFE-v7.1.md line 152:** `| RECOVERY | Mid-air packet re-issue or emergency launch. | Flight restored → CRUISE; Ground reached → TAKEOFF | |`
- The table has 4 columns but RECOVERY row only has 3 data cells (last is empty)

**Conclusion:** ✅ **AUDIT.md CORRECT** — Table structure issue; next-state column should be filled.

---

### FSM-002: v7 has 10 states, v7.1 has 8 — no reconciliation

**AUDIT.md verdict:** LOW — No mapping table exists

**My verification:**
- v7: IDLE, AUDIT, PRE_FLIGHT, GROUND_PATHFIND, TAKEOFF, CRUISE, EVASION, DESCENT, LANDING, STALL_ORBIT (10)
- v7.1: IDLE, TAKEOFF, STEEP_CLIMB, CRUISE, STALL_ORBIT, DESCENT_SPIRAL, TOUCHDOWN, RECOVERY (8)

**Conclusion:** ✅ **AUDIT.md CORRECT** — Missing migration documentation.

---

### FSM-003: No IDLE recovery path from terminal states in v7.1

**AUDIT.md verdict:** LOW — Restates FSM-001

**Conclusion:** ✅ **AUDIT.md CORRECT** — Dependent on FSM-001 fix.

---

### FSM-004: v7 ERR_RUBBERBAND_LOOP threshold unverifiable

**AUDIT.md verdict:** LOW — "> 3 server position reset packets in 10 ticks" — plausible but not verifiable

**My verification:** **EAFE-v7.md line 264** — threshold stated as empirical. No vanilla source reference.

**Conclusion:** ✅ **AUDIT.md CORRECT** — Flagged appropriately as empirical.

---

### ANTI-001: PRNG for Bézier perturbation unspecified

**AUDIT.md verdict:** LOW — N(0, σ²) on P1, P2 with σ=0.03, no PRNG specified

**My verification:** **EAFE-v7.md lines 120-122** — No PRNG algorithm or seed strategy mentioned.

**Conclusion:** ✅ **AUDIT.md CORRECT** — Affects reproducibility for anti-cheat fingerprinting.

---

### ANTI-002: Packet jitter is asymmetric — verify intentional

**AUDIT.md verdict:** LOW — 50ms ± U(-4ms, +6ms) = [46ms, 56ms], biased toward longer delays

**mimo-v2.5-free evidence:** Confirmed asymmetry, noted center is 50ms, spread 10ms, shifted 1ms toward longer.

**My verification:** **EAFE-v7.md line 127:** `Δt_packet = 50ms ± U(-4ms, +6ms)`

**Conclusion:** ✅ **AUDIT.md CORRECT** — Asymmetric jitter documented but intent undocumented.

---

### ANTI-003: Slew rate limits — verify against human limits

**AUDIT.md verdict:** INFO — 0.35 rad/tick yaw (~400°/s), 0.26 rad/tick pitch (~300°/s) — upper end but plausible

**My verification:** **EAFE-v7.md lines 124-125** — Values match pro player flick-shot capabilities.

**Conclusion:** ✅ **AUDIT.md CORRECT** — Reasonable values.

---

### EDGE-001: Nether void weight disproportionate

**AUDIT.md verdict:** LOW — w₄=200 for void inflates H(n); any w₄>0 triggers avoidance

**mimo-v2.5-free worked example:**
- Scenario A (1 from lava): H = 100
- Scenario B (1 from void): H = 200
- Scenario C (1 from both): H = 300
- With w₄=1.0: void node H=1, lava node H=100 → pathfinder prefers void-adjacent!

**My verification:**
- **EAFE-v7.md lines 215-221:** `w₁=100, w₂=80, w₃=50, w₄=200`, threshold H(n)>15
- The high weight ensures void proximity ALWAYS dominates regardless of other hazards

**Conclusion:** ⚠️ **AUDIT.md RECOMMENDATION DEBATABLE** — mimo-v2.5-free correctly shows that reducing w₄ to 1.0 would make void nodes score LOWER than lava-proximate nodes, causing the pathfinder to PREFER void-adjacent routes. The high weight is likely INTENTIONAL to guarantee void avoidance. AUDIT.md's recommendation to reduce to 1.0 is dangerous.

---

### EDGE-002: Fuel safety buffer +15 undocumented

**AUDIT.md verdict:** LOW — Empirical constant, no derivation

**My verification:** **EAFE-v7.1.md line 44:** `+ 15` — "mandatory safety buffer reserved for landing re-routes and emergency climbs"

**Conclusion:** ✅ **AUDIT.md CORRECT** — Documented as empirical but no sensitivity analysis provided.

---

### EDGE-003: Portal blockage timeout 60 ticks vs vanilla 80-tick cooldown

**AUDIT.md verdict:** LOW — v7 uses 60 ticks; vanilla has 80-tick cooldown

**mimo-v2.5-free clarification:** 80-tick cooldown applies AFTER successful shift, not before first entry. v7 measures time from entry to dimension shift packet.

**My verification:**
- **EAFE-v7.md line 267:** "Portal collision frame fails to trigger dimension shift within 60 ticks"
- Vanilla portal cooldown: 80 ticks (4 seconds) before you can use a portal AGAIN after dimension shift
- First portal entry: server processes on its own timeline (1-5 seconds typically)

**Conclusion:** ⚠️ **AUDIT.md PARTIALLY INCORRECT** — mimo-v2.5-free correctly identifies that the 80-tick cooldown is for RE-ENTRY, not initial shift. v7's 60-tick timeout measures a different thing (time-to-shift-packet). However, 60 ticks (3 seconds) may still be too aggressive for laggy servers.

---

### EDGE-004: TPS threshold 12.0 — verify appropriateness

**AUDIT.md verdict:** INFO — 12 TPS = 40% lag tolerance; aggressive but reasonable for vanilla

**My verification:** Both v7 (lines 49, 152) and v7.1 (line 87) use 12.0.

**Conclusion:** ✅ **AUDIT.md CORRECT** — Documented as tunable default.

---

### EDGE-005: v7 landing spiral parameters differ from v7.1

**AUDIT.md verdict:** INFO — v7: a=0.5, b=0.8, α∈[0,6π]; v7.1: a=1.0, b=0.5, R=1→25 blocks

**My verification:**
- **EAFE-v7.md line 235:** `a = 0.5, b = 0.8, α ∈ [0, 6π]`
- **EAFE-v7.1.md lines 136-137:** `a = 1.0 and b = 0.5`, expanding radius search

**Conclusion:** ✅ **AUDIT.md CORRECT** — v7.1 uses more practical expanding search.

---

### NOTATION-001: Pitch/yaw symbol convention differs

**AUDIT.md verdict:** MEDIUM — v7: φ for both (context-dependent); v7.1: φ=pitch, θ=yaw

**My verification:**
- **EAFE-v7.md lines 56-57:** "derived from pitch θ and yaw φ" but then uses φ in d_x, d_z and θ in d_y
- **EAFE-v7.1.md lines 23, 39-40:** φ=pitch, θ=yaw explicitly

**Conclusion:** ✅ **AUDIT.md CORRECT** — Confusing cross-reference.

---

### NOTATION-002: v7 orientation vector definition ambiguous

**AUDIT.md verdict:** MEDIUM — Uses both θ and φ without clear labeling in definition

**My verification:** **EAFE-v7.md lines 56-57** — Claims "pitch θ and yaw φ" but formula uses φ for horizontal components.

**Conclusion:** ✅ **AUDIT.md CORRECT** — Internally consistent but conflicts with v7.1.

---

### NOTATION-003: Dimensional consistency check

**AUDIT.md verdict:** INFO — All formulas dimensionally consistent

**My verification:** Checked acceleration (blocks/tick²), velocity (blocks/tick), angles (rad), angular velocity (rad/tick) — all consistent.

**Conclusion:** ✅ **AUDIT.md CORRECT**

---

## Summary of Findings vs. mimo-v2.5-free

| Finding | AUDIT.md | mimo-v2.5-free | My Verdict |
|---------|----------|----------------|------------|
| PHYS-001 | HIGH | Verified | ✅ Correct |
| PHYS-002 | HIGH | Detailed evidence | ✅ Correct |
| PHYS-003 | INFO | Verified | ✅ Correct |
| PHYS-004 | INFO | Verified | ✅ Correct |
| CONSIST-001 | HIGH | Verified | ✅ Correct |
| CONSIST-002 | MEDIUM | Verified | ✅ Correct |
| CONSIST-003 | N/A | Verified | ✅ Correct |
| CONSIST-004 | MEDIUM | Verified | ✅ Correct |
| CONSIST-005 | LOW | Verified | ✅ Correct |
| FSM-001 | MEDIUM | Verified | ✅ Correct |
| FSM-002 | LOW | Verified | ✅ Correct |
| FSM-003 | LOW | Verified | ✅ Correct |
| FSM-004 | LOW | Verified | ✅ Correct |
| ANTI-001 | LOW | Verified | ✅ Correct |
| ANTI-002 | LOW | Verified asymmetry | ✅ Correct |
| ANTI-003 | INFO | Verified | ✅ Correct |
| EDGE-001 | LOW | **Counter-evidence** | ⚠️ AUDIT recommendation dangerous |
| EDGE-002 | LOW | Verified | ✅ Correct |
| EDGE-003 | LOW | **Clarification** | ⚠️ AUDIT partially incorrect |
| EDGE-004 | INFO | Verified | ✅ Correct |
| EDGE-005 | INFO | Verified | ✅ Correct |
| NOTATION-001 | MEDIUM | Verified | ✅ Correct |
| NOTATION-002 | MEDIUM | Verified | ✅ Correct |
| NOTATION-003 | INFO | Verified | ✅ Correct |

---

## Corrections to AUDIT.md

### 1. EDGE-001 — Nether void weight (w₄=200)
**AUDIT.md says:** Reduce to w₄=1.0
**Correction:** DO NOT REDUCE. The high weight ensures void-adjacent nodes score higher than lava-adjacent nodes, guaranteeing avoidance. Reducing to 1.0 would make void nodes PREFERRED (H=1 vs H=100 for lava). The disproportionate weight is a SAFETY FEATURE, not a bug.

### 2. EDGE-003 — Portal timeout
**AUDIT.md says:** 60 ticks vs vanilla 80-tick cooldown — risk of pulling bot out
**Correction:** The 80-tick cooldown applies to RE-ENTRY after a successful dimension shift. v7's 60-tick timeout measures time from portal entry to dimension-shift packet arrival. Different metrics. However, 60 ticks (3s) may still be too short for high-latency servers — recommend increasing to 100-120 ticks with note about initial-entry vs re-entry distinction.

---

## Document Quality Assessment

### EAFE-v7.md
- **Role:** Reference/design document (NOT production-ready)
- **Completeness:** Comprehensive (9 sections, 267 lines)
- **Physics accuracy:** Known issues (unified drag, arbitrary C_L) — documented in AUDIT
- **Status:** Should carry deprecation notice pointing to v7.1

### EAFE-v7.1.md
- **Role:** Production/engineering specification
- **Physics accuracy:** Correct per vanilla decompilation
- **Incomplete areas:**
  - RECOVERY state next-state column empty (FSM-001)
  - No anti-cheat section (PRNG, jitter asymmetry undocumented)
  - No portal mechanics (EDGE-003 unaddressed)
  - Fuel buffer +15 still undocumented (EDGE-002)

### AUDIT.md
- **Quality:** Thorough, well-structured, 23 findings across 6 categories
- **Accuracy:** 21/23 findings verified correct; 2 need correction (EDGE-001, EDGE-003)
- **Cross-reference table:** Excellent — maps v7 issues to v7.1 status

### mimo-v2.5-free Report
- **Quality:** Excellent evidence-based verification
- **Value added:** Worked examples for EDGE-001, clarification on EDGE-003
- **Accuracy:** 100% on verified findings; correctly identified AUDIT.md issues

---

## Recommendations

### Immediate (v7.1 fixes)
1. **Fix FSM-001:** Fill RECOVERY next-state column: `Flight restored → CRUISE; Ground reached → TAKEOFF`
2. **Document EDGE-002:** Derive or document the +15 fuel buffer (landing re-routes: 2-3, emergency climbs: 1-2, margin: 10 → total 15)
3. **Address EDGE-003:** Increase portal timeout to 100-120 ticks; add note distinguishing initial-entry vs re-entry cooldown
4. **Add anti-cheat section:** Specify PRNG (e.g., seeded MT19937), document jitter asymmetry intent
5. **Add FSM migration table:** Map v7 states → v7.1 equivalents in README

### Documentation
1. **README.md** should note v7 is reference-only, v7.1 is authoritative
2. **AUDIT.md** should be updated with corrections for EDGE-001 and EDGE-003

---

## Scores

| Artifact | Completeness | Accuracy | Clarity | Overall |
|----------|-------------|----------|---------|---------|
| EAFE-v7.md | 9/10 | 6/10 | 8/10 | 7.5/10 |
| EAFE-v7.1.md | 7/10 | 9/10 | 9/10 | 8.5/10 |
| AUDIT.md | 10/10 | 9/10 | 10/10 | 9.5/10 |
| mimo-v2.5-free | 8/10 | 10/10 | 9/10 | 9/10 |

---

## Final Verdict

The EAFE documentation suite is **high quality** with a thorough audit that catches nearly all issues. The two corrections needed in AUDIT.md (EDGE-001, EDGE-003) are **safety-critical** — following AUDIT.md's original recommendations would introduce dangerous behavior (preferring void-adjacent paths, pulling bots out of portals prematurely).

**v7.1 is the authoritative physics model.** v7 should be explicitly deprecated. The FSM in v7.1 needs the RECOVERY state fixed before production use.

**mimo-v2.5-free's report is accurate and adds critical worked evidence** that corrects the audit on two points. This agent's analysis corroborates 21/23 findings and improves 2.