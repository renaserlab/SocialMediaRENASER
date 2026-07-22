"""Logging minimo y consistente para el backend."""

import logging

from app.core.config import get_settings


def configure_logging() -> None:
    get_settings()  # asegura settings inicializadas
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    )
    # aiosqlite es muy ruidoso en DEBUG; lo silenciamos.
    logging.getLogger("aiosqlite").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
