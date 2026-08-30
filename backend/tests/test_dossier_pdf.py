"""Dossier PDF generation timing and layout smoke."""

from __future__ import annotations

import time

from app.services.dossier_pdf import render_ksp_dossier_pdf


def test_pdf_generates_under_two_seconds_and_looks_like_pdf():
    dossier = {
        "suspect": {
            "id": "P-DEMO",
            "name": "Demo Accused",
            "district": "Bengaluru Urban",
            "priors": 3,
            "age": 34,
        },
        "firs": [
            {
                "docket": "FIR/0123/2025",
                "station": "Peenya PS",
                "district": "Bengaluru Urban",
                "status": "Under Investigation",
                "section_codes": "IPC 379",
                "mo": "Forced entry → jewellery · night",
                "at": 1_700_000_000_000,
                "informant_details": "[RESTRICTED - INSPECTOR OR ABOVE]",
                "wiretap_logs": "[RESTRICTED - INSPECTOR OR ABOVE]",
                "active_surveillance_notes": "[RESTRICTED - INSPECTOR OR ABOVE]",
            }
        ],
        "court_cases": [
            {
                "case_number": "CC/1/2025",
                "court_name": "JMFC",
                "status": "Pending",
                "bail_status": "On Bail",
                "ecourts_cnr": "KAXX01-000001-2025",
            }
        ],
        "warrants": [{"warrant_type": "NBW", "court_name": "Sessions", "status": "Active", "issued_at": 1}],
        "rowdy_sheet": {"category": "A", "opened_at": 1, "notes": "Demo"},
        "network": [{"id": "e1", "kind": "CO_ACCUSED_WITH", "other": "P-2"}],
        "mo_signatures": ["Forced entry → jewellery · night"],
        "generated_at": "2026-08-30T00:00:00Z",
    }
    t0 = time.perf_counter()
    pdf = render_ksp_dossier_pdf(dossier)
    elapsed = time.perf_counter() - t0
    assert elapsed < 2.0, f"PDF took {elapsed:.3f}s"
    assert pdf[:4] == b"%PDF"
    assert len(pdf) > 800
