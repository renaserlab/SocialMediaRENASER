"""Z Servicios, Bloque 1A: contratos de la API, bandera y separación de vistas.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. CON LA BANDERA APAGADA NO SE VE NADA: cada ruta contesta 503
     `services_disabled` y no toca la base.
  2. LAS PUERTAS VAN EN ORDEN: sesión, rol (en administración) y bandera. Una
     cuenta sin permisos no distingue un servidor configurado de uno que no.
  3. SOLO EXISTEN LAS RUTAS QUE RESPONDEN DE VERDAD. Las del Bloque 1B tienen
     contrato y NINGUNA ruta; ninguna ruta de la aplicación está duplicada.
  4. EL ESTADO NO SE CAMBIA CON UN PATCH: el cuerpo no admite `status`.
  5. LO PRIVADO NO SE FILTRA: ni rutas de documentos, ni notas internas, ni
     quién decidió en la vista de quien postula; y la vista pública no lleva
     nada legal ni tributario.
  6. EMPEZAR ES IDEMPOTENTE y la bandeja pagina por cursor sin repetir.

SQLite desde `Base.metadata`, como el resto de la suite. Lo que solo impone
PostgreSQL —disparadores, RLS, privilegios— está en
`test_servicios_migracion_0086.py`.
"""

from __future__ import annotations

import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import create_app
from app.modules.profiles.models import Profile
from app.modules.services import esquema, permissions, schemas, service
from app.modules.services.models import (
    POLITICA_PUBLICADA,
    PRESTADOR_ACTIVO,
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderDocument,
)
from app.modules.services.politicas import huella
from app.modules.services.router import CONTRATOS_DEL_BLOQUE_1B
from app.shared.database import Base, get_db

API = "/api/v1"
MIA = f"{API}/services/provider/application"
BANDEJA = f"{API}/admin/services/applications"

PRESTADORA = str(uuid.uuid4())
OTRA = str(uuid.uuid4())
TERCERA = str(uuid.uuid4())
MODERADOR = str(uuid.uuid4())
ADMIN = str(uuid.uuid4())

RESUMEN = "Doy clases de guitarra clásica desde hace diez años, en persona y en línea."


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _rutas(app) -> list[tuple[str, str]]:
    """Todas las rutas de la aplicación, aplanando los routers incluidos."""

    def planas(rutas, prefijo=""):
        for ruta in rutas:
            if type(ruta).__name__ == "_IncludedRouter":
                yield from planas(
                    ruta.original_router.routes, prefijo + ruta.include_context.prefix
                )
            elif getattr(ruta, "methods", None):
                for metodo in ruta.methods:
                    yield metodo, prefijo + ruta.path

    return list(planas(app.routes))


@pytest.fixture()
def encendida(monkeypatch):
    monkeypatch.setattr(get_settings(), "feature_services", True)
    esquema.olvidar()
    yield
    esquema.olvidar()


@pytest_asyncio.fixture()
async def entorno():
    """La aplicación de verdad con una base SQLite propia y cinco personas."""
    esquema.olvidar()
    app = create_app()
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    async with sesiones() as db:
        for ident, nombre, rol in (
            (PRESTADORA, "Ana", "user"),
            (OTRA, "Olga", "user"),
            (TERCERA, "Tere", "user"),
            (MODERADOR, "Mode", "moderator"),
            (ADMIN, "Adri", "admin"),
        ):
            db.add(Profile(id=ident, full_name=nombre, username=nombre.lower(), role=rol))
        await db.commit()

    quien = {"uid": PRESTADORA}

    async def _db():
        async with sesiones() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=quien["uid"], email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, quien, sesiones, app
    app.dependency_overrides.clear()
    await motor.dispose()
    esquema.olvidar()


def _como(quien: dict, uid: str) -> None:
    quien["uid"] = uid


async def _iniciar(http, *, tipo="individual", nombre="Ana Guitarra"):
    return await http.post(MIA, json={"provider_type": tipo, "display_name": nombre})


