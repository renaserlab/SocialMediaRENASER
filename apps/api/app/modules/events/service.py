"""La coordinación transaccional de Eventos.

Aquí se juntan las piezas puras —`states`, `admission`— con la base de datos y
la auditoría. El router no decide nada: recibe, autoriza y llama.

TODA DECISIÓN SENSIBLE DEJA RASTRO, y el rastro se confirma con la operación
que describe. `auditoria.anotar` solo hace `flush`, y `get_db` no confirma por
su cuenta: una nota sin `commit` detrás es una nota que no existe.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.core.security import AuthUser
from app.modules.catalog import eventos
from app.modules.catalog.models import Event, EventRegistration
from app.modules.events import admission, inventory, permissions, states
from app.modules.events.models import (
    EventAdmissionDecision,
    EventAdmissionReview,
    EventDocument,
    EventOperations,
    EventVersion,
)
from app.modules.gobernanza import auditoria
from app.modules.notifications import decisiones as avisos

#: Lo que la versión congela. Es lo que el organizador se compromete a entregar,
#: y por eso NO lleva ni la portada ni el enlace al grupo: cambiar una imagen no
#: cambia lo prometido, y obligar a una revisión por eso solo consigue que nadie
#: retoque nunca una foto mal recortada.
CAMPOS_DE_LA_VERSION = (
    "title",
    "promise",
    "category",
    "description",
    "starts_at",
    "ends_at",
    "timezone",
    "event_type",
    "location",
    "capacity",
)


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _destino(accion: str, actual: str) -> str:
    """La transición, con su fallo traducido a un 409 con la frase entera.

    `states` es puro y no sabe de HTTP; una `TransicionInvalida` suelta llegaría
    al cliente como un 500, que dice «se rompió algo» cuando lo que pasa es que
    la operación no cabe desde ese estado.
    """
    try:
        return states.destino(accion, actual)
    except states.TransicionInvalida as error:
        # CON CÓDIGO: sin él, cancelar un evento que ya no está publicado
        # llegaba como un 409 indistinguible de cualquier otro conflicto.
        raise ConflictError(
            str(error),
            code="event_transition_invalid",
            details={"action": accion, "from": actual},
        ) from error


@dataclass
class Expediente:
    """Un evento con todo lo que su ficha operativa necesita."""

    evento: Event
    operacion: EventOperations
    version: EventVersion | None = None
    evaluacion: EventAdmissionReview | None = None
    decision: EventAdmissionDecision | None = None
    documentos: list[EventDocument] | None = None
    inscritos: int = 0


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #


async def operacion_de(db: AsyncSession, evento_id: str) -> EventOperations | None:
    return await db.get(EventOperations, evento_id)


async def operaciones_de(
    db: AsyncSession, ids: list[str]
) -> dict[str, EventOperations]:
    """Las filas operativas de varios eventos, en UNA consulta.

    Una por evento sería N+1 en cada página del catálogo, que es la consulta más
    caliente de la aplicación.
    """
    if not ids:
        return {}
    filas = await db.scalars(
        select(EventOperations).where(EventOperations.event_id.in_(set(ids)))
    )
    return {fila.event_id: fila for fila in filas}


async def _exigir_evento(db: AsyncSession, evento_id: str) -> Event:
    evento = await db.get(Event, evento_id)
    if evento is None:
        raise NotFoundError("Evento no encontrado.")
    return evento


async def _exigir_operacion(db: AsyncSession, evento_id: str) -> EventOperations:
    operacion = await operacion_de(db, evento_id)
    if operacion is None:
        raise NotFoundError("Evento no encontrado.")
    return operacion


async def _tomar_el_turno(db: AsyncSession, evento_id: str) -> EventOperations:
    """La fila operativa, con el evento BLOQUEADO. Para todo lo que decide.

    ES EL MISMO FALLO QUE EL DEL AFORO, un nivel más arriba. Sin el cerrojo,
    dos decisiones simultáneas leen el mismo `workflow_status` y las dos validan
    contra un valor ya caducado: un `reject` y un `approve` a la vez sobre un
    evento en SUBMITTED dejaban `SUBMITTED -> DRAFT -> APPROVED`, una transición
    que la máquina de estados no permite, con el sello puesto y dos decisiones
    contradictorias en el expediente.

    También convierte en espera lo que antes eran choques contra las claves
    únicas —dos `submit` calculando el mismo número de versión, dos
    evaluaciones de la misma versión— que llegaban al cliente como un 500.

    Se bloquea la fila de `events` y no la de `event_operations` porque es el
    MISMO cerrojo que toma el aforo: un solo punto de serialización y ningún
    orden que invertir.
    """
    await inventory.bloquear_evento(db, evento_id)
    return await _exigir_operacion(db, evento_id)


async def ultima_version(db: AsyncSession, evento_id: str) -> EventVersion | None:
    return await db.scalar(
        select(EventVersion)
        .where(EventVersion.event_id == evento_id)
        .order_by(EventVersion.version.desc())
        .limit(1)
    )


async def evaluacion_de(
    db: AsyncSession, evento_id: str, version: int
) -> EventAdmissionReview | None:
    return await db.scalar(
        select(EventAdmissionReview).where(
            EventAdmissionReview.event_id == evento_id,
            EventAdmissionReview.version == version,
        )
    )


async def ultima_decision(
    db: AsyncSession, evento_id: str
) -> EventAdmissionDecision | None:
    return await db.scalar(
        select(EventAdmissionDecision)
        .where(EventAdmissionDecision.event_id == evento_id)
        .order_by(EventAdmissionDecision.created_at.desc())
        .limit(1)
    )


async def documentos_de(db: AsyncSession, evento_id: str) -> list[EventDocument]:
    filas = await db.scalars(
        select(EventDocument)
        .where(EventDocument.event_id == evento_id)
        .order_by(EventDocument.kind)
    )
    return list(filas)


async def expediente(db: AsyncSession, evento_id: str) -> Expediente:
    evento = await _exigir_evento(db, evento_id)
    operacion = await _exigir_operacion(db, evento_id)
    version = await ultima_version(db, evento_id)
    return Expediente(
        evento=evento,
        operacion=operacion,
        version=version,
        evaluacion=(
            await evaluacion_de(db, evento_id, version.version) if version else None
        ),
        decision=await ultima_decision(db, evento_id),
        documentos=await documentos_de(db, evento_id),
        inscritos=await inventory.contar(db, evento_id),
    )


# --------------------------------------------------------------------------- #
# Borrador
# --------------------------------------------------------------------------- #


async def crear_borrador(
    db: AsyncSession, *, datos: dict[str, Any], usuario: AuthUser
) -> Expediente:
    """Un evento nuevo NACE BORRADOR. No hay autopublicación.

    `events.status` se queda en `draft`, que es lo que el catálogo público mira,
    y `event_operations.workflow_status` en `DRAFT`. Las dos cosas: la primera
    es la visibilidad que ya existía y la segunda el ciclo operativo nuevo.
    """
    operativos = {k: datos.pop(k, None) for k in ("promise", "category", "timezone")}
    evento = Event(organizer_id=usuario.id, status="draft", **datos)
    db.add(evento)
    await db.flush()

    operacion = EventOperations(
        event_id=evento.id,
        workflow_status=states.BORRADOR,
        selection_status="none",
        origin="events_v2",
        **operativos,
    )
    db.add(operacion)
    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.draft_created",
        entity_type="event",
        entity_id=evento.id,
        new_state=states.BORRADOR,
    )
    await db.commit()
    await db.refresh(evento)
    await db.refresh(operacion)
    return Expediente(evento=evento, operacion=operacion)


async def actualizar_borrador(
    db: AsyncSession, *, evento_id: str, datos: dict[str, Any], usuario: AuthUser
) -> Expediente:
    """Edita lo que todavía no está comprometido.

    SOLO EN BORRADOR O EN CONDICIONAL. Un evento enviado está siendo revisado y
    lo que se revisa es su versión congelada; dejar que se edite por debajo
    convierte la revisión en una foto de algo que ya no existe. Uno aprobado o
    publicado no se toca: cambiarlo exige una versión nueva, que es el
    Incremento 2.
    """
    evento = await _exigir_evento(db, evento_id)
    permissions.exigir_organizador(evento, usuario)
    operacion = await _tomar_el_turno(db, evento_id)

    if operacion.workflow_status not in (states.BORRADOR, states.CONDICIONAL):
        raise ConflictError(
            "Este evento ya no es un borrador: para cambiarlo hay que publicar "
            "una versión nueva."
        )

    tocados = list(datos)

    for campo in ("promise", "category", "timezone"):
        if campo in datos:
            setattr(operacion, campo, datos.pop(campo))
    for campo, valor in datos.items():
        setattr(evento, campo, valor)
    operacion.updated_at = ahora()

    # SE AUDITA QUÉ CAMPOS SE TOCARON, no sus valores: editar un condicional
    # cambia justo lo que curaduría acaba de mirar, y hasta ahora no dejaba
    # rastro. Los valores no se archivan —la versión ya los guarda— y meterlos
    # aquí convertiría `audit_events` en una copia del evento.
    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.draft_updated",
        entity_type="event",
        entity_id=evento_id,
        payload={
            "campos": sorted(tocados),
            "workflow_status": operacion.workflow_status,
        },
    )
    await db.commit()
    await db.refresh(evento)
    await db.refresh(operacion)
    return Expediente(evento=evento, operacion=operacion)


# --------------------------------------------------------------------------- #
# Versiones
# --------------------------------------------------------------------------- #


def _foto(evento: Event, operacion: EventOperations) -> dict[str, Any]:
    """Lo comprometido, en un diccionario que se puede guardar y comparar."""
    fuente: dict[str, Any] = {}
    for campo in CAMPOS_DE_LA_VERSION:
        valor = getattr(evento, campo, None)
        if valor is None:
            valor = getattr(operacion, campo, None)
        if isinstance(valor, datetime):
            valor = valor.isoformat()
        fuente[campo] = valor
    return fuente


def campos_cambiados(anterior: dict[str, Any] | None, nueva: dict[str, Any]) -> list[str]:
    if not anterior:
        return []
    return sorted(k for k in nueva if anterior.get(k) != nueva.get(k))


#: Descripción mínima con revisión y en modo flexible. En flexible basta con
#: una frase: nadie tiene que evaluarla, y 40 caracteres obligatorios era de
#: lo primero que hacía parecer estricta la app a quien la probaba.
MINIMO_DE_DESCRIPCION = 40
MINIMO_DE_DESCRIPCION_FLEXIBLE = 10


def motivo_para_no_enviar(
    evento: Event, operacion: EventOperations, *, flexible: bool = False
) -> str | None:
    """Lo mínimo para que otra persona pueda revisarlo (o para publicarlo, en
    modo flexible: ver `Settings.publicacion_flexible`).

    NO se comprueba nada que no se pueda guardar. Pedir un programa detallado
    cuando no hay columna donde escribirlo sería un requisito imposible.
    """
    if not (evento.title or "").strip():
        return "Falta el título."
    minimo = MINIMO_DE_DESCRIPCION_FLEXIBLE if flexible else MINIMO_DE_DESCRIPCION
    if len((evento.description or "").strip()) < minimo:
        if flexible:
            return f"Escribe una descripción de al menos {minimo} caracteres."
        return "La descripción es demasiado corta para poder revisarla."
    # La promesa ayuda a quien EVALÚA; sin evaluación, es opcional.
    if not flexible and not (operacion.promise or "").strip():
        return "Falta la promesa: qué vivirá quien vaya."
    if not (operacion.category or "").strip():
        return "Falta la categoría."
    if evento.starts_at is None:
        return "Falta la fecha de inicio."
    if evento.event_type == "presential" and not (evento.location or "").strip():
        return "Un evento presencial necesita el recinto."
    if not (operacion.timezone or "").strip():
        return "Falta la zona horaria del evento."
    if evento.ends_at is not None:
        # EL FIN NO PUEDE IR ANTES QUE EL INICIO. No es una regla de estilo: la
        # ficha pinta un rango con las dos fechas, y al revés queda un evento
        # que termina antes de empezar. Se compara con las dos en la misma
        # forma porque SQLite las devuelve sin zona y PostgreSQL con ella.
        inicio = evento.starts_at
        fin = evento.ends_at
        if inicio.tzinfo is None and fin.tzinfo is not None:
            fin = fin.replace(tzinfo=None)
        elif inicio.tzinfo is not None and fin.tzinfo is None:
            fin = fin.replace(tzinfo=timezone.utc)
        if fin < inicio:
            return "El fin no puede ser anterior al inicio."
    return None


#: Desde donde se publica al enviar en modo flexible. Incluye lo que se envió
#: ANTES de encender el modo (SUBMITTED, APPROVED): pulsar «Publicar» otra vez
#: tiene que publicarlo, no contestar que ya está en revisión.
_PUBLICABLES_AL_ENVIAR = frozenset(
    {states.BORRADOR, states.CONDICIONAL, states.ENVIADO, states.APROBADO}
)


async def enviar_a_revision(
    db: AsyncSession,
    *,
    evento_id: str,
    usuario: AuthUser,
    motivo: str = "",
    flexible: bool = False,
) -> Expediente:
    """Congela una versión y la manda a curaduría.

    ENVIAR NO PUBLICA NADA, salvo en modo flexible (`publicacion_flexible`):
    entonces la versión nace publicada y el evento sale al catálogo en la misma
    transacción (ver `_publicar_al_enviar`).
    """
    evento = await _exigir_evento(db, evento_id)
    permissions.exigir_organizador(evento, usuario)
    operacion = await _tomar_el_turno(db, evento_id)

    estado_de_partida = operacion.workflow_status
    if flexible and estado_de_partida in _PUBLICABLES_AL_ENVIAR:
        return await _publicar_al_enviar(
            db, evento=evento, operacion=operacion, usuario=usuario, motivo=motivo
        )
    destino = _destino("submit", estado_de_partida)
    fallo = motivo_para_no_enviar(evento, operacion)
    if fallo is not None:
        raise ValidationAppError(fallo)

    anterior = await ultima_version(db, evento_id)
    if anterior is not None and anterior.status != "superseded":
        # Solo una versión vigente por evento: la anterior queda superada. El
        # indice parcial de la 0060 lo exige, y aqui se cumple a proposito y no
        # por accidente.
        anterior.status = "superseded"

    foto = _foto(evento, operacion)
    numero = (anterior.version + 1) if anterior is not None else 1
    version = EventVersion(
        event_id=evento_id,
        version=numero,
        status="submitted",
        snapshot=foto,
        changed_fields=campos_cambiados(anterior.snapshot if anterior else None, foto),
        reason=motivo.strip(),
        created_by=usuario.id,
    )
    db.add(version)

    operacion.workflow_status = destino
    operacion.current_version = numero
    operacion.submitted_at = ahora()
    operacion.updated_at = ahora()

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.submitted",
        entity_type="event",
        entity_id=evento_id,
        # El estado REAL de partida. Estaba fijo en BORRADOR, y `submit`
        # también se admite desde CONDITIONAL: el reenvío de un condicional
        # quedaba registrado con un «antes» falso.
        previous_state=estado_de_partida,
        new_state=destino,
        reason=motivo.strip() or None,
        payload={"version": numero},
    )
    await db.commit()
    await db.refresh(operacion)
    return await expediente(db, evento_id)


async def _publicar_al_enviar(
    db: AsyncSession,
    *,
    evento: Event,
    operacion: EventOperations,
    usuario: AuthUser,
    motivo: str,
) -> Expediente:
    """MODO FLEXIBLE: enviar publica. Una transacción, sin decisión inventada.

    NO SE ESCRIBE UNA DECISIÓN «APROBADA». La base la rechaza sin una
    evaluación de 85 o más (`event_admission_decisions_umbral`) y, además,
    aprobar pone el sello «Seleccionado por Z», que aquí nadie ha concedido:
    `selection_status` se queda como estaba. Lo que sí queda es la auditoría,
    con el sistema como actor, para poder distinguir después qué se publicó
    así. Administración puede suspenderlo igual que cualquier otro.
    """
    evento_id = evento.id
    estado_de_partida = operacion.workflow_status
    fallo = motivo_para_no_enviar(evento, operacion, flexible=True)
    if fallo is not None:
        raise ValidationAppError(fallo)

    bloqueos = documentos_que_bloquean(await documentos_de(db, evento_id), ahora())
    if bloqueos:
        raise ConflictError(
            "No se publica con requisitos pendientes: " + ", ".join(bloqueos)
        )

    anterior = await ultima_version(db, evento_id)
    if anterior is not None and anterior.status != "superseded":
        anterior.status = "superseded"
        # La vieja deja de ser la vigente ANTES de insertar la nueva: el índice
        # parcial de la 0060 admite una sola versión no superada por evento.
        await db.flush()

    foto = _foto(evento, operacion)
    numero = (anterior.version + 1) if anterior is not None else 1
    db.add(
        EventVersion(
            event_id=evento_id,
            version=numero,
            status="published",
            snapshot=foto,
            changed_fields=campos_cambiados(anterior.snapshot if anterior else None, foto),
            reason=motivo.strip(),
            created_by=usuario.id,
        )
    )

    momento = ahora()
    operacion.workflow_status = states.PUBLICADO
    operacion.current_version = numero
    operacion.submitted_at = momento
    operacion.published_at = momento
    operacion.updated_at = momento
    evento.status = "published"

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        actor_role="user",
        action="event.submitted",
        entity_type="event",
        entity_id=evento_id,
        previous_state=estado_de_partida,
        new_state=states.PUBLICADO,
        reason=motivo.strip() or None,
        payload={"version": numero, "modo": "publicacion_flexible"},
    )
    await auditoria.anotar(
        db,
        actor_id=None,
        actor_role="system",
        action="event.published",
        entity_type="event",
        entity_id=evento_id,
        previous_state=estado_de_partida,
        new_state=states.PUBLICADO,
        payload={"version": numero, "modo": "publicacion_flexible"},
    )
    await avisos.avisar(
        db,
        user_id=evento.organizer_id,
        tipo="event_published",
        entidad="event",
        entidad_id=evento_id,
        titulo=evento.title,
        automatico=True,
    )
    await db.commit()
    await db.refresh(operacion)
    return await expediente(db, evento_id)


async def versiones_de(db: AsyncSession, evento_id: str) -> list[EventVersion]:
    filas = await db.scalars(
        select(EventVersion)
        .where(EventVersion.event_id == evento_id)
        .order_by(EventVersion.version.desc())
    )
    return list(filas)


# --------------------------------------------------------------------------- #
# Admisión
# --------------------------------------------------------------------------- #


async def evaluar(
    db: AsyncSession,
    *,
    evento_id: str,
    puntajes: dict[str, int],
    evidencia: str,
    falla_critica: bool,
    motivo_de_la_falla: str,
    usuario: AuthUser,
) -> EventAdmissionReview:
    """Guarda la evaluación de curaduría de la versión que está en revisión.

    PUNTUAR NO ES DECIDIR. Esto no mueve el estado del evento; deja el puntaje y
    la evidencia para que quien decida tenga sobre qué decidir.
    """
    fallo = admission.motivo_para_no_puntuar(puntajes)
    if fallo is not None:
        raise ValidationAppError(fallo)
    if not evidencia.strip():
        raise ValidationAppError("La evaluación necesita evidencia escrita.")
    if falla_critica and not motivo_de_la_falla.strip():
        raise ValidationAppError("Una falla crítica necesita decir cuál es.")

    operacion = await _tomar_el_turno(db, evento_id)
    if operacion.workflow_status not in (states.ENVIADO, states.CONDICIONAL):
        raise ConflictError("Solo se evalúa un evento que está en revisión.")
    if operacion.current_version is None:
        raise ConflictError("Este evento no tiene ninguna versión que evaluar.")

    evaluacion = await evaluacion_de(db, evento_id, operacion.current_version)
    total = sum(puntajes[nombre] for nombre in admission.CRITERIOS)
    # QUÉ HABÍA ANTES. La evaluación se sobrescribe en su sitio —es única por
    # evento y versión—, así que sin esto subir un 70 a un 90 no dejaba
    # constancia de que hubiera habido un 70. «Nadie modifica un puntaje sin
    # motivo, evidencia y auditoría» empieza por saber qué se modificó.
    antes = (
        {
            "total": evaluacion.total,
            "critical_failure": evaluacion.critical_failure,
            **{n: getattr(evaluacion, n) for n in admission.CRITERIOS},
        }
        if evaluacion is not None
        else None
    )
    if evaluacion is None:
        evaluacion = EventAdmissionReview(
            event_id=evento_id, version=operacion.current_version
        )
        db.add(evaluacion)
    for nombre in admission.CRITERIOS:
        setattr(evaluacion, nombre, puntajes[nombre])
    evaluacion.total = total
    evaluacion.evidence = evidencia.strip()
    evaluacion.critical_failure = falla_critica
    evaluacion.critical_reason = motivo_de_la_falla.strip()
    evaluacion.reviewer_id = usuario.id
    evaluacion.updated_at = ahora()

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.reviewed",
        entity_type="event",
        entity_id=evento_id,
        payload={
            "version": operacion.current_version,
            "total": total,
            "critical_failure": falla_critica,
            "antes": antes,
        },
    )
    await db.commit()
    await db.refresh(evaluacion)
    return evaluacion


#: El aviso que recibe el organizador por cada decisión (`notifications/decisiones.py`).
TIPO_DE_AVISO_POR_DECISION = {
    admission.APROBADO: "event_admission_approved",
    admission.CONDICIONAL: "event_admission_conditional",
    admission.RECHAZADO: "event_admission_rejected",
    admission.CAMBIOS: "event_admission_changes",
}

#: Acción de la máquina de estados por decisión de admisión.
_ACCION_POR_DECISION = {
    admission.APROBADO: "approve",
    admission.CONDICIONAL: "approve_conditional",
    admission.RECHAZADO: "reject",
    admission.CAMBIOS: "request_changes",
}


async def decidir(
    db: AsyncSession,
    *,
    evento_id: str,
    decision: str,
    motivo: str,
    usuario: AuthUser,
) -> Expediente:
    """Aprueba, condiciona, rechaza o pide correcciones. Con motivo obligatorio.

    RECHAZAR DEVUELVE A BORRADOR. El blueprint no tiene un estado `REJECTED`, y
    no se inventa: el rechazo vive en la decisión, con su motivo y su autor, y
    el evento vuelve a manos del organizador sin haber estado publicado nunca.
    """
    if not motivo.strip():
        raise ValidationAppError("Toda decisión de admisión necesita un motivo.")
    if decision not in _ACCION_POR_DECISION:
        raise ValidationAppError(f"«{decision}» no es una decisión de admisión.")

    operacion = await _tomar_el_turno(db, evento_id)
    anterior = operacion.workflow_status
    destino = _destino(_ACCION_POR_DECISION[decision], anterior)

    evaluacion = None
    if operacion.current_version is not None:
        evaluacion = await evaluacion_de(db, evento_id, operacion.current_version)
    resumen = (
        admission.Evaluacion(
            puntajes={n: getattr(evaluacion, n) for n in admission.CRITERIOS},
            falla_critica=evaluacion.critical_failure,
        )
        if evaluacion is not None
        else None
    )
    fallo = admission.motivo_para_no_decidir(decision, resumen)
    if fallo is not None:
        raise ConflictError(fallo)

    db.add(
        EventAdmissionDecision(
            event_id=evento_id,
            version=operacion.current_version or 0,
            decision=decision,
            reason=motivo.strip(),
            total=resumen.total if resumen is not None else None,
            critical_failure=bool(resumen.falla_critica) if resumen else False,
            decided_by=usuario.id,
        )
    )

    operacion.workflow_status = destino
    operacion.decided_at = ahora()
    operacion.updated_at = ahora()
    # EL SELLO NO SE REGALA. `approved` lo pone; cualquier otra decisión lo
    # quita, incluida la condicional: un pendiente por subsanar no es calidad
    # aprobada, y dejarlo puesto haría que el sello sobreviviera a su motivo.
    operacion.selection_status = (
        "approved" if admission.da_sello_z(decision) else "none"
    )

    if operacion.current_version is not None:
        version = await ultima_version(db, evento_id)
        if version is not None and version.status == "submitted":
            if decision == admission.APROBADO:
                version.status = "approved"

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action=f"event.{decision}",
        entity_type="event",
        entity_id=evento_id,
        previous_state=anterior,
        new_state=destino,
        reason=motivo.strip(),
        payload={
            "version": operacion.current_version,
            "total": resumen.total if resumen is not None else None,
            "selection_status": operacion.selection_status,
        },
    )
    evento = await db.get(Event, evento_id)
    if evento is not None:
        await avisos.avisar(
            db,
            user_id=evento.organizer_id,
            tipo=TIPO_DE_AVISO_POR_DECISION[decision],
            entidad="event",
            entidad_id=evento_id,
            titulo=evento.title,
            # Aprobar no necesita explicarse; lo demás, sí: el motivo es lo
            # que le dice al organizador qué corregir.
            motivo=None if decision == admission.APROBADO else motivo,
        )
    await db.commit()
    return await expediente(db, evento_id)


def documentos_que_bloquean(documentos: list[EventDocument], momento: datetime) -> list[str]:
    """Los requisitos que impiden publicar ahora mismo.

    Un documento vencido bloquea aunque esté aprobado: el permiso municipal que
    caducó ayer no autoriza nada hoy.
    """
    bloquean = []
    for doc in documentos:
        if not doc.blocks_publication:
            continue
        vencido = doc.expires_at is not None and _sin_zona(doc.expires_at) < _sin_zona(momento)
        if doc.status != "approved" or vencido:
            bloquean.append(doc.kind)
    return sorted(bloquean)


def _sin_zona(valor: datetime) -> datetime:
    """Comparable en PostgreSQL (con zona) y en SQLite (sin ella)."""
    return valor.replace(tzinfo=None) if valor.tzinfo is not None else valor


async def publicar(
    db: AsyncSession, *, evento_id: str, usuario: AuthUser
) -> Expediente:
    """Hace visible un evento APROBADO. Nada más puede publicarse.

    Escribe las dos cosas: `workflow_status = PUBLISHED` y el `events.status`
    de siempre, que es por donde el catálogo público filtra. Mientras existan
    las dos, publicar es un solo sitio en el código.
    """
    evento = await _exigir_evento(db, evento_id)
    operacion = await _tomar_el_turno(db, evento_id)
    anterior = operacion.workflow_status
    destino = _destino("publish", anterior)

    bloqueos = documentos_que_bloquean(await documentos_de(db, evento_id), ahora())
    if bloqueos:
        raise ConflictError(
            "No se publica con requisitos pendientes: " + ", ".join(bloqueos)
        )

    operacion.workflow_status = destino
    operacion.published_at = ahora()
    operacion.updated_at = ahora()
    evento.status = "published"

    version = await ultima_version(db, evento_id)
    if version is not None and version.status in ("submitted", "approved"):
        version.status = "published"

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.published",
        entity_type="event",
        entity_id=evento_id,
        previous_state=anterior,
        new_state=destino,
        payload={"version": operacion.current_version},
    )
    await avisos.avisar(
        db,
        user_id=evento.organizer_id,
        tipo="event_published",
        entidad="event",
        entidad_id=evento_id,
        titulo=evento.title,
    )
    await db.commit()
    return await expediente(db, evento_id)


async def cambiar_visibilidad(
    db: AsyncSession, *, evento_id: str, accion: str, motivo: str, usuario: AuthUser
) -> Expediente:
    """Suspende o reanuda. Suspender DETIENE las reservas.

    `cancel` no está: cancelar abre devoluciones y este incremento no cobra
    entradas. Detener la venta es exactamente lo que hace suspender.
    """
    if accion == "suspend" and not motivo.strip():
        raise ValidationAppError("Suspender un evento necesita un motivo.")

    evento = await _exigir_evento(db, evento_id)
    operacion = await _tomar_el_turno(db, evento_id)
    anterior = operacion.workflow_status
    destino = _destino(accion, anterior)

    operacion.workflow_status = destino
    operacion.updated_at = ahora()
    # Deja de verse en el catálogo mientras se resuelve. No se borra nada: las
    # reservas que ya existen siguen ahí.
    evento.status = "published" if destino == states.PUBLICADO else "draft"

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action=f"event.{accion}",
        entity_type="event",
        entity_id=evento_id,
        previous_state=anterior,
        new_state=destino,
        reason=motivo.strip() or None,
    )
    if accion == "suspend":
        await avisos.avisar(
            db,
            user_id=evento.organizer_id,
            tipo="event_suspended",
            entidad="event",
            entidad_id=evento_id,
            titulo=evento.title,
            motivo=motivo,
        )
    await db.commit()
    return await expediente(db, evento_id)


async def cancelar(
    db: AsyncSession, *, evento_id: str, motivo: str, usuario: AuthUser
):
    """Cancela el evento entero y deja lo vendido retenido y con devolución debida.

    QUÉ PASA CON EL DINERO NO SE DECIDE AQUÍ. Lo decide `cancelacion.py`, que es
    el único sitio donde vive la regla, y hoy contesta que Z exige devolver el
    100 %. Lo que NO pasa aquí ni allí: ejecutar, liberar o transferir.

    EN UNA SOLA TRANSACCIÓN. Un evento cancelado sin sus expedientes sería gente
    con la entrada muerta y sin ningún caso abierto.
    """
    from app.modules.events import cancelacion

    if not motivo.strip():
        raise ValidationAppError("Cancelar un evento necesita un motivo.")

    evento = await _exigir_evento(db, evento_id)
    operacion = await _tomar_el_turno(db, evento_id)
    anterior = operacion.workflow_status
    destino = _destino("cancel", anterior)

    operacion.workflow_status = destino
    operacion.updated_at = ahora()
    # SALE DEL CATÁLOGO, y el estado de verdad vive en `workflow_status`.
    # `content_status` no tiene `cancelled` y añadirlo al enum por esto sería
    # tocar un tipo que usa media plataforma; `hidden` dice lo que hace falta:
    # ya no se ve. Ni `draft` —nunca fue un borrador— ni `deleted`.
    evento.status = "hidden"

    resultado = await cancelacion.cancelar_evento(
        db, evento_id=evento_id, actor_id=usuario.id, motivo=motivo.strip()
    )

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.cancel",
        entity_type="event",
        entity_id=evento_id,
        previous_state=anterior,
        new_state=destino,
        reason=motivo.strip()[:500],
        payload={
            "regla": resultado.regla,
            "expedientes": resultado.expedientes,
            "saldos_bloqueados": resultado.saldos_bloqueados,
            "sin_saldo": resultado.sin_saldo,
            # DECIDIDAS, no pagadas. La auditoría tiene que poder distinguir
            # «Z debe este dinero» de «este dinero volvió».
            "devoluciones_decididas": resultado.devoluciones_decididas,
            "pendientes": resultado.pendientes,
        },
    )
    await db.commit()
    return await expediente(db, evento_id), resultado


async def guardar_documento(
    db: AsyncSession,
    *,
    evento_id: str,
    datos: dict[str, Any],
    usuario: AuthUser,
) -> EventDocument:
    """Registra un requisito documental y su estado. Uno por tipo y evento."""
    await inventory.bloquear_evento(db, evento_id)
    tipo = str(datos.get("kind", "")).strip()
    if not tipo:
        raise ValidationAppError("El requisito necesita un tipo.")

    doc = await db.scalar(
        select(EventDocument).where(
            EventDocument.event_id == evento_id, EventDocument.kind == tipo
        )
    )
    if doc is None:
        doc = EventDocument(event_id=evento_id, kind=tipo)
        db.add(doc)
    # `blocks_publication` es el campo que LEVANTA el bloqueo de publicación:
    # cambiarlo sin dejar dicho qué había antes es cambiar quién puede publicar
    # sin rastro.
    antes = {"status": doc.status, "blocks_publication": doc.blocks_publication}
    for campo in ("status", "expires_at", "required", "blocks_publication", "note", "file_path"):
        if campo in datos and datos[campo] is not None:
            setattr(doc, campo, datos[campo])
    doc.updated_at = ahora()

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.document_recorded",
        entity_type="event",
        entity_id=evento_id,
        payload={
            "kind": tipo,
            "status": doc.status,
            "blocks_publication": doc.blocks_publication,
            "antes": antes,
        },
    )
    await db.commit()
    await db.refresh(doc)
    return doc


# --------------------------------------------------------------------------- #
# Listados
# --------------------------------------------------------------------------- #


async def mis_eventos(
    db: AsyncSession, *, usuario: AuthUser, limite: int, desplazamiento: int
) -> list[Expediente]:
    filas = (
        await db.execute(
            select(Event, EventOperations)
            .join(EventOperations, EventOperations.event_id == Event.id)
            .where(Event.organizer_id == usuario.id)
            .order_by(EventOperations.updated_at.desc(), Event.id.desc())
            .limit(limite)
            .offset(desplazamiento)
        )
    ).all()
    expedientes = await _con_conteos(db, filas)
    # LA ÚLTIMA OBSERVACIÓN, en UNA consulta. Sin esto la lista devolvía
    # `ultima_observacion: null` siempre: a quien le devolvían un evento con
    # correcciones veía una fila «Borrador» sin ninguna señal de que le habían
    # pedido algo. Es el mismo fallo que tenía la cola de revisión.
    await _con_decisiones(db, expedientes)
    return expedientes


async def _con_decisiones(db: AsyncSession, expedientes: list[Expediente]) -> None:
    """La decisión MÁS RECIENTE de cada evento, sin una consulta por evento."""
    ids = [exp.evento.id for exp in expedientes]
    if not ids:
        return
    filas = await db.scalars(
        select(EventAdmissionDecision)
        .where(EventAdmissionDecision.event_id.in_(set(ids)))
        .order_by(EventAdmissionDecision.created_at.asc())
    )
    # Ascendente y sobrescribiendo: la última que se lee de cada evento es la
    # más reciente. Un `distinct on` no existe en SQLite.
    ultima: dict[str, EventAdmissionDecision] = {}
    for fila in filas:
        ultima[fila.event_id] = fila
    for exp in expedientes:
        exp.decision = ultima.get(exp.evento.id)


#: Lo que espera una decisión. `CONDITIONAL` entra: tiene un pendiente y sigue
#: siendo trabajo de curaduría, no del olvido.
#:
#: `APPROVED` TAMBIÉN: aprobado todavía no es publicado, y publicar es otro
#: paso de administración. Antes salía de la cola al aprobarlo, así que quien
#: cerraba la pantalla de revisión antes de pulsar «Publicar» dejaba el evento
#: aprobado para siempre, sin ninguna lista desde la que volver a encontrarlo.
PENDIENTES = (states.ENVIADO, states.CONDICIONAL, states.APROBADO)


async def pendientes(
    db: AsyncSession, *, limite: int, desplazamiento: int, estado: str | None = None
) -> list[Expediente]:
    estados = (estado,) if estado else PENDIENTES
    filas = (
        await db.execute(
            select(Event, EventOperations)
            .join(EventOperations, EventOperations.event_id == Event.id)
            .where(EventOperations.workflow_status.in_(estados))
            .order_by(EventOperations.submitted_at.asc(), Event.id.asc())
            .limit(limite)
            .offset(desplazamiento)
        )
    ).all()
    expedientes = await _con_conteos(db, filas)
    # LAS EVALUACIONES DE LA PÁGINA, en UNA consulta. Sin esto la cola decía
    # «sin evaluar» en todas las filas, incluidas las que ya tenían puntaje:
    # no es que faltara un dato, es que enseñaba uno falso.
    await _con_evaluaciones(db, expedientes)
    return expedientes


async def _con_evaluaciones(db: AsyncSession, expedientes: list[Expediente]) -> None:
    """Cuelga a cada expediente la evaluación DE SU VERSIÓN VIGENTE.

    Se pide por el par `(evento, versión)` y no solo por evento: una evaluación
    de la versión 1 no dice nada de la 2, y colgarla ahí haría creer que lo
    último enviado ya se miró.
    """
    pares = [
        (exp.evento.id, exp.operacion.current_version)
        for exp in expedientes
        if exp.operacion.current_version is not None
    ]
    if not pares:
        return
    filas = await db.scalars(
        select(EventAdmissionReview).where(
            tuple_(
                EventAdmissionReview.event_id, EventAdmissionReview.version
            ).in_(pares)
        )
    )
    por_evento = {(f.event_id, f.version): f for f in filas}
    for exp in expedientes:
        exp.evaluacion = por_evento.get(
            (exp.evento.id, exp.operacion.current_version)
        )


async def _con_conteos(db: AsyncSession, filas) -> list[Expediente]:
    """Los inscritos de todas las filas en UNA consulta, no una por evento."""
    ids = [evento.id for evento, _ in filas]
    conteos: dict[str, int] = {}
    if ids:
        resultado = await db.execute(
            select(
                EventRegistration.event_id,
                func.count(),
            )
            .where(
                EventRegistration.event_id.in_(set(ids)),
                EventRegistration.status.in_(inventory.ACTIVAS),
            )
            .group_by(EventRegistration.event_id)
        )
        conteos = {fila[0]: fila[1] for fila in resultado.all()}
    return [
        Expediente(
            evento=evento,
            operacion=operacion,
            inscritos=conteos.get(evento.id, 0),
        )
        for evento, operacion in filas
    ]


def estado_para_mostrar(exp: Expediente, momento: datetime | None = None) -> str:
    """El estado con los derivados ya resueltos."""
    momento = momento or eventos.ahora()
    aforo = inventory.aforo_de(exp.evento, exp.operacion.approved_capacity)
    lleno = aforo is not None and exp.inscritos >= aforo
    return states.estado_visible(
        exp.operacion.workflow_status,
        lleno=lleno,
        temporal=eventos.estado_de(exp.evento, momento),
    )
