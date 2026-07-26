# YUKTI — Frontend Design Spec

**Yielding Unified Karnataka Trend Intelligence Platform**
Frontend for the Karnataka State Police / SCRB Crime Intelligence & Analytical Platform (CIAP).
Date: 2026-07-25 · Hackathon: Hack2Skill Datathon 2026 · Frontend only.

---

## 1. Thesis

**ಯುಕ್ತಿ (yukti)** — Kannada/Sanskrit for *reasoning, deduction, ingenuity*. Not surveillance, not
prophecy. The source document (CIAP Technical Solution Document v1.0, §10.3) is explicit: every AI/ML
output is a **decision-support signal with visible evidence**, never an automated determination.

The frontend's job is therefore to **make reasoning visible**. Every predictive surface must expose the
records that produced it. This is the product argument and the design constraint at once.

### Visual world

Not cyberpunk. The aesthetic derives from where this product actually lives:

- **Survey of India / ISRO Bhuvan cartography** (§11) — graticules, contour plates, trig marks
- **Brass survey instruments** — the theodolite as interaction metaphor
- **KSP khaki** — the uniform, as the text colour
- **Station ledgers and FIR dockets** — the structural vocabulary being replaced

The product is an **instrument**, not a console.

---

## 2. Design system

### 2.1 Colour

```
--ink       #070A0F   page ground — blue-black, never pure black
--slate     #101823   panel surface
--rule      #1E2A38   hairlines, graticule, borders
--brass     #C9A227   PRIMARY accent — instrument brass / KSP insignia
--khaki     #DCD3BE   body text, warm off-white
--bhuvan    #4C9FC0   cool secondary data series, water, coordinate readouts
--redzone   #FF3B2F   RESERVED — statistically significant spikes only (§7.1)
```

**Risk ramp** (sequential, perceptually ordered, drawn from the palette — never rainbow):

```
#2E6F7E  →  #C9A227  →  #E4622F  →  #FF3B2F
low         moderate     high        critical
```

**Rule:** `--redzone` is data, not decoration. It appears only where §7.1 / §8 define a genuine
CUSUM/EWMA control-limit breach. It is never used for hover states, focus rings, or emphasis.

### 2.2 Typography

| Role | Face | Use |
|---|---|---|
| Display | Noto Serif Kannada | ಯುಕ್ತಿ — hero, act titles |
| Display (Latin) | IBM Plex Sans Condensed | section heads, module titles |
| Body | IBM Plex Sans | prose, descriptions |
| Data | IBM Plex Mono | coordinates, docket refs, all numerals in UI |

**The deliberate risk:** Kannada is the *primary* display voice; English annotates it. The hero sets
ಯುಕ್ತಿ at ~220px with `YUKTI` as small mono annotation beneath. Justification: §13 makes bilingual
Kannada/English a hard non-functional requirement, and the product is named in that language. This is
structural, not ornamental.

### 2.3 Structure

No `01 / 02 / 03` sequence markers — the content is not a sequence. Sections instead carry the **source
document's own references** (`SEC 7.2 · MOD-02`), because the site is that document made navigable.
Structure encodes a real fact about the content.

A live lat/long **graticule** frames the viewport and reads out the 3D camera's actual geographic
position. It is an instrument readout driven by real state, not a decorative frame.

### 2.4 Signature element

**The Karnataka instrument.** 30 real district polygons extruded to volumetric geometry on a dark
contour base plate, inside a brass graticule frame.

- height = incident volume
- colour = risk ramp
- rim = brushed brass emissive
- camera = constrained orbit, theodolite-like, with persistent coordinate readout

**The bold moment:** a time-sweep rakes west→east across the state; districts pulse as incidents fire
chronologically.

---

## 3. Information architecture

### 3.1 `/` — three-act scroll narrative

One continuous 3D scene; the camera does the storytelling.