async def _publicar_terminos(sesiones, pais="PE") -> ServicePolicy:
    texto = "Condiciones del prestador de Z Servicios. " * 3
    async with sesiones() as db:
        politica = ServicePolicy(
            kind="provider_terms",
            country_code=pais,
            version=1,
            status=POLITICA_PUBLICADA,
            title="Condiciones del prestador",
            body=texto,
            body_sha256=huella(texto),
            parameters={},
            effective_at=_ahora() - timedelta(days=1),
            published_at=_ahora() - timedelta(days=1),
            published_by=ADMIN,
        )
        db.add(politica)
        await db.commit()
        return politica


async def _enviada_a_mano(sesiones, uid: str, politica: ServicePolicy, *, momento=None):
    """Una postulación ENVIADA escrita a mano: enviar es del Bloque 1B."""
    momento = momento or _ahora()
    async with sesiones() as db:
        prestador = ServiceProvider(
            profile_id=uid,
            provider_type="individual",
            display_name=f"Prestador {uid[:4]}",
            created_at=momento,
            updated_at=momento,
        )
        db.add(prestador)
        await db.flush()
        solicitud = ServiceProviderApplication(
            provider_id=prestador.id,
            status="submitted",
            summary=RESUMEN,
            terms_policy_id=politica.id,
            terms_sha256=politica.body_sha256,
            terms_accepted_at=momento,
            truthfulness_declared_at=momento,
            submitted_at=momento,
            last_submitted_at=momento,
            created_at=momento,
            updated_at=momento,
        )
        db.add(solicitud)
        await db.commit()
        return solicitud.id


# =========================================================================== #
# 1. El módulo, las rutas y los contratos
# =========================================================================== #
def test_el_modulo_se_importa_y_la_bandera_nace_apagada() -> None:
    from app.modules.services import (  # noqa: F401
        esquema as _e,
        models as _m,
        permissions as _p,
        politicas as _po,
        router as _r,
        schemas as _s,
        service as _sv,
        states as _st,
    )

    assert get_settings().__class__.model_fields["feature_services"].default is False


def test_solo_estan_las_rutas_del_bloque_1a() -> None:
    rutas = {(m, p) for m, p in _rutas(create_app()) if "/services" in p}
    assert rutas == {
        ("POST", f"{API}/services/provider/application"),
        ("GET", f"{API}/services/provider/application"),
        ("PATCH", f"{API}/services/provider/application"),
        ("GET", f"{API}/services/provider/application/history"),
        ("GET", f"{API}/admin/services/applications"),
        ("GET", f"{API}/admin/services/applications/{{application_id}}"),
        ("GET", f"{API}/admin/services/applications/{{application_id}}/history"),
    }


def test_ninguna_ruta_de_la_aplicacion_esta_duplicada() -> None:
    rutas = _rutas(create_app())
    duplicadas = [r for r, n in Counter(rutas).items() if n > 1]
    assert not duplicadas, f"rutas duplicadas: {duplicadas}"
    assert len(rutas) > 300


def test_los_contratos_del_1b_estan_fijados_y_sin_ruta() -> None:
    """Contrato sí, ruta no: nada responde «éxito» sin hacer nada."""
    rutas = set(_rutas(create_app()))
    assert len(CONTRATOS_DEL_BLOQUE_1B) == 9
    for contrato in CONTRATOS_DEL_BLOQUE_1B:
        assert (contrato.metodo, API + contrato.ruta) not in rutas, contrato.ruta
        assert contrato.entrada is not None and contrato.salida is not None
        assert "status" not in contrato.entrada.model_fields
        if contrato.salto is not None:
            assert contrato.salto in service.states.TRANSICIONES, contrato.salto
    # Cada salto del mapa tiene su acción: no queda ninguno sin contrato.
    saltos = {c.salto for c in CONTRATOS_DEL_BLOQUE_1B if c.salto}
    assert saltos | {("resubmitted", "under_review"), ("suspended", "under_review")} == set(
        service.states.TRANSICIONES
    )


@pytest.mark.parametrize(
    "esquema_de_entrada",
    [
        schemas.SolicitudIniciar,
        schemas.BorradorActualizar,
        schemas.DocumentoRegistrar,
        schemas.CredencialRegistrar,
        schemas.SolicitudEnviar,
        schemas.RevisionIniciar,
        schemas.CorreccionesSolicitar,
        schemas.SolicitudAprobar,
        schemas.SolicitudRechazar,
        schemas.PrestadorSuspender,
    ],
)
def test_ninguna_entrada_admite_estado_ni_campos_desconocidos(esquema_de_entrada) -> None:
    assert "status" not in esquema_de_entrada.model_fields
    with pytest.raises(ValidationError):
        esquema_de_entrada.model_validate({"status": "approved"})


