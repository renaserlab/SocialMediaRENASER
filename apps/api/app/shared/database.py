"""Acceso a la base de datos (Supabase PostgreSQL).

Principio: el esquema es propiedad de las migraciones SQL de Supabase
(supabase/migrations). El backend NO ejecuta create_all en produccion; los
modelos ORM solo mapean tablas existentes para consultarlas.
"""

from collections.abc import AsyncGenerator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import get_settings

settings = get_settings()

# El engine es perezoso: no abre conexion hasta la primera consulta,
# por lo que la app puede levantar aunque DATABASE_URL aun no apunte a Supabase.
#
# POR QUE ESTOS PARAMETROS Y NO LOS DE POR DEFECTO. Medido el 25/08/2026 contra
# produccion: la base vive en `aws-0-us-east-1` (Virginia) y la API en Oregon,
# asi que CADA viaje de ida y vuelta a la base cuesta unos 70 ms. Con los
# valores por defecto eso se paga mas veces de las necesarias:
#
#   * `pool_pre_ping` manda un SELECT 1 ANTES de entregar cada conexion. Es la
#     forma robusta de no servir una conexion que el pooler ya cerro, pero
#     cuesta un viaje entero. En la misma region es ~1 ms y no se nota; a
#     traves del pais son ~70 ms EN CADA PETICION. Se mantiene porque perder
#     peticiones es peor que tardar, y porque al mover la API a us-east-1 el
#     coste desaparece solo. Si alguna vez estorba, la alternativa NO es
#     quitarlo a secas: es bajar `pool_recycle` y reintentar la desconexion.
#   * `pool_recycle` cierra por iniciativa propia las conexiones que llevan
#     media hora abiertas. El pooler de Supabase las corta por su cuenta al
#     cabo de un rato; reciclarlas antes convierte un error en una reconexion
#     silenciosa, y ademas hace que el pre-ping falle mucho menos.
#   * El tamano se fija explicitamente para que sea una decision y no un
#     descuido. Diez conexiones simultaneas sobran para la carga de hoy y
#     siguen estando muy por debajo del limite del plan de Supabase, que es lo
#     que de verdad hay que no agotar: si el pool crece sin techo, quien se
#     queda sin conexiones es la base, no la API.
# EL AJUSTE DEL POOL ES SOLO PARA POSTGRESQL. SQLite no usa un pool con tamano
# —en memoria es `StaticPool`, en fichero `NullPool`— y pasarle `pool_size` o
# `max_overflow` levanta un `TypeError` al construir el motor. O sea: el valor
# POR DEFECTO de `database_url` es SQLite y con el la aplicacion no arrancaba,
# aunque toda la configuracion y `create_all_dev()` prometen que ese modo existe.
# Nadie se dio cuenta porque en la maquina de desarrollo hay un `.env` que
# apunta a Postgres y en produccion tambien.
_opciones_del_pool: dict[str, object] = (
    {}
    if settings.uses_sqlite
    else {"pool_pre_ping": True, "pool_recycle": 1800, "pool_size": 5, "max_overflow": 5}
)

engine = create_async_engine(
    settings.database_url,
    echo=False,
    **_opciones_del_pool,
)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


