"""Utilidades de paginacion compartidas."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Query


@dataclass(frozen=True)
class Page:
    limit: int
    offset: int


def pagination_params(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> Page:
    return Page(limit=limit, offset=offset)
