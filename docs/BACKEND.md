# YUKTI — Backend Build Guide

Everything the backend needs to build so the existing frontend works against real data,
with nothing on the UI side changing.

**Read this first:** the frontend is already complete and already calls a single module.
Your job is to reimplement that one module against real services. You do **not** need to
touch any component, any 3D scene, or any chart.

---

## 1. The contract

`src/data/api.ts` is the only file the UI imports data from. That is enforced, not just
documented — this returns nothing:

```bash
grep -rn "from '@/data/" src/platform src/landing src/three | grep -v "data/\(api\|types\)'"
```

Everything under `src/data/` other than `api.ts` and `types.ts` is a synthetic generator.
Delete it once real services exist.

### 1.1 Two shapes, and why it matters

| Shape | Functions | How to replace |
|---|---|---|
| **async** | `getRiskScores`, `getAnomalies`, `getIncidents`, `getStations`, `getGraph`, `getTimeSeries`, `getModels`, `getDistricts`, `getIncidentsFiltered` | Swap the body for a `fetch`. Nothing else changes. |
| **sync** | `getDistrictMetrics`, `stateTotals`, `getNetwork`, `getCommunities`, `getModelCards`, `getCategorySeries`, `getDistrictSeries`, `getActiveAlerts`, `getOffenderProfiles`, `peekStations`, `getDistrictFlows` | Called inside React `useMemo` on the render path. Keep them synchronous. Hydrate a module-level cache inside `loadPlatformData()` and have these read it. |

`loadPlatformData()` is awaited once when the platform mounts. Put every warm-up fetch
there. If a sync accessor is called before its cache is warm it returns an empty array and
the module renders as though there were no data — so `loadPlatformData()` must resolve
before the platform paints, or the accessors must tolerate an empty first read (they
currently do; the UI shows loading states).

### 1.2 Every function, with its service

```ts
// ─── Aggregates ────────────────────────────────────────────────────────────
getDistricts()              → DistrictMetrics[]   // 30 rows, one per district
getDistrictMetrics()        → DistrictMetrics[]   // sync mirror of the above
stateTotals()               → { incidents, byCategory, redZones, stations, avgClearance }
volumeScale()               → (n: number) => number   // 0..1 for tower height

// ─── Records ───────────────────────────────────────────────────────────────
getIncidents()              → Incident[]          // geo-tagged sample for the map
getIncidentsFiltered(f)     → Incident[]          // f: IncidentFilter
getStations()               → StationMetrics[]    // police stations, MOD-01 tier 3
peekStations(district?)     → StationMetrics[]    // sync cache read

// ─── Graph (§9.2 Neo4j) ────────────────────────────────────────────────────
getNetwork()                → GraphData           // { nodes, edges }
getGraph(rootId?, depth?)   → GraphData           // ego subgraph
getCommunities()            → Community[]         // Louvain output
getOffenderProfiles()       → OffenderProfile[]   // repeat-offender tracking
shortestPath(a, b)          → PathResult | null   // pure, runs client-side
commonNeighbours(a, b)      → GraphNode[]         // pure, runs client-side

// ─── Time series ───────────────────────────────────────────────────────────
getCategorySeries(cat)      → TrendSeries         // state-wide, STL + CUSUM
getDistrictSeries(dist,cat) → TrendSeries
getActiveAlerts(weeks)      → { series, at, index }[]

// ─── Model outputs ─────────────────────────────────────────────────────────
getRiskScores()             → RiskScore[]         // gradient-boosted, per district
getAnomalies(limit)         → AnomalyFlag[]       // Isolation Forest
getModels() / getModelCards() → ModelCard[]       // MLflow registry
```

Full field-level types are in **`src/data/types.ts`**. Treat that file as the schema
contract — do not change it without telling the frontend.

### 1.3 Two rules that are not negotiable

**1. `evidence` is non-optional** on `RiskScore` and `AnomalyFlag`.

```ts
export interface RiskScore {
  district: string
  score: number                  // 0..1, RELATIVE to the state
  band: 'low' | 'moderate' | 'high' | 'critical'
  drivers: { feature: string; contribution: number }[]
  evidence: Evidence[]           // ← never optional
  horizonDays: number
}
```

