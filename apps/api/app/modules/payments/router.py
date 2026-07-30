"""Portal de pagos de los cursos.

**Estado: construido pero APAGADO.** `payments_enabled` está en `false` hasta
que se elija pasarela; mientras tanto los endpoints responden 503 en vez de
simular un cobro.

## Por qué el cobro ocurre en la web y no dentro de la app

Vender contenido digital DENTRO de una aplicación obliga a usar las compras
integradas de Apple y la facturación de Google Play, con su comisión. Cobrando
en la web esa comisión no existe: es el modelo de Netflix o Spotify.

A cambio hay una regla que no se puede saltar: la aplicación móvil **no puede
mostrar precios, botones de compra ni enlaces al checkout** (directriz 3.1.1 de
Apple). Por eso este flujo lo inicia la web, y la app se limita a consultar si
hay acceso. `FEATURE_PURCHASES` en el móvil sigue en `false` justamente por eso.

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
from sqlalchemy import select
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
from app.modules.payments.providers import CheckoutRequest, get_provider
from app.modules.payments.schemas import (
    CheckoutCreate,
    CheckoutRead,
    CourseAccessRead,
    PurchaseRead,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

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
            course_title=course.title,
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

    if course.price_minor <= 0:
        return CourseAccessRead(course_id=cid, has_access=True, reason="gratuito")

    if course.author_id == current_user.id:
        return CourseAccessRead(course_id=cid, has_access=True, reason="autor")

    if getattr(current_user, "is_admin", False):
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
