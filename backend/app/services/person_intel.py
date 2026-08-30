"""Person Intelligence & Alerts — decision-support relevance matching (not guilt prediction)."""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models_orm import PersonIntelAlertState
from app.rbac import UserContext, mask_sensitive_fields
from app.services.graph import get_graph
from app.services.incidents import get_incidents
from app.services.offenders import get_offender_profiles

# Transparent weights — sum to 1.0. Missing factors are excluded and weights renormalized.
WEIGHTS = {
    "crime_type": 0.25,
    "mo_similarity": 0.30,
    "location": 0.20,
    "time_pattern": 0.10,
    "network": 0.10,
    "vehicle": 0.05,
}
ALERT_THRESHOLD = 0.70
HIGH_RELEVANCE = 0.85

_CACHE: dict[str, Any] = {"at": 0.0, "index": None}
_CACHE_TTL_SEC = 120.0


def _now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 0.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _tokens(text: str) -> set[str]:
    return {t for t in re.split(r"[^a-zA-Z0-9α-ωΑ-Ω\u0C80-\u0CFF]+", (text or "").lower()) if len(t) > 1}


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def _hour_bucket(ts_ms: int) -> str:
    if not ts_ms:
        return ""
    h = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).hour
    if 5 <= h < 12:
        return "morning"
    if 12 <= h < 17:
        return "afternoon"
    if 17 <= h < 22:
        return "evening"
    return "night"


def _incident_probe(inc: Any) -> dict[str, Any]:
    """Normalize Incident pydantic or dict into a probe dict."""
    if hasattr(inc, "model_dump"):
        d = inc.model_dump()
    elif isinstance(inc, dict):
        d = dict(inc)
    else:
        d = {
            "id": getattr(inc, "id", ""),
            "category": getattr(inc, "category", ""),
            "district": getattr(inc, "district", ""),
            "at": getattr(inc, "at", 0),
            "mo": getattr(inc, "mo", None),
            "lonLat": getattr(inc, "lonLat", None),
            "docket": getattr(inc, "docket", ""),
            "narrative": getattr(inc, "narrative", ""),
        }
    mo = d.get("mo") or {}
    if hasattr(mo, "model_dump"):
        mo = mo.model_dump()
    return {
        "id": str(d.get("id") or ""),
        "docket": str(d.get("docket") or d.get("id") or ""),
        "category": str(d.get("category") or ""),
        "district": str(d.get("district") or ""),
        "at": int(d.get("at") or 0),
        "lonLat": d.get("lonLat"),
        "mo_entry": str((mo or {}).get("entry") or ""),
        "mo_target": str((mo or {}).get("target") or ""),
        "mo_timing": str((mo or {}).get("timing") or ""),
        "mo_tools": str((mo or {}).get("tools") or ""),
        "narrative": str(d.get("narrative") or ""),
        "synthetic": bool(d.get("synthetic") or str(d.get("id") or "").startswith("SYN-")),
    }


