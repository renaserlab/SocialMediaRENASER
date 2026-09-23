"""El temario editado por la API: permisos, rastro, idempotencia y conflicto.

EL DEFECTO QUE MOTIVA ESTE FICHERO. El editor del movil escribia
`course_modules` y `course_lessons` DIRECTAMENTE contra PostgREST, porque la API
no ofrecia otro camino. La RLS decidia quien podia escribir, asi que no era un
agujero de permisos; era un agujero de RASTRO: un autor reescribia el temario de
un curso ya vendido y no quedaba ni una linea diciendo que habia pasado.
`test_versionado_de_cursos` ya lo dejo escrito con todas las letras —«no hay
forma de saber que contenido se vendio»—; aqui se cierra por el lado del
servidor.

LAS PRUEBAS QUE MAS VALEN, igual que alli, son las de lo que NO debe pasar:

  * que editar el temario NO cree una version ni toque la vigente;
  * que un doble toque no deje dos modulos;
  * que guardar sobre un curso que cambio por debajo se rechace CON los dos
    numeros de version, en vez de pisar el trabajo de otra persona;
  * que reordenar a medias no cuele.

SQLite en memoria, igual que el resto de la suite. Nada de esto llega a Supabase.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog import esquema as esquema_de_catalogo
from app.modules.catalog.models import Course, CourseVersion
from app.modules.gobernanza import esquema as esquema_gobernanza
from app.modules.gobernanza.models import AuditEvent
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.profiles.models import Profile
from app.modules.recommendations.models import CourseTopic, Topic
from app.shared.database import Base, get_db

#: La 0034 SE IMPORTA, no se copia. Ya esta escrita dos veces —el script de
#: Supabase y `test_cursos_v2`, que lo documenta— y una tercera copia se
#: separaria de las otras dos al primer cambio: esta prueba se quedaria verde
#: contra un esquema que no existe en ningun sitio.
from test_cursos_v2 import MIGRACION_0034

CATALOGO = "/api/v1/catalog"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"  # autora del curso
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # no es nadie en este curso
ADMIN = "aaaaaaaa-0000-0000-0000-000000000003"
CURSO = "cccccccc-0000-0000-0000-000000000001"
OTRO_CURSO = "cccccccc-0000-0000-0000-000000000002"

DESCRIPCION = "Una descripcion larga de sobra para pasar el minimo de treinta."


async def _base(con_0034: bool):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        if con_0034:
            for sentencia in MIGRACION_0034:
                await conn.execute(text(sentencia))
    esquema_de_catalogo.olvidar()
    esquema_gobernanza.olvidar()
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _cliente(sesiones, identidad: dict):
    async def _sesion():
        async with sesiones() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _sesion
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest_asyncio.fixture
async def entorno():
    """Un curso de ANA, publicable, en una base SIN la 0034 (produccion de hoy).

    Publicar sin la 0034 pide lo de siempre: titulo, descripcion, un tema, un
    modulo y una leccion. Con la 0034 haria falta ademas pasar por revision, y
    eso es otra prueba: aqui lo que se mide es el temario.
    """
    engine, sesiones = await _base(con_0034=False)
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, username="ana", full_name="Ana"),
                Profile(id=BRUNO, username="bruno", full_name="Bruno"),
                Profile(id=ADMIN, username="admin", full_name="Admin", role="admin"),
            ]
        )
        db.add(
            Course(
                id=CURSO,
                author_id=ANA,
                title="Curso de Ana",
                description=DESCRIPCION,
                price_minor=19900,
                currency="PEN",
                status="draft",
            )
        )
        db.add(
            Course(
                id=OTRO_CURSO,
                author_id=ANA,
                title="Otro curso de Ana",
                description=DESCRIPCION,
                status="draft",
            )
        )
        await db.flush()
        modulo = CourseModule(course_id=CURSO, title="Modulo sembrado", sort_order=0)
        db.add(modulo)
        await db.flush()
        db.add(
            CourseLesson(
                module_id=modulo.id,
                title="Leccion sembrada",
                sort_order=0,
                duration_seconds=600,
            )
        )
        tema = Topic(slug="negocios", name="Negocios")
        db.add(tema)
        await db.flush()
        db.add(CourseTopic(course_id=CURSO, topic_id=tema.id))
        await db.commit()
        sembrado = modulo.id

    identidad = {"uid": ANA}
    http = await _cliente(sesiones, identidad)
    try:
        async with http:
            yield http, sesiones, identidad, sembrado
    finally:
        app.dependency_overrides.clear()
        esquema_gobernanza.olvidar()
        esquema_de_catalogo.olvidar()
        await engine.dispose()


@pytest_asyncio.fixture
async def entorno_v2():
    """Lo mismo, con la 0034 aplicada: hay tipo de leccion y muestra gratuita."""
    engine, sesiones = await _base(con_0034=True)
    async with sesiones() as db:
        db.add(Profile(id=ANA, username="ana", full_name="Ana"))
        db.add(
            Course(
                id=CURSO,
                author_id=ANA,
                title="Curso de Ana",
                description=DESCRIPCION,
                status="draft",
            )
        )
        await db.commit()

    identidad = {"uid": ANA}
    http = await _cliente(sesiones, identidad)
    try:
        async with http:
            yield http, sesiones, identidad
    finally:
        app.dependency_overrides.clear()
        esquema_gobernanza.olvidar()
        esquema_de_catalogo.olvidar()
        await engine.dispose()


async def _publicar(http) -> None:
    respuesta = await http.post(f"{CATALOGO}/courses/{CURSO}/publish")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    # `published: false` tambien es 200: es «te falta esto», no un error. Sin
    # esta comprobacion la prueba mediria un curso que nunca llego a publicarse.
    assert cuerpo["published"] is True, cuerpo.get("missing")


async def _huella_vigente(sesiones) -> str:
    async with sesiones() as db:
        version = await db.scalar(
            select(CourseVersion).where(CourseVersion.status == "published")
        )
        assert version is not None
        return version.content_hash


async def _crear_modulo(http, titulo: str, **kwargs):
    return await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules", json={"title": titulo}, **kwargs
    )


async def _eventos(sesiones, accion: str) -> list[AuditEvent]:
    async with sesiones() as db:
        return list(
            await db.scalars(select(AuditEvent).where(AuditEvent.action == accion))
        )


# --------------------------------------------------------------------------- #
# Lo que edita el temario NO versiona, pero deja rastro
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_editar_el_temario_no_crea_version_ni_toca_la_vigente(entorno) -> None:
    """La regla entera en una prueba.

    Las versiones nacen al PUBLICAR. Si editar creara una, cada correccion de
    una errata inventaria un «cambio de producto» sobre garantias vivas; y si
    ademas reescribiera la vigente, estaria reescribiendo lo que alguien compro
    —cosa que la base rechaza con un disparador, pero que no puede llegar a
    intentarse—.
    """
    http, sesiones, _, _ = entorno
    await _publicar(http)
    async with sesiones() as db:
        antes = await db.scalar(select(CourseVersion))
        vigente_id, huella_antes = antes.id, antes.content_hash

    respuesta = await _crear_modulo(http, "Modulo nuevo")
    assert respuesta.status_code == 201, respuesta.text

    async with sesiones() as db:
        todas = list(await db.scalars(select(CourseVersion)))
        assert len(todas) == 1, "editar el temario no versiona"
        assert todas[0].id == vigente_id
        assert todas[0].content_hash == huella_antes, "la vigente es inmutable"


@pytest.mark.asyncio
async def test_una_edicion_sobre_un_curso_publicado_queda_registrada(entorno) -> None:
    """El agujero que se cierra: sin esto no hay forma de saber que paso.

    La nota dice sobre QUE version se edito y en que estado estaba el curso. Un
    modulo borrado de un curso publicado y uno borrado de un borrador no son el
    mismo hecho.
    """
    http, sesiones, _, _ = entorno
    await _publicar(http)
    respuesta = await _crear_modulo(http, "Modulo nuevo")
    assert respuesta.status_code == 201

    notas = await _eventos(sesiones, "course.module_created")
    assert len(notas) == 1
    nota = notas[0]
    assert nota.entity_id == CURSO
    assert nota.actor_id == ANA
    assert nota.payload["course_status"] == "published"
    assert nota.payload["version"] == 1
    assert nota.payload["module_id"] == respuesta.json()["id"]


@pytest.mark.asyncio
async def test_el_rastro_guarda_los_campos_tocados_y_no_su_contenido(entorno) -> None:
    """`audit_events.payload` se sirve por `GET /admin/audit-events`.

    Archivar ahi el titulo y el cuerpo de las lecciones convertiria la tabla de
    auditoria en una copia del curso. Lo que hace falta es saber QUE se toco.
    """
    http, sesiones, _, sembrado = entorno
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/modules/{sembrado}",
        json={"title": "Titulo reescrito"},
    )
    assert respuesta.status_code == 200, respuesta.text

    nota = (await _eventos(sesiones, "course.module_updated"))[0]
    assert nota.payload["fields"] == ["title"]
    assert "Titulo reescrito" not in str(nota.payload)


@pytest.mark.asyncio
async def test_un_patch_vacio_no_ensucia_el_rastro(entorno) -> None:
    """Un PATCH sin cambios no es una edicion.

    Anotarlo llenaria de ruido justo la tabla que hay que poder leer cuando algo
    pasa: el editor del movil manda un PATCH por cada pulsacion que sale del
    campo, tocara algo o no.
    """
    http, sesiones, _, sembrado = entorno
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/modules/{sembrado}", json={}
    )
    assert respuesta.status_code == 200, respuesta.text
    assert await _eventos(sesiones, "course.module_updated") == []


# --------------------------------------------------------------------------- #
# Permisos: los mismos que ya decidian sobre el curso
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_no_es_el_autor_no_toca_el_temario(entorno) -> None:
    """La app puede esconder el boton; lo que lo impide es esto.

    Sin la comprobacion, abrir la escritura del temario dejaria a cualquiera
    reescribir el curso de otra persona llamando a la URL a mano.
    """
    http, sesiones, identidad, sembrado = entorno
    identidad["uid"] = BRUNO

    assert (await _crear_modulo(http, "Colado")).status_code == 403
    borrado = await http.delete(f"{CATALOGO}/courses/{CURSO}/modules/{sembrado}")
    assert borrado.status_code == 403

    async with sesiones() as db:
        assert await db.get(CourseModule, sembrado) is not None


@pytest.mark.asyncio
async def test_la_administracion_si_puede_moderar_el_temario(entorno) -> None:
    """El paso franco de administracion, que es el otro lado de la misma regla."""
    http, _, identidad, _ = entorno
    identidad["uid"] = ADMIN
    assert (await _crear_modulo(http, "Moderado")).status_code == 201


@pytest.mark.asyncio
async def test_un_modulo_de_otro_curso_no_se_edita_por_la_url(entorno) -> None:
    """El permiso se valido sobre el curso de la RUTA, no sobre el del modulo.

    Comprobar solo que el modulo existe dejaria editar el temario de un curso
    ajeno colando su id: basta con ser autor de CUALQUIER curso.
    """
    http, sesiones, _, _ = entorno
    async with sesiones() as db:
        ajeno = CourseModule(course_id=OTRO_CURSO, title="Del otro curso", sort_order=0)
        db.add(ajeno)
        await db.commit()
        ajeno_id = ajeno.id

    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/modules/{ajeno_id}", json={"title": "Robado"}
    )
    assert respuesta.status_code == 404
    async with sesiones() as db:
        assert (await db.get(CourseModule, ajeno_id)).title == "Del otro curso"


# --------------------------------------------------------------------------- #
# Idempotencia
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_doble_toque_con_la_misma_clave_no_crea_dos_modulos(entorno) -> None:
    """Dos pulsaciones seguidas sobre «Anadir modulo» dejan UN modulo.

    Es el fallo mas comun del editor: la primera respuesta tarda, quien lo usa
    vuelve a pulsar, y el temario acaba con dos bloques vacios llamados igual.
    """
    http, sesiones, _, _ = entorno
    cabeceras = {"Idempotency-Key": "toque-1"}

    primera = await _crear_modulo(http, "Modulo nuevo", headers=cabeceras)
    segunda = await _crear_modulo(http, "Modulo nuevo", headers=cabeceras)

    assert primera.status_code == 201
    assert segunda.status_code == 201
    assert primera.json()["id"] == segunda.json()["id"]

    async with sesiones() as db:
        modulos = list(
            await db.scalars(
                select(CourseModule).where(CourseModule.course_id == CURSO)
            )
        )
        assert len(modulos) == 2, "el sembrado y UNO nuevo"


@pytest.mark.asyncio
async def test_dos_claves_distintas_crean_dos_modulos(entorno) -> None:
    """La otra mitad: la idempotencia no puede tragarse una creacion legitima.

    Sin esta prueba, derivar el id de algo que no incluya la clave —del curso a
    secas, por ejemplo— pasaria la de arriba y dejaria al autor sin poder anadir
    un segundo modulo.
    """
    http, sesiones, _, _ = entorno
    await _crear_modulo(http, "Uno", headers={"Idempotency-Key": "a"})
    await _crear_modulo(http, "Dos", headers={"Idempotency-Key": "b"})

    async with sesiones() as db:
        modulos = list(
            await db.scalars(
                select(CourseModule).where(CourseModule.course_id == CURSO)
            )
        )
        assert len(modulos) == 3


@pytest.mark.asyncio
async def test_sin_clave_de_idempotencia_se_crea_igual(entorno) -> None:
    """La cabecera es OPCIONAL: exigirla romperia a los clientes instalados."""
    http, _, _, _ = entorno
    assert (await _crear_modulo(http, "Sin clave")).status_code == 201
    assert (await _crear_modulo(http, "Sin clave")).status_code == 201


@pytest.mark.asyncio
async def test_la_clave_primaria_es_lo_que_sostiene_la_idempotencia(entorno) -> None:
    """La invariante, comprobada DONDE de verdad se sostiene: en la base.

    POR QUE NO SE LANZAN DOS PETICIONES A LA VEZ. Porque aqui no probaria nada:
    SQLite en memoria comparte UNA conexion entre todas las sesiones, asi que
    dos peticiones «simultaneas» se serializan y el verde no diria nada sobre
    PostgreSQL. Es el mismo razonamiento que
    `test_la_base_impide_dos_versiones_vigentes_del_mismo_curso`.

    Lo que si se comprueba es lo importante: el id se DERIVA de la clave, asi
    que la segunda insercion choca contra la clave primaria. Un «mira si existe
    y si no inserta» lo pasan dos peticiones; esto no.
    """
    from sqlalchemy.exc import IntegrityError

    from app.modules.catalog import contenido

    http, sesiones, _, _ = entorno
    respuesta = await _crear_modulo(
        http, "Modulo nuevo", headers={"Idempotency-Key": "k"}
    )
    assert respuesta.json()["id"] == contenido.id_idempotente(CURSO, ANA, "k")

    async with sesiones() as db:
        db.add(
            CourseModule(
                id=contenido.id_idempotente(CURSO, ANA, "k"),
                course_id=CURSO,
                title="colado por la puerta de atras",
                sort_order=99,
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()


# --------------------------------------------------------------------------- #
# If-Match: nadie guarda encima de lo que otro cambio
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_guardar_con_una_version_vieja_responde_409_con_las_dos(entorno) -> None:
    """«Se me borro lo que acababa de escribir», convertido en un error legible.

    Dos personas con permiso sobre el mismo curso —el autor y quien modera— con
    el editor abierto: el segundo en guardar tiene que enterarse de que lo suyo
    esta calculado sobre un curso que ya no existe, y con QUE version, para
    poder recargar.
    """
    http, sesiones, _, _ = entorno
    await _publicar(http)
    vieja = await _huella_vigente(sesiones)

    # Alguien cambia el curso y lo vuelve a publicar: nace la version 2.
    await http.patch(f"{CATALOGO}/courses/{CURSO}", json={"title": "Otro titulo"})
    await _publicar(http)

    respuesta = await _crear_modulo(http, "Tarde", headers={"If-Match": vieja})
    assert respuesta.status_code == 409, respuesta.text
    error = respuesta.json()["error"]
    assert error["code"] == "course_version_mismatch"
    assert error["details"]["expected"] == vieja
    assert error["details"]["current"]["version"] == 2
    assert error["details"]["current"]["content_hash"] != vieja

    async with sesiones() as db:
        modulos = list(
            await db.scalars(
                select(CourseModule).where(CourseModule.course_id == CURSO)
            )
        )
        assert len(modulos) == 1, "el rechazado no se escribio a medias"


@pytest.mark.asyncio
async def test_con_la_version_vigente_se_guarda(entorno) -> None:
    """Y con comillas tambien: un ETag estandar viaja entrecomillado.

    Compararlas con la huella pelada daria un 409 en la primera peticion
    correcta de cualquier cliente que use la cabecera como manda HTTP.
    """
    http, sesiones, _, _ = entorno
    await _publicar(http)
    vigente = await _huella_vigente(sesiones)

    assert (
        await _crear_modulo(http, "A tiempo", headers={"If-Match": vigente})
    ).status_code == 201
    assert (
        await _crear_modulo(http, "Con comillas", headers={"If-Match": f'"{vigente}"'})
    ).status_code == 201


@pytest.mark.asyncio
async def test_sin_if_match_no_se_comprueba_nada(entorno) -> None:
    """La garantia es opcional a proposito: obligarla romperia a los instalados."""
    http, _, _, _ = entorno
    await _publicar(http)
    assert (await _crear_modulo(http, "Sin cabecera")).status_code == 201


@pytest.mark.asyncio
async def test_un_curso_sin_version_lo_dice_en_vez_de_callarselo(entorno) -> None:
    """`current: null` es una respuesta, no un hueco: no hay nada que casar."""
    http, _, _, _ = entorno
    respuesta = await _crear_modulo(
        http, "Sobre un borrador", headers={"If-Match": "x"}
    )
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["details"]["current"] is None


# --------------------------------------------------------------------------- #
# El orden
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_crear_anade_al_final_y_no_empata_el_orden(entorno) -> None:
    """Dos elementos con el mismo `sort_order` son un temario sin orden.

    El alumno ve las lecciones bailar entre dos cargas de la misma pantalla,
    porque quien decide entonces es como devuelva las filas la base.
    """
    http, _, _, _ = entorno
    posiciones = [
        (await _crear_modulo(http, f"Modulo {i}")).json()["sort_order"]
        for i in range(3)
    ]
    assert posiciones == [1, 2, 3], "detras del sembrado, que ocupa el 0"


@pytest.mark.asyncio
async def test_reordenar_deja_exactamente_el_orden_pedido(entorno) -> None:
    http, sesiones, _, sembrado = entorno
    segundo = (await _crear_modulo(http, "Segundo")).json()["id"]
    tercero = (await _crear_modulo(http, "Tercero")).json()["id"]

    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules/reorder",
        json={"ids": [tercero, sembrado, segundo]},
    )
    assert respuesta.status_code == 200, respuesta.text
    assert [m["id"] for m in respuesta.json()] == [tercero, sembrado, segundo]

    async with sesiones() as db:
        orden = {
            m.id: m.sort_order
            for m in await db.scalars(
                select(CourseModule).where(CourseModule.course_id == CURSO)
            )
        }
        assert orden == {tercero: 0, sembrado: 1, segundo: 2}


@pytest.mark.asyncio
async def test_reordenar_a_medias_no_cuela_y_no_escribe_nada(entorno) -> None:
    """Una reordenacion parcial no es «casi el orden pedido».

    Los que no viajan se quedan con su numero anterior y empatan con los nuevos:
    el resultado es un orden que no pidio nadie. Y se rechaza ANTES de escribir,
    porque aceptar la mitad dejaria el temario a medio ordenar.
    """
    http, sesiones, _, sembrado = entorno
    segundo = (await _crear_modulo(http, "Segundo")).json()["id"]

    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules/reorder", json={"ids": [segundo]}
    )
    assert respuesta.status_code == 422, respuesta.text
    assert respuesta.json()["error"]["code"] == "course_order_invalid"

    async with sesiones() as db:
        orden = {
            m.id: m.sort_order
            for m in await db.scalars(
                select(CourseModule).where(CourseModule.course_id == CURSO)
            )
        }
        assert orden == {sembrado: 0, segundo: 1}, "nadie se movio"


@pytest.mark.asyncio
async def test_reordenar_con_un_intruso_se_rechaza(entorno) -> None:
    """Un id de otro curso en la lista no puede colarse a reordenar aqui."""
    http, sesiones, _, sembrado = entorno
    async with sesiones() as db:
        ajeno = CourseModule(course_id=OTRO_CURSO, title="Del otro", sort_order=0)
        db.add(ajeno)
        await db.commit()
        ajeno_id = ajeno.id

    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules/reorder",
        json={"ids": [sembrado, ajeno_id]},
    )
    assert respuesta.status_code == 422


# --------------------------------------------------------------------------- #
# Borrar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_borrar_un_modulo_se_lleva_sus_lecciones_y_dice_cuantas(entorno) -> None:
    """«Se borro un modulo» y «se borraron un modulo y dos lecciones de un curso
    publicado» no son el mismo hecho, y el segundo es el que alguien va a querer
    reconstruir dentro de seis meses.
    """
    http, sesiones, _, sembrado = entorno
    await _publicar(http)
    await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules/{sembrado}/lessons",
        json={"title": "Segunda leccion"},
    )

    respuesta = await http.delete(f"{CATALOGO}/courses/{CURSO}/modules/{sembrado}")
    assert respuesta.status_code == 204, respuesta.text

    async with sesiones() as db:
        assert await db.get(CourseModule, sembrado) is None
        huerfanas = list(
            await db.scalars(
                select(CourseLesson).where(CourseLesson.module_id == sembrado)
            )
        )
        assert huerfanas == [], "las lecciones se van con su modulo"

    nota = (await _eventos(sesiones, "course.module_deleted"))[0]
    assert nota.payload["lessons"] == 2
    assert nota.payload["course_status"] == "published"


@pytest.mark.asyncio
async def test_borrar_una_leccion_de_otro_modulo_no_se_puede(entorno) -> None:
    http, sesiones, _, sembrado = entorno
    otro = (await _crear_modulo(http, "Otro modulo")).json()["id"]
    async with sesiones() as db:
        leccion = await db.scalar(
            select(CourseLesson).where(CourseLesson.module_id == sembrado)
        )
        leccion_id = leccion.id

    respuesta = await http.delete(
        f"{CATALOGO}/courses/{CURSO}/modules/{otro}/lessons/{leccion_id}"
    )
    assert respuesta.status_code == 404
    async with sesiones() as db:
        assert await db.get(CourseLesson, leccion_id) is not None


# --------------------------------------------------------------------------- #
# Lecciones y la ficha de la 0034
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_una_leccion_guarda_su_tipo_y_su_muestra(entorno_v2) -> None:
    """`kind` e `is_preview` NO estan en el ORM y se escriben aparte.

    `is_preview` decide QUE SE VE SIN PAGAR: si se perdiera en silencio, una
    leccion pensada como muestra quedaria cerrada —o al reves, y el curso se
    veria entero sin comprarlo—.
    """
    http, sesiones, _ = entorno_v2
    modulo = (await _crear_modulo(http, "Modulo")).json()["id"]

    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules/{modulo}/lessons",
        json={"title": "Introduccion", "kind": "text", "is_preview": True},
    )
    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["kind"] == "text"
    assert cuerpo["is_preview"] is True

    # Y se lee de la base, no del cuerpo que acabamos de construir.
    #
    # EL ID VA EN HEXADECIMAL SIN GUIONES: `Uuid(as_uuid=False)` se guarda en
    # SQLite como `char(32)`, asi que con guiones el `where` no casa ninguna
    # fila y la prueba se quedaria verde sin comprobar nada.
    async with sesiones() as db:
        fila = (
            await db.execute(
                text("select kind, is_preview from course_lessons where id = :i"),
                {"i": cuerpo["id"].replace("-", "")},
            )
        ).first()
        assert fila[0] == "text"
        assert bool(fila[1]) is True


@pytest.mark.asyncio
async def test_un_modulo_guarda_su_descripcion(entorno_v2) -> None:
    http, _, _ = entorno_v2
    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules",
        json={"title": "Modulo", "description": "De que va el bloque."},
    )
    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["description"] == "De que va el bloque."


@pytest.mark.asyncio
async def test_sin_la_0034_la_leccion_se_crea_igual(entorno) -> None:
    """Que no se pueda guardar el tipo no puede impedir crear la leccion.

    Y lo que se devuelve es la VERDAD de esta base: video y no muestra. Decir
    `is_preview: true` sin poder guardarlo abriria una leccion de pago en la
    pantalla y la cerraria en la siguiente carga.
    """
    http, _, _, sembrado = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/modules/{sembrado}/lessons",
        json={"title": "Introduccion", "kind": "text", "is_preview": True},
    )
    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["kind"] == "video"
    assert respuesta.json()["is_preview"] is False


@pytest.mark.asyncio
async def test_quitar_el_video_de_una_leccion_es_mandar_null(entorno) -> None:
    """«No enviado» y «enviado vacio» no son lo mismo.

    Sin distinguirlos no habria forma de quitar un video: mandar `null` se
    entenderia como «no lo toques».
    """
    http, sesiones, _, sembrado = entorno
    async with sesiones() as db:
        leccion = await db.scalar(
            select(CourseLesson).where(CourseLesson.module_id == sembrado)
        )
        leccion.media_path = "cursos/uno.mp4"
        await db.commit()
        leccion_id = leccion.id

    ruta = f"{CATALOGO}/courses/{CURSO}/modules/{sembrado}/lessons/{leccion_id}"
    sin_tocar = await http.patch(ruta, json={"title": "Otro titulo"})
    assert sin_tocar.json()["media_path"] == "cursos/uno.mp4"

    borrado = await http.patch(ruta, json={"media_path": None})
    assert borrado.status_code == 200, borrado.text
    assert borrado.json()["media_path"] is None


@pytest.mark.asyncio
async def test_un_titulo_de_solo_espacios_no_pasa(entorno) -> None:
    """Se pinta como una fila en blanco y parece un fallo de la aplicacion.

    Se comprueba el MENSAJE y no solo el 422: `min_length=1` de Pydantic deja
    pasar «   » y devuelve el 422 generico, asi que un codigo a secas no sabria
    distinguir «lo rechazo el esquema» de «lo rechazo la limpieza del titulo»,
    que es lo que aqui se vigila.
    """
    http, _, _, _ = entorno
    respuesta = await _crear_modulo(http, "   ")
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["message"] == "El título no puede estar vacío."