def test_las_decisiones_que_se_ensenan_exigen_motivo() -> None:
    for sin_motivo in (
        schemas.CorreccionesSolicitar,
        schemas.SolicitudRechazar,
        schemas.PrestadorSuspender,
    ):
        with pytest.raises(ValidationError):
            sin_motivo.model_validate({})
        sin_motivo.model_validate({"message": "Falta el DNI legible."})


def test_enviar_exige_declarar_la_veracidad_y_la_huella_de_lo_aceptado() -> None:
    base = {"terms_policy_id": str(uuid.uuid4()), "terms_sha256": "a" * 64}
    with pytest.raises(ValidationError):
        schemas.SolicitudEnviar.model_validate({**base, "declare_truthfulness": False})
    with pytest.raises(ValidationError):
        schemas.SolicitudEnviar.model_validate(
            {**base, "terms_sha256": "X" * 64, "declare_truthfulness": True}
        )
    schemas.SolicitudEnviar.model_validate({**base, "declare_truthfulness": True})


def test_una_credencial_no_vence_antes_de_emitirse() -> None:
    with pytest.raises(ValidationError):
        schemas.CredencialRegistrar.model_validate(
            {
                "kind": "professional_license",
                "title": "Colegiatura",
                "issuer": "Colegio",
                "issued_on": "2026-01-01",
                "expires_on": "2025-01-01",
            }
        )


def test_las_salidas_no_llevan_rutas_de_archivos_ni_numeros_completos() -> None:
    for salida in (
        schemas.DocumentoPrivadoRead,
        schemas.DocumentoAdminRead,
        schemas.SolicitudPrivadaRead,
        schemas.SolicitudAdminRead,
        schemas.CredencialPrivadaRead,
        schemas.CredencialAdminRead,
    ):
        assert "storage_path" not in salida.model_fields
        assert "number" not in salida.model_fields


def test_la_vista_privada_no_lleva_lo_administrativo() -> None:
    privada = set(schemas.SolicitudPrivadaRead.model_fields)
    for campo in ("internal_notes", "decided_by", "terms_sha256", "terms_policy_id"):
        assert campo not in privada
    assert "internal_note" not in schemas.EventoVisibleRead.model_fields
    assert "actor_id" not in schemas.EventoVisibleRead.model_fields


def test_la_vista_publica_solo_existe_para_un_prestador_activo() -> None:
    prestador = ServiceProvider(
        id=str(uuid.uuid4()),
        profile_id=PRESTADORA,
        provider_type="company",
        display_name="Taller Andino",
        legal_name="Taller Andino S.A.C.",
        tax_id="20123456789",
        representative_name="Ana",
        country_code="PE",
        status="pending",
    )
    assert schemas.PrestadorPublicoRead.desde(prestador) is None
    prestador.status = PRESTADOR_ACTIVO
    publico = schemas.PrestadorPublicoRead.desde(prestador).model_dump()
    assert publico == {
        "id": prestador.id,
        "provider_type": "company",
        "display_name": "Taller Andino",
        "country_code": "PE",
    }


# =========================================================================== #
# 2. La bandera y las puertas
# =========================================================================== #
@pytest.mark.asyncio
async def test_con_la_bandera_apagada_todo_contesta_503_sin_mirar_la_base(entorno) -> None:
    http, quien, _, _ = entorno
    assert get_settings().feature_services is False
    peticiones = [
        ("POST", MIA, {"provider_type": "individual", "display_name": "Ana"}),
        ("GET", MIA, None),
        ("PATCH", MIA, {"summary": RESUMEN}),
        ("GET", f"{MIA}/history", None),
    ]
    for metodo, ruta, cuerpo in peticiones:
        r = await http.request(metodo, ruta, json=cuerpo)
        assert r.status_code == 503, (metodo, ruta, r.text)
        assert r.json()["error"]["code"] == "services_disabled"
    # NO SE MIRÓ LA BASE: la puerta de esquema sigue sin respuesta guardada.
    assert "admision" not in esquema._cache

    _como(quien, ADMIN)
    for ruta in (BANDEJA, f"{BANDEJA}/{uuid.uuid4()}", f"{BANDEJA}/{uuid.uuid4()}/history"):
        r = await http.get(ruta)
        assert r.status_code == 503, ruta
        assert r.json()["error"]["code"] == "services_disabled"


