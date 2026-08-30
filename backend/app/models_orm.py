from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.db import Base

# Use JSON that works on both Postgres and SQLite fallback
JsonType = JSON().with_variant(JSONB(), "postgresql")


class District(Base):
    __tablename__ = "district"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    code: Mapped[str] = mapped_column(String(16), default="")
    population: Mapped[int] = mapped_column(Integer)
    urban_pct: Mapped[float] = mapped_column(Float)
    literacy_pct: Mapped[float] = mapped_column(Float)
    stations: Mapped[int] = mapped_column(Integer)
    lon: Mapped[float] = mapped_column(Float, default=0.0)
    lat: Mapped[float] = mapped_column(Float, default=0.0)


class CrimeHead(Base):
    __tablename__ = "crime_head"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)


class Unit(Base):
    __tablename__ = "unit"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    district_id: Mapped[int] = mapped_column(ForeignKey("district.id"), index=True)
    lon: Mapped[float] = mapped_column(Float, default=0.0)
    lat: Mapped[float] = mapped_column(Float, default=0.0)


class Employee(Base):
    __tablename__ = "employee"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    rank: Mapped[str] = mapped_column(String(64), default="ASI")
    unit_id: Mapped[str | None] = mapped_column(ForeignKey("unit.id"), nullable=True)


class CaseMaster(Base):
    __tablename__ = "case_master"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    crime_no: Mapped[str] = mapped_column(String(64), index=True)
    crime_head_id: Mapped[int] = mapped_column(ForeignKey("crime_head.id"), index=True)
    district_id: Mapped[int] = mapped_column(ForeignKey("district.id"), index=True)
    unit_id: Mapped[str] = mapped_column(ForeignKey("unit.id"), index=True)
    registered_at: Mapped[int] = mapped_column(BigInteger, index=True)
    status: Mapped[str] = mapped_column(String(64))
    lon: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    world_x: Mapped[float] = mapped_column(Float)
    world_z: Mapped[float] = mapped_column(Float)
    mo_entry: Mapped[str] = mapped_column(String(128))
    mo_target: Mapped[str] = mapped_column(String(128))
    mo_timing: Mapped[str] = mapped_column(String(64))
    mo_tools: Mapped[str] = mapped_column(String(128))
    narrative: Mapped[str] = mapped_column(Text)
    officer_id: Mapped[int | None] = mapped_column(ForeignKey("employee.id"), nullable=True)
    anomaly: Mapped[bool] = mapped_column(Boolean, default=False)
    anomaly_score: Mapped[float] = mapped_column(Float, default=0.0)
    in_sample: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    # CCTNS live-sync extensions (nullable for legacy Catalyst rows)
    cctns_fir_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    police_station_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    fir_timestamp: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    crime_group_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    crime_head_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    raw_kannada_narrative: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_synced_realtime: Mapped[bool] = mapped_column(Boolean, default=False)
    parsed_mo_metadata: Mapped[dict | None] = mapped_column(JsonType, nullable=True)


class Person(Base):
    __tablename__ = "person"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    age: Mapped[int] = mapped_column(Integer)
    district_id: Mapped[int] = mapped_column(ForeignKey("district.id"))
    priors: Mapped[int] = mapped_column(Integer, default=0)
    mo_cluster: Mapped[int] = mapped_column(Integer, default=0)


