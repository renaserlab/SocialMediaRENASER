"""Las resenas entre personas, de extremo a extremo, sobre una base de verdad.

SQLite en memoria, mismo patron que el resto de la suite. Las personas y las
resenas de estos escenarios viven los milisegundos que dura cada prueba: NUNCA
llegan a Supabase, y ninguna opinion de aqui aparece en el perfil de nadie.

QUE SE COMPRUEBA AQUI Y NO CABE EN UNA FUNCION PURA. Practicamente todo lo de
este modulo es una regla que cruza QUIEN pregunta con QUE dice la base:

  * que la resena de A sobre B salga en el perfil de B y NO en el de A —que era
    justo lo que hacia mal `testimonials`—,
  * que A pueda borrar la suya y B NO pueda borrar la que hay sobre B,
  * que nadie se resene a si mismo,
  * que un bloqueo corte en LOS DOS SENTIDOS,
  * que el texto sea obligatorio y el archivo opcional —lo contrario que en la
    galeria, donde el archivo era obligatorio y el texto no—,
  * y que el sello de «interaccion verificada» salga de una reserva o una
    compra REALES y no de un campo que mande el cliente.

LO QUE ESTA PRUEBA NO PUEDE COMPROBAR: la RLS. Estas politicas las aplica
PostgreSQL y SQLite no las tiene. Por eso al final hay un bloque que lee la
migracion 0030 y comprueba que las politicas existen y dicen lo que deben:
sin el, el dia que alguien reescriba la migracion nadie se enteraria de que la
regla de «B no borra la resena sobre B» se quedo solo en el backend, y bastaria
una peticion a PostgREST para saltarsela.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.bookings.models import Booking
from app.modules.catalog.models import Course
from app.modules.learning.models import Purchase
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.reviews.models import ProfileReview
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

API = "/api/v1/reviews"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"    # escribe resenas
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # las recibe
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"  # mira desde fuera
DIEGO = "aaaaaaaa-0000-0000-0000-000000000004"  # administra

ORIGEN = datetime(2026, 8, 25, 12, 0, 0, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()

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
        from app.modules.reviews import models as _r  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(Profile(id=DIEGO, full_name="Diego", username="diego", role="admin"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    esquema.olvidar()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# Ayudas
# --------------------------------------------------------------------------- #
def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


async def publicar(http, sobre: str, texto: str = "Trabajó muy bien.", media=None):
    cuerpo: dict = {"reviewed_user_id": sobre, "body": texto}
    if media is not None:
        cuerpo["media"] = media
    return await http.post(API, json=cuerpo)


# --------------------------------------------------------------------------- #
# 1. Lo que `testimonials` no podia hacer: A opina de B y sale en el perfil de B
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_resena_de_ana_sobre_bruno_sale_en_el_perfil_de_bruno(entorno):
    """El caso entero, y el que estaba roto.

    En `testimonials` no habia columna para decir sobre quien se opinaba, asi
    que la galeria se listaba por `author_id`: lo que Ana escribia aparecia en
    el perfil de ANA. Una resena que sale en el perfil de quien la escribe no
    es una resena.
    """
    http, _, identidad = entorno
    identidad["uid"] = ANA

    creada = await publicar(http, BRUNO, "Me ayudó muchísimo con mi negocio.")
    assert creada.status_code == 201, creada.text
    assert creada.json()["reviewed_user_id"] == BRUNO
    assert creada.json()["reviewer_id"] == ANA

    # En el perfil de Bruno: ahi esta.
    recibidas = await http.get(f"{API}/received/{BRUNO}")
    assert recibidas.status_code == 200
    assert [r["body"] for r in recibidas.json()] == [
        "Me ayudó muchísimo con mi negocio."
    ]
    # Y con el nombre de quien la escribio resuelto por el servidor: la tarjeta
    # necesita una cara, y pedir el perfil aparte seria una peticion por resena.
    assert recibidas.json()[0]["reviewer_name"] == "Ana"

    # En el perfil de Ana NO esta: ella no ha recibido ninguna.
    assert (await http.get(f"{API}/received/{ANA}")).json() == []


@pytest.mark.asyncio
async def test_bruno_ve_en_su_perfil_lo_que_le_escribieron(entorno):
    """Lo mismo desde el otro lado: Bruno entra en su perfil y la lee."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    await publicar(http, BRUNO)

    identidad["uid"] = BRUNO
    recibidas = await http.get(f"{API}/received/{BRUNO}")
    assert len(recibidas.json()) == 1
    # Pero NO la puede gestionar: no es suya. Ver el bloque 3.
    assert recibidas.json()[0]["can_manage"] is False


