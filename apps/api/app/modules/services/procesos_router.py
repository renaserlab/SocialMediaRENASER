"""LOS PROCESOS AUTOMÁTICOS DE Z SERVICIOS — la entrada del planificador.

Los dos barridos ya existían (arquitectura §17 y §21): vencer las retenciones
(`reserva.vencer_retenciones`) y recordar/cerrar las atenciones
(`atencion.tareas`). Los dos son idempotentes, van por lotes y NO son la
autoridad de nada: el vencimiento lo decide la hora, no el barrido.

Lo que faltaba era QUIÉN LOS LLAMA. Sus rutas de administración
(`/admin/services/holds/expire` y `/admin/services/tasks/run`) piden la sesión
de una persona con rol de administración, y un planificador no es una persona:
la sesión de Supabase caduca en una hora y nadie puede guardarla en una regla.
Dentro de la API sigue sin haber temporizador (la aplicación corre en varias
máquinas y cada una lo lanzaría).

Esta es la ÚNICA entrada sin sesión de todo Servicios, y por eso es tan
estrecha:

  * NO RECIBE NADA: ni cuerpo, ni parámetros, ni identificadores. Solo puede
    hacer lo que hacen los dos barridos con sus valores de fábrica.
  * SE AUTENTICA con un secreto compartido (`SERVICES_TASKS_TOKEN`, que vive
    en el secreto de la API y no en un parámetro de la pila), comparado en
    tiempo constante y EN BYTES —igual que el aviso de 100ms
    (`live/webhooks.py`)—.
  * FALLA CERRADA: sin secreto configurado, o con uno corto, no acepta
    ninguna cabecera, tampoco la vacía.
  * A QUIEN NO RECONOCE LE CONTESTA COMO SI SERVICIOS ESTUVIERA APAGADO, pase
    lo que pase: el mismo 503 `services_disabled`, haya o no un piloto en
    marcha, haya o no un secreto configurado y traiga o no una cabecera. Es
    la regla del piloto (P101, `acceso.py`): nadie averigua desde fuera qué
    está encendido. Con las banderas delante del secreto, una petición
    anónima recibía cuatro respuestas distintas según el estado del servidor.
  * LAS BANDERAS, DESPUÉS Y SOLO PARA EL PLANIFICADOR: reconocido, con la
    contratación apagada recibe el 503 que le toca y no corre nada.
  * NO MUEVE DINERO y no escribe nada que los barridos no escribieran ya.
  * Y AL TERMINAR DEJA PROGRAMADA UNA PASADA POR LA COLA DE AVISOS
    (`notifications/despacho.py`), sin esperarla: EventBridge corta la llamada
    a los cinco segundos y hablar con Expo puede tardar más. Es lo que recoge
    los reintentos; el aviso recién creado ya salió al guardarse.
"""

from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.notifications import despacho
from app.modules.services import atencion, esquema, reserva
from app.shared.database import get_db

logger = logging.getLogger("renaser.services")

CABECERA = "X-Services-Tasks-Token"

#: Un secreto más corto que esto no es un secreto: se trata como si no hubiera.
LARGO_MINIMO_DEL_SECRETO = 32


class ProcesosRead(BaseModel):
    expired: int
    reminded: int
    closed: int
    #: Terminadas sin la señal fuerte y con el plazo vencido: NO se cierran solas.
    unverified: int
    skipped: int


def exigir_planificador(recibido: str | None = Header(default=None, alias=CABECERA)) -> None:
    """El secreto y, solo después, las banderas. Sin tocar la base."""
    esperado = (get_settings().services_tasks_token or "").strip()
    configurado = len(esperado) >= LARGO_MINIMO_DEL_SECRETO
    # EN BYTES: `compare_digest` con texto lanza `TypeError` ante un carácter no
    # ASCII, y eso sería un 500 que cualquiera podría provocar. Se compara
    # SIEMPRE, también sin secreto configurado: lo que se tarda no dice nada.
    candidato = (recibido or "").strip().encode("utf-8")
    coincide = hmac.compare_digest(candidato, esperado.encode("utf-8"))
    if not (configurado and candidato and coincide):
        # Lo mismo que a cualquiera con Servicios apagado. El motivo de verdad
        # va al registro, que solo lee quien opera: sin él, un planificador mal
        # configurado sería indistinguible de uno bien configurado y apagado.
        if candidato:
            logger.warning(
                "servicios.procesos: llamada rechazada (%s)",
                "sin secreto configurado en la API" if not configurado else "la cabecera no es el secreto",
            )
        raise esquema.ServiciosApagados()
    if not esquema.encendido():
        raise esquema.ServiciosApagados()
    if not esquema.reserva_encendida():
        raise esquema.ReservaApagada()


async def _preparado(db: AsyncSession = Depends(get_db)) -> None:
    """Las migraciones de la reserva y de la atención, o 503. Ya autenticado."""
    await esquema.exigir_atencion(db)


router = APIRouter(
    prefix="/internal/services",
    tags=["services-internal"],
    # Antes que nada, y antes de abrir la base: la puerta.
    dependencies=[Depends(exigir_planificador)],
    # No es parte del contrato de la aplicación: no se anuncia en el esquema.
    include_in_schema=False,
)


@router.post("/tasks/run", response_model=ProcesosRead)
async def correr(
    _preparado: None = Depends(_preparado),
    db: AsyncSession = Depends(get_db),
) -> ProcesosRead:
    """Los dos barridos, uno detrás del otro y CADA UNO EN SU TRANSACCIÓN: si
    el segundo falla, lo que venció el primero queda vencido, y la siguiente
    pasada repite sin hacer nada dos veces. NO MUEVE DINERO."""
    vencidas = await reserva.vencer_retenciones(db)
    await db.commit()
    hecho = await atencion.tareas(db)
    await db.commit()
    # Solo cuentas: ni identificadores ni, por supuesto, el secreto.
    logger.info(
        "servicios.procesos expired=%s reminded=%s closed=%s unverified=%s skipped=%s",
        vencidas, hecho.recordadas, hecho.cerradas, hecho.sin_verificar, hecho.saltadas,
    )
    # Los avisos que toca reintentar, y los que hayan quedado sin salir. No se
    # espera: se programa y se contesta.
    despacho.despachar()
    return ProcesosRead(
        expired=vencidas,
        reminded=hecho.recordadas,
        closed=hecho.cerradas,
        unverified=hecho.sin_verificar,
        skipped=hecho.saltadas,
    )


__all__ = ["CABECERA", "LARGO_MINIMO_DEL_SECRETO", "ProcesosRead", "exigir_planificador", "router"]
