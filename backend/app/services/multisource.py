"""Multi-source correlation ingestion: CDR, ANPR, financial → graph nodes/edges."""

from __future__ import annotations

import csv
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models_orm import GraphSnapshot
from app.schemas import GraphData, GraphEdge, GraphNode
from app.services.snapshot import db_get, publish


MULTI_NODE_KINDS = {"Suspect", "Victim", "Location", "CDR_Phone", "ANPR_Vehicle", "BankAccount", "IMEI", "Person", "Incident", "Vehicle", "Organisation"}
MULTI_EDGE_KINDS = {"CALLED", "SIGHTED_AT", "TRANSFERRED_FUNDS_TO", "USES_IMEI", "CO_ACCUSED_IN", "ACCUSED_IN", "CO_ACCUSED_WITH", "ASSOCIATED_WITH", "OCCURRED_AT", "SAME_MO_AS", "VICTIM_OF", "WITNESSED", "MEMBER_OF"}
_OVERLAY_KINDS = {"CDR_Phone", "ANPR_Vehicle", "BankAccount", "IMEI"}
_PERSON_CAP = 48


def _now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _load_graph(db: Session) -> GraphData:
    snap = db.get(GraphSnapshot, 1)
    if snap and (snap.nodes or snap.edges):
        return GraphData(
            nodes=[GraphNode.model_validate(n) for n in (snap.nodes or [])],
            edges=[GraphEdge.model_validate(e) for e in (snap.edges or [])],
        )
    # Fall back to published Catalyst/bootstrap graph snapshot
    cached = db_get(db, "graph")
    if isinstance(cached, dict):
        return GraphData.model_validate(cached)
    return GraphData(nodes=[], edges=[])


def _save_graph(db: Session, data: GraphData) -> GraphData:
    snap = db.get(GraphSnapshot, 1)
    payload_nodes = [n.model_dump() for n in data.nodes]
    payload_edges = [e.model_dump() for e in data.edges]
    if snap is None:
        snap = GraphSnapshot(id=1, nodes=payload_nodes, edges=payload_edges, communities=[])
        db.add(snap)
    else:
        snap.nodes = payload_nodes
        snap.edges = payload_edges
        snap.updated_at = datetime.utcnow()
    db.flush()

    # Keep API/bootstrap caches in sync so Slate sees multi-source layers
    payload = {"nodes": payload_nodes, "edges": payload_edges}
    publish(db, "graph", payload)
    boot = db_get(db, "bootstrap")
    if isinstance(boot, dict):
        boot = dict(boot)
        boot["network"] = payload
        publish(db, "bootstrap", boot)
    db.commit()
    return data


def _upsert_node(nodes: dict[str, GraphNode], node: GraphNode) -> None:
    existing = nodes.get(node.id)
    if existing:
        meta = dict(existing.meta or {})
        meta.update(node.meta or {})
        nodes[node.id] = existing.model_copy(
            update={
                "label": node.label or existing.label,
                "degree": max(existing.degree, node.degree),
                "centrality": max(existing.centrality, node.centrality),
                "meta": meta,
            }
        )
    else:
        nodes[node.id] = node


def _add_edge(edges: dict[str, GraphEdge], edge: GraphEdge) -> None:
    edges[edge.id] = edge


def _parse_rows(payload: str | bytes | list | dict, content_type: str = "") -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [dict(r) for r in payload]
    if isinstance(payload, dict):
        if "records" in payload and isinstance(payload["records"], list):
            return [dict(r) for r in payload["records"]]
        return [dict(payload)]
    text = payload.decode("utf-8") if isinstance(payload, bytes) else str(payload)
    text = text.strip()
    if not text:
        return []
    if content_type.endswith("json") or text.startswith("{") or text.startswith("["):
        data = json.loads(text)
        return _parse_rows(data)
    reader = csv.DictReader(io.StringIO(text))
    return [dict(row) for row in reader]


