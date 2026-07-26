# EAFE Documentation Suite — Design Spec

**Date:** 2026-07-26
**Status:** Approved
**Scope:** Documentation and visualization for EAFE-v7 and EAFE-v7.1 autonomous elytra flight engine specs

## 1. Problem Statement

Two specification files exist (`EAFE-v7.md`, `EAFE-v7.1.md`) describing an autonomous Minecraft Elytra flight engine. They contain physics formulas, state machines, anti-cheat logic, and fail-safe matrices — but no README for GitHub, no human-friendly visualization, and no technical audit. The docs need:

- A **README.md** with inline formulas, diagrams, and project overview for GitHub
- An **HTML file** rendering both specs with MathJax/KaTeX for human browsing
- A **full technical audit** (`AUDIT.md`) verifying physics correctness, formula consistency, FSM completeness, and edge cases

## 2. File Structure

```
efly/
├── EAFE-v7.md          # Existing — v7.0 Master Architecture (unchanged)
├── EAFE-v7.1.md        # Existing — v7.1 Engineering Spec (unchanged)
├── README.md           # New — Project overview with inline formulas & diagrams
├── AUDIT.md            # New — Full technical audit findings
└── eafe-specs.html     # New — Interactive HTML rendering of both specs
```

Four new files total. The two existing spec files remain the canonical source of truth.

## 3. README.md Design

Detailed, self-contained project overview. GitHub renders `$...$` LaTeX natively.

### Sections

1. **Header & badges** — project name, version tags, license
2. **Overview** — what EAFE is (protocol-level navigation for autonomous elytra flight in Minecraft)
3. **Version table** — v7 vs v7.1 comparison (what each adds/changes)
4. **FSM State Diagram** — Mermaid `stateDiagram-v2` rendering the state machine
5. **Core Physics** — key formulas inline:
   - Velocity update loop (3-step from v7.1)
   - Axis-decoupled drag (0.99 horizontal, 0.98 vertical)
   - Gravity constant (0.08 blocks/tick²)
   - Passive wing lift (cos²φ × 0.06)
   - Fuel requirement equation
6. **Navigation** — target angle calculations, sine-wave cruise algorithm
7. **Anti-Cheat** — Bézier curve overview, slew rate limits
8. **Landing** — Archimedean spiral scan, surface classifier summary
9. **Fail-Safe Matrix** — condensed table of all error states and recovery protocols
10. **Links** — to full spec files

### Style

- GitHub-flavored Markdown with LaTeX math
- Mermaid diagrams for FSM and flow charts
- Tables for comparisons and matrices
- Concise but complete — someone should understand the project from README alone

## 4. AUDIT.md Design

Full technical audit reviewing both specs for correctness.

### Audit Categories

1. **Physics Correctness**
   - Verify drag constants match vanilla decompiled code
   - Check gravity value (0.08 blocks/tick²)
   - Validate lift formula against `LivingEntity.travel` decompilation
   - Cross-check v7 unified drag (0.99) vs v7.1 axis-decoupled drag (0.99h/0.98v)

2. **Formula Consistency (v7 vs v7.1)**
   - Identify contradictions between versions
   - Flag where v7.1 supersedes v7 formulas
   - Check dimensional analysis on all equations

3. **FSM Completeness**
   - Verify all state transitions have guard conditions
   - Check for unreachable states
   - Verify all states have exit conditions
   - Flag RECOVERY state with blank next-state in v7.1

4. **Anti-Cheat Logic**
   - Bézier control point perturbation — PRNG/seed strategy undefined
   - Slew rate limits — verify they match human player bounds
   - Packet jitter range (50ms ± U(-4ms, +6ms)) — verify non-symmetric jitter is intentional

5. **Edge Cases & Missing Failure Modes**
   - Nether hazard weight w_4=200 for void — disproportionate vs binary outcome
   - Fuel formula safety buffer (+15) — undocumented empirical constant
   - Portal blockage timeout (60 ticks) — verify matches vanilla portal mechanics
   - TPS threshold (12.0) — verify aligns with common server configs

6. **Mathematical Notation**
   - Verify all LaTeX compiles correctly
   - Check notation consistency (φ vs θ for pitch, ψ vs φ for yaw)
   - Flag ambiguous variable names

### Output Format

Each finding gets:
- **ID** (e.g., PHYS-001)
- **Severity** (CRITICAL / HIGH / MEDIUM / LOW)
- **Location** (file:line reference)
- **Description** of the issue
- **Recommendation** for fix

## 5. eafe-specs.html Design

Single self-contained HTML file. No build step. Loads libraries from CDN.

### Dependencies (CDN)

- **KaTeX** v0.16.x — math rendering (faster than MathJax)
- **Mermaid.js** v10.x — state diagrams and flow charts
- No other dependencies

### Layout

```
┌─────────────────────────────────────────────────┐
│  EAFE Specs    [v7] [v7.1] [Audit]   [🌙/☀️]   │
├──────────┬──────────────────────────────────────┤
│ TOC      │  Content Area                        │
│          │                                      │
│ §1 FSM   │  Renders current selected spec       │
│ §2 Phys  │  with KaTeX math, Mermaid diagrams,  │
│ §3 Nav   │  collapsible sections, tables        │
│ §4 Anti  │                                      │
│ §5 Land  │                                      │
│ §6 Fail  │                                      │
│          │                                      │
└──────────┴──────────────────────────────────────┘
```

### Features

- **Sidebar TOC** — collapsible, mirrors section structure of each spec
- **Tab navigation** — switch between v7, v7.1, and Audit views
- **Dark/light theme toggle** — CSS custom properties, persists to localStorage
- **Responsive** — sidebar collapses to hamburger on mobile
- **KaTeX auto-render** — processes all `$...$` and `$$...$$` blocks
- **Mermaid init** — renders all ```mermaid code blocks as diagrams
- **Collapsible sections** — each major section can expand/collapse
- **Side-by-side comparison** — where v7 and v7.1 overlap, show both formulas

### Styling

- Minimal, clean design — system fonts, good whitespace
- Dark theme: `#1a1a2e` background, `#e0e0e0` text
- Light theme: `#ffffff` background, `#1a1a1a` text
- Monospace for code/formulas in tables
- Color-coded severity badges in audit section

## 6. Implementation Order

1. **AUDIT.md** — run the technical audit first (findings inform what README highlights)
2. **README.md** — write with audit insights integrated
3. **eafe-specs.html** — build the HTML renderer last (depends on final MD content)

## 7. Evaluation Criteria

- All LaTeX formulas compile in KaTeX
- All Mermaid diagrams render correctly
- Audit covers all 9 sections of v7 and all 7 sections of v7.1
- README is self-contained — understandable without reading full specs
- HTML works in modern browsers (Chrome, Firefox, Safari, Edge)
- No broken links between files
