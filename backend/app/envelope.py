from typing import Any, Generic, Optional, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Meta(BaseModel):
    total: int = 0
    page: int = 1
    limit: int = 100


class Envelope(BaseModel, Generic[T]):
    success: bool = True
    data: T
    error: Optional[str] = None
    meta: Meta = Field(default_factory=Meta)


def ok(data: Any, total: int | None = None, page: int = 1, limit: int = 100) -> dict:
    if total is None:
        total = len(data) if isinstance(data, list) else 1
    return Envelope(success=True, data=data, error=None, meta=Meta(total=total, page=page, limit=limit)).model_dump()


def fail(message: str, status_hint: int = 400) -> dict:
    return Envelope(success=False, data=None, error=message, meta=Meta(total=0)).model_dump()