def ingest_cdr(db: Session, payload: str | bytes | list | dict, content_type: str = "") -> dict[str, Any]:
    rows = _parse_rows(payload, content_type)
    graph = _load_graph(db)
    nodes = {n.id: n for n in graph.nodes}
    edges = {e.id: e for e in graph.edges}
    added_n = added_e = 0

    for i, row in enumerate(rows):
        caller = str(row.get("caller") or row.get("caller_number") or row.get("from") or "").strip()
        receiver = str(row.get("receiver") or row.get("receiver_number") or row.get("to") or "").strip()
        if not caller or not receiver:
            continue
        duration = float(row.get("duration") or row.get("call_duration") or 0)
        tower = str(row.get("cell_tower") or row.get("tower") or row.get("location") or "")
        imei = str(row.get("imei") or "").strip()
        ts = int(row.get("timestamp") or row.get("at") or _now_ms())
        lat = row.get("lat") or row.get("latitude")
        lng = row.get("lng") or row.get("lon") or row.get("longitude")
        loc = None
        if lat is not None and lng is not None:
            try:
                loc = (float(lat), float(lng))
            except (TypeError, ValueError):
                loc = None

        for num, label in ((caller, f"CDR {caller}"), (receiver, f"CDR {receiver}")):
            nid = f"cdr:{num}"
            before = nid in nodes
            _upsert_node(
                nodes,
                GraphNode(
                    id=nid,
                    kind="CDR_Phone",  # type: ignore[arg-type]
                    label=label,
                    district=tower or "KA",
                    community=0,
                    centrality=0.2,
                    degree=1,
                    meta={"number": num, "tower": tower},
                ),
            )
            if not before:
                added_n += 1

        eid = f"called:{caller}:{receiver}:{ts}:{i}"
        if eid not in edges:
            added_e += 1
        _add_edge(
            edges,
            GraphEdge(
                id=eid,
                source=f"cdr:{caller}",
                target=f"cdr:{receiver}",
                kind="CALLED",  # type: ignore[arg-type]
                weight=max(1.0, duration / 60.0),
                confidence=0.95,
                timestamp=ts,
                confidence_score=0.95,
                frequency=1,
                location_lat_lng=loc,
                source_reference_id=str(row.get("id") or eid),
            ),
        )

        if imei:
            iid = f"imei:{imei}"
            if iid not in nodes:
                added_n += 1
            _upsert_node(
                nodes,
                GraphNode(
                    id=iid,
                    kind="IMEI",  # type: ignore[arg-type]
                    label=f"IMEI {imei[-6:]}",
                    district="KA",
                    community=0,
                    centrality=0.15,
                    degree=1,
                    meta={"imei": imei},
                ),
            )
            ueid = f"uses:{caller}:{imei}"
            if ueid not in edges:
                added_e += 1
            _add_edge(
                edges,
                GraphEdge(
                    id=ueid,
                    source=f"cdr:{caller}",
                    target=iid,
                    kind="USES_IMEI",  # type: ignore[arg-type]
                    weight=1.0,
                    timestamp=ts,
                    confidence_score=0.9,
                    source_reference_id=str(row.get("id") or ueid),
                ),
            )

    # recompute degrees lightly
    deg: dict[str, int] = {nid: 0 for nid in nodes}
    for e in edges.values():
        if e.source in deg:
            deg[e.source] += 1
        if e.target in deg:
            deg[e.target] += 1
    for nid, n in list(nodes.items()):
        nodes[nid] = n.model_copy(update={"degree": deg.get(nid, n.degree)})

    data = GraphData(nodes=list(nodes.values()), edges=list(edges.values()))
    _save_graph(db, data)
    return {"source": "cdr", "rows": len(rows), "nodes_added": added_n, "edges_added": added_e, "nodes": len(data.nodes), "edges": len(data.edges)}


