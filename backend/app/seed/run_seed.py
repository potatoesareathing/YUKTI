"""Seed KSP-shaped tables with synthetic FIR data matching the frontend contract."""

from __future__ import annotations

import math
import sys

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal, init_db
from app.models_orm import (
    Accused,
    CaseMaster,
    ChargesheetDetails,
    ComplainantDetails,
    CrimeHead,
    District,
    DistrictAggregate,
    Employee,
    Person,
    Unit,
    Victim,
)
from app.schemas import CRIME_CATEGORIES
from app.seed.census_data import CENSUS_2011, NDPS_WEIGHTED
from app.seed.geo import jitter, to_world_xz
from app.seed.rng import gaussian, seeded

MO_ENTRIES = ["Forced door", "Window climb", "Duplicate key", "Social engineering", "Vehicle break"]
MO_TARGETS = ["Residence — locked", "Residence — open", "Commercial", "ATM / kiosk", "Vehicle parked"]
MO_TIMINGS = ["0000–0400", "0400–0800", "0800–1200", "1800–2200", "2200–0000"]
MO_TOOLS = ["Crowbar", "None", "Smartphone", "Lock pick", "Vehicle"]
STATUSES = ["Under Investigation", "Chargesheeted", "Disposed", "Untraced"]
OFFICER_NAMES = ["ASI Rao", "PSI Nair", "HC Patil", "SI Khan", "ASI Devi", "PSI Gowda"]


def category_weights(row: dict) -> dict[str, float]:
    u = row["urbanPct"] / 100
    lit = row["literacyPct"] / 100
    rural = 1 - u
    return {
        "Body Offence": 0.9 + rural * 0.7,
        "Property Crime": 0.7 + u * 2.1,
        "Vehicle Theft": 0.35 + u * 2.4,
        "Cyber & Financial Fraud": 0.15 + u * 2.6 * lit,
        "Crime Against Women": 0.8 + u * 0.5,
        "Narcotics (NDPS)": (0.3 + u * 0.6) * (2.3 if row["name"] in NDPS_WEIGHTED else 1),
        "Public Order": 0.6 + rural * 0.9,
        "Economic Offence": 0.2 + u * 1.4 * lit,
    }


def build_district_metrics(row: dict, settings) -> dict:
    r = seeded(f"district:{row['name']}")
    u = row["urbanPct"] / 100
    base_rate = 150 + u * 330 + gaussian(r, 0, 38)
    rate = max(95, base_rate)
    total = max(1, round((rate * row["population"]) / 100_000 / (365 / settings.period_days)))
    weights = category_weights(row)
    wsum = sum(weights[c] for c in CRIME_CATEGORIES)
    by_category: dict[str, int] = {}
    assigned = 0
    for i, c in enumerate(CRIME_CATEGORIES):
        if i == len(CRIME_CATEGORIES) - 1:
            by_category[c] = max(0, total - assigned)
        else:
            n = round((weights[c] / wsum) * total * (0.9 + r() * 0.2))
            by_category[c] = n
            assigned += n
    trend = gaussian(r, 0.012, 0.085)
    rate_term = min(1, (rate - 95) / 520) * 0.42
    urban_term = u * 0.24
    trend_term = min(1, max(0, (trend + 0.12) / 0.34)) * 0.26
    lit_term = (1 - row["literacyPct"] / 100) * 0.18
    risk = min(0.97, max(0.05, rate_term + urban_term + trend_term + lit_term))
    clearance = round(38 + (row["literacyPct"] - 50) * 0.42 + gaussian(r, 0, 5))
    return {
        "name": row["name"],
        "code": "",
        "population": row["population"],
        "urbanPct": row["urbanPct"],
        "literacyPct": row["literacyPct"],
        "stations": row["stations"],
        "incidents": total,
        "byCategory": by_category,
        "rate": round(rate),
        "risk": risk,
        "riskNorm": 0.0,
        "trend": trend,
        "redZone": False,
        "clearancePct": clearance,
    }