@pytest.mark.asyncio
async def test_quien_firma_sale_del_token_y_no_del_cuerpo(entorno):
    """La identidad SIEMPRE del JWT.

    Se manda `reviewer_id` en el cuerpo apuntando a otra persona: el esquema lo
    ignora entero. Si se aceptara, cualquiera podria firmar una opinion con el
    nombre de otro, que en una seccion de resenas no es una travesura.
    """
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await http.post(
        API,
        json={"reviewed_user_id": BRUNO, "body": "Bien.", "reviewer_id": CARLA},
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["reviewer_id"] == ANA


# --------------------------------------------------------------------------- #
# 2. El texto es obligatorio; la foto y el video, opcionales
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_resena_solo_de_texto_se_publica(entorno):
    """LO CONTRARIO QUE EN LA GALERIA. En `testimonials` el archivo era NOT
    NULL, asi que la hoja desactivaba el boton hasta elegir una foto: publicar
    una opinion escrita, sin mas, era literalmente imposible."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await publicar(http, BRUNO, "Sin foto, pero lo cuento entero.")
    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["media"] == []


@pytest.mark.asyncio
async def test_una_resena_sin_texto_se_rechaza(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO, "")).status_code == 422


@pytest.mark.asyncio
async def test_una_resena_de_solo_espacios_tambien(entorno):
    """`min_length=1` dejaria pasar un espacio, y una resena en blanco ocupa el
    sitio de la unica que esa persona puede escribir."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO, "     ")).status_code == 422


@pytest.mark.asyncio
async def test_la_foto_acompana_a_la_resena(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await publicar(
        http,
        BRUNO,
        "Con foto del resultado.",
        media=[{"storage_path": f"{ANA}/resultado.jpg", "media_type": "image"}],
    )
    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["media"][0]["storage_path"] == f"{ANA}/resultado.jpg"


@pytest.mark.asyncio
async def test_un_archivo_en_la_carpeta_de_otro_se_rechaza(entorno):
    """La politica de Storage exige que la ruta empiece por la carpeta de quien
    sube (`<uid>/...`). Aceptar aqui una ruta ajena dejaria la fila apuntando a
    un archivo que esa cuenta no subio: un hueco roto para siempre."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await publicar(
        http,
        BRUNO,
        "Con foto robada.",
        media=[{"storage_path": f"{CARLA}/suya.jpg", "media_type": "image"}],
    )
    assert respuesta.status_code == 422, respuesta.text
    assert codigo(respuesta) == "review_media_path_invalid"


@pytest.mark.asyncio
async def test_una_ruta_sin_carpeta_tambien_se_rechaza(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await publicar(
        http, BRUNO, "Suelta.", media=[{"storage_path": "foto.jpg", "media_type": "image"}]
    )
    assert respuesta.status_code == 422
    assert codigo(respuesta) == "review_media_path_invalid"


@pytest.mark.asyncio
async def test_el_archivo_rechazado_no_deja_media_a_medias(entorno):
    """La ruta se comprueba ANTES de escribir: si no, quedaria una resena
    publicada con la mitad de sus archivos y sin forma de saber cual falta."""
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    await publicar(
        http,
        BRUNO,
        "Dos archivos, uno ajeno.",
        media=[
            {"storage_path": f"{ANA}/mia.jpg", "media_type": "image"},
            {"storage_path": f"{CARLA}/suya.jpg", "media_type": "image"},
        ],
    )
    async with sesiones() as db:
        assert (await db.scalars(__import__("sqlalchemy").select(ProfileReview))).all() == []


# --------------------------------------------------------------------------- #
# 3. LA REGLA: A borra la suya; B NO borra la que hay sobre B
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_ana_borra_su_propia_resena(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO)).json()

    borrado = await http.delete(f"{API}/{resena['id']}")
    assert borrado.status_code == 204, borrado.text
    assert (await http.get(f"{API}/received/{BRUNO}")).json() == []


@pytest.mark.asyncio
async def test_bruno_NO_puede_borrar_la_resena_que_hay_sobre_el(entorno):
    """EL CORAZON DE LA SECCION.

    Si el opinado pudiera quitar lo que no le gusta, en cada perfil quedaria
    solo lo favorable y leer las resenas no serviria para nada. Su via es
    reportarla (`/api/v1/reports`) y que decida quien modera.

    La interfaz de `testimonials` hacia exactamente lo contrario: daba los
    botones de editar y borrar a quien es dueno del perfil.
    """
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO, "No me gustó nada el trato.")).json()

    identidad["uid"] = BRUNO
    borrado = await http.delete(f"{API}/{resena['id']}")
    assert borrado.status_code == 403, borrado.text
    assert codigo(borrado) == "review_not_yours_to_delete"

    # Y sigue ahi.
    assert len((await http.get(f"{API}/received/{BRUNO}")).json()) == 1


@pytest.mark.asyncio
async def test_bruno_tampoco_puede_editarla(entorno):
    """Editar es la otra forma de hacerla desaparecer: dejar el texto en «genial»
    borra la opinion sin borrar la fila."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO, "No me gustó nada.")).json()

    identidad["uid"] = BRUNO
    respuesta = await http.patch(f"{API}/{resena['id']}", json={"body": "Genial todo"})
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "review_not_yours_to_delete"


@pytest.mark.asyncio
async def test_carla_no_puede_borrar_una_resena_ajena(entorno):
    """Ni la escribio ni va sobre ella: no tiene nada que hacer aqui."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO)).json()

    identidad["uid"] = CARLA
    respuesta = await http.delete(f"{API}/{resena['id']}")
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "review_not_yours"


@pytest.mark.asyncio
async def test_la_moderacion_si_puede_borrar(entorno):
    """La administracion mantiene el paso franco: es lo que permite moderar."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO)).json()

    identidad["uid"] = DIEGO
    assert (await http.delete(f"{API}/{resena['id']}")).status_code == 204


@pytest.mark.asyncio
async def test_ana_edita_su_resena_y_puede_quitarle_la_foto(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (
        await publicar(
            http,
            BRUNO,
            "Primera impresión.",
            media=[{"storage_path": f"{ANA}/uno.jpg", "media_type": "image"}],
        )
    ).json()

    editada = await http.patch(
        f"{API}/{resena['id']}", json={"body": "Lo he pensado mejor.", "media": []}
    )
    assert editada.status_code == 200, editada.text
    assert editada.json()["body"] == "Lo he pensado mejor."
    # Lista vacia SI quita los archivos; omitir el campo los deja como estaban.
    assert editada.json()["media"] == []


@pytest.mark.asyncio
async def test_editar_sin_tocar_media_conserva_la_foto(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (
        await publicar(
            http,
            BRUNO,
            "Con foto.",
            media=[{"storage_path": f"{ANA}/uno.jpg", "media_type": "image"}],
        )
    ).json()

    editada = await http.patch(f"{API}/{resena['id']}", json={"body": "Otro texto."})
    assert len(editada.json()["media"]) == 1


@pytest.mark.asyncio
async def test_editar_no_puede_cambiar_sobre_quien_va(entorno):
    """Cambiar `reviewed_user_id` convertiria una resena sobre Bruno en una
    resena sobre Carla conservando su fecha y su sello: una forma silenciosa de
    mentir. El campo no existe en el esquema de edicion, asi que se ignora."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO)).json()

    await http.patch(f"{API}/{resena['id']}", json={"reviewed_user_id": CARLA})
    assert (await http.get(f"{API}/received/{CARLA}")).json() == []
    assert len((await http.get(f"{API}/received/{BRUNO}")).json()) == 1


@pytest.mark.asyncio
async def test_can_manage_es_de_quien_escribio_y_de_quien_modera(entorno):
    """La aplicacion se apoya en esto para no ensenar botones que van a dar 403.
    Que NUNCA salga true para el resenado es la misma regla de siempre."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    await publicar(http, BRUNO)

    identidad["uid"] = ANA
    assert (await http.get(f"{API}/received/{BRUNO}")).json()[0]["can_manage"] is True
    identidad["uid"] = BRUNO
    assert (await http.get(f"{API}/received/{BRUNO}")).json()[0]["can_manage"] is False
    identidad["uid"] = CARLA
    assert (await http.get(f"{API}/received/{BRUNO}")).json()[0]["can_manage"] is False
    identidad["uid"] = DIEGO
    assert (await http.get(f"{API}/received/{BRUNO}")).json()[0]["can_manage"] is True


@pytest.mark.asyncio
async def test_las_mias_son_las_que_yo_escribi(entorno):
    """Hace falta para poder editarlas o borrarlas sin recordar en que perfil
    quedaron."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    await publicar(http, BRUNO, "Sobre Bruno.")
    await publicar(http, CARLA, "Sobre Carla.")

    mias = await http.get(f"{API}/mine")
    assert {r["reviewed_user_id"] for r in mias.json()} == {BRUNO, CARLA}

    identidad["uid"] = BRUNO
    assert (await http.get(f"{API}/mine")).json() == []


# --------------------------------------------------------------------------- #
# 4. Autoresena: prohibida
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_nadie_se_resena_a_si_mismo(entorno):
    """Prohibida por un CHECK en la base (0030) ademas de aqui. El backend la
    corta antes para poder decir POR QUE en vez de devolver un error de
    restriccion, que en la pantalla se lee como un fallo tecnico."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await publicar(http, ANA, "Soy estupenda.")
    assert respuesta.status_code == 422, respuesta.text
    assert codigo(respuesta) == "review_self_not_allowed"


@pytest.mark.asyncio
async def test_la_autoresena_no_deja_rastro(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    await publicar(http, ANA)
    async with sesiones() as db:
        assert (await db.scalars(__import__("sqlalchemy").select(ProfileReview))).all() == []


# --------------------------------------------------------------------------- #
# 5. Bloqueos, simetricos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_puede_resenar_a_quien_te_bloqueo(entorno):
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=BRUNO, blocked_id=ANA))
        await db.commit()

    identidad["uid"] = ANA
    respuesta = await publicar(http, BRUNO)
    assert respuesta.status_code == 403, respuesta.text
    assert codigo(respuesta) == "review_blocked"


@pytest.mark.asyncio
async def test_tampoco_a_quien_bloqueaste_tu(entorno):
    """El corte es SIMETRICO. Cortar un solo sentido dejaria que quien bloqueo a
    alguien pudiera seguir opinando sobre esa persona en su perfil."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=BRUNO))
        await db.commit()

    identidad["uid"] = ANA
    respuesta = await publicar(http, BRUNO)
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "review_blocked"


@pytest.mark.asyncio
async def test_un_bloqueo_posterior_esconde_la_resena_a_las_dos_partes(entorno):
    """La resena se escribio antes del bloqueo y no se borra —no la ha borrado
    nadie—, pero deja de verse por los dos lados."""
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    await publicar(http, BRUNO, "Antes de enfadarnos.")

    async with sesiones() as db:
        db.add(UserBlock(blocker_id=BRUNO, blocked_id=ANA))
        await db.commit()

    identidad["uid"] = ANA
    assert (await http.get(f"{API}/received/{BRUNO}")).json() == []
    identidad["uid"] = BRUNO
    assert (await http.get(f"{API}/received/{BRUNO}")).json() == []
    # A un tercero le sigue apareciendo: el bloqueo es entre esas dos personas.
    identidad["uid"] = CARLA
    assert len((await http.get(f"{API}/received/{BRUNO}")).json()) == 1


# --------------------------------------------------------------------------- #
# 6. Una por pareja
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_puede_resenar_dos_veces_a_la_misma_persona(entorno):
    """Sin este limite, una sola cuenta puede llenar el perfil de otra con
    veinte entradas y tapar todo lo demas. Cambiar de opinion sigue siendo
    posible: se edita la que hay."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO, "Primera.")).status_code == 201
    segunda = await publicar(http, BRUNO, "Segunda.")
    assert segunda.status_code == 409, segunda.text
    assert codigo(segunda) == "review_already_exists"


@pytest.mark.asyncio
async def test_despues_de_borrarla_se_puede_escribir_otra(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO, "Primera.")).json()
    await http.delete(f"{API}/{resena['id']}")
    assert (await publicar(http, BRUNO, "Otra distinta.")).status_code == 201


@pytest.mark.asyncio
async def test_dos_personas_distintas_si_pueden_resenar_a_la_misma(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    await publicar(http, BRUNO, "Dice Ana.")
    identidad["uid"] = CARLA
    await publicar(http, BRUNO, "Dice Carla.")

    identidad["uid"] = BRUNO
    assert len((await http.get(f"{API}/received/{BRUNO}")).json()) == 2


# --------------------------------------------------------------------------- #
# 7. El sello de interaccion verificada: sale de datos reales o no sale
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_constancia_no_hay_sello(entorno):
    """Y la resena vale IGUAL. No llevar sello es la situacion normal de casi
    todas; lo que no puede pasar es que se ponga sin nada detras."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO)).json()["verified_source"] is None


@pytest.mark.asyncio
async def test_una_sesion_completada_da_el_sello(entorno):
    """La migracion 0025 guardo `completed_at` diciendo exactamente esto: «es lo
    que permitira verificar una resena posterior»."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add(
            Booking(
                requester_id=ANA,
                provider_id=BRUNO,
                topic="Mentoría",
                status="completed",
                completed_at=ORIGEN,
            )
        )
        await db.commit()

    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO)).json()["verified_source"] == "booking"