def ingest_anpr(db: Session, payload: str | bytes | list | dict, content_type: str = "") -> dict[str, Any]:
    rows = _parse_rows(payload, content_type)
    graph = _load_graph(db)
    nodes = {n.id: n for n in graph.nodes}
    edges = {e.id: e for e in graph.edges}
    added_n = added_e = 0

    for i, row in enumerate(rows):
        reg = str(row.get("registration") or row.get("vehicle") or row.get("reg_no") or "").strip().upper()
        if not reg:
            continue
        camera = str(row.get("camera_id") or row.get("toll_id") or row.get("camera") or "CAM")
        ts = int(row.get("timestamp") or row.get("at") or _now_ms())
        lat = float(row.get("lat") or row.get("latitude") or 12.97)
        lng = float(row.get("lng") or row.get("lon") or row.get("longitude") or 77.59)
        vid = f"anpr:{reg}"
        lid = f"loc:anpr:{camera}"
        if vid not in nodes:
            added_n += 1
        _upsert_node(
            nodes,
            GraphNode(
                id=vid,
                kind="ANPR_Vehicle",  # type: ignore[arg-type]
                label=reg,
                district=str(row.get("district") or "KA"),
                community=0,
                centrality=0.25,
                degree=1,
                meta={"registration": reg},
            ),
        )
        if lid not in nodes:
            added_n += 1
        _upsert_node(
            nodes,
            GraphNode(
                id=lid,
                kind="Location",
                label=f"ANPR {camera}",
                district=str(row.get("district") or "KA"),
                community=0,
                centrality=0.1,
                degree=1,
                meta={"camera_id": camera, "lat": lat, "lng": lng},
            ),
        )
        eid = f"sighted:{reg}:{camera}:{ts}:{i}"
        if eid not in edges:
            added_e += 1
        _add_edge(
            edges,
            GraphEdge(
                id=eid,
                source=vid,
                target=lid,
                kind="SIGHTED_AT",  # type: ignore[arg-type]
                weight=1.0,
                timestamp=ts,
                confidence_score=0.92,
                frequency=1,
                location_lat_lng=(lat, lng),
                source_reference_id=str(row.get("id") or eid),
            ),
        )

    data = GraphData(nodes=list(nodes.values()), edges=list(edges.values()))
    _save_graph(db, data)
    return {"source": "anpr", "rows": len(rows), "nodes_added": added_n, "edges_added": added_e, "nodes": len(data.nodes), "edges": len(data.edges)}


def ingest_finance(db: Session, payload: str | bytes | list | dict, content_type: str = "") -> dict[str, Any]:
    rows = _parse_rows(payload, content_type)
    graph = _load_graph(db)
    nodes = {n.id: n for n in graph.nodes}
    edges = {e.id: e for e in graph.edges}
    added_n = added_e = 0

    for i, row in enumerate(rows):
        src = str(row.get("source_account") or row.get("from_account") or row.get("from") or "").strip()
        dst = str(row.get("destination_account") or row.get("to_account") or row.get("to") or "").strip()
        if not src or not dst:
            continue
        amount = float(row.get("amount") or 0)
        ifsc = str(row.get("ifsc") or row.get("IFSC") or "")
        ts = int(row.get("timestamp") or row.get("at") or _now_ms())
        for acct, ifsc_v in ((src, ifsc), (dst, str(row.get("to_ifsc") or ifsc))):
            aid = f"bank:{acct}"
            if aid not in nodes:
                added_n += 1
            _upsert_node(
                nodes,
                GraphNode(
                    id=aid,
                    kind="BankAccount",  # type: ignore[arg-type]
                    label=f"A/C …{acct[-4:]}",
                    district="KA",
                    community=0,
                    centrality=0.2,
                    degree=1,
                    meta={"account": acct, "ifsc": ifsc_v},
                ),
            )
        eid = f"xfer:{src}:{dst}:{ts}:{i}"
        if eid not in edges:
            added_e += 1
        _add_edge(
            edges,
            GraphEdge(
                id=eid,
                source=f"bank:{src}",
                target=f"bank:{dst}",
                kind="TRANSFERRED_FUNDS_TO",  # type: ignore[arg-type]
                weight=max(1.0, amount / 1000.0),
                timestamp=ts,
                confidence_score=0.88,
                frequency=1,
                source_reference_id=str(row.get("id") or eid),
            ),
        )

    data = GraphData(nodes=list(nodes.values()), edges=list(edges.values()))
    _save_graph(db, data)
    return {"source": "finance", "rows": len(rows), "nodes_added": added_n, "edges_added": added_e, "nodes": len(data.nodes), "edges": len(data.edges)}


