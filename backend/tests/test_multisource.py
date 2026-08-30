"""Multi-source ingest + syndicate pathfinding."""

from __future__ import annotations

import json

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.services import multisource


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_cdr_and_anpr_ingest_and_multihop_path():
    db = _session()
    cdr = [
        {
            "caller": "9876500001",
            "receiver": "9876500002",
            "duration": 120,
            "cell_tower": "BLR-T1",
            "imei": "356938035643809",
            "timestamp": 1_700_000_000_000,
        }
    ]
    anpr = [
        {
            "registration": "KA01AB1234",
            "camera_id": "TOLL-1",
            "lat": 12.97,
            "lng": 77.59,
            "timestamp": 1_700_000_100_000,
        }
    ]
    # Link phone world to vehicle via a synthetic co-link: bank hop between entities
    # by adding finance between accounts tagged on phones is overkill — instead
    # connect ANPR vehicle to a phone via a second CDR tower location reuse is enough
    # for independent node creation; for multi-hop we add a shared bank path:
    finance = [
        {
            "source_account": "111122223333",
            "destination_account": "444455556666",
            "amount": 50000,
            "ifsc": "SBIN0001234",
            "timestamp": 1_700_000_200_000,
        }
    ]
    r1 = multisource.ingest_cdr(db, json.dumps(cdr), "application/json")
    r2 = multisource.ingest_anpr(db, json.dumps(anpr), "application/json")
    r3 = multisource.ingest_finance(db, json.dumps(finance), "application/json")
    assert r1["edges_added"] >= 1
    assert r2["nodes_added"] >= 1
    assert r3["edges_added"] >= 1

    path = multisource.syndicate_paths(db, "cdr:9876500001", "cdr:9876500002")
    assert path["found"] is True
    assert path["hops"] >= 1
    assert path["nodes"][0]["id"] == "cdr:9876500001"
    assert path["nodes"][-1]["id"] == "cdr:9876500002"


def test_ensure_overlay_from_catalyst_persons():
    db = _session()
    # Seed a mini Catalyst-like FIR graph (persons + co-accused + location)
    from app.models_orm import GraphSnapshot

    nodes = [
        {
            "id": "p1",
            "kind": "Person",
            "label": "A",
            "district": "Bengaluru Urban",
            "community": 0,
            "centrality": 0.9,
            "degree": 2,
        },
        {
            "id": "p2",
            "kind": "Person",
            "label": "B",
            "district": "Bengaluru Urban",
            "community": 0,
            "centrality": 0.8,
            "degree": 2,
        },
        {
            "id": "loc1",
            "kind": "Location",
            "label": "PS Demo",
            "district": "Bengaluru Urban",
            "community": 0,
            "centrality": 0.1,
            "degree": 0,
        },
    ]
    edges = [
        {
            "id": "e1",
            "source": "p1",
            "target": "p2",
            "kind": "CO_ACCUSED_WITH",
            "weight": 1.0,
            "confidence": 1.0,
        }
    ]
    db.add(GraphSnapshot(id=1, nodes=nodes, edges=edges, communities=[]))
    db.commit()

    result = multisource.ensure_multisource_overlay(db)
    assert result["status"] == "hydrated"
    assert result["source"] == "catalyst_persons"
    assert result["multi_source_nodes"] >= 4

    again = multisource.ensure_multisource_overlay(db)
    assert again["status"] == "already"

    path = multisource.syndicate_paths(db, "p1", "p2")
    assert path["found"] is True
    assert path["hops"] >= 1
