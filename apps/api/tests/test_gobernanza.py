"""Políticas versionadas, consentimientos y auditoría.

LO QUE SE PROTEGE, y son tres cosas distintas:

1. **Que la política la elija el servidor.** El cliente pide el tipo, no la
   versión. Y si no hay ninguna vigente, la operación se para en vez de coger
   «la más parecida».
2. **Que un consentimiento sea una prueba.** No se reescribe, no se borra, no lo
   consumen dos órdenes, y un doble toque no crea dos.
3. **Que la auditoría no mienta.** Vive en la misma transacción que la operación
   que describe, así que un `rollback` se la lleva; distingue lo intentado de lo
   conseguido; y no filtra IP ni agente de usuario a ninguna respuesta.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.gobernanza import auditoria, consentimientos, esquema, politicas
from app.modules.gobernanza.contexto import OrigenDeLaPeticion
from app.modules.gobernanza.models import AuditEvent, ConsentRecord, PolicyVersion
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

API = "/api/v1"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"
CURSO = "cccccccc-0000-0000-0000-000000000001"

#: Un hash de 64 caracteres hexadecimales, que es lo único que la base admite en
#: `ip_hash`. Escrito a mano para que la prueba no dependa de la sal.
HUELLA = "a" * 64


@pytest_asyncio.fixture
async def sesiones():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    hacer = async_sessionmaker(engine, expire_on_commit=False)
    esquema.olvidar()
    async with hacer() as db:
        db.add_all(
            [
                Profile(id=ANA, username="ana", full_name="Ana"),
                Profile(id=JEFA, username="jefa", full_name="Jefa", role="admin"),
            ]
        )
        await db.commit()
    try:
        yield hacer
    finally:
        esquema.olvidar()


@pytest_asyncio.fixture
async def http(sesiones):
    identidad = {"uid": ANA}

    async def _sesion():
        async with sesiones() as db:
            yield db

    app.dependency_overrides[get_db] = _sesion
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=identidad["uid"], email="x@y.z"
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://t"
        ) as cliente:
            yield cliente, identidad
    finally:
        app.dependency_overrides.clear()


# --------------------------------------------------------------------------- #
# 1. Políticas
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_publicar_cierra_la_anterior_en_la_misma_transaccion(sesiones) -> None:
    """El momento intermedio no puede existir.

    Con ninguna vigente se bloquearian las compras; con dos, el servidor tendria
    que ELEGIR entre dos textos legales, que es exactamente lo que no puede pasar.
    """
    async with sesiones() as db:
        primera = await politicas.publicar(
            db, policy_type=politicas.RECOMPRA, version="v1", body="Texto uno"
        )
        await db.commit()
        segunda = await politicas.publicar(
            db, policy_type=politicas.RECOMPRA, version="v2", body="Texto dos"
        )
        await db.commit()

        assert primera.status == "superseded"
        assert primera.effective_to is not None
        assert segunda.status == "published"
        vigente = await politicas.vigente(db, policy_type=politicas.RECOMPRA)
        assert vigente.id == segunda.id


@pytest.mark.asyncio
async def test_la_base_impide_dos_politicas_vigentes(sesiones) -> None:
    """Como en las versiones de curso: lo sostiene un indice, no un `if`."""
    async with sesiones() as db:
        await politicas.publicar(
            db, policy_type=politicas.RECOMPRA, version="v1", body="Texto uno"
        )
        await db.commit()
        db.add(
            PolicyVersion(
                policy_type=politicas.RECOMPRA,
                jurisdiction="PE",
                locale="es",
                version="colada",
                body="otro",
                body_sha256=politicas.huella("otro"),
                status="published",
                effective_from=politicas.ahora(),
                published_at=politicas.ahora(),
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()


@pytest.mark.asyncio
async def test_sin_politica_vigente_la_operacion_se_para(sesiones) -> None:
    """Fallar en cerrado. No se coge «la mas parecida» ni se sigue sin ella."""
    async with sesiones() as db:
        with pytest.raises(politicas.PoliticaAusente):
            await politicas.exigir_vigente(db, policy_type=politicas.TERMINOS)


@pytest.mark.asyncio
async def test_no_se_siembra_ningun_texto_de_terminos_de_compra(sesiones) -> None:
    """LO QUE NO SE HACE, y es deliberado.

    No hay terminos de compra aprobados: falta decidir entidad vendedora,
    jurisdiccion e impuestos. Escribir un texto provisional para que «algo
    haya» seria justo lo que no se debe hacer con un documento que alguien va
    a firmar. La capacidad existe; el contenido espera una decision.
    """
    async with sesiones() as db:
        await politicas.sembrar_recompra(db)
        await db.commit()
        assert await politicas.vigente(db, policy_type=politicas.TERMINOS) is None
        assert await politicas.vigente(db, policy_type=politicas.PRIVACIDAD) is None
        # Y la de recompra si, con la version que dice el codigo.
        from app.modules.refunds import politica as recompra

        puesta = await politicas.vigente(db, policy_type=politicas.RECOMPRA)
        assert puesta is not None and puesta.version == recompra.VERSION_ACTUAL


@pytest.mark.asyncio
async def test_sembrar_dos_veces_no_duplica(sesiones) -> None:
    async with sesiones() as db:
        await politicas.sembrar_recompra(db)
        await db.commit()
        await politicas.sembrar_recompra(db)
        await db.commit()
        todas = list(await db.scalars(select(PolicyVersion)))
        assert len(todas) == 1


@pytest.mark.asyncio
async def test_sembrar_deja_una_sola_nota_de_auditoria(http, sesiones) -> None:
    """Publicar una politica se audita; volver a pulsar el boton, no.

    Publicar es el acto que mas falta hace auditar de los que pasan por el
    endpoint: fija el texto contra el que se comparara cada aceptacion
    posterior. Pero la siembra es idempotente, y anotar en cada llamada llenaria
    la tabla de publicaciones que no ocurrieron. Una tabla que cuenta actos
    inexistentes deja de servir como prueba de los que si ocurrieron.
    """
    cliente, identidad = http
    identidad["uid"] = JEFA

    primera = await cliente.post(f"{API}/admin/policies/seed-refund-repurchase")
    assert primera.status_code == 200, primera.text
    segunda = await cliente.post(f"{API}/admin/policies/seed-refund-repurchase")
    assert segunda.status_code == 200, segunda.text
    assert segunda.json()["version"] == primera.json()["version"]

    async with sesiones() as db:
        notas = list(
            await db.scalars(
                select(AuditEvent).where(AuditEvent.action == "policy.published")
            )
        )
    assert len(notas) == 1, "la segunda llamada no publico nada y no debe anotar"
    assert notas[0].actor_id == JEFA
    assert notas[0].entity_type == "policy_version"
    # LA HUELLA DEL TEXTO TIENE QUE SOBREVIVIR AL FILTRO. Es el unico campo que
    # dice QUE texto se publico; sin el, la nota solo dice que alguien publico
    # algo. El filtro llego a comerselo en silencio por llamarse `body_sha256`.
    assert notas[0].payload["policy_hash"], "la nota no dice que texto se fijo"
    assert notas[0].payload["version"] == primera.json()["version"]


@pytest.mark.asyncio
async def test_quien_solo_modera_no_puede_publicar_una_politica(http, sesiones) -> None:
    """Moderar contenido y fijar el texto que alguien va a firmar no son lo
    mismo. `puede_mover_dinero` deja fuera a `moderator`, que `is_admin` incluye.
    """
    cliente, identidad = http
    moderadora = "aaaaaaaa-0000-0000-0000-0000000000ff"
    async with sesiones() as db:
        db.add(Profile(id=moderadora, username="modera", role="moderator"))
        await db.commit()
    identidad["uid"] = moderadora

    respuesta = await cliente.post(f"{API}/admin/policies/seed-refund-repurchase")
    assert respuesta.status_code == 403, respuesta.text
    async with sesiones() as db:
        assert await politicas.vigente(db, policy_type=politicas.RECOMPRA) is None


@pytest.mark.asyncio
async def test_el_cliente_pide_el_tipo_y_recibe_la_vigente(http, sesiones) -> None:
    cliente, _ = http
    async with sesiones() as db:
        await politicas.sembrar_recompra(db)
        await db.commit()

    respuesta = await cliente.get(f"{API}/policies/{politicas.RECOMPRA}")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["policy_type"] == politicas.RECOMPRA
    assert cuerpo["body"]
    # NO SE PUEDE PEDIR UNA VERSION CONCRETA: el endpoint no acepta ese
    # parametro. Si se pudiera, quien firma elegiria el texto que firma.
    assert "version" in cuerpo and "?version=" not in str(respuesta.url)


@pytest.mark.asyncio
async def test_sin_politica_el_endpoint_responde_404_y_no_un_hueco(http) -> None:
    cliente, _ = http
    respuesta = await cliente.get(f"{API}/policies/{politicas.TERMINOS}")
    assert respuesta.status_code == 404
    assert "policy_not_available" in respuesta.text


# --------------------------------------------------------------------------- #
# 2. Consentimientos
# --------------------------------------------------------------------------- #


async def _con_politica(sesiones):
    async with sesiones() as db:
        await politicas.sembrar_recompra(db)
        await db.commit()


@pytest.mark.asyncio
async def test_un_doble_toque_no_crea_dos_aceptaciones(sesiones) -> None:
    """El `select … if ya existe` de Python lo pasan dos peticiones a la vez.

    Aqui se inserta y se deja colisionar el indice unico parcial. La segunda
    llamada devuelve la que ya estaba, no una nueva.
    """
    await _con_politica(sesiones)
    async with sesiones() as db:
        primera = await consentimientos.registrar(
            db,
            subject_id=ANA,
            policy_type=politicas.RECOMPRA,
            texto_mostrado="Ya usaste tu garantia el 2026-01-01",
            scope_kind="course",
            scope_id=CURSO,
        )
        await db.commit()
        segunda = await consentimientos.registrar(
            db,
            subject_id=ANA,
            policy_type=politicas.RECOMPRA,
            texto_mostrado="Ya usaste tu garantia el 2026-01-01",
            scope_kind="course",
            scope_id=CURSO,
        )
        await db.commit()

        assert segunda.id == primera.id
        assert len(list(await db.scalars(select(ConsentRecord)))) == 1


@pytest.mark.asyncio
async def test_una_aceptacion_no_la_consumen_dos_ordenes(sesiones) -> None:
    await _con_politica(sesiones)
    async with sesiones() as db:
        acepto = await consentimientos.registrar(
            db,
            subject_id=ANA,
            policy_type=politicas.RECOMPRA,
            texto_mostrado="texto",
            scope_kind="course",
            scope_id=CURSO,
        )
        await db.commit()

        primera = await consentimientos.consumir(
            db, acepto, kind="order", identificador="00000000-0000-0000-0000-0000000000a1"
        )
        await db.commit()
        assert primera is True

        # La segunda no la sella: ya estaba sellada.
        segunda = await consentimientos.consumir(
            db, acepto, kind="order", identificador="00000000-0000-0000-0000-0000000000a2"
        )
        assert segunda is False
        assert acepto.consumed_by_id == "00000000-0000-0000-0000-0000000000a1"


@pytest.mark.asyncio
async def test_dos_aceptaciones_no_apuntan_a_la_misma_orden(sesiones) -> None:
    """Lo sostiene `consent_records_consumo_unico`.

    Antes esto se resolvia en Python con un `order_by … limit 1` tras un fallo
    ya corregido a mano; nada en la base lo impedia.
    """
    await _con_politica(sesiones)
    async with sesiones() as db:
        uno = await consentimientos.registrar(
            db,
            subject_id=ANA,
            policy_type=politicas.RECOMPRA,
            texto_mostrado="texto",
            scope_kind="course",
            scope_id=CURSO,
        )
        await db.commit()
        assert await consentimientos.consumir(
            db, uno, kind="order", identificador="00000000-0000-0000-0000-0000000000a1"
        )
        await db.commit()

        otro = await consentimientos.registrar(
            db,
            subject_id=ANA,
            policy_type=politicas.RECOMPRA,
            texto_mostrado="texto",
            scope_kind="course",
            scope_id="cccccccc-0000-0000-0000-000000000002",
        )
        await db.commit()
        # La misma orden que ya consumio el primero.
        assert not await consentimientos.consumir(
            db, otro, kind="order", identificador="00000000-0000-0000-0000-0000000000a1"
        )


@pytest.mark.asyncio
async def test_la_fecha_y_la_huella_las_pone_el_servidor(sesiones) -> None:
    """El cliente no manda ninguna de las dos.

    Una aceptacion con fecha del telefono y huella del telefono no demuestra
    nada: las dos las elige quien firma.
    """
    await _con_politica(sesiones)
    async with sesiones() as db:
        acepto = await consentimientos.registrar(
            db,
            subject_id=ANA,
            policy_type=politicas.RECOMPRA,
            texto_mostrado="El texto exacto que se mostro",
        )
        await db.commit()
        assert acepto.accepted_at is not None
        assert acepto.policy_hash == politicas.huella("El texto exacto que se mostro")


@pytest.mark.asyncio
async def test_mis_consentimientos_no_devuelven_ip_ni_agente(http, sesiones) -> None:
    """NI SIQUIERA A QUIEN LOS FIRMO.

    No le aportan nada y convertirian el endpoint en una forma de comprobar
    desde donde se conecta una cuenta.
    """
    cliente, _ = http
    await _con_politica(sesiones)
    async with sesiones() as db:
        await consentimientos.registrar(
            db,
            subject_id=ANA,
            policy_type=politicas.RECOMPRA,
            texto_mostrado="texto",
            origen=OrigenDeLaPeticion(
                ip_hash=HUELLA,
                ip_prefix="203.0.113.0/24",
                user_agent_family="Chrome 141",
                request_id="abc",
            ),
        )
        await db.commit()

    respuesta = await cliente.get(f"{API}/policies/me/consents")
    assert respuesta.status_code == 200, respuesta.text
    crudo = respuesta.text
    for prohibido in ("ip_hash", "ip_prefix", "user_agent", "203.0.113", "Chrome"):
        assert prohibido not in crudo, f"se filtro «{prohibido}»"


@pytest.mark.asyncio
async def test_nadie_ve_los_consentimientos_de_otra_persona(http, sesiones) -> None:
    cliente, identidad = http
    await _con_politica(sesiones)
    async with sesiones() as db:
        await consentimientos.registrar(
            db, subject_id=ANA, policy_type=politicas.RECOMPRA, texto_mostrado="texto"
        )
        await db.commit()

    identidad["uid"] = JEFA  # administracion tampoco, por este endpoint
    respuesta = await cliente.get(f"{API}/policies/me/consents")
    assert respuesta.json() == []


# --------------------------------------------------------------------------- #
# 3. Auditoría
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_auditoria_vive_en_la_transaccion_de_la_operacion(sesiones) -> None:
    """Si la operacion se deshace, el rastro se deshace con ella.

    Es la propiedad que se busca: «no existe cambio sin su registro». Al reves
    tambien vale: no existe registro de un cambio que no ocurrio.
    """
    async with sesiones() as db:
        await auditoria.anotar(
            db,
            action="balance.frozen",
            entity_type="owner_sale_balance",
            entity_id="00000000-0000-0000-0000-0000000000b1",
            actor_id=JEFA,
            actor_role="admin",
        )
        await db.rollback()

    async with sesiones() as db:
        assert list(await db.scalars(select(AuditEvent))) == []


@pytest.mark.asyncio
async def test_la_auditoria_distingue_lo_intentado_de_lo_conseguido(sesiones) -> None:
    async with sesiones() as db:
        await auditoria.anotar(
            db,
            action="refund.approved",
            entity_type="refund_request",
            entity_id="00000000-0000-0000-0000-0000000000c1",
            actor_id=JEFA,
            actor_role="admin",
            outcome="denied",
            reason="ya estaba aprobada",
        )
        await db.commit()
        fila = await db.scalar(select(AuditEvent))
        assert fila.outcome == "denied"


@pytest.mark.asyncio
async def test_la_auditoria_no_guarda_cuerpos_ni_secretos(sesiones) -> None:
    """El `payload` es para identificadores y codigos, nada mas.

    Guardar ahi el cuerpo de un aviso de pasarela seria copiar datos de pago a
    una tabla que lee administracion.
    """
    async with sesiones() as db:
        await auditoria.anotar(
            db,
            action="transfer.executed",
            entity_type="owner_sale_balance",
            entity_id="00000000-0000-0000-0000-0000000000b1",
            payload={
                "balance_id": "b1",
                # Un valor que NO se parece a una clave de verdad. El escaner de
                # secretos mira patrones, no intenciones: una clave inventada en
                # una prueba lo hace saltar igual que una de verdad, y una alerta
                # que siempre es falsa acaba en que nadie las mira. (Este
                # comentario tampoco escribe el patron, por lo mismo.)
                "authorization": "Bearer <una-credencial-cualquiera>",
                "body": {"card": "4242"},
                "token": "tok_123",
                "email": "quien@ejemplo.com",
            },
        )
        await db.commit()
        fila = await db.scalar(select(AuditEvent))
        assert fila.payload == {"balance_id": "b1"}


@pytest.mark.asyncio
async def test_un_evento_de_auditoria_no_se_reescribe(sesiones) -> None:
    """En PostgreSQL lo impide un disparador de la 0050.

    AQUI NO SE PUEDE COMPROBAR: SQLite no ejecuta esos disparadores, que se
    declaran en el SQL de la migracion. Lo que si se comprueba es que ningun
    codigo de la aplicacion actualiza ni borra la tabla, que es la otra mitad.
    """
    import pathlib

    raiz = pathlib.Path(__file__).resolve().parents[1] / "app"
    sospechosas = []
    for fichero in raiz.rglob("*.py"):
        texto = fichero.read_text(encoding="utf-8", errors="replace")
        if "AuditEvent" in texto and ("update(AuditEvent" in texto or "delete(AuditEvent" in texto):
            sospechosas.append(str(fichero))
    assert not sospechosas, f"alguien actualiza o borra auditoria: {sospechosas}"


@pytest.mark.asyncio
async def test_la_auditoria_solo_la_lee_tesoreria(http, sesiones) -> None:
    """`moderator` no. Quien oculta una publicacion no ve quien movio dinero."""
    cliente, identidad = http
    async with sesiones() as db:
        db.add(Profile(id="aaaaaaaa-0000-0000-0000-00000000000d", username="mod", role="moderator"))
        await db.commit()

    assert (await cliente.get(f"{API}/admin/audit-events")).status_code == 403

    identidad["uid"] = "aaaaaaaa-0000-0000-0000-00000000000d"
    assert (await cliente.get(f"{API}/admin/audit-events")).status_code == 403

    identidad["uid"] = JEFA
    assert (await cliente.get(f"{API}/admin/audit-events")).status_code == 200


@pytest.mark.asyncio
async def test_la_auditoria_no_expone_el_origen_ni_a_administracion(
    http, sesiones
) -> None:
    cliente, identidad = http
    async with sesiones() as db:
        await auditoria.anotar(
            db,
            action="course.published",
            entity_type="course",
            entity_id=CURSO,
            origen=OrigenDeLaPeticion(
                ip_hash=HUELLA, ip_prefix="203.0.113.0/24", user_agent_family="Chrome 141"
            ),
        )
        await db.commit()

    identidad["uid"] = JEFA
    respuesta = await cliente.get(f"{API}/admin/audit-events")
    assert respuesta.status_code == 200
    for prohibido in ("ip_hash", "ip_prefix", "user_agent", "203.0.113", "Chrome"):
        assert prohibido not in respuesta.text, f"se filtro «{prohibido}»"


# --------------------------------------------------------------------------- #
# 4. Sin la 0050
# --------------------------------------------------------------------------- #


#: Lo que la 0050 anade y que, por tanto, NO existe antes de aplicarla.
SIN_LA_0050 = ("course_versions", "policy_versions", "consent_records", "audit_events")
COLUMNAS_DE_LA_0050 = (
    "course_version_id",
    "guarantee_hours",
    "guarantee_policy",
    "terms_version",
    "offer_hash",
    "snapshot_origin",
)


async def _base_sin_la_0050():
    """Un esquema como el de PRODUCCION antes de pegar la 0050.

    NO BASTA CON OMITIR LAS TABLAS NUEVAS. Lo que de verdad rompe un despliegue
    adelantado son las COLUMNAS que la 0050 añade a `orders` y `entitlements`:
    los modelos las mapean sin ninguna guarda, asi que cualquier
    `select(Order)` las pide y la base contesta que no existen. Una prueba que
    solo quitara las tablas se quedaria verde mientras el comercio entero se
    cae, que es exactamente el fallo que hay que poder ver.
    """
    import sqlalchemy as sa

    from app.shared.database import Base as _Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    antiguo = sa.MetaData()
    for nombre, tabla in _Base.metadata.tables.items():
        if nombre in SIN_LA_0050:
            continue
        columnas = [
            c._copy()
            for c in tabla.columns
            if not (
                nombre in ("orders", "entitlements") and c.name in COLUMNAS_DE_LA_0050
            )
        ]
        sa.Table(nombre, antiguo, *columnas)
    async with engine.begin() as conn:
        await conn.run_sync(antiguo.create_all)
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.asyncio
async def test_sin_la_0050_el_comercio_SE_CAE_y_hay_que_saberlo(sesiones) -> None:
    """LA 0050 SE APLICA ANTES QUE EL CODIGO. No al reves.

    Esta prueba no comprueba que algo funcione: comprueba que NO funciona, y lo
    fija por escrito. Los modelos mapean seis columnas nuevas en `orders` y una
    en `entitlements` sin guarda de esquema —a diferencia de `cursos_v2`, que
    lee la 0034 por un `MetaData` aparte—, asi que desplegar el codigo con la
    migracion pendiente NO degrada nada: tumba el checkout, el webhook de pago y
    el historial de compras.

    Si alguien decide arreglarlo de verdad, esta prueba fallara y habra que
    reescribirla. Mientras tanto, es lo que evita que la promesa contraria se
    cuele en un comentario.
    """
    from app.modules.commerce.models import Order

    hacer = await _base_sin_la_0050()
    async with hacer() as db:
        with pytest.raises(Exception) as fallo:
            await db.execute(select(Order).limit(1))
        assert "course_version_id" in str(fallo.value)


@pytest.mark.asyncio
async def test_sin_la_0050_la_gobernanza_si_degrada_con_educacion(sesiones) -> None:
    """Lo que SI aguanta: politicas, consentimientos y auditoria.

    Estos modulos preguntan por su esquema antes de tocarlo, igual que
    `refunds` y `catalog` con las suyas. Sin las tablas devuelven `None` y la
    aplicacion sigue: lo que NO puede pasar es un 500.
    """
    hacer = await _base_sin_la_0050()
    esquema.olvidar()
    try:
        async with hacer() as db:
            assert await auditoria.anotar(
                db, action="x", entity_type="course", entity_id=CURSO
            ) is None
            assert await politicas.vigente(db, policy_type=politicas.RECOMPRA) is None
            assert await politicas.sembrar_recompra(db) is None
            assert await consentimientos.registrar(
                db, subject_id=ANA, policy_type=politicas.RECOMPRA, texto_mostrado="x"
            ) is None
    finally:
        esquema.olvidar()
