"""Schema catalogue for the natural-language query endpoint.

This module is the boundary that keeps YUKTI inside CIAP §10 and the DPDP Act.
The language model that translates a question into a query is shown **this
catalogue and nothing else** — table names, column names, types, and a short
description each. No row is ever sent to it, and neither is any column holding
FIR narrative text or a protected attribute.

Two rules follow from that and are enforced here rather than in the prompt,
because a prompt is a request and a validator is a guarantee:

* ``BLOCKED_COLUMNS`` never appear in the catalogue **and** are rejected if a
  generated query references them anyway. ``case_master.narrative`` is the FIR
  free text §10 protects; it is empty in the current dataset and will not be
  once CCTNS data lands.
* ``BLOCKED_TABLES`` are the protected-attribute lookups named in
  DATA-AND-MODELS.md §2.0 — caste, religion, occupation. They must never become
  model features, and they are not answerable here either: a question that
  slices crime by caste is exactly the query this platform should not make easy.
"""

from __future__ import annotations

from dataclasses import dataclass, field

SOURCE_LOCAL = "local"
SOURCE_CATALYST = "catalyst"


@dataclass(frozen=True)
class Column:
    name: str
    type: str
    description: str
    #: True when the column is nullable. Joining on one of these with an inner
    #: join silently drops rows, which reads to the user as "no such record"
    #: rather than "that field is blank" — so the catalogue has to say so.
    optional: bool = False


@dataclass(frozen=True)
class Table:
    name: str
    description: str
    columns: tuple[Column, ...]
    joins: tuple[str, ...] = field(default=())
    #: Column that identifies a row, used to make answers traceable.
    primary_key: str = "id"

    @property
    def column_names(self) -> set[str]:
        return {c.name for c in self.columns}


# Protected attributes per DATA-AND-MODELS.md §2.0. Not exposed, not queryable.
BLOCKED_TABLES: frozenset[str] = frozenset(
    {
        "caste_master",
        "castemaster",
        "religion_master",
        "religionmaster",
        "occupation_master",
        "occupationmaster",
        "audit_log",
    }
)

# Columns carrying FIR free text or direct identifiers. Never shown, never selected.
BLOCKED_COLUMNS: frozenset[str] = frozenset(
    {
        "narrative",
        "brieffacts",
        "brief_facts",
        "caste_id",
        "religion_id",
        "occupation_id",
        "casteid",
        "religionid",
        "occupationid",
    }
)