CIAP §10.3 requires that every model output surfaced to an investigator links back to the
records that produced it. Making `evidence` required means an unexplainable score is
impossible to construct — the type system enforces the policy. Do not relax it to
`evidence?`. If you cannot produce evidence for a score, do not return the score.

**2. Predicted links are flagged.** `GraphEdge.predicted: true` plus a `confidence`. The UI
renders predictions in brass, off by default, labelled as hypotheses. If a GraphSAGE
suggestion arrives without that flag it will be drawn as a recorded association — claiming
evidence that does not exist.

---

## 2. Mapping the KSP schema to these types

The ER diagram (`Police_FIR_ER_Diagram.pdf`) is richer than the placeholder types. Mapping:

| KSP table | Frontend type | Notes |
|---|---|---|
| `CaseMaster` | `Incident` | `CaseMasterID`→`id`, `CrimeNo`→`docket`, `CrimeRegisteredDate`→`at` |
| `Accused` / `Victim` | `Person` + role | §9.1: role is per-incident, never a person attribute |
| `ComplainantDetails` | `Person` (role: complainant) | |
| `Unit` (UnitType = station) | `StationMetrics` | `UnitID`→station id |
| `District` | `DistrictMetrics.name` | join to Census for denominators |
| `CrimeHead` + `CrimeSubHead` | `CrimeCategory` | **two-level; the type is currently flat — see below** |
| `CaseStatusMaster` | `Incident.status` | |
| `ChargesheetDetails` | clearance rate | makes MOD-04's clearance real |
| `ArrestSurrender` | offender timeline | strengthens MOD-05 |
| `GravityOffence` | *no home yet* | **strong risk feature — see below** |
| `Employee` + `Rank` | `Incident.officer` | |
| `Act` / `Section` | *not surfaced* | candidate for the evidence drawer |

### Two schema changes worth proposing to the frontend

1. **Crime taxonomy is two-level.** `CrimeCategory` is a flat union of 8 strings. The real
   schema has `CrimeHead` → `CrimeSubHead`. Propose:
   ```ts
   interface CrimeClass { head: string; headId: number; subHead: string; subHeadId: number }
   ```
   This affects the MOD-01 filter, MOD-04 category selector and MOD-03 category mix.

2. **`GravityOffence` should be a risk driver.** Offence severity is a better predictor
   than anything currently in the model, and it is already in the schema. Add
   `gravity: number` to `Incident` and include it in `RiskScore.drivers`.

Raise both with the frontend before implementing — they are the only two places where the
real schema and the current contract genuinely disagree.

---

## 3. Recommended stack

Follows CIAP §5 so the architecture document and the code agree.

| Layer | Choice | Why |
|---|---|---|
| API | **FastAPI** (Python) | Same language as the ML work; no serialisation boundary between model and endpoint |
| Relational | **PostgreSQL + PostGIS** | §5.3; PostGIS does district/station spatial joins natively |
| Graph | **Neo4j** | §9.2 is written as a Neo4j schema; Graph Data Science library gives Louvain, PageRank and link prediction |
| Search | **Elasticsearch** | Full-text over FIR narratives (§5.3) |
| Cache | **Redis** | Dashboard aggregates; §5.3 |
| Orchestration | **Airflow** | Nightly ETL and model retraining (§5.2) |
| Model registry | **MLflow** | Feeds `getModels()` directly |

### Why a separate graph store

Do not try to serve MOD-02 from Postgres recursive CTEs. The queries are
`common-neighbour`, `shortest-path` and `community-detection` over a 200k+ edge graph;
Neo4j GDS does these in one call and Postgres does not. The relational store stays the
system of record (§9.2) — the graph is a derived, continuously synced view.

---

## 4. Build order

Each phase leaves the app working. Do not skip ahead — the frontend degrades gracefully
only if the earlier phases are in place.

