"""Lo que sale por la API. Esquemas CERRADOS, campo a campo.

LA LISTA DE LO QUE NUNCA SALE POR AQUÍ, y cada uno estuvo a punto de salir:

    ip_hash              no
    ip_prefix            no
    user_agent_family    no
    la IP en claro       no existe ni en la base

El contexto de origen se guarda para poder resolver un caso de abuso desde
administración, con permisos de tesorería. No es información del alumno ni del
creador del curso, y la protección de verdad **no es la RLS** —la API entra con
la clave de servicio y se la salta— sino que estos esquemas no lo enumeran.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class PoliticaVigente(BaseModel):
    """El texto que rige ahora mismo, tal y como se le enseña a la persona."""

    policy_type: str
    version: str
    jurisdiction: str
    locale: str
    body: str
    checkbox_text: str | None = None
    effective_from: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ConsentimientoPropio(BaseModel):
    """Una aceptación, vista por quien la firmó.

    SIN `ip_hash`, `ip_prefix` NI `user_agent_family`: ni siquiera a la propia
    persona se le devuelven. No le aportan nada y convertirían el endpoint en
    una forma de comprobar desde dónde se conecta una cuenta.

    Tampoco va `policy_hash`: es un dato técnico que no dice nada a quien lo lee
    y no ayuda a nadie a entender qué aceptó. Lo que ayuda es el texto.
    """

    id: str
    policy_type: str
    policy_version: str
    accepted_at: datetime
    scope_kind: str
    scope_id: str | None = None
    consumed_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class VersionDeCurso(BaseModel):
    """La fotografía de lo que un curso ofrecía.

    `reconstruida` es la que más importa de todo el esquema: distingue una
    versión creada al publicar de verdad de una reconstruida por el backfill de
    la 0050 a partir del estado actual del curso. Sin esa distinción, el
    backfill se convierte en una prueba falsa de qué se vendió.
    """

    id: str
    course_id: str
    version: int
    status: str
    published_at: datetime
    reconstruida: bool
    snapshot: dict


class EventoDeAuditoria(BaseModel):
    """Una operación sensible, vista desde administración.

    SIN el contexto de origen tampoco aquí. Quien investiga un abuso lo hace
    con acceso directo a la base y con motivo; no se sirve por una API que
    cualquier administrador puede llamar desde el móvil.
    """

    id: str
    occurred_at: datetime
    action: str
    entity_type: str
    entity_id: str
    outcome: str
    actor_id: str | None = None
    actor_role: str
    previous_state: str | None = None
    new_state: str | None = None
    reason: str | None = None
    external_reference: str | None = None
    payload: dict = {}
    request_id: str | None = None

    model_config = ConfigDict(from_attributes=True)
