"""Ninguna palanca que mueva dinero puede estar sin documentar.

POR QUE ESTE FICHERO EXISTE. La entrega de Stripe tiene que poder hacerse sin
desarrollo nuevo: llega la cuenta, se ponen las credenciales, se registra el
webhook, se encienden las banderas. Eso solo es cierto si los NOMBRES EXACTOS
de esas variables estan escritos en algun sitio que no sea el codigo fuente.

Y no lo estaban. `.env.example` documentaba la clave secreta y el secreto del
webhook, pero no la bandera que ejecuta las devoluciones contra la pasarela, ni
la que habilita las cuentas conectadas, ni la que autoriza las transferencias,
ni la COMISION —que nace en -1, «sin configurar», y sin la cual no se escribe
ni un saldo—, ni la bandera que habilita vender un producto fisico, ni los
minutos que aparta un pedido. Quien fuera a encender Stripe tendria que leerse
`config.py` para descubrir que le faltan seis interruptores.

LO QUE SE VIGILA NO ES UNA LISTA DE NOMBRES. Es una REGLA: cualquier ajuste
cuyo nombre hable de dinero —pagos, pasarela, comision, cuenta de cobro,
transferencias, devoluciones, venta, reserva— tiene que aparecer en
`.env.example`. Asi, la bandera que alguien anada manana queda cubierta sin que
nadie se acuerde de volver aqui.

NO COMPRUEBA VALORES, Y ES DELIBERADO: `.env.example` no lleva secretos. Lo que
se comprueba es que el NOMBRE este y que lo que mueve dinero nazca apagado.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
CONFIG = RAIZ / "app" / "core" / "config.py"
EJEMPLO = RAIZ / ".env.example"

#: Cuando el nombre de un ajuste contiene uno de estos, mueve dinero o decide
#: si se puede mover. La lista es del DOMINIO, no del fichero: por eso cubre a
#: los que todavia no existen.
DEL_DINERO = (
    "payment",
    "stripe",
    "fee",
    "payout",
    "transfer",
    "refund",
    "product_sales",
    "reservation_minutes",
    "connect",
    #: Regalar un curso de pago es mover dinero, aunque sea hacia cero.
    "beta_free_access",
)

#: Ajustes que contienen una de esas palabras y NO son una palanca de dinero.
#: Cada uno con su motivo, porque una excepcion sin motivo es un agujero.
EXCEPCIONES = {
    #: Derivado de `environment`, no se configura: una variable mas es una
    #: variable mas que se puede olvidar, y olvidarla aqui significaria buscar
    #: los productos de pruebas en el servidor de verdad.
    "payments_environment",
}


def _ajustes_del_dinero() -> list[str]:
    """Los campos de `Settings` que hablan de dinero. Leidos, no recordados."""
    texto = CONFIG.read_text(encoding="utf-8")
    campos = re.findall(r"^    ([a-z][a-z0-9_]*): ", texto, re.M)
    return [
        c
        for c in campos
        if c not in EXCEPCIONES and any(p in c for p in DEL_DINERO)
    ]


def test_toda_palanca_de_dinero_esta_en_el_ejemplo_de_entorno() -> None:
    """El nombre EXACTO, tal y como hay que escribirlo en el despliegue."""
    ejemplo = EJEMPLO.read_text(encoding="utf-8")
    del_dinero = _ajustes_del_dinero()
    assert len(del_dinero) >= 10, (
        "se detectaron muy pocos ajustes de dinero: revisa DEL_DINERO, "
        f"encontrados {del_dinero}"
    )

    faltan = [c for c in del_dinero if f"\n{c.upper()}=" not in f"\n{ejemplo}"]
    assert not faltan, (
        "estas palancas mueven dinero y no estan en .env.example, asi que "
        "encender Stripe exigiria leerse config.py: " + ", ".join(sorted(faltan))
    )


def test_ninguna_palanca_de_dinero_nace_encendida_en_el_ejemplo() -> None:
    """Un `.env.example` que se copia tal cual no puede cobrar a nadie.

    Es el fichero del que sale el primer despliegue. Que una bandera financiera
    viniera en `true` convertiria un descuido en un cobro real.
    """
    ejemplo = EJEMPLO.read_text(encoding="utf-8")
    encendidas = []
    for campo in _ajustes_del_dinero():
        for linea in ejemplo.splitlines():
            if linea.startswith(f"{campo.upper()}="):
                valor = linea.split("=", 1)[1].strip().lower()
                if valor == "true":
                    encendidas.append(campo)
    assert not encendidas, (
        "vienen encendidas en el ejemplo: " + ", ".join(sorted(encendidas))
    )


def test_la_comision_viene_sin_configurar_y_no_en_cero() -> None:
    """`-1` significa «nadie lo ha decidido». Cero significa «Z no se queda nada».

    La diferencia cuesta dinero: con cero, olvidarse de ponerla haria que se
    transfiriera el bruto y ninguna prueba lo delataria, porque el resultado
    cuadra.
    """
    ejemplo = EJEMPLO.read_text(encoding="utf-8")
    linea = next(
        (l for l in ejemplo.splitlines() if l.startswith("PLATFORM_FEE_BPS=")), None
    )
    assert linea is not None, "PLATFORM_FEE_BPS no esta en .env.example"
    assert linea.split("=", 1)[1].strip() == "-1", (
        "PLATFORM_FEE_BPS tiene que venir en -1 (sin configurar), no en 0"
    )


@pytest.mark.parametrize(
    "evento",
    [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
        "charge.refunded",
        "refund.created",
        "refund.updated",
        "refund.failed",
        "charge.refund.updated",
        "charge.dispute.created",
        "charge.dispute.funds_withdrawn",
        "charge.dispute.closed",
    ],
)
def test_el_documento_de_puesta_en_marcha_nombra_cada_evento_escuchado(
    evento: str,
) -> None:
    """Lo que hay que marcar en el panel de Stripe, evento por evento.

    UN EVENTO QUE EL CODIGO ESCUCHA Y NADIE MARCA NO LLEGA NUNCA. Los tres de
    disputa son el caso caro: sin ellos, un contracargo no se registra, el saldo
    no se congela y se paga sobre dinero que el banco ya retiro.
    """
    doc = RAIZ.parents[1] / "docs" / "Z_STRIPE_PUESTA_EN_MARCHA.md"
    assert doc.exists(), "falta docs/Z_STRIPE_PUESTA_EN_MARCHA.md"
    assert evento in doc.read_text(encoding="utf-8"), (
        f"el codigo escucha `{evento}` y el documento de puesta en marcha no lo "
        "manda marcar en el panel"
    )


def test_los_eventos_del_documento_son_los_que_el_codigo_traduce() -> None:
    """Y al reves: el documento no manda marcar nada que aqui se ignore.

    Marcar de mas no rompe —se ignora sin fallar—, pero un documento que nombra
    eventos que el codigo no conoce deja de ser fiable para el que lo sigue.
    """
    from app.modules.payments.stripe_provider import EVENTOS

    doc = RAIZ.parents[1] / "docs" / "Z_STRIPE_PUESTA_EN_MARCHA.md"
    texto = doc.read_text(encoding="utf-8")
    nombrados = set(re.findall(r"`((?:checkout|charge|refund)\.[a-z_.]+)`", texto))
    sobran = sorted(n for n in nombrados if n not in EVENTOS)
    assert not sobran, (
        "el documento manda marcar eventos que el codigo no traduce: "
        + ", ".join(sobran)
    )