def _profiles_from_graph(db: Session) -> list:
    """Person profiles with ≥1 documented ACCUSED_IN case (not only repeat offenders)."""
    from app.schemas import OffenderIncident, OffenderProfile

    data = get_graph(db)
    by_id = {n.id: n for n in data.nodes}
    linked: dict[str, list] = defaultdict(list)
    for e in data.edges:
        if e.kind != "ACCUSED_IN":
            continue
        src, tgt = by_id.get(e.source), by_id.get(e.target)
        if not src or not tgt:
            continue
        person = src if src.kind == "Person" else tgt if tgt.kind == "Person" else None
        incident = src if src.kind == "Incident" else tgt if tgt.kind == "Incident" else None
        if not person or not incident:
            continue
        m = incident.meta or {}
        linked[person.id].append(
            OffenderIncident(
                id=incident.id,
                docket=incident.label,
                district=incident.district,
                at=int(m.get("At", 0) or 0),
                entry=str(m.get("Entry", "—")),
                target=str(m.get("Target", "—")),
                window=str(m.get("Window", "—")),
            )
        )

    profiles = []
    for pid, incidents in linked.items():
        if not incidents:
            continue
        person = by_id[pid]
        incidents.sort(key=lambda i: i.at)
        counts: dict[str, int] = defaultdict(int)
        for i in incidents:
            counts[f"{i.entry} → {i.target}"] += 1
        signature = max(counts, key=counts.get)  # type: ignore[arg-type]
        districts = sorted({i.district for i in incidents})
        span = max(0, (incidents[-1].at - incidents[0].at) // 86_400_000) if len(incidents) > 1 else 0
        priors = int((person.meta or {}).get("priors", max(0, len(incidents) - 1)))
        profiles.append(
            OffenderProfile(
                person=person,
                incidents=incidents,
                districts=districts,
                signature=signature,
                spanDays=span,
                priors=priors,
                matches=[],
            )
        )
    profiles.sort(key=lambda p: len(p.incidents), reverse=True)
    return profiles[:200]


def _profile_index(db: Session) -> dict[str, Any]:
    import time

    now = time.time()
    if _CACHE["index"] is not None and now - float(_CACHE["at"]) < _CACHE_TTL_SEC:
        return _CACHE["index"]  # type: ignore[return-value]

    offenders = _profiles_from_graph(db)
    if not offenders:
        offenders = get_offender_profiles(db)
    graph = get_graph(db)
    by_id = {n.id: n for n in graph.nodes}
    adj: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for e in graph.edges:
        adj[e.source].append((e.target, e.kind))
        adj[e.target].append((e.source, e.kind))

    incidents = get_incidents(db)
    inc_by_id = {i.id: i for i in incidents}

    # Precompute lightweight fingerprints for fast matching
    fingerprints: dict[str, dict[str, Any]] = {}
    for o in offenders:
        cats: Counter[str] = Counter()
        locs: Counter[str] = Counter()
        mo_sigs: Counter[str] = Counter()
        buckets: Counter[str] = Counter()
        for oi in o.incidents:
            full = inc_by_id.get(oi.id)
            cat = str(full.category) if full is not None else str((by_id.get(oi.id).meta or {}).get("Category", "Unknown") if by_id.get(oi.id) else "Unknown")
            cats[cat] += 1
            locs[oi.district] += 1
            mo_sigs[f"{oi.entry} → {oi.target}"] += 1
            buckets[_hour_bucket(oi.at)] += 1
        vehicles = []
        associates = []
        for other_id, kind in adj.get(o.person.id, []):
            other = by_id.get(other_id)
            if not other:
                continue
            if other.kind in ("ANPR_Vehicle", "Vehicle"):
                vehicles.append(other.label.upper())
            elif other.kind == "Person" and other.id != o.person.id:
                associates.append(other.id)
        fingerprints[o.person.id] = {
            "crime_types": set(cats),
            "locations": set(locs),
            "mo_signature": o.signature,
            "mo_tokens": _tokens(" ".join(mo_sigs.keys())),
            "time_buckets": buckets,
            "vehicles": set(vehicles),
            "associates": set(associates),
            "case_ids": [i.id for i in o.incidents],
            "documented_cases": len(o.incidents),
        }

    idx = {
        "offenders": offenders,
        "by_id": by_id,
        "adj": adj,
        "inc_by_id": inc_by_id,
        "graph": graph,
        "fingerprints": fingerprints,
    }
    _CACHE["index"] = idx
    _CACHE["at"] = now
    return idx


def _score_fingerprint(probe: dict[str, Any], fp: dict[str, Any], network_ids: set[str]) -> dict[str, Any]:
    """Fast path scoring using precomputed fingerprints."""
    profile_lite = {
        "crime_types": [{"type": t, "count": 1} for t in fp["crime_types"]],
        "documented_mo_patterns": [{"signature": fp["mo_signature"], "count": 1}],
        "mo_signature": fp["mo_signature"],
        "historical_locations": [{"district": d, "count": 1} for d in fp["locations"]],
        "timeline": [{"at": 0, "case_id": cid, "category": next(iter(fp["crime_types"]), "Unknown")} for cid in fp["case_ids"][:1]],
        "map_points": [],
        "associated_persons": [{"id": a} for a in fp["associates"]],
        "associated_vehicles": [{"label": v} for v in fp["vehicles"]],
    }
    # Prefer token Jaccard for MO using fingerprint tokens
    scored = score_relevance(probe, profile_lite, network_ids)
    # Overlay time bucket from fingerprint if probe has time
    pb = _hour_bucket(int(probe.get("at") or 0))
    buckets: Counter = fp.get("time_buckets") or Counter()
    if pb and buckets and scored["factors"]["time_pattern"]["available"] is False:
        total = sum(buckets.values()) or 1
        share = buckets.get(pb, 0) / total
        scored["factors"]["time_pattern"] = {
            "score_pct": round(share * 100),
            "available": True,
            "explanation": f"Incident time window ({pb}) vs documented activity distribution",
            "evidence_refs": [f"{k}:{v}" for k, v in buckets.most_common()],
        }
        # recompute overall with updated time factor
        avail = {k: v for k, v in scored["factors"].items() if v.get("available") and v.get("score_pct") is not None}
        if avail:
            wsum = sum(WEIGHTS[k] for k in avail if k in WEIGHTS)
            overall = sum(WEIGHTS[k] / wsum * (float(avail[k]["score_pct"]) / 100.0) for k in avail if k in WEIGHTS)
            scored["investigation_relevance"] = round(overall * 100)
            scored["investigation_relevance_01"] = round(overall, 4)
    return scored


def build_person_profile(db: Session, person_id: str, user: UserContext | None = None) -> dict[str, Any]:
    idx = _profile_index(db)
    offender = next((o for o in idx["offenders"] if o.person.id == person_id), None)
    node = idx["by_id"].get(person_id)
    if not offender and not node:
        raise KeyError(f"Person not found: {person_id}")

    person = offender.person if offender else node
    incidents_raw = list(offender.incidents) if offender else []
    timeline: list[dict[str, Any]] = []
    map_points: list[dict[str, Any]] = []
    categories: Counter[str] = Counter()
    locations: Counter[str] = Counter()
    mo_sigs: Counter[str] = Counter()

    for oi in incidents_raw:
        full = idx["inc_by_id"].get(oi.id)
        cat = str(full.category) if full is not None else "Unknown"
        categories[cat or "Unknown"] += 1
        locations[oi.district] += 1
        sig = f"{oi.entry} → {oi.target}"
        mo_sigs[sig] += 1
        lon_lat = list(full.lonLat) if full is not None else None
        timeline.append(
            {
                "case_id": oi.id,
                "docket": oi.docket,
                "district": oi.district,
                "at": oi.at,
                "mo": sig,
                "timing": oi.window,
                "category": cat or "Unknown",
                "lonLat": lon_lat,
            }
        )
        if lon_lat:
            map_points.append(
                {
                    "case_id": oi.id,
                    "docket": oi.docket,
                    "district": oi.district,
                    "lonLat": lon_lat,
                    "at": oi.at,
                    "category": cat or "Unknown",
                }
            )

    timeline.sort(key=lambda t: t["at"])

    # Network associates + vehicles from graph
    associates: list[dict[str, Any]] = []
    vehicles: list[dict[str, Any]] = []
    for other_id, kind in idx["adj"].get(person_id, []):
        other = idx["by_id"].get(other_id)
        if not other:
            continue
        if other.kind in ("ANPR_Vehicle", "Vehicle"):
            vehicles.append(
                {
                    "id": other.id,
                    "label": other.label,
                    "kind": other.kind,
                    "edge": kind,
                    "meta": other.meta or {},
                    "synthetic": other.kind == "ANPR_Vehicle",
                }
            )
        elif other.kind in ("Person", "Organisation") and other.id != person_id:
            associates.append(
                {
                    "id": other.id,
                    "label": other.label,
                    "kind": other.kind,
                    "edge": kind,
                    "district": other.district,
                }
            )

    # Dedup associates
    seen: set[str] = set()
    uniq_assoc = []
    for a in associates:
        if a["id"] in seen:
            continue
        seen.add(a["id"])
        uniq_assoc.append(a)

    freq_crime = categories.most_common(1)[0][0] if categories else None
    freq_loc = locations.most_common(1)[0][0] if locations else person.district
    aliases = []
    if person.meta:
        for key in ("alias", "Alias", "aliases", "Reference"):
            if key in person.meta and person.meta[key]:
                aliases.append(str(person.meta[key]))

    age = None
    if person.meta and person.meta.get("age") is not None:
        age = person.meta.get("age")
    # ORM age via offenders path — not always on graph node

    payload = {
        "person_id": person.id,
        "name": person.label,
        "aliases": aliases,
        "age": age,
        "physical_descriptors": [],  # not in dataset — omit invention
        "district": person.district,
        "priors": int(offender.priors) if offender else int((person.meta or {}).get("priors") or 0),
        "documented_cases": len(timeline),
        "crime_types": [{"type": k, "count": v} for k, v in categories.most_common(8)],
        "historical_locations": [{"district": k, "count": v} for k, v in locations.most_common(8)],
        "most_frequent_crime_type": freq_crime,
        "frequently_occurring_location": freq_loc,
        "associated_vehicles": vehicles[:20],
        "associated_persons": uniq_assoc[:30],
        "documented_mo_patterns": [{"signature": k, "count": v} for k, v in mo_sigs.most_common(8)],
        "mo_signature": offender.signature if offender else (mo_sigs.most_common(1)[0][0] if mo_sigs else None),
        "timeline": timeline,
        "map_points": map_points,
        "span_days": offender.spanDays if offender else 0,
        "case_status": "Documented in YUKTI dataset",
        "data_notes": [
            "Profile built from authorized/synthetic YUKTI records only.",
            "Physical descriptors unavailable in current dataset.",
            "ANPR vehicle links are synthetic overlays when present.",
        ],
        "decision_support": "Investigation relevance only — requires officer verification. Not a determination of guilt.",
    }
    if user:
        return mask_sensitive_fields(payload, user)
    return payload


def search_persons(db: Session, q: str, limit: int = 40) -> list[dict[str, Any]]:
    qn = (q or "").strip().lower()
    if not qn:
        return []
    idx = _profile_index(db)
    results: list[dict[str, Any]] = []

    for o in idx["offenders"]:
        hay = " ".join(
            [
                o.person.label,
                o.person.district,
                o.signature,
                " ".join(o.districts),
                " ".join(i.docket for i in o.incidents),
                " ".join(i.entry + " " + i.target for i in o.incidents),
            ]
        ).lower()
        # vehicles
        for other_id, _kind in idx["adj"].get(o.person.id, []):
            other = idx["by_id"].get(other_id)
            if other and other.kind in ("ANPR_Vehicle", "Vehicle"):
                hay += " " + other.label.lower()

        exact = o.person.label.lower() == qn or any(i.docket.lower() == qn for i in o.incidents)
        if qn in hay or exact:
            results.append(
                {
                    "person_id": o.person.id,
                    "name": o.person.label,
                    "district": o.person.district,
                    "match_kind": "exact_record" if exact or qn == o.person.label.lower() else "record_match",
                    "documented_cases": len(o.incidents),
                    "mo_signature": o.signature,
                    "priors": o.priors,
                }
            )
    results.sort(key=lambda r: (0 if r["match_kind"] == "exact_record" else 1, -r["documented_cases"]))
    return results[:limit]


def score_relevance(probe: dict[str, Any], profile: dict[str, Any], network_ids: set[str]) -> dict[str, Any]:
    """Explainable investigation relevance — not a guilt score."""
    factors: dict[str, dict[str, Any]] = {}

    # Crime type
    types = {c["type"] for c in profile.get("crime_types") or [] if c.get("type") and c["type"] != "Unknown"}
    if probe.get("category") and types:
        hit = probe["category"] in types
        factors["crime_type"] = {
            "score": 1.0 if hit else 0.0,
            "available": True,
            "explanation": "Same crime category as documented cases" if hit else "Crime category does not overlap documented cases",
            "evidence_refs": [t["case_id"] for t in profile.get("timeline") or [] if t.get("category") == probe["category"]][:5],
        }
    else:
        factors["crime_type"] = {"score": 0.0, "available": False, "explanation": "Crime type unavailable for comparison", "evidence_refs": []}

    # MO similarity
    mo_text = " ".join(
        [
            probe.get("mo_entry") or "",
            probe.get("mo_target") or "",
            probe.get("mo_tools") or "",
            probe.get("mo_timing") or "",
        ]
    )
    prof_mo = " ".join(p["signature"] for p in profile.get("documented_mo_patterns") or [])
    if _tokens(mo_text) and _tokens(prof_mo):
        sim = _jaccard(_tokens(mo_text), _tokens(prof_mo))
        # boost if exact signature fragment
        sig = profile.get("mo_signature") or ""
        if sig and probe.get("mo_entry") and probe.get("mo_target"):
            if f"{probe['mo_entry']} → {probe['mo_target']}" == sig:
                sim = max(sim, 0.95)
        factors["mo_similarity"] = {
            "score": round(sim, 4),
            "available": True,
            "explanation": "Documented MO pattern overlap with incident attributes",
            "evidence_refs": [p["signature"] for p in (profile.get("documented_mo_patterns") or [])[:3]],
        }
    else:
        factors["mo_similarity"] = {"score": 0.0, "available": False, "explanation": "MO attributes incomplete", "evidence_refs": []}

    # Location
    locs = {h["district"] for h in profile.get("historical_locations") or []}
    if probe.get("district") and locs:
        hit = probe["district"] in locs
        geo = 1.0 if hit else 0.15
        # refine with map points if coords present
        ll = probe.get("lonLat")
        if ll and profile.get("map_points"):
            try:
                lon, lat = float(ll[0]), float(ll[1])
                dists = []
                for mp in profile["map_points"]:
                    if mp.get("lonLat"):
                        dists.append(
                            _haversine_km((lat, lon), (float(mp["lonLat"][1]), float(mp["lonLat"][0])))
                        )
                if dists:
                    nearest = min(dists)
                    if nearest < 5:
                        geo = max(geo, 0.95)
                    elif nearest < 25:
                        geo = max(geo, 0.7)
                    elif nearest < 80:
                        geo = max(geo, 0.4)
            except (TypeError, ValueError, IndexError):
                pass
        factors["location"] = {
            "score": round(geo, 4),
            "available": True,
            "explanation": "Geographic overlap with documented incident districts/locations",
            "evidence_refs": [h["district"] for h in (profile.get("historical_locations") or [])[:5]],
        }
    else:
        factors["location"] = {"score": 0.0, "available": False, "explanation": "Location data incomplete", "evidence_refs": []}

    # Time pattern
    pb = _hour_bucket(int(probe.get("at") or 0))
    hist_buckets = Counter(_hour_bucket(int(t["at"])) for t in profile.get("timeline") or [] if t.get("at"))
    if pb and hist_buckets:
        total = sum(hist_buckets.values())
        share = hist_buckets.get(pb, 0) / total
        factors["time_pattern"] = {
            "score": round(share, 4),
            "available": True,
            "explanation": f"Incident time window ({pb}) vs documented activity distribution",
            "evidence_refs": [f"{k}:{v}" for k, v in hist_buckets.most_common()],
        }
    else:
        factors["time_pattern"] = {"score": 0.0, "available": False, "explanation": "Time pattern unavailable", "evidence_refs": []}

    # Network
    if network_ids:
        hit = bool(network_ids & {a["id"] for a in profile.get("associated_persons") or []})
        # also if probe has accused links — network_ids may include co-accused of incident
        factors["network"] = {
            "score": 1.0 if hit else 0.0,
            "available": True,
            "explanation": "Existing documented network relationship to entities linked to the incident"
            if hit
            else "No direct network link found in current graph",
            "evidence_refs": list(network_ids & {a["id"] for a in profile.get("associated_persons") or []})[:5],
        }
    else:
        factors["network"] = {"score": 0.0, "available": False, "explanation": "No incident network context supplied", "evidence_refs": []}

    # Vehicle
    veh_labels = {v["label"].upper() for v in profile.get("associated_vehicles") or []}
    probe_veh = str(probe.get("vehicle") or probe.get("registration") or "").upper()
    if veh_labels and probe_veh:
        hit = probe_veh in veh_labels or any(probe_veh in v for v in veh_labels)
        factors["vehicle"] = {
            "score": 1.0 if hit else 0.0,
            "available": True,
            "explanation": "Associated vehicle overlap" if hit else "No matching associated vehicle",
            "evidence_refs": list(veh_labels)[:5],
        }
    elif veh_labels:
        factors["vehicle"] = {"score": 0.0, "available": False, "explanation": "Incident has no vehicle attribute to compare", "evidence_refs": []}
    else:
        factors["vehicle"] = {"score": 0.0, "available": False, "explanation": "No associated vehicles on profile", "evidence_refs": []}

    # Weighted average over available factors only
    avail = {k: v for k, v in factors.items() if v.get("available")}
    if not avail:
        overall = 0.0
    else:
        wsum = sum(WEIGHTS[k] for k in avail)
        overall = sum(WEIGHTS[k] / wsum * float(avail[k]["score"]) for k in avail)

    reasons = []
    for k, v in sorted(avail.items(), key=lambda kv: -float(kv[1]["score"])):
        if float(v["score"]) >= 0.5:
            reasons.append(
                {
                    "factor": k,
                    "label": k.replace("_", " ").title(),
                    "score_pct": round(float(v["score"]) * 100),
                    "explanation": v["explanation"],
                    "evidence_refs": v.get("evidence_refs") or [],
                }
            )

    return {
        "investigation_relevance": round(overall * 100),
        "investigation_relevance_01": round(overall, 4),
        "factors": {
            k: {
                "score_pct": round(float(v["score"]) * 100) if v["available"] else None,
                "available": v["available"],
                "explanation": v["explanation"],
                "evidence_refs": v.get("evidence_refs") or [],
            }
            for k, v in factors.items()
        },
        "weights": WEIGHTS,
        "reasons": reasons,
        "threshold": round(ALERT_THRESHOLD * 100),
        "disclaimer": "Investigation Relevance is decision-support only. Requires officer verification. Not a guilt or criminality score.",
    }


def match_incident(
    db: Session,
    incident_id: str | None = None,
    probe_body: dict | None = None,
    limit: int = 15,
) -> dict[str, Any]:
    idx = _profile_index(db)
    if probe_body:
        probe = _incident_probe(probe_body)
        probe["synthetic"] = True
    elif incident_id:
        inc = idx["inc_by_id"].get(incident_id)
        if not inc:
            raise KeyError(f"Incident not found: {incident_id}")
        probe = _incident_probe(inc)
    else:
        # Demo synthetic incident derived from a real FIR so IDs stay consistent
        seed = next(iter(idx["inc_by_id"].values()), None)
        if not seed:
            raise KeyError("No incidents available to build a demo probe")
        probe = _incident_probe(seed)
        probe["id"] = f"SYN-PROBE-{seed.id}"
        probe["docket"] = f"DEMO/{seed.docket}"
        probe["synthetic"] = True
        probe["narrative"] = "Synthetic demonstration incident for Person Intelligence matching."

    network_ids: set[str] = set()
    base_inc_id = incident_id
    if not base_inc_id and probe.get("id", "").startswith("SYN-PROBE-"):
        base_inc_id = probe["id"].removeprefix("SYN-PROBE-")
    if base_inc_id and base_inc_id in idx["by_id"]:
        for other_id, kind in idx["adj"].get(base_inc_id, []):
            if kind in ("ACCUSED_IN", "VICTIM_OF", "WITNESSED", "CO_ACCUSED_WITH"):
                network_ids.add(other_id)

    matches: list[dict[str, Any]] = []
    fps = idx.get("fingerprints") or {}
    for o in idx["offenders"]:
        fp = fps.get(o.person.id)
        if fp:
            scored = _score_fingerprint(probe, fp, network_ids)
            documented = int(fp["documented_cases"])
        else:
            profile = build_person_profile(db, o.person.id)
            scored = score_relevance(probe, profile, network_ids)
            documented = len(o.incidents)
        if scored["investigation_relevance_01"] < 0.45:
            continue
        matches.append(
            {
                "person_id": o.person.id,
                "name": o.person.label,
                "district": o.person.district,
                "documented_cases": documented,
                "match_kind": "relevance_potential_match",
                "relevance": scored,
                "alert_eligible": scored["investigation_relevance_01"] >= ALERT_THRESHOLD,
            }
        )
    matches.sort(key=lambda m: -m["relevance"]["investigation_relevance"])
    return {
        "probe": probe,
        "matches": matches[:limit],
        "alert_threshold_pct": round(ALERT_THRESHOLD * 100),
        "disclaimer": "Potential matches require officer verification. YUKTI does not identify perpetrators.",
    }


def _alert_id(person_id: str, probe_id: str) -> str:
    return f"pia:{person_id}:{probe_id}"


def list_alerts(db: Session, limit: int = 40) -> dict[str, Any]:
    """Generate potential-match alerts from a synthetic probe + top recent incidents."""
    match = match_incident(db, incident_id=None, probe_body=None, limit=25)
    states = {
        row.alert_id: row.status
        for row in db.query(PersonIntelAlertState).all()
    }
    alerts = []
    for m in match["matches"]:
        if not m.get("alert_eligible"):
            continue
        aid = _alert_id(m["person_id"], match["probe"]["id"])
        status = states.get(aid, "open")
        if status == "dismissed":
            continue
        rel = m["relevance"]
        alerts.append(
            {
                "id": aid,
                "type": "potential_relevant_person",
                "title": "POTENTIAL RELEVANT PERSON",
                "summary": "A documented person profile shows strong similarities to the current incident.",
                "person_id": m["person_id"],
                "person_name": m["name"],
                "probe": match["probe"],
                "previous_related_cases": m["documented_cases"],
                "investigation_relevance": rel["investigation_relevance"],
                "mo_similarity_pct": rel["factors"]["mo_similarity"]["score_pct"],
                "geographic_overlap": "High"
                if (rel["factors"]["location"]["score_pct"] or 0) >= 70
                else "Moderate"
                if (rel["factors"]["location"]["score_pct"] or 0) >= 40
                else "Limited",
                "reasons": rel["reasons"],
                "status": status,
                "requires_officer_verification": True,
                "disclaimer": rel["disclaimer"],
            }
        )
    alerts.sort(key=lambda a: -a["investigation_relevance"])
    return {
        "alerts": alerts[:limit],
        "probe": match["probe"],
        "disclaimer": match["disclaimer"],
    }


def set_alert_status(db: Session, alert_id: str, status: str, user_id: str) -> dict[str, Any]:
    if status not in ("open", "investigating", "dismissed"):
        raise ValueError("status must be open|investigating|dismissed")
    row = db.get(PersonIntelAlertState, alert_id)
    if row is None:
        row = PersonIntelAlertState(alert_id=alert_id, status=status, updated_by=user_id)
        db.add(row)
    else:
        row.status = status
        row.updated_by = user_id
        row.updated_at = datetime.utcnow()
    db.commit()
    return {"alert_id": alert_id, "status": status}


def dashboard_metrics(db: Session) -> dict[str, Any]:
    data = list_alerts(db, limit=100)
    alerts = data["alerts"]
    high = [a for a in alerts if a["investigation_relevance"] >= round(HIGH_RELEVANCE * 100)]
    investigating = [a for a in alerts if a["status"] == "investigating"]
    offenders = _profiles_from_graph(db)
    if not offenders:
        offenders = get_offender_profiles(db)
    recurring = sum(1 for o in offenders if len(o.districts) > 1)
    return {
        "potential_matches_detected": len(alerts),
        "high_relevance_matches": len(high),
        "marked_for_investigation": len(investigating),
        "recurring_documented_patterns": recurring,
        "documented_person_profiles": len(offenders),
        "disclaimer": "Metrics are decision-support counts from YUKTI dataset comparisons only.",
        "probe_id": data["probe"]["id"],
        "synthetic_probe": bool(data["probe"].get("synthetic")),
    }
