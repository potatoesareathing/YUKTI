"""Police RBAC: roles, user context, scoping, and column masking."""

from __future__ import annotations

from enum import Enum
from typing import Any, Iterable, Mapping, MutableMapping, Sequence

from pydantic import BaseModel, Field


class PoliceRole(str, Enum):
    CONSTABLE = "CONSTABLE"
    PSI = "PSI"
    INSPECTOR = "INSPECTOR"
    DSP = "DSP"
    SP_CP = "SP_CP"
    SCRB_ADMIN = "SCRB_ADMIN"


POLICE_ROLE = [r.value for r in PoliceRole]

ROLE_CLEARANCE: dict[PoliceRole, int] = {
    PoliceRole.CONSTABLE: 1,
    PoliceRole.PSI: 2,
    PoliceRole.INSPECTOR: 3,
    PoliceRole.DSP: 4,
    PoliceRole.SP_CP: 5,
    PoliceRole.SCRB_ADMIN: 5,
}

RESTRICTED_MARKER = "[RESTRICTED - INSPECTOR OR ABOVE]"
SENSITIVE_FIELDS = ("informant_details", "wiretap_logs", "active_surveillance_notes")


class UserContext(BaseModel):
    """JWT / session principal with jurisdictional scope."""

    user_id: str
    username: str
    rank: PoliceRole = PoliceRole.SCRB_ADMIN
    clearance_level: int = Field(default=5, ge=1, le=5)
    station_id: str | None = None
    district_id: str | None = None  # district code or numeric id as string
    roles: list[str] = Field(default_factory=list)

    @property
    def can_see_sensitive(self) -> bool:
        return ROLE_CLEARANCE[self.rank] >= ROLE_CLEARANCE[PoliceRole.INSPECTOR]

    @property
    def statewide(self) -> bool:
        return self.rank in (PoliceRole.SP_CP, PoliceRole.SCRB_ADMIN) or self.clearance_level >= 5


def parse_role(raw: str | None) -> PoliceRole:
    if not raw:
        return PoliceRole.SCRB_ADMIN
    key = raw.strip().upper().replace("-", "_").replace(" ", "_")
    aliases = {
        "SP": PoliceRole.SP_CP,
        "CP": PoliceRole.SP_CP,
        "ADMIN": PoliceRole.SCRB_ADMIN,
        "SCRB": PoliceRole.SCRB_ADMIN,
    }
    if key in aliases:
        return aliases[key]
    try:
        return PoliceRole(key)
    except ValueError:
        return PoliceRole.CONSTABLE


def mask_sensitive_fields(payload: Any, user: UserContext) -> Any:
    """Recursively redact sensitive keys for ranks below INSPECTOR."""
    if user.can_see_sensitive:
        return payload
    if isinstance(payload, Mapping):
        out: dict[str, Any] = {}
        for k, v in payload.items():
            if k in SENSITIVE_FIELDS:
                out[k] = RESTRICTED_MARKER
            else:
                out[k] = mask_sensitive_fields(v, user)
        return out
    if isinstance(payload, list):
        return [mask_sensitive_fields(item, user) for item in payload]
    return payload


def scope_allows_station(user: UserContext, station_id: str | None) -> bool:
    if user.statewide:
        return True
    if user.rank in (PoliceRole.CONSTABLE, PoliceRole.PSI):
        if not user.station_id:
            return False
        return station_id == user.station_id
    # INSPECTOR / DSP: station within district handled by district check on FIR
    return True


def scope_allows_district(user: UserContext, district_id: str | None, district_name: str | None = None) -> bool:
    if user.statewide:
        return True
    if user.rank in (PoliceRole.INSPECTOR, PoliceRole.DSP):
        if not user.district_id:
            return False
        return district_id == user.district_id or (
            district_name is not None and district_name == user.district_id
        )
    if user.rank in (PoliceRole.CONSTABLE, PoliceRole.PSI):
        # Station-scoped users: district alone is not enough for unmasked FIR
        return False
    return False


def filter_fir_records(
    records: Sequence[Mapping[str, Any]],
    user: UserContext,
    *,
    station_key: str = "station_id",
    district_key: str = "district_id",
    district_name_key: str = "district",
) -> list[dict[str, Any]]:
    """Apply station/district scoping then column masking."""
    out: list[dict[str, Any]] = []
    for raw in records:
        rec = dict(raw)
        station_id = str(rec.get(station_key) or rec.get("station") or "") or None
        district_id = str(rec.get(district_key) or "") or None
        district_name = str(rec.get(district_name_key) or "") or None

        if user.rank in (PoliceRole.CONSTABLE, PoliceRole.PSI):
            if not scope_allows_station(user, station_id):
                continue
        elif user.rank in (PoliceRole.INSPECTOR, PoliceRole.DSP):
            if not scope_allows_district(user, district_id, district_name):
                continue

        out.append(mask_sensitive_fields(rec, user))
    return out


def assert_dossier_export_allowed(
    user: UserContext,
    *,
    suspect_district_ids: Iterable[str],
    suspect_station_ids: Iterable[str],
) -> None:
    """Raise PermissionError if user cannot export this suspect's dossier."""
    districts = {str(d) for d in suspect_district_ids if d}
    stations = {str(s) for s in suspect_station_ids if s}

    if user.statewide:
        return
    if user.rank in (PoliceRole.INSPECTOR, PoliceRole.DSP):
        if user.district_id and user.district_id in districts:
            return
        if user.district_id and any(d == user.district_id for d in districts):
            return
        raise PermissionError("Dossier export limited to assigned district")
    if user.rank in (PoliceRole.CONSTABLE, PoliceRole.PSI):
        if user.station_id and user.station_id in stations:
            return
        raise PermissionError("Dossier export limited to assigned station; cannot export out-of-jurisdiction")
    raise PermissionError("Insufficient clearance for dossier export")
