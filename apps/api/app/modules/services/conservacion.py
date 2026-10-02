"""Lo que Servicios tiene que conservar de una persona: su HISTORIA CONTRACTUAL.

LA REGLA (F21, decisión PROVISIONAL de la primera versión, 02/10/2026). Una
cuenta con historia contractual en Servicios NO SE BORRA SOLA: la baja
automática contesta 409 y la cierra soporte. Antes, borrar la cuenta de quien
presta se llevaba en cascada sus servicios y, con ellos, las reservas pasadas,
los pedidos, lo que aceptó quien contrató, las atenciones, los casos con su
expediente y las reseñas; y la de quien contrata dejaba todo eso sin su nombre
y se llevaba su nota y sus evidencias.

NO ES LA SOLUCIÓN DEFINITIVA. Conservar esa historia sin que siga nombrando a
la persona (anonimizar) exige una decisión legal y cambiar la clave de la
0090: sigue pendiente. Esto es el freno que impide que, mientras tanto, el
flujo normal de baja la destruya o la deje a medias.

QUÉ ES HISTORIA CONTRACTUAL. Todo nace al CONFIRMAR una reserva
(`reserva.confirmar`, el único sitio que escribe un pedido y una reserva) y
cuelga de ese pedido o de esa reserva: `FAMILIAS`. Frena en CUALQUIER estado:
una reserva cancelada, una atención cerrada, un caso retirado o resuelto y una
reseña oculta son historia igual que lo vivo. Y frena a las DOS partes: a
quien contrató y a quien prestó.

QUÉ NO LO ES, y no frena: `NO_FRENAN`. La postulación y sus documentos, el
catálogo sin contratar, la agenda, una retención que no llegó a reserva y lo
guardado se siguen yendo con la cuenta, como hasta ahora.

SE MIRA CON LA BANDERA APAGADA TAMBIÉN: apagar Servicios no convierte su
historia en descartable.

SOLO PROTEGE EL CAMINO DE LA API (`DELETE /auth/me`). Quien borre la fila del
perfil a mano en Supabase sigue disparando las cascadas de la 0090: no hay
ninguna otra ruta de la aplicación que borre un perfil.
"""

from __future__ import annotations

from sqlalchemy import exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from app.modules.profiles.models import Profile
from app.modules.services.agenda_models import (
    ServiceSchedule,
    ServiceScheduleBlock,
    ServiceScheduleEvent,
    ServiceScheduleException,
    ServiceScheduleRule,
)
from app.modules.services.atencion_models import (
    ServiceAttendance,
    ServiceIncident,
    ServiceIncidentEntry,
    ServiceReview,
)
from app.modules.services.catalogo_models import (
    Service,
    ServiceCategory,
    ServiceEvent,
    ServiceVersion,
    ServiceVersionImage,
)
from app.modules.services.descubrimiento_models import SavedService
from app.modules.services.models import (
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderApplicationSubmission,
    ServiceProviderCredential,
    ServiceProviderDocument,
)
from app.modules.services.reserva_models import (
    RETENCION_ACTIVA,
    ServiceBooking,
    ServiceBookingAcceptance,
    ServiceBookingEvent,
    ServiceBookingIntake,
    ServiceHold,
    ServiceOrder,
)

#: LAS FAMILIAS CONTRACTUALES: `(tabla, raíz, cómo se llega a la raíz)`. La
#: raíz es el pedido o la reserva, que es donde consta QUIÉN es parte: quien
#: contrató (`client_id`) y quien prestó (`provider_id`).
#:
#: SE MIRAN TODAS, aunque hoy ninguna fila de las demás pueda existir sin su
#: reserva: la comprobación no depende de que eso siga siendo verdad.
#:
#: POR LA PARTE, NO POR QUIEN ESCRIBIÓ. Quien resolvió un caso desde
#: administración figura en el expediente y no es parte de la reserva: su
#: cuenta no se frena por eso.
FAMILIAS: tuple[tuple[type, type, tuple], ...] = (
    (ServiceOrder, ServiceOrder, ()),
    (ServiceBooking, ServiceBooking, ()),
    (ServiceBookingIntake, ServiceBooking, (ServiceBookingIntake.booking_id == ServiceBooking.id,)),
    (ServiceBookingAcceptance, ServiceOrder, (ServiceBookingAcceptance.order_id == ServiceOrder.id,)),
    # El historial DE UNA RESERVA. Las líneas de una retención que no llegó a
    # reserva no tienen `booking_id` y no entran.
    (ServiceBookingEvent, ServiceBooking, (ServiceBookingEvent.booking_id == ServiceBooking.id,)),
    (ServiceAttendance, ServiceBooking, (ServiceAttendance.booking_id == ServiceBooking.id,)),
    (ServiceIncident, ServiceBooking, (ServiceIncident.booking_id == ServiceBooking.id,)),
    # El expediente: mensajes, evidencias, resoluciones, la apelación y notas.
    (
        ServiceIncidentEntry,
        ServiceBooking,
        (ServiceIncidentEntry.incident_id == ServiceIncident.id, ServiceIncident.booking_id == ServiceBooking.id),
    ),
    (ServiceReview, ServiceBooking, (ServiceReview.booking_id == ServiceBooking.id,)),
)

