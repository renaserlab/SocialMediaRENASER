"""Reglas que valen para TODA la suite.

LO QUE ESTO IMPIDE, y no es teorico. `apps/api/.env` existe en la maquina de
desarrollo con las credenciales REALES del proyecto. Con ese fichero delante,
`processing_configured()` devuelve True, y cualquier prueba que publique una
publicacion por HTTP encolaria `process_media` en segundo plano: una tarea que
descarga el medio de Supabase, genera derivados y los SUBE, con la
`service_role` key. Es decir, una prueba tocando produccion sin que nadie lo
haya pedido.

Nadie se dio cuenta hasta que una prueba nueva fue la primera en llamar al
endpoint de crear. Por eso se apaga aqui, para toda la suite y de una vez, en
lugar de recordarlo en cada fichero: lo que depende de que alguien se acuerde,
antes o despues falla.

Que quede claro lo que NO se esta desactivando: la logica del endpoint corre
entera —validacion, permisos, escritura— y se sigue comprobando. Lo unico que
no ocurre es la tarea de fondo que sale de la maquina.
"""

from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.modules.recommendations import cache, esquema


@pytest.fixture(autouse=True, scope="session")
def _sin_salidas_a_produccion() -> None:
    """Ninguna prueba puede escribir en el almacenamiento real.

    `autouse` y de sesion: no hay forma de olvidarse de aplicarla, y no hay
    forma de que una prueba la desactive por descuido.
    """
    ajustes = get_settings()
    ajustes.media_processing_enabled = False
    ajustes.video_transcode_enabled = False


@pytest.fixture(autouse=True)
def _sin_estado_heredado() -> None:
    """Cada prueba empieza sin lo que averiguo la anterior.

    Dos memorias viven en el PROCESO y no en la base de datos: la del ranking
    (`cache`) y la del esquema disponible (`esquema`). Las dos estan indexadas
    por identificadores —usuario, nombre de tabla— que se repiten entre pruebas,
    y cada prueba levanta su propia base en memoria.

    Sin esto funcionaba igual, pero por casualidad: porque las pruebas corren en
    el orden en que estan escritas y porque la unica que usa un esquema distinto
    se limpia a si misma. Con `pytest-randomly`, con reparto en paralelo o con
    un segundo fichero «sin migracion», una prueba heredaria la respuesta de
    otra y el fallo apareceria en un sitio que no tiene nada que ver.

    `autouse`: no hay forma de olvidarse de aplicarla.
    """
    cache.vaciar()
    esquema.olvidar()
