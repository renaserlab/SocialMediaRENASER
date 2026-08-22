"""Agenda: sesiones 1:1 con estado propio.

Antes solo existia un aviso (`session_booked`, migracion 0019). Un aviso se lee
una vez y no se puede aceptar, rechazar, reprogramar ni dar por hecho; tampoco
deja rastro de que dos personas se hayan visto, que es lo que hara falta el dia
que una resena tenga que ser verificable.
"""

from app.modules.bookings.router import router  # noqa: F401
