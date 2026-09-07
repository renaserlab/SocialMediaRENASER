"""Los endpoints de devoluciones, de punta a punta.

LO QUE ESTAS PRUEBAS PROTEGEN, y por qué cada una existe:

1. **Autorización.** El creador del curso no aprueba sus propias devoluciones,
   y nadie toca una solicitud ajena. Un fallo aquí no da error: da dinero.
2. **Concurrencia.** Dos administradores aprobando a la vez, dos pulsaciones
   del alumno. Se lanzan de verdad, no se comprueba que exista un `if`.
3. **Lo que el cliente NO puede decidir.** Importe, curso, plazo y estado los
   pone el servidor aunque el cuerpo intente traerlos.
4. **Que apagado sea apagado.** Con `STRIPE_REFUNDS_ENABLED` en falso no sale
   un céntimo, y el expediente lo dice en vez de quedarse colgado.
"""

from __future__ import annotations

import asyncio
import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.commerce.models import (
    CommerceProduct,
    CourseEnrollment,
    Entitlement,
    Order,
    PaymentTransaction,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.refunds.models import RefundRequest
from app.shared.database import Base, get_db

PAGOS = "/api/v1/payments"
ADMIN = "/api/v1/admin"
LEARNING = "/api/v1/learning"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # autor del curso
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"  # administración
MODERA = "aaaaaaaa-0000-0000-0000-00000000000d"  # solo modera contenido
CARLA = "aaaaaaaa-0000-0000-0000-000000000004"
CURSO = "cccccccc-0000-0000-0000-000000000001"
ORDEN = "00000000-0000-0000-0000-0000000000a1"
PRECIO = 19900


@pytest_asyncio.fixture
async def entorno():
    """Curso de pago de Bruno, comprado y pagado por Ana."""
    esquema.olvidar()
    ajustes = get_settings()
    anterior = ajustes.feature_course_refunds
    ajustes.feature_course_refunds = True

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=JEFA, full_name="Jefa", username="jefa", role="admin"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(
            Course(
                id=CURSO,
                author_id=BRUNO,
                title="Curso de pago",
                price_minor=PRECIO,
                currency="PEN",
                status="published",
            )
        )
        modulo = CourseModule(course_id=CURSO, title="Modulo 1")
        db.add(modulo)
        await db.flush()
        db.add(CourseLesson(module_id=modulo.id, title="Leccion 1"))
        db.add(CourseLesson(module_id=modulo.id, title="Leccion 2"))
        producto = CommerceProduct(course_id=CURSO)
        db.add(producto)
        await db.flush()
        db.add(
            Order(
                id=ORDEN,
                user_id=ANA,
                commerce_product_id=producto.id,
                provider="stripe",
                channel="web",
                environment="sandbox",
                status="paid",
                amount_minor=PRECIO,
                currency="PEN",
            )
        )
        db.add(
            PaymentTransaction(
                order_id=ORDEN,
                provider="stripe",
                environment="sandbox",
                external_transaction_id="pi_1",
                kind="purchase",
                amount_minor=PRECIO,
                currency="PEN",
            )
        )
        db.add(
            Entitlement(
                user_id=ANA,
                commerce_product_id=producto.id,
                status="active",
                source_provider="stripe",
            )
        )
        db.add(CourseEnrollment(user_id=ANA, course_id=CURSO, source="entitlement"))
        db.add(CourseEnrollment(user_id=CARLA, course_id=CURSO, source="free"))
        await db.commit()

    identidad = {"uid": ANA}

    async def _db_override():
        async with sesiones() as sesion:
            yield sesion

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, identidad, sesiones
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()
    ajustes.feature_course_refunds = anterior


async def _arrancar_garantia(sesiones) -> None:
    """Simula que Ana entró a una lección protegida."""
    from app.modules.refunds import service as devoluciones

    async with sesiones() as db:
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        await db.commit()


async def _pedir(http, *, orden=ORDEN, motivo="not_as_expected"):
    return await http.post(
        f"{PAGOS}/refund-requests", json={"order_id": orden, "reason": motivo}
    )


# --------------------------------------------------------------------------- #
# 1. Elegibilidad
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_haber_entrado_la_garantia_no_ha_empezado(entorno):
    http, _, _ = entorno
    cuerpo = (await http.get(f"{PAGOS}/courses/{CURSO}/refund-eligibility")).json()
    assert cuerpo["eligible"] is False
    assert cuerpo["reason_code"] == "not_started"
    # La hora del SERVIDOR viaja siempre, para que la cuenta atrás de la
    # pantalla no dependa del reloj del teléfono.
    assert cuerpo["server_time"]


@pytest.mark.asyncio
async def test_tras_entrar_es_elegible_y_dice_cuanto_queda(entorno):
    http, _, sesiones = entorno
    await _arrancar_garantia(sesiones)
    cuerpo = (await http.get(f"{PAGOS}/courses/{CURSO}/refund-eligibility")).json()
    assert cuerpo["eligible"] is True
    assert cuerpo["seconds_remaining"] > 0
    assert cuerpo["order_id"] == ORDEN
    assert cuerpo["amount_minor"] == PRECIO


# --------------------------------------------------------------------------- #
# 2. Crear la solicitud
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_una_solicitud_valida_se_crea(entorno):
    http, _, _ = entorno
    _, _, sesiones = entorno
    await _arrancar_garantia(sesiones)
    respuesta = await _pedir(http)
    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["status"] == "requested"
    # El importe lo pone el SERVIDOR desde la orden.
    assert cuerpo["amount_minor"] == PRECIO
    assert cuerpo["currency"] == "PEN"


@pytest.mark.asyncio
async def test_el_importe_del_cuerpo_se_ignora(entorno):
    """Mandar un importe no cambia nada: el esquema ni siquiera lo admite."""
    http, _, sesiones = entorno
    await _arrancar_garantia(sesiones)
    respuesta = await http.post(
        f"{PAGOS}/refund-requests",
        json={
            "order_id": ORDEN,
            "reason": "other",
            "amount_minor": 1,
            "status": "refunded",
        },
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["amount_minor"] == PRECIO
    assert respuesta.json()["status"] == "requested"


@pytest.mark.asyncio
async def test_no_se_puede_pedir_la_devolucion_de_una_orden_ajena(entorno):
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    identidad["uid"] = CARLA
    respuesta = await _pedir(http)
    assert respuesta.status_code in (400, 404, 422)
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(RefundRequest)) == 0


@pytest.mark.asyncio
async def test_una_orden_inexistente_no_crea_nada(entorno):
    http, _, sesiones = entorno
    await _arrancar_garantia(sesiones)
    respuesta = await _pedir(http, orden="00000000-0000-0000-0000-00000000dead")
    assert respuesta.status_code in (400, 404, 422)


@pytest.mark.asyncio
async def test_dos_pulsaciones_no_crean_dos_solicitudes(entorno):
    """La doble pulsación real, no la comprobación de que exista un `if`.

    LO QUE SE AFIRMA ES LA INVARIANTE, NO EL CÓDIGO DE ESTADO. Las tres
    peticiones salen a la vez contra una SQLite en memoria, que solo admite un
    escritor: alguna puede morir con un error de la base en vez de con el 422
    del índice. Eso es una limitación del banco de pruebas, no del producto —en
    PostgreSQL las tres llegan y el índice parcial resuelve el empate—, y
    exigir aquí un código concreto sería exigir un detalle de SQLite.

    Lo que NO puede pasar, y es lo que se comprueba, es que queden dos
    solicitudes vivas sobre el mismo dinero. De ahí salen las dobles
    aprobaciones y los dobles reembolsos.
    """
    http, _, sesiones = entorno
    await _arrancar_garantia(sesiones)

    respuestas = await asyncio.gather(
        _pedir(http), _pedir(http), _pedir(http), return_exceptions=True
    )
    creadas = [
        r
        for r in respuestas
        if not isinstance(r, BaseException) and r.status_code == 201
    ]

    # DOS 201 NO SON DOS SOLICITUDES. Quien pierde el choque del indice recibe
    # la que ya existia, con su mismo id: eso es idempotencia, y es mejor que
    # un error —la persona pulso dos veces, no hizo nada malo—. Lo que se
    # comprueba es que todas apunten a la MISMA.
    identificadores = {r.json()["id"] for r in creadas}
    assert len(identificadores) <= 1, identificadores

    async with sesiones() as db:
        cuantas = await db.scalar(select(func.count()).select_from(RefundRequest))
    assert cuantas <= 1

    # Y la puerta sigue cerrada después: una cuarta, ya sin concurrencia, se
    # rechaza con el código que corresponde.
    if cuantas == 1:
        assert (await _pedir(http)).status_code == 422


@pytest.mark.asyncio
async def test_con_una_solicitud_viva_no_se_puede_abrir_otra(entorno):
    http, _, sesiones = entorno
    await _arrancar_garantia(sesiones)
    assert (await _pedir(http)).status_code == 201
    segunda = await _pedir(http)
    assert segunda.status_code == 422
    assert "request_active" in segunda.text


# --------------------------------------------------------------------------- #
# 3. Permisos de administración
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_creador_del_curso_NO_puede_aprobar(entorno):
    """Aprobar la devolución de lo que uno vende es juez y parte.

    Y además le daría acceso al motivo privado de quien la pide.
    """
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()

    identidad["uid"] = BRUNO  # el autor del curso
    for ruta in ("take", "approve", "reject"):
        respuesta = await http.post(
            f"{ADMIN}/refund-requests/{solicitud['id']}/{ruta}", json={"notes": "x"}
        )
        assert respuesta.status_code == 403, f"{ruta}: {respuesta.status_code}"


@pytest.mark.asyncio
async def test_quien_solo_modera_contenido_no_mueve_dinero(entorno):
    """`moderator` oculta publicaciones. No aprueba reembolsos.

    LOS DOS PERMISOS SE PARECEN Y NO SON EL MISMO. La comprobación usaba
    `is_admin`, y ese conjunto incluye `moderator`: el rol pensado para resolver
    un reporte podía entrar en la bandeja, leer el motivo privado de cualquier
    alumno y lanzar un reembolso real contra la pasarela. Ahora el dinero exige
    `FINANCE_ROLES`, que es más estrecho.
    """
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()

    async with sesiones() as db:
        db.add(Profile(id=MODERA, full_name="Modera", username="modera", role="moderator"))
        await db.commit()

    identidad["uid"] = MODERA
    assert (await http.get(f"{ADMIN}/refund-requests")).status_code == 403
    assert (
        await http.get(f"{ADMIN}/refund-requests/{solicitud['id']}")
    ).status_code == 403
    for ruta in ("take", "approve", "reject", "retry", "cancel"):
        respuesta = await http.post(
            f"{ADMIN}/refund-requests/{solicitud['id']}/{ruta}", json={"notes": "x"}
        )
        assert respuesta.status_code == 403, f"{ruta}: {respuesta.status_code}"
    # Y tampoco la tesorería: los saldos retenidos son dinero, no moderación.
    assert (await http.get(f"{ADMIN}/owner-balances/health")).status_code == 403


@pytest.mark.asyncio
async def test_un_usuario_cualquiera_tampoco_ve_la_bandeja(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = CARLA
    assert (await http.get(f"{ADMIN}/refund-requests")).status_code == 403


@pytest.mark.asyncio
async def test_nadie_lee_la_solicitud_de_otro(entorno):
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()
    identidad["uid"] = CARLA
    respuesta = await http.get(f"{PAGOS}/refund-requests/{solicitud['id']}")
    assert respuesta.status_code == 404


# --------------------------------------------------------------------------- #
# 4. El circuito de revisión
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_camino_completo_hasta_procesando(entorno):
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()

    identidad["uid"] = JEFA
    tomada = await http.post(f"{ADMIN}/refund-requests/{solicitud['id']}/take")
    assert tomada.status_code == 200, tomada.text
    assert tomada.json()["status"] == "under_review"

    aprobada = await http.post(
        f"{ADMIN}/refund-requests/{solicitud['id']}/approve", json={"notes": "vale"}
    )
    assert aprobada.status_code == 200, aprobada.text
    # Con los reembolsos APAGADOS no se llama a nadie, asi que el expediente NO
    # puede decir que fallo: nunca se intento. Se queda en `approved` esperando
    # a que se habilite la ejecucion externa.
    assert aprobada.json()["status"] == "approved"
    # Y NADIE ha perdido el acceso: aprobar no retira nada.
    async with sesiones() as db:
        activos = await db.scalar(
            select(func.count())
            .select_from(Entitlement)
            .where(Entitlement.status == "active")
        )
    assert activos == 1


@pytest.mark.asyncio
async def test_rechazar_exige_motivo(entorno):
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()
    identidad["uid"] = JEFA
    await http.post(f"{ADMIN}/refund-requests/{solicitud['id']}/take")

    sin_motivo = await http.post(
        f"{ADMIN}/refund-requests/{solicitud['id']}/reject", json={"notes": "  "}
    )
    assert sin_motivo.status_code == 422
    assert "reason_required" in sin_motivo.text

    con_motivo = await http.post(
        f"{ADMIN}/refund-requests/{solicitud['id']}/reject",
        json={"notes": "El curso se entregó completo."},
    )
    assert con_motivo.status_code == 200
    assert con_motivo.json()["status"] == "rejected"


@pytest.mark.asyncio
async def test_un_rechazo_NO_consume_la_garantia(entorno):
    """Si le queda plazo, puede volver a pedirlo."""
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()
    identidad["uid"] = JEFA
    await http.post(f"{ADMIN}/refund-requests/{solicitud['id']}/take")
    await http.post(
        f"{ADMIN}/refund-requests/{solicitud['id']}/reject", json={"notes": "no"}
    )

    identidad["uid"] = ANA
    cuerpo = (await http.get(f"{PAGOS}/courses/{CURSO}/refund-eligibility")).json()
    assert cuerpo["refund_used"] is False
    assert cuerpo["eligible"] is True
    assert (await _pedir(http)).status_code == 201


@pytest.mark.asyncio
async def test_no_se_puede_aprobar_sin_haber_tomado(entorno):
    """`requested → approved` se salta a quien tenía que mirarlo."""
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()
    identidad["uid"] = JEFA
    respuesta = await http.post(
        f"{ADMIN}/refund-requests/{solicitud['id']}/approve", json={"notes": "ya"}
    )
    assert respuesta.status_code == 422
    assert "invalid_transition" in respuesta.text


@pytest.mark.asyncio
async def test_dos_administradores_aprobando_a_la_vez_solo_aprueban_una(entorno):
    """LA CARRERA QUE CUESTA DINERO.

    Los dos leen `under_review`, los dos pasan la comprobación en memoria y los
    dos escriben. Lo que lo impide es el UPDATE condicional: la base cambia la
    fila solo si su estado sigue siendo el que se leyó.
    """
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()
    identidad["uid"] = JEFA
    await http.post(f"{ADMIN}/refund-requests/{solicitud['id']}/take")

    async def aprobar():
        return await http.post(
            f"{ADMIN}/refund-requests/{solicitud['id']}/approve", json={"notes": "ok"}
        )

    respuestas = await asyncio.gather(aprobar(), aprobar(), aprobar())
    exitos = [r for r in respuestas if r.status_code == 200]
    assert len(exitos) == 1, [r.status_code for r in respuestas]


@pytest.mark.asyncio
async def test_el_alumno_puede_retirar_la_suya_y_no_gasta_garantia(entorno):
    http, _, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()

    respuesta = await http.post(f"{PAGOS}/refund-requests/{solicitud['id']}/cancel")
    assert respuesta.status_code == 200
    assert respuesta.json()["status"] == "cancelled"

    cuerpo = (await http.get(f"{PAGOS}/courses/{CURSO}/refund-eligibility")).json()
    assert cuerpo["refund_used"] is False
    assert cuerpo["eligible"] is True


@pytest.mark.asyncio
async def test_el_historial_de_estados_solo_lo_ve_administracion(entorno):
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()

    # El alumno ve lo suyo, pero su lectura no trae el historial.
    mio = (await http.get(f"{PAGOS}/refund-requests/{solicitud['id']}")).json()
    assert "history" not in mio

    identidad["uid"] = JEFA
    detalle = (await http.get(f"{ADMIN}/refund-requests/{solicitud['id']}")).json()
    assert len(detalle["history"]) >= 1
    assert detalle["history"][0]["to_status"] == "requested"


@pytest.mark.asyncio
async def test_la_nota_de_una_DECISION_si_llega_al_alumno(entorno):
    """Un rechazo sin motivo legible es indefendible ante quien lo recibe."""
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()
    identidad["uid"] = JEFA
    await http.post(f"{ADMIN}/refund-requests/{solicitud['id']}/take")
    await http.post(
        f"{ADMIN}/refund-requests/{solicitud['id']}/reject",
        json={"notes": "El curso se entregó completo."},
    )

    identidad["uid"] = ANA
    mio = (await http.get(f"{PAGOS}/refund-requests/{solicitud['id']}")).json()
    assert mio["review_notes"] == "El curso se entregó completo."


@pytest.mark.asyncio
async def test_las_notas_INTERNAS_no_se_le_ensenan_al_alumno(entorno):
    """`review_notes` viaja en la respuesta del alumno, así que no vale todo.

    ANTES SE ESCRIBÍA EN CUALQUIER TRANSICIÓN. Cerrar un expediente muerto con
    una nota interna —«duplicada de la de septiembre, la lleva legal»— la
    publicaba tal cual en la pantalla de quien pidió la devolución. Y por el
    mismo camino se colaba el motivo técnico con el que la pasarela rechazó el
    cargo, presentado como si fuera la nota de la persona que lo revisó.

    La nota SIGUE guardándose en el historial, que solo ve administración: no
    se pierde el rastro, se pierde la publicación.
    """
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    solicitud = (await _pedir(http)).json()
    identidad["uid"] = JEFA
    await http.post(f"{ADMIN}/refund-requests/{solicitud['id']}/take")
    interna = "Duplicada de la de septiembre; la lleva legal."
    cerrada = await http.post(
        f"{ADMIN}/refund-requests/{solicitud['id']}/cancel", json={"notes": interna}
    )
    assert cerrada.status_code == 200, cerrada.text
    assert cerrada.json()["status"] == "cancelled"

    # Administración la sigue teniendo, en el historial.
    detalle = (await http.get(f"{ADMIN}/refund-requests/{solicitud['id']}")).json()
    assert any(evento["notes"] == interna for evento in detalle["history"])

    # El alumno ve el estado, y no la nota.
    identidad["uid"] = ANA
    mio = (await http.get(f"{PAGOS}/refund-requests/{solicitud['id']}")).json()
    assert mio["status"] == "cancelled"
    assert mio["review_notes"] is None
    assert interna not in json.dumps(mio)


# --------------------------------------------------------------------------- #
# 5. Estudiantes
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_autor_ve_sus_estudiantes(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{LEARNING}/courses/{CURSO}/students")
    assert respuesta.status_code == 200
    alumnos = respuesta.json()
    assert {a["id"] for a in alumnos} == {ANA, CARLA}


@pytest.mark.asyncio
async def test_quien_compro_sale_como_venta_y_quien_entro_gratis_no(entorno):
    """El estado `sold` distingue una venta de una matrícula gratuita."""
    http, identidad, _ = entorno
    identidad["uid"] = BRUNO
    alumnos = (await http.get(f"{LEARNING}/courses/{CURSO}/students")).json()
    por_id = {a["id"]: a for a in alumnos}
    assert por_id[ANA]["commercial_state"] == "sold"
    assert por_id[CARLA]["commercial_state"] == "none"


@pytest.mark.asyncio
async def test_una_solicitud_viva_se_ve_como_en_revision(entorno):
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    await _pedir(http)

    identidad["uid"] = BRUNO
    alumnos = (await http.get(f"{LEARNING}/courses/{CURSO}/students")).json()
    por_id = {a["id"]: a for a in alumnos}
    assert por_id[ANA]["commercial_state"] == "under_review"


@pytest.mark.asyncio
async def test_un_usuario_ajeno_recibe_403_y_no_una_lista_vacia(entorno):
    """Vacía le diría que el curso no tiene alumnos, que también es información."""
    http, identidad, _ = entorno
    identidad["uid"] = CARLA
    assert (await http.get(f"{LEARNING}/courses/{CURSO}/students")).status_code == 403


@pytest.mark.asyncio
async def test_los_filtros_se_aplican_ANTES_de_paginar(entorno):
    """Filtrar después del `limit` pierde gente sin decirlo.

    Se piden 20, la base devuelve 20, el filtro deja 6: la página sale con 6 y
    la siguiente se salta 14 personas que sí cumplían. Aquí las dos matrículas
    están sin empezar, así que pedir `limit=1` con filtro tiene que devolver
    exactamente 1 en la primera página y 1 en la segunda.
    """
    http, identidad, _ = entorno
    identidad["uid"] = BRUNO
    primera = await http.get(
        f"{LEARNING}/courses/{CURSO}/students?state=not_started&limit=1&offset=0"
    )
    segunda = await http.get(
        f"{LEARNING}/courses/{CURSO}/students?state=not_started&limit=1&offset=1"
    )
    assert len(primera.json()) == 1, primera.json()
    assert len(segunda.json()) == 1, segunda.json()
    assert primera.json()[0]["id"] != segunda.json()[0]["id"]


@pytest.mark.asyncio
async def test_la_lista_no_lleva_datos_sensibles(entorno):
    http, identidad, sesiones = entorno
    await _arrancar_garantia(sesiones)
    await _pedir(http, motivo="technical_problem")

    identidad["uid"] = BRUNO
    crudo = (await http.get(f"{LEARNING}/courses/{CURSO}/students")).text
    for prohibido in ("explanation", "review_notes", "external_refund_id", "pi_1"):
        assert prohibido not in crudo, prohibido


# --------------------------------------------------------------------------- #
# 6. Recompra sin garantía
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_devolucion_previa_no_hay_nada_que_aceptar(entorno):
    http, _, _ = entorno
    cuerpo = (await http.get(f"{PAGOS}/courses/{CURSO}/repurchase-notice")).json()
    assert cuerpo["requires_acceptance"] is False


@pytest.mark.asyncio
async def test_tras_usar_la_garantia_se_exige_aceptar(entorno):
    http, _, sesiones = entorno
    from app.modules.refunds import service as devoluciones
    from app.modules.refunds.models import CourseRefundWindow

    await _arrancar_garantia(sesiones)
    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        await db.commit()

    cuerpo = (await http.get(f"{PAGOS}/courses/{CURSO}/repurchase-notice")).json()
    assert cuerpo["requires_acceptance"] is True
    # El TEXTO viene del servidor: es lo que hay que poder demostrar después.
    assert "garantía" in cuerpo["notice"]
    assert cuerpo["policy_version"]
    assert cuerpo["checkbox_label"]

    # Y una vez aceptado, deja de pedirse.
    aceptar = await http.post(
        f"{PAGOS}/repurchase-acceptance", json={"course_id": CURSO, "accepted": True}
    )
    assert aceptar.status_code == 204
    despues = (await http.get(f"{PAGOS}/courses/{CURSO}/repurchase-notice")).json()
    assert despues["requires_acceptance"] is False


async def politicas_de_gobernanza(db) -> None:
    from app.modules.gobernanza import politicas

    await politicas.sembrar_recompra(db)
    await db.commit()


async def _lista_para_recomprar(sesiones) -> None:
    """Garantia usada: la siguiente compra exige aceptar la condicion."""
    from app.modules.refunds import service as devoluciones
    from app.modules.refunds.models import CourseRefundWindow

    await _arrancar_garantia(sesiones)
    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        await db.commit()


@pytest.mark.asyncio
async def test_si_falla_la_anotacion_la_aceptacion_y_el_consentimiento_siguen(
    entorno, monkeypatch
):
    """LOS DOS SAVEPOINTS SEPARADOS SON EL MOTIVO DE ESTA PRUEBA.

    Compartiendo uno, un fallo al anotar en la auditoria deshacia tambien el
    `consent_record` que ya se habia creado bien: se perdia la prueba del
    consentimiento por no poder escribir su nota. El consentimiento es el dato
    con valor legal; la nota es el rastro.
    """
    from app.modules.gobernanza import auditoria
    from app.modules.gobernanza.models import ConsentRecord
    from app.modules.refunds.models import RefundPolicyAcceptance

    http, _, sesiones = entorno
    await _lista_para_recomprar(sesiones)
    async with sesiones() as db:
        await politicas_de_gobernanza(db)

    async def _revienta(*_a, **_k):
        raise RuntimeError("la auditoria se cayo")

    monkeypatch.setattr(auditoria, "anotar", _revienta)

    respuesta = await http.post(
        f"{PAGOS}/repurchase-acceptance", json={"course_id": CURSO, "accepted": True}
    )
    assert respuesta.status_code == 204, respuesta.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(RefundPolicyAcceptance)) == 1
        assert await db.scalar(select(func.count()).select_from(ConsentRecord)) == 1


@pytest.mark.asyncio
async def test_si_falla_el_consentimiento_la_aceptacion_sigue_y_se_anota(
    entorno, monkeypatch
):
    """LO ACCESORIO NO PUEDE TUMBAR LO PRINCIPAL.

    `refund_policy_acceptances` es la que consulta el checkout para dejar
    comprar. Si se perdiera por un fallo al escribir la trazabilidad anadida,
    la compra quedaria bloqueada por un problema que no es de quien compra.
    """
    from app.modules.gobernanza import consentimientos
    from app.modules.gobernanza.models import AuditEvent, ConsentRecord
    from app.modules.refunds.models import RefundPolicyAcceptance

    http, _, sesiones = entorno
    await _lista_para_recomprar(sesiones)
    async with sesiones() as db:
        await politicas_de_gobernanza(db)

    async def _revienta(*_a, **_k):
        raise RuntimeError("el consentimiento se cayo")

    monkeypatch.setattr(consentimientos, "registrar", _revienta)

    respuesta = await http.post(
        f"{PAGOS}/repurchase-acceptance", json={"course_id": CURSO, "accepted": True}
    )
    assert respuesta.status_code == 204, respuesta.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(RefundPolicyAcceptance)) == 1
        assert await db.scalar(select(func.count()).select_from(ConsentRecord)) == 0
        # La nota se escribe igual, con `consent_id` vacio: dice lo que paso.
        notas = list(await db.scalars(select(AuditEvent)))
        assert len(notas) == 1 and notas[0].action == "consent.accepted"


@pytest.mark.asyncio
async def test_sin_la_politica_sembrada_la_recompra_no_se_bloquea(entorno):
    """El caso normal hasta que alguien llame al endpoint de siembra.

    Bloquear una compra porque una tabla de trazabilidad esta vacia seria una
    regresion causada por lo accesorio.
    """
    from app.modules.gobernanza.models import ConsentRecord
    from app.modules.refunds.models import RefundPolicyAcceptance

    http, _, sesiones = entorno
    await _lista_para_recomprar(sesiones)  # SIN sembrar ninguna politica

    respuesta = await http.post(
        f"{PAGOS}/repurchase-acceptance", json={"course_id": CURSO, "accepted": True}
    )
    assert respuesta.status_code == 204, respuesta.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(RefundPolicyAcceptance)) == 1
        assert await db.scalar(select(func.count()).select_from(ConsentRecord)) == 0


