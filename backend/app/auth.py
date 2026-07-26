"""OIDC JWT validation with AUTH_BYPASS for local UI."""

from __future__ import annotations

from typing import Annotated, Optional

import httpx
from fastapi import Depends, HTTPException, Request
from jose import JWTError, jwt

from app.config import get_settings

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


def current_user(request: Request) -> str:
    settings = get_settings()
    auth = request.headers.get("Authorization", "")
    if settings.auth_bypass and not auth.startswith("Bearer "):
        return "dev-bypass"
    if not auth.startswith("Bearer "):
        if settings.auth_bypass:
            return "anonymous"
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth[7:]
    try:
        # Prefer JWKS; fall back to unverified claims in bypass mode
        jwks = _get_jwks()
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
                return str(payload.get("preferred_username") or payload.get("sub") or "user")
        if settings.auth_bypass:
            payload = jwt.get_unverified_claims(token)
            return str(payload.get("preferred_username") or payload.get("sub") or "user")
        raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError as exc:
        if settings.auth_bypass:
            return "dev-bypass"
        raise HTTPException(status_code=401, detail=str(exc)) from exc


UserDep = Annotated[str, Depends(current_user)]