LOCAL_TABLES: tuple[Table, ...] = (
    Table(
        name="district",
        description="The 40 Karnataka districts, with Census 2011 denominators.",
        columns=(
            Column("id", "integer", "Primary key."),
            Column("name", "text", "District name, e.g. 'Bengaluru City'."),
            Column("population", "integer", "Census 2011 population — the per-100k denominator."),
            Column("urban_pct", "real", "Percent of the district population classed as urban."),
            Column("literacy_pct", "real", "Literacy rate, percent."),
            Column("stations", "integer", "Count of police stations in the district."),
        ),
    ),
    Table(
        name="crime_head",
        description="Crime category lookup (the eight major heads).",
        columns=(
            Column("id", "integer", "Primary key."),
            Column("name", "text", "Category name, e.g. 'Property Crime', 'Vehicle Theft'."),
        ),
    ),
    Table(
        name="unit",
        description="Police stations and other units.",
        columns=(
            Column("id", "text", "Primary key."),
            Column("name", "text", "Unit name, e.g. 'Kamakshipalya PS'."),
            Column("district_id", "integer", "References district.id."),
        ),
        joins=("unit.district_id = district.id",),
    ),
    Table(
        name="employee",
        description="Police personnel. Names are present; prefer aggregates over listing them.",
        columns=(
            Column("id", "integer", "Primary key."),
            Column("name", "text", "Officer name."),
            Column("rank", "text", "Rank, e.g. 'ASI', 'PSI'."),
            Column("unit_id", "text", "References unit.id.", optional=True),
        ),
        joins=("employee.unit_id = unit.id",),
    ),
    Table(
        name="case_master",
        description=(
            "One row per FIR. The central fact table — most questions aggregate over it. "
            "registered_at is epoch milliseconds, so use date arithmetic on it rather than "
            "string comparison."
        ),
        columns=(
            Column("id", "text", "Primary key. Return this as evidence."),
            Column("crime_no", "text", "Crime number as recorded in CCTNS."),
            Column("crime_head_id", "integer", "References crime_head.id."),
            Column("district_id", "integer", "References district.id."),
            Column("unit_id", "text", "References unit.id — the station of registration."),
            Column("registered_at", "bigint", "Registration timestamp, epoch milliseconds."),
            Column("status", "text", "'Under Investigation', 'Chargesheeted', 'Disposed', 'Untraced'."),
            Column("lon", "real", "Longitude. May be a station centroid — see the geocoding caveat."),
            Column("lat", "real", "Latitude. May be a station centroid."),
            Column("mo_entry", "text", "Modus operandi: method of entry."),
            Column("mo_target", "text", "Modus operandi: target."),
            Column("mo_timing", "text", "Modus operandi: time window."),
            Column("mo_tools", "text", "Modus operandi: tools used."),
            Column(
                "officer_id",
                "integer",
                "References employee.id — the investigating officer. Often unassigned.",
                optional=True,
            ),
            Column("anomaly", "boolean", "True when the anomaly detector flagged this case."),
            Column("anomaly_score", "real", "Isolation Forest score; higher is more unusual."),
        ),
        joins=(
            "case_master.district_id = district.id",
            "case_master.crime_head_id = crime_head.id",
            "case_master.unit_id = unit.id",
            "case_master.officer_id = employee.id",
        ),
    ),
    Table(
        name="person",
        description="People linked to cases. Personally identifying — aggregate, do not enumerate.",
        columns=(
            Column("id", "text", "Primary key."),
            Column("age", "integer", "Age in years."),
            Column("district_id", "integer", "References district.id."),
            Column("priors", "integer", "Count of prior linked cases."),
            Column("mo_cluster", "integer", "MO similarity cluster id from the TF-IDF/DBSCAN model."),
        ),
        joins=("person.district_id = district.id",),
    ),
    Table(
        name="accused",
        description="Join table linking a person to a case as accused.",
        columns=(
            Column("person_id", "text", "References person.id."),
            Column("case_id", "text", "References case_master.id."),
        ),
        joins=("accused.person_id = person.id", "accused.case_id = case_master.id"),
    ),
    Table(
        name="victim",
        description="Join table linking a person to a case as victim.",
        columns=(
            Column("person_id", "text", "References person.id."),
            Column("case_id", "text", "References case_master.id."),
        ),
        joins=("victim.person_id = person.id", "victim.case_id = case_master.id"),
    ),
    Table(
        name="chargesheet_details",
        description="Chargesheet filing per case — the basis for clearance rates.",
        columns=(
            Column("case_id", "text", "References case_master.id."),
            Column("filed", "boolean", "Whether a chargesheet was filed."),
            Column(
                "filed_at",
                "bigint",
                "Filing timestamp, epoch milliseconds. Null when not filed.",
                optional=True,
            ),
        ),
        joins=("chargesheet_details.case_id = case_master.id",),
        primary_key="case_id",
    ),
)


