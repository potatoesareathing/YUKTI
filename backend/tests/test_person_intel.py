"""Person Intelligence relevance scoring, search, alerts."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models_orm import GraphSnapshot, ApiSnapshot
from app.services import person_intel as pi


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _seed_minimal(db):
    nodes = [
        {
            "id": "p1",
            "kind": "Person",
            "label": "Ramesh Demo",
            "district": "Bengaluru Urban",
            "community": 0,
            "centrality": 0.9,
            "degree": 3,
            "meta": {"priors": 2, "alias": "Ramu"},
        },
        {
            "id": "p2",
            "kind": "Person",
            "label": "Other",
            "district": "Mysuru",
            "community": 1,
            "centrality": 0.2,
            "degree": 1,
            "meta": {"priors": 0},
        },
        {
            "id": "inc1",
            "kind": "Incident",
            "label": "FIR/1/2024",
            "district": "Bengaluru Urban",
            "community": 0,
            "centrality": 0.1,
            "degree": 1,
            "meta": {"At": 1_700_000_000_000, "Entry": "Forced", "Target": "Residence", "Window": "Night", "Category": "Property Crime"},
        },
        {
            "id": "inc2",
            "kind": "Incident",
            "label": "FIR/2/2024",
            "district": "Bengaluru Urban",
            "community": 0,
            "centrality": 0.1,
            "degree": 1,
            "meta": {"At": 1_700_100_000_000, "Entry": "Forced", "Target": "Residence", "Window": "Night", "Category": "Property Crime"},
        },
        {
            "id": "v1",
            "kind": "ANPR_Vehicle",
            "label": "KA01AB9999",
            "district": "Bengaluru Urban",
            "community": 0,
            "centrality": 0.1,
            "degree": 1,
            "meta": {"registration": "KA01AB9999"},
        },
    ]
    edges = [
        {"id": "e1", "source": "p1", "target": "inc1", "kind": "ACCUSED_IN", "weight": 1.0, "confidence": 1.0},
        {"id": "e2", "source": "p1", "target": "inc2", "kind": "ACCUSED_IN", "weight": 1.0, "confidence": 1.0},
        {"id": "e3", "source": "p1", "target": "v1", "kind": "ASSOCIATED_WITH", "weight": 1.0, "confidence": 1.0},
        {"id": "e4", "source": "p1", "target": "p2", "kind": "CO_ACCUSED_WITH", "weight": 1.0, "confidence": 1.0},
    ]
    db.add(GraphSnapshot(id=1, nodes=nodes, edges=edges, communities=[]))
    # Bootstrap-style incidents snapshot used by get_incidents
    incidents = [
        {
            "id": "inc1",
            "docket": "FIR/1/2024",
            "category": "Property Crime",
            "district": "Bengaluru Urban",
            "station": "PS Demo",
            "lonLat": [77.59, 12.97],
            "world": [0, 0],
            "at": 1_700_000_000_000,
            "status": "Under Investigation",
            "mo": {"entry": "Forced", "target": "Residence", "timing": "Night", "tools": "Crowbar"},
            "narrative": "demo",
            "officer": "O1",
            "anomaly": False,
            "anomalyScore": 0.0,
        },
        {
            "id": "inc2",
            "docket": "FIR/2/2024",
            "category": "Property Crime",
            "district": "Bengaluru Urban",
            "station": "PS Demo",
            "lonLat": [77.60, 12.98],
            "world": [0, 0],
            "at": 1_700_100_000_000,
            "status": "Under Investigation",
            "mo": {"entry": "Forced", "target": "Residence", "timing": "Night", "tools": "Crowbar"},
            "narrative": "demo",
            "officer": "O1",
            "anomaly": False,
            "anomalyScore": 0.0,
        },
    ]
    db.add(ApiSnapshot(id="incidents", payload=incidents))
    db.commit()


def test_profile_search_and_timeline_order():
    db = _session()
    _seed_minimal(db)

    from app.services.offenders import get_offender_profiles

    profiles = get_offender_profiles(db)
    assert any(p.person.id == "p1" for p in profiles)

    prof = pi.build_person_profile(db, "p1")
    assert prof["name"] == "Ramesh Demo"
    assert prof["documented_cases"] == 2
    assert prof["timeline"][0]["at"] <= prof["timeline"][-1]["at"]
    assert any(v["label"] == "KA01AB9999" for v in prof["associated_vehicles"])

    hits = pi.search_persons(db, "Ramesh")
    assert hits and hits[0]["person_id"] == "p1"
    exact = pi.search_persons(db, "FIR/1/2024")
    assert exact and exact[0]["match_kind"] in ("exact_record", "record_match")


def test_relevance_scoring_and_threshold():
    profile = {
        "crime_types": [{"type": "Property Crime", "count": 2}],
        "documented_mo_patterns": [{"signature": "Forced → Residence", "count": 2}],
        "mo_signature": "Forced → Residence",
        "historical_locations": [{"district": "Bengaluru Urban", "count": 2}],
        "timeline": [{"at": 1_700_000_000_000, "case_id": "inc1", "category": "Property Crime"}],
        "map_points": [{"lonLat": [77.59, 12.97], "case_id": "inc1"}],
        "associated_persons": [{"id": "p2"}],
        "associated_vehicles": [{"label": "KA01AB9999"}],
    }
    probe = {
        "category": "Property Crime",
        "district": "Bengaluru Urban",
        "mo_entry": "Forced",
        "mo_target": "Residence",
        "mo_timing": "Night",
        "mo_tools": "Crowbar",
        "at": 1_700_050_000_000,
        "lonLat": [77.591, 12.971],
        "vehicle": "KA01AB9999",
    }
    scored = pi.score_relevance(probe, profile, {"p2"})
    assert scored["investigation_relevance"] >= 70
    assert scored["factors"]["crime_type"]["score_pct"] == 100
    assert scored["factors"]["mo_similarity"]["available"] is True
    assert "disclaimer" in scored

    # Missing data should not invent high scores
    empty = pi.score_relevance({"category": ""}, {"crime_types": [], "timeline": []}, set())
    assert empty["investigation_relevance"] == 0


def test_alerts_and_status():
    db = _session()
    _seed_minimal(db)

    alerts = pi.list_alerts(db)
    assert "alerts" in alerts
    assert alerts["probe"].get("synthetic") is True
    if alerts["alerts"]:
        aid = alerts["alerts"][0]["id"]
        out = pi.set_alert_status(db, aid, "dismissed", "tester")
        assert out["status"] == "dismissed"
        again = pi.list_alerts(db)
        assert all(a["id"] != aid for a in again["alerts"])

    dash = pi.dashboard_metrics(db)
    assert "potential_matches_detected" in dash
    assert "documented_person_profiles" in dash