class Accused(Base):
    __tablename__ = "accused"
    __table_args__ = (UniqueConstraint("person_id", "case_id", name="uq_accused"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("case_master.id"), index=True)


class Victim(Base):
    __tablename__ = "victim"
    __table_args__ = (UniqueConstraint("person_id", "case_id", name="uq_victim"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("case_master.id"), index=True)


class ComplainantDetails(Base):
    __tablename__ = "complainant_details"
    __table_args__ = (UniqueConstraint("person_id", "case_id", name="uq_complainant"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("case_master.id"), index=True)


class ChargesheetDetails(Base):
    __tablename__ = "chargesheet_details"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("case_master.id"), unique=True)
    filed: Mapped[bool] = mapped_column(Boolean, default=False)
    filed_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class DistrictAggregate(Base):
    """Precomputed DistrictMetrics row (Phase 1 cache table)."""

    __tablename__ = "district_aggregate"

    district_id: Mapped[int] = mapped_column(ForeignKey("district.id"), primary_key=True)
    payload: Mapped[dict] = mapped_column(JsonType)


class WeeklySeries(Base):
    __tablename__ = "weekly_series"
    __table_args__ = (UniqueConstraint("district_id", "crime_head_id", "week_index", name="uq_week"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    district_id: Mapped[int | None] = mapped_column(ForeignKey("district.id"), nullable=True, index=True)
    crime_head_id: Mapped[int] = mapped_column(ForeignKey("crime_head.id"), index=True)
    week_index: Mapped[int] = mapped_column(Integer)
    at_ms: Mapped[int] = mapped_column(BigInteger)
    value: Mapped[float] = mapped_column(Float)
    trend: Mapped[float] = mapped_column(Float, default=0.0)
    seasonal: Mapped[float] = mapped_column(Float, default=0.0)
    residual: Mapped[float] = mapped_column(Float, default=0.0)


class SeriesMeta(Base):
    __tablename__ = "series_meta"
    __table_args__ = (UniqueConstraint("district_id", "crime_head_id", name="uq_series_meta"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    district_id: Mapped[int | None] = mapped_column(ForeignKey("district.id"), nullable=True)
    crime_head_id: Mapped[int] = mapped_column(ForeignKey("crime_head.id"))
    control_limit: Mapped[float] = mapped_column(Float)
    breaches: Mapped[list] = mapped_column(JsonType, default=list)
    label: Mapped[str] = mapped_column(String(256))
    key: Mapped[str] = mapped_column(String(128))


class GraphSnapshot(Base):
    __tablename__ = "graph_snapshot"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    nodes: Mapped[list] = mapped_column(JsonType)
    edges: Mapped[list] = mapped_column(JsonType)
    communities: Mapped[list] = mapped_column(JsonType, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class RiskScoreRow(Base):
    __tablename__ = "risk_score"

    district_id: Mapped[int] = mapped_column(ForeignKey("district.id"), primary_key=True)
    payload: Mapped[dict] = mapped_column(JsonType)


class AnomalyRow(Base):
    __tablename__ = "anomaly_flag"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[dict] = mapped_column(JsonType)
    score: Mapped[float] = mapped_column(Float, index=True)


class ModelCardRow(Base):
    __tablename__ = "model_card"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[dict] = mapped_column(JsonType)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    user_id: Mapped[str] = mapped_column(String(128), default="anonymous")
    action: Mapped[str] = mapped_column(String(64))
    path: Mapped[str] = mapped_column(String(512))
    resource_refs: Mapped[list] = mapped_column(JsonType, default=list)
    detail: Mapped[str] = mapped_column(Text, default="")


class ApiSnapshot(Base):
    """Precomputed API payloads published by the nightly job. Request path is read-only."""

    __tablename__ = "api_snapshot"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[dict | list] = mapped_column(JsonType)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class CaseSensitiveNotes(Base):
    """Column-level restricted fields — masked below INSPECTOR."""

    __tablename__ = "case_sensitive_notes"

    case_id: Mapped[str] = mapped_column(ForeignKey("case_master.id"), primary_key=True)
    informant_details: Mapped[str] = mapped_column(Text, default="")
    wiretap_logs: Mapped[str] = mapped_column(Text, default="")
    active_surveillance_notes: Mapped[str] = mapped_column(Text, default="")


class CourtCase(Base):
    __tablename__ = "court_case"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    case_number: Mapped[str] = mapped_column(String(64))
    court_name: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(64), default="Pending")
    bail_status: Mapped[str] = mapped_column(String(64), default="None")
    ecourts_cnr: Mapped[str] = mapped_column(String(64), default="")


class Warrant(Base):
    __tablename__ = "warrant"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), index=True)
    warrant_type: Mapped[str] = mapped_column(String(32), default="NBW")
    issued_at: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(32), default="Active")
    court_name: Mapped[str] = mapped_column(String(128), default="")


class RowdySheet(Base):
    __tablename__ = "rowdy_sheet"

    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"), primary_key=True)
    category: Mapped[str] = mapped_column(String(64), default="A")
    opened_at: Mapped[int] = mapped_column(BigInteger, default=0)
    notes: Mapped[str] = mapped_column(Text, default="")


class DossierExport(Base):
    """Immutable audit of KSP dossier PDF exports."""

    __tablename__ = "dossier_exports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(128), index=True)
    suspect_id: Mapped[str] = mapped_column(String(32), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class CctnsFir(Base):
    """CCTNS-ingested FIR mirror — primary live-sync store."""

    __tablename__ = "cctns_fir"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # cctns_fir_id
    case_id: Mapped[str | None] = mapped_column(ForeignKey("case_master.id"), nullable=True, index=True)
    police_station_code: Mapped[str] = mapped_column(String(64), default="", index=True)
    district_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    fir_timestamp: Mapped[int] = mapped_column(BigInteger, default=0, index=True)
    crime_group_name: Mapped[str] = mapped_column(String(128), default="")
    crime_head_name: Mapped[str] = mapped_column(String(128), default="")
    lat: Mapped[float] = mapped_column(Float, default=0.0)
    lng: Mapped[float] = mapped_column(Float, default=0.0)
    raw_kannada_narrative: Mapped[str] = mapped_column(Text, default="")
    is_synced_realtime: Mapped[bool] = mapped_column(Boolean, default=True)
    parsed_mo_metadata: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="webhook")  # webhook | poller | catalyst
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class MoPatternAlert(Base):
    """Cross-jurisdiction emerging MO pattern when similarity > threshold."""

    __tablename__ = "mo_pattern_alert"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    fir_a_id: Mapped[str] = mapped_column(String(64), index=True)
    fir_b_id: Mapped[str] = mapped_column(String(64), index=True)
    district_a: Mapped[str] = mapped_column(String(128), default="")
    district_b: Mapped[str] = mapped_column(String(128), default="")
    score: Mapped[float] = mapped_column(Float, default=0.0)
    shared_tags: Mapped[list] = mapped_column(JsonType, default=list)
    payload: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class PersonIntelAlertState(Base):
    """Officer disposition for Person Intelligence potential-match alerts."""

    __tablename__ = "person_intel_alert_state"

    alert_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), default="open", index=True)  # open|investigating|dismissed
    updated_by: Mapped[str] = mapped_column(String(128), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
