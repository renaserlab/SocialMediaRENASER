"""Esquemas de notificaciones."""

from datetime import datetime

from pydantic import BaseModel

from app.modules.content.schemas import AuthorSummary


class NotificationRead(BaseModel):
    id: str
    type: str
    actor: AuthorSummary | None = None
    entity_type: str | None = None
    entity_id: str | None = None
    read: bool = False
    created_at: datetime

    #: CUANTA GENTE reaccionó en total a esa publicación.
    #:
    #: Solo viaja en las notificaciones agrupadas de «me gusta». Es lo que
    #: permite escribir «Edson y 99 personas más» en vez de cien avisos
    #: distintos, uno por persona.
    #:
    #: Sale de contar `post_likes` EN VIVO, no de un contador guardado. Así no
    #: puede quedarse desfasado cuando alguien retira su reacción, que es
    #: exactamente lo que le pasaría a un número escrito en la notificación el
    #: día que se creó.
    #:
    #: `None` en todo lo que no sea un «me gusta» agrupado, para que el cliente
    #: distinga «no aplica» de «cero personas».
    group_count: int | None = None