@pytest.mark.asyncio
async def test_la_sesion_vale_en_los_dos_papeles(entorno):
    """Sirve tanto si quien opina pidio la sesion como si la dio: las dos
    personas estuvieron igual de presentes."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add(
            Booking(
                requester_id=BRUNO,
                provider_id=ANA,
                topic="Mentoría",
                status="completed",
                completed_at=ORIGEN,
            )
        )
        await db.commit()

    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO)).json()["verified_source"] == "booking"


@pytest.mark.asyncio
async def test_una_sesion_pendiente_no_da_sello(entorno):
    """Agendar no es haberse visto. Si `pending` valiera, el sello se
    conseguiria pidiendo una sesion que nadie llega a dar."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add(
            Booking(
                requester_id=ANA, provider_id=BRUNO, topic="Mentoría", status="pending"
            )
        )
        await db.commit()

    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO)).json()["verified_source"] is None


@pytest.mark.asyncio
async def test_un_curso_pagado_del_resenado_da_el_sello(entorno):
    http, sesiones, identidad = entorno
    curso = "cccccccc-0000-0000-0000-000000000001"
    async with sesiones() as db:
        db.add(Course(id=curso, author_id=BRUNO, title="Curso de Bruno"))
        db.add(Purchase(user_id=ANA, course_id=curso, provider="culqi", status="paid"))
        await db.commit()

    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO)).json()["verified_source"] == "course"