CATALYST_TABLES: tuple[Table, ...] = (
    Table(
        name="District",
        description="Karnataka districts.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id. Return this as evidence."),
            Column("DistrictName", "varchar", "District name."),
            Column("StateID", "foreign key", "References State.ROWID."),
            Column("Active", "boolean", "Whether the district is active."),
        ),
        joins=("District.StateID = State.ROWID",),
        primary_key="ROWID",
    ),
    Table(
        name="State",
        description="States.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("StateID", "int", "Legacy state id."),
            Column("StateName", "varchar", "State name."),
        ),
        primary_key="ROWID",
    ),
    Table(
        name="Unit",
        description="Police stations and units.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("UnitName", "varchar", "Unit name, e.g. 'Kamakshipalya PS'."),
            Column("TypeID", "foreign key", "References UnitType.ROWID."),
            Column("DistrictID", "foreign key", "References District.ROWID."),
            Column("StateID", "foreign key", "References State.ROWID."),
        ),
        joins=("Unit.DistrictID = District.ROWID", "Unit.TypeID = UnitType.ROWID"),
        primary_key="ROWID",
    ),
    Table(
        name="UnitType",
        description="Unit type lookup, e.g. 'Police Station'.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("UnitTypeName", "varchar", "Type name."),
        ),
        primary_key="ROWID",
    ),
    Table(
        name="Employee",
        description="Police personnel. Names present — aggregate rather than enumerate.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("KGID", "varchar", "Government employee id."),
            Column("FirstName", "varchar", "Officer name."),
            Column("UnitID", "foreign key", "References Unit.ROWID."),
            Column("DistrictID", "foreign key", "References District.ROWID."),
        ),
        joins=("Employee.UnitID = Unit.ROWID", "Employee.DistrictID = District.ROWID"),
        primary_key="ROWID",
    ),
    Table(
        name="CaseMaster",
        description="One row per FIR. The central fact table.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id. Return this as evidence."),
            Column("CrimeNo", "varchar", "Crime number."),
            Column("CaseNo", "varchar", "Case number."),
            Column("CrimeRegisteredDate", "date", "Registration date."),
            Column("IncidentFromDate", "datetime", "Incident window start."),
            Column("IncidentToDate", "datetime", "Incident window end."),
            Column("PoliceStationID", "foreign key", "References Unit.ROWID."),
            Column("PolicePersonID", "foreign key", "References Employee.ROWID."),
            Column("CrimeMajorHeadID", "foreign key", "References CrimeHead.ROWID."),
            Column("CrimeMinorHeadID", "foreign key", "References CrimeSubHead.ROWID."),
            Column("CaseStatusID", "foreign key", "References CaseStatusMaster.ROWID."),
            Column("GravityOffenceID", "foreign key", "References GravityOffence.ROWID."),
            Column("latitude", "double", "Latitude; may be a station centroid."),
            Column("longitude", "double", "Longitude; may be a station centroid."),
        ),
        joins=(
            "CaseMaster.PoliceStationID = Unit.ROWID",
            "CaseMaster.CrimeMajorHeadID = CrimeHead.ROWID",
            "CaseMaster.CaseStatusID = CaseStatusMaster.ROWID",
        ),
        primary_key="ROWID",
    ),
    Table(
        name="CrimeHead",
        description="Major crime head lookup.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("CrimeGroupName", "varchar", "Crime group name, e.g. 'CYBER CRIME'."),
        ),
        primary_key="ROWID",
    ),
    Table(
        name="CrimeSubHead",
        description="Minor crime head lookup.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("CrimeHeadName", "varchar", "Sub-head name."),
            Column("CrimeHeadID", "foreign key", "References CrimeHead.ROWID."),
        ),
        joins=("CrimeSubHead.CrimeHeadID = CrimeHead.ROWID",),
        primary_key="ROWID",
    ),
    Table(
        name="CaseStatusMaster",
        description="Case status lookup, e.g. 'Pending Trial', 'Traced'.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("CaseStatusName", "varchar", "Status name."),
        ),
        primary_key="ROWID",
    ),
    Table(
        name="GravityOffence",
        description="Offence gravity lookup, e.g. 'Heinous'.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("LookupValue", "varchar", "Gravity label."),
        ),
        primary_key="ROWID",
    ),
    Table(
        name="Act",
        description="Acts of law.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("ActCode", "varchar", "Act code, e.g. 'ACT0038'."),
            Column("ShortName", "varchar", "Short name, e.g. 'IPC 1860'."),
            Column("ActDescription", "text", "Full description."),
        ),
        primary_key="ROWID",
    ),
    Table(
        name="Section",
        description="Sections within an act.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("ActID", "foreign key", "References Act.ROWID."),
            Column("SectionCode", "varchar", "Section code, e.g. '302'."),
        ),
        joins=("Section.ActID = Act.ROWID",),
        primary_key="ROWID",
    ),
    Table(
        name="ActSectionAssociation",
        description="Which acts and sections a case was booked under.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("CaseMasterID", "foreign key", "References CaseMaster.ROWID."),
            Column("ActID", "foreign key", "References Act.ROWID."),
            Column("SectionID", "foreign key", "References Section.ROWID."),
        ),
        joins=(
            "ActSectionAssociation.CaseMasterID = CaseMaster.ROWID",
            "ActSectionAssociation.ActID = Act.ROWID",
            "ActSectionAssociation.SectionID = Section.ROWID",
        ),
        primary_key="ROWID",
    ),
    Table(
        name="Victim",
        description="Victims linked to cases. Personally identifying — aggregate.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("CaseMasterID", "foreign key", "References CaseMaster.ROWID."),
            Column("AgeYear", "int", "Age in years."),
            Column("GenderID", "int", "Gender code: 1 male, 2 female, 3 unknown."),
        ),
        joins=("Victim.CaseMasterID = CaseMaster.ROWID",),
        primary_key="ROWID",
    ),
    Table(
        name="Accused",
        description="Accused persons linked to cases. Personally identifying — aggregate.",
        columns=(
            Column("ROWID", "bigint", "Catalyst row id."),
            Column("CaseMasterID", "foreign key", "References CaseMaster.ROWID."),
            Column("PersonID", "varchar", "Person reference."),
        ),
        joins=("Accused.CaseMasterID = CaseMaster.ROWID",),
        primary_key="ROWID",
    ),
)


