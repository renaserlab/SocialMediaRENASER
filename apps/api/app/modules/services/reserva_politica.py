"""LOS LÍMITES DE LA RESERVA Y DE LA ATENCIÓN DE SERVICIOS (Incrementos 5 y
6), EN UN SOLO SITIO.

Dos clases de número, y no se mezclan:

  * LOS PROVISIONALES DE LA EMPRESA, configurables por entorno y acotados
    aquí: cuánto dura una retención (`services_booking_hold_minutes`, 10 del
    documento de reglas §6.1), cuántas activas puede tener una persona
    (`services_booking_max_active_holds`, 3, §6.5) y qué modalidades se
    confirman solas (`services_booking_instant_modalities`). No se deciden
    aquí: se leen de la configuración.
  * LOS TÉCNICOS: los largos de lo que escribe quien contrata, las páginas,
    el lote del barrido y cuánto se espera un cerrojo. Los mismos que impone
    la 0093 donde la base los conoce.

DE LOS PROVISIONALES, LOS QUE DECIDEN QUÉ SE PUEDE HACER CON UNA RESERVA YA
CONFIRMADA SE CONGELAN CON ELLA (0095, G18): `PoliticaDeAtencion`. Lo que
vale antes de que haya reserva (la retención, qué se confirma solo), lo que es
un aviso (el recordatorio) y lo que es de la moderación de Z (la moderación
previa de una reseña) se sigue leyendo de la configuración al actuar.

Y UNA PREGUNTA: ¿se puede cobrar un servicio? Hoy NO, y la respuesta vive
solo aquí (`cobro_disponible`).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from app.core.config import Settings, get_settings
from app.modules.services.catalogo_models import MODALIDADES

# --------------------------------------------------------------------------- #
# Técnicos
# --------------------------------------------------------------------------- #
#: Lo que escribe quien contrata (los mismos que la 0093).
NOTA_MAXIMA = 500
DISTRITO_MAXIMO = 100
DIRECCION_MAXIMA = 200
REFERENCIA_MAXIMA = 200
#: Las listas de reservas y de retenciones.
RESERVAS_POR_PAGINA = 20
RESERVAS_MAXIMAS_POR_PAGINA = 50
#: El barrido de retenciones vencidas: cuántas en una llamada.
LOTE_DEL_BARRIDO = 200
LOTE_MAXIMO_DEL_BARRIDO = 1000
#: Cuánto espera una petición a que otra suelte el servicio antes de un 409.
ESPERA_DEL_CERROJO_MS = 5000
#: El código de una reserva: 8 caracteres sin los que se confunden (0/O, 1/I).
ALFABETO_DEL_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

#: Cotas de los provisionales: un entorno mal configurado no aparta un horario
#: durante horas ni deja a nadie sin poder retener.
_RETENCION_MINUTOS = (1, 60)
_RETENCIONES_ACTIVAS = (1, 20)


@dataclass(frozen=True)
class Politica:
    """Lo configurable, ya leído y acotado."""

    retencion_minutos: int
    retenciones_activas: int
    modalidades_inmediatas: frozenset[str]

    @classmethod
    def de(cls, ajustes: Settings | None = None) -> "Politica":
        a = ajustes or get_settings()
        inmediatas = frozenset(
            m.strip() for m in str(a.services_booking_instant_modalities or "").split(",") if m.strip()
        ) & frozenset(MODALIDADES)
        return cls(
            retencion_minutos=min(max(int(a.services_booking_hold_minutes), _RETENCION_MINUTOS[0]),
                                  _RETENCION_MINUTOS[1]),
            retenciones_activas=min(max(int(a.services_booking_max_active_holds), _RETENCIONES_ACTIVAS[0]),
                                    _RETENCIONES_ACTIVAS[1]),
            modalidades_inmediatas=inmediatas,
        )


# --------------------------------------------------------------------------- #
# La atención y la posventa (Incremento 6)
# --------------------------------------------------------------------------- #
#: TÉCNICOS (los mismos que impone la 0094 donde la base los conoce).
CODIGO_DE_ASISTENCIA_CIFRAS = 6
INTENTOS_DEL_CODIGO = 5
DESCRIPCION_DEL_CASO = (20, 2000)
ENTRADA_MAXIMA = 2000
MOTIVO_MAXIMO = 500
#: Por PARTE, no por caso: que una llene su cupo no deja a la otra sin el suyo.
EVIDENCIAS_POR_PARTE = 10
COMENTARIO_DE_RESENA = (20, 2000)
RESPUESTA_MAXIMA = 1000
#: Los barridos de la atención: cuántas filas en una llamada.
LOTE_DE_TAREAS = 200
LOTE_MAXIMO_DE_TAREAS = 1000

#: Cotas de los PROVISIONALES de la atención (política operativa v1 del
#: alcance; ninguno es una decisión tomada aquí). Un entorno mal configurado
#: no deja una atención sin poder empezar ni un caso sin plazo.
_COTAS_DE_LA_ATENCION = {
    "services_attention_checkin_minutes": (0, 240),
    "services_attention_tolerance_minutes": (0, 240),
    "services_attention_confirmation_hours": (1, 720),
    "services_booking_reschedule_max": (0, 10),
    "services_booking_reschedule_min_hours": (0, 720),
    "services_booking_reminder_hours": (1, 168),
    "services_incident_window_hours": (1, 720),
    "services_incident_appeal_days": (1, 60),
    # Dos resoluciones como mucho por caso (0094): una apelación, o ninguna.
    "services_incident_appeals_max": (0, 1),
    "services_review_window_days": (1, 365),
}


def _acotado(ajustes: Settings, nombre: str) -> int:
    minimo, maximo = _COTAS_DE_LA_ATENCION[nombre]
    return min(max(int(getattr(ajustes, nombre)), minimo), maximo)


# --------------------------------------------------------------------------- #
# LA POLÍTICA OPERATIVA DE UNA RESERVA (0095, G18): se congela al confirmarla
# --------------------------------------------------------------------------- #
#: La estructura de la fotografía. Otra estructura es otra versión, con su
#: migración: la base solo admite las que conoce.
VERSION_DE_LA_FOTOGRAFIA = 1

#: LO QUE SE CONGELA, y nada más: lo que decide qué se puede hacer con una
#: reserva YA confirmada y hasta cuándo. El ajuste del que sale al confirmar →
#: el atributo. En la fotografía, la clave es el ajuste sin `services_`.
_CONGELADO = {
    "services_attention_checkin_minutes": "llegada_minutos",
    "services_attention_confirmation_hours": "confirmacion_horas",
    "services_attention_tolerance_minutes": "tolerancia_minutos",
    "services_booking_reschedule_max": "reprogramaciones",
    "services_booking_reschedule_min_hours": "reprogramar_horas_antes",
    "services_incident_appeal_days": "apelacion_dias",
    "services_incident_appeals_max": "apelaciones",
    "services_incident_window_hours": "caso_horas",
    "services_review_window_days": "resena_dias",
}
#: La clave de la fotografía → (atributo, cotas). Las mismas que impone la 0095.
CAMPOS_CONGELADOS: dict[str, tuple[str, tuple[int, int]]] = {
    ajuste.removeprefix("services_"): (atributo, _COTAS_DE_LA_ATENCION[ajuste])
    for ajuste, atributo in _CONGELADO.items()
}
#: La clave del plazo de confirmación: el barrido la busca en la base.
CLAVE_DE_LA_CONFIRMACION = "attention_confirmation_hours"


class FotografiaInvalida(Exception):
    """La política guardada con una reserva no es de fiar: otra estructura,
    una clave o un valor que no toca, o una huella que no es la suya. NO SE
    SUSTITUYE por la de ahora: con esa reserva no se hace nada."""


def huella_de_la_fotografia(version: int, valores: dict[str, int]) -> str:
    """La huella de una fotografía: SHA-256 de su forma canónica (claves en
    orden, sin espacios). La 0095 calcula la misma y no guarda otra."""
    canonica = json.dumps({"schema_version": version, "values": valores}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonica.encode()).hexdigest()


@dataclass(frozen=True)
class PoliticaDeAtencion:
    """LA POLÍTICA OPERATIVA DE UNA RESERVA: los plazos y los topes con los
    que se decide qué se puede hacer con ella. TODOS PROVISIONALES.

    SE CONGELA AL CONFIRMAR. `vigente()` es la de AHORA: la lee quien confirma
    una reserva, para guardarla con ella. Todo lo que pasa después lee
    `de_la_reserva()`: cambiar la configuración no cambia una reserva hecha."""

    #: Cuántos minutos antes de la hora se abre la llegada (código, iniciar).
    llegada_minutos: int
    #: La tolerancia: pasada la hora, cuándo se puede reportar una ausencia.
    tolerancia_minutos: int
    #: Cuánto tiene quien contrata para confirmar que se realizó.
    confirmacion_horas: int
    #: Cuántas veces reprograma quien contrata, y con cuánta antelación.
    reprogramaciones: int
    reprogramar_horas_antes: int
    #: Cuánto hay para abrir un caso, y para apelar su resolución.
    caso_horas: int
    apelacion_dias: int
    apelaciones: int
    #: Cuánto hay para reseñar.
    resena_dias: int
    #: Falso en la vigente y en una reserva ANTERIOR A LA 0095, que no tiene
    #: fotografía: se rige por la de ahora, como cuando se confirmó.
    congelada: bool = False

    @classmethod
    def vigente(cls, ajustes: Settings | None = None) -> "PoliticaDeAtencion":
        """La de la configuración de AHORA, leída y acotada."""
        a = ajustes or get_settings()
        return cls(**{atributo: _acotado(a, ajuste) for ajuste, atributo in _CONGELADO.items()})

    def fotografia(self) -> dict[str, int]:
        """Lo que se guarda con la reserva: los valores, por su clave."""
        return {clave: getattr(self, atributo) for clave, (atributo, _) in CAMPOS_CONGELADOS.items()}

    @classmethod
    def de_la_reserva(cls, reserva) -> "PoliticaDeAtencion":  # noqa: ANN001 - una `ServiceBooking`
        """LA de ESA reserva: la que se congeló al confirmarla, comprobada
        (estructura, claves, valores y huella). Es la ÚNICA lectura de la
        fotografía. Una reserva anterior a la 0095 no la tiene, y NO SE LE
        INVENTA: se rige por la vigente y lo dice (`congelada` es falso)."""
        foto, version, huella = reserva.operating_policy, reserva.operating_policy_version, \
            reserva.operating_policy_sha256
        if foto is None and version is None and huella is None:
            return cls.vigente()
        if version != VERSION_DE_LA_FOTOGRAFIA or not isinstance(foto, dict) or set(foto) != set(CAMPOS_CONGELADOS):
            raise FotografiaInvalida()
        valores = {}
        for clave, (atributo, (minimo, maximo)) in CAMPOS_CONGELADOS.items():
            valor = foto[clave]
            if type(valor) is not int or not minimo <= valor <= maximo:
                raise FotografiaInvalida()
            valores[atributo] = valor
        if huella != huella_de_la_fotografia(version, foto):
            raise FotografiaInvalida()
        return cls(**valores, congelada=True)


# LO QUE NO SE CONGELA, y se lee de la configuración al actuar: no dice qué
# puede hacer nadie con una reserva hecha.
def recordatorio_horas(ajustes: Settings | None = None) -> int:
    """Con cuántas horas de antelación se recuerda una reserva. Es un aviso,
    no un plazo de nadie."""
    return _acotado(ajustes or get_settings(), "services_booking_reminder_hours")


def resenas_con_moderacion_previa(ajustes: Settings | None = None) -> bool:
    """Si una reseña NUEVA espera a moderación antes de verse. Es de la
    moderación de Z, no de la reserva: vale para toda reseña que se escribe."""
    return bool((ajustes or get_settings()).services_reviews_premoderation)


#: Los adaptadores de cobro de Servicios. NINGUNO: no existe ninguno.
ADAPTADORES_DE_COBRO: dict[str, object] = {}


def cobro_disponible(ajustes: Settings | None = None) -> bool:
    """¿Se puede cobrar un servicio? HOY NO, y por tres razones a la vez: las
    banderas están apagadas, la pasarela es `none` y no existe adaptador. Con
    las tres, tampoco: la 0093 solo admite pedidos gratuitos. Un servicio con
    precio contesta `service_booking_payments_not_configured` y NUNCA se da por
    cobrado."""
    a = ajustes or get_settings()
    return bool(
        a.feature_service_payments
        and a.service_payments_provider != "none"
        and a.service_payments_provider in ADAPTADORES_DE_COBRO
    )


__all__ = [
    "ADAPTADORES_DE_COBRO",
    "ALFABETO_DEL_CODIGO",
    "CAMPOS_CONGELADOS",
    "CLAVE_DE_LA_CONFIRMACION",
    "CODIGO_DE_ASISTENCIA_CIFRAS",
    "COMENTARIO_DE_RESENA",
    "DESCRIPCION_DEL_CASO",
    "ENTRADA_MAXIMA",
    "EVIDENCIAS_POR_PARTE",
    "FotografiaInvalida",
    "INTENTOS_DEL_CODIGO",
    "LOTE_DE_TAREAS",
    "LOTE_MAXIMO_DE_TAREAS",
    "MOTIVO_MAXIMO",
    "PoliticaDeAtencion",
    "RESPUESTA_MAXIMA",
    "DIRECCION_MAXIMA",
    "DISTRITO_MAXIMO",
    "ESPERA_DEL_CERROJO_MS",
    "LOTE_DEL_BARRIDO",
    "LOTE_MAXIMO_DEL_BARRIDO",
    "NOTA_MAXIMA",
    "Politica",
    "REFERENCIA_MAXIMA",
    "RESERVAS_MAXIMAS_POR_PAGINA",
    "RESERVAS_POR_PAGINA",
    "VERSION_DE_LA_FOTOGRAFIA",
    "cobro_disponible",
    "huella_de_la_fotografia",
    "recordatorio_horas",
    "resenas_con_moderacion_previa",
]