@pytest.mark.asyncio
async def test_no_se_puede_aceptar_sin_marcar_la_casilla(entorno):
    http, _, sesiones = entorno
    from app.modules.refunds import service as devoluciones
    from app.modules.refunds.models import CourseRefundWindow

    await _arrancar_garantia(sesiones)
    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
        ventana.refund_used_at = devoluciones.ahora()
        await db.commit()

    respuesta = await http.post(
        f"{PAGOS}/repurchase-acceptance", json={"course_id": CURSO, "accepted": False}
    )
    assert respuesta.status_code == 422
    assert "acceptance_required" in respuesta.text


# --------------------------------------------------------------------------- #
# 7. Apagado es apagado
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_con_la_funcion_apagada_no_se_puede_pedir(entorno):
    http, _, sesiones = entorno
    await _arrancar_garantia(sesiones)
    ajustes = get_settings()
    ajustes.feature_course_refunds = False
    try:
        respuesta = await _pedir(http)
        elegibilidad = await http.get(f"{PAGOS}/courses/{CURSO}/refund-eligibility")
    finally:
        ajustes.feature_course_refunds = True

    assert respuesta.status_code == 503
    # Pero la elegibilidad SÍ responde: la ficha del curso tiene que pintarse.
    assert elegibilidad.status_code == 200
    assert elegibilidad.json()["reason_code"] == "disabled"
