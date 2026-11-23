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

import os

# ------------------------------------------------------------------------- #
# LA BASE DE DATOS, ANTES DE IMPORTAR NADA DE `app`.
#
# `apps/api/.env` existe en la maquina de desarrollo y su `DATABASE_URL` apunta
# al POOLER DE SUPABASE DE PRODUCCION. `app/shared/database.py` construye el
# motor al importarse, leyendo esa variable: cualquier prueba que se olvide de
# sustituir `get_db` —hoy todas lo hacen, pero basta una nueva— abriria una
# sesion contra la base real. No conecta hasta que alguien la usa, y esa es
# exactamente la clase de bomba que no avisa hasta que estalla.
#
# Se fija aqui y no en una fixture porque una fixture llega TARDE: el motor ya
# se creo cuando pytest importo el modulo de prueba. Y por eso este bloque va
# antes de los `from app...` de mas abajo, que son los que arrastran el modulo
# de base de datos.
#
# Se ESCRIBE la variable en vez de comprobarla y fallar: una comprobacion
# obligaria a cada persona a preparar su entorno antes de poder ejecutar las
# pruebas, y lo que hace falta es que ejecutarlas sea inofensivo por defecto.
# Cada prueba sigue levantando su propio motor en memoria, como hasta ahora;
# esto solo decide a donde apunta el que NADIE deberia estar usando.
# ------------------------------------------------------------------------- #
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import pytest

from app.core.config import get_settings
from app.modules.catalog import esquema as esquema_de_catalogo
from app.modules.medios import calidades as calidades_de_video
from app.modules.medios import esquema as esquema_de_medios
from app.modules.medios import firma as firma_de_medios
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
def _servicios_abierto_a_todos(monkeypatch: pytest.MonkeyPatch) -> None:
    """Las pruebas de Servicios encienden `feature_services` y dan por hecho
    que eso basta para entrar. Desde el piloto (P101) ya no basta: de fábrica,
    con la bandera encendida no entra nadie que no esté en la lista.

    Aquí se abre para todos, que es lo que esas pruebas prueban. EL VALOR DE
    FÁBRICA SE PRUEBA APARTE, y cerrado (`test_servicios_piloto.py`), donde
    cada prueba pone la lista y la apertura que necesita.
    """
    monkeypatch.setattr(get_settings(), "services_public_access", True)


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

    El de CATALOGO es el mas peligroso de los tres y por eso esta aqui y no en
    un fichero suelto: las pruebas de la 0034 aplican esas columnas a SU base en
    memoria, asi que la memoria del proceso se queda con un «si» que en la base
    de la prueba siguiente es mentira. Sin limpiarlo, cualquier prueba posterior
    que tocara un curso preguntaria por columnas que no existen y reventaria en
    un sitio que no tiene nada que ver con lo que estaba probando.

    `autouse`: no hay forma de olvidarse de aplicarla.
    """
    cache.vaciar()
    esquema.olvidar()
    esquema_de_catalogo.olvidar()
    # Los medios en S3 (0116): si la columna `almacen` existe se recuerda en el
    # proceso, y la clave de firma se guarda leida. Cada prueba levanta su base
    # y su clave.
    esquema_de_medios.olvidar()
    firma_de_medios.olvidar()
    # Lo mismo con la columna `variantes` de la 0117 (calidades de video).
    calidades_de_video.fijar(None)
