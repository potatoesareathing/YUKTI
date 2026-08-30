"""CCTNS webhook, Kannada NLP, MO match, beat geofence tests."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.v1_routes import _require_cctns_auth
from app.db import Base
from app.models_orm import CaseMaster, CrimeHead, District, Unit
from app.services import beat, cctns
from app.services.kannada_nlp import extract_mo_entities
from app.services.mo_match import mo_similarity


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_kannada_nlp_extracts_entities():
    text = (
        "ಕುಖ್ಯಾತ ರೌಡಿ ಸ್ಟಾಕರ್ ಆರೋಪಿ ಕಪ್ಪು ಬಣ್ಣದ ಪಲ್ಸರ್ ಬಳಸಿ "
        "ಒಂಟಿ ಮಹಿಳೆಯರನ್ನು ಗುರಿಮಾಡಿ ಸರಗಳ್ಳತನ ಮಾಡಿದ. ಆಯುಧ: ಕಬ್ಬಿಣದ ರಾಡ್."
    )
    meta = extract_mo_entities(text)
    assert meta["suspect_aliases"] or meta["mo_methods"]
    assert any("ಸರಗಳ್ಳತನ" in m for m in meta["mo_methods"]) or "chain_snatching" in meta["mo_tags"]
    assert meta["weapons"]
    assert meta["mo_tags"]


def test_mo_match_cross_district_high_score():
    a = {"mo_tags": ["chain_snatching", "iron_rod", "pulsar", "target_lone_women"]}
    b = {"mo_tags": ["chain_snatching", "iron_rod", "pulsar", "target_lone_women"]}
    sim = mo_similarity(a, b)
    assert sim["score"] >= 0.8
    assert "chain_snatching" in sim["shared_tags"]


def test_cctns_webhook_ingest_and_match():
    db = _session()
    db.add(District(id=1, name="Bengaluru Urban", code="BNU", population=1, urban_pct=0.8, literacy_pct=0.9, stations=10, lon=77.59, lat=12.97))
    db.add(District(id=2, name="Mysuru City", code="MYS", population=1, urban_pct=0.7, literacy_pct=0.85, stations=8, lon=76.65, lat=12.3))
    db.add(CrimeHead(id=1, name="Robbery"))
    db.add(Unit(id="PS1", name="PS One", district_id=1, lon=77.59, lat=12.97))
    db.commit()

    narrative = "ಸರಗಳ್ಳತನ · ಕಬ್ಬಿಣದ ರಾಡ್ · ಕಪ್ಪು ಬಣ್ಣದ ಪಲ್ಸರ್ · ಒಂಟಿ ಮಹಿಳೆಯರನ್ನು ಗುರಿಮಾಡಿ"
    e1 = cctns.ingest_fir_payload(
        db,
        {
            "cctns_fir_id": "FIR-A-001",
            "district_id": "Bengaluru Urban",
            "police_station_code": "PS1",
            "crime_head_name": "Robbery",
            "lat": 12.97,
            "lng": 77.59,
            "raw_kannada_narrative": narrative,
            "fir_timestamp": 1_700_000_000_000,
        },
        source="webhook",
    )
    e2 = cctns.ingest_fir_payload(
        db,
        {
            "cctns_fir_id": "FIR-B-002",
            "district_id": "Mysuru City",
            "police_station_code": "PS2",
            "crime_head_name": "Robbery",
            "lat": 12.3,
            "lng": 76.65,
            "raw_kannada_narrative": narrative,
            "fir_timestamp": 1_700_000_100_000,
        },
        source="webhook",
    )
    assert e1["parsed_mo_metadata"]["mo_tags"]
    assert e2["mo_alerts"], "identical MO tags across districts should raise emerging pattern"
    assert e2["mo_alerts"][0]["score"] >= 0.8


def test_geofence_red_zone_hit():
    db = _session()
    # Seed a CCTNS FIR so red zone centres on Bengaluru
    cctns.ingest_fir_payload(
        db,
        {
            "cctns_fir_id": "FIR-GEO-1",
            "district_id": "Bengaluru Urban",
            "lat": 12.9716,
            "lng": 77.5946,
            "crime_head_name": "Chain Snatching",
            "raw_kannada_narrative": "ಸರಗಳ್ಳತನ",
            "fir_timestamp": 1,
        },
        source="webhook",
    )
    cctns.ingest_fir_payload(
        db,
        {
            "cctns_fir_id": "FIR-GEO-2",
            "district_id": "Bengaluru Urban",
            "lat": 12.972,
            "lng": 77.595,
            "crime_head_name": "Chain Snatching",
            "raw_kannada_narrative": "ಸರಗಳ್ಳತನ",
            "fir_timestamp": 2,
        },
        source="webhook",
    )
    hit = beat.check_geofence(db, 12.9716, 77.5946)
    assert hit["inside"] is True
    assert hit["zones"]
    miss = beat.check_geofence(db, 15.0, 75.0)
    assert miss["inside"] is False


def _fake_request(client_host: str = "203.0.113.10", forwarded: str | None = None):
    req = MagicMock()
    req.headers = {}
    if forwarded:
        req.headers["x-forwarded-for"] = forwarded
    req.client = MagicMock()
    req.client.host = client_host
    return req


def test_cctns_auth_bypass_allows_missing_key():
    settings = MagicMock(
        auth_bypass=True,
        cctns_api_key="yukti-cctns-dev-key",
        cctns_ip_allowlist="",
    )
    with patch("app.api.v1_routes.get_settings", return_value=settings):
        _require_cctns_auth(_fake_request(), None)
        _require_cctns_auth(_fake_request(), "yukti-cctns-dev-key")


def test_cctns_auth_bypass_rejects_wrong_key():
    settings = MagicMock(
        auth_bypass=True,
        cctns_api_key="yukti-cctns-dev-key",
        cctns_ip_allowlist="",
    )
    with patch("app.api.v1_routes.get_settings", return_value=settings):
        with pytest.raises(HTTPException) as exc:
            _require_cctns_auth(_fake_request(), "wrong-key")
        assert exc.value.status_code == 401


def test_cctns_auth_requires_key_when_bypass_off():
    settings = MagicMock(
        auth_bypass=False,
        cctns_api_key="yukti-cctns-dev-key",
        cctns_ip_allowlist="",
    )
    with patch("app.api.v1_routes.get_settings", return_value=settings):
        with pytest.raises(HTTPException) as exc:
            _require_cctns_auth(_fake_request(), None)
        assert exc.value.status_code == 401
        _require_cctns_auth(_fake_request(), "yukti-cctns-dev-key")


def test_cctns_auth_empty_allowlist_does_not_block():
    settings = MagicMock(
        auth_bypass=False,
        cctns_api_key="yukti-cctns-dev-key",
        cctns_ip_allowlist="",
    )
    with patch("app.api.v1_routes.get_settings", return_value=settings):
        _require_cctns_auth(_fake_request(client_host="198.51.100.1"), "yukti-cctns-dev-key")


def test_cctns_auth_allowlist_enforced_when_set():
    settings = MagicMock(
        auth_bypass=False,
        cctns_api_key="yukti-cctns-dev-key",
        cctns_ip_allowlist="10.0.0.1,10.0.0.2",
    )
    with patch("app.api.v1_routes.get_settings", return_value=settings):
        with pytest.raises(HTTPException) as exc:
            _require_cctns_auth(_fake_request(client_host="198.51.100.1"), "yukti-cctns-dev-key")
        assert exc.value.status_code == 403
        _require_cctns_auth(_fake_request(client_host="10.0.0.2"), "yukti-cctns-dev-key")
