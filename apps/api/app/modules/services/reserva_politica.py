"""LOS LÍMITES DE LA RESERVA DE SERVICIOS (Incremento 5), EN UN SOLO SITIO.

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

Y UNA PREGUNTA: ¿se puede cobrar un servicio? Hoy NO, y la respuesta vive
solo aquí (`cobro_disponible`).
"""

from __future__ import annotations

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
    "cobro_disponible",
]
