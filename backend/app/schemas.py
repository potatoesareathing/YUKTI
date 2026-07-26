from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

CrimeCategory = Literal[
    "Body Offence",
    "Property Crime",
    "Vehicle Theft",
    "Cyber & Financial Fraud",
    "Crime Against Women",
    "Narcotics (NDPS)",
    "Public Order",
    "Economic Offence",
]

CRIME_CATEGORIES: list[CrimeCategory] = [
    "Body Offence",
    "Property Crime",
    "Vehicle Theft",
    "Cyber & Financial Fraud",
    "Crime Against Women",
    "Narcotics (NDPS)",
    "Public Order",
    "Economic Offence",
]

CaseStatus = Literal["Under Investigation", "Chargesheeted", "Disposed", "Untraced"]
NodeKind = Literal["Person", "Incident", "Location", "Vehicle", "Organisation"]
EdgeKind = Literal[
    "ACCUSED_IN",
    "VICTIM_OF",
    "WITNESSED",
    "OCCURRED_AT",
    "ASSOCIATED_WITH",
    "SAME_MO_AS",
    "MEMBER_OF",
    "CO_ACCUSED_WITH",
]
RiskBand = Literal["low", "moderate", "high", "critical"]
EvidenceKind = Literal["incident", "person", "series", "feature"]
ModelStatus = Literal["Serving", "Retraining", "Validation", "Registered"]


class ModusOperandi(BaseModel):
    entry: str
    target: str
    timing: str
    tools: str


class Incident(BaseModel):
    id: str
    docket: str
    category: CrimeCategory
    district: str
    station: str
    lonLat: tuple[float, float]
    world: tuple[float, float]
    at: int
    status: CaseStatus
    mo: ModusOperandi
    narrative: str
    officer: str
    anomaly: bool
    anomalyScore: float


class DistrictMetrics(BaseModel):
    name: str
    code: str = ""
    population: int
    urbanPct: float
    literacyPct: float
    stations: int
    incidents: int
    byCategory: dict[str, int]
    rate: float
    risk: float
    riskNorm: float
    trend: float
    redZone: bool
    clearancePct: float


class GraphNode(BaseModel):
    id: str
    kind: NodeKind
    label: str
    district: str
    community: int
    centrality: float
    degree: int
    meta: Optional[dict[str, Any]] = None


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    kind: EdgeKind
    weight: float
    predicted: Optional[bool] = None
    confidence: Optional[float] = None


class GraphData(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class TrendPoint(BaseModel):
    at: int
    value: float
    trend: float
    seasonal: float
    residual: float


class TrendSeries(BaseModel):
    key: str
    label: str
    points: list[TrendPoint]
    controlLimit: float
    breaches: list[int]


class Evidence(BaseModel):
    kind: EvidenceKind
    ref: str
    label: str
    detail: str


class RiskScore(BaseModel):
    district: str
    score: float
    band: RiskBand
    drivers: list[dict[str, Any]]
    evidence: list[Evidence] = Field(min_length=1)
    horizonDays: int

    @field_validator("evidence")
    @classmethod
    def evidence_non_empty(cls, v: list[Evidence]) -> list[Evidence]:
        if not v:
            raise ValueError("evidence must be non-empty")
        return v


class AnomalyFlag(BaseModel):
    id: str
    incidentId: str
    district: str
    score: float
    reason: str
    evidence: list[Evidence] = Field(min_length=1)
    at: int

    @field_validator("evidence")
    @classmethod
    def evidence_non_empty(cls, v: list[Evidence]) -> list[Evidence]:
        if not v:
            raise ValueError("evidence must be non-empty")
        return v


class ModelCard(BaseModel):
    id: str
    name: str
    purpose: str
    family: str
    io: str
    status: ModelStatus
    version: str
    metricLabel: str
    metric: float
    drift: float
    lastTrained: int
    module: str


class StationMetrics(BaseModel):
    id: str
    name: str
    district: str
    world: tuple[float, float]
    sampled: int
    estimated: int
    byCategory: dict[str, int]
    topCategory: CrimeCategory
    anomalies: int
    share: float
    lastAt: int


class StateTotals(BaseModel):
    incidents: int
    byCategory: dict[str, int]
    redZones: int
    stations: int
    avgClearance: float


class Community(BaseModel):
    id: int
    label: str
    size: int
    district: str
    topNode: GraphNode


class OffenderIncident(BaseModel):
    id: str
    docket: str
    district: str
    at: int
    entry: str
    target: str
    window: str


class OffenderMatch(BaseModel):
    person: GraphNode
    district: str
    shared: int


class OffenderProfile(BaseModel):
    person: GraphNode
    incidents: list[OffenderIncident]
    districts: list[str]
    signature: str
    spanDays: int
    priors: int
    matches: list[OffenderMatch]


class DistrictFlow(BaseModel):
    id: str
    a: str
    b: str
    ties: int
    predicted: int
    communities: list[int]


class DistrictHub(BaseModel):
    district: str
    entities: int
    people: int
    incidents: int
    internalTies: int
    communities: list[int]
    topNode: GraphNode


class FlowAggregate(BaseModel):
    flows: list[DistrictFlow]
    hubs: list[DistrictHub]
    droppedPairs: int
    droppedTies: int
    totalCrossTies: int
    minTies: int


class AlertItem(BaseModel):
    series: TrendSeries
    at: int
    index: int


class AuditBody(BaseModel):
    action: str = "evidence_open"
    resource_refs: list[str] = Field(default_factory=list)
    detail: str = ""


class BootstrapPayload(BaseModel):
    districts: list[DistrictMetrics]
    stateTotals: StateTotals
    incidents: list[Incident]
    stations: list[StationMetrics]
    network: GraphData
    communities: list[Community]
    models: list[ModelCard]
    offenders: list[OffenderProfile]
    flows: FlowAggregate
    alerts: list[AlertItem]
    riskScores: list[RiskScore]
    anomalies: list[AnomalyFlag]
    categorySeries: dict[str, TrendSeries]
    districtSeries: dict[str, TrendSeries]
    now: int
    periodDays: int