#: LA CLASIFICACIÓN DE LO DEMÁS (F21): por qué no frena la baja. Toda tabla de
#: Servicios está aquí o en `FAMILIAS`; una nueva tiene que clasificarse.
DESCARTABLE = "operativa descartable"
DOCUMENTAL = "documental sensible"
DERIVADO = "dato derivado"
DE_LA_PLATAFORMA = "de la plataforma"
NO_FRENAN: dict[type, str] = {
    # La postulación y sus documentos de identidad: datos personales de quien
    # postula. Se borran con la cuenta y sus archivos (S7), en cualquier estado.
    ServiceProvider: DOCUMENTAL,
    ServiceProviderApplication: DOCUMENTAL,
    ServiceProviderDocument: DOCUMENTAL,
    ServiceProviderCredential: DOCUMENTAL,
    ServiceProviderApplicationEvent: DOCUMENTAL,
    ServiceProviderApplicationSubmission: DOCUMENTAL,
    # El catálogo y la agenda de un servicio que nadie contrató: no obligan a
    # nadie. Se van con la cuenta, y sus imágenes con ellos, sin retiro previo.
    Service: DESCARTABLE,
    ServiceVersion: DESCARTABLE,
    ServiceVersionImage: DESCARTABLE,
    ServiceEvent: DESCARTABLE,
    ServiceSchedule: DESCARTABLE,
    ServiceScheduleRule: DESCARTABLE,
    ServiceScheduleException: DESCARTABLE,
    ServiceScheduleBlock: DESCARTABLE,
    ServiceScheduleEvent: DESCARTABLE,
    # Un horario apartado unos minutos que no llegó a reserva. La que sí llegó
    # (`consumed`) es de su reserva, y esa frena.
    ServiceHold: DESCARTABLE,
    # Lo que alguien guardó para verlo después.
    SavedService: DERIVADO,
    # No son de ninguna persona: no se van con ninguna cuenta.
    ServicePolicy: DE_LA_PLATAFORMA,
    ServiceCategory: DE_LA_PLATAFORMA,
}


def _parte(raiz: type, enlaces: tuple, perfil_id: str):
    """¿Hay alguna fila en un pedido o una reserva donde esta persona es
    parte? Dos `EXISTS`, uno por papel: cada uno entra por el índice de su
    columna (`…_de_la_persona`, `…_del_prestador`) y baja a lo demás por la
    clave de la reserva. Juntarlos en un `or` sobre la misma tabla obligaría a
    recorrerla entera."""
    como_cliente = exists().where(*enlaces, raiz.client_id == perfil_id)
    como_prestador = exists().where(
        *enlaces, raiz.provider_id == ServiceProvider.id, ServiceProvider.profile_id == perfil_id
    )
    return or_(como_cliente, como_prestador)


def consulta(perfil_id: str) -> Select:
    """UNA sentencia, una columna por familia: `true` si la persona tiene algo
    en ella. No cuenta ni carga nada."""
    return select(
        *(_parte(raiz, enlaces, perfil_id).label(tabla.__tablename__) for tabla, raiz, enlaces in FAMILIAS)
    )


async def _poner_en_fila(db: AsyncSession, perfil_id: str) -> None:
    """Que no nazca una reserva entre mirar y borrar. Hasta el final de la
    transacción de la baja:

      * LOS SERVICIOS en los que puede nacer: los que ofrece y aquellos en los
        que tiene un horario apartado. Con el mismo cerrojo que toma quien
        contrata (`reserva._poner_en_fila`, FOR NO KEY UPDATE): una
        confirmación en curso termina antes de mirar, y una nueva espera.
      * SU PERFIL (FOR UPDATE): escribir un pedido o una reserva a su nombre
        comprueba la clave ajena a `profiles` y espera también.

    EN ESE ORDEN, que es el de la confirmación (el servicio y después la
    persona): al revés, la baja y una confirmación a la vez se esperarían la
    una a la otra (40P01). Solo PostgreSQL: SQLite (pruebas) no tiene cerrojos
    de fila.
    """
    if (await db.connection()).dialect.name != "postgresql":
        return
    los_que_ofrece = select(ServiceProvider.id).where(ServiceProvider.profile_id == perfil_id)
    donde_aparto = select(ServiceHold.service_id).where(
        ServiceHold.client_id == perfil_id, ServiceHold.status == RETENCION_ACTIVA
    )
    await db.execute(
        select(Service.id)
        .where(or_(Service.provider_id.in_(los_que_ofrece), Service.id.in_(donde_aparto)))
        .order_by(Service.id)
        .with_for_update(key_share=True)
    )
    await db.execute(select(Profile.id).where(Profile.id == perfil_id).with_for_update())


async def de_la_persona(db: AsyncSession, perfil_id: str) -> tuple[str, ...]:
    """Las familias contractuales en las que esta persona es parte; vacía si
    no tiene historia que conservar.

    DENTRO DE LA TRANSACCIÓN DE LA BAJA y antes de borrar o de tocar un
    archivo: deja en fila sus servicios y su perfil. CUALQUIER FALLO SUBE: quien
    llama no puede dar por buena una cuenta que no se pudo mirar.

    Los nombres son para el registro de soporte. A la persona no se le dice
    ni cuáles ni cuántas.
    """
    await _poner_en_fila(db, perfil_id)
    fila = (await db.execute(consulta(perfil_id))).one()
    return tuple(nombre for nombre, hay in fila._mapping.items() if hay)


__all__ = [
    "DERIVADO",
    "DESCARTABLE",
    "DE_LA_PLATAFORMA",
    "DOCUMENTAL",
    "FAMILIAS",
    "NO_FRENAN",
    "consulta",
    "de_la_persona",
]
