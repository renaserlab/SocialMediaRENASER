"""El texto de la política de una sola devolución, versionado y con huella.

POR QUÉ AQUÍ Y NO EN EL FRONTEND. Porque lo que hay que poder demostrar después
es qué texto EXACTO se le enseñó a alguien antes de cobrarle. Si el texto vive
en la aplicación móvil, cambia con cada despliegue y las aceptaciones antiguas
apuntan a una redacción que ya no existe; entonces «lo aceptó» no significa
nada, porque no se sabe el qué.

El servidor manda el texto, el servidor guarda su huella, y el cliente solo lo
muestra. Cambiar la redacción obliga a subir la versión, y las aceptaciones ya
guardadas siguen señalando la suya.
"""

from __future__ import annotations

import hashlib
from typing import Final

#: Súbela al cambiar cualquiera de los textos de abajo. Las aceptaciones ya
#: guardadas conservan la versión con la que se firmaron.
VERSION_ACTUAL: Final = "v1"

#: Lo que se le enseña a quien ya usó su garantía y vuelve a comprar. `{fecha}`
#: lo rellena el servidor con la fecha real del reembolso anterior.
AVISO_DE_RECOMPRA: Final = (
    "Ya utilizaste la garantía de devolución de este curso el {fecha}. "
    "Si vuelves a comprarlo, conservarás tu progreso, pero esta nueva compra "
    "no admitirá otra devolución."
)

#: Lo que hay que marcar para poder continuar.
CASILLA_DE_ACEPTACION: Final = (
    "He leído y acepto que esta recompra no cuenta con una nueva garantía "
    "de devolución."
)


def huella(texto: str) -> str:
    """La huella del texto aceptado.

    Se guarda junto a la versión y no en lugar de ella: la versión dice cuál
    era, la huella demuestra que no se ha tocado desde entonces.
    """
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def texto_de_recompra(fecha_legible: str) -> str:
    """El aviso ya montado, tal y como se muestra y tal y como se firma."""
    return AVISO_DE_RECOMPRA.format(fecha=fecha_legible)


def huella_de_recompra(fecha_legible: str) -> str:
    """La huella de ese aviso concreto, con su fecha dentro."""
    return huella(texto_de_recompra(fecha_legible) + "\n" + CASILLA_DE_ACEPTACION)
