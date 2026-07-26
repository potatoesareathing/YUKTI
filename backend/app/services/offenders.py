from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from app.schemas import GraphNode, OffenderIncident, OffenderMatch, OffenderProfile
from app.services.graph import get_graph
from app.services.snapshot import load


def get_offender_profiles(db: Session) -> list[OffenderProfile]:
    cached = load(db, "offenders")
    if cached is not None:
        return [OffenderProfile.model_validate(o) for o in cached]

    data = get_graph(db)
    by_id = {n.id: n for n in data.nodes}

    linked: dict[str, list[OffenderIncident]] = defaultdict(list)
    for e in data.edges:
        if e.kind != "ACCUSED_IN":
            continue
        src, tgt = by_id.get(e.source), by_id.get(e.target)
        if not src or not tgt:
            continue
        person = src if src.kind == "Person" else tgt if tgt.kind == "Person" else None
        incident = src if src.kind == "Incident" else tgt if tgt.kind == "Incident" else None
        if not person or not incident or not incident.meta:
            continue
        m = incident.meta
        linked[person.id].append(
            OffenderIncident(
                id=incident.id,
                docket=incident.label,
                district=incident.district,
                at=int(m.get("At", 0)),
                entry=str(m.get("Entry", "—")),
                target=str(m.get("Target", "—")),
                window=str(m.get("Window", "—")),
            )
        )

    profiles: list[OffenderProfile] = []
    sig_index: dict[str, list[tuple[GraphNode, str]]] = defaultdict(list)

    for pid, incidents in linked.items():
        if len(incidents) < 2:
            continue
        person = by_id[pid]
        incidents.sort(key=lambda i: i.at)
        # dominant signature
        counts: dict[str, int] = defaultdict(int)
        for i in incidents:
            counts[f"{i.entry} → {i.target}"] += 1
        signature = max(counts, key=counts.get)  # type: ignore[arg-type]
        districts = sorted({i.district for i in incidents})
        span = max(0, (incidents[-1].at - incidents[0].at) // 86_400_000)
        priors = int(person.meta.get("priors", len(incidents) - 1)) if person.meta else len(incidents) - 1
        sig_index[signature].append((person, districts[0] if districts else person.district))
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

    for p in profiles:
        matches = []
        for other, dist in sig_index.get(p.signature, []):
            if other.id == p.person.id:
                continue
            if dist in p.districts:
                continue
            matches.append(OffenderMatch(person=other, district=dist, shared=1))
        p.matches = matches[:5]

    profiles.sort(key=lambda p: len(p.incidents), reverse=True)
    return profiles[:80]
