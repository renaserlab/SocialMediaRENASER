"""Quién puede qué en Productos. LO DECIDE EL SERVIDOR, siempre.

QUÉ ROLES SE USAN Y POR QUÉ NO SE INVENTAN OTROS. La arquitectura nombra
«Evaluador Z», «Mediador Z» y «Finanzas Z», pero `profiles.role` solo tiene
`admin`, `moderator` y `user`, y quién puede ser evaluador es una decisión que la
empresa todavía no ha tomado. Añadir roles nuevos aquí sería tomarla por ella, y
además exigiría una migración sobre una tabla que usa media plataforma.

Así que se reutiliza la separación que ya existe y ya está probada:

    evaluar y admitir   ->  `is_admin` (admin + moderator): es curaduría
    publicar y retirar  ->  solo `admin`: es autorizar que algo se venda

ES EL MISMO PATRÓN DE EVENTOS (D34): curaduría puntúa, administración decide.
Un moderador puede mirar un producto y evaluarlo; poner el sello de Z en el
catálogo es otra cosa.

Y NINGÚN PERMISO FINANCIERO POR HERENCIA. Productos no mueve dinero todavía, y
cuando lo mueva pasará por `puede_mover_dinero`, que es un conjunto aparte y más
estrecho. Este fichero no lo menciona para que nadie lo confunda con un permiso
que concede.

DOS REGLAS QUE NO SON DE ROL Y PESAN MÁS:

  1. NADIE EVALÚA NI PUBLICA SU PROPIO PRODUCTO, ni siendo administrador. Se
     comprueba ANTES que el rol, igual que en la admisión de eventos: si se
     comprobara después, un administrador dueño del producto recibiría un 403
     genérico en vez del motivo real, y el día que alguien relaje el rol la
     puerta desaparece.
  2. UN PRODUCTO AJENO ES UN 404, NUNCA UN 403. Decir «existe pero no es tuyo»
     ya cuenta que existe.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.modules.products.models import (
    VENDEDOR_ACTIVO,
    Product,
    ProductSeller,
)
from app.shared.permissions import FINANCE_ROLES, get_role, is_admin


class NoEsTuProducto(NotFoundError):
    """404 a propósito. Ver la cabecera."""

    code = "product_not_found"


class SinCapacidadComercial(ForbiddenError):
    code = "product_seller_not_active"


class EsTuPropioProducto(ForbiddenError):
    code = "product_self_review_forbidden"


async def puede_evaluar(db: AsyncSession, user_id: str) -> bool:
    """Curaduría: mirar, puntuar, registrar evidencia y decidir."""
    return await is_admin(db, user_id)


async def puede_publicar(db: AsyncSession, user_id: str) -> bool:
    """Autorizar que algo lleve el sello de Z en el catálogo. Solo `admin`."""
    return await get_role(db, user_id) in FINANCE_ROLES


async def exigir_evaluador(db: AsyncSession, user_id: str) -> None:
    if not await puede_evaluar(db, user_id):
        raise ForbiddenError(
            "Solo quien evalúa puede hacer esto.", code="product_review_forbidden"
        )


async def exigir_publicador(db: AsyncSession, user_id: str) -> None:
    if not await puede_publicar(db, user_id):
        raise ForbiddenError(
            "Solo administración publica o retira un producto.",
            code="product_publish_forbidden",
        )


async def vendedor_de(db: AsyncSession, user_id: str) -> ProductSeller | None:
    """La capacidad comercial de esta persona, si la tiene."""
    return await db.scalar(
        select(ProductSeller).where(ProductSeller.profile_id == user_id)
    )


async def exigir_vendedor_activo(db: AsyncSession, user_id: str) -> ProductSeller:
    """La capacidad comercial, o se para.

    `pending` y `suspended` NO son «casi activo»: sin admisión aceptada no se
    postulan productos, y eso es lo que hace que Z no sea un marketplace
    abierto.
    """
    vendedor = await vendedor_de(db, user_id)
    if vendedor is None:
        raise SinCapacidadComercial(
            "Todavía no eres responsable comercial en Z.",
            details={"status": None},
        )
    if vendedor.status != VENDEDOR_ACTIVO:
        raise SinCapacidadComercial(
            "Tu capacidad comercial no está activa.",
            details={"status": vendedor.status},
        )
    return vendedor


async def dueno_de(db: AsyncSession, producto: Product) -> str | None:
    """El perfil responsable de ese producto."""
    return await db.scalar(
        select(ProductSeller.profile_id).where(ProductSeller.id == producto.seller_id)
    )


async def exigir_mio(db: AsyncSession, *, producto_id: str, user_id: str) -> Product:
    """El producto de quien pregunta. 404 para el ajeno."""
    producto = await db.get(Product, producto_id)
    if producto is None:
        raise NoEsTuProducto("Producto no encontrado.")
    if await dueno_de(db, producto) != user_id:
        raise NoEsTuProducto("Producto no encontrado.")
    return producto


async def exigir_ajeno(db: AsyncSession, *, producto: Product, user_id: str) -> None:
    """Que NO sea el propio. Se comprueba antes que el rol.

    Un administrador dueño del producto no puede evaluarlo ni publicarlo, y el
    error dice exactamente eso en vez de un 403 genérico.
    """
    if await dueno_de(db, producto) == user_id:
        raise EsTuPropioProducto(
            "Nadie evalúa ni publica su propio producto.",
            details={"product_id": producto.id},
        )


__all__ = [
    "EsTuPropioProducto",
    "NoEsTuProducto",
    "SinCapacidadComercial",
    "dueno_de",
    "exigir_ajeno",
    "exigir_evaluador",
    "exigir_mio",
    "exigir_publicador",
    "exigir_vendedor_activo",
    "puede_evaluar",
    "puede_publicar",
    "vendedor_de",
]
