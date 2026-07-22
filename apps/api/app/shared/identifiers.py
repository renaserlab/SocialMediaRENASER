"""Validacion de identificadores que llegan por la URL."""

from uuid import UUID

from app.core.exceptions import NotFoundError


def ensure_uuid(value: str, message: str) -> str:
    """Devuelve el id si es un UUID valido; si no, 404.

    Sin esta comprobacion, un id con otro formato (un slug de una pantalla
    antigua, o basura) llegaba tal cual a Postgres y asyncpg reventaba con
    `invalid UUID ...`, devolviendo un 500 en vez del 404 que corresponde.
    """
    try:
        UUID(value)
    except (ValueError, AttributeError, TypeError) as exc:
        raise NotFoundError(message) from exc
    return value
