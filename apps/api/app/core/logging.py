"""Logging minimo y consistente para el backend."""

import logging

from app.core.config import get_settings


class _ConElIdentificador(logging.Filter):
    """Mete el identificador de la peticion en curso en cada linea.

    POR QUE HACE FALTA. La auditoria guarda `request_id` en cada fila, pero sin
    esto ese identificador no aparece en ninguna linea de registro: una fila de
    auditoria y las lineas que la rodean no se pueden cruzar, que es justo lo
    que hace falta para investigar algo.

    Se lee de un `ContextVar`, asi que no hay que pasarlo por veinte firmas de
    funcion. Fuera de una peticion —una tarea, el arranque— vale `-`.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        from app.modules.gobernanza.contexto import request_id

        record.peticion = request_id() or "-"
        return True


def configure_logging() -> None:
    get_settings()  # asegura settings inicializadas
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(peticion)s | %(name)s | %(message)s",
    )
    for manejador in logging.getLogger().handlers:
        manejador.addFilter(_ConElIdentificador())
    # aiosqlite es muy ruidoso en DEBUG; lo silenciamos.
    logging.getLogger("aiosqlite").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