_CATALOGUES: dict[str, tuple[Table, ...]] = {
    SOURCE_LOCAL: LOCAL_TABLES,
    SOURCE_CATALYST: CATALYST_TABLES,
}


def tables_for(source: str) -> tuple[Table, ...]:
    try:
        return _CATALOGUES[source]
    except KeyError:
        raise ValueError(f"Unknown data source {source!r}") from None


def allowed_tables(source: str) -> set[str]:
    return {t.name.lower() for t in tables_for(source)}


def allowed_columns(source: str) -> set[str]:
    names: set[str] = set()
    for table in tables_for(source):
        names |= {c.name.lower() for c in table.columns}
    return names


def primary_key_for(source: str, table_name: str) -> str | None:
    """The identifier column for a table, so answers can be traced to records."""
    for table in tables_for(source):
        if table.name.lower() == table_name.lower():
            return table.primary_key
    return None


def optional_columns(source: str) -> set[str]:
    """Nullable columns as ``table.column``.

    Qualified deliberately: ``employee.unit_id`` is nullable and
    ``case_master.unit_id`` is not, so matching on the bare name would warn
    about the wrong query.
    """
    names: set[str] = set()
    for table in tables_for(source):
        names |= {f"{table.name.lower()}.{c.name.lower()}" for c in table.columns if c.optional}
    return names


def render_catalogue(source: str) -> str:
    """Render the catalogue as the prompt text. This is the only schema the model sees."""
    lines: list[str] = []
    for table in tables_for(source):
        lines.append(f"TABLE {table.name}  -- {table.description}")
        for col in table.columns:
            marks = []
            if col.name == table.primary_key:
                marks.append("PRIMARY KEY")
            if col.optional:
                marks.append("OPTIONAL, may be NULL - use LEFT JOIN")
            suffix = f"  [{'; '.join(marks)}]" if marks else ""
            lines.append(f"    {col.name} ({col.type}){suffix}  -- {col.description}")
        if table.joins:
            lines.append("  joins: " + "; ".join(table.joins))
        lines.append("")
    return "\n".join(lines).rstrip()
