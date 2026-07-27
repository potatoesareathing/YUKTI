"""Zoho Catalyst Data Store as a backend data source.

CATALYST-DEPLOY.md treats Catalyst as the hosting layer — Slate for the
frontend, AppSail for this service. This module adds the other half: reading
the crime tables out of the Catalyst **Data Store** over ZCQL, so the backend
can serve the same questions from either its own SQLAlchemy session or from
Catalyst, without the caller knowing which.

Auth is the standard Zoho OAuth refresh-token grant. The refresh token is
long-lived and belongs in the environment, never in the repository; access
tokens are minted on demand and cached until just before they expire.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

# Zoho runs per-datacentre hosts. The YUKTI project lives in the India DC.
_ACCOUNTS_HOST = {
    "in": "https://accounts.zoho.in",
    "us": "https://accounts.zoho.com",
    "eu": "https://accounts.zoho.eu",
    "au": "https://accounts.zoho.com.au",
}
_API_HOST = {
    "in": "https://api.catalyst.zoho.in",
    "us": "https://api.catalyst.zoho.com",
    "eu": "https://api.catalyst.zoho.eu",
    "au": "https://api.catalyst.zoho.com.au",
}

# ZCQL caps a single result page. Paging is by ROWID cursor rather than LIMIT
# offset: Catalyst treats the offset in `LIMIT offset, count` as 1-indexed, so
# offset paging overlaps by exactly one row on every page boundary.
ZCQL_PAGE = 300


class CatalystError(RuntimeError):
    """Raised when the Catalyst Data Store cannot be reached or rejects a query."""


class CatalystNotConfigured(CatalystError):
    """Raised when Catalyst credentials are absent."""


@dataclass
class _Token:
    value: str
    expires_at: float

    @property
    def valid(self) -> bool:
        return bool(self.value) and time.time() < self.expires_at - 60


class CatalystClient:
    """Thin ZCQL client over the Catalyst Data Store."""

    def __init__(
        self,
        project_id: str,
        environment_id: str,
        refresh_token: str = "",
        client_id: str = "",
        client_secret: str = "",
        datacentre: str = "in",
        environment: str = "Development",
        timeout: float = 20.0,
        access_token: str = "",
    ) -> None:
        """Authenticates one of two ways.

        A ``refresh_token`` plus client credentials is the durable option: the
        client mints access tokens as needed and a long-running service never
        needs attention.

        An ``access_token`` on its own is the short-lived option, for a token
        injected by something that already holds the credentials — a CI secret,
        a sidecar, or ``catalyst token:generate`` on a developer's machine. It
        expires in about an hour and is not refreshed, which is the point: the
        credential that could mint more never reaches this process.
        """
        if not project_id or not environment_id:
            raise CatalystNotConfigured(
                "Catalyst is not configured. Set catalyst_project_id and catalyst_environment_id."
            )
        if not access_token and not all([refresh_token, client_id, client_secret]):
            raise CatalystNotConfigured(
                "Catalyst needs either catalyst_access_token, or all of catalyst_refresh_token, "
                "catalyst_client_id and catalyst_client_secret."
            )
        self.project_id = project_id
        self.environment_id = environment_id
        self.environment = environment
        self._refresh_token = refresh_token
        self._client_id = client_id
        self._client_secret = client_secret
        self._accounts = _ACCOUNTS_HOST.get(datacentre, _ACCOUNTS_HOST["in"])
        self._api = _API_HOST.get(datacentre, _API_HOST["in"])
        self._timeout = timeout
        self._static_token = access_token
        # A supplied token is treated as valid for an hour; Zoho issues them
        # with roughly that lifetime and does not tell us when it was minted.
        self._token = _Token(access_token, time.time() + 3600) if access_token else _Token("", 0.0)
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ auth

    def _access_token(self) -> str:
        with self._lock:
            if self._token.valid:
                return self._token.value
            if self._static_token:
                raise CatalystError(
                    "The supplied Catalyst access token has expired. Supply a fresh "
                    "catalyst_access_token, or configure the refresh-token credentials so "
                    "tokens can be minted automatically."
                )
            try:
                response = httpx.post(
                    f"{self._accounts}/oauth/v2/token",
                    data={
                        "refresh_token": self._refresh_token,
                        "client_id": self._client_id,
                        "client_secret": self._client_secret,
                        "grant_type": "refresh_token",
                    },
                    timeout=self._timeout,
                )
                response.raise_for_status()
                payload = response.json()
            except httpx.HTTPError as exc:
                raise CatalystError(f"Could not refresh the Catalyst access token: {exc}") from exc

            token = payload.get("access_token")
            if not token:
                raise CatalystError(f"Token endpoint returned no access_token: {payload}")
            self._token = _Token(token, time.time() + float(payload.get("expires_in", 3600)))
            return token

    # ----------------------------------------------------------------- query

    def _headers(self) -> dict[str, str]:
        """Catalyst selects project environment by header, not query string.

        Sending ``?Environment=`` and ``?catalyst_org=`` instead is accepted by
        the endpoint and then rejected as INVALID_INPUT, which reads like a
        malformed query rather than a missing header — so these are kept in one
        place and mirrored from the CLI's own request builder.
        """
        return {
            "Authorization": f"Zoho-oauthtoken {self._access_token()}",
            "Accept": "application/vnd.catalyst.v2+json",
            "X-CATALYST-Environment": self.environment,
            "CATALYST-ORG": self.environment_id,
        }

    def query(self, zcql: str) -> list[dict[str, Any]]:
        """Run one ZCQL statement and return flattened rows."""
        url = f"{self._api}/baas/v1/project/{self.project_id}/query"
        try:
            response = httpx.post(
                url,
                headers=self._headers(),
                json={"query": zcql},
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise CatalystError(f"Catalyst request failed: {exc}") from exc

        if response.status_code >= 400:
            raise CatalystError(f"Catalyst rejected the query ({response.status_code}): {response.text[:400]}")

        body = response.json()
        rows = body.get("data")
        if rows is None:
            raise CatalystError(f"Unexpected Catalyst response: {str(body)[:400]}")
        return [_flatten(row) for row in rows]

    def paged_query(self, zcql_without_limit: str, table: str, page: int = ZCQL_PAGE) -> list[dict[str, Any]]:
        """Page a query by ROWID cursor.

        Catalyst's ``LIMIT offset, count`` offset is 1-indexed, so offset paging
        silently repeats one row per page. Cursoring on ROWID avoids it entirely.
        """
        out: list[dict[str, Any]] = []
        cursor = "0"
        while True:
            joiner = "AND" if " where " in zcql_without_limit.lower() else "WHERE"
            statement = (
                f"{zcql_without_limit} {joiner} {table}.ROWID > {cursor} "
                f"ORDER BY {table}.ROWID LIMIT {page}"
            )
            rows = self.query(statement)
            if not rows:
                break
            out.extend(rows)
            cursor = str(rows[-1].get("ROWID"))
            if len(rows) < page:
                break
        return out

    def ping(self) -> bool:
        try:
            self.query("SELECT ROWID FROM CaseMaster LIMIT 1")
            return True
        except CatalystError:
            return False


def _flatten(row: dict[str, Any]) -> dict[str, Any]:
    """ZCQL nests each row under its table name; merge them into one flat dict."""
    if not isinstance(row, dict):
        return {"value": row}
    flat: dict[str, Any] = {}
    for value in row.values():
        if isinstance(value, dict):
            flat.update(value)
    return flat or row


_client: CatalystClient | None = None
_client_lock = threading.Lock()


def get_catalyst_client() -> CatalystClient:
    """Process-wide Catalyst client. Raises CatalystNotConfigured when unset."""
    global _client
    with _client_lock:
        if _client is None:
            settings = get_settings()
            _client = CatalystClient(
                project_id=settings.catalyst_project_id,
                environment_id=settings.catalyst_environment_id,
                refresh_token=settings.catalyst_refresh_token,
                client_id=settings.catalyst_client_id,
                client_secret=settings.catalyst_client_secret,
                datacentre=settings.catalyst_dc,
                environment=settings.catalyst_environment,
                access_token=settings.catalyst_access_token,
            )
        return _client