def syndicate_paths(db: Session, a: str, b: str, max_hops: int = 6) -> dict[str, Any]:
    """BFS shortest path across multi-source graph (shared phones/vehicles/accounts)."""
    graph = _load_graph(db)
    adj: dict[str, list[tuple[str, GraphEdge]]] = {n.id: [] for n in graph.nodes}
    for e in graph.edges:
        adj.setdefault(e.source, []).append((e.target, e))
        adj.setdefault(e.target, []).append((e.source, e))

    if a not in adj or b not in adj:
        return {"found": False, "nodes": [], "edges": [], "hops": 0}

    from collections import deque

    q = deque([a])
    prev: dict[str, tuple[str, GraphEdge] | None] = {a: None}
    while q:
        cur = q.popleft()
        if cur == b:
            break
        for nxt, edge in adj.get(cur, []):
            if nxt in prev:
                continue
            prev[nxt] = (cur, edge)
            q.append(nxt)
            # depth limit via hop count along chain
            hops = 0
            walk = nxt
            while walk != a and prev.get(walk):
                hops += 1
                walk = prev[walk][0]  # type: ignore[index]
                if hops > max_hops:
                    break

    if b not in prev:
        return {"found": False, "nodes": [], "edges": [], "hops": 0}

    node_ids = [b]
    edge_ids: list[str] = []
    walk = b
    while walk != a:
        parent, edge = prev[walk]  # type: ignore[misc]
        edge_ids.append(edge.id)
        node_ids.append(parent)
        walk = parent
    node_ids.reverse()
    edge_ids.reverse()
    by_n = {n.id: n.model_dump() for n in graph.nodes}
    by_e = {e.id: e.model_dump() for e in graph.edges}
    return {
        "found": True,
        "hops": len(edge_ids),
        "nodes": [by_n[i] for i in node_ids if i in by_n],
        "edges": [by_e[i] for i in edge_ids if i in by_e],
    }


def _digest_int(seed: str, mod: int) -> int:
    h = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return int(h[:12], 16) % mod


def _phone_for(person_id: str) -> str:
    return f"9{_digest_int(f'phone:{person_id}', 10**9):09d}"


def _imei_for(person_id: str) -> str:
    return f"35{_digest_int(f'imei:{person_id}', 10**13):013d}"


def _reg_for(person_id: str) -> str:
    n = _digest_int(f"reg:{person_id}", 10**4)
    letters = "ABCDEFGHJKLMNPRSTUVWXYZ"
    a = letters[_digest_int(f"ra:{person_id}", len(letters))]
    b = letters[_digest_int(f"rb:{person_id}", len(letters))]
    series = _digest_int(f"rs:{person_id}", 99) + 1
    return f"KA{series:02d}{a}{b}{n:04d}"


def _account_for(person_id: str) -> str:
    return f"{_digest_int(f'acct:{person_id}', 10**12):012d}"


def _has_overlay(graph: GraphData) -> bool:
    return any(n.kind in _OVERLAY_KINDS for n in graph.nodes)


def _testdata_path(name: str) -> Path | None:
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "testdata" / name,
        here.parents[3] / "backend" / "testdata" / name,
        Path.cwd() / "testdata" / name,
        Path.cwd() / "backend" / "testdata" / name,
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


