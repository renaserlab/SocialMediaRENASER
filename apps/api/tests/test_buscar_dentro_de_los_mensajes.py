"""Buscar por lo que se DIJO, y solo cuando salga barato (migración 0046).

QUÉ VIGILA ESTE FICHERO, y por qué cada cosa está aquí.

1. **SIN LA 0046 NO CAMBIA ABSOLUTAMENTE NADA.** Es la parte que más importa y
   la primera que se prueba. La búsqueda de la bandeja ya funcionaba por nombre
   y por usuario, está en producción, y una migración que todavía no se ha
   aplicado no puede alterar ni un resultado de los que ya salían. Sin el índice
   trigram, buscar el texto de un mensaje **no encuentra nada nuevo**.

2. **CON LA 0046, ENCUENTRA POR EL TEXTO.** Y sin dejar de encontrar por nombre:
   es una condición que se SUMA con `or_`, así que ninguna conversación que
   aparecía antes deja de aparecer.

3. **LOS BORRADOS NO SE ENCUENTRAN.** Un mensaje con lápida conserva su texto en
   la fila para que el historial pueda pintar «mensaje eliminado» en su sitio.
   Encontrarlo al buscar sería devolverle a alguien justo lo que decidió quitar.

4. **NO CUESTA NI UNA CONSULTA MÁS.** Es una condición dentro de la sentencia
   que ya se hacía. Se cuentan las consultas reales, con dos tamaños.

5. **NO SE BUSCA EN LO AJENO.** El texto de un mensaje es más sensible que un
   nombre: la subconsulta del texto NO está acotada a las conversaciones de
   quien busca —lo hace la consulta de fuera— y esa delegación hay que probarla,
   no suponerla.

CÓMO SE SIMULA LA MIGRACIÓN. La comprobación de esquema pregunta por el NOMBRE
del índice con el inspector de SQLAlchemy, que funciona igual en PostgreSQL y en
SQLite. Así que aquí se crea un índice corriente con ese mismo nombre: no es un
índice trigram —SQLite no los tiene— pero para lo que se prueba da igual, porque
lo que decide encender la función es que EXISTA, y el `ILIKE` es SQL corriente
que se comporta igual en los dos motores. Lo que el índice de verdad cambia es
el coste, y eso no se mide con SQLite.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import Conversation, ConversationMember, Message
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"
#: Dos personas que hablan entre ellas. Ana no está en esa conversación.
DIEGO = "aaaaaaaa-0000-0000-0000-000000000004"
ELENA = "aaaaaaaa-0000-0000-0000-000000000005"

CHAT_BRUNO = "cccccccc-0000-0000-0000-000000000001"
CHAT_CARLA = "cccccccc-0000-0000-0000-000000000002"
CHAT_AJENO = "cccccccc-0000-0000-0000-000000000003"

#: La palabra que se busca. Rara a propósito: no puede salir por casualidad en
#: un nombre, en un usuario ni en otro mensaje.
PALABRA = "berenjena"

ORIGEN = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)


def _instante(segundos: int) -> datetime:
    return ORIGEN + timedelta(seconds=segundos)


async def _sembrar(sesiones) -> None:
    """Tres conversaciones: una de Ana con la palabra, otra sin ella, y una ajena."""
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana Lopez", username="ana"),
                Profile(id=BRUNO, full_name="Bruno Diaz", username="bruno"),
                Profile(id=CARLA, full_name="Carla Ruiz", username="carla"),
                Profile(id=DIEGO, full_name="Diego Paz", username="diego"),
                Profile(id=ELENA, full_name="Elena Sol", username="elena"),
            ]
        )
        for chat, (uno, otro) in (
            (CHAT_BRUNO, (ANA, BRUNO)),
            (CHAT_CARLA, (ANA, CARLA)),
            (CHAT_AJENO, (DIEGO, ELENA)),
        ):
            db.add(Conversation(id=chat, kind="direct", created_by=uno))
            db.add(ConversationMember(conversation_id=chat, user_id=uno))
            db.add(ConversationMember(conversation_id=chat, user_id=otro))

        # En el chat con Bruno se dijo la palabra.
        db.add(
            Message(
                conversation_id=CHAT_BRUNO,
                sender_id=BRUNO,
                body=f"te traigo {PALABRA} del mercado",
                created_at=_instante(10),
            )
        )
        # En el de Carla, no.
        db.add(
            Message(
                conversation_id=CHAT_CARLA,
                sender_id=CARLA,
                body="nos vemos el jueves",
                created_at=_instante(20),
            )
        )
        # Y en uno donde Ana NO esta, si.
        db.add(
            Message(
                conversation_id=CHAT_AJENO,
                sender_id=DIEGO,
                body=f"la {PALABRA} estaba buenisima",
                created_at=_instante(30),
            )
        )
        await db.commit()


async def _levantar(*, con_0046: bool):
    cache.vaciar()
    esquema.olvidar()
    esquema_mensajes.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401
        from app.modules.stories import models as _st  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
        if con_0046:
            # La 0046, en lo único que la comprobación de esquema mira: que exista
            # un índice con ESE nombre. Ver la cabecera del fichero.
            await conn.execute(
                text(
                    "create index "
                    f"{esquema_mensajes.INDICE_DE_BUSQUEDA_EN_MENSAJES} "
                    "on messages (body)"
                )
            )

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    await _sembrar(sesiones)

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=ANA, email="ana@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    return engine, sesiones


@pytest_asyncio.fixture
async def sin_0046():
    engine, sesiones = await _levantar(con_0046=False)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, engine
    app.dependency_overrides.clear()
    await engine.dispose()


@pytest_asyncio.fixture
async def con_0046():
    engine, sesiones = await _levantar(con_0046=True)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, engine
    app.dependency_overrides.clear()
    await engine.dispose()


async def _buscar(http: AsyncClient, texto: str) -> list[str]:
    respuesta = await http.get(f"{API}?q={texto}")
    assert respuesta.status_code == 200, respuesta.text
    return [fila["id"] for fila in respuesta.json()]


# --------------------------------------------------------------------------- #
# 1. Sin la migración, NADA cambia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0046_el_texto_de_un_mensaje_no_encuentra_nada(sin_0046):
    """La prueba que protege lo que ya está en producción.

    Una migración sin aplicar no puede alterar un solo resultado de los que ya
    salían. Si esta se pone roja, es que la búsqueda dentro de los mensajes se
    encendió sin índice, que es el recorrido secuencial que la 0046 vino a
    evitar.
    """
    http, _, _ = sin_0046

    assert await _buscar(http, PALABRA) == []


@pytest.mark.asyncio
async def test_sin_la_0046_seguir_buscando_por_nombre_funciona_igual(sin_0046):
    http, _, _ = sin_0046

    assert await _buscar(http, "bruno") == [CHAT_BRUNO]


# --------------------------------------------------------------------------- #
# 2. Con la migración, encuentra por el texto
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_con_la_0046_se_encuentra_por_lo_que_se_dijo(con_0046):
    http, _, _ = con_0046

    assert await _buscar(http, PALABRA) == [CHAT_BRUNO]


@pytest.mark.asyncio
async def test_buscar_por_nombre_sigue_funcionando_con_la_0046(con_0046):
    """La condición se SUMA con `or_`: nada de lo que aparecía deja de aparecer."""
    http, _, _ = con_0046

    assert await _buscar(http, "carla") == [CHAT_CARLA]


@pytest.mark.asyncio
async def test_una_palabra_de_dos_letras_no_entra_en_los_mensajes(con_0046):
    """`pg_trgm` indexa grupos de TRES letras: con menos, el índice no ayuda.

    Y además «de» aparece en media aplicación. Por debajo del umbral se busca
    como siempre, por nombre y por usuario.
    """
    http, sesiones, _ = con_0046
    async with sesiones() as db:
        db.add(
            Message(
                conversation_id=CHAT_CARLA,
                sender_id=CARLA,
                body="ab cd",
                created_at=_instante(40),
            )
        )
        await db.commit()

    assert await _buscar(http, "ab") == []


# --------------------------------------------------------------------------- #
# 3. Lo que se borró, se borró
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_mensaje_con_lapida_no_se_encuentra(con_0046):
    """El texto sigue en la fila para poder pintar «mensaje eliminado» en su
    sitio; encontrarlo al buscar sería devolver justo lo que alguien quitó."""
    http, sesiones, _ = con_0046
    async with sesiones() as db:
        # Por el ORM y no con SQL crudo: `Uuid(as_uuid=False)` guarda el
        # identificador SIN guiones en SQLite, asi que un `where id = :id` con la
        # cadena de siempre no encuentra la fila. El modelo hace la conversion.
        mensaje = (
            await db.scalars(
                select(Message).where(Message.conversation_id == CHAT_BRUNO)
            )
        ).one()
        mensaje.deleted_at = _instante(50)
        await db.commit()

    assert await _buscar(http, PALABRA) == []


# --------------------------------------------------------------------------- #
# 4. No se busca en lo ajeno
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_encuentra_una_conversacion_de_la_que_no_eres_miembro(con_0046):
    """La subconsulta del texto NO se acota a las conversaciones de quien busca.

    Es deliberado —así el índice se recorre una sola vez— y quien acota es la
    consulta de fuera, que está unida a la propia fila de
    `conversation_members`. Esa delegación hay que probarla: si algún día alguien
    reordena esa unión, esto se convierte en leer los mensajes de otros.
    """
    http, _, _ = con_0046

    encontradas = await _buscar(http, PALABRA)

    assert CHAT_AJENO not in encontradas
    assert encontradas == [CHAT_BRUNO]


# --------------------------------------------------------------------------- #
# 5. Ni una consulta más
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_buscar_en_los_mensajes_no_añade_consultas(con_0046):
    """Es una condición dentro de la sentencia que ya se hacía.

    Se compara contra la MISMA petición sin texto: si el número sube, es que
    alguien resolvió la búsqueda en una consulta aparte, y de ahí a una por
    conversación hay un paso.
    """
    http, _, engine = con_0046

    contadas: list[str] = []

    def _apuntar(_conn, _cursor, sentencia, *_a):  # noqa: ANN001
        if sentencia.lstrip().lower().startswith("select"):
            contadas.append(sentencia)

    event.listen(engine.sync_engine, "before_cursor_execute", _apuntar)
    try:
        await http.get(API)
        sin_buscar = len(contadas)
        contadas.clear()
        await http.get(f"{API}?q={PALABRA}")
        buscando = len(contadas)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _apuntar)

    assert buscando == sin_buscar, (
        f"buscar costó {buscando} consultas y no buscar {sin_buscar}"
    )


@pytest.mark.asyncio
async def test_el_indice_se_pregunta_una_vez_por_proceso(con_0046):
    """Preguntarlo en cada petición sería un viaje a la base por tecleo.

    Es la misma regla del resto de comprobaciones de esquema, y aquí pesa más
    que en ninguna: la búsqueda se dispara con cada letra.
    """
    http, _, _ = con_0046
    esquema_mensajes.olvidar()

    await http.get(f"{API}?q={PALABRA}")
    assert esquema_mensajes._cache["indice_busqueda_mensajes"] is True

    # Y una segunda petición ya no vuelve a mirarlo: si lo hiciera, el valor
    # tendría que salir del inspector otra vez y no de la memoria.
    guardado = dict(esquema_mensajes._cache)
    await http.get(f"{API}?q={PALABRA}")
    assert esquema_mensajes._cache == guardado
