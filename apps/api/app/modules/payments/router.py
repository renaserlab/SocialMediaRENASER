"""Portal de pagos de los cursos.

**Estado: construido y APAGADO por defecto.** `PAYMENTS_ENABLED` es el
interruptor general; encima hay uno por proveedor
(`REVENUECAT_VERIFICATION_ENABLED`, `STRIPE_PAYMENTS_ENABLED`). Mientras estén
en `false` los endpoints responden 503 en vez de simular un cobro.

## Dónde se cobra cada cosa

Decisión de negocio, ya tomada:

- **Móvil (Android/iOS)** → compras integradas de Google Play y la App Store, a
  través de RevenueCat. Es lo que exigen las dos tiendas para contenido digital
  que se consume dentro de la app. Vender por fuera es el motivo de rechazo de
  la directriz 3.1.1 de Apple, no una optimización de comisión.
- **Web** → Stripe Checkout alojado.

**Stripe nunca aparece en el flujo nativo de compra de cursos**, y RevenueCat
nunca se exige en la web. Las dos rutas comparten una sola implementación de
«conceder» (`service.py`) para que no puedan divergir.

La compra es **única y permanente**: no hay suscripción, ni plan mensual, ni
`Z Pro`. `entitlements.expires_at` se queda a nulo.

## Los dos flujos que conviven

El de esta primera parte del fichero es el ANTIGUO, sobre la tabla `purchases`.
El de la segunda es el del dominio comercial de la migración 0035
(`orders`, `entitlements`, `payment_events`...). Conviven mientras dura el
trasvase que hace la 0036: quien ya tenía acceso lo conserva.

## Reglas que sostienen el dinero

1. **El importe se lee del curso en el servidor**, nunca del cliente. Si
   viniera de fuera, cualquiera compraría un curso de 300 por 1.
2. **Solo el webhook marca `paid`.** Que el cliente vuelva del navegador no
   prueba nada: puede volver sin haber pagado, o no volver habiendo pagado.
3. **El webhook verifica la firma.** Sin eso, quien descubra la URL se regala
   los cursos que quiera.
4. **El webhook es idempotente.** Las pasarelas reintentan; el `unique
   (provider, provider_transaction_id)` de la tabla evita cobrar o conceder dos
   veces por el mismo aviso.
"""

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.logging import get_logger
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Course
from app.modules.learning.models import Purchase
from app.modules.catalog import esquema as esquema_catalogo
from app.modules.commerce import esquema as esquema_comercio
from app.modules.commerce import service as comercio_service
from app.modules.events import pagos as eventos_pagos
from app.modules.payments import nativo, service
from app.modules.payments.providers import CheckoutRequest, get_provider
from app.modules.payments.revenuecat import RevenueCatClient, RevenueCatError
from app.modules.payments.schemas import (
    CheckoutCreate,
    CheckoutRead,
    CourseAccessRead,
    EstadoDeOrdenRead,
    NativeSyncCreate,
    NativeSyncRead,
    PurchaseHistoryRead,
    PurchaseRead,
    StoreProductRead,
)
from app.modules.payments.stripe_provider import (
    StripeConfigError,
    StripeSignatureError,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin

logger = get_logger(__name__)

router = APIRouter(prefix="/payments", tags=["payments"])

#: Pasarela por defecto. 'web' es la que evita la comisión de las tiendas.
DEFAULT_PROVIDER = "web"


def _require_enabled() -> None:
    """Corta si los pagos no están configurados todavía.

    Se responde 503 y no 404 a propósito: el endpoint existe, lo que falta es la
    pasarela. Un 404 haría pensar que la ruta está mal escrita.
    """
    settings = get_settings()
    if not settings.payments_enabled:
        raise ServiceUnavailableError("El portal de pagos aún no está disponible.")


@router.post("/checkout", response_model=CheckoutRead)
async def create_checkout(
    payload: CheckoutCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CheckoutRead:
    """Inicia la compra de un curso y devuelve a dónde pagar."""
    _require_enabled()

    course_id = ensure_uuid(payload.course_id, "course_id")
    course = await db.get(Course, course_id)
    if course is None or course.status != "published":
        raise NotFoundError("Curso no encontrado.")

    if course.price_minor <= 0:
        raise ValidationAppError("Este curso es gratuito; no requiere compra.")

    # Ya comprado: no se cobra dos veces.
    already = await db.scalar(
        select(Purchase).where(
            Purchase.user_id == current_user.id,
            Purchase.course_id == course_id,
            Purchase.status == "paid",
        )
    )
    if already is not None:
        raise ConflictError("Ya tienes acceso a este curso.")

    provider = get_provider(DEFAULT_PROVIDER)
    if provider is None:
        raise ServiceUnavailableError("Pasarela de pago no disponible.")

    # Se reutiliza un intento pendiente en vez de acumular filas muertas cada
    # vez que alguien abre el checkout y se lo piensa.
    purchase = await db.scalar(
        select(Purchase).where(
            Purchase.user_id == current_user.id,
            Purchase.course_id == course_id,
            Purchase.status == "pending",
        )
    )
    if purchase is None:
        purchase = Purchase(
            user_id=current_user.id,
            course_id=course_id,
            provider=provider.name,
            # El importe se congela AQUI, en el servidor. Si el precio del curso
            # sube mientras alguien esta pagando, paga lo que se le mostro.
            amount_minor=course.price_minor,
            currency=course.currency,
            status="pending",
        )
        db.add(purchase)
        await db.commit()
        await db.refresh(purchase)

    settings = get_settings()
    session = await provider.create_checkout(
        CheckoutRequest(
            purchase_id=purchase.id,
            concepto=course.title,
            amount_minor=purchase.amount_minor,
            currency=purchase.currency,
            user_email=current_user.email or "",
            return_url=f"{settings.payments_return_url}?purchase={purchase.id}",
        )
    )

    return CheckoutRead(
        purchase_id=purchase.id,
        checkout_url=session.checkout_url,
        amount_minor=purchase.amount_minor,
        currency=purchase.currency,
    )


@router.post("/webhook/{provider_name}", status_code=status.HTTP_204_NO_CONTENT)
async def payment_webhook(
    provider_name: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Aviso de la pasarela. **Es lo único que concede el acceso.**

    No lleva autenticación de usuario a propósito: quien llama es la pasarela,
    no una persona. La autenticidad se comprueba con la firma del propio aviso.
    """
    # Stripe va por el flujo NUEVO (dominio comercial de la 0035), no por la
    # tabla `purchases`. Se delega aquí en vez de declarar `/webhook/stripe`
    # como ruta aparte porque Starlette resuelve por orden de registro y
    # `/webhook/{provider_name}` ya está declarado más arriba: una ruta literal
    # añadida después nunca llegaría a coincidir.
    if provider_name == "stripe":
        return await procesar_webhook_stripe(request, db)

    _require_enabled()

    provider = get_provider(provider_name)
    if provider is None:
        raise NotFoundError("Pasarela desconocida.")

    body = await request.body()
    try:
        event = provider.verify_and_parse(body=body, headers=dict(request.headers))
    except NotImplementedError:
        raise
    except Exception:
        # Firma inválida: se registra y se rechaza. NO se detalla el motivo en
        # la respuesta, para no ayudar a quien esté probando a falsificarla.
        logger.warning("[pagos] aviso rechazado: firma no válida", exc_info=True)
        raise ValidationAppError("Aviso no válido.")

    purchase = await db.get(Purchase, event.purchase_id)
    if purchase is None:
        # Se responde 204 igualmente: si se devuelve un error, la pasarela
        # reintenta en bucle un aviso que nunca va a cuadrar.
        logger.warning("[pagos] aviso de una compra inexistente: %s", event.purchase_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # Idempotencia: las pasarelas reintentan. Si ya está pagada, no se toca.
    if purchase.status == "paid":
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    if event.status == "paid":
        # Comprobacion de importe: si no coincide con lo que se guardo, algo va
        # mal (precio manipulado, moneda distinta) y NO se concede el acceso.
        if event.amount_minor != purchase.amount_minor:
            logger.error(
                "[pagos] importe distinto en la compra %s: esperado %s, recibido %s",
                purchase.id,
                purchase.amount_minor,
                event.amount_minor,
            )
            raise ValidationAppError("El importe no coincide.")
        purchase.status = "paid"
        purchase.provider_transaction_id = event.provider_transaction_id
    elif event.status in {"cancelled", "refunded"}:
        purchase.status = event.status
        purchase.provider_transaction_id = event.provider_transaction_id
    else:
        # Un estado intermedio que no nos interesa; no es un error.
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=list[PurchaseRead])
async def my_purchases(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Purchase]:
    """Compras de quien pregunta. Funciona aunque los pagos estén apagados."""
    result = await db.execute(
        select(Purchase)
        .where(Purchase.user_id == current_user.id)
        .order_by(Purchase.purchased_at.desc())
    )
    return list(result.scalars().all())


async def _curso_de_la_orden(db: AsyncSession, orden) -> str | None:
    """El curso al que apunta una orden, a través de su producto de comercio."""
    from app.modules.commerce.models import CommerceProduct

    producto = await db.get(CommerceProduct, orden.commerce_product_id)
    return str(producto.course_id) if producto is not None else None


@router.get("/orders/{order_id}", response_model=EstadoDeOrdenRead)
async def estado_de_la_orden(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EstadoDeOrdenRead:
    """En qué quedó una orden. Es lo que mira la pantalla de vuelta del pago.

    LA PANTALLA NO PUEDE CREERSE LA URL. Al volver de la pasarela, el navegador
    trae `?order=<id>` y nada más: ese parámetro lo escribe cualquiera, y
    conceder acceso —o simplemente decir «pago confirmado»— a partir de él sería
    dejar que quien pide decida si ha pagado. Aquí se le pregunta al servidor.

    Y SE DEVUELVE EL ACCESO APARTE DEL ESTADO. Una orden puede estar `paid` con
    el acceso todavía sin conceder, porque quien lo concede es el aviso de la
    pasarela y aún no ha llegado. Son segundos, pero son exactamente los
    segundos en los que la persona está mirando la pantalla.

    404 SI NO ES SUYA, y no 403: responder «prohibido» confirmaría que esa orden
    existe, y con eso se puede recorrer el espacio de identificadores para saber
    qué órdenes hay. Que una orden ajena y una inexistente se vean igual desde
    fuera es lo correcto.
    """
    from app.modules.commerce.models import Order

    oid = ensure_uuid(order_id, "order_id")
    orden = await db.get(Order, oid)
    if orden is None or orden.user_id != current_user.id:
        raise NotFoundError("Orden no encontrada.")

    curso = await _curso_de_la_orden(db, orden)
    acceso = False
    if curso is not None and await esquema_comercio.hay_comercio(db):
        resuelto = await comercio_service.resolver_acceso_al_curso(
            db, user_id=current_user.id, course_id=curso, es_admin=False
        )
        acceso = resuelto.tiene_acceso

    titulo = ""
    version = None
    if curso:
        ficha = await db.get(Course, curso)
        titulo = ficha.title if ficha else ""
        version = await _numero_de_version(db, orden.course_version_id)

    return EstadoDeOrdenRead(
        id=str(orden.id),
        course_id=curso or "",
        course_title=titulo,
        status=orden.status,
        amount_minor=orden.amount_minor,
        currency=orden.currency,
        has_access=acceso,
        created_at=orden.created_at,
        paid_at=orden.paid_at,
        provider=orden.provider or "",
        course_version=version,
        guarantee_hours=orden.guarantee_hours,
        repurchase_without_guarantee=await _fue_recompra_sin_garantia(db, orden.id),
    )


async def _numero_de_version(db: AsyncSession, version_id: str | None) -> int | None:
    if version_id is None:
        return None
    from app.modules.catalog.models import CourseVersion

    fila = await db.get(CourseVersion, version_id)
    return fila.version if fila else None


async def _fue_recompra_sin_garantia(db: AsyncSession, order_id: str) -> bool:
    """Si esta compra se hizo firmando que no tendria garantia."""
    from app.modules.refunds import esquema as esquema_devoluciones

    if not await esquema_devoluciones.hay_devoluciones(db):
        return False
    from app.modules.refunds.models import RefundPolicyAcceptance

    return bool(
        await db.scalar(
            select(RefundPolicyAcceptance.id)
            .where(RefundPolicyAcceptance.order_id == order_id)
            .limit(1)
        )
    )


@router.get("/courses/{course_id}/access", response_model=CourseAccessRead)
async def course_access(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseAccessRead:
    """Si esta persona puede ver el contenido del curso, y por qué.

    La app lo usa para decidir qué mostrar. **No es la seguridad**: quien manda
    es la RLS (`has_course_access`, migración 0016), que protege los archivos
    aunque alguien llame directamente al almacenamiento.
    """
    cid = ensure_uuid(course_id, "course_id")
    course = await db.get(Course, cid)
    if course is None:
        raise NotFoundError("Curso no encontrado.")

    # Con la 0035/0036 aplicadas, quien decide es el comercio: derecho activo,
    # o —mientras dure el trasvase— la fila heredada de `purchases`. Se delega
    # en vez de repetir aquí las reglas porque tener DOS respuestas a la misma
    # pregunta ya costó un fallo: este endpoint decía "sin_acceso" sobre cursos
    # que `has_course_access()` sí dejaba ver, y la pantalla creía a la
    # equivocada.
    if await esquema_comercio.hay_comercio(db):
        acceso = await comercio_service.resolver_acceso_al_curso(
            db,
            user_id=current_user.id,
            course_id=cid,
            es_admin=await is_admin(db, current_user.id),
        )
        return CourseAccessRead(
            course_id=cid,
            has_access=acceso.tiene_acceso,
            reason=_motivo_publico(acceso.motivo),
        )

    # Sin la migración, exactamente lo de siempre. Desplegar este código no
    # puede exigir que la 0035 ya esté puesta.
    if course.price_minor <= 0:
        return CourseAccessRead(course_id=cid, has_access=True, reason="gratuito")

    if course.author_id == current_user.id:
        return CourseAccessRead(course_id=cid, has_access=True, reason="autor")

    # El rol de la aplicación vive en `profiles.role`, NO en el token: en el JWT
    # de Supabase `role` vale siempre "authenticated". Esto preguntaba por un
    # `current_user.is_admin` que `AuthUser` NUNCA ha tenido, y el `getattr` con
    # valor por defecto lo tapaba: la rama no se cumplía jamás, así que a la
    # administración este endpoint le decía "sin_acceso" sobre un curso de pago
    # que la base de datos —`has_course_access()`, migración 0016— y
    # `/learning/courses/{id}` sí le dejan ver. Dos respuestas distintas a la
    # misma pregunta, y la pantalla se creía la equivocada.
    if await is_admin(db, current_user.id):
        return CourseAccessRead(course_id=cid, has_access=True, reason="administracion")

    paid = await db.scalar(
        select(Purchase).where(
            Purchase.user_id == current_user.id,
            Purchase.course_id == cid,
            Purchase.status == "paid",
        )
    )
    if paid is not None:
        return CourseAccessRead(course_id=cid, has_access=True, reason="comprado")

    return CourseAccessRead(course_id=cid, has_access=False, reason="sin_acceso")


# ===========================================================================
# Dominio comercial (migración 0035): compra nativa y Stripe web
# ===========================================================================
#
# Todo lo de aquí abajo está APAGADO por defecto. `PAYMENTS_ENABLED` es el
# interruptor general, y encima hay uno por proveedor: encender el cobro por
# Stripe no puede encender de rebote la concesión de acceso desde las tiendas,
# ni al revés.


def _proveedores_para(platform: str, entorno: str) -> list[str]:
    """Qué proveedores valen en cada plataforma, en orden de preferencia.

    El Test Store SOLO existe fuera de producción: si apareciera una fila suya
    en la base real seguiría sin ofrecerse, porque una compra de juguete no
    puede abrir un curso de verdad.
    """
    pruebas = [] if entorno == "production" else ["revenuecat_test"]
    if platform == "android":
        return ["google", *pruebas]
    if platform == "ios":
        return ["apple", *pruebas]
    if platform == "web":
        return ["stripe"]
    return []


async def _require_comercio(db: AsyncSession) -> None:
    """503 si la migración 0035 todavía no está aplicada en esta base.

    Desplegar este código no puede exigir que la migración ya esté puesta. Sin
    ella no hay dónde apuntar una compra, así que se dice que el servicio no
    está disponible en vez de reventar con un 500 que además, al no llevar
    cabeceras CORS, en el navegador aparece como un error de red.
    """
    if not await esquema_comercio.hay_comercio(db):
        raise ServiceUnavailableError("El módulo de compras aún no está desplegado.")


async def _curso_vendible(db: AsyncSession, course: Course) -> str:
    """Vacío si se puede vender; si no, el motivo.

    Publicado Y aprobado. La revisión editorial es la columna `review_status`
    que añade la 0034; mientras esa migración no esté, se exige lo único que
    existe, que es que el curso esté publicado. Comprobar una columna que no
    hay dejaría los pagos rotos hasta que la aplicaran.
    """
    if course.status != "published":
        return "no_publicado"
    if await esquema_catalogo.hay_cursos_v2(db):
        estado = await db.scalar(
            text("select review_status from courses where id = :id").bindparams(
                id=course.id
            )
        )
        if estado is not None and estado != "approved":
            return "no_aprobado"
    return ""


#: Del vocabulario INTERNO del comercio al que ya publica esta API.
#:
#: `reason` es contrato público: lo consume `PaymentRepository.CourseAccess` en
#: el móvil, que documenta cinco valores. El comercio distingue además si el
#: acceso se sostiene en un derecho (`entitlement`) o en la fila heredada de
#: `purchases` (`compra_heredada`), y esa distinción le importa a ÉL —para
#: saber qué cerrar al reembolsar— pero no a la pantalla: para quien mira, las
#: dos cosas significan «lo compraste». Traducir aquí mantiene estable lo que
#: ya usa la aplicación en vez de renombrar un valor publicado, que rompería
#: una pantalla ajena sin avisar. Cuando termine el trasvase de la 0036,
#: `compra_heredada` desaparece y esta tabla se queda en una línea.
_MOTIVOS_PUBLICOS = {
    comercio_service.ENTITLEMENT: "comprado",
    comercio_service.COMPRA_HEREDADA: "comprado",
}


def _motivo_publico(motivo: str) -> str:
    return _MOTIVOS_PUBLICOS.get(motivo, motivo)


@router.get("/courses/{course_id}/product", response_model=StoreProductRead)
async def course_product(
    course_id: str,
    platform: str = "web",
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StoreProductRead:
    """Qué se puede comprar para este curso desde esta plataforma.

    Existe para que la pantalla NUNCA pinte un botón muerto. Un curso puede
    estar dado de alta en Google y todavía no en Apple, y eso hay que poder
    decirlo con palabras. La respuesta lleva siempre `reason` cuando no se
    puede comprar, para que la interfaz explique el motivo en vez de callarse.
    """
    ajustes = get_settings()
    cid = ensure_uuid(course_id, "course_id")
    course = await db.get(Course, cid)
    if course is None:
        raise NotFoundError("Curso no encontrado.")

    plataforma = platform if platform in {"ios", "android", "web"} else "web"
    base = StoreProductRead(
        course_id=cid,
        platform=plataforma,
        available=False,
        price_minor=course.price_minor,
        currency=course.currency,
    )

    if course.price_minor <= 0:
        return base.model_copy(update={"reason": "gratuito"})
    if not ajustes.payments_enabled:
        return base.model_copy(update={"reason": "pagos_apagados"})
    motivo = await _curso_vendible(db, course)
    if motivo:
        return base.model_copy(update={"reason": motivo})
    if not await esquema_comercio.hay_comercio(db):
        return base.model_copy(update={"reason": "pagos_apagados"})

    entorno = ajustes.payments_environment
    for proveedor in _proveedores_para(plataforma, entorno):
        producto = await service.producto_para_curso(
            db, course_id=cid, provider=proveedor, environment=entorno
        )
        if producto is None:
            continue
        if await service.tiene_entitlement(
            db,
            user_id=current_user.id,
            commerce_product_id=producto.commerce_product_id,
        ):
            return base.model_copy(
                update={
                    "reason": "ya_comprado",
                    "provider": proveedor,
                    "product_id": producto.external_product_id,
                }
            )
        return base.model_copy(
            update={
                "available": True,
                "provider": proveedor,
                "product_id": producto.external_product_id,
            }
        )
    # Sin producto configurado para esta plataforma. NO es un error: es una
    # respuesta, y la pantalla tiene que saber decirla.
    return base.model_copy(update={"reason": "sin_producto"})


@router.post("/native/sync", response_model=NativeSyncRead)
async def native_sync(
    payload: NativeSyncCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NativeSyncRead:
    """Reconcilia las compras de las tiendas contra RevenueCat.

    **Un «éxito» del cliente no concede nada.** Esta petición es un disparador:
    la identidad sale del JWT y todo lo demás —qué se compró, cuándo, si se
    devolvió— se le pregunta a RevenueCat servidor a servidor con la clave
    secreta. Da igual lo que mande el teléfono.

    Se llama tras comprar, al restaurar compras y al iniciar sesión. **No se
    llama en cada petición de vídeo**: lo que concede acceso es `entitlements`,
    que queda persistido aquí.
    """
    ajustes = get_settings()
    _require_enabled()
    if not ajustes.revenuecat_verification_enabled:
        raise ServiceUnavailableError(
            "La verificación de compras de tienda aún no está activada."
        )
    await _require_comercio(db)

    try:
        cliente = RevenueCatClient(
            secret_api_key=ajustes.revenuecat_secret_api_key,
            project_id=ajustes.revenuecat_project_id,
            base_url=ajustes.revenuecat_api_base,
        )
        resultado = await nativo.sincronizar(
            db,
            user_id=current_user.id,
            cliente=cliente,
            entorno=ajustes.payments_environment,
            canal_declarado=payload.platform,
        )
    except RevenueCatError as error:
        # Un fallo del proveedor NO revoca nada y NO se disfraza de éxito. Si
        # se devolviera una respuesta vacía, la aplicación pensaría que esa
        # persona no ha comprado nunca.
        logger.warning("[pagos] no se pudo sincronizar con RevenueCat: %s", error)
        raise ServiceUnavailableError(
            "No se pudo comprobar tus compras ahora mismo. Inténtalo de nuevo."
        ) from error

    return NativeSyncRead(
        granted=resultado.concedidos,
        revoked=resultado.revocados,
        unchanged=resultado.sin_cambios,
        unknown_products=resultado.desconocidos,
    )


@router.post("/stripe/checkout", response_model=CheckoutRead)
async def stripe_checkout(
    payload: CheckoutCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CheckoutRead:
    """Abre un Checkout alojado de Stripe. **Solo web.**

    El importe se lee del curso EN EL SERVIDOR. El cuerpo de la petición sigue
    llevando únicamente `course_id`: si aceptara un importe, cualquiera
    compraría un curso de 300 por 1.
    """
    ajustes = get_settings()
    _require_enabled()
    if not ajustes.stripe_payments_enabled:
        raise ServiceUnavailableError("El cobro por tarjeta aún no está disponible.")
    await _require_comercio(db)

    cid = ensure_uuid(payload.course_id, "course_id")
    course = await db.get(Course, cid)
    if course is None:
        raise NotFoundError("Curso no encontrado.")
    if course.price_minor <= 0:
        raise ValidationAppError("Este curso es gratuito; no requiere compra.")
    if await _curso_vendible(db, course):
        raise ValidationAppError("Este curso todavía no está a la venta.")

    entorno = ajustes.payments_environment
    producto = await service.producto_para_curso(
        db, course_id=cid, provider="stripe", environment=entorno
    )
    if producto is None:
        raise ServiceUnavailableError(
            "Este curso no está disponible para comprar por la web."
        )
    if await service.tiene_entitlement(
        db, user_id=current_user.id, commerce_product_id=producto.commerce_product_id
    ):
        # No se cobra dos veces a quien ya tiene acceso.
        raise ConflictError("Ya tienes acceso a este curso.")

    # RECOMPRA SIN GARANTIA: hay que haberlo aceptado ANTES de cobrar.
    #
    # Quien ya uso su garantia en este curso puede volver a comprarlo, pero esa
    # compra no admite otra devolucion. Enseñarselo despues de cobrar seria
    # cobrarle sin haberle dicho lo que compra. El aviso lo sirve
    # `/payments/courses/{id}/repurchase-notice` y la aceptacion se guarda con
    # la huella del texto exacto que se mostro.
    await _exigir_aceptacion_de_recompra(db, user_id=current_user.id, course_id=cid)

    # El importe lo pone el comercio leyendo el curso: `crear_orden` NI SIQUIERA
    # acepta un parámetro de importe, así que no hay forma de que llegue uno del
    # cliente ni por descuido ni por un parámetro que alguien añada mañana.
    pedido = await service.crear_pedido_pendiente(
        db, user_id=current_user.id, producto=producto, canal="web"
    )
    # La aceptacion se ato a la orden que acaba de nacer: sin esto quedaria
    # suelta y no se podria responder «que acepto exactamente quien compro
    # ESTA orden».
    await _atar_aceptacion(db, user_id=current_user.id, course_id=cid, order_id=pedido.id)
    # El comercio hace `flush`, nunca `commit`: el commit es de quien llama.
    await db.commit()

    proveedor = get_provider("stripe")
    if proveedor is None:  # pragma: no cover - registrado en providers.py
        raise ServiceUnavailableError("Pasarela de pago no disponible.")
    try:
        sesion = await proveedor.create_checkout(
            CheckoutRequest(
                purchase_id=pedido.id,
                concepto=course.title,
                # Del PEDIDO, no del curso: es el importe que se congeló en el
                # servidor al abrirlo. Si el precio del curso cambia mientras
                # alguien está pagando, paga lo que se le enseñó.
                amount_minor=pedido.amount_minor,
                currency=pedido.currency,
                user_email=current_user.email or "",
                return_url=f"{ajustes.payments_return_url}?order={pedido.id}",
                cancel_url=f"{ajustes.payments_cancel_url}?order={pedido.id}",
                metadata={
                    "order_id": pedido.id,
                    "user_id": current_user.id,
                    "course_id": cid,
                    "commerce_product_id": producto.commerce_product_id,
                },
            )
        )
    except StripeConfigError as error:
        logger.error("[pagos] Stripe no pudo abrir el checkout: %s", error)
        raise ServiceUnavailableError("No se pudo abrir el pago. Inténtalo de nuevo.")

    return CheckoutRead(
        purchase_id=pedido.id,
        checkout_url=sesion.checkout_url,
        amount_minor=pedido.amount_minor,
        currency=pedido.currency,
    )


async def procesar_webhook_stripe(request: Request, db: AsyncSession) -> Response:
    """Aviso de Stripe. Verifica la firma SIEMPRE y es idempotente.

    Responde 204 casi siempre a propósito. Un error hace que Stripe reintente
    en bucle, y hay avisos que nunca van a cuadrar —un pedido que no existe, un
    evento que no nos incumbe— y reintentarlos no arregla nada. Lo único que se
    rechaza con error es una firma inválida: eso sí hay que verlo.
    """
    ajustes = get_settings()
    # LA BANDERA DE COMPRAS NO PUEDE BLOQUEAR LAS DEVOLUCIONES. Apagar
    # `stripe_payments_enabled` significa «no se venden cosas nuevas», no «el
    # dinero que ya cobramos se queda aqui». Si el corte se hiciera arriba, un
    # `charge.refunded` de una compra anterior se rechazaria con un 503, Stripe
    # reintentaria en bucle y el acceso no se retiraria nunca. La comprobacion
    # baja hasta despues de verificar la firma, que es cuando se sabe si el
    # aviso es una compra o una devolucion.
    proveedor = get_provider("stripe")
    if proveedor is None:  # pragma: no cover
        raise NotFoundError("Pasarela desconocida.")

    body = await request.body()
    try:
        evento = proveedor.verify_and_parse(body=body, headers=dict(request.headers))
    except (StripeSignatureError, StripeConfigError):
        # No se detalla el motivo en la respuesta: ayudaría a quien esté
        # probando a falsificarla.
        logger.warning("[pagos] aviso de Stripe rechazado", exc_info=True)
        raise ValidationAppError("Aviso no válido.")

    # LOS AVISOS DE ENTRADAS SE ENTREGAN A EVENTOS, y antes de la bandera de
    # Cursos: `stripe_payments_enabled` gobierna la compra de un CURSO y no
    # tiene nada que decir sobre una entrada. El dominio sale de la metadata que
    # nosotros adjuntamos al abrir el cobro, no de un campo que Stripe rellene.
    #
    # Y SI NO VIENE EL DOMINIO, SE PREGUNTA A NUESTRAS TABLAS. Un `refund.*` o
    # un `charge.dispute.*` traen el objeto reembolso o disputa, con metadata
    # propia —vacia— en vez de la del cobro: sin esta segunda pregunta, la
    # devolucion de una entrada caia aqui como si fuera de Cursos.
    if evento.dominio == eventos_pagos.DOMINIO or await eventos_pagos.es_de_entradas(
        db, evento
    ):
        return await _webhook_de_eventos(db, evento)

    if not ajustes.stripe_payments_enabled and evento.status not in _ESTADOS_DE_DEVOLUCION:
        # Firma valida, pero es un aviso de COMPRA y las compras estan
        # apagadas. Sigue bloqueado, igual que antes.
        raise ServiceUnavailableError("El cobro por tarjeta no está activado.")

    if not await esquema_comercio.hay_comercio(db):
        logger.error("[pagos] llega un aviso de Stripe sin la migración 0035 aplicada")
        raise ServiceUnavailableError("El módulo de compras aún no está desplegado.")

    if evento.environment != ajustes.payments_environment:
        # Un aviso de pruebas no concede nada en producción, ni al revés.
        logger.info("[pagos] aviso de Stripe de otro entorno: %s", evento.environment)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # El aviso se guarda EN CRUDO antes de interpretarlo. `es_nuevo=False`
    # significa repetición: Stripe reintenta, y ahí se para. La barrera es el
    # índice único `(provider, external_event_id)`, no un `if` nuestro: dos
    # avisos simultáneos pasarían los dos por un `if`, por el índice no.
    _fila, es_nuevo = await comercio_service.registrar_evento(
        db,
        provider="stripe",
        external_event_id=evento.event_id,
        event_type=evento.event_type,
        environment=evento.environment,
        payload=dict(evento.payload),
    )
    if not es_nuevo:
        # Ya procesado. Diez avisos iguales, un entitlement y una compra.
        await db.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # EL IDENTIFICADOR, EN UNA VARIABLE, ANTES DE TOCAR NADA. `_fila` es un
    # objeto del ORM: en cuanto la transacción se deshace queda caducado, y
    # leerle un atributo dispara una recarga perezosa que en asíncrono revienta
    # con `MissingGreenlet`. Una cadena no caduca.
    id_del_aviso = _fila.id

    try:
        # SAVEPOINT, NO `rollback`. Antes esto se aplicaba suelto y el manejador
        # de error deshacía la transacción entera; el problema es que la fila de
        # `payment_events` se escribió en ESA misma transacción y todavía no
        # estaba confirmada, así que el `rollback` se llevaba por delante justo
        # el registro anti-repetición que el bloque de abajo existe para
        # garantizar. Y el `UPDATE` posterior no encontraba ninguna fila que
        # marcar.
        #
        # Con el savepoint, un fallo deshace SOLO lo que intentó aplicarse: la
        # fila del aviso sigue en pie, la transacción de fuera sigue utilizable
        # —que es lo que en PostgreSQL no ocurre tras una sentencia fallida sin
        # aislar— y el error queda anotado y confirmado.
        async with db.begin_nested():
            await _aplicar_evento_stripe(db, evento)
    except Exception as error:
        # El aviso queda marcado con su error para poder reprocesarlo a mano.
        # Se deja constancia ANTES de propagar: si se pierde el registro del
        # fallo, nadie sabrá que hubo un cobro que no llegó a conceder nada.
        logger.exception("[pagos] no se pudo aplicar el aviso %s", evento.event_id)
        await comercio_service.marcar_evento_procesado(
            db, event_id=id_del_aviso, error=str(error)[:500]
        )
        await db.commit()
        raise

    await comercio_service.marcar_evento_procesado(db, event_id=id_del_aviso)
    # Nadie hace `commit` dentro del comercio: solo `flush`. Se hace aquí, una
    # vez, cuando la operación entera ha salido bien. Al revés, un webhook que
    # concede el derecho y luego falla al marcar la orden dejaría las dos cosas
    # a medias.
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _webhook_de_eventos(db: AsyncSession, evento) -> Response:
    """Un aviso de entradas, ya verificado. Mismas garantias que el de Cursos.

    LA BANDERA DE VENTA NO SE MIRA AQUI. Apagar `FEATURE_EVENT_PAYMENTS` impide
    ABRIR cobros nuevos; rechazar el aviso de uno que ya se abrio dejaria a
    quien pago sin su entrada y a Stripe reintentando en bucle.
    """
    ajustes = get_settings()

    if not await esquema_comercio.hay_comercio(db):
        # Sin la 0035 no hay donde anotar el aviso, y sin anotarlo no se puede
        # garantizar que no se procese dos veces. Se falla en cerrado.
        logger.error("[eventos] aviso de Stripe sin la migración 0035 aplicada")
        raise ServiceUnavailableError("El módulo de compras aún no está desplegado.")

    if evento.environment != ajustes.payments_environment:
        # Un aviso de pruebas NO emite una entrada en producción, ni al revés.
        logger.info("[eventos] aviso de otro entorno: %s", evento.environment)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # ANTI-REPETICION EN LA BASE, no en un `if`: dos avisos simultáneos pasarían
    # los dos por una comprobación y por el índice único pasa uno.
    _fila, es_nuevo = await comercio_service.registrar_evento(
        db,
        provider="stripe",
        external_event_id=evento.event_id,
        event_type=evento.event_type,
        environment=evento.environment,
        payload=dict(evento.payload),
    )
    if not es_nuevo:
        await db.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    id_del_aviso = _fila.id
    try:
        async with db.begin_nested():
            nota = await eventos_pagos.atender_aviso(db, evento)
    except Exception as error:  # noqa: BLE001
        logger.exception("[eventos] no se pudo aplicar el aviso %s", evento.event_id)
        await comercio_service.marcar_evento_procesado(
            db, event_id=id_del_aviso, error=str(error)[:500]
        )
        await db.commit()
        # NO SE PROPAGA. Un aviso que no cuadra —importe distinto, reserva
        # vencida, pedido cancelado— no se arregla reintentandolo: queda
        # anotado con su error para que una persona lo concilie. Propagar
        # pondria a Stripe a repetirlo cada pocos minutos durante días.
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # CON LA NOTA, SI LA HAY. Un aviso de devolucion queda cerrado pero
    # marcado: `error` es la cola de conciliacion que ya usa Cursos.
    await comercio_service.marcar_evento_procesado(
        db, event_id=id_del_aviso, error=nota
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


#: Avisos de devolucion que NO retiran acceso. Se anotan y se dejan estar.
#:
#: Antes los tres se traducian a 'refunded' por su NOMBRE, asi que un reembolso
#: pendiente, uno fallido y uno PARCIAL quitaban el curso igual que uno
#: completo. Quien devolvia 1 de 199 perdia el curso entero.
_DEVOLUCIONES_SIN_EFECTO = {
    "refund_procesando": "el reembolso sigue en tramite",
    "refund_parcial": "el reembolso es PARCIAL: no retira el acceso",
    "refund_fallido": "el reembolso fallo",
}

#: Una disputa la abre el BANCO del titular, no la persona, y el dinero se
#: retira fuera de nuestro circuito. Nunca retira acceso por si sola: abrir una
#: disputa no es haber perdido nada todavia, y decidirlo automaticamente dejaria
#: sin curso a quien podria ganarla.
_ESTADOS_DE_DISPUTA = frozenset({
    "disputa_abierta",
    "disputa_fondos_retirados",
    "disputa_cerrada",
})

#: Todo lo que es un aviso de DEVOLUCION o de DISPUTA, con efecto o sin el. Es
#: lo que sigue entrando con las compras nuevas deshabilitadas: apagar la venta
#: no puede dejar de atender el dinero ya cobrado.
_ESTADOS_DE_DEVOLUCION = (
    frozenset(_DEVOLUCIONES_SIN_EFECTO) | {"refunded"} | _ESTADOS_DE_DISPUTA
)


async def _aplicar_evento_stripe(db: AsyncSession, evento) -> None:
    entorno = evento.environment

    if evento.status in _ESTADOS_DE_DISPUTA:
        await _atender_disputa(db, evento)
        return

    if evento.status in _DEVOLUCIONES_SIN_EFECTO:
        # Se registra el avance del expediente, si lo hay, pero NO se toca el
        # acceso: retirarlo antes de que el dinero vuelva deja a la persona sin
        # las dos cosas.
        await _anotar_avance_de_devolucion(db, evento)
        logger.info(
            "[pagos] aviso de devolucion sin efecto sobre el acceso (%s): %s",
            _DEVOLUCIONES_SIN_EFECTO[evento.status],
            evento.provider_transaction_id,
        )
        return

    if evento.status == "refunded":
        pedido = await service.pedido_por_transaccion(
            db,
            provider="stripe",
            environment=entorno,
            external_transaction_id=evento.provider_transaction_id,
        )
        if pedido is None:
            logger.warning(
                "[pagos] devolución de Stripe sin compra apuntada: %s",
                evento.provider_transaction_id,
            )
            return
        await _aplicar_reembolso_total(db, pedido, evento)
        return

    if evento.status != "paid":
        # 'pendiente' (pago diferido que aún no ha llegado), 'failed',
        # 'cancelled' e 'ignorado'. Ninguno concede acceso.
        return

    pedido = (
        await service.pedido_por_id(db, evento.purchase_id)
        if evento.purchase_id
        else None
    )
    if pedido is None:
        logger.warning(
            "[pagos] aviso de Stripe de un pedido inexistente: %s", evento.purchase_id
        )
        return
    if pedido.provider != "stripe" or pedido.environment != entorno:
        logger.error("[pagos] el pedido %s no es de Stripe en este entorno", pedido.id)
        return
    if evento.amount_minor != pedido.amount_minor:
        # El importe que se cobró NO es el que se congeló al abrir el pedido.
        # No se concede: es exactamente la forma de comprar un curso de 300
        # por 1 si alguien pudiera manipular la sesión.
        #
        # SIN el `and` que habia aqui. Con el, un aviso SIN importe —o con
        # cero— se saltaba la comprobacion entera y concedia el acceso: la
        # ausencia de dato no puede valer como coincidencia.
        logger.error(
            "[pagos] importe distinto en el pedido %s: esperado %s, cobrado %s",
            pedido.id,
            pedido.amount_minor,
            evento.amount_minor,
        )
        return
    if (evento.currency or "").strip().upper() != (pedido.currency or "").strip().upper():
        logger.error(
            "[pagos] moneda distinta en el pedido %s: esperada %s, cobrada %s",
            pedido.id,
            pedido.currency,
            evento.currency,
        )
        return

    concesion = await service.conceder(
        db,
        user_id=pedido.user_id,
        producto=await service.producto_de_pedido(db, pedido),
        external_transaction_id=evento.provider_transaction_id,
        canal="web",
        order_id=pedido.id,
    )
    # Solo con el pago CONFIRMADO: ni por una orden pendiente, ni porque el
    # navegador volviera de Stripe. Y `concesion` dice si de verdad se estreno:
    # un webhook repetido no vuelve a avisar ni a deber el dinero dos veces.
    await _al_confirmar_la_compra(db, pedido, estrenada=_es_nueva(concesion))


async def _atender_disputa(db: AsyncSession, evento) -> None:
    """Un contracargo: se retiene el saldo y se deja rastro. NADA MAS.

    LAS TRES COSAS QUE **NO** HACE, y las tres a proposito:

    1. **No retira el acceso.** Abrir una disputa no es haberla perdido. Quitar
       el curso al abrirse castigaria a quien puede acabar ganandola, y la
       decision no es de un webhook.
    2. **No consume la garantia.** No es una devolucion voluntaria: quien sufre
       un cargo fraudulento no ha usado su derecho a devolver nada.
    3. **No cancela el saldo.** Solo lo retiene. Cancelarlo daria por perdida
       una disputa que aun no se ha resuelto.

    LO QUE SI HACE es congelar el dinero del propietario mientras dure, para que
    no se le pague algo que el banco esta reclamando. La retencion se marca SIN
    solicitud asociada, asi que resolver una devolucion no la levanta por
    accidente. Como se sale de ahi al ganar o perder esta en `docs/`.
    """
    pedido = await service.pedido_por_transaccion(
        db,
        provider="stripe",
        environment=evento.environment,
        external_transaction_id=evento.provider_transaction_id,
    )
    if pedido is None:
        logger.error(
            "[pagos] disputa (%s) sin compra apuntada: %s",
            evento.status,
            evento.event_type,
        )
        return

    from app.modules.refunds import esquema as esquema_devoluciones

    from app.modules.commerce import liquidacion

    retenido = False
    if await esquema_devoluciones.hay_devoluciones(db):
        # Savepoint: que no se pueda tumbar el aviso entero por esto.
        try:
            async with db.begin_nested():
                retenido = await liquidacion.congelar_por_disputa(
                    db, order_id=pedido.id
                )
        except Exception:  # noqa: BLE001
            logger.exception("[pagos] no se pudo retener el saldo de la disputa")

    # ALERTA, en el nivel que se vigila. El cuerpo del aviso ya queda guardado
    # en `payment_events`; aqui van solo codigos e identificadores.
    logger.error(
        "[pagos] DISPUTA %s sobre la orden %s. Saldo retenido: %s. El acceso NO "
        "se ha tocado y la garantia NO se ha consumido: requiere revision.",
        evento.status,
        pedido.id,
        retenido,
    )
    # SIN `commit`. Esto corre dentro del SAVEPOINT que abre el webhook, y un
    # `commit` no confirma el savepoint: sube hasta la raiz, la confirma entera
    # y deja sin efecto el aislamiento. Escribe el `commit` unico del final.
    await db.flush()


async def _aplicar_reembolso_total(db: AsyncSession, pedido, evento) -> None:
    """Un reembolso TOTAL y confirmado: la unica cosa que retira acceso.

    Se delega en `refunds.reembolso.aplicar`, que hace las diez cosas en la
    MISMA transaccion. Aqui solo se resuelve la orden y el expediente.

    SI LA 0049 NO ESTA APLICADA se cae al camino de siempre —revocar y marcar
    la orden—, que es exactamente lo que hacia antes. Desplegar este codigo no
    exige tener la migracion puesta.
    """
    from app.modules.commerce.models import Order
    from app.modules.refunds import esquema as esquema_devoluciones

    orden = await db.get(Order, pedido.id)
    if orden is None:
        logger.error("[pagos] la devolucion apunta a un pedido inexistente")
        return

    if not await esquema_devoluciones.hay_devoluciones(db):
        # SIN LA 0049 se retira acceso por el camino antiguo, pero con las
        # MISMAS puertas: un aviso sin importe, sin moneda o sin un `re_...`
        # real tampoco puede quitarle el curso a nadie aqui.
        from app.modules.refunds import validacion

        try:
            referencia = validacion.exigir_conciliado(
                compra=validacion.CompraOriginal(
                    id=orden.id,
                    amount_minor=orden.amount_minor,
                    currency=orden.currency,
                    environment=orden.environment,
                    provider=orden.provider,
                ),
                confirmado=validacion.ReembolsoConfirmado(
                    external_refund_id=evento.refund_id,
                    amount_minor=evento.amount_minor,
                    currency=evento.currency,
                    environment=evento.environment,
                    provider=orden.provider,
                ),
            )
        except validacion.NoConciliado as error:
            logger.error(
                "[pagos] devolucion sin conciliar sobre el pedido %s: %s",
                pedido.id,
                error,
            )
            return
        await service.revocar(
            db,
            user_id=pedido.user_id,
            producto=await service.producto_de_pedido(db, pedido),
            external_transaction_id=referencia,
            amount_minor=evento.amount_minor,
            currency=evento.currency,
            motivo="devolución confirmada por Stripe",
        )
        await comercio_service.marcar_orden(db, order_id=pedido.id, status="refunded")
        return

    from app.modules.refunds import reembolso, service as devoluciones

    solicitud = await devoluciones.solicitud_viva(
        db, user_id=orden.user_id, course_id=await _curso_de(db, orden)
    )
    # Los identificadores, ANTES: si la validacion falla, deshacer el savepoint
    # caduca los objetos y leerles un atributo dispara una carga perezosa que en
    # async revienta con `MissingGreenlet`.
    orden_id = orden.id
    solicitud_id = solicitud.id if solicitud is not None else None

    # SAVEPOINT. Un aviso que no cuadra no puede llevarse por delante la
    # transaccion del webhook: en ella vive la fila de `payment_events` que
    # impide procesar dos veces el mismo aviso. Con un `rollback` a secas esa
    # fila desaparecia y el anti-replay dejaba de existir.
    try:
        async with db.begin_nested():
            await reembolso.aplicar(
                db,
                orden=orden,
                # EL IDENTIFICADOR REAL DEL REEMBOLSO. Antes se componia uno
                # sintetico con el cobro (`pi_x:refund`): no existe en Stripe,
                # no se puede consultar ni auditar, y no permitia detectar que
                # el mismo reembolso se aplicara a dos ordenes distintas.
                external_transaction_id=evento.refund_id,
                # SIN COALESCENCIA. Lo que no venga en el aviso no se sustituye
                # por lo que esperabamos: queda sin conciliar y el acceso no se
                # toca.
                amount_minor=evento.amount_minor,
                currency=evento.currency,
                environment=evento.environment,
                solicitud=solicitud,
                motivo="reembolso confirmado por Stripe",
            )
    except reembolso.NoConciliado as error:
        # NO se toca nada. Un aviso que no cuadra con la orden es justo el que
        # no hay que aplicar: en la duda, el acceso se queda. Y se deja rastro
        # DURABLE, no solo en el registro: alguien tiene que mirarlo.
        logger.error(
            "[pagos] devolucion sin conciliar sobre la orden %s: %s", orden_id, error
        )
        await _anotar_sin_conciliar(db, orden_id, solicitud_id, str(error)[:300])


async def _anotar_sin_conciliar(
    db: AsyncSession, orden_id: str, solicitud_id: str | None, motivo: str
) -> None:
    """Deja constancia DURABLE de un aviso que no cuadra, para que se revise.

    Solo identificadores y texto ya recortado: nunca el cuerpo del aviso.

    RECIBE CADENAS Y NO OBJETOS porque llega justo despues de deshacer un
    savepoint, y eso caduca los objetos del ORM: leerles un atributo dispararia
    una recarga perezosa que en asincrono revienta con `MissingGreenlet`.

    Y NO HACE `commit` NI `rollback`, que es lo que antes se le escapaba. Los
    dos suben hasta la raiz: el `commit` confirmaba la transaccion del webhook a
    medias, y el `rollback` del manejador de error se llevaba por delante la
    fila de `payment_events` —el registro anti-repeticion que todo este bloque
    existe para conservar—. Y lo hacia EN SILENCIO: no lanza nada, asi que la
    peticion respondia con normalidad y el reenvio de Stripe se procesaba como
    si fuera nuevo. Un savepoint propio deshace solo esta anotacion.
    """
    from app.modules.refunds import service as devoluciones
    from app.modules.refunds.models import RefundRequest

    if solicitud_id is None:
        return
    try:
        async with db.begin_nested():
            solicitud = await db.get(RefundRequest, solicitud_id)
            if solicitud is None:
                return
            await devoluciones._anotar(
                db,
                solicitud,
                desde=solicitud.status,
                hasta=solicitud.status,
                rol="system",
                actor_id=None,
                reason="aviso de devolucion sin conciliar",
                notes=motivo,
                metadata={"order_id": orden_id, "requiere_revision": True},
            )
    except Exception:  # pragma: no cover - la anotacion no puede romper el aviso
        # El savepoint ya deshizo lo suyo al salir. No se deshace nada mas.
        logger.exception("[pagos] no se pudo anotar la devolucion sin conciliar")


async def _curso_de(db: AsyncSession, orden) -> str:
    from app.modules.commerce.models import CommerceProduct

    producto = await db.get(CommerceProduct, orden.commerce_product_id)
    return producto.course_id if producto and producto.course_id else ""


async def _anotar_avance_de_devolucion(db: AsyncSession, evento) -> None:
    """Deja constancia de un reembolso en tramite, parcial o fallido.

    No cambia el acceso. Lo unico que puede mover es el expediente: un fallo de
    la pasarela pasa la solicitud a `failed`, que es lo que habilita el
    reintento en la bandeja de administracion.
    """
    from app.modules.refunds import esquema as esquema_devoluciones

    if not await esquema_devoluciones.hay_devoluciones(db):
        return

    from app.modules.commerce.models import Order
    from app.modules.refunds import estados, service as devoluciones

    pedido = await service.pedido_por_transaccion(
        db,
        provider="stripe",
        environment=evento.environment,
        external_transaction_id=evento.provider_transaction_id,
    )
    if pedido is None:
        return
    orden = await db.get(Order, pedido.id)
    if orden is None:
        return
    solicitud = await devoluciones.solicitud_viva(
        db, user_id=orden.user_id, course_id=await _curso_de(db, orden)
    )
    if solicitud is None:
        return

    # ¿HABLA ESTE AVISO DEL REEMBOLSO QUE TENEMOS EN CURSO? Un mismo cobro puede
    # acumular varios: un parcial antiguo que fallo, mas el total que esta en
    # marcha. Sin comparar identificadores, el `refund.failed` del parcial
    # mataba el expediente del total —que seguia vivo— y lo dejaba en `failed`
    # con un motivo TERMINAL. A partir de ahi el expediente miente, y el boton
    # de reintentar suelta la referencia viva y pide un SEGUNDO reembolso.
    referencia_viva = (solicitud.external_refund_id or "").strip()
    del_mismo = (
        not evento.refund_id
        or not referencia_viva
        or evento.refund_id == referencia_viva
    )

    if (
        evento.status == "refund_fallido"
        and del_mismo
        and solicitud.status == estados.REFUND_PROCESSING
    ):
        await devoluciones.transicionar(
            db,
            solicitud,
            hasta=estados.FAILED,
            rol="system",
            actor_id=None,
            # El motivo es un CODIGO porque `_fallos_terminales` lo clasifica
            # con `es_terminal`: un aviso de reembolso fallido es concluyente.
            reason="provider_refund_failed",
            # SIN `external_reference`: `provider_transaction_id` es el cobro
            # (`pi_...`), no el reembolso. Escribirlo en `external_refund_id`
            # dejaba el expediente sin salida —conciliar preguntaria por un id
            # que la pasarela no reconoce— y bloqueaba la reejecucion.
            metadata={
                "event_type": evento.event_type,
                "terminal": True,
                "payment_intent": evento.provider_transaction_id,
            },
        )
        return

    # Parcial, en tramite, o un fallo de OTRO reembolso del mismo cobro: solo se
    # anota, sin mover el estado. Un reembolso parcial NO resuelve el
    # expediente; lo tiene que mirar una persona.
    await devoluciones._anotar(
        db,
        solicitud,
        desde=solicitud.status,
        hasta=solicitud.status,
        rol="system",
        actor_id=None,
        reason=evento.status,
        # Mismo motivo: el cobro va en los metadatos, no en la referencia.
        metadata={
            "event_type": evento.event_type,
            "payment_intent": evento.provider_transaction_id,
        },
    )


async def _exigir_aceptacion_de_recompra(
    db: AsyncSession, *, user_id: str, course_id: str
) -> None:
    """409 si va a recomprar sin haber aceptado que no habra garantia.

    NO ES UNA CASILLA COSMETICA. Es la unica forma de que despues se pueda
    demostrar que se le dijo: la aceptacion guarda la version y la huella del
    texto que se mostro, asi que cambiar la redaccion no reescribe lo que
    firmaron los de antes.

    NO MIRA LA BANDERA, solo la 0049. Quien ya gasto su garantia la gasto: si
    apagar `FEATURE_COURSE_REFUNDS` levantara esta exigencia, esa persona
    recompraria sin que nadie le dijera que esta compra tampoco admite otra
    devolucion. Sin la migracion no hay garantias que haber usado y no se exige
    nada, que es como funcionaba antes de esta funcionalidad.
    """
    from app.modules.refunds import esquema as esquema_devoluciones

    if not await esquema_devoluciones.hay_devoluciones(db):
        return

    from app.modules.refunds import service as devoluciones

    usada = await devoluciones.ya_devolvio(db, user_id=user_id, course_id=course_id)
    if usada is None:
        # Primera compra, o una recompra sin devolucion previa: con garantia.
        return
    if await devoluciones.tiene_aceptacion(
        db, user_id=user_id, course_id=course_id
    ):
        return
    raise ConflictError(
        "Ya usaste la garantía de este curso. Tienes que aceptar que esta "
        "nueva compra no admite otra devolución.",
        code="refund_acceptance_required",
    )


async def _atar_aceptacion(
    db: AsyncSession, *, user_id: str, course_id: str, order_id: str
) -> None:
    """Enlaza la aceptacion suelta con la orden recien creada."""
    from app.modules.refunds import esquema as esquema_devoluciones

    if not await esquema_devoluciones.hay_devoluciones(db):
        return
    from app.modules.refunds import service as devoluciones

    await devoluciones.enlazar_aceptacion(
        db, user_id=user_id, course_id=course_id, order_id=order_id
    )


def _es_nueva(concesion) -> bool:
    """Si la concesion escribio algo o ya estaba.

    `ResultadoDeConcesion` puede llamar distinto al campo segun la version; se
    consulta con tolerancia para no atar este aviso a su forma interna.
    """
    for nombre in ("creado", "creada", "nuevo", "nueva", "estrenado"):
        valor = getattr(concesion, nombre, None)
        if isinstance(valor, bool):
            return valor
    return True


async def _al_confirmar_la_compra(db: AsyncSession, pedido, *, estrenada: bool) -> None:
    """Lo que pasa cuando el dinero entra de verdad: saldo y aviso.

    NO PUEDE TUMBAR LA COMPRA. Si algo de esto falla, quien pago ya tiene su
    acceso —se concedio antes— y lo que queda por hacer se puede reconstruir.
    Perder la compra por no haber podido mandar un aviso seria absurdo.
    """
    from app.modules.commerce.models import Order

    # SAVEPOINT, y no un `try` a secas. El derecho ya se concedio en ESTA misma
    # transaccion y todavia no hay `commit`. En PostgreSQL una sentencia que
    # falla ABORTA la transaccion entera, asi que sin aislar esto pasaba lo
    # siguiente: fallaba el aviso al propietario, el `except` se lo tragaba, y
    # el `marcar_evento_procesado` de mas arriba reventaba con «current
    # transaction is aborted». El `except` exterior hacia `rollback` y se
    # llevaba por delante LA CONCESION. El comprador pagaba, se quedaba sin
    # curso, y como el aviso ya constaba visto Stripe no reintentaba.
    #
    # Con `begin_nested` el fallo deshace solo el saldo y el aviso; el derecho
    # concedido sigue en pie y el `commit` de fuera lo escribe.
    try:
        async with db.begin_nested():
            orden = await db.get(Order, pedido.id)
            if orden is None:
                return
            await _crear_saldo_del_propietario(db, orden)
            if estrenada:
                await _avisar_compra_al_propietario(db, orden)
    except Exception:  # noqa: BLE001
        logger.exception(
            "[pagos] la compra %s se concedio pero fallo el saldo o el aviso",
            pedido.id,
        )


async def _crear_saldo_del_propietario(db: AsyncSession, orden) -> None:
    """La fotografia de la venta, retenida hasta que venza la garantia.

    `available_at` NACE NULO cuando hay garantia, y eso es lo importante.

    EL CASO QUE OBLIGA A ELLO. Alguien compra y NO entra al curso en ocho dias.
    Si el saldo naciera con «disponible dentro de 168 horas desde la compra»,
    el trabajo de liberacion lo daria por vencido al septimo dia y el
    propietario cobraria. Al noveno la persona entra, y ES ENTONCES cuando
    empieza su garantia: el dinero ya estaba pagado con la garantia abierta.

    Con `NULL` no hay nada que vencer: `liberar_vencidos` exige
    `available_at is not null`, asi que el saldo se queda quieto. La fecha
    REAL la escribe `asegurar_ventana` en el primer acceso protegido, cuando
    por fin se sabe cuando termina el plazo.

    CONSECUENCIA ACEPTADA: una compra que nadie llega a abrir nunca deja de
    estar pendiente. Es deliberado —no se puede liberar un plazo que no ha
    empezado— y se vigila con la señal de «pendientes sin fecha» de
    `docs/Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`.

    SIN GARANTIA SI HAY FECHA. Con las devoluciones apagadas no hay plazo que
    esperar, asi que el saldo nace disponible desde ya. Antes se quedaba en
    `NULL` tambien en ese caso, o sea bloqueado para siempre: justo lo
    contrario de lo que tocaba.
    """
    from app.modules.commerce import liquidacion
    from app.modules.refunds import esquema as esquema_devoluciones
    from app.modules.refunds.service import ahora

    if not await esquema_devoluciones.hay_liquidaciones(db):
        return
    con_garantia = get_settings().feature_course_refunds
    await liquidacion.registrar_saldo(
        db, orden=orden, disponible_desde=None if con_garantia else ahora()
    )
    # SIN `commit` AQUI, y es lo que hace que el savepoint de arriba sirva de
    # algo. Un `commit` dentro de un SAVEPOINT no lo deshace: lo CIERRA, y de
    # paso escribe la transaccion entera del webhook. Con el puesto, el
    # aislamiento que `_al_confirmar_la_compra` promete era mentira —el saldo ya
    # estaba escrito cuando fallaba el aviso— y el `rollback` del manejador de
    # error de mas arriba ya no deshacia la concesion que dice deshacer.
    # Escribe el `commit` unico del final del webhook.
    await db.flush()


async def _avisar_compra_al_propietario(db: AsyncSession, orden) -> None:
    """«Alguien compro tu curso». UNA por transaccion.

    `add_notification` es idempotente por (destinatario, tipo, actor, entidad)
    para los tipos que lo declaran, asi que un webhook repetido no duplica.
    Y se calla solo si el comprador es el propio autor.
    """
    from app.modules.commerce.models import CommerceProduct
    from app.modules.catalog.models import Course
    from app.modules.notifications.service import add_notification

    producto = await db.get(CommerceProduct, orden.commerce_product_id)
    if producto is None or producto.course_id is None:
        return
    curso = await db.get(Course, producto.course_id)
    if curso is None:
        return
    # LA ENTIDAD ES LA ORDEN, NO EL CURSO. `course_purchase` es idempotente por
    # (destinatario, tipo, actor, entidad); con el curso como entidad, la
    # SEGUNDA compra del mismo curso por la misma persona —una recompra despues
    # de devolver— se tomaria por un reintento del webhook y el propietario no
    # se enteraria de una venta real. Con la orden, cada venta avisa una vez y
    # solo una.
    await add_notification(
        db,
        user_id=curso.author_id,
        actor_id=orden.user_id,
        type="course_purchase",
        entity_type="order",
        entity_id=orden.id,
        payload={"orderId": orden.id, "courseId": curso.id},
    )
    # Tampoco aqui: mismo motivo que en `_crear_saldo_del_propietario`. El
    # comercio solo hace `flush`; el `commit` es uno y esta al final del webhook.
    await db.flush()


@router.get("/history", response_model=list[PurchaseHistoryRead])
async def purchase_history(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PurchaseHistoryRead]:
    """Historial de compras, reconstruido desde el servidor.

    Nunca desde el almacenamiento local del teléfono: allí no se puede saber si
    algo se devolvió, y quien reinstale se quedaría sin historial. Funciona
    aunque los pagos estén apagados, y responde vacío —no un error— si la
    migración 0035 todavía no está aplicada.
    """
    if not await esquema_comercio.hay_comercio(db):
        return []
    filas = await service.historial(db, current_user.id)
    return [PurchaseHistoryRead(**fila) for fila in filas]
