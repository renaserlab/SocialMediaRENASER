"""Rellena la miniatura de las fotos publicadas ANTES de que existiera.

POR QUE HACE FALTA. Las cuadriculas de perfil servian la imagen del feed
—1080 px— para celdas de 118 puntos. Ahora cada foto nueva lleva una miniatura
de 400 px en `poster_path`, pero lo ya publicado no la tiene y se sigue viendo
con el archivo grande. Este script la genera para lo anterior.

QUE HACE Y QUE NO HACE. Solo AÑADE: lee las fotos que no tienen `poster_path`,
genera la miniatura y la sube. No borra ningun archivo, no toca los originales,
no toca los derivados del feed y no modifica ninguna otra columna. Volver a
ejecutarlo es inofensivo, porque el procesado se salta lo que ya tiene
miniatura.

EN SECO POR DEFECTO. Sin `--aplicar` no escribe nada: cuenta lo que haria. Es a
proposito. Esto habla con el Storage de produccion, y algo que gasta y escribe
no puede dispararse por teclear mal un comando.

    python scripts/reprocesar_miniaturas.py                 # cuenta y se calla
    python scripts/reprocesar_miniaturas.py --aplicar       # ahora si
    python scripts/reprocesar_miniaturas.py --aplicar --limite 20

DESPUES DE EJECUTARLO no hace falta reiniciar nada: `poster_path` se lee en
cada peticion, no se cachea por proceso.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# El script vive en `scripts/` pero importa `app`, que cuelga de `apps/api`.
# Sin esto solo funcionaria ejecutandolo con -m desde el sitio exacto, y eso es
# justo lo que se olvida a los tres meses.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.modules.content.media_processing import (  # noqa: E402
    MINIATURA_MIN_BYTES,
    process_media,
    processing_configured,
)
from app.modules.content.models import PostMedia  # noqa: E402
from app.shared.database import SessionLocal  # noqa: E402

logger = logging.getLogger("reprocesar_miniaturas")


async def _pendientes(limite: int) -> list[str]:
    """Las fotos sin miniatura, de la mas reciente a la mas antigua.

    Las recientes primero porque son las que la gente abre: si el proceso se
    corta a la mitad, lo hecho es lo que mas se nota.
    """
    async with SessionLocal() as db:
        filas = (
            await db.execute(
                select(PostMedia.id)
                .where(
                    PostMedia.media_type == "image",
                    PostMedia.poster_path.is_(None),
                )
                .order_by(PostMedia.id.desc())
                .limit(limite)
            )
        ).all()
    return [fila[0] for fila in filas]


async def principal() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--aplicar",
        action="store_true",
        help="Escribe de verdad. Sin esto solo cuenta.",
    )
    parser.add_argument("--limite", type=int, default=500)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not processing_configured():
        print(
            "El procesado de multimedia no esta configurado en este entorno.\n"
            "Faltan las credenciales de Storage; sin ellas no hay nada que hacer."
        )
        return 1

    pendientes = await _pendientes(args.limite)
    if not pendientes:
        print("No hay ninguna foto sin miniatura. Nada que hacer.")
        return 0

    print(f"Fotos sin miniatura: {len(pendientes)}")
    if not args.aplicar:
        print(
            "\nEn seco: no se ha escrito nada.\n"
            f"Las que pesen menos de {MINIATURA_MIN_BYTES // 1024} KB se saltaran,\n"
            "porque el original ya es mas pequeno que la miniatura.\n"
            "Para hacerlo de verdad: --aplicar"
        )
        return 0

    hechas = 0
    fallos = 0
    for media_id in pendientes:
        try:
            await process_media(media_id)
            hechas += 1
        except Exception:
            # Una foto rota no puede parar las otras cuatrocientas.
            fallos += 1
            logger.warning("Fallo con %s", media_id, exc_info=True)

    print(f"\nProcesadas: {hechas}. Con fallo: {fallos}.")
    return 0 if fallos == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(principal()))