@pytest.mark.asyncio
async def test_la_bandera_apagada_se_comprueba_antes_que_el_cuerpo(entorno) -> None:
    """Un cuerpo inválido con la bandera apagada no cuenta nada de su forma."""
    http, *_ = entorno
    r = await http.post(MIA, json={"status": "approved"})
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_sin_permiso_de_revision_es_403_incluso_con_la_bandera_apagada(entorno) -> None:
    """El rol va ANTES que la bandera: no se averigua la configuración."""
    http, quien, _, _ = entorno
    _como(quien, OTRA)
    for ruta in (BANDEJA, f"{BANDEJA}/{uuid.uuid4()}", f"{BANDEJA}/{uuid.uuid4()}/history"):
        r = await http.get(ruta)
        assert r.status_code == 403, ruta
        assert r.json()["error"]["code"] == "service_review_forbidden"


@pytest.mark.asyncio
async def test_sin_sesion_es_401(entorno) -> None:
    http, _, _, app = entorno
    app.dependency_overrides.pop(get_current_user)
    for metodo, ruta in (("GET", MIA), ("POST", MIA), ("GET", BANDEJA)):
        r = await http.request(metodo, ruta, json={})
        assert r.status_code == 401, (metodo, ruta)


@pytest.mark.asyncio
async def test_encendida_sin_la_0086_contesta_503_services_not_ready(encendida) -> None:
    esquema.olvidar()
    app = create_app()
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(
            lambda sync: Base.metadata.create_all(
                sync,
                tables=[
                    t
                    for n, t in Base.metadata.tables.items()
                    if not n.startswith("service_")
                ],
            )
        )
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=PRESTADORA, full_name="Ana", username="ana"))
        await db.commit()

    async def _db():
        async with sesiones() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=PRESTADORA, email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
            r = await http.get(MIA)
        assert r.status_code == 503
        assert r.json()["error"]["code"] == "services_not_ready"
    finally:
        app.dependency_overrides.clear()
        await motor.dispose()
        esquema.olvidar()


# =========================================================================== #
# 3. Quien postula: SU postulación
# =========================================================================== #
@pytest.mark.asyncio
async def test_sin_postulacion_es_404(entorno, encendida) -> None:
    http, *_ = entorno
    for ruta in (MIA, f"{MIA}/history"):
        r = await http.get(ruta)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "service_application_not_found"
    r = await http.patch(MIA, json={"summary": RESUMEN})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_empezar_crea_un_borrador_y_repetir_no_crea_otro(entorno, encendida) -> None:
    http, _, sesiones, _ = entorno
    r = await _iniciar(http)
    assert r.status_code == 201, r.text
    cuerpo = r.json()
    assert cuerpo["status"] == "draft"
    assert cuerpo["editable"] is True
    assert cuerpo["provider"]["status"] == "pending"
    assert set(cuerpo["missing"]) == {
        "legal_name",
        "country_code",
        "summary",
        "document:identity",
    }

    otra = await _iniciar(http, tipo="company", nombre="Otro nombre")
    assert otra.status_code == 200
    assert otra.json()["id"] == cuerpo["id"]
    # El segundo cuerpo NO cambió nada.
    assert otra.json()["provider"]["display_name"] == "Ana Guitarra"
    assert otra.json()["provider"]["provider_type"] == "individual"

    async with sesiones() as db:
        assert len(list(await db.scalars(select(ServiceProvider)))) == 1
        assert len(list(await db.scalars(select(ServiceProviderApplication)))) == 1
        eventos = list(await db.scalars(select(ServiceProviderApplicationEvent)))
    assert len(eventos) == 1
    assert (eventos[0].from_status, eventos[0].to_status) == (None, "draft")
    assert eventos[0].actor_role == "provider"
    assert eventos[0].actor_id == PRESTADORA