| Act | Ref | Content |
|---|---|---|
| I | — | ಯುಕ್ತಿ. State rises from dark, towers grow, time-sweep runs. |
| II | SEC 7.1 | Camera dives to Bengaluru. KDE heat mesh, time-slider. |
| III | SEC 7.2 | Towers dissolve upward into the 3D link-analysis graph → ENTER PLATFORM |

### 3.2 `/platform` — the working product

Six modules per §3.1, sharing analytical services per §7.

| Ref | Module | Capability |
|---|---|---|
| MOD-01 | Geospatial | 3D drill-down state→district→station, hotspot layers |
| MOD-02 | Network | 3D force-directed graph, community detection, expand-from-node |
| MOD-03 | Predictive | risk gauges, socio-economic overlays, evidence drill-through |
| MOD-04 | Trends | STL decomposition, CUSUM spike alerts, red-zone triggers |
| MOD-05 | Behavioural | MO similarity clusters, repeat-offender timelines |
| MOD-06 | Intelligence | model portfolio status, anomaly queue, explainability |

**Cross-cutting requirement:** every AI-derived value renders with an **evidence affordance** that opens
the underlying records. This implements §10.3 in the UI and is the primary thing distinguishing YUKTI
from a generic analytics dashboard.

---

## 4. Technical architecture

**Stack:** Vite · React · TypeScript · React Three Fiber + drei · Tailwind v4 · Zustand · d3
(geo/scale/force-3d).

```
src/
  styles/globals.css      design tokens (@theme), font loading
  lib/                    geo projection, extrusion, colour ramp, seeded RNG, formatting
  data/                   deterministic synthetic data + api.ts swap point
  store/                  Zustand — camera target, filters, selection, act progress
  three/                  Canvas, KarnatakaMap, Towers, Graticule, Hotspots, Network3D, shaders
  landing/                three acts + scroll rig
  platform/               shell + six modules
  ui/                     Panel, Readout, Sparkline, RiskGauge, EvidenceDrawer, …
```

File discipline: 200–400 lines typical, 800 hard max. One purpose per module.

### 4.1 Data source

Real Karnataka district boundaries: 30 features, GeoJSON, ~5,800 coordinates — small enough to extrude
in real time without simplification. Districts include Bengaluru Urban, Bengaluru Rural, Kalaburagi,
Dakshina Kannada, Kodagu, Mysuru, Belagavi, and 23 others.

### 4.2 Backend contract

All synthetic data is **seeded and deterministic** (same render every reload — required for a
demo). It is isolated behind exactly one file:

```ts
src/data/api.ts        // ← the ONLY file the backend team replaces
  getDistricts()       → DistrictMetrics[]
  getIncidents(f)      → Incident[]
  getNetwork(rootId)   → { nodes: GraphNode[]; edges: GraphEdge[] }
  getTimeSeries(k)     → TrendSeries
  getRiskScores()      → RiskScore[]        // each carries evidence[] refs
```

Types mirror §9 of the source document exactly — entities `Person | Incident | Location | Vehicle |
Organisation`, relationships `ACCUSED_IN | VICTIM_OF | WITNESSED | OCCURRED_AT | ASSOCIATED_WITH |
SAME_MO_AS | MEMBER_OF | CO_ACCUSED_WITH`. Swapping to live APIs is a one-file change.

---

## 5. Quality floor

- Responsive to mobile; 3D degrades to a static composed frame below the interaction threshold
- `prefers-reduced-motion` respected — time-sweep and camera moves become instant cuts
- Visible keyboard focus; all module navigation keyboard-reachable
- Bilingual Kannada/English labels on primary navigation (§13)
- Target: first meaningful paint before geometry loads; dashboards interactive < 3s (§13)

## 6. Explicit non-goals

- No backend, no auth, no real API calls — a separate team owns these
- No real crime data. All figures are synthetic and labelled as such in the UI.
- Predictive surfaces are labelled decision-support with evidence visible, per §15 model-bias risk.
  The UI must not present synthetic scores as validated predictions.
