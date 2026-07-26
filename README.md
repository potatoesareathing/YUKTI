# ಯುಕ್ತಿ YUKTI

**Yielding Unified Karnataka Trend Intelligence Platform**

Frontend for the Karnataka State Police / SCRB **Crime Intelligence & Analytical Platform (CIAP)**.
Built for the Hack2Skill Datathon 2026. Frontend only — the backend is a separate workstream.

*yukti* (ಯುಕ್ತಿ) is Kannada for **reasoning, deduction, ingenuity**. That is the product argument:
§10.3 of the technical solution document requires every AI/ML output to be a decision-support signal
with visible evidence, never an automated determination. So the platform's job is to make reasoning
visible, and every predictive surface exposes the records behind it.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run typecheck
```

Node 20+. No environment variables, no backend, no network calls at runtime — district boundaries are
served from `public/`.

### Useful URLs

| URL | What it shows |
|---|---|
| `/` | Three-act scroll narrative |
| `/?act=hotspots` · `/?act=network` | Deep-link into an act |
| `/?p=0.5` | Pin the narrative to a fixed point (screenshots, demos) |
| `/platform/geospatial` | MOD-01 — 3D map, hotspots, state→district→station drill-down |
| `…?district=Bengaluru Urban&station=0` | Open a drill-down tier directly |
| `/platform/network` | MOD-02 — live force graph, hover spotlight |
| `…?node=3` · `…?path=4` | Select an entity · trace a shortest path |
| `/platform/predictive` | MOD-03 — risk scoring, socio-economic overlay, anomaly call-outs |
| `/platform/trends` | MOD-04 — STL decomposition, CUSUM alerts |
| `/platform/behaviour` | MOD-05 — MO clusters, and `?view=offenders` for repeat-offender profiles |
| `/platform/intelligence` | MOD-06 — model portfolio, anomaly queue |

Keys **1–6** switch modules. **Esc** closes the evidence drawer.

---

## For the backend team

### One file to replace

`src/data/api.ts` is the only file that needs to change. Every function is already async and already
returns the §9 domain types from `src/data/types.ts`.

```ts
getDistricts()            → DistrictMetrics[]   // aggregate query over PostgreSQL / PostGIS
getIncidentsFiltered(f)   → Incident[]          // FIR query service; Elasticsearch for narratives
getGraph(rootId?, depth)  → GraphData           // Neo4j, §9.2 schema
getTimeSeries(cat, dist?) → TrendSeries         // precomputed STL + CUSUM output
getRiskScores()           → RiskScore[]         // gradient-boosted model serving endpoint
getAnomalies(limit)       → AnomalyFlag[]       // Isolation Forest serving endpoint
getModels()               → ModelCard[]         // MLflow registry
```

### The boundary is enforced, not just documented

Nothing under `src/platform`, `src/landing` or `src/three` imports a data module
directly — every one of them imports from `api.ts`. That is checkable:

```bash
grep -rn "from '@/data/" src/platform src/landing src/three | grep -v "data/\(api\|types\)'"
# → no output
```

Two shapes are exported, and the difference matters when wiring a real backend:

- **async** — the natural contract. Replace with a fetch and the UI is unchanged.
- **sync** — accessors the render path calls inside `useMemo`. They read from a
  cache that `loadPlatformData()` warms on mount. To back these with a network
  call, hydrate the cache in that loader and keep the accessors synchronous.

### Two contracts worth keeping

1. **`evidence` is non-optional** on `RiskScore` and `AnomalyFlag`. This makes an unexplainable score
   impossible to construct, which is §10.3 enforced by the type system rather than by convention.
   Please don't relax it to `evidence?`.

2. **Graph vocabulary is exactly §9.2.** Node kinds `Person | Incident | Location | Vehicle |
   Organisation`; edges `ACCUSED_IN | VICTIM_OF | WITNESSED | OCCURRED_AT | ASSOCIATED_WITH |
   SAME_MO_AS | MEMBER_OF | CO_ACCUSED_WITH`. Predicted links carry `predicted: true` and a
   `confidence`, and the UI renders them differently from observed edges on purpose.

### What the demo data is

All figures are **synthetic and seeded** — deterministic across reloads, so a judge sees the same
Kalaburagi score twice. Two things are real:

- **District boundaries.** 30 Karnataka districts, real polygons, projected through `d3-geo`
  Mercator. `public/data/karnataka-districts.geo.json`.
- **Census 2011 denominators.** Population, urbanisation, literacy per district, in
  `src/data/census.ts`. Crime counts only mean something against a real denominator — a raw count for
  Bengaluru Urban (9.6M) and Kodagu (554k) are not comparable.

The synthetic layer is *structured*, not noise: cyber fraud concentrates where urbanisation and
literacy are high, NDPS weights toward the coastal belt and state borders, and MO signatures are
weighted per district so clustering has something real to recover.

---

## Architecture

```
src/
  lib/          projection & extrusion (geo.ts), palette, seeded RNG, formatting
  data/         types (§9) · census · generators · api.ts ← the swap point
  store/        Zustand — selection, filters, layers, evidence drawer
  three/        Canvas, Districts, HotspotLayer, GraphView, StationMarkers, CameraRig, clock
  landing/      three-act scroll narrative over one continuous scene
  platform/     shell + six modules
  ui/           primitives, charts, instrument frame, evidence drawer
