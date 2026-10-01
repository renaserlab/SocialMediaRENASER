"""Las reglas de la atención de Servicios, SIN base (Incremento 6).

`acciones_disponibles` es la única lista de lo que una persona puede hacer con
una reserva; `plazos`, sus momentos; `estado_del_efecto`, lo único que decide
en qué queda un efecto económico solicitado. Aquí se recorren con objetos de
mentira: cada estado, cada papel y cada límite de tiempo.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.modules.services import atencion
from app.modules.services import reserva_politica as limites
from app.modules.services.atencion_models import ESTADOS_DE_ATENCION, ESTADOS_DE_CASO, ESTADOS_DEL_EFECTO

INICIO = datetime(2031, 3, 3, 15, 0, tzinfo=timezone.utc)
FIN = INICIO + timedelta(minutes=60)
CLIENTE, PERFIL = "c" * 8, "p" * 8
POLITICA = limites.PoliticaDeAtencion(
    llegada_minutos=15, tolerancia_minutos=15, confirmacion_horas=24, reprogramaciones=1,
    reprogramar_horas_antes=24, recordatorio_horas=24, caso_horas=48, apelacion_dias=5, resena_dias=30,
    resena_con_moderacion_previa=True,
)


def _reserva(estado: str = "confirmed"):
    return SimpleNamespace(id="b", status=estado, starts_at=INICIO, ends_at=FIN, version_id="v1", client_id=CLIENTE)


def _atencion(estado: str, **extra):
    base = {"status": estado, "completed_at": None, "closed_at": None, "started_with_code": False}
    return SimpleNamespace(**{**base, **extra})


def _caso(estado: str = "open", *, abierto_por: str = CLIENTE, resoluciones: int = 0, resuelto=None):
    return SimpleNamespace(status=estado, opened_by=abierto_por, resolutions=resoluciones, resolved_at=resuelto)


def _resena(estado: str = "published", respuesta: str | None = None):
    return SimpleNamespace(status=estado, reply=respuesta)


def _acciones(rol: str, *, ahora: datetime, reserva=None, atendiendo=None, caso=None, resena=None,
              reprogramaciones: int = 0, version: str | None = "v1", activo: bool = True) -> set[str]:
    return set(atencion.acciones_disponibles(
        rol=rol, usuario_id=CLIENTE if rol == "client" else PERFIL, reserva=reserva or _reserva(),
        atencion=atendiendo, caso=caso, resena=resena, ahora=ahora, politica=POLITICA,
        reprogramaciones=reprogramaciones, version_vigente=version, prestador_activo=activo,
    ))


# --------------------------------------------------------------------------- #
# Antes de empezar
# --------------------------------------------------------------------------- #
def test_con_tiempo_se_cancela_y_se_reprograma_y_nada_mas() -> None:
    ahora = INICIO - timedelta(days=7)
    assert _acciones("client", ahora=ahora) == {"cancel", "reschedule"}
    assert _acciones("provider", ahora=ahora) == {"cancel"}


@pytest.mark.parametrize(
    ("falta", "reprogramaciones", "version", "se_puede"),
    [
        (timedelta(hours=24), 0, "v1", True),       # justo en el límite
        (timedelta(hours=23, minutes=59), 0, "v1", False),
        (timedelta(days=3), 1, "v1", False),        # ya la movió una vez
        (timedelta(days=3), 0, "v2", False),        # el servicio publicó otra versión
        (timedelta(days=3), 0, None, False),        # el servicio ya no es público
    ],
)
def test_reprogramar_tiene_su_antelacion_su_tope_y_su_contrato(falta, reprogramaciones, version, se_puede) -> None:
    acciones = _acciones("client", ahora=INICIO - falta, reprogramaciones=reprogramaciones, version=version)
    assert ("reschedule" in acciones) is se_puede
    assert "cancel" in acciones  # cancelar no depende de nada de eso


def test_la_llegada_se_abre_antes_de_la_hora_y_se_cierra_al_terminar() -> None:
    for minutos, abierta in ((-16, False), (-15, True), (0, True), (60, True), (61, False)):
        ahora = INICIO + timedelta(minutes=minutos)
        assert ("issue_code" in _acciones("client", ahora=ahora)) is abierta, minutos
        assert ("start" in _acciones("provider", ahora=ahora)) is abierta, minutos
    # Con el código pedido se sigue pudiendo empezar; un prestador suspendido, no.
    con_codigo = _atencion("code_issued")
    assert "start" in _acciones("provider", ahora=INICIO, atendiendo=con_codigo)
    assert "start" not in _acciones("provider", ahora=INICIO, atendiendo=con_codigo, activo=False)


def test_en_la_hora_de_inicio_ya_no_se_cancela() -> None:
    assert "cancel" in _acciones("client", ahora=INICIO - timedelta(seconds=1))
    for rol in ("client", "provider"):
        assert "cancel" not in _acciones(rol, ahora=INICIO)


def test_la_inasistencia_se_declara_pasada_la_tolerancia_y_dentro_del_plazo() -> None:
    for minutos, se_puede in ((14, False), (15, True), (60 + 48 * 60, True), (60 + 48 * 60 + 1, False)):
        ahora = INICIO + timedelta(minutes=minutos)
        for rol in ("client", "provider"):
            assert ("report_absence" in _acciones(rol, ahora=ahora)) is se_puede, (rol, minutos)


# --------------------------------------------------------------------------- #
# La atención, estado a estado
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("estado", [e for e in ESTADOS_DE_ATENCION if e != "code_issued"])
def test_lo_que_ya_empezo_no_se_cancela_ni_se_mueve_ni_se_declara_ausente(estado) -> None:
    atendiendo = _atencion(estado, completed_at=FIN, closed_at=FIN if estado == "closed" else None)
    for ahora in (INICIO - timedelta(days=3), INICIO + timedelta(minutes=30)):
        for rol in ("client", "provider"):
            acciones = _acciones(rol, ahora=ahora, atendiendo=atendiendo)
            assert not acciones & {"cancel", "reschedule", "issue_code", "start", "report_absence"}, (estado, rol)


def test_cada_estado_de_la_atencion_ofrece_lo_suyo() -> None:
    ahora = INICIO + timedelta(minutes=30)
    esperado = {
        "in_progress": ({"confirm", "open_incident"}, {"complete", "open_incident"}),
        "completed": ({"confirm", "open_incident"}, {"open_incident"}),
        "closed": ({"review", "open_incident"}, {"open_incident"}),
        "no_show_client": ({"open_incident"}, {"open_incident"}),
        "no_show_provider": ({"open_incident"}, {"open_incident"}),
    }
    for estado, (cliente, prestador) in esperado.items():
        atendiendo = _atencion(estado, completed_at=ahora, closed_at=ahora if estado == "closed" else None)
        assert _acciones("client", ahora=ahora, atendiendo=atendiendo) == cliente, estado
        assert _acciones("provider", ahora=ahora, atendiendo=atendiendo) == prestador, estado


def test_una_reserva_cancelada_no_ofrece_nada() -> None:
    for ahora in (INICIO - timedelta(days=3), INICIO, INICIO + timedelta(days=1)):
        for rol in ("client", "provider"):
            assert _acciones(rol, ahora=ahora, reserva=_reserva("cancelled")) == set()
            assert _acciones(rol, ahora=ahora, reserva=_reserva("cancelled"),
                             atendiendo=_atencion("code_issued")) == set()


# --------------------------------------------------------------------------- #
# El caso
# --------------------------------------------------------------------------- #
def test_un_caso_vivo_impide_confirmar_y_solo_lo_retira_quien_lo_abrio() -> None:
    ahora = INICIO + timedelta(minutes=30)
    atendiendo = _atencion("completed", completed_at=ahora)
    abierto = _caso("open")
    cliente = _acciones("client", ahora=ahora, atendiendo=atendiendo, caso=abierto)
    prestador = _acciones("provider", ahora=ahora, atendiendo=atendiendo, caso=abierto)
    assert cliente == {"add_incident_entry", "withdraw_incident"}
    assert prestador == {"add_incident_entry"}
    # Abierto por el prestador, es él quien lo retira.
    suyo = _caso("open", abierto_por=PERFIL)
    assert "withdraw_incident" in _acciones("provider", ahora=ahora, atendiendo=atendiendo, caso=suyo)
    assert "withdraw_incident" not in _acciones("client", ahora=ahora, atendiendo=atendiendo, caso=suyo)


def test_se_apela_una_vez_dentro_de_su_plazo() -> None:
    resuelto_el = INICIO + timedelta(days=1)
    atendiendo = _atencion("completed", completed_at=FIN)
    resuelto = _caso("resolved", resoluciones=1, resuelto=resuelto_el)
    for dias, se_puede in ((0, True), (5, True), (5.01, False)):
        ahora = resuelto_el + timedelta(days=dias)
        for rol in ("client", "provider"):
            assert ("appeal_incident" in _acciones(rol, ahora=ahora, atendiendo=atendiendo, caso=resuelto)) is se_puede
    # Resuelto, ya no se escribe ni se retira; y la atención se puede confirmar otra vez.
    acciones = _acciones("client", ahora=resuelto_el, atendiendo=atendiendo, caso=resuelto)
    assert acciones == {"appeal_incident", "confirm"}
    # Apelado: se escribe, no se apela otra vez. Cerrado o retirado: nada del caso.
    apelado = _caso("appealed", resoluciones=1, resuelto=resuelto_el)
    assert _acciones("provider", ahora=resuelto_el, atendiendo=atendiendo, caso=apelado) == {"add_incident_entry"}
    for final, resoluciones in (("closed", 2), ("withdrawn", 0)):
        fin = _caso(final, resoluciones=resoluciones, resuelto=resuelto_el if resoluciones else None)
        for rol in ("client", "provider"):
            assert not [a for a in _acciones(rol, ahora=resuelto_el, atendiendo=atendiendo, caso=fin)
                        if "incident" in a], (final, rol)


def test_los_estados_de_un_caso_estan_todos_cubiertos() -> None:
    assert set(ESTADOS_DE_CASO) == {"open", "resolved", "appealed", "closed", "withdrawn"}
    assert set(ESTADOS_DE_ATENCION) == {"code_issued", "in_progress", "completed", "closed", "no_show_client",
                                        "no_show_provider"}


# --------------------------------------------------------------------------- #
# La reseña
# --------------------------------------------------------------------------- #
def test_la_resena_es_de_una_atencion_cerrada_dentro_de_su_plazo_y_una() -> None:
    cerrada_el = FIN + timedelta(hours=1)
    cerrada = _atencion("closed", completed_at=FIN, closed_at=cerrada_el)
    for dias, se_puede in ((0, True), (30, True), (30.01, False)):
        acciones = _acciones("client", ahora=cerrada_el + timedelta(days=dias), atendiendo=cerrada)
        assert ("review" in acciones) is se_puede, dias
    assert "review" not in _acciones("client", ahora=cerrada_el, atendiendo=cerrada, resena=_resena("pending"))
    assert "review" not in _acciones("provider", ahora=cerrada_el, atendiendo=cerrada)
    # El prestador responde UNA vez, y solo a lo que ya se ve.
    assert "reply_review" in _acciones("provider", ahora=cerrada_el, atendiendo=cerrada, resena=_resena())
    for resena in (_resena("pending"), _resena("hidden"), _resena("published", "Gracias.")):
        assert "reply_review" not in _acciones("provider", ahora=cerrada_el, atendiendo=cerrada, resena=resena)
    assert "reply_review" not in _acciones("client", ahora=cerrada_el, atendiendo=cerrada, resena=_resena())


# --------------------------------------------------------------------------- #
# Los plazos y el dinero
# --------------------------------------------------------------------------- #
def test_los_plazos_salen_de_la_politica_y_de_lo_que_paso_de_verdad() -> None:
    p = atencion.plazos(_reserva(), None, None, POLITICA)
    assert p.llegada_desde == INICIO - timedelta(minutes=15)
    assert p.ausencia_desde == INICIO + timedelta(minutes=15)
    assert p.reprogramar_hasta == INICIO - timedelta(hours=24)
    assert p.caso_hasta == FIN + timedelta(hours=48)
    assert p.resena_hasta is None and p.apelar_hasta is None
    # Si terminó más tarde de lo previsto, el plazo del caso cuenta desde entonces; antes, desde su fin.
    tarde = FIN + timedelta(hours=2)
    assert atencion.plazos(_reserva(), _atencion("completed", completed_at=tarde), None, POLITICA).caso_hasta == (
        tarde + timedelta(hours=48))
    pronto = INICIO + timedelta(minutes=20)
    assert atencion.plazos(_reserva(), _atencion("completed", completed_at=pronto), None, POLITICA).caso_hasta == (
        FIN + timedelta(hours=48))
    cerrada = _atencion("closed", completed_at=FIN, closed_at=tarde)
    resuelto = _caso("resolved", resoluciones=1, resuelto=tarde)
    p = atencion.plazos(_reserva(), cerrada, resuelto, POLITICA)
    assert p.resena_hasta == tarde + timedelta(days=30) and p.apelar_hasta == tarde + timedelta(days=5)


def test_la_politica_se_lee_de_la_configuracion_con_sus_cotas(monkeypatch) -> None:
    from app.core.config import get_settings

    ajustes = get_settings()
    de_fabrica = limites.PoliticaDeAtencion.de()
    assert (de_fabrica.llegada_minutos, de_fabrica.tolerancia_minutos, de_fabrica.confirmacion_horas) == (15, 15, 24)
    assert (de_fabrica.reprogramaciones, de_fabrica.reprogramar_horas_antes, de_fabrica.caso_horas) == (1, 24, 48)
    assert (de_fabrica.apelacion_dias, de_fabrica.resena_dias, de_fabrica.resena_con_moderacion_previa) == (5, 30, True)
    monkeypatch.setattr(ajustes, "services_booking_reschedule_max", 3)
    monkeypatch.setattr(ajustes, "services_reviews_premoderation", False)
    cambiada = limites.PoliticaDeAtencion.de()
    assert cambiada.reprogramaciones == 3 and cambiada.resena_con_moderacion_previa is False
    # Un valor absurdo no rompe nada: se acota.
    monkeypatch.setattr(ajustes, "services_attention_tolerance_minutes", -5)
    monkeypatch.setattr(ajustes, "services_review_window_days", 10 ** 9)
    acotada = limites.PoliticaDeAtencion.de()
    assert acotada.tolerancia_minutos >= 0 and acotada.resena_dias < 10 ** 6


def test_un_efecto_economico_nunca_queda_ejecutado(monkeypatch) -> None:
    gratis = SimpleNamespace(payment_status="not_required", total_minor=0)
    con_dinero = SimpleNamespace(payment_status="paid", total_minor=15000)
    vistos = set()
    for disponible in (False, True):
        monkeypatch.setattr(limites, "cobro_disponible", lambda d=disponible: d)
        for pedido in (None, gratis, con_dinero):
            for efecto in ("none", "full_refund", "partial_refund"):
                vistos.add(atencion.estado_del_efecto(pedido, efecto))
    assert vistos == set(ESTADOS_DEL_EFECTO) == {"not_applicable", "pending", "blocked"}
    monkeypatch.setattr(limites, "cobro_disponible", lambda: True)
    assert atencion.estado_del_efecto(gratis, "full_refund") == "not_applicable"
    assert atencion.estado_del_efecto(con_dinero, "none") == "not_applicable"
    assert atencion.estado_del_efecto(con_dinero, "full_refund") == "pending"
    monkeypatch.setattr(limites, "cobro_disponible", lambda: False)
    assert atencion.estado_del_efecto(con_dinero, "partial_refund") == "blocked"


def test_los_motivos_de_cada_parte_y_de_la_moderacion_son_listas_cerradas() -> None:
    from app.modules.services import posventa
    from app.modules.services.atencion_models import MOTIVOS

    assert set(posventa.MOTIVOS_DE["client"]) | set(posventa.MOTIVOS_DE["provider"]) == set(MOTIVOS)
    assert "client_absent" not in posventa.MOTIVOS_DE["client"]
    assert "provider_absent" not in posventa.MOTIVOS_DE["provider"]
    assert "safety" in posventa.MOTIVOS_DE["client"] and "safety" in posventa.MOTIVOS_DE["provider"]
    # Una reseña no se esconde «por negativa»: ese motivo no existe.
    assert not [m for m in posventa.MOTIVOS_DE_MODERACION if "negativ" in m or "rating" in m]
    assert atencion.MOTIVOS_DE_CANCELACION == ("change_of_plans", "unavailable", "operational", "other")
