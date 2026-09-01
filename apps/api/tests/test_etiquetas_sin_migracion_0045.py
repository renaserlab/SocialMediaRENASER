"""La aplicacion tiene que funcionar SIN la migracion 0045.

POR QUE ESTA PRUEBA EXISTE, Y ES LA MISMA LECCION QUE LA 0027, LA 0028, LA 0029
Y LA 0033. Se escribio codigo contra un esquema que todavia no estaba aplicado y
la rama entera dejo de funcionar contra la base real: cada peticion que tocaba
la tabla nueva reventaba con un 500 que el navegador ademas reportaba como error
de CORS, porque Starlette no anade cabeceras CORS a una excepcion sin capturar.
Horas buscando en el sitio equivocado.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta. La 0045 espera aprobacion humana, asi que HOY, contra
produccion, esto es lo que tiene que pasar:

- LA BANDEJA FUNCIONA EXACTAMENTE IGUAL QUE SIEMPRE. Esto es lo importante: las
  etiquetas son una capa ENCIMA de las conversaciones, no una parte de ellas, y
  una funcion que todavia no esta no puede degradar la mensajeria.
- Listar etiquetas responde `[]`. No es un error: no hay etiquetas, y una lista
  vacia significa exactamente eso. La aplicacion, al verla vacia y recibir el
  503 al escribir, NO OFRECE la funcion: nunca un boton muerto.
- Crear, renombrar, borrar, asignar y quitar responden 503 y
  `conversation_labels_not_available`. 503 y no 404 —que haria pensar que la
  ruta esta mal escrita— ni 500 —que haria pensar que algo se ha roto—.
- Y las dos funciones que consumira el listado de conversaciones (el filtro por
  etiqueta y la lectura por lotes) responden «nada», no revientan. Si el filtro
  fallara, el listado entero dejaria de responder por una funcion que ni
  siquiera esta puesta.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITAN las dos tablas
que anade la 0045, dejando la base exactamente como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.etiquetas import (
    condicion_de_etiqueta,
    etiquetas_por_conversacion,
)
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CHAT = "cccccccc-0000-0000-0000-000000000001"
UNA_ETIQUETA = "11111111-2222-3333-4444-555555555555"


@pytest_asyncio.fixture
async def base_sin_0045():
    """El esquema tal y como esta HOY en produccion: sin las tablas del CRM."""
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
        from app.modules.live import models as _li  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

        # Y ahora se DESHACE la 0045, que es lo que se quiere probar. Primero las
        # asignaciones, que es la que apunta a la otra.
        await conn.execute(text("drop table conversation_label_assignments"))
        await conn.execute(text("drop table conversation_labels"))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.flush()
        db.add(Conversation(id=CHAT, kind="direct", created_by=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=BRUNO))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=ANA, email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones

    app.dependency_overrides.clear()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# 1. Lo que ya existia sigue funcionando igual
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_bandeja_funciona_exactamente_igual(base_sin_0045):
    """Lo importante de todo el fichero. Una funcion que todavia no esta no
    puede dejar a nadie sin sus mensajes."""
    http, _ = base_sin_0045

    enviado = await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    assert enviado.status_code == 201

    listado = await http.get(API)
    assert listado.status_code == 200
    assert [c["id"] for c in listado.json()] == [CHAT]

    historial = await http.get(f"{API}/{CHAT}/messages")
    assert historial.status_code == 200
    assert [m["body"] for m in historial.json()] == ["hola"]


@pytest.mark.asyncio
async def test_el_listado_no_consulta_las_tablas_que_no_existen(base_sin_0045):
    """Si las consultara, el listado entero responderia 500 —disfrazado de error
    de CORS— por una funcion que ni siquiera esta puesta.

    LA COMPROBACION CAMBIO CUANDO LA BANDEJA EMPEZO A DEVOLVER `labels` EN CADA
    FILA. Antes bastaba con que la palabra «label» no apareciera en la respuesta;
    ahora el campo esta SIEMPRE —es parte del contrato de `ConversationRead`— y
    lo que hay que exigir es que venga VACIO sin la 0045. La diferencia importa:
    el campo presente y vacio es la verdad («no hay etiquetas»), mientras que
    consultar la tabla ausente para saberlo seria el 500 que este fichero
    persigue. Quien lo garantiza es el retorno temprano de
    `etiquetas_por_conversacion`, que ni toca la base.
    """
    http, _ = base_sin_0045
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    respuesta = await http.get(API)
    assert respuesta.status_code == 200
    filas = respuesta.json()
    assert filas, "la bandeja tiene que seguir devolviendo la conversacion"
    assert all(fila["labels"] == [] for fila in filas), (
        "sin la 0045 no hay etiquetas: el campo tiene que venir vacio"
    )


@pytest.mark.asyncio
async def test_filtrar_por_etiqueta_sin_la_0045_no_revienta_y_no_devuelve_nada(
    base_sin_0045,
):
    """Un `label_id` en la URL sin la migracion puesta: lista vacia, nunca 500.

    Puede llegar de un cliente viejo que guardo el filtro elegido, o de una URL
    escrita a mano. La respuesta correcta es «no hay ninguna conversacion con esa
    etiqueta», que ademas es cierta: sin la tabla no hay etiquetas. Lo que no
    puede pasar es consultar `conversation_label_assignments` para averiguarlo.
    """
    http, _ = base_sin_0045
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    respuesta = await http.get(
        API, params={"label_id": "11111111-1111-1111-1111-111111111111"}
    )
    assert respuesta.status_code == 200
    assert respuesta.json() == []


# --------------------------------------------------------------------------- #
# 2. Leer responde vacio; escribir responde 503
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_listar_etiquetas_responde_vacio_y_no_un_error(base_sin_0045):
    """No hay etiquetas. Una lista vacia significa exactamente eso, y es lo que
    hace que la aplicacion ofrezca crear la primera en vez de un fallo."""
    http, _ = base_sin_0045
    respuesta = await http.get(f"{API}/labels")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_las_etiquetas_de_una_conversacion_responden_vacio(base_sin_0045):
    http, _ = base_sin_0045
    respuesta = await http.get(f"{API}/{CHAT}/labels")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_escribir_responde_503_con_su_codigo_y_nunca_500(base_sin_0045):
    """503 y no 404 ni 500: la ruta existe y esta bien escrita, lo que falta es
    que la migracion este puesta. Y con codigo propio para que la aplicacion
    pueda esconder la funcion en vez de ensenar un error generico."""
    http, _ = base_sin_0045

    peticiones = [
        await http.post(f"{API}/labels", json={"nombre": "Seguimiento"}),
        await http.patch(f"{API}/labels/{UNA_ETIQUETA}", json={"nombre": "Otra"}),
        await http.delete(f"{API}/labels/{UNA_ETIQUETA}"),
        await http.put(f"{API}/{CHAT}/labels/{UNA_ETIQUETA}"),
        await http.delete(f"{API}/{CHAT}/labels/{UNA_ETIQUETA}"),
    ]
    for respuesta in peticiones:
        assert respuesta.status_code == 503, respuesta.text
        assert respuesta.json()["error"]["code"] == "conversation_labels_not_available"


# --------------------------------------------------------------------------- #
# 3. Lo que consumira el listado tampoco revienta
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_filtro_por_etiqueta_no_devuelve_nada_y_no_falla(base_sin_0045):
    """El endpoint de la lista acepta `label_id`. Si esta condicion reventara
    sin la 0045, filtrar tumbaria la bandeja entera."""
    _, sesiones = base_sin_0045
    async with sesiones() as db:
        condicion = await condicion_de_etiqueta(db, uid=ANA, label_id=UNA_ETIQUETA)
        filas = (
            await db.execute(select(Conversation.id).where(condicion))
        ).scalars().all()
    assert filas == []


@pytest.mark.asyncio
async def test_la_lectura_por_lotes_devuelve_un_diccionario_vacio(base_sin_0045):
    """Es lo que pinta los chips de cada fila de la bandeja: sin la 0045 no hay
    ninguno que pintar, que no es lo mismo que no poder pintar la bandeja."""
    _, sesiones = base_sin_0045
    async with sesiones() as db:
        assert (
            await etiquetas_por_conversacion(db, uid=ANA, conversation_ids=[CHAT])
        ) == {}