@pytest.mark.asyncio
async def test_una_compra_pendiente_no_da_sello(entorno):
    http, sesiones, identidad = entorno
    curso = "cccccccc-0000-0000-0000-000000000001"
    async with sesiones() as db:
        db.add(Course(id=curso, author_id=BRUNO, title="Curso de Bruno"))
        db.add(
            Purchase(user_id=ANA, course_id=curso, provider="culqi", status="pending")
        )
        await db.commit()

    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO)).json()["verified_source"] is None


@pytest.mark.asyncio
async def test_el_curso_de_otra_persona_no_da_sello(entorno):
    """Comprarle un curso a Carla no dice nada sobre Bruno."""
    http, sesiones, identidad = entorno
    curso = "cccccccc-0000-0000-0000-000000000001"
    async with sesiones() as db:
        db.add(Course(id=curso, author_id=CARLA, title="Curso de Carla"))
        db.add(Purchase(user_id=ANA, course_id=curso, provider="culqi", status="paid"))
        await db.commit()

    identidad["uid"] = ANA
    assert (await publicar(http, BRUNO)).json()["verified_source"] is None


@pytest.mark.asyncio
async def test_el_cliente_no_puede_pedir_el_sello(entorno):
    """No hay ningun campo para pedirlo: mandarlo no hace nada. Si lo hubiera,
    el sello dejaria de significar algo el mismo dia."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await http.post(
        API,
        json={
            "reviewed_user_id": BRUNO,
            "body": "Con sello, por favor.",
            "verified_source": "booking",
        },
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["verified_source"] is None


@pytest.mark.asyncio
async def test_el_sello_no_se_recalcula_al_editar(entorno):
    """La reserva ocurrio, y eso ya no cambia. Si se recalculara, cancelar una
    reserva antigua retiraria el sello de una resena escrita cuando la sesion
    si habia ocurrido."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        reserva = Booking(
            requester_id=ANA,
            provider_id=BRUNO,
            topic="Mentoría",
            status="completed",
            completed_at=ORIGEN,
        )
        db.add(reserva)
        await db.commit()
        reserva_id = reserva.id

    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO)).json()
    assert resena["verified_source"] == "booking"

    async with sesiones() as db:
        encontrada = await db.get(Booking, reserva_id)
        encontrada.status = "cancelled"
        await db.commit()

    editada = await http.patch(f"{API}/{resena['id']}", json={"body": "Lo mismo."})
    assert editada.json()["verified_source"] == "booking"