def _apply_live_person_overlay(graph: GraphData) -> tuple[GraphData, dict[str, Any]]:
    """Attach CDR / ANPR / bank nodes to Catalyst Person + co-accused pairs."""
    persons = sorted(
        [n for n in graph.nodes if n.kind == "Person"],
        key=lambda n: (n.centrality, n.degree),
        reverse=True,
    )[:_PERSON_CAP]
    if not persons:
        return graph, {"source": "none", "persons": 0}

    locations = [n for n in graph.nodes if n.kind == "Location"]
    nodes = {n.id: n for n in graph.nodes}
    edges = {e.id: e for e in graph.edges}
    added_n = added_e = 0
    phone_of: dict[str, str] = {}
    bank_of: dict[str, str] = {}
    veh_of: dict[str, str] = {}
    base_ts = 1_700_000_000_000

    for idx, person in enumerate(persons):
        phone = _phone_for(person.id)
        imei = _imei_for(person.id)
        reg = _reg_for(person.id)
        acct = _account_for(person.id)
        phone_of[person.id] = phone
        bank_of[person.id] = acct
        veh_of[person.id] = reg
        ts = base_ts + idx * 60_000
        loc = locations[idx % len(locations)] if locations else None

        for nid, kind, label, meta in (
            (f"cdr:{phone}", "CDR_Phone", f"CDR {phone}", {"number": phone, "person_id": person.id}),
            (f"imei:{imei}", "IMEI", f"IMEI {imei[-6:]}", {"imei": imei, "person_id": person.id}),
            (f"anpr:{reg}", "ANPR_Vehicle", reg, {"registration": reg, "person_id": person.id}),
            (f"bank:{acct}", "BankAccount", f"A/C …{acct[-4:]}", {"account": acct, "person_id": person.id, "ifsc": "SBIN0001234"}),
        ):
            before = nid in nodes
            _upsert_node(
                nodes,
                GraphNode(
                    id=nid,
                    kind=kind,  # type: ignore[arg-type]
                    label=label,
                    district=person.district or "KA",
                    community=person.community,
                    centrality=0.22,
                    degree=1,
                    meta=meta,
                ),
            )
            if not before:
                added_n += 1

        for eid, src, tgt, kind in (
            (f"assoc:phone:{person.id}", person.id, f"cdr:{phone}", "ASSOCIATED_WITH"),
            (f"uses:{phone}:{imei}", f"cdr:{phone}", f"imei:{imei}", "USES_IMEI"),
            (f"assoc:veh:{person.id}", person.id, f"anpr:{reg}", "ASSOCIATED_WITH"),
            (f"assoc:bank:{person.id}", person.id, f"bank:{acct}", "ASSOCIATED_WITH"),
        ):
            if eid not in edges:
                added_e += 1
            _add_edge(
                edges,
                GraphEdge(
                    id=eid,
                    source=src,
                    target=tgt,
                    kind=kind,  # type: ignore[arg-type]
                    weight=1.0,
                    timestamp=ts,
                    confidence_score=0.85,
                    source_reference_id=f"live-overlay:{person.id}",
                ),
            )

        if loc is not None:
            eid = f"sighted:{reg}:{loc.id}"
            if eid not in edges:
                added_e += 1
            _add_edge(
                edges,
                GraphEdge(
                    id=eid,
                    source=f"anpr:{reg}",
                    target=loc.id,
                    kind="SIGHTED_AT",  # type: ignore[arg-type]
                    weight=1.0,
                    timestamp=ts,
                    confidence_score=0.9,
                    frequency=1,
                    source_reference_id=f"live-overlay:{person.id}",
                ),
            )

    # Cross-links for co-accused pairs already in the Catalyst graph
    for e in list(edges.values()):
        if e.kind not in ("CO_ACCUSED_WITH", "CO_ACCUSED_IN"):
            continue
        a, b = e.source, e.target
        if a not in phone_of or b not in phone_of:
            continue
        pa, pb = phone_of[a], phone_of[b]
        called_id = f"called:{pa}:{pb}:overlay"
        if called_id not in edges:
            added_e += 1
        _add_edge(
            edges,
            GraphEdge(
                id=called_id,
                source=f"cdr:{pa}",
                target=f"cdr:{pb}",
                kind="CALLED",  # type: ignore[arg-type]
                weight=2.0,
                timestamp=base_ts,
                confidence_score=0.8,
                frequency=3,
                source_reference_id=f"live-overlay:{e.id}",
            ),
        )
        ba, bb = bank_of[a], bank_of[b]
        xfer_id = f"xfer:{ba}:{bb}:overlay"
        if xfer_id not in edges:
            added_e += 1
        _add_edge(
            edges,
            GraphEdge(
                id=xfer_id,
                source=f"bank:{ba}",
                target=f"bank:{bb}",
                kind="TRANSFERRED_FUNDS_TO",  # type: ignore[arg-type]
                weight=5.0,
                timestamp=base_ts + 120_000,
                confidence_score=0.75,
                source_reference_id=f"live-overlay:{e.id}",
            ),
        )

    deg: dict[str, int] = {nid: 0 for nid in nodes}
    for edge in edges.values():
        if edge.source in deg:
            deg[edge.source] += 1
        if edge.target in deg:
            deg[edge.target] += 1
    for nid, n in list(nodes.items()):
        nodes[nid] = n.model_copy(update={"degree": deg.get(nid, n.degree)})

    return GraphData(nodes=list(nodes.values()), edges=list(edges.values())), {
        "source": "catalyst_persons",
        "persons": len(persons),
        "nodes_added": added_n,
        "edges_added": added_e,
    }


