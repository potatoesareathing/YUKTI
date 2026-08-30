"""OIDC JWT validation with AUTH_BYPASS and police UserContext."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from fastapi import Depends, HTTPException, Request
from jose import JWTError, jwt

from app.config import get_settings
from app.rbac import PoliceRole, UserContext, parse_role, ROLE_CLEARANCE

_jwks_cache: dict | None = None


def _get_jwks() -> dict | None:
    global _jwks_cache
    if _jwks_cache is not None:
        return _jwks_cache
    settings = get_settings()
    try:
        url = f"{settings.keycloak_issuer}/protocol/openid-connect/certs"
        r = httpx.get(url, timeout=2.0)
        r.raise_for_status()
        _jwks_cache = r.json()
        return _jwks_cache
    except Exception:
        return None


def _context_from_claims(payload: dict[str, Any], fallback_id: str = "user") -> UserContext:
    username = str(payload.get("preferred_username") or payload.get("sub") or fallback_id)
    user_id = str(payload.get("sub") or username)
    realm_roles = []
    ra = payload.get("realm_access")
    if isinstance(ra, dict):
        realm_roles = list(ra.get("roles") or [])
    rank_raw = (
        payload.get("rank")
        or payload.get("police_rank")
        or (realm_roles[0] if realm_roles else None)
        or "SCRB_ADMIN"
    )
    rank = parse_role(str(rank_raw))
    clearance = int(payload.get("clearance_level") or ROLE_CLEARANCE[rank])
    clearance = max(1, min(5, clearance))
    return UserContext(
        user_id=user_id,
        username=username,
        rank=rank,
        clearance_level=clearance,
        station_id=(str(payload["station_id"]) if payload.get("station_id") else None),
        district_id=(str(payload["district_id"]) if payload.get("district_id") else None),
        roles=[str(r) for r in realm_roles],
    )


def _context_from_headers(request: Request, base: UserContext) -> UserContext:
    """Local/testing overrides via X-Police-* headers (also used when AUTH_BYPASS)."""
    role = request.headers.get("X-Police-Role")
    station = request.headers.get("X-Station-Id")
    district = request.headers.get("X-District-Id")
    clearance = request.headers.get("X-Clearance-Level")
    data = base.model_dump()
    if role:
        data["rank"] = parse_role(role)
        data["clearance_level"] = ROLE_CLEARANCE[data["rank"]]
    if station is not None:
        data["station_id"] = station or None
    if district is not None:
        data["district_id"] = district or None
    if clearance:
        try:
            data["clearance_level"] = max(1, min(5, int(clearance)))
        except ValueError:
            pass
    return UserContext(**data)


def current_user(request: Request) -> UserContext:
    settings = get_settings()
    auth = request.headers.get("Authorization", "")

    if settings.auth_bypass and not auth.startswith("Bearer "):
        ctx = UserContext(
            user_id="dev-bypass",
            username="dev-bypass",
            rank=PoliceRole.SCRB_ADMIN,
            clearance_level=5,
            station_id=None,
            district_id=None,
            roles=["SCRB_ADMIN"],
        )
        return _context_from_headers(request, ctx)

    if not auth.startswith("Bearer "):
        if settings.auth_bypass:
            ctx = UserContext(
                user_id="anonymous",
                username="anonymous",
                rank=PoliceRole.CONSTABLE,
                clearance_level=1,
            )
            return _context_from_headers(request, ctx)
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = auth[7:]
    try:
        jwks = _get_jwks()
        payload: dict[str, Any] | None = None
        if jwks:
            header = jwt.get_unverified_header(token)
            key = next((k for k in jwks.get("keys", []) if k.get("kid") == header.get("kid")), None)
            if key:
                payload = jwt.decode(
                    token,
                    key,
                    algorithms=[header.get("alg", "RS256")],
                    audience=settings.keycloak_audience,
                    issuer=settings.keycloak_issuer,
                    options={"verify_aud": False},
                )
        if payload is None:
            if settings.auth_bypass:
                payload = jwt.get_unverified_claims(token)
            else:
                raise HTTPException(status_code=401, detail="Invalid token")
        ctx = _context_from_claims(payload)
        return _context_from_headers(request, ctx)
    except JWTError as exc:
        if settings.auth_bypass:
            ctx = UserContext(
                user_id="dev-bypass",
                username="dev-bypass",
                rank=PoliceRole.SCRB_ADMIN,
                clearance_level=5,
            )
            return _context_from_headers(request, ctx)
        raise HTTPException(status_code=401, detail=str(exc)) from exc


UserDep = Annotated[UserContext, Depends(current_user)]