@pytest.mark.asyncio
async def test_el_estado_no_se_cambia_con_un_patch(entorno, encendida) -> None:
    http, *_ = entorno
    await _iniciar(http)
    for cuerpo in (
        {"status": "approved"},
        {"summary": RESUMEN, "status": "submitted"},
        {"decided_by": ADMIN},
        {"internal_notes": "hola"},
    ):
        r = await http.patch(MIA, json=cuerpo)
        assert r.status_code == 422, cuerpo
    assert (await http.get(MIA)).json()["status"] == "draft"


@pytest.mark.asyncio
async def test_un_patch_vacio_o_que_vacia_lo_obligatorio_es_422(entorno, encendida) -> None:
    http, *_ = entorno
    await _iniciar(http)
    for cuerpo in ({}, {"display_name": None}, {"provider_type": None}, {"country_code": "PER"}):
        r = await http.patch(MIA, json=cuerpo)
        assert r.status_code == 422, cuerpo


@pytest.mark.asyncio
async def test_el_borrador_se_completa_y_dice_lo_que_falta(entorno, encendida) -> None:
    http, _, sesiones, _ = entorno
    await _iniciar(http)
    r = await http.patch(
        MIA,
        json={
            "legal_name": "Ana María Quispe",
            "country_code": "pe",
            "summary": RESUMEN,
            "requested_category": "musica",
        },
    )
    assert r.status_code == 200, r.text
    cuerpo = r.json()
    assert cuerpo["provider"]["country_code"] == "PE"
    assert cuerpo["summary"] == RESUMEN
    # Sin condiciones publicadas NO se puede enviar, y se dice.
    assert set(cuerpo["missing"]) == {"document:identity", "provider_terms_not_published"}

    await _publicar_terminos(sesiones)
    assert set((await http.get(MIA)).json()["missing"]) == {"document:identity"}

    # Un `null` explícito vacía un campo que admite vacío.
    r = await http.patch(MIA, json={"legal_name": None})
    assert r.json()["provider"]["legal_name"] is None
    assert "legal_name" in r.json()["missing"]


@pytest.mark.asyncio
async def test_una_empresa_necesita_ruc_representante_y_representacion(entorno, encendida) -> None:
    http, *_ = entorno
    await _iniciar(http, tipo="company", nombre="Taller Andino")
    faltan = set((await http.get(MIA)).json()["missing"])
    assert {"tax_id", "representative_name", "document:legal_representation"} <= faltan


@pytest.mark.asyncio
async def test_lo_enviado_ya_no_se_edita(entorno, encendida) -> None:
    http, quien, sesiones, _ = entorno
    politica = await _publicar_terminos(sesiones)
    await _enviada_a_mano(sesiones, OTRA, politica)
    _como(quien, OTRA)
    r = await http.patch(MIA, json={"summary": RESUMEN + " Editado."})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "service_application_not_editable"
    assert r.json()["error"]["details"] == {"status": "submitted"}
    visto = (await http.get(MIA)).json()
    assert visto["editable"] is False
    assert visto["missing"] == []


@pytest.mark.asyncio
async def test_la_vista_privada_no_filtra_nada_de_z(entorno, encendida) -> None:
    http, _, sesiones, _ = entorno
    creada = (await _iniciar(http)).json()
    async with sesiones() as db:
        solicitud = await db.get(ServiceProviderApplication, creada["id"])
        solicitud.internal_notes = "NOTA INTERNA QUE NO SALE"
        db.add(
            ServiceProviderDocument(
                provider_id=solicitud.provider_id,
                application_id=solicitud.id,
                kind="identity",
                storage_path=f"{PRESTADORA}/{solicitud.id}/dni.pdf",
                content_type="application/pdf",
                byte_size=2048,
                created_at=_ahora(),
            )
        )
        await db.commit()

    r = await http.get(MIA)
    texto = r.text
    assert "NOTA INTERNA QUE NO SALE" not in texto
    assert "dni.pdf" not in texto and "storage_path" not in texto
    cuerpo = r.json()
    assert "internal_notes" not in cuerpo and "decided_by" not in cuerpo
    assert cuerpo["documents"][0]["kind"] == "identity"
    assert "document:identity" not in cuerpo["missing"]

    historial = (await http.get(f"{MIA}/history")).json()
    assert historial == [
        {
            "from_status": None,
            "to_status": "draft",
            "by": "you",
            "visible_note": None,
            "created_at": historial[0]["created_at"],
        }
    ]


