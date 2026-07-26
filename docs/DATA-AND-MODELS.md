# YUKTI — Real Data & Real Models

How to replace the synthetic layer with real Karnataka crime data, and how to train and
serve the eight models in CIAP §8 so they produce the outputs the frontend already renders.

Companion to `BACKEND.md`. That document covers the API contract; this one covers what
goes behind it.

---

## Part 1 — Real data

### 1.1 The primary source is not public

The authoritative data is **CCTNS** (Crime and Criminal Tracking Network & Systems), which
holds the FIR-level records described in `Police_FIR_ER_Diagram.pdf`. It is not open.
Access requires a **formal data-sharing agreement with SCRB**, which CIAP §14 puts in Phase
0 for a reason — it is the long pole, and no amount of engineering shortens it.

Start that conversation before writing ETL code. Everything below is either what you use
until access lands, or what you join *against* CCTNS once it does.

### 1.2 What you can get today

| Source | What it gives | Format | Notes |
|---|---|---|---|
| **[NCRB — Crime in India](https://www.ncrb.gov.in/crime-in-india.html)** | District-level counts by crime head, annual, per state | PDF + XLSX | The realistic public substitute for CCTNS. District × crime-head × year. |
| **[data.gov.in](https://data.gov.in/)** | NCRB tables as machine-readable, some IPC-head splits | CSV / API | Search "NCRB Karnataka". Quality varies year to year. |
| **[Census of India 2011](https://censusindia.gov.in/)** | Population, urbanisation, literacy, SC/ST, workforce — district and taluk | XLSX | Already ported into `src/data/census.ts`. The denominator for every rate. |
| **[Karnataka State Police](https://ksp.karnataka.gov.in/)** | Unit directory, jurisdiction lists, annual reports | HTML / PDF | Best source for the real `Unit` table — station names, codes, district mapping. |
| **[ISRO Bhuvan](https://bhuvan.nrsc.gov.in/)** | Administrative boundaries, base layers | WMS / SHP | CIAP §11 names it. Authoritative Indian boundaries. |
| **[Survey of India](https://onlinemaps.surveyofindia.gov.in/)** | Official district/taluk boundaries | SHP | Use where legal provenance of a boundary matters. |
| **[Karnataka GIS](https://kgis.ksrsac.in/)** | State GIS, ward and taluk layers | WMS | Ward-level is what §7.3 asks for in socio-economic overlays. |
| **[Nominatim](https://nominatim.org/) / [Bhuvan geocoder](https://bhuvan.nrsc.gov.in/api/)** | Address → lon/lat | API | Needed to geocode FIR addresses. See 1.4. |

### 1.3 The boundary file already in the repo

`public/data/karnataka-districts.geo.json` — 30 real district polygons, 5,802 coordinates,
106 KB, sorted north→south. It works and is already wired.

**Two upgrades worth making:**

1. **2011 vs current districts.** The file matches Census 2011's 30 districts. Karnataka has
   since notified **Vijayanagara** (split from Ballari, 2021). If CCTNS reports 31, you need
   an updated boundary set and a crosswalk table mapping old→new for historical comparison.
   Do not silently merge — a district that did not exist before 2021 has no 2011 baseline,
   and pretending otherwise breaks every trend line.

2. **Taluk and ward boundaries.** §7.3 asks for socio-economic overlays "at the ward/taluk
   level". District is as far as the current file goes. Pull taluk polygons from KGIS.

### 1.4 Geocoding is the hard part

FIR addresses are free text, frequently informal ("near Ganesha temple, Peenya 2nd stage").
Expect **60–75% clean geocoding** and plan for the remainder.

Recommended cascade, stopping at the first hit:

```
1. Exact match against a gazetteer of known landmarks per station jurisdiction
2. Structured fields if present (village/taluk codes from the Census LGD directory)
3. Nominatim / Bhuvan geocoder on the cleaned address string
4. Fall back to the POLICE STATION centroid, and FLAG the record
```

That flag matters. An incident placed at its station's centroid is not evidence of activity
at that point, and a KDE built over thousands of such fallbacks produces a fake hotspot
exactly where each station sits. Either exclude flagged records from the density layer or
render them as a separate, visibly distinct class. **The frontend's hotspot layer will
faithfully draw whatever artifact you feed it.**

### 1.5 Privacy and the law — read before loading anything

CIAP §10 and the **DPDP Act 2023** apply from the first row you load.

- **Data localisation** (§10.1) — all storage and processing inside Indian jurisdiction:
  State Data Centre, NIC, or a MeitY-empanelled Government Community Cloud. This rules out
  the default region of most managed database and LLM services.
- **Never send FIR text to a third-party API.** That includes commercial LLM endpoints for
  NER. Use a self-hosted model (see 2.6).
- **Purpose limitation and retention** — define a retention schedule before ingestion, not
  after.
- **Pseudonymise for analytics.** Aggregate views (the socio-economic overlays, the district
  dashboards) never need individual identity. Hold the identity join key in a separate,
  access-controlled table.
- **Audit everything.** §10.1 requires every query, export and reviewed flag to be logged
  immutably. The frontend's evidence drawer already tells the user this happens.

---

## Part 2 — Real models

CIAP §8 defines eight models. Below is what to actually build for each, what the frontend
expects back, and what will go wrong.

### 2.0 The constraint that overrides everything

**Protected attributes must not be direct model inputs.** CIAP §15 is explicit, and the
schema makes this a live risk: `CasteMaster`, `ReligionMaster` and `OccupationMaster` are
right there in the ER diagram and join cleanly to `Accused`.

Do not use them as features. Also watch for proxies — a ward identifier can encode caste
composition as effectively as a caste field. Run a fairness audit per §15: check score
distributions across demographic groups you did *not* train on, and record the result in
the model card.

There is a second-order trap worth naming. Predictive policing models trained on **recorded
crime** learn where police already go, not where crime happens. More patrols produce more
recorded incidents, which raise the risk score, which justify more patrols. Mitigations:

- Prefer **victim-reported** categories (burglary, vehicle theft) over **enforcement-driven**
  ones (NDPS, public order) as targets. NDPS counts measure enforcement effort almost
  directly.
- Include patrol or officer-strength intensity as a **control variable** so the model can
  separate reporting from incidence.
- Report per-100k rates, never raw counts — already enforced in the frontend contract.

---

### 2.1 Spatiotemporal hotspot detection — KDE + ST-DBSCAN

**Frontend contract:** `getIncidents()` returns geo-tagged points; the browser bakes the KDE
into a texture. You can serve points and let the client estimate, or precompute a density
grid server-side. For >10k points, precompute.

```python
from sklearn.neighbors import KernelDensity
import numpy as np

# Project to a metric CRS first. Doing KDE in degrees makes the kernel
# anisotropic — at Karnataka's latitude a degree of longitude is ~108 km
# and a degree of latitude ~111 km, so a "circular" kernel is an ellipse.
# EPSG:32643 (UTM 43N) covers Karnataka.
kde = KernelDensity(bandwidth=800, kernel="gaussian", metric="euclidean")
kde.fit(xy_metres)                      # (n, 2) in metres
log_density = kde.score_samples(grid)   # evaluate on a regular grid
```

**Bandwidth is the whole analysis.** Do not leave it at a default — cross-validate it, or
set it from a policing rationale (e.g. 800 m ≈ a beat), and *state the value in the UI*.
Two analysts with different bandwidths see different hotspots from identical data.

For the space–time clustering §8 names:

```bash
pip install st-dbscan          # or implement: DBSCAN with a spatial AND temporal epsilon
```

`ST-DBSCAN(eps1=750m, eps2=6h, min_samples=8)` is a reasonable start. Tune `min_samples`
against the sparsest district, not the densest, or rural districts will report no clusters
at all.

---

### 2.2 Trend and spike detection — STL + CUSUM

**Frontend contract:** `TrendSeries` with `points[].{value, trend, seasonal, residual}`,
a `controlLimit`, and `breaches[]` as indices. The UI plots STL as small multiples and
marks each breach on every panel.

```python
from statsmodels.tsa.seasonal import STL
import numpy as np

stl = STL(weekly_counts, period=52, robust=True).fit()
resid = stl.resid

# sigma from an IN-CONTROL baseline, not the whole series.
baseline = resid[: int(len(resid) * 0.6)]
sigma = baseline.std(ddof=1)

def cusum(resid, sigma, k=0.5, h=4.2, refractory=12):
    hi = lo = 0.0
    quiet_until = -1
    breaches = []
    for i, r in enumerate(resid):
        z = r / sigma
        hi = max(0.0, hi + z - k)
        lo = min(0.0, lo + z + k)
        if hi > h or lo < -h:
            hi = lo = 0.0
            if i > quiet_until:            # one shift → one alert
                breaches.append(i)
                quiet_until = i + refractory
    return breaches, h * sigma
```

Three things the frontend prototype already gets right and you must keep:

- **σ from an in-control baseline.** Estimating it over the whole series lets the shift
  inflate σ until the thing you are detecting no longer crosses the limit.
- **A refractory period.** A sustained level shift re-arms CUSUM within a week or two and
  would otherwise signal every week forever. Nine alerts for one event is how an analyst
  learns to ignore the alert panel.
- **`robust=True`** in STL, so a single extreme week does not drag the seasonal component.

Tune `h` against a labelled set of known spikes if SCRB can provide one. Report precision,
not just recall — a false red zone costs deployed officers.

---

### 2.3 Predictive risk scoring — gradient boosting + SHAP

**Frontend contract:** `RiskScore` with `score` (0..1, **relative** to the state), `band`,
`drivers[]` (feature → contribution) and a non-empty `evidence[]`.

```python
import lightgbm as lgb, shap, numpy as np

model = lgb.LGBMRegressor(
    objective="poisson",     # counts, not a Gaussian target
    n_estimators=600, learning_rate=0.03, num_leaves=31,
)
model.fit(X_train, y_train)   # y = incidents per 100k, next 30 days

explainer = shap.TreeExplainer(model)
shap_values = explainer.shap_values(X)   # → drivers[] straight from here
```

**Features that are legitimate:**
lagged incident rates (1/4/12/52 weeks), STL trend and seasonal components, Census
urbanisation, literacy, population density, station density per 100k, `GravityOffence`
mix, clearance rate, and calendar effects (festival weeks, monsoon).

**Validation must be temporal.** A random train/test split leaks the future into the past
and will report a spectacular, meaningless AUC. Use forward-chaining: train on weeks 1–52,
test on 53–56; then 1–56, test 57–60; and so on.

**Baseline first.** Fit "next month = mean of last three months" and record its error. If
LightGBM cannot beat that by a clear margin, report it honestly rather than shipping a
model that is a slower moving average.

`drivers[]` maps directly from SHAP values — that is the point of choosing SHAP over
feature importance. Importance is global; the UI shows *why this district, this month*.

---

### 2.4 Anomaly detection — Isolation Forest

**Frontend contract:** `AnomalyFlag` with `score`, a human-readable `reason`, and
`evidence[]`.

```python
from sklearn.ensemble import IsolationForest

iso = IsolationForest(n_estimators=300, contamination=0.03, random_state=42)
iso.fit(X_incidents)                     # per-jurisdiction, not state-wide
raw = -iso.score_samples(X_incidents)    # higher = more anomalous
```

**Fit per jurisdiction.** A 2 a.m. burglary is unremarkable in Bengaluru Urban and genuinely
odd in Kodagu. A single state-wide model just flags every rural district.

`contamination` is a policy choice, not a statistic — it sets how many flags land in the
analyst's queue. Set it from queue capacity and say so in the model card.

**The `reason` string needs care.** Isolation Forest gives a score, not an explanation.
Derive the reason by finding which feature is furthest from its jurisdiction norm:

```python
z = (x - district_mean) / district_std
reason_feature = feature_names[np.argmax(np.abs(z))]
```

That produces the sentences the UI already renders ("offence window 0000–0400 is atypical
for Property Crime in this jurisdiction"), and it is honest — the named feature really is
the one driving the flag.

---

### 2.5 MO similarity and repeat-offender linking

**Frontend contract:** `getOffenderProfiles()` — incidents per person with a dominant
signature, districts spanned, and matches in *other* districts.

```python
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import DBSCAN

# Structured MO fields, not free text: entry method, target, tools, window.
tfidf = TfidfVectorizer(analyzer="word", token_pattern=r"[^|]+")
X = tfidf.fit_transform(mo_strings)              # "forced door|residence|crowbar|0000-0400"
clusters = DBSCAN(eps=0.35, min_samples=4, metric="cosine").fit_predict(X)
```

Keep the frontend's rule: **only count a signature match when the two people operate in
different districts.** Within one jurisdiction a shared method is more likely a local norm
than a link between offenders — that restriction is what makes this §7.2's "compared for
similarity across jurisdictions" rather than a similarity join that flags everyone.

If free-text narrative is available, sentence embeddings beat TF-IDF — but see 2.6 for the
hosting constraint.

---

### 2.6 NLP entity extraction — Kannada + English NER

**Do not send FIR text to a hosted LLM API.** Data localisation (§10.1) and DPDP make that
a non-starter regardless of the provider's terms.

Self-hosted Indic models, all available on Hugging Face:

| Model | Use |
|---|---|
| **`ai4bharat/IndicNER`** | NER across 11 Indic languages including Kannada. Closest to off-the-shelf for this task. |
| **`google/muril-base-cased`** | Strong Indic-language base. Fine-tune for token classification. |
| **`ai4bharat/indic-bert`** | Lighter alternative. |
| **`l3cube-pune/kannada-bert`** | Kannada-specific. |

```python
from transformers import AutoTokenizer, AutoModelForTokenClassification

tok = AutoTokenizer.from_pretrained("ai4bharat/IndicNER")
model = AutoModelForTokenClassification.from_pretrained("ai4bharat/IndicNER")
```

**You will need to fine-tune.** Generic NER finds PERSON / LOCATION / ORG. Policing needs
WEAPON, VEHICLE, CONTRABAND, MO-METHOD, and Indian-specific entity forms. Budget for
**500–1,000 hand-annotated FIRs**; that is the realistic floor for usable F1, and it is
work for someone who reads Kannada, not for the model.

Code-mixing is the norm — Kannada script, romanised Kannada and English inside one
narrative. Test on real mixed text, not clean samples.

---

### 2.7 Community detection — Louvain / Leiden

**Frontend contract:** `GraphNode.community` (integer) and `centrality` (0..1 normalised).

Run in Neo4j GDS and write results back as node properties; do not compute per request.

```cypher
CALL gds.graph.project('crime', ['Person','Incident','Location','Vehicle','Organisation'],
  { CO_ACCUSED_WITH: {orientation:'UNDIRECTED'},
    ACCUSED_IN:      {orientation:'UNDIRECTED'},
    OCCURRED_AT:     {orientation:'UNDIRECTED'} });

CALL gds.louvain.write('crime', { writeProperty: 'community' });
CALL gds.pageRank.write('crime', { writeProperty: 'centrality' });
```

**Normalise PageRank to 0..1 against the maximum** — the UI sizes nodes by it and displays
it as a percentage.

**Prefer Leiden over Louvain** if GDS Enterprise is available. Louvain can produce
internally disconnected communities — a "group" whose members are not actually connected to
each other, which is indefensible if it ever reaches an investigator. Leiden guarantees
connectivity.

Louvain is also **non-deterministic**: run it twice, get different community IDs. Seed it,
or persist a mapping, or the same person changes group between page loads.

---

### 2.8 Link prediction — GraphSAGE

**Frontend contract:** edges with `predicted: true` and a `confidence`. The UI draws them
brass, off by default, labelled as hypotheses.

```cypher
CALL gds.beta.pipeline.linkPrediction.create('lp');
CALL gds.beta.pipeline.linkPrediction.addNodeProperty('lp','fastRP',
     { embeddingDimension: 128, mutateProperty: 'emb' });
CALL gds.beta.pipeline.linkPrediction.addFeature('lp','hadamard',
     { nodeProperties: ['emb'] });
```

**Calibrate the confidence.** A raw model output near 1.0 is not a 99% probability that two
people know each other, and the UI prints that number next to a person's name. Use isotonic
regression or Platt scaling against held-out edges so the number means what it says.

**Set a high threshold.** A false positive here is an unfounded suggestion that two people
are connected. Precision matters far more than recall, and §10.3 requires human review
before any action either way.

The frontend's current placeholder — pairs with ≥2 shared neighbours, ranked by count — is
Adamic-Adar-shaped and a reasonable baseline. Beat it before shipping GraphSAGE.

---

## Part 3 — Serving

### 3.1 Batch, not per-request

Nothing here runs on the request path except the graph queries. Airflow DAG:

```
nightly:
  ingest_cctns    → staging
  entity_resolve  → person/location dedupe across sources
  geocode         → lon/lat + fallback flag
  aggregate       → district + station rollups        → Postgres
  stl_cusum       → per district × crime head          → Postgres
  graph_sync      → Neo4j projection + Louvain + PageRank
  score_risk      → LightGBM + SHAP                    → Postgres
  score_anomaly   → Isolation Forest                   → Postgres
  publish         → Redis cache warm
```

The API reads precomputed rows. That is what makes §13's 3-second target achievable.

### 3.2 MLflow feeds MOD-06 directly

`ModelCard` maps onto MLflow's own concepts: `version`, `status`, `metric`, `lastTrained`.
The one field you must compute is **`drift`**.

```python
from scipy.stats import wasserstein_distance
drift = wasserstein_distance(training_feature_dist, current_feature_dist)
```

Or use PSI/KL. §8 requires that material behaviour change is reviewed before redeployment,
and the UI shows a ▲ and "review required before redeployment" above `DRIFT_THRESHOLD`
(0.05). Wire that to a real alert, not just a badge.

### 3.3 Evidence is a hard requirement, not a nicety

Every scoring job must emit the record IDs that produced each score, alongside the score.
It is far easier to capture them during scoring than to reconstruct them afterwards.

```python
evidence = [
  {"kind": "incident", "ref": fir_id, "label": crime_no,
   "detail": f"{category} · {station} · {date}"}
  for fir_id, crime_no, category, station, date in top_contributing_records
]
```

`RiskScore.evidence` and `AnomalyFlag.evidence` are non-optional in the TypeScript types
specifically so this cannot be skipped under deadline pressure. If a score has no evidence,
do not return the score.

---

## Part 4 — Prompts for an AI IDE

### 4.1 ML session primer

```
I am building the ML layer for YUKTI, a crime intelligence platform for the Karnataka
State Police. Read docs/DATA-AND-MODELS.md and docs/BACKEND.md before writing code.

Stack: Python, scikit-learn, LightGBM, statsmodels, SHAP, Neo4j GDS, MLflow, Airflow.

Four constraints that override normal ML practice, and I will reject code that breaks
them:

1. Protected attributes are NEVER model inputs. CasteMaster, ReligionMaster and
   OccupationMaster exist in the schema and join cleanly to Accused. Do not use them,
   and flag any feature you think may proxy for them.
2. Validation is TEMPORAL, never a random split. Forward-chaining only. A random split
   leaks the future and produces a meaningless AUC.
3. Every score must ship with the record IDs that produced it. If you cannot produce
   evidence, do not produce the score.
4. No FIR text leaves our infrastructure. Self-hosted models only — data localisation
   under DPDP 2023.

Before coding, tell me your feature list and how you will validate it. Wait for my
confirmation.
```

### 4.2 Risk scoring

```
Implement the district risk scoring model.

Target: incidents per 100,000 population in the next 30 days, per district.
Model: LightGBM, objective="poisson" (the target is a count).
Explanation: SHAP TreeExplainer — the frontend renders per-district feature
contributions, so global feature importance is not sufficient.

Features: lagged rates (1/4/12/52 weeks), STL trend and seasonal components, Census
urbanisation, literacy, population density, station density per 100k, GravityOffence mix,
clearance rate, festival and monsoon calendar flags.

Required in this order:
1. Fit a naive baseline first: "next month = mean of the last three". Report its MAE.
2. Fit LightGBM. Report MAE on forward-chained temporal splits only.
3. If LightGBM does not clearly beat the baseline, say so plainly. Do not tune until it
   wins and then present that as the result.
4. Emit RiskScore objects matching src/data/types.ts, including a populated evidence
   array built from the highest-contributing records.

Show me the baseline comparison before anything else.
```

### 4.3 Bias audit

```
Audit the risk model for the failure modes in §15 of the technical solution document.

1. Confirm no protected attribute (caste, religion, occupation) is a direct input.
2. For each feature, assess whether it could proxy for one. Ward and locality
   identifiers are the usual culprits — check them explicitly.
3. Compute score distributions across demographic groups the model did NOT train on.
   Report any group whose mean score differs by more than 1 standard deviation.
4. Assess the feedback-loop risk: are we predicting crime, or predicting where police
   already patrol? Compare model behaviour on victim-reported categories (burglary,
   vehicle theft) against enforcement-driven ones (NDPS, public order).
5. Write the findings into the MLflow model card.

Be direct about what you find. A model that fails this audit must not be deployed, and I
would rather know now.
```

### 4.4 Kannada NER

```
Build the FIR entity-extraction pipeline.

Base model: ai4bharat/IndicNER, self-hosted. No hosted API may see FIR text — data
localisation under DPDP 2023 and §10.1.

Entities beyond standard PERSON/LOC/ORG: WEAPON, VEHICLE, CONTRABAND, MO_METHOD.

Expect code-mixed input: Kannada script, romanised Kannada and English within a single
narrative. Test on genuinely mixed text, not clean samples.

Deliverables:
1. An annotation schema and guidelines someone who reads Kannada can follow.
2. A fine-tuning script for token classification.
3. An inference service returning entities with character offsets, so extractions can be
   traced back into the narrative for the evidence drawer.
4. Per-entity-type F1 on a held-out set.

Start with the annotation schema. Do not write the training loop until we agree on it.
```

### 4.5 Review pass

```
Review the ML code against these and fix what fails:

1. Any random train/test split on time-series data? (must be forward-chained)
2. Any protected attribute or obvious proxy in the feature set?
3. Does every score carry evidence record IDs?
4. Is CUSUM sigma estimated from an in-control baseline?
5. Is there a refractory period after a CUSUM signal?
6. Is KDE computed in a metric CRS, not degrees?
7. Is Isolation Forest fitted per jurisdiction?
8. Is PageRank normalised to 0..1?
9. Are link-prediction confidences calibrated?
10. Is anything on the request path that belongs in a nightly job?

Answer PASS or FAIL for each with the relevant line. Do not claim PASS without quoting
the code.
```

### 4.6 Where AI assistants reliably go wrong here

- **Random train/test split on time series.** Near-universal, and it produces an AUC that
  looks like success.
- **Using every available column** — including caste and religion, because they are in the
  schema and improve the metric.
- **KDE in degrees.** Silently anisotropic; the hotspots are wrong in a way nobody notices.
- **Dropping `evidence`** to make the types compile.
- **Computing STL per request** because it is simpler than an Airflow DAG.
- **Reporting only the final tuned metric**, with no baseline to compare it against.

---

## Part 5 — Honest expectations

| Component | Realistic difficulty | Main risk |
|---|---|---|
| District aggregates | Low | Getting CCTNS access at all |
| Geocoding | **High** | 25–40% will not resolve cleanly; fallbacks create fake hotspots |
| KDE / hotspots | Low–medium | Bandwidth choice drives the finding |
| STL / CUSUM | Medium | Needs 2+ years of consistent history |
| Risk scoring | **High** | May not beat a naive baseline. Be prepared to report that. |
| Anomaly detection | Medium | `contamination` is a policy choice dressed as a parameter |
| Kannada NER | **High** | Requires hand-annotation by a Kannada reader |
| Graph analytics | Low–medium | Entity resolution quality determines everything downstream |
| Link prediction | **High** | Easy to build, hard to justify. Calibrate or omit. |

**Entity resolution is the hidden critical path.** Every graph finding depends on knowing
that "Ravi Kumar, Bengaluru" in FIR 4012 is the same person as "R. Kumar, B'lore" in FIR
8871. Get that wrong and community detection, repeat-offender tracking and link prediction
are all confidently wrong together. Budget for it as a first-class component, not as a
data-cleaning step.

If a model does not beat its baseline, say so and ship the baseline. A platform whose
premise is explainable, evidence-linked decision support cannot afford a model nobody can
defend.