# --------------------------------------------------------------------------- #
# 8. Moderacion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_solo_la_moderacion_puede_esconder(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO)).json()

    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{API}/{resena['id']}/hide")
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "review_moderation_only"


@pytest.mark.asyncio
async def test_lo_escondido_no_se_entrega_pero_su_autor_lo_sigue_viendo(entorno):
    """Se esconde y no se borra: la decision queda registrada y se puede
    revisar. Quien la escribio la sigue viendo para que no le desaparezca sin
    explicacion."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    resena = (await publicar(http, BRUNO)).json()

    identidad["uid"] = DIEGO
    escondida = await http.post(f"{API}/{resena['id']}/hide")
    assert escondida.status_code == 200
    assert escondida.json()["status"] == "hidden"

    identidad["uid"] = CARLA
    assert (await http.get(f"{API}/received/{BRUNO}")).json() == []
    identidad["uid"] = BRUNO
    assert (await http.get(f"{API}/received/{BRUNO}")).json() == []
    identidad["uid"] = ANA
    assert len((await http.get(f"{API}/received/{BRUNO}")).json()) == 1
    identidad["uid"] = DIEGO
    assert len((await http.get(f"{API}/received/{BRUNO}")).json()) == 1


# --------------------------------------------------------------------------- #
# 9. Identificadores raros y perfiles que no existen
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_id_que_no_es_uuid_da_404_y_no_500(entorno):
    """Un slug de una pantalla antigua llegaba tal cual a Postgres y asyncpg
    reventaba con `invalid UUID`: un 500 que en el navegador se lee como error
    de CORS, porque Starlette no le pone cabeceras."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    assert (await http.get(f"{API}/received/no-soy-un-uuid")).status_code == 404
    assert (await http.delete(f"{API}/tampoco")).status_code == 404