@pytest.mark.asyncio
async def test_volver_a_postular_tras_un_rechazo_es_otra_postulacion(entorno, encendida) -> None:
    http, _, sesiones, _ = entorno
    primera = (await _iniciar(http)).json()
    politica = await _publicar_terminos(sesiones)
    async with sesiones() as db:
        solicitud = await db.get(ServiceProviderApplication, primera["id"])
        momento = _ahora()
        solicitud.status = "rejected"
        solicitud.summary = RESUMEN
        solicitud.terms_policy_id = politica.id
        solicitud.terms_sha256 = politica.body_sha256
        solicitud.terms_accepted_at = momento
        solicitud.truthfulness_declared_at = momento
        solicitud.submitted_at = momento
        solicitud.last_submitted_at = momento
        solicitud.decided_at = momento
        solicitud.decided_by = ADMIN
        solicitud.applicant_message = "La identidad no se pudo comprobar."
        await db.commit()

    rechazada = (await http.get(MIA)).json()
    assert rechazada["status"] == "rejected"
    assert rechazada["applicant_message"] == "La identidad no se pudo comprobar."

    nueva = await _iniciar(http)
    assert nueva.status_code == 201
    assert nueva.json()["id"] != primera["id"]
    assert (await http.get(MIA)).json()["id"] == nueva.json()["id"]


# =========================================================================== #
# 4. Administración: bandeja, detalle e historial
# =========================================================================== #
@pytest.mark.asyncio
async def test_la_bandeja_ensena_lo_que_espera_a_z_y_filtra(entorno, encendida) -> None:
    http, quien, sesiones, _ = entorno
    await _iniciar(http)  # un borrador de PRESTADORA
    politica = await _publicar_terminos(sesiones)
    await _enviada_a_mano(sesiones, OTRA, politica)

    _como(quien, MODERADOR)
    r = await http.get(BANDEJA)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["status"] for i in items] == ["submitted"]
    assert r.json()["next_cursor"] is None
    assert "internal_notes" not in items[0]

    borradores = (await http.get(BANDEJA, params={"status": "draft"})).json()["items"]
    assert [i["display_name"] for i in borradores] == ["Ana Guitarra"]
    empresas = await http.get(BANDEJA, params={"provider_type": "company"})
    assert empresas.json()["items"] == []

    for params, codigo in (
        ({"status": "aprobado"}, "service_application_status_unknown"),
        ({"provider_type": "robot"}, "service_provider_type_unknown"),
        ({"cursor": "no-es-un-cursor"}, "invalid_cursor"),
    ):
        r = await http.get(BANDEJA, params=params)
        assert r.status_code == 422, params
        assert r.json()["error"]["code"] == codigo


@pytest.mark.asyncio
async def test_la_bandeja_pagina_por_cursor_sin_repetir(entorno, encendida) -> None:
    http, quien, sesiones, _ = entorno
    politica = await _publicar_terminos(sesiones)
    base = _ahora()
    for i, uid in enumerate((PRESTADORA, OTRA, TERCERA)):
        await _enviada_a_mano(sesiones, uid, politica, momento=base - timedelta(minutes=i))

    _como(quien, ADMIN)
    vistos: list[str] = []
    cursor = None
    for _ in range(5):
        params = {"limit": 1}
        if cursor:
            params["cursor"] = cursor
        pagina = (await http.get(BANDEJA, params=params)).json()
        vistos += [i["id"] for i in pagina["items"]]
        cursor = pagina["next_cursor"]
        if cursor is None:
            break
    assert len(vistos) == 3 and len(set(vistos)) == 3
    assert cursor is None