# --------------------------------------------------------------------------- #
# TOPE POR SENTENCIA (`statement_timeout`)
#
# QUE PASABA SIN EL. La API entra como `postgres`, y ese rol no tiene tope (los
# de PostgREST si: 3 s `anon`, 8 s `authenticated`). Una consulta que se tuerce
# —un plan malo, un cerrojo que no se suelta— seguia corriendo despues de que
# CloudFront cortara a los 60 s y la app mostrara el error: nadie esperaba ya la
# respuesta, pero la sentencia seguia gastando CPU de la base y, sobre todo,
# tenia cogida una de las diez conexiones del pool. Unas pocas asi a la vez y
# se para la API entera, no la pantalla que las pidio.
#
# POR QUE ESTE VALOR. Tiene que caber DEBAJO de los 60 s de CloudFront y del
# balanceador con margen para el resto de la peticion (esperar turno en el
# pool, otras sentencias, contestar), y muy POR ENCIMA de lo mas largo que la
# API hace a proposito. Lo mas largo que se encontro (auditoria 28/10/2026) es
# la baja de una cuenta, que borra en cascada todo lo suyo: con la base de la
# prueba de carga (1000 personas, 180 000 mensajes), el `DELETE` del perfil de
# quien creo un grupo de 100 000 mensajes tarda 3,4 s; el de una persona
# normal, 54 ms. Treinta segundos dejan casi diez veces ese margen y aun asi
# cortan antes que CloudFront. Las pasadas de la cola de avisos, los barridos
# de Servicios (por lotes, y EventBridge corta a los 5 s) y
# `scripts/reprocesar_miniaturas.py` son consultas de milisegundos. Los guiones
# de la raiz (`scripts/procesar_media.py`) no usan este motor: hablan con la
# API REST de Supabase. Las migraciones tampoco: van por su propia conexion.
#
# ES POR SENTENCIA, NO POR PETICION: una peticion con tres consultas de 20 s
# no se corta. Para eso estan CloudFront y el balanceador.
#
# COMO SE APLICA: con un `SET` al abrir CADA conexion, no con
# `connect_args={"server_settings": ...}`. Los dos dejan el ajuste en la
# sesion, pero `server_settings` viaja en el paquete de arranque y quien lo
# recibe en produccion es el pooler de Supabase (Supavisor, modo sesion, puerto
# 5432), que monta su propia conexion con la base: un parametro de arranque que
# no reenvie se perderia en silencio, y uno que no entienda tumbaria todas las
# conexiones. Un `SET` es una sentencia mas y en modo sesion llega tal cual a
# la conexion que queda reservada para nosotros. NO valdria en modo
# transaccion (6543), donde cada transaccion puede caer en otra conexion: si
# algun dia se cambia de puerto, esto hay que pasarlo a `SET LOCAL`.
#
# Va FUERA de toda transaccion (`run_async` con la conexion de asyncpg, que
# sin transaccion abierta confirma cada sentencia): un `SET` dentro de una
# transaccion que despues se deshace se deshace con ella, y el `ROLLBACK` con
# el que el pool limpia cada conexion al devolverla se lo llevaria.
#
# Solo PostgreSQL: SQLite no tiene `statement_timeout` y el `SET` fallaria.
# --------------------------------------------------------------------------- #
def tope_por_sentencia_ms(ajustes=None) -> int | None:  # noqa: ANN001
    """Milisegundos del tope, o `None` si no se aplica (SQLite, o cero)."""
    ajustes = ajustes or settings
    if ajustes.uses_sqlite:
        return None
    ms = int(ajustes.database_statement_timeout_ms or 0)
    return ms if ms > 0 else None


def instalar_tope_por_sentencia(motor, ms: int | None):  # noqa: ANN001, ANN201
    """Engancha el `SET statement_timeout` a cada conexion NUEVA de `motor`.

    Devuelve el escucha enganchado (para poder comprobarlo o quitarlo), o
    `None` si no engancho nada: con `ms` a `None`, que es el caso de SQLite y
    el de quien lo apaga con cero.

    Una vez por conexion y no por peticion: el pool las reutiliza y el ajuste
    vive lo que vive la sesion, asi que no cuesta ningun viaje mas a la base
    salvo al abrir una conexion nueva (cada media hora, por `pool_recycle`).
    """
    if ms is None:
        return None
    sentencia = f"set statement_timeout = {int(ms)}"

    def _al_conectar(conexion_dbapi, _registro) -> None:  # noqa: ANN001
        conexion_dbapi.run_async(lambda conexion: conexion.execute(sentencia))

    event.listen(motor.sync_engine, "connect", _al_conectar)
    return _al_conectar


instalar_tope_por_sentencia(engine, tope_por_sentencia_ms())


class Base(DeclarativeBase):
    """Base declarativa compartida por todos los modulos."""


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
        # LA PETICIÓN TERMINÓ BIEN. Si dejó avisos en la cola de entregas, se
        # envían ahora y no cuando alguien se acuerde de vaciarla (ver
        # `notifications/despacho.py`). No espera a nada ni puede lanzar. Si la
        # petición falló, aquí no se llega: no hay nada confirmado que enviar.
        # Se importa aquí porque ese módulo depende de este.
        from app.modules.notifications import despacho

        despacho.tras_la_peticion(session)


async def create_all_dev() -> None:
    """Crea las tablas a partir de los modelos ORM.

    SOLO para desarrollo local sin Supabase (p. ej. SQLite). En produccion
    el esquema lo aplican las migraciones; llamar esto ahi es un error.
    """
    if settings.is_production:
        raise RuntimeError(
            "create_all_dev() no debe usarse en produccion. "
            "El esquema se gestiona con supabase/migrations."
        )
    # Importa los modelos para que queden registrados en Base.metadata.
    from app.modules.bookings import models as _bookings  # noqa: F401
    from app.modules.catalog import models as _catalog  # noqa: F401
    from app.modules.communities import models as _communities  # noqa: F401
    from app.modules.gobernanza import models as _gobernanza  # noqa: F401
    from app.modules.content import models as _content  # noqa: F401
    from app.modules.learning import models as _learning  # noqa: F401
    from app.modules.messaging import models as _messaging  # noqa: F401
    from app.modules.moderation import models as _moderation  # noqa: F401
    from app.modules.notifications import device_tokens as _device_tokens  # noqa: F401
    from app.modules.notifications import models as _notifications  # noqa: F401
    from app.modules.profiles import models as _profiles  # noqa: F401
    from app.modules.recommendations import models as _recs  # noqa: F401
    from app.modules.reviews import models as _reviews  # noqa: F401
    from app.modules.social_graph import models as _social  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
