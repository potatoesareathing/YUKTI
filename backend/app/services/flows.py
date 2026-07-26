from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from app.schemas import DistrictFlow, DistrictHub, FlowAggregate, GraphNode
from app.services.graph import get_graph
from app.services.snapshot import load


def get_district_flows(db: Session, min_ties: int = 2) -> FlowAggregate:
    if min_ties == 2:
        cached = load(db, "flows")
        if cached is not None:
            return FlowAggregate.model_validate(cached)

    data = get_graph(db)
    by_id = {n.id: n for n in data.nodes}

    hubs: dict[str, DistrictHub] = {}
    hub_communities: dict[str, set[int]] = defaultdict(set)
    for n in data.nodes:
        hub = hubs.get(n.district)
        if not hub:
            hub = DistrictHub(
                district=n.district,
                entities=0,
                people=0,
                incidents=0,
                internalTies=0,
                communities=[],
                topNode=n,
            )
            hubs[n.district] = hub
        hub.entities += 1
        if n.kind == "Person":
            hub.people += 1
        if n.kind == "Incident":
            hub.incidents += 1
        hub_communities[n.district].add(n.community)
        if n.centrality > hub.topNode.centrality:
            hub.topNode = n

    pair_ties: dict[tuple[str, str], list] = defaultdict(list)
    for e in data.edges:
        a = by_id.get(e.source)
        b = by_id.get(e.target)
        if not a or not b:
            continue
        if a.district == b.district:
            hubs[a.district].internalTies += 1
            continue
        key = tuple(sorted((a.district, b.district)))
        pair_ties[key].append(e)

    flows: list[DistrictFlow] = []
    dropped_pairs = dropped_ties = total_cross = 0
    for (da, db_), edges in pair_ties.items():
        total_cross += len(edges)
        predicted = sum(1 for e in edges if e.predicted)
        communities = sorted({by_id[e.source].community for e in edges} | {by_id[e.target].community for e in edges})
        if len(edges) < min_ties:
            dropped_pairs += 1
            dropped_ties += len(edges)
            continue
        flows.append(
            DistrictFlow(
                id=f"{da}|{db_}",
                a=da,
                b=db_,
                ties=len(edges),
                predicted=predicted,
                communities=communities,
            )
        )

    for dist, hub in hubs.items():
        hub.communities = sorted(hub_communities[dist])

    flows.sort(key=lambda f: -f.ties)
    return FlowAggregate(
        flows=flows,
        hubs=list(hubs.values()),
        droppedPairs=dropped_pairs,
        droppedTies=dropped_ties,
        totalCrossTies=total_cross,
        minTies=min_ties,
    )
