from __future__ import annotations

from sqlalchemy.orm import Session

from app.models_orm import AnomalyRow, ModelCardRow, RiskScoreRow
from app.schemas import AnomalyFlag, ModelCard, RiskScore
from app.services.snapshot import load


def get_risk_scores(db: Session) -> list[RiskScore]:
    cached = load(db, "risk_scores")
    if cached is not None:
        return [RiskScore.model_validate(r) for r in cached if r.get("evidence")]

    rows = db.query(RiskScoreRow).all()
    out: list[RiskScore] = []
    for r in rows:
        score = RiskScore.model_validate(r.payload)
        if not score.evidence:
            continue
        out.append(score)
    out.sort(key=lambda s: s.score, reverse=True)
    return out


def get_anomalies(db: Session, limit: int = 24) -> list[AnomalyFlag]:
    cached = load(db, "anomalies")
    if cached is not None:
        return [AnomalyFlag.model_validate(a) for a in cached if a.get("evidence")][:limit]

    rows = db.query(AnomalyRow).order_by(AnomalyRow.score.desc()).limit(limit * 2).all()
    out: list[AnomalyFlag] = []
    for r in rows:
        flag = AnomalyFlag.model_validate(r.payload)
        if not flag.evidence:
            continue
        out.append(flag)
        if len(out) >= limit:
            break
    return out


def get_models(db: Session) -> list[ModelCard]:
    cached = load(db, "models")
    if cached is not None:
        return [ModelCard.model_validate(m) for m in cached]
    rows = db.query(ModelCardRow).all()
    return [ModelCard.model_validate(r.payload) for r in rows]