```

**Stack:** Vite · React 18 · TypeScript · React Three Fiber + drei · three.js · Tailwind v4 ·
Zustand · d3 (geo / scale / shape / force-3d).

### Things that are actually computed, not faked

Worth knowing, because they are the parts a reviewer is most likely to assume are decorative:

- **KDE** — a Gaussian kernel accumulated over a 224² grid and uploaded as a texture. Changing the
  bandwidth changes the estimate. Rendered as iso-contours, the way density is drawn on a survey
  sheet, rather than as a blur.
- **CUSUM** — a two-sided tabular CUSUM (slack `k = 0.5σ`, decision interval `h = 4.2σ`) over the STL
  residual, with the control limit estimated from an in-control baseline and a refractory period so a
  sustained shift raises one alert rather than nine. Every red zone traces to a signal from it.
- **PageRank** — iterated over the generated edge list (damping 0.85, 40 iterations). The "key
  individuals" MOD-02 highlights are the ones the graph really routes through.
- **Force layout** — `d3-force-3d` run to convergence, then normalised to the view by measuring the
  95th-percentile radius of the result.
- **Link prediction** — candidate pairs with no observed edge but ≥2 shared neighbours, ranked by
  shared-neighbour count. This is §7.2's "two suspects who have never appeared in the same FIR but
  share a common associate".
- **The coordinate readout** — the camera's look-at point inverted back through the same Mercator
  projection. It is where the instrument is actually pointed.

### Design system

Brass on ink, derived from Survey of India cartography, brass theodolites and KSP khaki — not from
screen conventions. Tokens live in `src/styles/globals.css` and are mirrored for three.js in
`src/lib/palette.ts`; change one and you must change the other.

The **risk ramp is sequential and monotonically lighter with magnitude** (OKLab L 0.411 → 0.706), so
the encoding survives greyscale, print and colour-blindness. The alert red `#FF3B2F` is deliberately
*not* the top of that ramp — it is a reserved status colour for a CUSUM breach and always ships with
a ▲ glyph and a text label.

Charts are single-series or small multiples by design, so no categorical palette is needed anywhere.

### Accessibility & i18n

Bilingual Kannada/English navigation (§13). `prefers-reduced-motion` respected in the DOM and inside
the 3D scene. Visible keyboard focus, keyboard module switching, dialog focus management on the
evidence drawer. Responsive to mobile, where Act I re-frames and the scrim goes near-solid.

---

## Known limits

- **Demo data is synthetic.** The UI labels it as such throughout. Predictive surfaces are labelled
  decision-support with evidence attached, per §15's model-bias risk — they must not be read as
  validated predictions.
- **`three` is ~970 kB (269 kB gzip).** It is code-split into its own chunk so it caches
  independently. Lazy-loading the platform route would trim first paint further.
- **No auth, no audit log.** §10.1 requires both. They belong server-side and are out of scope here;
  the evidence drawer's footer states the logging requirement rather than implementing it.

## Reference

Design spec: `docs/superpowers/specs/2026-07-25-yukti-frontend-design.md`
Source document: CIAP Technical Solution Document v1.0, July 2026. Section references throughout the
code (`§7.4`, `SEC 7.2`) point at it.
