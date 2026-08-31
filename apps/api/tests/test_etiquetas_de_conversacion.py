"""El CRM ligero de la bandeja: etiquetas PRIVADAS de conversación (0045).

LO QUE DE VERDAD SE PRUEBA AQUÍ ES UNA COSA, y todo lo demás la acompaña: que
**la etiqueta que Ana le pone a su conversación con Bruno, Bruno no la ve
jamás**. Ni en la lista, ni en el detalle, ni en un contador, ni por la
diferencia entre dos códigos de error.

Eso no se puede comprobar «mirando el endpoint de etiquetas», porque el sitio
por donde se escaparía no sería ése. Por eso hay pruebas que piden el LISTADO de
conversaciones y el HISTORIAL de mensajes desde la cuenta de Bruno y buscan el
texto de la etiqueta en la respuesta CRUDA: si algún día alguien junta las
etiquetas con la conversación sin filtrar por dueño —que es el error natural,
porque «las etiquetas de la conversación» suena a algo que existe—, esa prueba
se pone roja aunque el endpoint de etiquetas siga perfecto.

Un fallo de privacidad no se manifiesta como un fallo: todo sigue compilando y
todo sigue funcionando. Sólo que Bruno se entera de que para Ana es un
«Pendiente».

Lo demás que se fija aquí:

  - una etiqueta es de su dueño y sólo él puede leerla, renombrarla y borrarla;
  - no se puede etiquetar una conversación de la que no se es miembro (si se
    pudiera, probar identificadores al azar diría cuáles existen);
  - asignar dos veces es idempotente, y lo garantiza la clave primaria;
  - borrar una etiqueta NO borra la conversación ni sus mensajes;
  - filtrar por etiqueta ocurre en el SERVIDOR y respeta la paginación.

La degradación sin la 0045 tiene su propio fichero:
`test_etiquetas_sin_migracion_0045.py`.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.etiquetas import (
    ConversationLabel,
    ConversationLabelAssignment,
    condicion_de_etiqueta,
    etiquetas_por_conversacion,
    normalizar,
)
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    Message,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"

#: Ana y Bruno hablan.
CHAT = "cccccccc-0000-0000-0000-000000000001"
#: Carla y Bruno hablan. Ana NO está aquí: es la conversación ajena.
AJENO = "cccccccc-0000-0000-0000-000000000002"
#: Una conversación que no existe en ninguna tabla.
INVENTADO = "cccccccc-0000-0000-0000-0000000000ff"


@pytest_asyncio.fixture
async def entorno():
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

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(Conversation(id=CHAT, kind="direct", created_by=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=BRUNO))
        db.add(Conversation(id=AJENO, kind="direct", created_by=CARLA))
        db.add(ConversationMember(conversation_id=AJENO, user_id=CARLA))
        db.add(ConversationMember(conversation_id=AJENO, user_id=BRUNO))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones, identidad

    app.dependency_overrides.clear()
    await engine.dispose()


async def _crear(http: AsyncClient, nombre: str) -> str:
    respuesta = await http.post(f"{API}/labels", json={"nombre": nombre})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()["id"]


# --------------------------------------------------------------------------- #
# 1. Una etiqueta es de quien la crea
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_etiqueta_se_crea_con_el_dueno_del_token(entorno):
    """El dueño sale del JWT. Si viniera del cuerpo, cualquiera podría meterle
    un chip en la bandeja a otra persona."""
    http, sesiones, _ = entorno
    label_id = await _crear(http, "Seguimiento")

    async with sesiones() as db:
        dueno = (
            await db.execute(
                select(ConversationLabel.owner_id).where(ConversationLabel.id == label_id)
            )
        ).scalar_one()
    assert dueno == ANA


@pytest.mark.asyncio
async def test_solo_salen_las_etiquetas_propias(entorno):
    http, _, identidad = entorno
    await _crear(http, "Interesado")

    identidad["uid"] = BRUNO
    await _crear(http, "Alumnos")
    mias = await http.get(f"{API}/labels")
    assert [e["nombre"] for e in mias.json()] == ["Alumnos"]

    identidad["uid"] = ANA
    mias = await http.get(f"{API}/labels")
    assert [e["nombre"] for e in mias.json()] == ["Interesado"]


@pytest.mark.asyncio
async def test_el_mismo_nombre_lo_pueden_usar_dos_personas(entorno):
    """La unicidad es POR DUEÑO. Reservar nombres entre desconocidos, además de
    absurdo, filtraría por el error de duplicado que alguien ya usa ese nombre."""
    http, _, identidad = entorno
    await _crear(http, "Alumnos")
    identidad["uid"] = BRUNO
    await _crear(http, "Alumnos")


@pytest.mark.asyncio
async def test_no_se_puede_repetir_el_nombre_ni_cambiando_mayusculas_o_espacios(entorno):
    http, _, _ = entorno
    await _crear(http, "Seguimiento")

    repetida = await http.post(f"{API}/labels", json={"nombre": "  seguimiento "})
    assert repetida.status_code == 409
    assert repetida.json()["error"]["code"] == "conversation_label_duplicada"


@pytest.mark.asyncio
async def test_el_nombre_se_guarda_como_se_escribio_y_normalizado_aparte(entorno):
    """Se pinta lo que escribió su dueño; lo normalizado sólo decide unicidad."""
    http, sesiones, _ = entorno
    label_id = await _crear(http, "  Nuevo   contacto  ")

    async with sesiones() as db:
        fila = (
            await db.execute(
                select(
                    ConversationLabel.nombre, ConversationLabel.nombre_normalizado
                ).where(ConversationLabel.id == label_id)
            )
        ).one()
    assert fila[0] == "Nuevo contacto"
    assert fila[1] == "nuevo contacto"
    assert normalizar("NUEVO   Contacto") == fila[1]


@pytest.mark.asyncio
async def test_un_nombre_de_solo_espacios_no_pasa(entorno):
    http, _, _ = entorno
    respuesta = await http.post(f"{API}/labels", json={"nombre": "   "})
    assert respuesta.status_code == 422


# --------------------------------------------------------------------------- #
# 2. LA PRUEBA CENTRAL: el otro participante no se entera
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_bruno_no_ve_la_etiqueta_que_ana_le_puso(entorno):
    """El requisito entero, dicho de una vez.

    Ana etiqueta su conversación con Bruno como «Interesado». Bruno pregunta por
    todo lo que puede preguntar y en ninguna respuesta aparece esa palabra.
    """
    http, _, identidad = entorno
    label_id = await _crear(http, "Interesado")
    asignada = await http.put(f"{API}/{CHAT}/labels/{label_id}")
    assert asignada.status_code == 204
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})

    identidad["uid"] = BRUNO

    # a) Su lista de etiquetas está vacía: la de Ana no es suya.
    assert (await http.get(f"{API}/labels")).json() == []

    # b) Las etiquetas de ESA conversación, para él, son ninguna. Es miembro y
    #    aun así no ve nada: no existen «las etiquetas de la conversación».
    suyas = await http.get(f"{API}/{CHAT}/labels")
    assert suyas.status_code == 200
    assert suyas.json() == []

    # c) Y el texto no aparece en la respuesta CRUDA de nada que pueda pedir.
    #    Esto es lo que seguirá protegiendo el día que alguien junte las
    #    etiquetas con la fila de la bandeja sin filtrar por dueño.
    for ruta in (API, f"{API}/{CHAT}/messages", f"{API}/{CHAT}/labels"):
        respuesta = await http.get(ruta)
        assert respuesta.status_code == 200, ruta
        assert "Interesado" not in respuesta.text, ruta
        assert label_id not in respuesta.text, ruta


@pytest.mark.asyncio
async def test_bruno_no_puede_leer_renombrar_ni_usar_la_etiqueta_de_ana(entorno):
    """Y los cuatro caminos responden lo mismo que si no existiera."""
    http, sesiones, identidad = entorno
    label_id = await _crear(http, "Interesado")

    identidad["uid"] = BRUNO

    # Renombrarla: 404, no 403. Un 403 confirmaría que ese id es de alguien.
    renombrar = await http.patch(f"{API}/labels/{label_id}", json={"nombre": "Suya"})
    assert renombrar.status_code == 404

    # Asignársela a la conversación que SÍ comparten: 404 por la etiqueta.
    asignar = await http.put(f"{API}/{CHAT}/labels/{label_id}")
    assert asignar.status_code == 404

    # Borrarla: 204 (es idempotente) pero NO la borra.
    borrar = await http.delete(f"{API}/labels/{label_id}")
    assert borrar.status_code == 204

    async with sesiones() as db:
        sigue = (
            await db.execute(
                select(func.count(ConversationLabel.id)).where(
                    ConversationLabel.id == label_id
                )
            )
        ).scalar_one()
    assert sigue == 1, "La etiqueta de Ana no la puede borrar Bruno."

    identidad["uid"] = ANA
    assert [e["nombre"] for e in (await http.get(f"{API}/labels")).json()] == [
        "Interesado"
    ]


@pytest.mark.asyncio
async def test_una_etiqueta_inexistente_y_una_ajena_responden_igual(entorno):
    """Si se distinguieran, probar identificadores diría cuáles existen."""
    http, _, identidad = entorno
    ajena = await _crear(http, "Interesado")
    inexistente = "11111111-2222-3333-4444-555555555555"

    identidad["uid"] = BRUNO
    a = await http.patch(f"{API}/labels/{ajena}", json={"nombre": "x"})
    b = await http.patch(f"{API}/labels/{inexistente}", json={"nombre": "x"})
    assert a.status_code == b.status_code == 404
    assert a.json() == b.json()


@pytest.mark.asyncio
async def test_la_funcion_por_lotes_solo_devuelve_lo_propio(entorno):
    """`etiquetas_por_conversacion` es lo que consumirá la bandeja. El filtro
    por dueño vive AHÍ dentro, para que quien la use no pueda olvidárselo."""
    http, sesiones, identidad = entorno
    de_ana = await _crear(http, "Interesado")
    await http.put(f"{API}/{CHAT}/labels/{de_ana}")

    identidad["uid"] = BRUNO
    de_bruno = await _crear(http, "Clientes")
    await http.put(f"{API}/{CHAT}/labels/{de_bruno}")

    async with sesiones() as db:
        para_ana = await etiquetas_por_conversacion(
            db, uid=ANA, conversation_ids=[CHAT, AJENO]
        )
        para_bruno = await etiquetas_por_conversacion(
            db, uid=BRUNO, conversation_ids=[CHAT, AJENO]
        )

    assert [e.nombre for e in para_ana[CHAT]] == ["Interesado"]
    assert [e.nombre for e in para_bruno[CHAT]] == ["Clientes"]
    # La conversación sin etiquetar no aparece: la bandeja pinta cero chips.
    assert AJENO not in para_ana


@pytest.mark.asyncio
async def test_la_funcion_por_lotes_con_la_lista_vacia_no_toca_la_base(entorno):
    """El retorno temprano evita un `in_([])`, que es lo que en este proyecto
    acaba escrito como `in_(lista or [""])` y asyncpg rechaza."""
    _, sesiones, _ = entorno
    async with sesiones() as db:
        assert await etiquetas_por_conversacion(db, uid=ANA, conversation_ids=[]) == {}


# --------------------------------------------------------------------------- #
# 3. Pertenecer a la conversación
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_puede_etiquetar_una_conversacion_ajena(entorno):
    http, sesiones, _ = entorno
    label_id = await _crear(http, "Interesado")

    respuesta = await http.put(f"{API}/{AJENO}/labels/{label_id}")
    assert respuesta.status_code == 403

    async with sesiones() as db:
        cuantas = (
            await db.execute(select(func.count(ConversationLabelAssignment.label_id)))
        ).scalar_one()
    assert cuantas == 0


@pytest.mark.asyncio
async def test_una_conversacion_ajena_y_una_inventada_responden_igual(entorno):
    """Si no respondieran lo mismo, la respuesta diría qué conversaciones
    existen sin necesidad de poder leer ninguna."""
    http, _, _ = entorno
    label_id = await _crear(http, "Interesado")

    ajena = await http.put(f"{API}/{AJENO}/labels/{label_id}")
    inventada = await http.put(f"{API}/{INVENTADO}/labels/{label_id}")
    assert ajena.status_code == inventada.status_code == 403
    assert ajena.json() == inventada.json()


@pytest.mark.asyncio
async def test_la_conversacion_se_comprueba_antes_que_la_etiqueta(entorno):
    """Al revés, un 404 de etiqueta contra una conversación ajena ya diría que
    la conversación estaba bien."""
    http, _, _ = entorno
    inexistente = "11111111-2222-3333-4444-555555555555"
    respuesta = await http.put(f"{API}/{AJENO}/labels/{inexistente}")
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_leer_las_etiquetas_de_una_conversacion_ajena_no_se_puede(entorno):
    http, _, _ = entorno
    assert (await http.get(f"{API}/{AJENO}/labels")).status_code == 403


# --------------------------------------------------------------------------- #
# 4. Asignar es idempotente
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_asignar_dos_veces_deja_una_sola_fila(entorno):
    """Lo garantiza la clave primaria compuesta, no un `if`: un `select` antes
    del `insert` deja siempre una ventana entre los dos."""
    http, sesiones, _ = entorno
    label_id = await _crear(http, "Seguimiento")

    for _ in range(3):
        assert (await http.put(f"{API}/{CHAT}/labels/{label_id}")).status_code == 204

    async with sesiones() as db:
        cuantas = (
            await db.execute(
                select(func.count()).select_from(ConversationLabelAssignment)
            )
        ).scalar_one()
    assert cuantas == 1

    # Y la cuenta que ve la persona tampoco se infla.
    etiquetas = (await http.get(f"{API}/labels")).json()
    assert etiquetas[0]["conversaciones"] == 1


@pytest.mark.asyncio
async def test_asignar_dos_veces_conserva_la_fecha_de_la_primera(entorno):
    """`on conflict do nothing`, no `do update`: la segunda vez no reescribe
    nada. Si la fecha se moviera, el orden de la bandeja cambiaría por un toque
    que no cambió nada."""
    http, sesiones, _ = entorno
    label_id = await _crear(http, "Seguimiento")
    await http.put(f"{API}/{CHAT}/labels/{label_id}")

    async with sesiones() as db:
        primera = (
            await db.execute(select(ConversationLabelAssignment.created_at))
        ).scalar_one()

    await http.put(f"{API}/{CHAT}/labels/{label_id}")

    async with sesiones() as db:
        segunda = (
            await db.execute(select(ConversationLabelAssignment.created_at))
        ).scalar_one()
    assert primera == segunda


@pytest.mark.asyncio
async def test_quitar_una_etiqueta_que_no_estaba_no_es_un_error(entorno):
    http, _, _ = entorno
    label_id = await _crear(http, "Seguimiento")
    assert (await http.delete(f"{API}/{CHAT}/labels/{label_id}")).status_code == 204
    assert (await http.delete(f"{API}/{CHAT}/labels/{label_id}")).status_code == 204


@pytest.mark.asyncio
async def test_asignar_y_quitar_es_reversible(entorno):
    http, _, _ = entorno
    label_id = await _crear(http, "Seguimiento")

    await http.put(f"{API}/{CHAT}/labels/{label_id}")
    assert [e["id"] for e in (await http.get(f"{API}/{CHAT}/labels")).json()] == [
        label_id
    ]

    await http.delete(f"{API}/{CHAT}/labels/{label_id}")
    assert (await http.get(f"{API}/{CHAT}/labels")).json() == []


# --------------------------------------------------------------------------- #
# 5. Renombrar y borrar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_renombrar_no_mueve_las_conversaciones(entorno):
    """Lo que cambia es la palabra, no la clasificación."""
    http, _, _ = entorno
    label_id = await _crear(http, "Interesado")
    await http.put(f"{API}/{CHAT}/labels/{label_id}")

    respuesta = await http.patch(f"{API}/labels/{label_id}", json={"nombre": "Interesados"})
    assert respuesta.status_code == 200
    assert respuesta.json()["nombre"] == "Interesados"
    assert respuesta.json()["conversaciones"] == 1

    assert [e["nombre"] for e in (await http.get(f"{API}/{CHAT}/labels")).json()] == [
        "Interesados"
    ]


@pytest.mark.asyncio
async def test_renombrar_a_un_nombre_que_ya_se_usa_choca(entorno):
    http, _, _ = entorno
    await _crear(http, "Alumnos")
    otra = await _crear(http, "Interesado")

    respuesta = await http.patch(f"{API}/labels/{otra}", json={"nombre": "alumnos"})
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "conversation_label_duplicada"


@pytest.mark.asyncio
async def test_borrar_una_etiqueta_no_borra_la_conversacion_ni_sus_mensajes(entorno):
    """Quitar una carpeta no quita lo que había dentro. Es lo que más miedo da
    al pulsarlo, así que es lo que hay que dejar clavado."""
    http, sesiones, _ = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    await http.post(f"{API}/{CHAT}/messages", json={"body": "que tal"})
    label_id = await _crear(http, "Seguimiento")
    await http.put(f"{API}/{CHAT}/labels/{label_id}")

    assert (await http.delete(f"{API}/labels/{label_id}")).status_code == 204

    async with sesiones() as db:
        conversaciones = (
            await db.execute(select(func.count()).select_from(Conversation))
        ).scalar_one()
        mensajes = (
            await db.execute(
                select(func.count()).select_from(Message).where(
                    Message.conversation_id == CHAT
                )
            )
        ).scalar_one()
        miembros = (
            await db.execute(
                select(func.count()).select_from(ConversationMember).where(
                    ConversationMember.conversation_id == CHAT
                )
            )
        ).scalar_one()
        asignaciones = (
            await db.execute(
                select(func.count()).select_from(ConversationLabelAssignment)
            )
        ).scalar_one()

    assert conversaciones == 2
    assert mensajes == 2
    assert miembros == 2
    # Las asignaciones sí se van, por el `cascade`: son de la etiqueta.
    assert asignaciones == 0

    historial = await http.get(f"{API}/{CHAT}/messages")
    # Se compara el CONJUNTO y no el orden: el `now()` de SQLite tiene
    # resolucion de segundo, asi que dos mensajes enviados seguidos comparten
    # marca y cual va primero lo decide el desempate por id, que es aleatorio.
    # Es un artefacto del motor de pruebas —en PostgreSQL cada insercion trae
    # microsegundos— y aqui ademas daria igual: lo que hay que demostrar es que
    # los dos mensajes SIGUEN AHI despues de borrar la etiqueta, no en que orden.
    assert sorted(m["body"] for m in historial.json()) == ["hola", "que tal"]


@pytest.mark.asyncio
async def test_borrar_dos_veces_responde_igual(entorno):
    http, _, _ = entorno
    label_id = await _crear(http, "Seguimiento")
    assert (await http.delete(f"{API}/labels/{label_id}")).status_code == 204
    assert (await http.delete(f"{API}/labels/{label_id}")).status_code == 204
    assert (await http.get(f"{API}/labels")).json() == []


@pytest.mark.asyncio
async def test_una_etiqueta_recien_creada_sale_con_cero(entorno):
    """`outer join`: una etiqueta sin asignar tiene que salir, no desaparecer."""
    http, _, _ = entorno
    await _crear(http, "Pendiente")
    etiquetas = (await http.get(f"{API}/labels")).json()
    assert etiquetas == [
        {"id": etiquetas[0]["id"], "nombre": "Pendiente", "conversaciones": 0}
    ]


@pytest.mark.asyncio
async def test_hay_un_tope_de_etiquetas_y_lo_dice(entorno):
    """Cincuenta es lo que permite devolver la lista entera sin paginar los
    chips. Al llegar, el mensaje dice qué hacer en vez de sólo negarse."""
    from app.modules.messaging.etiquetas import MAX_ETIQUETAS

    http, sesiones, _ = entorno
    async with sesiones() as db:
        for i in range(MAX_ETIQUETAS):
            db.add(
                ConversationLabel(
                    owner_id=ANA, nombre=f"E{i}", nombre_normalizado=f"e{i}"
                )
            )
        await db.commit()

    respuesta = await http.post(f"{API}/labels", json={"nombre": "Una mas"})
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "conversation_labels_max"


# --------------------------------------------------------------------------- #
# 6. Filtrar por etiqueta: en el servidor y con paginación
# --------------------------------------------------------------------------- #
#
# El endpoint del listado lo modifica otro agente; lo que se prueba aquí es la
# pieza que consumirá, montada en la MISMA forma de consulta que tiene el
# listado (join con `conversation_members`, orden y `limit`/`offset`). Si esta
# condición dejara de filtrar en la base, la paginación empezaría a devolver
# páginas medio vacías y un «hay más» que miente.


def _consulta_de_bandeja(uid: str, condicion=None):
    """La consulta del listado, tal y como la arma `list_conversations`."""
    consulta = (
        select(Conversation.id)
        .join(
            ConversationMember, ConversationMember.conversation_id == Conversation.id
        )
        .where(
            ConversationMember.user_id == uid,
            or_(
                Conversation.kind != "direct",
                select(Message.id)
                .where(
                    Message.conversation_id == Conversation.id,
                    Message.deleted_at.is_(None),
                )
                .exists(),
            ),
        )
    )
    if condicion is not None:
        consulta = consulta.where(condicion)
    return consulta.order_by(Conversation.created_at.asc(), Conversation.id.asc())


@pytest_asyncio.fixture
async def bandeja_grande(entorno):
    """Ana con ocho grupos: cinco etiquetados y tres sin etiquetar."""
    http, sesiones, identidad = entorno
    label_id = await _crear(http, "Seguimiento")

    etiquetadas: list[str] = []
    async with sesiones() as db:
        for i in range(8):
            conv = f"dddddddd-0000-0000-0000-{i:012d}"
            db.add(Conversation(id=conv, kind="group", title=f"G{i}", created_by=ANA))
            db.add(ConversationMember(conversation_id=conv, user_id=ANA))
            if i % 2 == 0 and len(etiquetadas) < 5:
                etiquetadas.append(conv)
        await db.commit()
    # Cinco: los pares son cuatro, así que se etiqueta uno impar más para que el
    # número no cuadre con ninguna página entera y la paginación tenga que
    # partir de verdad.
    etiquetadas.append("dddddddd-0000-0000-0000-000000000001")

    for conv in etiquetadas:
        assert (await http.put(f"{API}/{conv}/labels/{label_id}")).status_code == 204

    return http, sesiones, identidad, label_id, sorted(etiquetadas)


@pytest.mark.asyncio
async def test_el_filtro_por_etiqueta_lo_hace_la_base_y_no_python(bandeja_grande):
    _, sesiones, _, label_id, etiquetadas = bandeja_grande
    async with sesiones() as db:
        condicion = await condicion_de_etiqueta(db, uid=ANA, label_id=label_id)
        filas = (await db.execute(_consulta_de_bandeja(ANA, condicion))).scalars().all()
    assert sorted(filas) == etiquetadas
    assert len(filas) == 5


@pytest.mark.asyncio
async def test_el_filtro_por_etiqueta_pagina(bandeja_grande):
    """Las páginas cuentan las filas que de verdad quedan, no las que había
    antes de filtrar: sin esto llegarían páginas de dos elementos y un «hay
    más» que miente."""
    _, sesiones, _, label_id, etiquetadas = bandeja_grande
    async with sesiones() as db:
        condicion = await condicion_de_etiqueta(db, uid=ANA, label_id=label_id)
        consulta = _consulta_de_bandeja(ANA, condicion)
        paginas = []
        for offset in (0, 2, 4):
            paginas.append(
                (await db.execute(consulta.limit(2).offset(offset))).scalars().all()
            )

    assert [len(p) for p in paginas] == [2, 2, 1]
    assert sorted([c for pagina in paginas for c in pagina]) == etiquetadas
    # Ninguna fila repetida entre páginas.
    todas = [c for pagina in paginas for c in pagina]
    assert len(todas) == len(set(todas))


@pytest.mark.asyncio
async def test_sin_filtro_salen_todas(bandeja_grande):
    """La condición no puede esconder nada cuando no se pide filtrar."""
    _, sesiones, _, _, _ = bandeja_grande
    async with sesiones() as db:
        filas = (await db.execute(_consulta_de_bandeja(ANA))).scalars().all()
    assert len(filas) == 8


@pytest.mark.asyncio
async def test_filtrar_por_la_etiqueta_de_otro_no_devuelve_nada(bandeja_grande):
    """Y no un error: no puede servir para averiguar qué etiquetas existen."""
    _, sesiones, _, label_id, _ = bandeja_grande
    async with sesiones() as db:
        condicion = await condicion_de_etiqueta(db, uid=BRUNO, label_id=label_id)
        filas = (
            await db.execute(_consulta_de_bandeja(BRUNO, condicion))
        ).scalars().all()
    assert filas == []


@pytest.mark.asyncio
async def test_filtrar_por_una_etiqueta_inexistente_o_con_basura_no_revienta(entorno):
    """Un identificador con otro formato llegaría hasta el driver y asyncpg lo
    convertiría en un 500. Aquí es simplemente «no hay nada así»."""
    _, sesiones, _ = entorno
    async with sesiones() as db:
        for label_id in ("11111111-2222-3333-4444-555555555555", "no-es-un-uuid", ""):
            condicion = await condicion_de_etiqueta(db, uid=ANA, label_id=label_id)
            filas = (
                await db.execute(_consulta_de_bandeja(ANA, condicion))
            ).scalars().all()
            assert filas == [], label_id
