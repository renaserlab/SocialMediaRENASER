"""La admisión de eventos: no hay autopublicación y aprobar tiene reglas.

Lo que esto defiende, en una frase por bloque:

  - Un evento nace BORRADOR y nadie lo ve.
  - Enviarlo congela una versión y no lo publica.
  - Curaduría PUNTÚA; administración DECIDE. No es la misma persona ni el mismo
    permiso, y `moderator` —que puede moderar contenido— no aprueba eventos.
  - Aprobar exige 85 y cero fallas críticas. Condicional, de 80 a 84.
  - Publicar exige estar aprobado y no tener requisitos pendientes.
  - Nadie aprueba ni publica su propio evento.
  - El sello «Seleccionado por Z» solo aparece con una aprobación real.
  - Los eventos que ya existían siguen viéndose y NO reciben el sello.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Event
from app.modules.events import esquema
from app.modules.events.models import EventOperations, EventVersion
from app.modules.gobernanza.models import AuditEvent
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

EVENTOS = "/api/v1/events"
ADMIN = "/api/v1/admin/events"
CATALOGO = "/api/v1/catalog"

ORG = "cccccccc-1111-0000-0000-000000000001"
OTRA_ORG = "cccccccc-1111-0000-0000-000000000002"
CURADORA = "dddddddd-1111-0000-0000-000000000001"
ADMINISTRA = "dddddddd-1111-0000-0000-000000000002"
ADMIN_QUE_ORGANIZA = "dddddddd-1111-0000-0000-000000000003"
HEREDADO = "eeeeeeee-1111-0000-0000-0000000000f1"

#: Un puntaje que aprueba: 90 sobre 100.
APRUEBA = {
    "propuesta": 18,
    "trayectoria": 14,
    "programa": 14,
    "recinto": 13,
    "seguridad": 13,
    "precio": 9,
    "accesibilidad": 5,
    "afinidad": 4,
}
#: 82: solo llega a condicional.
CONDICIONA = {**APRUEBA, "propuesta": 10}
#: 75: no llega ni a condicional.
NO_LLEGA = {**APRUEBA, "propuesta": 10, "trayectoria": 7}


def _borrador(**extra):
    return {
        "title": "Cena de autor en Barranco",
        "description": "Una cena de siete tiempos con la chef, en su cocina.",
        "promise": "Cenarás lo que la chef cocina para su familia.",
        "category": "gastronomia",
        "timezone": "America/Lima",
        "starts_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        "location": "Barranco, Lima",
        "event_type": "presential",
        "capacity": 20,
        **extra,
    }


@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    async with sesiones() as db:
        db.add(Profile(id=ORG, full_name="Org", username="org", role="user"))
        db.add(Profile(id=OTRA_ORG, full_name="Otra", username="otra", role="user"))
        db.add(Profile(id=CURADORA, full_name="Cura", username="cura", role="moderator"))
        db.add(Profile(id=ADMINISTRA, full_name="Admin", username="admin", role="admin"))
        db.add(
            Profile(
                id=ADMIN_QUE_ORGANIZA,
                full_name="Admin que organiza",
                username="adminorg",
                role="admin",
            )
        )
        # Un evento HEREDADO: publicado antes de que existiera la admisión.
        db.add(
            Event(
                id=HEREDADO,
                organizer_id=OTRA_ORG,
                title="Feria de siempre",
                description="Lleva años publicándose.",
                starts_at=datetime.now(timezone.utc) + timedelta(days=10),
                event_type="presential",
                status="published",
            )
        )
        db.add(
            EventOperations(
                event_id=HEREDADO,
                workflow_status="PUBLISHED",
                selection_status="none",
                origin="legacy",
            )
        )
        await db.commit()

    identidad = {"uid": ORG}

    async def _db():
        async with sesiones() as sesion:
            yield sesion

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, identidad, sesiones
    for dep in (get_db, get_current_user, get_optional_user):
        app.dependency_overrides.pop(dep, None)
    await engine.dispose()


async def _crea_y_envia(http, identidad) -> str:
    identidad["uid"] = ORG
    creado = await http.post(EVENTOS, json=_borrador())
    assert creado.status_code == 201, creado.text
    ident = creado.json()["id"]
    enviado = await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": "Va"})
    assert enviado.status_code == 200, enviado.text
    return ident


async def _evalua(http, identidad, ident, puntajes, **extra):
    identidad["uid"] = CURADORA
    return await http.post(
        f"{ADMIN}/{ident}/review",
        json={"evidencia": "Programa completo y recinto confirmado.", **puntajes, **extra},
    )


# --------------------------------------------------------------------------- #
# Nace borrador
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_evento_nuevo_nace_borrador_y_no_lo_ve_nadie(entorno):
    http, identidad, _ = entorno
    creado = await http.post(EVENTOS, json=_borrador())
    assert creado.status_code == 201, creado.text
    assert creado.json()["workflow_status"] == "DRAFT"
    assert creado.json()["seleccionado_por_z"] is False

    listado = await http.get(f"{CATALOGO}/events")
    assert creado.json()["id"] not in {e["id"] for e in listado.json()}
    assert (
        await http.get(f"{CATALOGO}/events/{creado.json()['id']}")
    ).status_code == 404


@pytest.mark.asyncio
async def test_la_ruta_antigua_del_catalogo_tampoco_publica(entorno):
    """`POST /catalog/events` nacía PUBLICADO: eso era autopublicación."""
    http, _, _ = entorno
    creado = await http.post(
        f"{CATALOGO}/events",
        json={"title": "Por la puerta de atrás", "description": "x", "event_type": "online"},
    )
    assert creado.status_code == 201, creado.text
    assert creado.json()["status"] == "draft"
    listado = await http.get(f"{CATALOGO}/events")
    assert creado.json()["id"] not in {e["id"] for e in listado.json()}


@pytest.mark.asyncio
async def test_un_borrador_incompleto_dice_que_le_falta(entorno):
    http, _, _ = entorno
    creado = await http.post(
        EVENTOS, json={"title": "Sin nada más", "description": "corto"}
    )
    assert creado.json()["motivo_para_no_enviar"] is not None
    enviado = await http.post(
        f"{EVENTOS}/{creado.json()['id']}/submit", json={"motivo": ""}
    )
    assert enviado.status_code == 422


@pytest.mark.asyncio
async def test_sin_zona_horaria_no_se_envia(entorno):
    """`starts_at` guarda el instante, no dónde ocurre.

    Sin la zona, la ficha no puede escribir «19:00 hora de Lima» sin
    inventárselo, y el blueprint la pide en el punto 3 del detalle.
    """
    http, _, _ = entorno
    creado = await http.post(EVENTOS, json=_borrador(timezone=None))
    ident = creado.json()["id"]
    assert creado.json()["motivo_para_no_enviar"] == "Falta la zona horaria del evento."
    respuesta = await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": ""})
    assert respuesta.status_code == 422
    assert "zona horaria" in respuesta.text


@pytest.mark.asyncio
async def test_un_fin_anterior_al_inicio_no_se_envia(entorno):
    """Un evento que termina antes de empezar sale impreso como un rango al
    revés en la ficha pública."""
    http, _, _ = entorno
    inicio = datetime.now(timezone.utc) + timedelta(days=30)
    creado = await http.post(
        EVENTOS,
        json=_borrador(
            starts_at=inicio.isoformat(),
            ends_at=(inicio - timedelta(hours=2)).isoformat(),
        ),
    )
    ident = creado.json()["id"]
    assert creado.json()["motivo_para_no_enviar"] == (
        "El fin no puede ser anterior al inicio."
    )
    respuesta = await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": ""})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_sin_fin_si_se_puede_enviar(entorno):
    """`ends_at` es anulable: un evento puede anunciarse sin hora de cierre."""
    http, _, _ = entorno
    creado = await http.post(EVENTOS, json=_borrador(ends_at=None))
    assert creado.json()["motivo_para_no_enviar"] is None


@pytest.mark.asyncio
async def test_el_borrador_se_guarda_a_medias(entorno):
    http, _, _ = entorno
    creado = await http.post(EVENTOS, json={"title": "Empiezo", "description": ""})
    ident = creado.json()["id"]
    parcial = await http.patch(f"{EVENTOS}/{ident}", json={"promise": "Algo bueno"})
    assert parcial.status_code == 200
    assert parcial.json()["promise"] == "Algo bueno"
    # Y no borró el título por no venir.
    assert parcial.json()["title"] == "Empiezo"


@pytest.mark.asyncio
async def test_el_ciclo_no_se_mueve_con_un_patch(entorno):
    """No hay campo editable que cambie el estado. Es lo que abre la puerta."""
    http, _, _ = entorno
    creado = await http.post(EVENTOS, json=_borrador())
    ident = creado.json()["id"]
    respuesta = await http.patch(
        f"{EVENTOS}/{ident}",
        json={"workflow_status": "PUBLISHED", "selection_status": "approved"},
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["workflow_status"] == "DRAFT"
    assert respuesta.json()["selection_status"] == "none"


@pytest.mark.asyncio
async def test_el_evento_de_otra_persona_no_existe(entorno):
    http, identidad, _ = entorno
    creado = await http.post(EVENTOS, json=_borrador())
    ident = creado.json()["id"]
    identidad["uid"] = OTRA_ORG
    assert (await http.get(f"{EVENTOS}/{ident}")).status_code == 404
    assert (await http.patch(f"{EVENTOS}/{ident}", json={"title": "Mío"})).status_code == 404
    assert (
        await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": ""})
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Enviar congela una versión
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_enviar_congela_una_version_y_no_publica(entorno):
    http, identidad, sesiones = entorno
    ident = await _crea_y_envia(http, identidad)

    ficha = (await http.get(f"{EVENTOS}/{ident}")).json()
    assert ficha["workflow_status"] == "SUBMITTED"
    assert ficha["current_version"] == 1
    assert (await http.get(f"{CATALOGO}/events/{ident}")).status_code == 404

    async with sesiones() as db:
        version = await db.scalar(select(EventVersion).where(EventVersion.event_id == ident))
    assert version.snapshot["title"] == "Cena de autor en Barranco"
    assert version.snapshot["promise"].startswith("Cenarás")


@pytest.mark.asyncio
async def test_lo_enviado_no_se_edita_por_debajo(entorno):
    """Lo que curaduría revisa no puede cambiar mientras lo revisa."""
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    respuesta = await http.patch(f"{EVENTOS}/{ident}", json={"title": "Otro título"})
    assert respuesta.status_code == 409


@pytest.mark.asyncio
async def test_corregir_y_reenviar_crea_la_segunda_version(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)

    identidad["uid"] = CURADORA
    devuelto = await http.post(
        f"{ADMIN}/{ident}/request-changes",
        json={"motivo": "Falta el nombre del recinto exacto."},
    )
    assert devuelto.status_code == 200
    assert devuelto.json()["workflow_status"] == "DRAFT"

    identidad["uid"] = ORG
    ficha = (await http.get(f"{EVENTOS}/{ident}")).json()
    assert ficha["ultima_observacion"]["reason"].startswith("Falta el nombre")
    assert ficha["editable"] is True

    await http.patch(f"{EVENTOS}/{ident}", json={"location": "Casa Tupac, Barranco"})
    await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": "Corregido"})

    versiones = (await http.get(f"{EVENTOS}/{ident}/versions")).json()
    assert [v["version"] for v in versiones] == [2, 1]
    assert versiones[0]["changed_fields"] == ["location"]
    assert versiones[1]["status"] == "superseded"


# --------------------------------------------------------------------------- #
# Puntuar no es decidir
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_aprobar_sin_evaluar_no_se_puede(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision", json={"decision": "approved", "motivo": "Me gusta"}
    )
    assert respuesta.status_code == 409
    assert "sin evaluarlo" in respuesta.text


@pytest.mark.asyncio
async def test_aprobar_por_debajo_de_85_no_se_puede(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    assert (await _evalua(http, identidad, ident, CONDICIONA)).status_code == 200

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision", json={"decision": "approved", "motivo": "Aun así"}
    )
    assert respuesta.status_code == 409
    assert "85" in respuesta.text


@pytest.mark.asyncio
async def test_una_falla_critica_impide_aprobar_aunque_el_puntaje_alcance(entorno):
    """La regla que más fácil se pierde: 90 puntos y sin plan de emergencias."""
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    assert (
        await _evalua(
            http,
            identidad,
            ident,
            APRUEBA,
            falla_critica=True,
            motivo_de_la_falla="Sin plan de contingencia y el aforo lo exige.",
        )
    ).status_code == 200

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision", json={"decision": "approved", "motivo": "Es buenísimo"}
    )
    assert respuesta.status_code == 409
    assert "falla crítica" in respuesta.text


@pytest.mark.asyncio
async def test_condicional_solo_entre_80_y_84(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, APRUEBA)  # 90

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision", json={"decision": "conditional", "motivo": "Por si acaso"}
    )
    assert respuesta.status_code == 409
    assert "80" in respuesta.text


@pytest.mark.asyncio
async def test_por_debajo_de_80_se_rechaza_y_vuelve_a_borrador(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, NO_LLEGA)

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision",
        json={"decision": "rejected", "motivo": "La trayectoria no está acreditada."},
    )
    assert respuesta.status_code == 200
    # NO existe un estado «rechazado»: vuelve a su dueño, y el rechazo queda
    # escrito con su motivo.
    assert respuesta.json()["workflow_status"] == "DRAFT"
    assert respuesta.json()["ultima_observacion"]["decision"] == "rejected"
    assert respuesta.json()["seleccionado_por_z"] is False


@pytest.mark.asyncio
async def test_toda_decision_necesita_motivo(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, APRUEBA)
    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision", json={"decision": "approved", "motivo": ""}
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_un_puntaje_fuera_de_rango_se_rechaza(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    respuesta = await _evalua(http, identidad, ident, {**APRUEBA, "propuesta": 30})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_una_evaluacion_sin_evidencia_no_se_guarda(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    identidad["uid"] = CURADORA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/review", json={"evidencia": "", **APRUEBA}
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_una_falla_critica_sin_decir_cual_no_se_guarda(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    respuesta = await _evalua(http, identidad, ident, APRUEBA, falla_critica=True)
    assert respuesta.status_code == 422


# --------------------------------------------------------------------------- #
# Permisos
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_moderacion_evalua_pero_no_aprueba(entorno):
    """`moderator` revisa contenido. Aprobar es autorizar que se venda algo."""
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    assert (await _evalua(http, identidad, ident, APRUEBA)).status_code == 200

    identidad["uid"] = CURADORA
    for ruta, cuerpo in (
        (f"{ADMIN}/{ident}/decision", {"decision": "approved", "motivo": "Va"}),
        (f"{ADMIN}/{ident}/publish", None),
    ):
        respuesta = await http.post(ruta, json=cuerpo)
        assert respuesta.status_code == 403, ruta


@pytest.mark.asyncio
async def test_el_organizador_no_entra_en_la_cola_de_revision(entorno):
    http, identidad, _ = entorno
    await _crea_y_envia(http, identidad)
    identidad["uid"] = ORG
    assert (await http.get(f"{ADMIN}/pending")).status_code == 403


@pytest.mark.asyncio
async def test_nadie_aprueba_su_propio_evento_ni_siendo_administrador(entorno):
    """La primera decisión cerrada del blueprint: nadie se aprueba a sí mismo."""
    http, identidad, _ = entorno
    identidad["uid"] = ADMIN_QUE_ORGANIZA
    creado = await http.post(EVENTOS, json=_borrador())
    ident = creado.json()["id"]
    await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": ""})
    await _evalua(http, identidad, ident, APRUEBA)

    identidad["uid"] = ADMIN_QUE_ORGANIZA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision", json={"decision": "approved", "motivo": "El mío"}
    )
    assert respuesta.status_code == 403
    assert "su propio evento" in respuesta.text


@pytest.mark.asyncio
async def test_una_cuenta_cualquiera_no_ve_el_expediente(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    identidad["uid"] = OTRA_ORG
    assert (await http.get(f"{ADMIN}/{ident}")).status_code == 403


@pytest.mark.asyncio
async def test_el_organizador_no_ve_los_ocho_puntajes(entorno):
    """La evaluación es la deliberación; enseñarla la convierte en un regateo."""
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, APRUEBA)

    identidad["uid"] = ORG
    ficha = (await http.get(f"{EVENTOS}/{ident}")).json()
    for prohibido in ("evaluacion", "propuesta", "trayectoria", "total"):
        assert prohibido not in ficha, prohibido


# --------------------------------------------------------------------------- #
# Publicar
# --------------------------------------------------------------------------- #


async def _hasta_publicar(http, identidad) -> str:
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, APRUEBA)
    identidad["uid"] = ADMINISTRA
    await http.post(
        f"{ADMIN}/{ident}/decision",
        json={"decision": "approved", "motivo": "Cumple con holgura."},
    )
    return ident


@pytest.mark.asyncio
async def test_publicar_sin_aprobacion_no_se_puede(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(f"{ADMIN}/{ident}/publish")
    assert respuesta.status_code == 409
    assert "SUBMITTED" in respuesta.text


@pytest.mark.asyncio
async def test_aprobado_y_publicado_aparece_con_su_sello(entorno):
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)

    aprobado = (await http.get(f"{ADMIN}/{ident}")).json()
    assert aprobado["workflow_status"] == "APPROVED"
    assert aprobado["seleccionado_por_z"] is True
    # Aprobado NO es publicado: todavía no se ve.
    assert (await http.get(f"{CATALOGO}/events/{ident}")).status_code == 404

    publicado = await http.post(f"{ADMIN}/{ident}/publish")
    assert publicado.status_code == 200
    ficha = (await http.get(f"{CATALOGO}/events/{ident}")).json()
    assert ficha["selection_status"] == "approved"
    assert ficha["seleccionado_por_z"] is True


@pytest.mark.asyncio
async def test_un_condicional_no_lleva_sello(entorno):
    """80-84 tiene un pendiente. El sello dice «aprobado», no «casi»."""
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, CONDICIONA)
    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{ADMIN}/{ident}/decision",
        json={"decision": "conditional", "motivo": "Falta el seguro; es subsanable."},
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["workflow_status"] == "CONDITIONAL"
    assert respuesta.json()["seleccionado_por_z"] is False


@pytest.mark.asyncio
async def test_un_requisito_pendiente_impide_publicar(entorno):
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)

    identidad["uid"] = CURADORA
    await http.put(
        f"{ADMIN}/{ident}/documents",
        json={"kind": "permiso_municipal", "status": "pending", "blocks_publication": True},
    )
    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(f"{ADMIN}/{ident}/publish")
    assert respuesta.status_code == 409
    assert "permiso_municipal" in respuesta.text

    identidad["uid"] = CURADORA
    await http.put(
        f"{ADMIN}/{ident}/documents",
        json={"kind": "permiso_municipal", "status": "approved", "blocks_publication": True},
    )
    identidad["uid"] = ADMINISTRA
    assert (await http.post(f"{ADMIN}/{ident}/publish")).status_code == 200


@pytest.mark.asyncio
async def test_un_permiso_vencido_bloquea_aunque_este_aprobado(entorno):
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)
    identidad["uid"] = CURADORA
    await http.put(
        f"{ADMIN}/{ident}/documents",
        json={
            "kind": "seguro",
            "status": "approved",
            "expires_at": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
        },
    )
    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(f"{ADMIN}/{ident}/publish")
    assert respuesta.status_code == 409
    assert "seguro" in respuesta.text


@pytest.mark.asyncio
async def test_suspender_lo_saca_del_catalogo_y_reanudar_lo_devuelve(entorno):
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)
    identidad["uid"] = ADMINISTRA
    await http.post(f"{ADMIN}/{ident}/publish")

    suspendido = await http.post(
        f"{ADMIN}/{ident}/suspend", json={"motivo": "Un reporte por revisar."}
    )
    assert suspendido.status_code == 200
    assert suspendido.json()["workflow_status"] == "SUSPENDED"
    assert (await http.get(f"{CATALOGO}/events/{ident}")).status_code == 404

    reanudado = await http.post(
        f"{ADMIN}/{ident}/resume", json={"motivo": "Resuelto, sin incidencia."}
    )
    assert reanudado.json()["workflow_status"] == "PUBLISHED"
    assert (await http.get(f"{CATALOGO}/events/{ident}")).status_code == 200


@pytest.mark.asyncio
async def test_suspender_sin_motivo_no_se_puede(entorno):
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)
    identidad["uid"] = ADMINISTRA
    await http.post(f"{ADMIN}/{ident}/publish")
    respuesta = await http.post(f"{ADMIN}/{ident}/suspend", json={"motivo": "   "})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_publicar_dos_veces_no_se_puede(entorno):
    """Idempotencia por transición: la segunda no encuentra desde dónde ir."""
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)
    identidad["uid"] = ADMINISTRA
    assert (await http.post(f"{ADMIN}/{ident}/publish")).status_code == 200
    segunda = await http.post(f"{ADMIN}/{ident}/publish")
    assert segunda.status_code == 409
    assert "PUBLISHED" in segunda.text


# --------------------------------------------------------------------------- #
# Las dos puertas de atrás del catálogo
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_cancelar_una_reserva_no_ensena_un_evento_que_no_existe_para_ti(entorno):
    """`DELETE .../reserve` devolvía la ficha ENTERA de cualquier evento.

    `reservar` comprobaba que el evento fuera visible; `cancelar` no. Con el id
    de un borrador ajeno —o de uno suspendido por un motivo grave— cualquier
    cuenta recibía 200 con título, descripción, recinto, aforo y organizador.
    """
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)

    identidad["uid"] = OTRA_ORG
    respuesta = await http.delete(f"{CATALOGO}/events/{ident}/reserve")
    assert respuesta.status_code == 404, respuesta.text
    assert "Cena de autor" not in respuesta.text


@pytest.mark.asyncio
async def test_lo_ya_aprobado_no_se_edita_por_la_ruta_antigua(entorno):
    """`PATCH /catalog/events/{id}` esquivaba la máquina de estados entera.

    Se aprobaba un evento inocuo, se publicaba con su sello, y después se
    reescribían título, descripción y recinto por la ruta de siempre: seguía
    PUBLICADO, con sello, sobre contenido que nadie revisó, sin versión nueva y
    sin una línea de auditoría.
    """
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)
    identidad["uid"] = ADMINISTRA
    await http.post(f"{ADMIN}/{ident}/publish")

    identidad["uid"] = ORG
    respuesta = await http.patch(
        f"{CATALOGO}/events/{ident}",
        json={"title": "Otra cosa completamente distinta"},
    )
    assert respuesta.status_code == 409, respuesta.text

    ficha = (await http.get(f"{CATALOGO}/events/{ident}")).json()
    assert ficha["title"] == "Cena de autor en Barranco"


@pytest.mark.asyncio
async def test_moderacion_no_reescribe_el_evento_de_otra_persona(entorno):
    """`require_owner_or_admin` incluye `moderator`, y con eso curaduría podía
    reescribir el contenido público de cualquier evento ajeno: algo que ninguna
    ruta del módulo nuevo le concede."""
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    identidad["uid"] = CURADORA
    respuesta = await http.patch(
        f"{CATALOGO}/events/{ident}", json={"title": "Lo cambio yo"}
    )
    assert respuesta.status_code == 404, respuesta.text


@pytest.mark.asyncio
async def test_un_borrador_propio_si_se_edita_por_la_ruta_antigua(entorno):
    """La compatibilidad que SÍ se conserva: editar lo que aún es borrador."""
    http, identidad, _ = entorno
    creado = await http.post(EVENTOS, json=_borrador())
    ident = creado.json()["id"]
    respuesta = await http.patch(
        f"{CATALOGO}/events/{ident}", json={"title": "Mejor así"}
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["title"] == "Mejor así"


@pytest.mark.asyncio
async def test_decidir_sobre_un_evento_que_no_existe_no_lo_distingue(entorno):
    """403 antes que 404: si no, sondear ids dice cuáles son eventos reales."""
    http, identidad, _ = entorno
    real = await _crea_y_envia(http, identidad)
    inventado = "eeeeeeee-1111-0000-0000-0000000000aa"

    identidad["uid"] = OTRA_ORG
    cuerpo = {"decision": "approved", "motivo": "Va"}
    de_uno = await http.post(f"{ADMIN}/{real}/decision", json=cuerpo)
    de_otro = await http.post(f"{ADMIN}/{inventado}/decision", json=cuerpo)
    assert de_uno.status_code == de_otro.status_code == 403


@pytest.mark.asyncio
async def test_nadie_se_puntua_a_si_mismo(entorno):
    """Aprobar lo propio ya estaba cerrado; PUNTUARLO era la puerta de al lado.

    Una cuenta de curaduría que organiza podía ponerse 100/100, y el puntaje es
    exactamente lo que habilita la aprobación de otra persona: quien fabrica la
    condición de aprobación acaba siendo el propio organizador.
    """
    http, identidad, _ = entorno
    identidad["uid"] = ADMIN_QUE_ORGANIZA
    creado = await http.post(EVENTOS, json=_borrador())
    ident = creado.json()["id"]
    await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": ""})

    for ruta, cuerpo in (
        (f"{ADMIN}/{ident}/review", {"evidencia": "Está genial", **APRUEBA}),
        (f"{ADMIN}/{ident}/request-changes", {"motivo": "Me lo devuelvo"}),
        (
            f"{ADMIN}/{ident}/documents",
            {"kind": "seguro", "status": "approved", "blocks_publication": False},
        ),
    ):
        respuesta = (
            await http.put(ruta, json=cuerpo)
            if ruta.endswith("documents")
            else await http.post(ruta, json=cuerpo)
        )
        assert respuesta.status_code == 403, ruta


@pytest.mark.asyncio
async def test_quien_organiza_no_lee_su_propio_expediente_interno(entorno):
    """Ni siendo administración: los ocho puntajes son la deliberación."""
    http, identidad, _ = entorno
    identidad["uid"] = ADMIN_QUE_ORGANIZA
    creado = await http.post(EVENTOS, json=_borrador())
    ident = creado.json()["id"]
    await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": ""})

    respuesta = await http.get(f"{ADMIN}/{ident}")
    assert respuesta.status_code == 403


# --------------------------------------------------------------------------- #
# Herencia, auditoría y listados
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_evento_heredado_sigue_visible_y_sin_sello(entorno):
    """No desaparece. Y no se le regala una aprobación que nadie dio."""
    http, _, _ = entorno
    ficha = await http.get(f"{CATALOGO}/events/{HEREDADO}")
    assert ficha.status_code == 200
    assert ficha.json()["selection_status"] == "none"
    assert ficha.json()["seleccionado_por_z"] is False

    listado = (await http.get(f"{CATALOGO}/events")).json()
    assert HEREDADO in {e["id"] for e in listado}


@pytest.mark.asyncio
async def test_cada_decision_deja_rastro(entorno):
    http, identidad, sesiones = entorno
    ident = await _hasta_publicar(http, identidad)
    identidad["uid"] = ADMINISTRA
    await http.post(f"{ADMIN}/{ident}/publish")

    async with sesiones() as db:
        filas = list(
            await db.scalars(select(AuditEvent).where(AuditEvent.entity_id == ident))
        )
    acciones = {f.action for f in filas}
    assert {"event.draft_created", "event.submitted", "event.reviewed",
            "event.approved", "event.published"} <= acciones
    aprobacion = next(f for f in filas if f.action == "event.approved")
    assert aprobacion.reason == "Cumple con holgura."
    assert aprobacion.previous_state == "SUBMITTED"
    assert aprobacion.new_state == "APPROVED"
    assert aprobacion.actor_id == ADMINISTRA


@pytest.mark.asyncio
async def test_mis_eventos_trae_lo_que_pidio_la_revision(entorno):
    """La lista devolvía `ultima_observacion: null` SIEMPRE.

    A quien le devolvían el evento con correcciones veía una fila «Borrador»
    sin ninguna señal de que le habían pedido algo, y solo se enteraba si lo
    abría. Mismo fallo que tenía la cola: un dato ausente que se lee como «no
    hay nada que hacer».
    """
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    identidad["uid"] = CURADORA
    await http.post(
        f"{ADMIN}/{ident}/request-changes",
        json={"motivo": "Falta el nombre del recinto."},
    )

    identidad["uid"] = ORG
    mios = (await http.get(f"{EVENTOS}/mine")).json()
    assert mios[0]["ultima_observacion"] is not None
    assert mios[0]["ultima_observacion"]["decision"] == "changes_requested"
    assert mios[0]["ultima_observacion"]["reason"].startswith("Falta el nombre")


@pytest.mark.asyncio
async def test_subir_un_puntaje_deja_dicho_cual_habia(entorno):
    """La evaluación se sobrescribe en su sitio: sin el «antes», pasar un 75 a
    un 90 no dejaba constancia de que hubiera habido un 75."""
    http, identidad, sesiones = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, NO_LLEGA)
    await _evalua(http, identidad, ident, APRUEBA)

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(AuditEvent).where(AuditEvent.action == "event.reviewed")
            )
        )
    assert len(filas) == 2
    primera, segunda = sorted(filas, key=lambda f: f.payload["total"])
    assert primera.payload["antes"] is None
    assert segunda.payload["antes"]["total"] == 75
    assert segunda.payload["antes"]["propuesta"] == 10


@pytest.mark.asyncio
async def test_editar_un_borrador_deja_rastro_de_que_campos_se_tocaron(entorno):
    """Editar un condicional cambia justo lo que curaduría acaba de mirar."""
    http, identidad, sesiones = entorno
    creado = await http.post(EVENTOS, json=_borrador())
    ident = creado.json()["id"]
    await http.patch(f"{EVENTOS}/{ident}", json={"title": "Otro", "location": "Otro sitio"})

    async with sesiones() as db:
        fila = await db.scalar(
            select(AuditEvent).where(AuditEvent.action == "event.draft_updated")
        )
    assert fila is not None
    assert fila.payload["campos"] == ["location", "title"]
    # Los VALORES no se archivan: la versión ya los guarda y esto convertiría
    # la auditoría en una copia del evento.
    assert "Otro sitio" not in str(fila.payload)


@pytest.mark.asyncio
async def test_reenviar_un_condicional_audita_de_donde_venia(entorno):
    """`previous_state` estaba fijo en DRAFT, y submit también sale de
    CONDITIONAL: el reenvío quedaba registrado con un «antes» falso."""
    http, identidad, sesiones = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, CONDICIONA)
    identidad["uid"] = ADMINISTRA
    await http.post(
        f"{ADMIN}/{ident}/decision",
        json={"decision": "conditional", "motivo": "Falta el seguro."},
    )
    identidad["uid"] = ORG
    await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": "Ya está"})

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(AuditEvent).where(AuditEvent.action == "event.submitted")
            )
        )
    assert [f.previous_state for f in filas] == ["DRAFT", "CONDITIONAL"]


@pytest.mark.asyncio
async def test_reservar_no_borra_el_sello_de_la_respuesta(entorno):
    """La respuesta de reservar decía `selection_status: none`.

    El mismo evento contaba dos cosas distintas según por qué ruta se
    preguntara, y una pantalla que pintase la ficha con esa respuesta hacía
    desaparecer el sello al reservar.
    """
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)
    identidad["uid"] = ADMINISTRA
    await http.post(f"{ADMIN}/{ident}/publish")

    identidad["uid"] = OTRA_ORG
    respuesta = await http.post(f"{CATALOGO}/events/{ident}/reserve")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["seleccionado_por_z"] is True
    cancelada = await http.delete(f"{CATALOGO}/events/{ident}/reserve")
    assert cancelada.json()["seleccionado_por_z"] is True


@pytest.mark.asyncio
async def test_la_cola_de_revision_trae_lo_enviado(entorno):
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    identidad["uid"] = CURADORA
    cola = (await http.get(f"{ADMIN}/pending")).json()
    assert [e["id"] for e in cola] == [ident]
    assert cola[0]["organizer_id"] == ORG


@pytest.mark.asyncio
async def test_un_evento_aprobado_sigue_en_la_cola_hasta_publicarlo(entorno):
    """Aprobado no es publicado. Antes salía de la cola al aprobarlo, y si
    administración cerraba la revisión sin pulsar «Publicar», el evento se
    quedaba aprobado sin ninguna lista desde la que volver a encontrarlo."""
    http, identidad, _ = entorno
    ident = await _hasta_publicar(http, identidad)  # aprobado, sin publicar

    identidad["uid"] = CURADORA
    cola = {e["id"]: e for e in (await http.get(f"{ADMIN}/pending")).json()}
    assert ident in cola
    assert cola[ident]["workflow_status"] == "APPROVED"

    identidad["uid"] = ADMINISTRA
    assert (await http.post(f"{ADMIN}/{ident}/publish")).status_code == 200
    identidad["uid"] = CURADORA
    cola = {e["id"] for e in (await http.get(f"{ADMIN}/pending")).json()}
    assert ident not in cola


@pytest.mark.asyncio
async def test_la_cola_dice_cual_ya_esta_evaluado(entorno):
    """La cola decía «sin evaluar» en TODAS las filas, tuvieran puntaje o no.

    No era un dato que faltara: era un dato falso. `pendientes` no cargaba la
    evaluación y la pantalla lo interpretaba como que nadie lo había mirado.
    """
    http, identidad, _ = entorno
    evaluado = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, evaluado, APRUEBA)
    identidad["uid"] = ORG
    sin_evaluar = await _crea_y_envia(http, identidad)

    identidad["uid"] = CURADORA
    cola = {e["id"]: e for e in (await http.get(f"{ADMIN}/pending")).json()}

    assert cola[evaluado]["evaluacion"] is not None
    assert cola[evaluado]["evaluacion"]["total"] == 90
    assert cola[sin_evaluar]["evaluacion"] is None


@pytest.mark.asyncio
async def test_la_evaluacion_de_una_version_vieja_no_cuenta_por_la_nueva(entorno):
    """Evaluar la versión 1 no dice nada de la 2.

    Colgarla igual haría creer que lo último enviado ya se miró, que es peor
    que no decir nada.
    """
    http, identidad, _ = entorno
    ident = await _crea_y_envia(http, identidad)
    await _evalua(http, identidad, ident, APRUEBA)

    identidad["uid"] = CURADORA
    await http.post(
        f"{ADMIN}/{ident}/request-changes", json={"motivo": "Falta el recinto exacto."}
    )
    identidad["uid"] = ORG
    await http.patch(f"{EVENTOS}/{ident}", json={"location": "Casa Tupac"})
    await http.post(f"{EVENTOS}/{ident}/submit", json={"motivo": "Corregido"})

    identidad["uid"] = CURADORA
    cola = (await http.get(f"{ADMIN}/pending")).json()
    assert cola[0]["current_version"] == 2
    assert cola[0]["evaluacion"] is None


@pytest.mark.asyncio
async def test_mis_eventos_solo_trae_los_mios(entorno):
    http, identidad, _ = entorno
    mio = await _crea_y_envia(http, identidad)
    identidad["uid"] = OTRA_ORG
    await http.post(EVENTOS, json=_borrador(title="El de la otra"))

    identidad["uid"] = ORG
    mios = (await http.get(f"{EVENTOS}/mine")).json()
    assert [e["id"] for e in mios] == [mio]


@pytest.mark.asyncio
async def test_la_paginacion_de_mis_eventos_no_repite_ni_pierde(entorno):
    http, _, _ = entorno
    for i in range(5):
        await http.post(EVENTOS, json=_borrador(title=f"Evento {i}"))
    primera = (await http.get(f"{EVENTOS}/mine?limit=2&offset=0")).json()
    segunda = (await http.get(f"{EVENTOS}/mine?limit=2&offset=2")).json()
    tercera = (await http.get(f"{EVENTOS}/mine?limit=2&offset=4")).json()
    todos = [e["id"] for e in primera + segunda + tercera]
    assert len(todos) == len(set(todos)) == 5


@pytest.mark.asyncio
async def test_el_listado_no_pide_una_consulta_por_evento(entorno):
    """Sin N+1: cinco eventos no cuestan cinco veces lo que uno.

    Se compara el número de consultas con uno y con cinco en vez de fijar un
    tope a ojo: un número mágico se queda obsoleto y deja de significar nada.
    """
    from sqlalchemy import event as sa_event

    http, identidad, sesiones = entorno
    ident = await _crea_y_envia(http, identidad)

    contador = {"n": 0}
    motor = sesiones.kw["bind"]

    def contar(*_args, **_kwargs):
        contador["n"] += 1

    sa_event.listen(motor.sync_engine, "before_cursor_execute", contar)
    try:
        identidad["uid"] = CURADORA
        await http.get(f"{ADMIN}/pending")
        con_uno = contador["n"]

        identidad["uid"] = ORG
        for i in range(4):
            creado = await http.post(EVENTOS, json=_borrador(title=f"Otro {i}"))
            await http.post(f"{EVENTOS}/{creado.json()['id']}/submit", json={"motivo": ""})

        identidad["uid"] = CURADORA
        contador["n"] = 0
        cola = await http.get(f"{ADMIN}/pending")
        con_cinco = contador["n"]
    finally:
        sa_event.remove(motor.sync_engine, "before_cursor_execute", contar)

    assert len(cola.json()) == 5
    assert ident in {e["id"] for e in cola.json()}
    # Cinco eventos no pueden costar cinco veces lo que uno.
    assert con_cinco < con_uno * 3, (con_uno, con_cinco)


@pytest.mark.asyncio
async def test_sin_la_migracion_0060_las_rutas_responden_503(entorno):
    """La regla del proyecto: desplegar no puede exigir la migración puesta."""
    http, _, sesiones = entorno
    async with sesiones() as db:
        conexion = await db.connection()
        for tabla in (
            "event_admission_decisions",
            "event_admission_reviews",
            "event_documents",
            "event_versions",
            "event_operations",
        ):
            await conexion.exec_driver_sql(f"drop table if exists {tabla}")
        await db.commit()
    esquema.olvidar()

    respuesta = await http.get(f"{EVENTOS}/mine")
    assert respuesta.status_code == 503
    assert "events_workflow_not_available" in respuesta.text
    # Y el catálogo sigue funcionando exactamente igual.
    assert (await http.get(f"{CATALOGO}/events")).status_code == 200
    assert (await http.get(f"{CATALOGO}/events/{HEREDADO}")).status_code == 200