@pytest.mark.asyncio
async def test_resenar_a_alguien_que_no_existe_da_404(entorno):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await publicar(http, "aaaaaaaa-0000-0000-0000-00000000ffff")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_un_perfil_sin_resenas_devuelve_lista_vacia_y_no_404(entorno):
    """La regresion del `in_(lista or [''])`: la cadena vacia contra una columna
    uuid cuela en SQLite, PostgreSQL la rechaza y el manejador de DBAPIError lo
    convierte en un 404 silencioso. Un perfil sin resenas responderia «no
    encontrado» en vez de una lista vacia."""
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await http.get(f"{API}/received/{CARLA}")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


# --------------------------------------------------------------------------- #
# 10. Rendimiento
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_numero_de_consultas_no_crece_con_las_resenas(entorno):
    """PROHIBIDO una consulta por resena. La seccion de un perfil se abre entera
    de golpe: con veinte resenas serian sesenta viajes a la base para pintar una
    lista que cabe en una pantalla."""
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    autores = [ANA, CARLA, DIEGO]
    async with sesiones() as db:
        for i in range(20):
            db.add(
                ProfileReview(
                    id=f"55555555-0000-0000-0000-{i:012d}",
                    reviewer_id=autores[i % len(autores)],
                    reviewed_user_id=BRUNO,
                    body=f"Reseña {i}",
                    created_at=ORIGEN + timedelta(seconds=i),
                    updated_at=ORIGEN + timedelta(seconds=i),
                )
            )
        await db.commit()

    # Un viaje en vacio primero: la deteccion del esquema se hace UNA vez por
    # proceso y contarla aqui mediria otra cosa.
    assert (
        await http.get(f"{API}/received/{BRUNO}", params={"limit": 20})
    ).status_code == 200

    consultas: list[str] = []

    def _contar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _contar)
    try:
        respuesta = await http.get(f"{API}/received/{BRUNO}", params={"limit": 20})
    finally:
        event.remove(motor, "before_cursor_execute", _contar)

    assert len(respuesta.json()) == 20
    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    # SIETE y no seis desde la 0041: `_cursos_de` pregunta de que curso habla
    # cada resena, y lo hace de UNA vez para toda la lista (un `in_` con los
    # veinte identificadores), no una por fila.
    #
    # Lo que este tope protege es que el numero no DEPENDA de cuantas resenas
    # haya. Por eso la comprobacion de abajo, que es la que de verdad importa:
    # con 20 resenas se hacen las mismas consultas que con 3.
    assert len(selects) <= 7, f"{len(selects)} consultas para 20 resenas"

    # Y con tres resenas, exactamente las MISMAS. Un tope suelto se puede ir
    # subiendo de uno en uno hasta que deje de significar nada; esto no.
    con_tres: list[str] = []

    def _contar_tres(conn, cursor, statement, *args):  # noqa: ANN001
        con_tres.append(statement)

    event.listen(motor, "before_cursor_execute", _contar_tres)
    try:
        pocas = await http.get(f"{API}/received/{BRUNO}", params={"limit": 3})
    finally:
        event.remove(motor, "before_cursor_execute", _contar_tres)

    assert len(pocas.json()) == 3
    assert len([c for c in con_tres if c.lstrip().lower().startswith("select")]) == len(
        selects
    )


