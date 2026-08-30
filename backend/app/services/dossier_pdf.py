"""KSP-style Criminal History / Rowdy-Sheet PDF generator (reportlab)."""

from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


def render_ksp_dossier_pdf(dossier: dict[str, Any]) -> bytes:
    """Return PDF bytes formatted like a KSP Criminal History / Rowdy Sheet."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title="KSP Criminal History Sheet",
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "KSPTitle",
        parent=styles["Heading1"],
        alignment=TA_CENTER,
        fontSize=13,
        spaceAfter=2,
        textColor=colors.HexColor("#0B1F3A"),
    )
    sub = ParagraphStyle(
        "KSPSub",
        parent=styles["Normal"],
        alignment=TA_CENTER,
        fontSize=9,
        textColor=colors.HexColor("#333333"),
        spaceAfter=8,
    )
    body = ParagraphStyle("KSPBody", parent=styles["Normal"], fontSize=8, leading=11)
    label = ParagraphStyle("KSPLabel", parent=styles["Normal"], fontSize=8, textColor=colors.HexColor("#555555"))

    suspect = dossier.get("suspect") or {}
    story: list[Any] = []
    story.append(Paragraph("KARNATAKA STATE POLICE", title))
    story.append(Paragraph("Criminal History Sheet / Rowdy Sheet (CIAP — YUKTI)", sub))
    story.append(Paragraph("Confidential — For official use only", sub))

    meta_rows = [
        [
            Paragraph("<b>Name</b>", label),
            Paragraph(str(suspect.get("name", "—")), body),
            Paragraph("<b>Suspect ID</b>", label),
            Paragraph(str(suspect.get("id", "—")), body),
        ],
        [
            Paragraph("<b>District</b>", label),
            Paragraph(str(suspect.get("district", "—")), body),
            Paragraph("<b>Priors</b>", label),
            Paragraph(str(suspect.get("priors", "—")), body),
        ],
        [
            Paragraph("<b>Age</b>", label),
            Paragraph(str(suspect.get("age", "—")), body),
            Paragraph("<b>Generated</b>", label),
            Paragraph(str(dossier.get("generated_at", datetime.now(tz=timezone.utc).isoformat())), body),
        ],
    ]
    meta = Table(meta_rows, colWidths=[28 * mm, 55 * mm, 28 * mm, 55 * mm])
    meta.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#0B1F3A")),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.grey),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F0F3F7")),
                ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#F0F3F7")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(meta)
    story.append(Spacer(1, 8))

    rowdy = dossier.get("rowdy_sheet")
    if rowdy:
        story.append(Paragraph("<b>Rowdy Sheet categorization</b>", body))
        story.append(
            Paragraph(
                f"Category {rowdy.get('category', '—')} · Opened {rowdy.get('opened_at', '—')} · {rowdy.get('notes', '')}",
                body,
            )
        )
        story.append(Spacer(1, 6))

    story.append(Paragraph("<b>Chronological case history (FIRs)</b>", body))
    fir_header = ["Docket", "Station", "District", "Status", "Sections / MO", "At"]
    fir_data = [fir_header]
    for f in dossier.get("firs") or []:
        fir_data.append(
            [
                str(f.get("docket", ""))[:18],
                str(f.get("station", ""))[:16],
                str(f.get("district", ""))[:14],
                str(f.get("status", ""))[:14],
                str(f.get("section_codes", ""))[:10] + " / " + str(f.get("mo", ""))[:28],
                str(f.get("at", ""))[:13],
            ]
        )
    if len(fir_data) == 1:
        fir_data.append(["—", "—", "—", "—", "No linked FIRs", "—"])
    fir_table = Table(fir_data, colWidths=[28 * mm, 28 * mm, 26 * mm, 26 * mm, 52 * mm, 22 * mm])
    fir_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B1F3A")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(fir_table)
    story.append(Spacer(1, 8))

    # Sensitive / restricted block (already masked by RBAC)
    if dossier.get("firs"):
        sample = dossier["firs"][0]
        story.append(Paragraph("<b>Restricted investigative notes</b>", body))
        story.append(
            Paragraph(
                f"Informant: {sample.get('informant_details', '—')}<br/>"
                f"Wiretap: {sample.get('wiretap_logs', '—')}<br/>"
                f"Surveillance: {sample.get('active_surveillance_notes', '—')}",
                body,
            )
        )
        story.append(Spacer(1, 6))

    story.append(Paragraph("<b>Court cases &amp; bail (e-Courts)</b>", body))
    court_data = [["CNR / Case", "Court", "Status", "Bail"]]
    for c in dossier.get("court_cases") or []:
        court_data.append(
            [
                str(c.get("ecourts_cnr") or c.get("case_number", "")),
                str(c.get("court_name", ""))[:24],
                str(c.get("status", "")),
                str(c.get("bail_status", "")),
            ]
        )
    if len(court_data) == 1:
        court_data.append(["—", "—", "None on record", "—"])
    ct = Table(court_data, colWidths=[45 * mm, 55 * mm, 35 * mm, 35 * mm])
    ct.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#C45C26")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
            ]
        )
    )
    story.append(ct)
    story.append(Spacer(1, 8))

    story.append(Paragraph("<b>Active NBWs</b>", body))
    wdata = [["Type", "Court", "Status", "Issued"]]
    for w in dossier.get("warrants") or []:
        wdata.append(
            [
                str(w.get("warrant_type", "")),
                str(w.get("court_name", ""))[:28],
                str(w.get("status", "")),
                str(w.get("issued_at", "")),
            ]
        )
    if len(wdata) == 1:
        wdata.append(["—", "—", "None", "—"])
    wt = Table(wdata, colWidths=[25 * mm, 70 * mm, 35 * mm, 40 * mm])
    wt.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B1F3A")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
            ]
        )
    )
    story.append(wt)
    story.append(Spacer(1, 8))

    story.append(Paragraph("<b>Known MO signatures</b>", body))
    for mo in dossier.get("mo_signatures") or ["—"]:
        story.append(Paragraph(f"• {mo}", body))
    story.append(Spacer(1, 6))

    story.append(Paragraph("<b>Network associations (snapshot)</b>", body))
    ndata = [["Edge", "Kind", "Linked entity"]]
    for n in (dossier.get("network") or [])[:25]:
        ndata.append([str(n.get("id", ""))[:20], str(n.get("kind", "")), str(n.get("other", ""))[:28]])
    if len(ndata) == 1:
        ndata.append(["—", "—", "No graph links"])
    nt = Table(ndata, colWidths=[45 * mm, 45 * mm, 80 * mm])
    nt.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B1F3A")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
            ]
        )
    )
    story.append(nt)
    story.append(Spacer(1, 10))
    story.append(
        Paragraph(
            "Generated by YUKTI · Not a substitute for CCTNS certified extracts · Audit logged on export",
            ParagraphStyle("Foot", parent=body, alignment=TA_CENTER, fontSize=7, textColor=colors.grey),
        )
    )

    doc.build(story)
    return buf.getvalue()
