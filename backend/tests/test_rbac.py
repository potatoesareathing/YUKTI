"""RBAC unit tests — masking and dossier jurisdiction."""

from __future__ import annotations

import pytest

from app.rbac import (
    RESTRICTED_MARKER,
    PoliceRole,
    UserContext,
    assert_dossier_export_allowed,
    filter_fir_records,
    mask_sensitive_fields,
)


def test_constable_cannot_see_sensitive_notes():
    user = UserContext(
        user_id="c1",
        username="constable",
        rank=PoliceRole.CONSTABLE,
        clearance_level=1,
        station_id="STN-01",
        district_id="1",
    )
    payload = {
        "informant_details": "secret",
        "wiretap_logs": "tap",
        "active_surveillance_notes": "watch",
        "docket": "FIR/1",
    }
    masked = mask_sensitive_fields(payload, user)
    assert masked["informant_details"] == RESTRICTED_MARKER
    assert masked["wiretap_logs"] == RESTRICTED_MARKER
    assert masked["active_surveillance_notes"] == RESTRICTED_MARKER
    assert masked["docket"] == "FIR/1"


def test_inspector_sees_sensitive_notes():
    user = UserContext(
        user_id="i1",
        username="insp",
        rank=PoliceRole.INSPECTOR,
        clearance_level=3,
        district_id="Bengaluru Urban",
    )
    payload = {"informant_details": "secret", "wiretap_logs": "tap", "active_surveillance_notes": "watch"}
    assert mask_sensitive_fields(payload, user)["informant_details"] == "secret"


def test_constable_station_scope_filters_firs():
    user = UserContext(
        user_id="c1",
        username="constable",
        rank=PoliceRole.CONSTABLE,
        clearance_level=1,
        station_id="STN-01",
        district_id="1",
    )
    records = [
        {"station_id": "STN-01", "district_id": "1", "informant_details": "a"},
        {"station_id": "STN-99", "district_id": "1", "informant_details": "b"},
    ]
    out = filter_fir_records(records, user)
    assert len(out) == 1
    assert out[0]["station_id"] == "STN-01"
    assert out[0]["informant_details"] == RESTRICTED_MARKER


def test_constable_cannot_export_out_of_district_dossier():
    user = UserContext(
        user_id="c1",
        username="constable",
        rank=PoliceRole.CONSTABLE,
        clearance_level=1,
        station_id="STN-01",
        district_id="1",
    )
    with pytest.raises(PermissionError):
        assert_dossier_export_allowed(
            user,
            suspect_district_ids=["2", "Other District"],
            suspect_station_ids=["STN-99"],
        )


def test_scrb_admin_can_export_anywhere():
    user = UserContext(
        user_id="admin",
        username="admin",
        rank=PoliceRole.SCRB_ADMIN,
        clearance_level=5,
    )
    assert_dossier_export_allowed(
        user,
        suspect_district_ids=["anywhere"],
        suspect_station_ids=["STN-X"],
    )
