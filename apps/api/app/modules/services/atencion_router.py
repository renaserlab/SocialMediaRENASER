"""Las rutas de la atención y la posventa de Servicios (Incremento 6).

DE QUIEN CONTRATA (`/services/me/bookings/{b}/…`) Y DEL PRESTADOR
(`/services/provider/bookings/{b}/…`). Las que comparten las dos partes:

    POST  …/cancel                          cancelar (antes de empezar)
    POST  …/no-show                         decir que la otra parte no vino
    POST  …/incident                        abrir el caso de la reserva
    GET   …/incident                        el expediente (sin notas internas)
    POST  …/incident/entries                un mensaje al expediente
    POST  …/incident/evidence               una evidencia (PDF o foto, privada)
    GET   …/incident/entries/{e}/file       un enlace firmado para mirarla
    POST  …/incident/withdraw               retirarlo (quien lo abrió)
    POST  …/incident/appeal                 apelar la resolución, una vez

SOLO DE QUIEN CONTRATA:

    POST  …/reschedule                      mover la reserva a un horario ya apartado
    POST  …/check-in-code                   su código de asistencia
    POST  …/confirm                         confirmar que la atención se realizó
    POST  …/review                          la reseña verificada

SOLO DEL PRESTADOR:

    POST  …/start                           empezar (con el código, la señal fuerte)
    POST  …/complete                        marcarla como realizada
    POST  …/review/reply                    responder a la reseña, una vez

PÚBLICA:

    GET   /services/catalog/{id}/reviews    las reseñas publicadas y su resumen

DE ADMINISTRACIÓN (solo `admin`):

    GET   /admin/services/incidents                         la bandeja de casos
    GET   /admin/services/incidents/{c}                     el expediente entero
    POST  /admin/services/incidents/{c}/entries             un mensaje o una nota interna
    GET   /admin/services/incidents/{c}/entries/{e}/file    un enlace firmado
    POST  /admin/services/incidents/{c}/resolve             la resolución
    GET   /admin/services/reviews                           las reseñas, por estado
    POST  /admin/services/reviews/{r}/moderate              publicar o esconder
    POST  /admin/services/tasks/run                         los barridos (recordar, cerrar)

TODA ESCRITURA EXIGE `Idempotency-Key`. LAS PUERTAS, en este orden: sesión
(401) → `FEATURE_SERVICES` y `FEATURE_SERVICE_BOOKING`, sin tocar la base
(503) → 0086–0094 (503 `services_not_ready`) → cuerpo (422). En administración
el ROL va antes que las puertas. Lo ajeno es un 404.

NINGUNA RUTA MUEVE DINERO.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.services import atencion as dominio
from app.modules.services import esquema, posventa
from app.modules.services import reserva as reserva_dominio
from app.modules.services import reserva_politica as limites
from app.modules.services.atencion_schemas import (
    AbrirCaso,
    CancelarReserva,
    CasoAdminRead,
    CodigoRead,
    CrearResena,
    EnlaceRead,
    EscribirDesdeAdministracion,
    EscribirEnElCaso,
    ExpedienteAdminRead,
    ExpedienteRead,
    IniciarAtencion,
    ModerarResena,
    PaginaDeCasosRead,
    PaginaDeResenasAdminRead,
    PaginaDeResenasRead,
    ReprogramarReserva,
    ResenaAdminRead,
    ResenaRead,
    ResolverCaso,
    ResponderResena,
    ResumenDeResenasRead,
    TareasRead,
)
from app.modules.services.models import PESO_MAXIMO_DE_DOCUMENTO
from app.modules.services.reserva_models import CLIENTE, PRESTADOR
from app.modules.services.reserva_router import con_cuidado
from app.modules.services.reserva_schemas import ReservaDelPrestadorRead, ReservaDetalleRead
from app.modules.services.router import _clave, funcion_de_decision
from app.shared.database import get_db

router = APIRouter(prefix="/services", tags=["services-attention"])
admin_router = APIRouter(prefix="/admin/services", tags=["services-attention-admin"])

#: Cada parte, con el prefijo de sus rutas.
PARTES = ((CLIENTE, "/me/bookings"), (PRESTADOR, "/provider/bookings"))


async def atencion_disponible(db: AsyncSession = Depends(get_db)) -> None:
    """Banderas, 0086–0093 y la 0094 completas, o 503."""
    await esquema.exigir_atencion(db)


async def _detalle(db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str):  # noqa: ANN202
    """El detalle FRESCO tras una transición, como lo ve esa parte."""
    if rol == CLIENTE:
        d = await reserva_dominio.mi_reserva(db, cliente_id=usuario_id, reserva_id=reserva_id)
        return ReservaDetalleRead.del_detalle(await con_cuidado(db, d, rol=rol, usuario_id=usuario_id))
    d = await reserva_dominio.reserva_del_prestador(db, usuario_id=usuario_id, reserva_id=reserva_id)
    return ReservaDelPrestadorRead.del_detalle_del_prestador(await con_cuidado(db, d, rol=rol, usuario_id=usuario_id))


async def _expediente(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, caso_id: str | None = None
) -> ExpedienteRead:
    return ExpedienteRead.desde(
        await posventa.expediente(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, caso_id=caso_id),
        usuario_id=usuario_id,
    )


async def _leer_archivo(archivo: UploadFile) -> bytes:
    return await archivo.read(PESO_MAXIMO_DE_DOCUMENTO + 1)


# --------------------------------------------------------------------------- #
# Lo que comparten las dos partes
# --------------------------------------------------------------------------- #
def _rutas_de(rol: str, prefijo: str) -> None:
    modelo = ReservaDetalleRead if rol == CLIENTE else ReservaDelPrestadorRead

    async def cancelar(
        booking_id: str,
        cuerpo: CancelarReserva,
        clave: str | None = Depends(_clave),
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ):
        """Cancela una reserva que todavía no empezó. Libera su horario. Su
        consecuencia (y que no hay dinero que devolver) va en `care.deadlines`."""
        await dominio.cancelar(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol,
                               motivo=cuerpo.reason, nota=cuerpo.note, clave=clave)
        await db.commit()
        return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol)

    async def reportar_ausencia(
        booking_id: str,
        clave: str | None = Depends(_clave),
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ):
        """Dice que LA OTRA parte no vino, pasada la tolerancia. No decide nada
        económico; la otra parte recibe un aviso y puede abrir un caso."""
        await dominio.reportar_ausencia(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol, clave=clave)
        await db.commit()
        return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol)

    async def abrir_caso(
        booking_id: str,
        cuerpo: AbrirCaso,
        clave: str | None = Depends(_clave),
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ) -> ExpedienteRead:
        caso = await posventa.abrir_caso(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol,
                                         motivo=cuerpo.reason, descripcion=cuerpo.description, clave=clave)
        await db.commit()
        return await _expediente(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol, caso_id=caso.id)

    async def ver_caso(
        booking_id: str,
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ) -> ExpedienteRead:
        return await _expediente(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol)

    async def escribir(
        booking_id: str,
        cuerpo: EscribirEnElCaso,
        clave: str | None = Depends(_clave),
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ) -> ExpedienteRead:
        await posventa.escribir(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol,
                                texto=cuerpo.body, clave=clave)
        await db.commit()
        return await _expediente(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol)

    async def subir_evidencia(
        booking_id: str,
        response: Response,
        archivo: UploadFile = File(..., alias="file"),
        clave: str | None = Depends(_clave),
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ) -> ExpedienteRead:
        """Una evidencia (PDF o foto, máx. 10 MB) al depósito PRIVADO. La ruta
        la pone el servidor. El mismo archivo dos veces es el mismo (200)."""
        subida = await posventa.subir_evidencia(
            db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol,
            datos=await _leer_archivo(archivo), declarado=archivo.content_type, clave=clave,
        )
        try:
            await db.commit()
        except BaseException:
            # El archivo ya subió: sin su fila no es de nadie.
            await db.rollback()
            if subida.nueva:
                await posventa.borrar_archivo(subida.entrada.storage_path)
            raise
        # TRAS confirmar, lo que se subió y no hizo falta.
        await posventa.borrar_archivo(subida.sobrante)
        if not subida.nueva:
            response.status_code = status.HTTP_200_OK
        return await _expediente(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol)

    async def enlace(
        booking_id: str,
        entry_id: str,
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ) -> EnlaceRead:
        """Un enlace para MIRAR una evidencia ahora. Caduca enseguida."""
        entrada = await posventa.entrada_de(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol,
                                            entrada_id=entry_id)
        return EnlaceRead(url=await posventa.enlace_de(entrada), expires_in=posventa.SEGUNDOS_DE_LA_FIRMA)

    async def retirar(
        booking_id: str,
        clave: str | None = Depends(_clave),
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ) -> ExpedienteRead:
        caso = await posventa.retirar(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol, clave=clave)
        await db.commit()
        return await _expediente(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol, caso_id=caso.id)

    async def apelar(
        booking_id: str,
        cuerpo: EscribirEnElCaso,
        clave: str | None = Depends(_clave),
        current_user: AuthUser = Depends(get_current_user),
        _disponible: None = Depends(atencion_disponible),
        db: AsyncSession = Depends(get_db),
    ) -> ExpedienteRead:
        """UNA apelación por caso, dentro de su plazo. La resuelve otra persona."""
        await posventa.apelar(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol,
                              texto=cuerpo.body, clave=clave)
        await db.commit()
        return await _expediente(db, usuario_id=current_user.id, reserva_id=booking_id, rol=rol)

    base = f"{prefijo}/{{booking_id}}"
    for ruta, funcion, metodo, respuesta, codigo in (
        ("/cancel", cancelar, "POST", modelo, 200),
        ("/no-show", reportar_ausencia, "POST", modelo, 200),
        ("/incident", abrir_caso, "POST", ExpedienteRead, 201),
        ("/incident", ver_caso, "GET", ExpedienteRead, 200),
        ("/incident/entries", escribir, "POST", ExpedienteRead, 201),
        ("/incident/evidence", subir_evidencia, "POST", ExpedienteRead, 201),
        ("/incident/entries/{entry_id}/file", enlace, "GET", EnlaceRead, 200),
        ("/incident/withdraw", retirar, "POST", ExpedienteRead, 200),
        ("/incident/appeal", apelar, "POST", ExpedienteRead, 200),
    ):
        router.add_api_route(
            base + ruta, funcion, methods=[metodo], response_model=respuesta, status_code=codigo,
            name=f"{funcion.__name__}_{rol}", summary=(funcion.__doc__ or funcion.__name__).strip().split("\n")[0],
        )


for _rol, _prefijo in PARTES:
    _rutas_de(_rol, _prefijo)


# =========================================================================== #
# Solo quien contrata
# =========================================================================== #
@router.post("/me/bookings/{booking_id}/reschedule", response_model=ReservaDetalleRead)
async def reprogramar(
    booking_id: str,
    cuerpo: ReprogramarReserva,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ReservaDetalleRead:
    """Mueve la reserva al horario que quien contrata YA APARTÓ (`hold_id`,
    con `POST /services/catalog/{id}/holds`). Atómico: si falla, la reserva
    original sigue en pie. El contrato no cambia."""
    await dominio.reprogramar(db, cliente_id=current_user.id, reserva_id=booking_id, retencion_id=cuerpo.hold_id,
                              clave=clave)
    await db.commit()
    return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=CLIENTE)


@router.post("/me/bookings/{booking_id}/check-in-code", response_model=CodigoRead)
async def pedir_codigo(
    booking_id: str,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> CodigoRead:
    """EL CÓDIGO DE ASISTENCIA: quien contrata se lo enseña al prestador, y con
    él la atención empieza con la señal fuerte. Pedirlo otra vez da el mismo."""
    atencion = await dominio.pedir_codigo(db, cliente_id=current_user.id, reserva_id=booking_id, clave=clave)
    await db.commit()
    return CodigoRead(checkin_code=atencion.checkin_code)


@router.post("/me/bookings/{booking_id}/confirm", response_model=ReservaDetalleRead)
async def confirmar(
    booking_id: str,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ReservaDetalleRead:
    """Quien contrata confirma que la atención se realizó: queda cerrada."""
    await dominio.confirmar(db, cliente_id=current_user.id, reserva_id=booking_id, clave=clave)
    await db.commit()
    return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=CLIENTE)


@router.post("/me/bookings/{booking_id}/review", response_model=ReservaDetalleRead,
             status_code=status.HTTP_201_CREATED)
async def resenar(
    booking_id: str,
    cuerpo: CrearResena,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ReservaDetalleRead:
    """LA RESEÑA VERIFICADA: de una atención cerrada, una por reserva."""
    await posventa.resenar(db, cliente_id=current_user.id, reserva_id=booking_id,
                           datos=cuerpo.model_dump(), clave=clave)
    await db.commit()
    return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=CLIENTE)


# =========================================================================== #
# Solo el prestador
# =========================================================================== #
@router.post("/provider/bookings/{booking_id}/start", response_model=ReservaDelPrestadorRead)
async def iniciar(
    booking_id: str,
    cuerpo: IniciarAtencion,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ReservaDelPrestadorRead:
    """Empieza la atención. Con el código de quien contrata, la señal fuerte.
    Un código equivocado cuenta como intento (409) y no empieza nada."""
    inicio = await dominio.iniciar(db, usuario_id=current_user.id, reserva_id=booking_id, codigo=cuerpo.code,
                                   clave=clave)
    # EL INTENTO FALLIDO SE GUARDA: por eso se confirma antes de contestar 409.
    await db.commit()
    if not inicio.correcto:
        raise dominio.CodigoIncorrecto(details={"attempts_left": inicio.intentos_restantes})
    return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=PRESTADOR)


@router.post("/provider/bookings/{booking_id}/complete", response_model=ReservaDelPrestadorRead)
async def terminar(
    booking_id: str,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ReservaDelPrestadorRead:
    """Marca la atención como realizada. No la cierra ni libera nada."""
    await dominio.terminar(db, usuario_id=current_user.id, reserva_id=booking_id, clave=clave)
    await db.commit()
    return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=PRESTADOR)


@router.post("/provider/bookings/{booking_id}/review/reply", response_model=ReservaDelPrestadorRead)
async def responder_resena(
    booking_id: str,
    cuerpo: ResponderResena,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ReservaDelPrestadorRead:
    """La respuesta pública del prestador a la reseña. Una."""
    await posventa.responder_resena(db, usuario_id=current_user.id, reserva_id=booking_id, texto=cuerpo.reply,
                                    clave=clave)
    await db.commit()
    return await _detalle(db, usuario_id=current_user.id, reserva_id=booking_id, rol=PRESTADOR)


# =========================================================================== #
# Lo público: las reseñas de un servicio
# =========================================================================== #
@router.get("/catalog/{service_id}/reviews", response_model=PaginaDeResenasRead)
async def resenas_del_servicio(
    service_id: str,
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=limites.RESERVAS_POR_PAGINA, ge=1, le=limites.RESERVAS_MAXIMAS_POR_PAGINA),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeResenasRead:
    """Las reseñas PUBLICADAS de un servicio público y su resumen. Sin
    reseñas, el promedio es `null`, no cero. Sin la 0094 o con la contratación
    apagada no hay reseñas que enseñar (`available: false`), y la ficha sigue."""
    await esquema.exigir_agenda(db)
    if not esquema.reserva_encendida() or not await esquema.hay_atencion(db):
        return PaginaDeResenasRead(available=False, items=[], next_cursor=None, summary=None)
    pagina = await posventa.resenas_publicas(
        db, service_id, mira=current_user.id if current_user else None, cursor=cursor, limite=limit
    )
    r = pagina.resumen
    return PaginaDeResenasRead(
        available=True, items=[ResenaRead.desde(x) for x in pagina.resenas], next_cursor=pagina.siguiente,
        summary=ResumenDeResenasRead(total=r.total, average=r.promedio, recommend_bps=r.recomiendan_bps,
                                     by_axis=r.por_eje),
    )


# =========================================================================== #
# Administración
# =========================================================================== #
@admin_router.get("/incidents", response_model=PaginaDeCasosRead)
async def casos(
    status_: str | None = Query(default=None, alias="status",
                                pattern=r"^(open|resolved|appealed|closed|withdrawn)$"),
    with_financial_effect: bool = Query(default=False),
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=limites.RESERVAS_POR_PAGINA, ge=1, le=limites.RESERVAS_MAXIMAS_POR_PAGINA),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeCasosRead:
    """La bandeja de casos. Con `with_financial_effect`, solo los que tienen
    un efecto económico SOLICITADO: es de lectura, aquí no se ejecuta nada."""
    pagina = await posventa.casos(db, estado=status_, con_efecto=with_financial_effect, cursor=cursor, limite=limit)
    return PaginaDeCasosRead(items=[CasoAdminRead.desde(c, r) for c, r in pagina.casos],
                             next_cursor=pagina.siguiente)


@admin_router.get("/incidents/{incident_id}", response_model=ExpedienteAdminRead)
async def caso(
    incident_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteAdminRead:
    """El expediente entero, con lo que quien mira puede hacer ahora. Quien
    es parte de esa reserva no lo abre por aquí (409)."""
    return ExpedienteAdminRead.del_expediente(
        await posventa.expediente_para_administrar(db, incident_id, admin_id=current_user.id),
        usuario_id=current_user.id,
    )


@admin_router.post("/incidents/{incident_id}/entries", response_model=ExpedienteAdminRead,
                   status_code=status.HTTP_201_CREATED)
async def anotar(
    incident_id: str,
    cuerpo: EscribirDesdeAdministracion,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteAdminRead:
    """Un mensaje a las partes, o una NOTA INTERNA que no sale de aquí."""
    await posventa.anotar_desde_administracion(db, admin_id=current_user.id, caso_id=incident_id,
                                               texto=cuerpo.body, interna=cuerpo.internal, clave=clave)
    await db.commit()
    return ExpedienteAdminRead.del_expediente(
        await posventa.expediente_para_administrar(db, incident_id, admin_id=current_user.id),
        usuario_id=current_user.id,
    )


@admin_router.get("/incidents/{incident_id}/entries/{entry_id}/file", response_model=EnlaceRead)
async def enlace_para_administrar(
    incident_id: str,
    entry_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> EnlaceRead:
    x = await posventa.expediente_para_administrar(db, incident_id, admin_id=current_user.id)
    entrada = next((e for e in x.entradas if e.id == entry_id), None)
    if entrada is None:
        raise posventa.CasoNoEncontrado()
    return EnlaceRead(url=await posventa.enlace_de(entrada), expires_in=posventa.SEGUNDOS_DE_LA_FIRMA)


@admin_router.post("/incidents/{incident_id}/resolve", response_model=ExpedienteAdminRead)
async def resolver(
    incident_id: str,
    cuerpo: ResolverCaso,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteAdminRead:
    """LA RESOLUCIÓN: qué se decidió, su efecto en la atención y el efecto
    económico SOLICITADO con su estado. NO MUEVE DINERO. Quien es parte no
    resuelve, y una apelación la resuelve otra persona."""
    await posventa.resolver(
        db, admin_id=current_user.id, caso_id=incident_id, resultado=cuerpo.outcome, texto=cuerpo.resolution,
        efecto_en_la_atencion=cuerpo.attention_effect, efecto_economico=cuerpo.financial_effect,
        nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return ExpedienteAdminRead.del_expediente(
        await posventa.expediente_para_administrar(db, incident_id, admin_id=current_user.id),
        usuario_id=current_user.id,
    )


@admin_router.get("/reviews", response_model=PaginaDeResenasAdminRead)
async def resenas_para_moderar(
    status_: str | None = Query(default=None, alias="status", pattern=r"^(pending|published|hidden)$"),
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=limites.RESERVAS_POR_PAGINA, ge=1, le=limites.RESERVAS_MAXIMAS_POR_PAGINA),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeResenasAdminRead:
    pagina = await posventa.resenas_para_moderar(db, estado=status_, cursor=cursor, limite=limit)
    return PaginaDeResenasAdminRead(items=[ResenaAdminRead.de_moderacion(r) for r in pagina.resenas],
                                    next_cursor=pagina.siguiente)


@admin_router.post("/reviews/{review_id}/moderate", response_model=ResenaAdminRead)
async def moderar(
    review_id: str,
    cuerpo: ModerarResena,
    clave: str | None = Depends(_clave),
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> ResenaAdminRead:
    """Publica o esconde una reseña. No la borra ni la reescribe. NO MUEVE DINERO."""
    resena = await posventa.moderar(db, admin_id=current_user.id, resena_id=review_id, accion=cuerpo.action,
                                    motivo=cuerpo.reason, clave=clave)
    await db.commit()
    await db.refresh(resena)
    return ResenaAdminRead.de_moderacion(resena)


@admin_router.post("/tasks/run", response_model=TareasRead)
async def tareas(
    batch: int = Query(default=limites.LOTE_DE_TAREAS, ge=1, le=limites.LOTE_MAXIMO_DE_TAREAS),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(atencion_disponible),
    db: AsyncSession = Depends(get_db),
) -> TareasRead:
    """LOS BARRIDOS, por lotes e idempotentes: recordar lo que empieza pronto y
    cerrar las atenciones terminadas cuyo plazo pasó (solo con la señal
    fuerte y sin un caso). Lo llamará un planificador externo que todavía no
    existe (decisión de la empresa). NO MUEVE DINERO."""
    hecho = await dominio.tareas(db, lote=batch)
    await db.commit()
    return TareasRead(reminded=hecho.recordadas, closed=hecho.cerradas, unverified=hecho.sin_verificar,
                      skipped=hecho.saltadas)


__all__ = ["admin_router", "router"]