def normalise(rows: list[dict]) -> list[dict]:
    order = sorted(rows, key=lambda d: d["risk"])
    rank = {d["name"]: i / (len(order) - 1) for i, d in enumerate(order)}
    out = []
    for d in rows:
        r = rank[d["name"]]
        out.append(
            {
                **d,
                "riskNorm": math.pow(r, 1.45),
                "redZone": r > 0.74 and d["trend"] > 0.075,
            }
        )
    return out


def seed(db: Session, force: bool = False) -> None:
    settings = get_settings()
    if db.query(District).count() > 0 and not force:
        print("Seed skipped — districts already present")
        return

    if force:
        for table in (
            Accused,
            Victim,
            ComplainantDetails,
            ChargesheetDetails,
            CaseMaster,
            Person,
            Employee,
            Unit,
            DistrictAggregate,
            CrimeHead,
            District,
        ):
            db.query(table).delete()
        db.commit()

    heads = []
    for i, name in enumerate(CRIME_CATEGORIES, start=1):
        h = CrimeHead(id=i, name=name)
        db.add(h)
        heads.append(h)
    db.flush()
    head_by_name = {h.name: h.id for h in heads}

    metrics_raw = [build_district_metrics(row, settings) for row in CENSUS_2011]
    metrics = normalise(metrics_raw)
    metrics_by_name = {m["name"]: m for m in metrics}

    districts: list[District] = []
    for i, row in enumerate(CENSUS_2011, start=1):
        d = District(
            id=i,
            name=row["name"],
            code="",
            population=row["population"],
            urban_pct=row["urbanPct"],
            literacy_pct=row["literacyPct"],
            stations=row["stations"],
            lon=row["lon"],
            lat=row["lat"],
        )
        db.add(d)
        districts.append(d)
        db.add(DistrictAggregate(district_id=i, payload=metrics_by_name[row["name"]]))
    db.flush()

    # Units + employees
    units: list[Unit] = []
    employees: list[Employee] = []
    emp_id = 1
    for d in districts:
        n_stations = max(3, min(12, d.stations // 4 or 3))
        r = seeded(f"units:{d.name}")
        for s in range(n_stations):
            uid = f"{d.id}-{s+1}"
            lon, lat = jitter(d.lon, d.lat, r, 0.12)
            u = Unit(id=uid, name=f"{d.name.split()[0]} Station {s+1}", district_id=d.id, lon=lon, lat=lat)
            db.add(u)
            units.append(u)
            for _ in range(2):
                e = Employee(id=emp_id, name=OFFICER_NAMES[emp_id % len(OFFICER_NAMES)], rank="ASI", unit_id=uid)
                db.add(e)
                employees.append(e)
                emp_id += 1
    db.flush()

    units_by_district: dict[int, list[Unit]] = {}
    for u in units:
        units_by_district.setdefault(u.district_id, []).append(u)

    # Sample incidents (~4–6k) proportional to district volume
    sample_budget = settings.incident_sample_cap
    total_incidents = sum(m["incidents"] for m in metrics)
    case_seq = 1
    person_seq = 1

    for d in districts:
        m = metrics_by_name[d.name]
        share = m["incidents"] / max(1, total_incidents)
        n_sample = max(40, int(sample_budget * share))
        r = seeded(f"incidents:{d.name}")
        dist_units = units_by_district[d.id]
        cats = list(CRIME_CATEGORIES)
        weights = [max(1, m["byCategory"][c]) for c in cats]
        wsum = sum(weights)

        for _ in range(n_sample):
            # weighted category pick
            pick = r() * wsum
            acc = 0.0
            cat = cats[0]
            for c, w in zip(cats, weights):
                acc += w
                if pick <= acc:
                    cat = c
                    break
            unit = dist_units[int(r() * len(dist_units)) % len(dist_units)]
            lon, lat = jitter(unit.lon, unit.lat, r, 0.05)
            wx, wz = to_world_xz(lon, lat)
            day_offset = int(r() * settings.period_days)
            at = settings.now_ms - day_offset * 86_400_000
            status = STATUSES[int(r() * len(STATUSES)) % len(STATUSES)]
            anomaly_score = max(0.0, min(1.0, gaussian(r, 0.35, 0.22)))
            anomaly = anomaly_score > 0.72
            cid = f"INC-{case_seq}"
            docket = f"FIR-{d.id}-{case_seq:05d}"
            officer = employees[int(r() * len(employees)) % len(employees)]
            mo_entry = MO_ENTRIES[int(r() * len(MO_ENTRIES)) % len(MO_ENTRIES)]
            mo_target = MO_TARGETS[int(r() * len(MO_TARGETS)) % len(MO_TARGETS)]
            mo_timing = MO_TIMINGS[int(r() * len(MO_TIMINGS)) % len(MO_TIMINGS)]
            mo_tools = MO_TOOLS[int(r() * len(MO_TOOLS)) % len(MO_TOOLS)]
            case = CaseMaster(
                id=cid,
                crime_no=docket,
                crime_head_id=head_by_name[cat],
                district_id=d.id,
                unit_id=unit.id,
                registered_at=at,
                status=status,
                lon=lon,
                lat=lat,
                world_x=wx,
                world_z=wz,
                mo_entry=mo_entry,
                mo_target=mo_target,
                mo_timing=mo_timing,
                mo_tools=mo_tools,
                narrative=f"{cat} reported at {unit.name}. MO: {mo_entry} / {mo_target}.",
                officer_id=officer.id,
                anomaly=anomaly,
                anomaly_score=anomaly_score,
                in_sample=True,
            )
            db.add(case)

            # 1–3 accused, optional victim/complainant
            n_acc = 1 + (1 if r() > 0.55 else 0) + (1 if r() > 0.85 else 0)
            accused_ids = []
            for _a in range(n_acc):
                pid = f"P-{person_seq}"
                person_seq += 1
                p = Person(
                    id=pid,
                    name=f"Person {person_seq}",
                    age=18 + int(r() * 45),
                    district_id=d.id,
                    priors=int(r() * 4),
                    mo_cluster=int(r() * 8),
                )
                db.add(p)
                db.add(Accused(person_id=pid, case_id=cid))
                accused_ids.append(pid)

            if r() > 0.3:
                pid = f"P-{person_seq}"
                person_seq += 1
                db.add(
                    Person(
                        id=pid,
                        name=f"Victim {person_seq}",
                        age=18 + int(r() * 50),
                        district_id=d.id,
                        priors=0,
                        mo_cluster=0,
                    )
                )
                db.add(Victim(person_id=pid, case_id=cid))

            if r() > 0.4:
                pid = f"P-{person_seq}"
                person_seq += 1
                db.add(
                    Person(
                        id=pid,
                        name=f"Complainant {person_seq}",
                        age=20 + int(r() * 40),
                        district_id=d.id,
                        priors=0,
                        mo_cluster=0,
                    )
                )
                db.add(ComplainantDetails(person_id=pid, case_id=cid))

            filed = status in ("Chargesheeted", "Disposed")
            db.add(
                ChargesheetDetails(
                    case_id=cid,
                    filed=filed,
                    filed_at=at + 14 * 86_400_000 if filed else None,
                )
            )
            case_seq += 1

        if case_seq % 500 == 0:
            db.flush()
            print(f"  … seeded {case_seq} cases")

    db.commit()
    print(f"Seed complete: {len(districts)} districts, {case_seq - 1} sample cases")


def main() -> None:
    force = "--force" in sys.argv
    init_db()
    db = SessionLocal()
    try:
        seed(db, force=force)
    finally:
        db.close()


if __name__ == "__main__":
    main()
