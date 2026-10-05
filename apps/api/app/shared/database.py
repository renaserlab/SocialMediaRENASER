"""Acceso a la base de datos (Supabase PostgreSQL).

Principio: el esquema es propiedad de las migraciones SQL de Supabase
(supabase/migrations). El backend NO ejecuta create_all en produccion; los
modelos ORM solo mapean tablas existentes para consultarlas.
"""

from collections.abc import AsyncGenerator

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