**Phase 1 — Postgres + district aggregates** *(unblocks MOD-01, MOD-03)*
Load `CaseMaster`, `District`, `Unit`, `CrimeHead`. Implement `getDistricts()` and
`stateTotals()`. Join Census for denominators — a raw count for Bengaluru Urban (9.6M) and
Kodagu (554k) is not comparable, and the whole risk model rests on per-100k rates.

**Phase 2 — incidents + stations** *(completes MOD-01)*
`getIncidents()` with geocoded lon/lat, `getStations()` grouped by `Unit`. The frontend
expects a *sample* for the map layer (~4–8k records) and aggregates for the numbers — do
not return 90k geo-points to the browser.

**Phase 3 — time series** *(unblocks MOD-04)*
Precompute weekly series per district × crime head in Airflow. Run STL and CUSUM
server-side and store the components; `getTimeSeries()` returns them. Do not compute STL
in the browser.

**Phase 4 — Neo4j** *(unblocks MOD-02, MOD-05)*
Build the graph from `Accused`, `Victim`, `ComplainantDetails` and `CaseMaster`. Run
Louvain and PageRank in GDS, write results back as node properties. `getNetwork()` returns
nodes + edges with `community` and `centrality` already populated.

**Phase 5 — models** *(completes MOD-03, MOD-06)*
See `DATA-AND-MODELS.md`.

**Phase 6 — auth and audit** *(§10.1, currently absent)*
Keycloak OAuth2/OIDC with RBAC by police hierarchy, and an immutable audit log of every
query, export and evidence-drawer open. The frontend's evidence drawer already states that
access is logged — make that true.

---

## 5. Response shapes

Envelope, per the project's API convention:

```json
{ "success": true, "data": [ ... ], "error": null,
  "meta": { "total": 30, "page": 1, "limit": 100 } }
```

Unwrap in `api.ts` so the UI still receives bare arrays.

### Performance targets (CIAP §13)

- District drill-down and dashboard views under **3 seconds**
- Hotspot and trend batch jobs complete in the nightly window
- 99.5% uptime with graceful degradation to cached views

Cache `getDistricts`, `stateTotals` and `getCategorySeries` in Redis with a nightly
invalidation — they change once per ETL run, not per request.

---

## 6. Prompts for an AI IDE

These are written to be pasted whole. Each one carries enough context that the assistant
does not have to guess, and each ends with a constraint that prevents the most likely
wrong turn.

### 6.1 Session primer — paste once at the start

```
I am building the backend for YUKTI, a crime intelligence platform for the Karnataka
State Police (SCRB). The React/TypeScript frontend is already complete and is NOT to be
modified.

Context you must read before writing code:
- docs/BACKEND.md — the contract you are implementing
- src/data/types.ts — the exact TypeScript types every endpoint must satisfy
- src/data/api.ts — the single module the UI imports from
- Police_FIR_ER_Diagram.pdf — the real KSP database schema

Stack: FastAPI + PostgreSQL/PostGIS + Neo4j + Redis, Airflow for orchestration.

Two rules that override anything else:
1. RiskScore and AnomalyFlag MUST carry a non-empty `evidence` array. This implements
   §10.3 of the technical solution document: every model output shown to an investigator
   links back to the records that produced it. If you cannot produce evidence for a
   score, do not return the score.
2. Predicted graph edges MUST be flagged `predicted: true` with a `confidence`. The UI
   draws predictions differently from records on purpose.

Before you write anything, tell me which tables from the ER diagram you will read and
what you are unsure about. Do not start coding until I confirm.
```

### 6.2 Phase 1 — district aggregates

```
Implement GET /api/districts returning DistrictMetrics[] exactly as typed in
src/data/types.ts.

Source: CaseMaster joined to District and CrimeHead from the KSP schema, plus Census 2011
denominators (population, urban %, literacy %) which are already in
src/data/census.ts — port that table into a reference table in Postgres.

Requirements:
- `rate` is incidents per 100,000 population over the period. Never expose a raw count as
  though it were comparable across districts.
- `byCategory` keys must match the CrimeCategory union exactly.
- `riskNorm` is the district's RANK within the state, 0..1, raised to the power 1.45.
  It is used for colour only. `risk` stays the model's own output.
- `redZone` is true only when riskNorm > 0.74 AND the period-on-period trend is positive.
  Both conditions — a persistently busy district must not sit permanently in alarm.

Write it as a single SQL query with a Python wrapper. Show me the query first.
```

