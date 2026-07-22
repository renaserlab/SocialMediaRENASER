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
engine = create_async_engine(settings.database_url, echo=False, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    """Base declarativa compartida por todos los modulos."""


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


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
    from app.modules.catalog import models as _catalog  # noqa: F401
    from app.modules.communities import models as _communities  # noqa: F401
    from app.modules.content import models as _content  # noqa: F401
    from app.modules.learning import models as _learning  # noqa: F401
    from app.modules.messaging import models as _messaging  # noqa: F401
    from app.modules.moderation import models as _moderation  # noqa: F401
    from app.modules.notifications import models as _notifications  # noqa: F401
    from app.modules.profiles import models as _profiles  # noqa: F401
    from app.modules.social_graph import models as _social  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