@pytest.mark.asyncio
async def test_el_detalle_administrativo_lleva_lo_interno_pero_no_la_ruta(entorno, encendida) -> None:
    http, quien, sesiones, _ = entorno
    creada = (await _iniciar(http)).json()
    async with sesiones() as db:
        solicitud = await db.get(ServiceProviderApplication, creada["id"])
        solicitud.internal_notes = "Revisar el DNI con RENIEC."
        db.add(
            ServiceProviderDocument(
                provider_id=solicitud.provider_id,
                application_id=solicitud.id,
                kind="identity",
                storage_path=f"{PRESTADORA}/{solicitud.id}/secreto.pdf",
                content_type="application/pdf",
                byte_size=4096,
                created_at=_ahora(),
            )
        )
        await db.commit()

    _como(quien, MODERADOR)
    r = await http.get(f"{BANDEJA}/{creada['id']}")
    assert r.status_code == 200, r.text
    cuerpo = r.json()
    assert cuerpo["internal_notes"] == "Revisar el DNI con RENIEC."
    assert cuerpo["provider"]["profile_id"] == PRESTADORA
    assert cuerpo["documents"][0]["application_id"] == creada["id"]
    assert "secreto.pdf" not in r.text and "storage_path" not in r.text

    historial = (await http.get(f"{BANDEJA}/{creada['id']}/history")).json()
    assert historial[0]["actor_id"] == PRESTADORA
    assert historial[0]["actor_role"] == "provider"
    assert "internal_note" in historial[0]


@pytest.mark.asyncio
async def test_lo_que_no_existe_es_404_aunque_el_id_este_mal_escrito(entorno, encendida) -> None:
    http, quien, _, _ = entorno
    _como(quien, ADMIN)
    for ident in (str(uuid.uuid4()), "no-es-un-uuid", "1' or '1'='1"):
        for sufijo in ("", "/history"):
            r = await http.get(f"{BANDEJA}/{ident}{sufijo}")
            assert r.status_code == 404, (ident, sufijo)
            assert r.json()["error"]["code"] == "service_application_not_found"


# =========================================================================== #
# 5. Permisos conceptuales
# =========================================================================== #
@pytest.mark.asyncio
async def test_funciones_de_cada_rol(entorno) -> None:
    _, _, sesiones, _ = entorno
    async with sesiones() as db:
        assert await permissions.funcion_de(db, ADMIN) == "admin"
        assert await permissions.funcion_de(db, MODERADOR) == "reviewer"
        assert await permissions.funcion_de(db, OTRA) is None
        assert await permissions.exigir_revisor(db, MODERADOR) == "reviewer"
        assert await permissions.exigir_decisor(db, ADMIN) == "admin"
        with pytest.raises(permissions.SinPermisoDeDecision):
            await permissions.exigir_decisor(db, MODERADOR)
        with pytest.raises(permissions.SinPermisoDeRevision):
            await permissions.exigir_revisor(db, OTRA)


def test_nadie_revisa_su_propia_admision() -> None:
    with pytest.raises(permissions.EsTuPropiaAdmision) as error:
        permissions.exigir_ajena(dueno_del_expediente=ADMIN, user_id=ADMIN)
    assert error.value.code == "service_self_review_forbidden"
    permissions.exigir_ajena(dueno_del_expediente=PRESTADORA, user_id=ADMIN)


def test_decidir_una_admision_no_hereda_permisos_de_dinero() -> None:
    from pathlib import Path

    fuente = Path(permissions.__file__).read_text(encoding="utf-8")
    codigo = "\n".join(
        linea for linea in fuente.splitlines() if not linea.lstrip().startswith("#")
    )
    assert "FINANCE_ROLES" not in codigo.split('"""', 2)[-1]
    assert "puede_mover_dinero" not in codigo.split('"""', 2)[-1]
    assert permissions.ROLES_QUE_DECIDEN == {"admin"}
    assert permissions.ROLES_QUE_REVISAN == {"admin", "moderator"}


# =========================================================================== #
# 6. Regresión acotada: lo compartido sigue igual
# =========================================================================== #
@pytest.mark.asyncio
async def test_la_configuracion_publica_y_la_salud_no_cambian(entorno) -> None:
    http, *_ = entorno
    assert (await http.get("/health")).json() == {
        "status": "ok",
        "service": "renaser-social-media-api",
    }
    config = (await http.get(f"{API}/platform/config")).json()
    assert set(config) == {"publicacion_flexible"}
