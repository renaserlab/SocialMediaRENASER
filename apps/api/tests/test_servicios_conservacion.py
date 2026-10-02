"""F21: la historia contractual de Servicios impide la baja automática.

DECISIÓN PROVISIONAL de la primera versión (02/10/2026): una cuenta que es
parte de un pedido o de una reserva de Servicios —como quien contrató o como
quien prestó, viva o cerrada— no se borra sola. `DELETE /auth/me` contesta 409
`service_history_requires_support` y la cierra soporte. La anonimización
definitiva sigue pendiente de validación legal.

LO QUE SE COMPRUEBA:

  * la clasificación de las 28 tablas de Servicios y que las familias que
    frenan son TODO lo que cuelga de un pedido o de una reserva (sin base);
  * con PostgreSQL de verdad y por el endpoint real: cada familia frena por
    sí sola, a las dos partes, en cualquier estado; nada cambia ni se llama a
    Storage; lo que no es contractual no frena; un fallo al mirar es un 503;
    dos bajas a la vez; y que no nace una reserva entre mirar y borrar.

El contrato del servicio sin PostgreSQL (el orden y los códigos) está en
`test_baja_de_cuenta.py`.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

from app.core.config import get_settings
from app.modules.identity import baja
from app.modules.services import conservacion, posventa
from app.modules.services import reserva_politica as limites
from app.shared import storage
from app.shared.database import Base, get_db
from tests.test_baja_de_cuenta_postgres import SIN_POSTGRES, _borrar_cuenta, _existe, _filas, _persona, _uno
from tests.test_servicios_admision_api import PDF
from tests.test_servicios_agenda_api import _codigo, _dia, _pedir
from tests.test_servicios_atencion_api import (  # noqa: F401 - montajes compartidos
    DESCRIPCION,
    RESENA,
    RESENAS,
    _atendida,
    _con_caso,
    _hacer,
    _llevar,
    _resolver,
    atencion,
)
from tests.test_servicios_descubrimiento_api import (  # noqa: F401 - montajes compartidos
    CATALOGO,
    base_aplicada,
    entorno,
    mundo,
)
from tests.test_servicios_reserva_api import (  # noqa: F401 - montajes compartidos
    _aceptando,
    _clave,
    _condiciones,
    _confirmar,
    _horarios,
    _reservado,
    _resumen,
    _retener,
    _servicio,
    _siempre,
    reservas,
)

pytestmark = pytest.mark.asyncio

CODIGO = "service_history_requires_support"
#: Las nueve, escritas aquí A MANO: quitar una de `conservacion.FAMILIAS`
#: pone esta lista en rojo.
CONTRACTUALES = (
    "service_orders",
    "service_bookings",
    "service_booking_intakes",
    "service_booking_acceptances",
    "service_booking_events",
    "service_attendances",
    "service_incidents",
    "service_incident_entries",
    "service_reviews",
)
DE_SERVICIOS = sorted(t for t in Base.metadata.tables if t.startswith("service") or t == "saved_services")


def _familias() -> dict[str, tuple]:
    return {tabla.__tablename__: (tabla, raiz, enlaces) for tabla, raiz, enlaces in conservacion.FAMILIAS}


# =========================================================================== #
# 1. La clasificación, sin base
# =========================================================================== #
async def test_las_familias_que_frenan_son_las_nueve_contractuales() -> None:
    assert tuple(_familias()) == CONTRACTUALES


async def test_toda_tabla_de_servicios_esta_clasificada_una_vez() -> None:
    """28 tablas: o frena o consta por qué no. Una tabla nueva de Servicios
    sin clasificar pone esto en rojo."""
    frenan = set(_familias())
    no_frenan = {modelo.__tablename__: clase for modelo, clase in conservacion.NO_FRENAN.items()}
    assert len(DE_SERVICIOS) == 28
    assert frenan.isdisjoint(no_frenan)
    assert sorted(frenan | set(no_frenan)) == DE_SERVICIOS
    assert set(no_frenan.values()) == {
        conservacion.DESCARTABLE, conservacion.DOCUMENTAL, conservacion.DERIVADO, conservacion.DE_LA_PLATAFORMA,
    }
    # La retención sin reserva y lo guardado no son contractuales.
    assert no_frenan["service_holds"] == conservacion.DESCARTABLE
    assert no_frenan["saved_services"] == conservacion.DERIVADO


async def test_frena_todo_lo_que_cuelga_de_un_pedido_o_de_una_reserva() -> None:
    """Por las claves ajenas de los modelos (las mismas de la base, que las
    pruebas de migración comparan): todo lo que apunta, directa o
    indirectamente, a un pedido o a una reserva es contractual."""
    cuelgan = {"service_orders", "service_bookings"}
    while True:
        mas = {
            tabla.name for tabla in Base.metadata.tables.values()
            if any(clave.column.table.name in cuelgan for clave in tabla.foreign_keys)
        } - cuelgan
        if not mas:
            break
        cuelgan |= mas
    assert cuelgan == set(CONTRACTUALES)


async def test_la_consulta_es_una_sentencia_de_existencia_y_no_cuenta_ni_trae_filas() -> None:
    sql = str(conservacion.consulta("11111111-1111-4111-8111-111111111111").compile(dialect=postgresql.dialect()))
    minusculas = sql.lower()
    # Dos por familia: como quien contrató y como quien prestó.
    assert minusculas.count("exists (") == 2 * len(CONTRACTUALES)
    assert "count(" not in minusculas and minusculas.count("select") == 1 + 2 * len(CONTRACTUALES)
    for tabla in CONTRACTUALES:
        assert f" as {tabla}" in minusculas, tabla
    # Por la PARTE de la reserva, no por quien escribió una línea.
    for columna in ("author_id", "opened_by", "resolved_by", "accepted_by", "actor_id"):
        assert columna not in minusculas, columna


# =========================================================================== #
# Ayudas (PostgreSQL)
# =========================================================================== #
_TABLAS_DE_LA_FOTO = (*DE_SERVICIOS, "profiles", "audit_events", "notifications")


async def _foto(motor) -> dict[str, tuple]:
    """Cuántas filas y su contenido, tabla por tabla: «nada cambió»."""
    foto = {}
    async with motor.connect() as conexion:
        for tabla in _TABLAS_DE_LA_FOTO:
            foto[tabla] = tuple((await conexion.execute(text(
                "select count(*), coalesce(md5(string_agg(md5(t::text), '' order by md5(t::text))), '') "
                f"from public.{tabla} t"
            ))).one())
        foto["auth.users"] = tuple((await conexion.execute(text("select count(*) from auth.users"))).one())
    return foto


async def _frenada(app, motor, almacen, uid: str) -> None:
    """La baja de `uid` contesta 409 con el código de F21 y NO CAMBIA NADA:
    ni una fila, ni un archivo, ni una llamada a Storage."""
    antes, archivos, llamadas = await _foto(motor), {d: dict(o) for d, o in almacen.objetos.items()}, len(almacen.borrados)
    r = await _borrar_cuenta(app, uid)
    assert r.status_code == 409, r.text
    assert r.json()["error"] == {"code": CODIGO, "message": baja.HistoriaDeServicios.message, "details": None}
    assert await _existe(motor, uid)
    assert await _foto(motor) == antes
    assert almacen.objetos == archivos and len(almacen.borrados) == llamadas


async def _historia(app, motor, almacen) -> dict:
    """UNA reserva con todo lo que una reserva puede tener: la nota de quien
    contrata, lo aceptado, la atención cerrada, un caso resuelto con su
    evidencia, y la reseña."""
    perfil, servicio, jefa, moderador = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = await _retener(app, cliente, servicio, inicio)
    assert r.status_code == 201, r.text
    retencion = r.json()["id"]
    r = await _confirmar(app, cliente, retencion,
                         _aceptando(await _resumen(app, cliente, retencion), note="Llevo mis apuntes del curso."))
    assert r.status_code == 201, r.text
    h = {"perfil": perfil, "servicio": servicio, "jefa": jefa, "moderador": moderador, "cliente": cliente,
         "retencion": retencion, "reserva": r.json()}
    reserva = h["reserva"]["id"]
    await _llevar(motor, reserva, minutos=5)
    codigo = (await _hacer(app, "client", h, "check-in-code")).json()["checkin_code"]
    assert (await _hacer(app, "provider", h, "start", {"code": codigo})).status_code == 200
    await _llevar(motor, reserva, minutos=-20)
    r = await _hacer(app, "client", h, "incident", {"reason": "quality", "description": DESCRIPCION})
    assert r.status_code == 201, r.text
    h["caso"] = r.json()["id"]
    r = await _pedir_archivo(app, h)
    assert r.status_code == 201, r.text
    assert (await _resolver(app, jefa, h["caso"], attention_effect="completed")).status_code == 200
    assert (await _hacer(app, "client", h, "review", RESENA)).status_code == 201
    assert len(almacen.de(posventa.DEPOSITO, cliente)) == 1
    return h


async def _pedir_archivo(app, h: dict):
    from tests.test_baja_de_cuenta_postgres import _cliente

    async with _cliente(app, h["cliente"]) as http:
        return await http.post(
            f"/api/v1/services/me/bookings/{h['reserva']['id']}/incident/evidence",
            files={"file": ("a.pdf", PDF, "application/pdf")}, headers={"Idempotency-Key": _clave()},
        )


#: De cada familia, sus filas en UNA reserva.
_DE_LA_RESERVA = {
    "service_orders": "select count(*) from public.service_orders o join public.service_bookings b on b.order_id = o.id "
                      "where b.id = cast(:b as uuid)",
    "service_bookings": "select count(*) from public.service_bookings where id = cast(:b as uuid)",
    "service_booking_intakes": "select count(*) from public.service_booking_intakes where booking_id = cast(:b as uuid)",
    "service_booking_acceptances": "select count(*) from public.service_booking_acceptances a "
                                   "join public.service_bookings b on b.order_id = a.order_id where b.id = cast(:b as uuid)",
    "service_booking_events": "select count(*) from public.service_booking_events where booking_id = cast(:b as uuid)",
    "service_attendances": "select count(*) from public.service_attendances where booking_id = cast(:b as uuid)",
    "service_incidents": "select count(*) from public.service_incidents where booking_id = cast(:b as uuid)",
    "service_incident_entries": "select count(*) from public.service_incident_entries e "
                                "join public.service_incidents i on i.id = e.incident_id where i.booking_id = cast(:b as uuid)",
    "service_reviews": "select count(*) from public.service_reviews where booking_id = cast(:b as uuid)",
}


# =========================================================================== #
# 2. Cada familia frena por sí sola, a las dos partes
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.parametrize("tabla", CONTRACTUALES)
async def test_cada_familia_contractual_frena_la_baja_por_si_sola(atencion, monkeypatch, tabla) -> None:  # noqa: F811
    """Con la comprobación reducida a UNA familia, la baja sigue frenada para
    quien contrató y para quien prestó. Quitar esa familia de `FAMILIAS` deja
    esta prueba sin su familia (rojo): ninguna se puede retirar en silencio."""
    app, motor, almacen = atencion
    h = await _historia(app, motor, almacen)
    assert await _uno(motor, _DE_LA_RESERVA[tabla], b=h["reserva"]["id"]) >= 1, tabla
    monkeypatch.setattr(conservacion, "FAMILIAS", (_familias()[tabla],))
    for parte in (h["cliente"], h["perfil"]):
        async with motor.connect() as conexion:
            from sqlalchemy.ext.asyncio import AsyncSession

            sesion = AsyncSession(bind=conexion)
            try:
                assert await conservacion.de_la_persona(sesion, parte) == (tabla,)
            finally:
                await sesion.close()
        await _frenada(app, motor, almacen, parte)


@SIN_POSTGRES
async def test_la_historia_completa_dice_sus_nueve_familias_y_la_respuesta_ninguna(atencion, caplog) -> None:  # noqa: F811
    """El registro (para soporte) nombra las familias; la respuesta, no: ni
    cuáles ni cuántas, ni a quien contrató ni a quien prestó."""
    import logging

    app, motor, almacen = atencion
    h = await _historia(app, motor, almacen)
    for parte in (h["cliente"], h["perfil"]):
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            r = await _borrar_cuenta(app, parte)
        assert r.status_code == 409 and _codigo(r) == CODIGO, r.text
        registro = " ".join(x.getMessage() for x in caplog.records)
        for tabla in CONTRACTUALES:
            assert tabla in registro and tabla not in r.text, tabla
        assert h["reserva"]["id"] not in r.text and h["caso"] not in r.text
    # Quien resolvió el caso desde administración figura en el expediente y NO
    # es parte de la reserva: su cuenta no se frena por eso.
    assert await _uno(motor, "select count(*) from public.service_incidents where resolved_by = cast(:u as uuid)",
                      u=h["jefa"]) == 1
    assert (await _borrar_cuenta(app, h["jefa"])).status_code == 204
    # Y una persona sin nada que ver, tampoco.
    assert (await _borrar_cuenta(app, await _persona(motor))).status_code == 204


# =========================================================================== #
# 3. En cualquier estado: lo vivo y lo cerrado
# =========================================================================== #
@SIN_POSTGRES
async def test_una_reserva_por_venir_frena_a_las_dos_partes_y_la_base_tambien(atencion, monkeypatch) -> None:  # noqa: F811
    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)
        # Repetir no cambia la respuesta.
        await _frenada(app, motor, almacen, parte)

    # LA SEGUNDA LÍNEA. Aunque la comprobación no viera nada, la base no deja
    # borrar una reserva por venir (0093): 409, y tampoco se toca nada.
    async def _nada(db, perfil_id):
        return ()

    monkeypatch.setattr(conservacion, "de_la_persona", _nada)
    for parte in (h["cliente"], h["perfil"]):
        antes = await _foto(motor)
        r = await _borrar_cuenta(app, parte)
        assert r.status_code == 409 and _codigo(r) == "account_deletion_blocked", r.text
        assert await _foto(motor) == antes and almacen.borrados == []


@SIN_POSTGRES
async def test_una_reserva_pasada_sin_atencion_tambien_frena(atencion) -> None:  # noqa: F811
    """Antes, la de quien contrató se borraba y dejaba la reserva sin su
    nombre; la de quien prestó se llevaba la reserva entera."""
    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)


@SIN_POSTGRES
async def test_una_reserva_cancelada_es_historia(atencion) -> None:  # noqa: F811
    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    assert (await _hacer(app, "client", h, "cancel", {})).status_code == 200
    assert await _uno(motor, "select status from public.service_bookings where id = cast(:b as uuid)",
                      b=h["reserva"]["id"]) == "cancelled"
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)


@SIN_POSTGRES
async def test_una_atencion_cerrada_frena(atencion) -> None:  # noqa: F811
    app, motor, almacen = atencion
    h = await _atendida(app, motor)
    assert await _uno(motor, "select status from public.service_attendances where booking_id = cast(:b as uuid)",
                      b=h["reserva"]["id"]) == "closed"
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)


@SIN_POSTGRES
@pytest.mark.parametrize("estado", ["withdrawn", "resolved", "appealed", "closed"])
async def test_un_caso_frena_en_cualquier_estado(atencion, estado) -> None:  # noqa: F811
    app, motor, almacen = atencion
    h = await _con_caso(app, motor)
    otra_jefa = await _persona(motor, "admin")
    if estado == "withdrawn":
        assert (await _hacer(app, "client", h, "incident/withdraw")).status_code == 200
    else:
        assert (await _resolver(app, h["jefa"], h["caso"], attention_effect="completed")).status_code == 200
    if estado in ("appealed", "closed"):
        r = await _hacer(app, "provider", h, "incident/appeal", {"body": "No estoy de acuerdo con la decisión tomada."})
        assert r.status_code == 200, r.text
    if estado == "closed":
        assert (await _resolver(app, otra_jefa, h["caso"], outcome="rejected")).status_code == 200
    assert await _uno(motor, "select status from public.service_incidents where id = cast(:c as uuid)",
                      c=h["caso"]) == estado
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)


@SIN_POSTGRES
async def test_una_resena_publicada_u_oculta_frena(atencion) -> None:  # noqa: F811
    app, motor, almacen = atencion
    h = await _atendida(app, motor)
    r = await _hacer(app, "client", h, "review", RESENA)
    assert r.status_code == 201 and r.json()["care"]["review"]["status"] == "published", r.text
    resena = r.json()["care"]["review"]["id"]
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)
    r = await _pedir(app, "POST", f"{RESENAS}/{resena}/moderate", h["jefa"],
                     {"action": "hide", "reason": "off_topic"}, _clave())
    assert r.status_code == 200 and r.json()["status"] == "hidden", r.text
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)


@SIN_POSTGRES
async def test_con_servicios_apagado_la_historia_sigue_frenando(atencion, monkeypatch) -> None:  # noqa: F811
    """Apagar las banderas no convierte la historia en descartable."""
    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    ajustes = get_settings()
    monkeypatch.setattr(ajustes, "feature_services", False)
    monkeypatch.setattr(ajustes, "feature_service_booking", False)
    for parte in (h["cliente"], h["perfil"]):
        await _frenada(app, motor, almacen, parte)


# =========================================================================== #
# 4. Lo que NO es contractual no frena
# =========================================================================== #
@SIN_POSTGRES
async def test_un_servicio_publicado_que_nadie_contrato_se_va_con_la_cuenta(atencion) -> None:  # noqa: F811
    """El catálogo, la agenda, una retención que no llegó a reserva y lo que
    alguien guardó: operativo o derivado. La baja de quien presta se permite
    SIN retiro previo, y la de quien solo apartó un horario o guardó, también."""
    app, motor, _ = atencion
    perfil, servicio, jefa, _moderador = await _servicio(app, motor)
    await _condiciones(app, jefa)
    con_retencion, guardo, solto = await _persona(motor), await _persona(motor), await _persona(motor)
    horarios = await _horarios(app, servicio, _dia(7))
    r = await _retener(app, con_retencion, servicio, horarios[0]["starts_at"])
    assert r.status_code == 201, r.text
    r = await _retener(app, solto, servicio, horarios[1]["starts_at"])
    assert r.status_code == 201, r.text
    assert (await _pedir(app, "POST", f"/api/v1/services/holds/{r.json()['id']}/release", solto, None, _clave())).status_code == 200
    r = await _pedir(app, "POST", f"{CATALOGO}/{servicio}/save", guardo)
    assert r.status_code in (200, 201), r.text
    assert await _uno(motor, "select count(*) from public.service_holds where service_id = cast(:s as uuid)", s=servicio) == 2
    assert await _uno(motor, "select count(*) from public.service_bookings where service_id = cast(:s as uuid)", s=servicio) == 0

    for persona in (solto, guardo, con_retencion):
        r = await _borrar_cuenta(app, persona)
        assert r.status_code == 204, r.text
        assert not await _existe(motor, persona)
    r = await _borrar_cuenta(app, perfil)
    assert r.status_code == 204, r.text
    assert not await _existe(motor, perfil)
    for tabla in ("services", "service_schedules", "service_holds", "saved_services"):
        columna = "id" if tabla == "services" else "service_id"
        assert await _uno(motor, f"select count(*) from public.{tabla} where {columna} = cast(:s as uuid)", s=servicio) == 0


@SIN_POSTGRES
async def test_el_token_de_una_persona_no_borra_ni_destraba_la_cuenta_de_otra(atencion) -> None:  # noqa: F811
    """La identidad sale del token. Con el id de otra persona en la consulta,
    en el cuerpo o en una cabecera, se borra la cuenta PROPIA y la ajena —y su
    historia— siguen intactas."""
    from tests.test_baja_de_cuenta_postgres import ME, _cliente

    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    ajena = await _filas(motor, "select id::text, client_id::text, provider_id::text, status from public.service_bookings "
                                "where id = cast(:b as uuid)", b=h["reserva"]["id"])
    otra = await _persona(motor)
    async with _cliente(app, otra) as http:
        r = await http.request("DELETE", ME, params={"user_id": h["cliente"], "id": h["perfil"]},
                               json={"user_id": h["cliente"]}, headers={"x-user-id": h["cliente"]})
    assert r.status_code == 204, r.text
    assert not await _existe(motor, otra)
    assert await _existe(motor, h["cliente"]) and await _existe(motor, h["perfil"])
    assert await _filas(motor, "select id::text, client_id::text, provider_id::text, status from public.service_bookings "
                               "where id = cast(:b as uuid)", b=h["reserva"]["id"]) == ajena
    await _frenada(app, motor, almacen, h["cliente"])


# =========================================================================== #
# 5. Si no se puede mirar, no se borra
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.parametrize("donde", ["consulta", "cerrojos"])
async def test_un_error_al_mirar_es_503_y_no_se_toca_nada(atencion, monkeypatch, donde) -> None:  # noqa: F811
    """Ni para la cuenta con historia ni para la que no la tiene: una cuenta
    que no se pudo mirar no se da por limpia. Y el fallo no se recuerda."""
    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    limpia = await _persona(motor)
    if donde == "consulta":
        monkeypatch.setattr(conservacion, "consulta", lambda perfil_id, familias=None: text("select 1 / 0"))
    else:
        async def _revienta(db, perfil_id):
            await db.execute(text("select 1 / 0"))

        monkeypatch.setattr(conservacion, "_poner_en_fila", _revienta)
    for persona in (h["cliente"], h["perfil"], limpia):
        antes, llamadas = await _foto(motor), len(almacen.borrados)
        r = await _borrar_cuenta(app, persona)
        assert r.status_code == 503 and _codigo(r) == "account_deletion_unavailable", r.text
        assert await _existe(motor, persona) and await _foto(motor) == antes and len(almacen.borrados) == llamadas
    monkeypatch.undo()
    assert (await _borrar_cuenta(app, limpia)).status_code == 204


# =========================================================================== #
# 6. A la vez
# =========================================================================== #
@SIN_POSTGRES
async def test_dos_bajas_a_la_vez_con_historia_son_dos_409_y_nada_cambia(atencion) -> None:  # noqa: F811
    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    for parte in (h["cliente"], h["perfil"]):
        antes = await _foto(motor)
        respuestas = await asyncio.gather(*(_borrar_cuenta(app, parte) for _ in range(4)))
        assert [(r.status_code, _codigo(r)) for r in respuestas] == [(409, CODIGO)] * 4
        assert await _foto(motor) == antes and almacen.borrados == []


async def _esperando(motor, minimo: int = 1) -> bool:
    """¿Hay alguna sesión esperando un cerrojo?"""
    for _ in range(50):
        if await _uno(motor, "select count(*) from pg_catalog.pg_stat_activity where wait_event_type = 'Lock' "
                             "and datname = current_database()") >= minimo:
            return True
        await asyncio.sleep(0.1)
    return False


@SIN_POSTGRES
async def test_la_baja_de_quien_presta_espera_a_una_contratacion_en_curso(atencion) -> None:  # noqa: F811
    """El cerrojo de quien confirma una reserva es el del servicio (FOR NO KEY
    UPDATE). Mientras alguien lo tiene, la baja de quien presta NO mira ni
    borra: espera. Si esa contratación termina en reserva, la ve."""
    app, motor, almacen = atencion
    perfil, servicio, _jefa, _moderador = await _servicio(app, motor)
    async with motor.connect() as contratando:
        await contratando.execute(text("select id from public.services where id = cast(:s as uuid) for no key update"),
                                  {"s": servicio})
        baja_en_curso = asyncio.create_task(_borrar_cuenta(app, perfil))
        assert await _esperando(motor)
        assert not baja_en_curso.done() and await _existe(motor, perfil) and almacen.borrados == []
        await contratando.rollback()
    assert (await baja_en_curso).status_code == 204
    assert not await _existe(motor, perfil)


@SIN_POSTGRES
async def test_la_baja_de_quien_contrata_espera_a_quien_escribe_a_su_nombre(atencion) -> None:  # noqa: F811
    """Escribir un pedido o una reserva a nombre de alguien comprueba la clave
    ajena a su perfil (FOR KEY SHARE). La baja toma su perfil FOR UPDATE antes
    de mirar: espera a esa escritura, y una nueva la espera a ella."""
    app, motor, almacen = atencion
    cliente = await _persona(motor)
    async with motor.connect() as escribiendo:
        await escribiendo.execute(text("select id from public.profiles where id = cast(:u as uuid) for key share"),
                                  {"u": cliente})
        baja_en_curso = asyncio.create_task(_borrar_cuenta(app, cliente))
        assert await _esperando(motor)
        assert not baja_en_curso.done() and await _existe(motor, cliente) and almacen.borrados == []
        await escribiendo.rollback()
    assert (await baja_en_curso).status_code == 204


@SIN_POSTGRES
@pytest.mark.parametrize("quien", ["prestador", "cliente"])
async def test_confirmar_y_borrar_a_la_vez_nunca_destruye_una_reserva(atencion, quien) -> None:  # noqa: F811
    """La carrera de verdad, varias veces: o la reserva nace y la baja se
    frena, o la baja gana y la reserva no nace. Nunca una reserva confirmada
    que desaparece o se queda sin su parte, y nunca un 500.

    ANTES de F21 esta carrera, con quien contrata, acababa en un interbloqueo
    (40P01) y la baja contestaba 500: borrar el perfil dejaba en NULL la
    retención que la confirmación tenía bloqueada, y la confirmación esperaba
    al perfil. Ahora la baja toma primero el cerrojo del servicio, como quien
    confirma."""
    app, motor, _ = atencion
    resultados = set()
    for _ in range(6):
        perfil, servicio, jefa, _moderador = await _servicio(app, motor)
        await _condiciones(app, jefa)
        cliente = await _persona(motor)
        inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
        r = await _retener(app, cliente, servicio, inicio)
        assert r.status_code == 201, r.text
        retencion = r.json()["id"]
        cuerpo = _aceptando(await _resumen(app, cliente, retencion))
        se_va = perfil if quien == "prestador" else cliente
        confirmada, borrada = await asyncio.gather(
            _confirmar(app, cliente, retencion, cuerpo), _borrar_cuenta(app, se_va)
        )
        assert confirmada.status_code != 500 and borrada.status_code != 500, (confirmada.text, borrada.text)
        reservas_del_servicio = await _filas(
            motor, "select client_id::text, status from public.service_bookings where service_id = cast(:s as uuid)",
            s=servicio)
        if confirmada.status_code == 201:
            assert (borrada.status_code, _codigo(borrada)) == (409, CODIGO), borrada.text
            assert await _existe(motor, se_va)
            assert reservas_del_servicio == [(cliente, "confirmed")]
        else:
            assert borrada.status_code == 204, (confirmada.text, borrada.text)
            assert not await _existe(motor, se_va) and reservas_del_servicio == []
        resultados.add((confirmada.status_code, borrada.status_code))
    # 404: la retención o el servicio ya no están. 409: la confirmación no
    # esperó más por el cerrojo (`service_booking_busy`).
    assert resultados <= {(201, 409), (404, 204), (409, 204)}, resultados


def _con_storage_detenido(monkeypatch) -> tuple[asyncio.Event, asyncio.Event]:
    """La baja se queda DENTRO de Storage (con la base ya borrada sin
    confirmar y todos sus cerrojos) hasta que se le diga que siga."""
    dentro, seguir = asyncio.Event(), asyncio.Event()
    original = storage.delete_user_files

    async def detenido(*args, **kwargs):
        dentro.set()
        await seguir.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(storage, "delete_user_files", detenido)
    return dentro, seguir


@SIN_POSTGRES
@pytest.mark.parametrize("quien", ["prestador", "cliente"])
async def test_si_la_baja_va_primero_la_reserva_no_nace(atencion, monkeypatch, quien) -> None:  # noqa: F811
    """La otra mitad de la carrera, SIN DEJARLA AL AZAR (hallazgo de la
    revisión: la prueba de arriba podía pasar ejercitando una sola rama). La
    baja ya miró y está borrando; quien confirma ESPERA; y cuando la baja
    termina, la reserva no nace."""
    app, motor, _ = atencion
    perfil, servicio, jefa, _moderador = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = await _retener(app, cliente, servicio, inicio)
    assert r.status_code == 201, r.text
    retencion = r.json()["id"]
    cuerpo = _aceptando(await _resumen(app, cliente, retencion))
    se_va = perfil if quien == "prestador" else cliente
    dentro, seguir = _con_storage_detenido(monkeypatch)

    baja_en_curso = asyncio.create_task(_borrar_cuenta(app, se_va))
    await asyncio.wait_for(dentro.wait(), 20)
    confirmando = asyncio.create_task(_confirmar(app, cliente, retencion, cuerpo))
    assert await _esperando(motor)
    assert not confirmando.done() and not baja_en_curso.done()
    seguir.set()
    borrada, confirmada = await baja_en_curso, await confirmando

    assert borrada.status_code == 204, borrada.text
    assert confirmada.status_code in (404, 409), confirmada.text
    assert not await _existe(motor, se_va)
    assert await _uno(motor, "select count(*) from public.service_bookings b join public.service_holds h "
                             "on h.id = b.hold_id where h.id = cast(:h as uuid)", h=retencion) == 0
    assert await _uno(motor, "select count(*) from public.service_orders where client_id = cast(:u as uuid)", u=cliente) == 0


@SIN_POSTGRES
async def test_la_baja_de_quien_aparto_un_horario_no_deja_esperando_a_los_demas(atencion, monkeypatch) -> None:  # noqa: F811
    """Hallazgo de la revisión. Para ponerse en fila con una confirmación
    suya, la baja de quien apartó un horario bloqueaba EL SERVICIO de otro
    prestador hasta terminar de borrar archivos: los demás recibían
    `service_booking_busy`. Ahora bloquea su retención, que es solo suya."""
    app, motor, _ = atencion
    _perfil, servicio, _jefa, _moderador = await _servicio(app, motor)
    se_va, otra = await _persona(motor), await _persona(motor)
    horarios = await _horarios(app, servicio, _dia(7))
    assert (await _retener(app, se_va, servicio, horarios[0]["starts_at"])).status_code == 201
    dentro, seguir = _con_storage_detenido(monkeypatch)

    baja_en_curso = asyncio.create_task(_borrar_cuenta(app, se_va))
    await asyncio.wait_for(dentro.wait(), 20)
    # Con la baja a medias, otra persona aparta otro horario del mismo servicio SIN esperar.
    r = await asyncio.wait_for(_retener(app, otra, servicio, horarios[1]["starts_at"]), 3)
    assert r.status_code == 201, r.text
    assert not baja_en_curso.done()
    seguir.set()
    assert (await baja_en_curso).status_code == 204


@SIN_POSTGRES
async def test_si_alguien_retiene_el_servicio_la_baja_no_se_queda_colgada(atencion, monkeypatch) -> None:  # noqa: F811
    """Hallazgo de la revisión: la baja esperaba el cerrojo del servicio sin
    límite. Espera lo que una contratación (`ESPERA_DEL_CERROJO_MS`) y, si no
    llega, es un 503 que se reintenta: nada borrado, ningún archivo tocado."""
    app, motor, almacen = atencion
    perfil, servicio, _jefa, _moderador = await _servicio(app, motor)
    monkeypatch.setattr(limites, "ESPERA_DEL_CERROJO_MS", 400)
    antes = await _foto(motor)
    async with motor.connect() as atascada:
        await atascada.execute(text("select id from public.services where id = cast(:s as uuid) for update"),
                               {"s": servicio})
        r = await asyncio.wait_for(_borrar_cuenta(app, perfil), 10)
        assert r.status_code == 503 and _codigo(r) == "account_deletion_unavailable", r.text
        await atascada.rollback()
    assert await _existe(motor, perfil) and await _foto(motor) == antes and almacen.borrados == []
    assert (await _borrar_cuenta(app, perfil)).status_code == 204


@SIN_POSTGRES
async def test_la_baja_espera_a_su_retencion_sin_tener_todavia_su_perfil(atencion) -> None:  # noqa: F811
    """EL ORDEN, que es lo que evita el interbloqueo con una confirmación
    suya: la retención ANTES que el perfil. Quien confirma tiene su retención
    y después escribe a nombre de la persona; si la baja tuviera ya el perfil
    mientras espera la retención, se esperarían la una a la otra."""
    app, motor, almacen = atencion
    _perfil, servicio, _jefa, _moderador = await _servicio(app, motor)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = await _retener(app, cliente, servicio, inicio)
    assert r.status_code == 201, r.text
    async with motor.connect() as confirmando, motor.connect() as escribiendo:
        await confirmando.execute(text("select id from public.service_holds where id = cast(:h as uuid) for update"),
                                  {"h": r.json()["id"]})
        baja_en_curso = asyncio.create_task(_borrar_cuenta(app, cliente))
        assert await _esperando(motor)
        assert not baja_en_curso.done() and almacen.borrados == []
        # El perfil sigue libre: quien confirma puede escribir a su nombre (FOR KEY SHARE) sin esperar.
        await escribiendo.execute(
            text("select id from public.profiles where id = cast(:u as uuid) for key share nowait"), {"u": cliente})
        await escribiendo.rollback()
        await confirmando.rollback()
    assert (await baja_en_curso).status_code == 204


@SIN_POSTGRES
async def test_dos_bajas_a_la_vez_la_segunda_espera_a_la_primera_lo_que_haga_falta(atencion, monkeypatch) -> None:  # noqa: F811
    """El cerrojo del perfil NO tiene el límite de los otros dos: la segunda
    baja espera a que la primera termine de borrar archivos y contesta 204,
    no un 503."""
    app, motor, _ = atencion
    nadie = await _persona(motor)
    monkeypatch.setattr(limites, "ESPERA_DEL_CERROJO_MS", 300)
    dentro, seguir = _con_storage_detenido(monkeypatch)
    primera = asyncio.create_task(_borrar_cuenta(app, nadie))
    await asyncio.wait_for(dentro.wait(), 20)
    segunda = asyncio.create_task(_borrar_cuenta(app, nadie))
    assert await _esperando(motor)
    await asyncio.sleep(1.2)  # cuatro veces el límite de los otros cerrojos
    assert not segunda.done() and not primera.done()
    seguir.set()
    assert [(await primera).status_code, (await segunda).status_code] == [204, 204]
    assert not await _existe(motor, nadie)


# =========================================================================== #
# 6b. La base no tiene por qué tener todas las migraciones
# =========================================================================== #
_TABLAS_DE_LA_0094 = ("service_reviews", "service_incident_entries", "service_incidents", "service_attendances")
_TABLAS_DE_LA_0093 = ("service_booking_events", "service_booking_acceptances", "service_booking_intakes",
                  "service_bookings", "service_orders")


async def _borrar_en_una_base_sin(app, motor, uid: str, tablas: tuple[str, ...]):
    """La baja de `uid` con `tablas` quitadas, todo dentro de una transacción
    que SE DESHACE: la base de la prueba no cambia."""
    from sqlalchemy.ext.asyncio import AsyncSession

    normal = app.dependency_overrides[get_db]
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        sesion = AsyncSession(bind=conexion, expire_on_commit=False)
        app.dependency_overrides[get_db] = _siempre(sesion)
        try:
            await conexion.execute(text("drop table " + ", ".join(f"public.{t}" for t in tablas) + " cascade"))
            return await _borrar_cuenta(app, uid)
        finally:
            app.dependency_overrides[get_db] = normal
            await sesion.close()
            if transaccion.is_active:
                await transaccion.rollback()


@SIN_POSTGRES
async def test_sin_las_tablas_de_la_contratacion_la_baja_sigue_y_con_parte_de_ellas_mira_lo_que_hay(atencion) -> None:  # noqa: F811
    """Hallazgo de la revisión: la baja exigía que existieran las tablas de
    Servicios y, sin ellas, contestaba 503 para siempre. El código no puede
    exigir que su migración esté aplicada."""
    app, motor, almacen = atencion
    h = await _reservado(app, motor)
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 60)
    limpia = await _persona(motor)
    antes = await _foto(motor)
    # Sin la atención (0094) y con la contratación (0093): la reserva frena igual.
    for parte in (h["cliente"], h["perfil"]):
        r = await _borrar_en_una_base_sin(app, motor, parte, _TABLAS_DE_LA_0094)
        assert r.status_code == 409 and _codigo(r) == CODIGO, r.text
    # Sin ninguna de las dos: no hay historia contractual que mirar, y la baja no se rompe.
    r = await _borrar_en_una_base_sin(app, motor, limpia, (*_TABLAS_DE_LA_0094, *_TABLAS_DE_LA_0093))
    assert r.status_code == 204, r.text
    # Todo se deshizo: la base y sus tablas siguen como estaban.
    assert await _foto(motor) == antes and await _existe(motor, limpia)
    await _frenada(app, motor, almacen, h["cliente"])


# =========================================================================== #
# 7. Eficiente: por índices, sin recorrer las tablas
# =========================================================================== #
@SIN_POSTGRES
async def test_la_consulta_entra_por_indices_en_todas_las_familias(atencion) -> None:  # noqa: F811
    """Con los recorridos secuenciales desactivados, el plan no tiene ninguno:
    cada `EXISTS` tiene un índice por el que entrar (los que ya existían)."""
    _, motor, _ = atencion
    sql = str(conservacion.consulta("11111111-1111-4111-8111-111111111111").compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    async with motor.connect() as conexion:
        await conexion.execute(text("set local enable_seqscan = off"))
        plan = "\n".join(f[0] for f in (await conexion.execute(text("explain " + sql.replace(":", "\\:")))).all())
        await conexion.rollback()
    assert "Seq Scan" not in plan, plan
    assert plan.count("Index") >= 2 * len(CONTRACTUALES), plan
