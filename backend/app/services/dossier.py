"""Aggregate multi-jurisdictional records for a KSP criminal history / rowdy sheet."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models_orm import (
    Accused,
    CaseMaster,
    CaseSensitiveNotes,
    CourtCase,
    District,
    Person,
    RowdySheet,
    Unit,
    Warrant,
)
from app.rbac import UserContext, assert_dossier_export_allowed, mask_sensitive_fields
from app.services.graph import get_graph
from app.services.offenders import get_offender_profiles


def _ensure_demo_legal(db: Session, person_id: str) -> None:
    """Seed lightweight court/warrant/rowdy rows for demo if person exists and has none."""
    person = db.get(Person, person_id)
    if not person:
        return
    if db.query(CourtCase).filter(CourtCase.person_id == person_id).count() == 0:
        db.add(
            CourtCase(
                person_id=person_id,
                case_number=f"CC/{person_id[-4:]}/2025",
                court_name="JMFC / Sessions — demo",
                status="Pending",
                bail_status="On Bail" if person.priors < 3 else "Custody",
                ecourts_cnr=f"KAXX01-{person_id[-6:]}-2025",
            )
        )
    if db.query(Warrant).filter(Warrant.person_id == person_id).count() == 0 and person.priors >= 2:
        db.add(
            Warrant(
                person_id=person_id,
                warrant_type="NBW",
                issued_at=int(datetime.now(tz=timezone.utc).timestamp() * 1000) - 86400000 * 40,
                status="Active",
                court_name="District Court — demo",
            )
        )
    if db.get(RowdySheet, person_id) is None and person.priors >= 3:
        db.add(
            RowdySheet(
                person_id=person_id,
                category="A",
                opened_at=int(datetime.now(tz=timezone.utc).timestamp() * 1000) - 86400000 * 400,
                notes="Auto-seeded demo rowdy sheet for dossier PDF.",
            )
        )
    # Sensitive notes for first linked case (masking demos)
    accused = db.query(Accused).filter(Accused.person_id == person_id).first()
    if accused and db.get(CaseSensitiveNotes, accused.case_id) is None:
        db.add(
            CaseSensitiveNotes(
                case_id=accused.case_id,
                informant_details="Confidential informant ID IF-DEMO-01",
                wiretap_logs="Intercept summary REF/WT/DEMO",
                active_surveillance_notes="Static surveillance notes — restricted",
            )
        )
    db.commit()


def build_dossier(db: Session, suspect_id: str, user: UserContext) -> dict[str, Any]:
    person = db.get(Person, suspect_id)
    if not person:
        # Fall back to graph offender id
        profiles = {p.person.id: p for p in get_offender_profiles(db)}
        if suspect_id not in profiles:
            raise KeyError(f"Suspect not found: {suspect_id}")
        # Graph-only person — still build from offender profile
        profile = profiles[suspect_id]
        firs = []
        for inc in profile.incidents:
            firs.append(
                {
                    "case_id": inc.id,
                    "docket": inc.docket,
                    "district": inc.district,
                    "district_id": inc.district,
                    "station": "—",
                    "station_id": None,
                    "status": "Under Investigation",
                    "section_codes": "IPC (seed)",
                    "at": inc.at,
                    "mo": f"{inc.entry} → {inc.target} · {inc.window}",
                    "informant_details": "Confidential informant ID IF-DEMO-01",
                    "wiretap_logs": "Intercept summary REF/WT/DEMO",
                    "active_surveillance_notes": "Static surveillance notes — restricted",
                }
            )
        assert_dossier_export_allowed(
            user,
            suspect_district_ids=[d for d in profile.districts],
            suspect_station_ids=[],
        )
        graph = get_graph(db)
        associations = [
            {"id": e.id, "kind": e.kind, "other": e.target if e.source == suspect_id else e.source}
            for e in graph.edges
            if e.source == suspect_id or e.target == suspect_id
        ][:40]
        payload = {
            "suspect": {
                "id": profile.person.id,
                "name": profile.person.label,
                "district": profile.person.district,
                "priors": profile.priors,
                "signature": profile.signature,
                "span_days": profile.spanDays,
            },
            "firs": firs,
            "court_cases": [],
            "warrants": [],
            "rowdy_sheet": None,
            "network": associations,
            "mo_signatures": [profile.signature],
            "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        }
        return mask_sensitive_fields(payload, user)

    _ensure_demo_legal(db, suspect_id)

    district = db.get(District, person.district_id)
    links = db.query(Accused).filter(Accused.person_id == suspect_id).all()
    firs: list[dict[str, Any]] = []
    station_ids: list[str] = []
    district_ids: list[str] = [str(person.district_id)]
    if district:
        district_ids.append(district.name)

    for link in links:
        case = db.get(CaseMaster, link.case_id)
        if not case:
            continue
        unit = db.get(Unit, case.unit_id)
        dist = db.get(District, case.district_id)
        notes = db.get(CaseSensitiveNotes, case.id)
        station_ids.append(case.unit_id)
        district_ids.append(str(case.district_id))
        if dist:
            district_ids.append(dist.name)
        firs.append(
            {
                "case_id": case.id,
                "docket": case.crime_no,
                "district": dist.name if dist else "",
                "district_id": str(case.district_id),
                "station": unit.name if unit else case.unit_id,
                "station_id": case.unit_id,
                "status": case.status,
                "section_codes": f"CH-{case.crime_head_id}",
                "at": case.registered_at,
                "mo": f"{case.mo_entry} → {case.mo_target} · {case.mo_timing}",
                "informant_details": notes.informant_details if notes else "",
                "wiretap_logs": notes.wiretap_logs if notes else "",
                "active_surveillance_notes": notes.active_surveillance_notes if notes else "",
            }
        )

    assert_dossier_export_allowed(
        user,
        suspect_district_ids=district_ids,
        suspect_station_ids=station_ids,
    )

    courts = [
        {
            "case_number": c.case_number,
            "court_name": c.court_name,
            "status": c.status,
            "bail_status": c.bail_status,
            "ecourts_cnr": c.ecourts_cnr,
        }
        for c in db.query(CourtCase).filter(CourtCase.person_id == suspect_id).all()
    ]
    warrants = [
        {
            "warrant_type": w.warrant_type,
            "issued_at": w.issued_at,
            "status": w.status,
            "court_name": w.court_name,
        }
        for w in db.query(Warrant).filter(Warrant.person_id == suspect_id).all()
    ]
    rowdy = db.get(RowdySheet, suspect_id)
    graph = get_graph(db)
    associations = [
        {"id": e.id, "kind": e.kind, "other": e.target if e.source == suspect_id else e.source}
        for e in graph.edges
        if e.source == suspect_id or e.target == suspect_id
    ][:40]

    mo_set = sorted({f["mo"] for f in firs if f.get("mo")})
    payload = {
        "suspect": {
            "id": person.id,
            "name": person.name,
            "age": person.age,
            "district": district.name if district else "",
            "district_id": str(person.district_id),
            "priors": person.priors,
            "mo_cluster": person.mo_cluster,
        },
        "firs": firs,
        "court_cases": courts,
        "warrants": warrants,
        "rowdy_sheet": (
            {
                "category": rowdy.category,
                "opened_at": rowdy.opened_at,
                "notes": rowdy.notes,
            }
            if rowdy
            else None
        ),
        "network": associations,
        "mo_signatures": mo_set,
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
    }
    return mask_sensitive_fields(payload, user)
