"""Las reglas de la atención de Servicios, SIN base (Incremento 6).

`acciones_disponibles` es la única lista de lo que una persona puede hacer con
una reserva; `plazos`, sus momentos; `estado_del_efecto`, lo único que decide
en qué queda un efecto económico solicitado. Aquí se recorren con objetos de
mentira: cada estado, cada papel y cada límite de tiempo.

Y LA POLÍTICA OPERATIVA DE UNA RESERVA (0095, G18): su fotografía tiene solo
lo contractual, su huella es canónica y reproducible, y el lector comprueba
estructura, claves, valores y huella. Una que no es de fiar NO se sustituye
por la vigente; una reserva anterior a la 0095 se rige por la vigente, y lo
dice.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.core.config import Settings, get_settings
from app.modules.services import atencion
from app.modules.services import reserva_politica as limites
from app.modules.services.atencion_models import ESTADOS_DE_ATENCION, ESTADOS_DE_CASO, ESTADOS_DEL_EFECTO

INICIO = datetime(2031, 3, 3, 15, 0, tzinfo=timezone.utc)
FIN = INICIO + timedelta(minutes=60)
CLIENTE, PERFIL = "c" * 8, "p" * 8
POLITICA = limites.PoliticaDeAtencion(
    llegada_minutos=15, tolerancia_minutos=15, confirmacion_horas=24, reprogramaciones=1,
    reprogramar_horas_antes=24, caso_horas=48, apelacion_dias=5, apelaciones=1, resena_dias=30,
)


def _reserva(estado: str = "confirmed"):
    return SimpleNamespace(id="b", status=estado, starts_at=INICIO, ends_at=FIN, version_id="v1", client_id=CLIENTE)


def _atencion(estado: str, **extra):
    base = {"status": estado, "completed_at": None, "closed_at": None, "started_with_code": False}
    return SimpleNamespace(**{**base, **extra})


def _caso(estado: str = "open", *, abierto_por: str = CLIENTE, resoluciones: int = 0, resuelto=None):
    return SimpleNamespace(status=estado, opened_by=abierto_por, resolutions=resoluciones, resolved_at=resuelto)


def _casos(acciones: set[str]) -> set[str]:
    return {a for a in acciones if "incident" in a}


def _resena(estado: str = "published", respuesta: str | None = None):
    return SimpleNamespace(status=estado, reply=respuesta)


def _acciones(rol: str, *, ahora: datetime, reserva=None, atendiendo=None, caso=None, resena=None,
              reprogramaciones: int = 0, version: str | None = "v1", activo: bool = True,
              politica=POLITICA, **extra) -> set[str]:
    return set(atencion.acciones_disponibles(
        rol=rol, usuario_id=CLIENTE if rol == "client" else PERFIL, reserva=reserva or _reserva(),
        atencion=atendiendo, caso=caso, resena=resena, ahora=ahora, politica=politica,
        reprogramaciones=reprogramaciones, version_vigente=version, prestador_activo=activo, **extra,
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
    # SIN OTRA PERSONA QUE PUEDA RESOLVERLA, o con las apelaciones a cero, no se ofrece.
    sin_apelaciones = replace(POLITICA, apelaciones=0)
    for rol in ("client", "provider"):
        assert "appeal_incident" not in _acciones(rol, ahora=resuelto_el, atendiendo=atendiendo, caso=resuelto,
                                                  hay_otro_decisor=False)
        assert "appeal_incident" not in _acciones(rol, ahora=resuelto_el, atendiendo=atendiendo, caso=resuelto,
                                                  politica=sin_apelaciones)
    # Apelado: se escribe, no se apela otra vez. Cerrado: nada del caso.
    apelado = _caso("appealed", resoluciones=1, resuelto=resuelto_el)
    assert _acciones("provider", ahora=resuelto_el, atendiendo=atendiendo, caso=apelado) == {"add_incident_entry"}
    cerrado = _caso("closed", resoluciones=2, resuelto=resuelto_el)
    for rol in ("client", "provider"):
        assert not [a for a in _acciones(rol, ahora=resuelto_el, atendiendo=atendiendo, caso=cerrado)
                    if "incident" in a], rol


def test_un_caso_retirado_no_le_quita_el_suyo_a_la_otra_parte() -> None:
    ahora = INICIO + timedelta(hours=2)
    atendiendo = _atencion("completed", completed_at=FIN)
    retirado = _caso("withdrawn", abierto_por=PERFIL)
    # La otra parte abre el suyo; quien retiró el suyo, no (ni escribe, ni lo retira otra vez).
    assert _casos(_acciones("client", ahora=ahora, atendiendo=atendiendo, caso=retirado)) == {"open_incident"}
    assert _casos(_acciones("provider", ahora=ahora, atendiendo=atendiendo, caso=retirado,
                            retiro_el_suyo=True)) == set()
    # Con el de la otra parte ya abierto, quien retiró el suyo escribe en ese como cualquiera.
    vivo = _caso("open", abierto_por=CLIENTE)
    assert _casos(_acciones("provider", ahora=ahora, atendiendo=atendiendo, caso=vivo,
                            retiro_el_suyo=True)) == {"add_incident_entry"}
    # Un caso retirado no frena la confirmación (no está vivo).
    assert "confirm" in _acciones("client", ahora=ahora, atendiendo=atendiendo, caso=retirado)


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
    de_fabrica = limites.PoliticaDeAtencion.vigente()
    assert (de_fabrica.llegada_minutos, de_fabrica.tolerancia_minutos, de_fabrica.confirmacion_horas) == (15, 15, 24)
    assert (de_fabrica.reprogramaciones, de_fabrica.reprogramar_horas_antes, de_fabrica.caso_horas) == (1, 24, 48)
    assert (de_fabrica.apelacion_dias, de_fabrica.apelaciones, de_fabrica.resena_dias) == (5, 1, 30)
    # Lo que NO es de la reserva (un aviso y la moderación) se lee aparte.
    assert (limites.recordatorio_horas(), limites.resenas_con_moderacion_previa()) == (24, True)
    monkeypatch.setattr(ajustes, "services_booking_reschedule_max", 3)
    monkeypatch.setattr(ajustes, "services_reviews_premoderation", False)
    assert limites.PoliticaDeAtencion.vigente().reprogramaciones == 3
    assert limites.resenas_con_moderacion_previa() is False
    # Un valor absurdo no rompe nada: se acota.
    monkeypatch.setattr(ajustes, "services_attention_tolerance_minutes", -5)
    monkeypatch.setattr(ajustes, "services_review_window_days", 10 ** 9)
    monkeypatch.setattr(ajustes, "services_booking_reminder_hours", 10 ** 9)
    acotada = limites.PoliticaDeAtencion.vigente()
    assert acotada.tolerancia_minutos >= 0 and acotada.resena_dias < 10 ** 6 and limites.recordatorio_horas() <= 168


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


# =========================================================================== #
# La política operativa de UNA reserva: su fotografía y su lector (0095, G18)
# =========================================================================== #
VERSION = limites.VERSION_DE_LA_FOTOGRAFIA
#: LA POLÍTICA A: la de fábrica (la «política operativa v1» del alcance, provisional).
A = {ajuste: Settings.model_fields[ajuste].default for ajuste in limites._CONGELADO}
#: LA POLÍTICA B: todo distinto.
B = {
    "services_attention_checkin_minutes": 120,
    "services_attention_confirmation_hours": 1,
    "services_attention_tolerance_minutes": 60,
    "services_booking_reschedule_max": 3,
    "services_booking_reschedule_min_hours": 2,
    "services_incident_appeal_days": 1,
    "services_incident_appeals_max": 0,
    "services_incident_window_hours": 1,
    "services_review_window_days": 1,
}


def _foto(politica: dict) -> dict:
    return {ajuste.removeprefix("services_"): valor for ajuste, valor in politica.items()}


FOTO_A, FOTO_B = _foto(A), _foto(B)
HUELLA_A = limites.huella_de_la_fotografia(VERSION, FOTO_A)
HUELLA_B = limites.huella_de_la_fotografia(VERSION, FOTO_B)


def _poner(monkeypatch, politica: dict, **mas) -> None:
    """Cambia la configuración GLOBAL, como haría la empresa."""
    for ajuste, valor in {**politica, **mas}.items():
        monkeypatch.setattr(get_settings(), ajuste, valor)


def _fila(foto=FOTO_A, version=VERSION, huella=None, **extra):
    """Lo que el lector mira de una `ServiceBooking`."""
    if huella is None and isinstance(foto, dict) and version is not None:
        huella = limites.huella_de_la_fotografia(version, foto)
    return SimpleNamespace(id="reserva", operating_policy=foto, operating_policy_version=version,
                           operating_policy_sha256=huella, **extra)


def test_la_fotografia_tiene_lo_contractual_y_nada_mas() -> None:
    assert sorted(limites.CAMPOS_CONGELADOS) == sorted(FOTO_A) == [
        "attention_checkin_minutes", "attention_confirmation_hours", "attention_tolerance_minutes",
        "booking_reschedule_max", "booking_reschedule_min_hours", "incident_appeal_days", "incident_appeals_max",
        "incident_window_hours", "review_window_days",
    ]
    assert FOTO_A == {
        "attention_checkin_minutes": 15, "attention_confirmation_hours": 24, "attention_tolerance_minutes": 15,
        "booking_reschedule_max": 1, "booking_reschedule_min_hours": 24, "incident_appeal_days": 5,
        "incident_appeals_max": 1, "incident_window_hours": 48, "review_window_days": 30,
    }
    assert limites.PoliticaDeAtencion.vigente().fotografia() == FOTO_A
    # Solo enteros: ni textos, ni la configuración del sistema.
    assert all(type(v) is int for v in FOTO_A.values())
    # LO QUE NO ES DE LA RESERVA no está: ni el aviso previo, ni la moderación,
    # ni lo de antes de reservar, ni nada técnico.
    for ajeno in ("reminder", "premoderation", "hold", "instant", "notice", "horizon", "batch", "lock"):
        assert not any(ajeno in clave for clave in limites.CAMPOS_CONGELADOS), ajeno
    assert not hasattr(limites.PoliticaDeAtencion.vigente(), "recordatorio_horas")
    assert not hasattr(limites.PoliticaDeAtencion.vigente(), "resena_con_moderacion_previa")


def test_la_huella_es_canonica_y_reproducible() -> None:
    # Fija: quien cambie la forma canónica (o una clave) se entera aquí, porque
    # dejaría de coincidir con la de las reservas ya guardadas.
    assert HUELLA_A == "dc91b8babbc87259fc13f037255fbca83a7f0e8f3e4944e731378f50294c5e8a"
    # No depende del orden en que vengan las claves.
    assert limites.huella_de_la_fotografia(VERSION, dict(reversed(list(FOTO_A.items())))) == HUELLA_A
    assert limites.huella_de_la_fotografia(VERSION, json.loads(json.dumps(FOTO_A))) == HUELLA_A
    # Y cambia con cualquier valor, y con la versión de la estructura.
    vistas = {HUELLA_A, HUELLA_B, limites.huella_de_la_fotografia(VERSION + 1, FOTO_A)}
    for clave in FOTO_A:
        vistas.add(limites.huella_de_la_fotografia(VERSION, {**FOTO_A, clave: FOTO_A[clave] + 1}))
    assert len(vistas) == 3 + len(FOTO_A)


def test_el_lector_devuelve_la_de_la_reserva_y_no_mira_la_configuracion(monkeypatch) -> None:
    _poner(monkeypatch, B)
    leida = limites.PoliticaDeAtencion.de_la_reserva(_fila(FOTO_A))
    assert leida.congelada is True and leida.fotografia() == FOTO_A
    assert (leida.reprogramar_horas_antes, leida.reprogramaciones, leida.tolerancia_minutos) == (24, 1, 15)
    assert (leida.llegada_minutos, leida.confirmacion_horas, leida.caso_horas) == (15, 24, 48)
    assert (leida.apelacion_dias, leida.apelaciones, leida.resena_dias) == (5, 1, 30)
    assert limites.PoliticaDeAtencion.vigente().fotografia() == FOTO_B
    assert atencion.politica_de(_fila(FOTO_A)) == leida


@pytest.mark.parametrize("fila", [
    _fila({**FOTO_A, "attention_tolerance_minutes": 16}, huella=HUELLA_A),   # un valor tocado
    _fila(FOTO_B, huella=HUELLA_A),                                         # sustituida por otra
    _fila(FOTO_A, huella="a" * 64),                                         # otra huella
    _fila(FOTO_A, huella=HUELLA_A.upper()),
    _fila({c: v for c, v in FOTO_A.items() if c != "review_window_days"}),  # falta una clave
    _fila({**FOTO_A, "cancellation_fee_percent": 50}),                      # sobra una
    _fila({**FOTO_A, "attention_tolerance_minutes": "15"}),                 # un texto
    _fila({**FOTO_A, "attention_tolerance_minutes": 15.0}),                 # no entero
    _fila({**FOTO_A, "attention_tolerance_minutes": True}),
    _fila({**FOTO_A, "attention_tolerance_minutes": None}),
    _fila({**FOTO_A, "attention_tolerance_minutes": -1}),                   # fuera de su cota
    _fila({**FOTO_A, "incident_appeals_max": 2}),
    _fila(FOTO_A, version=2),                                               # una estructura que no conoce
    _fila(FOTO_A, version=0),
    _fila([FOTO_A], huella=HUELLA_A),
    _fila("x", huella=HUELLA_A),
    # A medias: la fotografía sin su huella, o sin su versión, o la huella sola.
    SimpleNamespace(id="r", operating_policy=FOTO_A, operating_policy_version=VERSION, operating_policy_sha256=None),
    SimpleNamespace(id="r", operating_policy=FOTO_A, operating_policy_version=None, operating_policy_sha256=HUELLA_A),
    SimpleNamespace(id="r", operating_policy=None, operating_policy_version=None, operating_policy_sha256=HUELLA_A),
    SimpleNamespace(id="r", operating_policy=None, operating_policy_version=VERSION, operating_policy_sha256=None),
])
def test_una_fotografia_que_no_es_de_fiar_no_se_usa_ni_se_sustituye(fila, monkeypatch) -> None:
    """Con una fotografía tocada, incompleta o de otra estructura no se decide
    nada: ni con ella ni con la vigente."""
    _poner(monkeypatch, B)
    with pytest.raises(limites.FotografiaInvalida):
        limites.PoliticaDeAtencion.de_la_reserva(fila)
    with pytest.raises(atencion.AccionNoDisponible) as error:
        atencion.politica_de(fila)
    assert error.value.code == "service_booking_action_not_available"
    assert error.value.details == {"reason": "operating_policy"}


def test_una_reserva_anterior_a_la_0095_se_rige_por_la_vigente_y_lo_dice(monkeypatch) -> None:
    anterior = _fila(None, None, None)
    leida = limites.PoliticaDeAtencion.de_la_reserva(anterior)
    assert leida.congelada is False and leida.fotografia() == FOTO_A
    _poner(monkeypatch, B)
    despues = limites.PoliticaDeAtencion.de_la_reserva(anterior)
    assert despues.congelada is False and despues.fotografia() == FOTO_B
