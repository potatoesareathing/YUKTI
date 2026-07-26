from __future__ import annotations

from sqlalchemy.orm import Session

from app.models_orm import GraphSnapshot
from app.schemas import Community, GraphData, GraphNode
from app.services.snapshot import load


def get_graph(db: Session, root_id: str | None = None, depth: int = 2) -> GraphData:
    cached = load(db, "graph")
    if cached is not None:
        data = GraphData.model_validate(cached)
    else:
        snap = db.query(GraphSnapshot).filter(GraphSnapshot.id == 1).first()
        if not snap:
            return GraphData(nodes=[], edges=[])
        data = GraphData(nodes=snap.nodes, edges=snap.edges)
    if not root_id:
        return data
    return _ego(data, root_id, depth)


def _ego(data: GraphData, root_id: str, depth: int) -> GraphData:
    by_id = {n.id: n for n in data.nodes}
    if root_id not in by_id:
        return GraphData(nodes=[], edges=[])
    keep = {root_id}
    frontier = {root_id}
    for _ in range(depth):
        nxt: set[str] = set()
        for e in data.edges:
            if e.source in frontier:
                keep.add(e.target)
                nxt.add(e.target)
            if e.target in frontier:
                keep.add(e.source)
                nxt.add(e.source)
        frontier = nxt
    nodes = [n for n in data.nodes if n.id in keep]
    edges = [e for e in data.edges if e.source in keep and e.target in keep]
    return GraphData(nodes=nodes, edges=edges)


def get_communities(db: Session) -> list[Community]:
    cached = load(db, "communities")
    if cached is not None:
        return [Community.model_validate(c) for c in cached]
    snap = db.query(GraphSnapshot).filter(GraphSnapshot.id == 1).first()
    if not snap:
        return []
    out: list[Community] = []
    for c in snap.communities or []:
        out.append(
            Community(
                id=c["id"],
                label=c["label"],
                size=c["size"],
                district=c["district"],
                topNode=GraphNode.model_validate(c["topNode"]),
            )
        )
    return out