# --------------------------------------------------------------------------- #
# 11. La RLS de la 0030, que SQLite no puede ejecutar
# --------------------------------------------------------------------------- #
#
# Estas politicas las aplica PostgreSQL. Aqui se comprueba que la migracion las
# ESCRIBE y que dicen lo que deben, porque la aplicacion movil habla tambien con
# PostgREST: una regla que solo viva en el backend se salta con una peticion a
# mano contra la base. Se leen sin comentarios; si no, el propio fichero —que
# explica todo esto en prosa— daria positivo por su propia explicacion.
def _sql_0030_sin_comentarios() -> str:
    sql = (
        Path(__file__).resolve().parents[3]
        / "supabase"
        / "migrations"
        / "0030_resenas_entre_usuarios.sql"
    ).read_text(encoding="utf-8")
    return "\n".join(linea.split("--")[0] for linea in sql.splitlines())


def test_la_migracion_prohibe_la_autoresena_con_un_check():
    """En la BASE, no solo en el formulario: la aplicacion escribe tambien
    contra PostgREST y una validacion de pantalla se salta con una peticion."""
    assert re.search(
        r"check\s*\(\s*reviewer_id\s*<>\s*reviewed_user_id\s*\)",
        _sql_0030_sin_comentarios(),
    ), "falta el CHECK que impide reseñarse a uno mismo"