### 6.3 Phase 3 — STL + CUSUM

```
Implement the time-series pipeline behind GET /api/series.

For each district × crime head, build a weekly count series over 104 weeks, then:
1. STL decomposition (statsmodels.tsa.seasonal.STL, period=52) into trend, seasonal,
   residual.
2. A two-sided tabular CUSUM over the RESIDUAL with slack k = 0.5σ and decision interval
   h = 4.2σ.

Three things the current frontend prototype gets right and you must preserve:
- σ is estimated from an IN-CONTROL baseline (the earlier portion of the series), not the
  whole series. Including the shift inflates σ until the thing you are detecting no longer
  crosses the limit.
- After a signal, apply a refractory period of ~12 weeks. A sustained level shift re-arms
  the statistic within two weeks and would otherwise signal every week forever. One shift
  should raise one alert.
- Return the decomposed components, not just the raw series — the UI plots STL as small
  multiples and marks breaches on every panel.

Store results in Postgres; the API reads precomputed rows. Do not compute STL per request.
```

### 6.4 Phase 4 — Neo4j graph

```
Build the Neo4j projection and implement GET /api/graph.

Schema is fixed by §9.2 of the technical solution document:
  Nodes:  Person | Incident | Location | Vehicle | Organisation
  Edges:  ACCUSED_IN | VICTIM_OF | WITNESSED | OCCURRED_AT | ASSOCIATED_WITH |
          SAME_MO_AS | MEMBER_OF | CO_ACCUSED_WITH

Build from Accused, Victim, ComplainantDetails and CaseMaster. Two people accused in the
same FIR get CO_ACCUSED_WITH.

Then, using Neo4j GDS:
- gds.louvain → write back as node property `community`
- gds.pageRank → write back as `centrality`, NORMALISED to 0..1 against the maximum
- gds.beta.graphSage or gds.linkPrediction → candidate edges, written with
  predicted: true and a confidence

One correctness note: `degree` must count DISTINCT neighbours, not adjacency entries. Two
people co-accused in three FIRs produce three edges; counting those as three links
inflates every figure in the UI and makes the same name appear three times in a
connections list.

Return GraphData with community and centrality already populated — the frontend does not
recompute them.
```

### 6.5 Reviewing AI output

```
Review the code you just wrote against these, and fix anything that fails:

1. Does every RiskScore and AnomalyFlag carry a non-empty evidence array?
2. Are any raw counts exposed where a per-100k rate is needed for comparability?
3. Does `degree` count distinct neighbours?
4. Is σ for CUSUM estimated from an in-control baseline?
5. Are predicted edges flagged?
6. Does the response satisfy src/data/types.ts exactly — no extra fields, no missing
   ones, no `any`?
7. Are there N+1 queries in any endpoint that returns a list?

For each, answer PASS or FAIL with the line. Do not claim PASS without quoting the code.
```

### 6.6 What to watch for

AI assistants reliably get three things wrong here, so check them explicitly:

- **They will make `evidence` optional** to get the types to compile. That silently
  removes the platform's central safeguard.
- **They will compute STL per request.** It belongs in a nightly job.
- **They will serve the graph from Postgres** with recursive CTEs because it avoids adding
  a dependency. It will not hold at 200k edges.

---

## 7. Definition of done

- [ ] `loadPlatformData()` resolves against real services
- [ ] Every function in §1.2 returns real data with types unchanged
- [ ] `evidence` is populated on every risk score and anomaly flag
- [ ] Predicted edges are flagged and separable
- [ ] District figures are per-100k, not raw counts
- [ ] `degree` counts distinct neighbours
- [ ] STL/CUSUM precomputed, not per-request
- [ ] Louvain and PageRank written back as node properties
- [ ] Dashboard views under 3s (§13)
- [ ] Auth and immutable audit log in place (§10.1)
- [ ] `src/data/` generators deleted

The frontend needs **zero** changes for any of this.
