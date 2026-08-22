"""Que puede hacer cada parte con una sesion, y que no.

Estas reglas son el producto, no un detalle de implementacion: quien recibe la
solicitud acepta o rechaza, quien la pidio no puede aceptarse a si mismo, y de
un estado final no se sale. Si se rompen, la agenda deja de significar nada — y
con ella, la resena verificable que dependera de que una sesion llegue a
`completed`.
"""

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.modules.bookings.models import Booking
from app.modules.bookings.router import _leer
from app.modules.bookings.schemas import (
    ESTADOS,
    BookingCreate,
    BookingUpdate,
    transicion_permitida,
)
from app.modules.profiles.models import Profile

PROVEEDOR = "provider"
SOLICITANTE = "requester"


# --------------------------------------------------------------------------- #
# Quien responde a una solicitud
# --------------------------------------------------------------------------- #
def test_quien_recibe_la_solicitud_puede_aceptarla():
    assert transicion_permitida("pending", "accepted", PROVEEDOR)


def test_quien_recibe_la_solicitud_puede_rechazarla():
    assert transicion_permitida("pending", "rejected", PROVEEDOR)


def test_quien_pidio_la_sesion_no_puede_aceptarsela_a_si_mismo():
    """El caso que convertiria la agenda en un buzon de sesiones inventadas."""
    assert not transicion_permitida("pending", "accepted", SOLICITANTE)


def test_quien_pidio_la_sesion_puede_cancelarla():
    assert transicion_permitida("pending", "cancelled", SOLICITANTE)


def test_quien_recibe_no_puede_cancelar_lo_que_todavia_no_ha_respondido():
    """Para eso esta rechazar; cancelar es para lo ya acordado."""
    assert not transicion_permitida("pending", "cancelled", PROVEEDOR)


# --------------------------------------------------------------------------- #
# Reprogramar
# --------------------------------------------------------------------------- #
def test_las_dos_partes_pueden_proponer_otra_fecha():
    assert transicion_permitida("pending", "reschedule_requested", PROVEEDOR)
    assert transicion_permitida("pending", "reschedule_requested", SOLICITANTE)


def test_sobre_una_reprogramacion_quien_la_recibe_puede_aceptarla():
    assert transicion_permitida("reschedule_requested", "accepted", SOLICITANTE)
    assert transicion_permitida("reschedule_requested", "accepted", PROVEEDOR)


# --------------------------------------------------------------------------- #
# Completar: la puerta de las resenas
# --------------------------------------------------------------------------- #
def test_una_sesion_aceptada_la_puede_dar_por_hecha_cualquiera_de_las_dos():
    """Si solo pudiera una, bastaria con que se despistara para que la otra no
    pudiera dejar resena nunca."""
    assert transicion_permitida("accepted", "completed", PROVEEDOR)
    assert transicion_permitida("accepted", "completed", SOLICITANTE)


def test_no_se_puede_completar_algo_que_nadie_acepto():
    assert not transicion_permitida("pending", "completed", PROVEEDOR)
    assert not transicion_permitida("pending", "completed", SOLICITANTE)


# --------------------------------------------------------------------------- #
# Estados finales
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("final", ["rejected", "cancelled", "completed", "expired"])
@pytest.mark.parametrize("rol", [PROVEEDOR, SOLICITANTE])
@pytest.mark.parametrize(
    "destino", ["accepted", "rejected", "cancelled", "completed", "reschedule_requested"]
)
def test_de_un_estado_final_no_se_sale(final, rol, destino):
    assert not transicion_permitida(final, destino, rol)


def test_un_estado_inventado_no_abre_ninguna_puerta():
    assert not transicion_permitida("lo_que_sea", "accepted", PROVEEDOR)


# --------------------------------------------------------------------------- #
# Contratos de entrada
# --------------------------------------------------------------------------- #
def test_los_estados_declarados_son_los_que_admite_la_base_de_datos():
    """La lista y el CHECK de la migracion 0025 tienen que decir lo mismo."""
    assert set(ESTADOS) == {
        "pending",
        "accepted",
        "rejected",
        "cancelled",
        "reschedule_requested",
        "completed",
        "expired",
    }


def test_una_solicitud_necesita_tema():
    with pytest.raises(ValidationError):
        BookingCreate(provider_id="11111111-1111-1111-1111-111111111111", topic="")


def test_no_se_puede_pedir_pasar_a_un_estado_que_no_existe():
    with pytest.raises(ValidationError):
        BookingUpdate(status="lo_que_sea")


def test_nadie_puede_marcar_una_sesion_como_caducada_a_mano():
    """`expired` lo decide el paso del tiempo, no una peticion."""
    with pytest.raises(ValidationError):
        BookingUpdate(status="expired")


# --------------------------------------------------------------------------- #
# Como llega cada sesion al movil
# --------------------------------------------------------------------------- #
#
# `my_role` es lo que decide que botones se pintan: a quien le PIDEN una sesion
# se le ofrece aceptar o rechazar, y a quien la pidio, cancelar. Si se calcula
# mal, las dos partes ven los botones de la otra.
def _perfil(uid: str, nombre: str) -> Profile:
    p = Profile()
    p.id = uid
    p.full_name = nombre
    p.username = nombre.lower()
    p.avatar_path = None
    p.bio = ""
    return p


def _reserva(estado: str = "pending") -> Booking:
    b = Booking()
    b.id = "22222222-2222-2222-2222-222222222222"
    b.requester_id = "ana"
    b.provider_id = "beto"
    b.topic = "Carpintería básica"
    b.note = ""
    b.status = estado
    b.scheduled_at = None
    b.timezone = None
    b.conversation_id = None
    b.completed_at = None
    b.created_at = datetime.now(timezone.utc)
    b.updated_at = b.created_at
    return b


def test_a_quien_le_piden_la_sesion_se_le_dice_que_es_el_proveedor():
    leido = _leer(_reserva(), _perfil("ana", "Ana"), _perfil("beto", "Beto"), "beto")
    assert leido.my_role == "provider"


def test_a_quien_la_pidio_se_le_dice_que_es_el_solicitante():
    leido = _leer(_reserva(), _perfil("ana", "Ana"), _perfil("beto", "Beto"), "ana")
    assert leido.my_role == "requester"


def test_las_dos_partes_viajan_resueltas_para_no_pedir_un_perfil_por_fila():
    leido = _leer(_reserva(), _perfil("ana", "Ana"), _perfil("beto", "Beto"), "ana")
    assert leido.requester.full_name == "Ana"
    assert leido.provider.full_name == "Beto"


def test_una_nota_vacia_no_llega_como_nula():
    """La pantalla la pinta directamente; un `None` saldria como «null»."""
    reserva = _reserva()
    reserva.note = None
    assert _leer(reserva, _perfil("ana", "Ana"), _perfil("beto", "B"), "ana").note == ""