def test_la_migracion_exige_texto_no_vacio():
    assert re.search(
        r"body\s+text\s+not null\s+check\s*\(\s*char_length\s*\(\s*btrim\s*\(\s*body\s*\)\s*\)",
        _sql_0030_sin_comentarios(),
    ), "el texto de la reseña tiene que ser obligatorio en la base"


def test_la_politica_de_borrado_solo_mira_al_autor():
    """LA REGLA. La politica de DELETE no puede nombrar a `reviewed_user_id`:
    si lo hiciera, quien recibe la resena podria borrarla desde PostgREST
    aunque el backend se lo negara."""
    sql = _sql_0030_sin_comentarios()
    politica = re.search(
        r"create policy profile_reviews_delete.*?;", sql, re.S | re.I
    )
    assert politica, "falta la politica de borrado de profile_reviews"
    texto = politica.group(0)
    assert "reviewer_id = auth.uid()" in texto
    assert "is_admin" in texto
    assert "reviewed_user_id" not in texto, (
        "la persona reseñada NO puede aparecer en la politica de borrado"
    )


def test_la_politica_de_edicion_tampoco_nombra_al_resenado():
    sql = _sql_0030_sin_comentarios()
    politica = re.search(r"create policy profile_reviews_update.*?;", sql, re.S | re.I)
    assert politica, "falta la politica de edicion de profile_reviews"
    assert "reviewed_user_id" not in politica.group(0)


def test_la_politica_de_insercion_exige_firmar_en_nombre_propio():
    sql = _sql_0030_sin_comentarios()
    politica = re.search(r"create policy profile_reviews_insert.*?;", sql, re.S | re.I)
    assert politica, "falta la politica de insercion de profile_reviews"
    texto = politica.group(0)
    assert "reviewer_id = auth.uid()" in texto
    assert "reviewed_user_id <> auth.uid()" in texto
    assert "user_blocks" in texto, "el bloqueo tiene que cortar tambien en la RLS"


def test_la_lectura_corta_por_bloqueo_en_los_dos_sentidos():
    sql = _sql_0030_sin_comentarios()
    politica = re.search(r"create policy profile_reviews_read.*?;", sql, re.S | re.I)
    assert politica, "falta la politica de lectura de profile_reviews"
    texto = politica.group(0)
    assert texto.count("b.blocker_id") >= 2 and texto.count("b.blocked_id") >= 2


def test_la_migracion_no_toca_testimonials():
    """`testimonials` tiene contenido REAL. La 0030 solo anade: si alguna vez
    aparece aqui un `drop`, un `alter` o una politica suya, esta prueba lo para.

    Las unicas menciones permitidas son las de la comprobacion final, que solo
    CUENTA sus filas y sus politicas para demostrar que siguen intactas.
    """
    sql = _sql_0030_sin_comentarios()
    for linea in sql.splitlines():
        if "testimonials" not in linea:
            continue
        limpia = linea.strip().lower()
        assert limpia.startswith("(select count(*)") or "tablename = 'testimonials'" in limpia, (
            f"la 0030 no puede tocar testimonials: {linea.strip()}"
        )
    assert "drop table" not in sql.lower()


def test_la_migracion_crea_una_resena_por_pareja():
    assert re.search(
        r"create unique index if not exists profile_reviews_una_por_pareja\s*\n?\s*on public\.profile_reviews \(reviewer_id, reviewed_user_id\)",
        _sql_0030_sin_comentarios(),
    ), "falta el indice unico que impide inundar un perfil"