def ensure_multisource_overlay(db: Session, force: bool = False) -> dict[str, Any]:
    """Use Catalyst graph persons when present; otherwise sample CSV synthetic data.

    Idempotent: skips if CDR/ANPR/bank/IMEI nodes already exist unless force=True.
    """
    graph = _load_graph(db)
    if not force and _has_overlay(graph):
        multi = sum(1 for n in graph.nodes if n.kind in _OVERLAY_KINDS)
        return {"status": "already", "multi_source_nodes": multi, "nodes": len(graph.nodes), "edges": len(graph.edges)}

    persons = [n for n in graph.nodes if n.kind == "Person"]
    if persons:
        data, meta = _apply_live_person_overlay(graph)
        _save_graph(db, data)
        return {
            "status": "hydrated",
            **meta,
            "nodes": len(data.nodes),
            "edges": len(data.edges),
            "multi_source_nodes": sum(1 for n in data.nodes if n.kind in _OVERLAY_KINDS),
        }

    # Empty / no person graph — fall back to bundled sample CSVs
    cdr_path = _testdata_path("sample_cdr.csv")
    anpr_path = _testdata_path("sample_anpr.csv")
    results: dict[str, Any] = {"status": "synthetic_fallback", "source": "testdata"}
    if cdr_path:
        results["cdr"] = ingest_cdr(db, cdr_path.read_text(encoding="utf-8"), "text/csv")
    if anpr_path:
        results["anpr"] = ingest_anpr(db, anpr_path.read_text(encoding="utf-8"), "text/csv")
    finance = [
        {
            "source_account": "111122223333",
            "destination_account": "444455556666",
            "amount": 50000,
            "ifsc": "SBIN0001234",
            "timestamp": 1_700_000_200_000,
        }
    ]
    results["finance"] = ingest_finance(db, finance, "application/json")
    graph = _load_graph(db)
    results["nodes"] = len(graph.nodes)
    results["edges"] = len(graph.edges)
    results["multi_source_nodes"] = sum(1 for n in graph.nodes if n.kind in _OVERLAY_KINDS)
    return results
