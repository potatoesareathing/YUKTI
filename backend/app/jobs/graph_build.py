"""Build entity graph, run Louvain/PageRank (networkx), sync Neo4j, store snapshot."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime

import networkx as nx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models_orm import Accused, CaseMaster, CrimeHead, District, GraphSnapshot, Person, Unit
from app.seed.rng import seeded

try:
    from neo4j import GraphDatabase
except ImportError:
    GraphDatabase = None  # type: ignore


def _sync_neo4j(nodes: list[dict], edges: list[dict]) -> None:
    settings = get_settings()
    if GraphDatabase is None:
        return
    try:
        driver = GraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password))
        with driver.session() as session:
            session.run("MATCH (n) DETACH DELETE n")
            for n in nodes:
                session.run(
                    """
                    CREATE (x:Entity {id:$id, kind:$kind, label:$label, district:$district,
                                      community:$community, centrality:$centrality, degree:$degree})
                    """,
                    **{k: n[k] for k in ("id", "kind", "label", "district", "community", "centrality", "degree")},
                )
            for e in edges:
                session.run(
                    """
                    MATCH (a:Entity {id:$source}), (b:Entity {id:$target})
                    CREATE (a)-[r:REL {id:$id, kind:$kind, weight:$weight, predicted:$predicted, confidence:$confidence}]->(b)
                    """,
                    id=e["id"],
                    source=e["source"],
                    target=e["target"],
                    kind=e["kind"],
                    weight=e["weight"],
                    predicted=bool(e.get("predicted")),
                    confidence=e.get("confidence"),
                )
        driver.close()
        print("Neo4j sync complete")
    except Exception as exc:
        print(f"Neo4j sync skipped: {exc}")


def build_graph(db: Session) -> None:
    districts = {d.id: d.name for d in db.query(District).all()}
    units = {u.id: u for u in db.query(Unit).all()}
    heads = {h.id: h.name for h in db.query(CrimeHead).all()}
    cases = db.query(CaseMaster).filter(CaseMaster.in_sample.is_(True)).limit(2500).all()
    people = {p.id: p for p in db.query(Person).all()}
    accused_rows = db.query(Accused).all()
    accused_by_case: dict[str, list[str]] = defaultdict(list)
    for a in accused_rows:
        accused_by_case[a.case_id].append(a.person_id)

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    edge_id = 0

    def add_node(nid: str, kind: str, label: str, district: str, meta: dict | None = None):
        if nid not in nodes:
            nodes[nid] = {
                "id": nid,
                "kind": kind,
                "label": label,
                "district": district,
                "community": 0,
                "centrality": 0.0,
                "degree": 0,
                "meta": meta or {},
            }

    def add_edge(src: str, tgt: str, kind: str, weight: float = 1.0, predicted: bool = False, confidence: float | None = None):
        nonlocal edge_id
        edge_id += 1
        e = {"id": f"E-{edge_id}", "source": src, "target": tgt, "kind": kind, "weight": weight}
        if predicted:
            e["predicted"] = True
            e["confidence"] = confidence if confidence is not None else 0.5
        edges.append(e)

    # Locations from units
    for u in units.values():
        add_node(f"LOC-{u.id}", "Location", u.name, districts[u.district_id])

    for c in cases:
        dist = districts[c.district_id]
        add_node(
            c.id,
            "Incident",
            c.crime_no,
            dist,
            {
                "At": c.registered_at,
                "Entry": c.mo_entry,
                "Target": c.mo_target,
                "Window": c.mo_timing,
                "Category": heads.get(c.crime_head_id, ""),
            },
        )
        loc_id = f"LOC-{c.unit_id}"
        add_edge(c.id, loc_id, "OCCURRED_AT")
        accs = accused_by_case.get(c.id, [])
        for pid in accs:
            p = people.get(pid)
            if not p:
                continue
            add_node(pid, "Person", p.name, districts[p.district_id], {"priors": p.priors})
            add_edge(pid, c.id, "ACCUSED_IN")
        # CO_ACCUSED_WITH between pairs
        for i in range(len(accs)):
            for j in range(i + 1, len(accs)):
                add_edge(accs[i], accs[j], "CO_ACCUSED_WITH", weight=1.0)

    # SAME_MO_AS between similar incidents (sample)
    by_mo: dict[str, list[str]] = defaultdict(list)
    for c in cases:
        key = f"{c.mo_entry}|{c.mo_target}"
        by_mo[key].append(c.id)
    for ids in by_mo.values():
        for i in range(min(len(ids) - 1, 3)):
            add_edge(ids[i], ids[i + 1], "SAME_MO_AS", weight=0.8)

    # Build undirected multigraph for algorithms — degree = distinct neighbours
    G = nx.Graph()
    for n in nodes:
        G.add_node(n)
    for e in edges:
        if e["source"] in G and e["target"] in G:
            G.add_edge(e["source"], e["target"])

    # Louvain
    try:
        from networkx.algorithms.community import louvain_communities

        communities = louvain_communities(G, seed=42)
    except Exception:
        communities = list(nx.connected_components(G))

    comm_of = {}
    for i, comm in enumerate(communities):
        for nid in comm:
            comm_of[nid] = i

    # PageRank normalised 0..1
    if G.number_of_nodes():
        pr = nx.pagerank(G, alpha=0.85)
        mx = max(pr.values()) or 1.0
        for nid, score in pr.items():
            nodes[nid]["centrality"] = score / mx
            nodes[nid]["community"] = comm_of.get(nid, 0)
            nodes[nid]["degree"] = G.degree(nid)  # distinct neighbours in simple Graph

    # Predicted links (GraphSAGE stand-in): same-district persons without a recorded tie
    rng = seeded("linkpred")
    persons = [n for n in nodes.values() if n["kind"] == "Person"]
    by_district: dict[str, list[dict]] = defaultdict(list)
    for p in persons:
        by_district[p["district"]].append(p)
    predicted = 0
    for dist, group in by_district.items():
        if predicted >= 60:
            break
        for i, a in enumerate(group[:80]):
            if predicted >= 60:
                break
            for b in group[i + 1 : i + 6]:
                if G.has_edge(a["id"], b["id"]):
                    continue
                if rng() < 0.55:
                    continue
                na = set(G.neighbors(a["id"]))
                nb = set(G.neighbors(b["id"]))
                common = len(na & nb)
                conf = min(0.95, 0.42 + common * 0.1 + rng() * 0.2)
                add_edge(a["id"], b["id"], "ASSOCIATED_WITH", weight=conf, predicted=True, confidence=conf)
                predicted += 1

    # Community summary
    community_payload = []
    for i, comm in enumerate(communities):
        members = [nodes[n] for n in comm if n in nodes]
        if not members:
            continue
        top = max(members, key=lambda x: x["centrality"])
        district_counts: dict[str, int] = defaultdict(int)
        for m in members:
            district_counts[m["district"]] += 1
        home = max(district_counts, key=district_counts.get)  # type: ignore[arg-type]
        community_payload.append(
            {
                "id": i,
                "label": f"Community {i}",
                "size": len(members),
                "district": home,
                "topNode": top,
            }
        )

    node_list = list(nodes.values())
    snap = db.query(GraphSnapshot).filter(GraphSnapshot.id == 1).first()
    if snap:
        snap.nodes = node_list
        snap.edges = edges
        snap.communities = community_payload
        snap.updated_at = datetime.utcnow()
    else:
        db.add(
            GraphSnapshot(
                id=1,
                nodes=node_list,
                edges=edges,
                communities=community_payload,
                updated_at=datetime.utcnow(),
            )
        )
    db.commit()
    _sync_neo4j(node_list, edges)
    print(f"Graph: {len(node_list)} nodes, {len(edges)} edges, {predicted} predicted")
