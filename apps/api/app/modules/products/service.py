"""El ciclo de vida de un producto y de sus versiones.

POR QUÉ ESTE FICHERO EXISTE. La arquitectura propone `catalog.py` para lo que se
LEE y `applications.py`/`evaluations.py` para la admisión. Lo que falta es quién
escribe el producto y su versión, y eso no es catálogo ni admisión: es el
ciclo. Está aquí y no repartido para que el orden de los pasos —qué se puede
editar, qué congela una publicación, qué exige una evaluación— se pueda leer de
una vez.

LA REGLA QUE SOSTIENE TODO LO DEMÁS: **lo publicado no se toca**. Una versión
publicada se supersede y se publica otra; las fotos y las variantes cuelgan de la
versión justo para que cambiar una foto no reescriba en silencio lo que se
evaluó.

Y PUBLICAR NO ES UN BOTÓN. Exige una evaluación aprobada de ESA versión, sus
tres razones respaldadas por evidencia y al menos una foto. Sin eso el sello de
Z sería una etiqueta que se pone uno mismo.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, ConflictError, ValidationAppError
from app.modules.gobernanza import auditoria
from app.modules.products import esquema, permissions
from app.modules.products import states as maquina
from app.modules.products.models import (
    APROBADO,
    BORRADOR,
    DECISION_APROBADO,
    EVALUACION_DECIDIDA,
    PUBLICADO,
    RAZONES_EXIGIDAS,
    RETIRADO,
    SUSPENDIDO,
    VERSION_BORRADOR,
    VERSION_PUBLICADA,
    VERSION_SUPERADA,
    Product,
    ProductApprovalReason,
    ProductCategory,
    ProductEvaluation,
    ProductMedia,
    ProductSeller,
    ProductVariant,
    ProductVersion,
)

logger = logging.getLogger("renaser.products")

#: Los campos que forman la huella. El ORDEN NO IMPORTA porque se serializa
#: canónico; lo que importa es que estén TODOS los que alguien lee antes de
#: comprar. Uno que falte hace que cambiarlo no cambie la huella, y entonces la
#: huella deja de demostrar nada.
CAMPOS_DE_LA_HUELLA = (
    "name",
    "summary",
    "description",
    "materials",
    "origin_country",
    "manufacturer",
    "price_minor",
    "currency",
)

#: Topes que la base también impone. Aquí se dicen antes para que el error sea
#: comprensible en vez de una violación de CHECK.
LARGOS = {
    "name": (3, 140),
    "summary": (0, 300),
    "description": (0, 8_000),
    "materials": (0, 2_000),
    "manufacturer": (2, 160),
}

#: Cuántas variantes y cuántas fotos caben. No es una regla de negocio: es que
#: una versión es una ficha, no un almacén, y su huella se calcula entera.
MAXIMO_DE_VARIANTES = 50
MAXIMO_DE_FOTOS = 12


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def huella(datos: dict[str, Any], *, variantes: list[dict] | None = None) -> str:
    """El resumen de lo publicable. CANÓNICO: claves ordenadas y sin espacios.

    Sin eso el mismo contenido daría huellas distintas según cómo se escribiera,
    y la huella dejaría de servir para demostrar qué se publicó.
    """
    cuerpo = {c: datos.get(c) for c in CAMPOS_DE_LA_HUELLA}
    cuerpo["variants"] = [
        {
            "sku": v.get("sku"),
            "name": v.get("name"),
            "options": v.get("options") or {},
            "price_delta_minor": int(v.get("price_delta_minor") or 0),
        }
        for v in sorted(variantes or [], key=lambda v: str(v.get("sku", "")))
    ]
    crudo = json.dumps(cuerpo, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(crudo.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Validación de lo que se escribe
# --------------------------------------------------------------------------- #
def _exigir_textos(datos: dict[str, Any]) -> dict[str, Any]:
    """Recorta, quita lo vacío y comprueba los topes. Falla en cerrado."""
    limpio: dict[str, Any] = {}
    for campo, (minimo, maximo) in LARGOS.items():
        crudo = datos.get(campo)
        valor = (crudo or "").strip() if isinstance(crudo, str) else crudo
        if valor in (None, ""):
            if minimo > 0 and campo == "name":
                raise ValidationAppError(
                    "El producto necesita un nombre.", code="product_name_required"
                )
            limpio[campo] = None
            continue
        if len(valor) > maximo or len(valor) < minimo:
            raise ValidationAppError(
                f"`{campo}` está fuera de lo posible.",
                code="product_field_out_of_range",
                details={"field": campo, "min": minimo, "max": maximo},
            )
        limpio[campo] = valor

    pais = (datos.get("origin_country") or "").strip().upper() or None
    if pais is not None and (len(pais) != 2 or not pais.isalpha()):
        raise ValidationAppError(
            "El país de origen son dos letras.", code="product_country_invalid"
        )
    limpio["origin_country"] = pais

    # EL PRECIO VA CON SU MONEDA, y nulo NO es gratis: es «sin precio».
    precio = datos.get("price_minor")
    moneda = (datos.get("currency") or "").strip().upper() or None
    if isinstance(precio, bool) or (precio is not None and not isinstance(precio, int)):
        raise ValidationAppError(
            "El precio es un número entero en unidades menores.",
            code="product_price_invalid",
        )
    if precio is not None and precio < 0:
        raise ValidationAppError(
            "El precio no puede ser negativo.", code="product_price_invalid"
        )
    if moneda is not None and (len(moneda) != 3 or not moneda.isalpha()):
        raise ValidationAppError(
            "La moneda son tres letras.", code="product_currency_invalid"
        )
    if (precio is None) != (moneda is None):
        raise ValidationAppError(
            "Un importe sin moneda no es un importe.",
            code="product_price_without_currency",
        )
    limpio["price_minor"] = precio
    limpio["currency"] = moneda
    return limpio


def _exigir_variantes(crudas: list[dict] | None) -> list[dict]:
    if not crudas:
        return []
    if len(crudas) > MAXIMO_DE_VARIANTES:
        raise ValidationAppError(
            "Demasiadas variantes para una sola versión.",
            code="product_variants_too_many",
            details={"max": MAXIMO_DE_VARIANTES},
        )
    vistos: set[str] = set()
    limpias: list[dict] = []
    for posicion, v in enumerate(crudas):
        sku = str(v.get("sku") or "").strip()
        nombre = str(v.get("name") or "").strip()
        if not sku or not nombre:
            raise ValidationAppError(
                "Una variante necesita SKU y nombre.",
                code="product_variant_incomplete",
            )
        if sku in vistos:
            raise ValidationAppError(
                "Dos variantes con el mismo SKU.",
                code="product_variant_sku_repeated",
                details={"sku": sku},
            )
        vistos.add(sku)
        opciones = v.get("options") or {}
        if not isinstance(opciones, dict):
            raise ValidationAppError(
                "Las opciones de una variante son un objeto.",
                code="product_variant_options_invalid",
            )
        delta = v.get("price_delta_minor") or 0
        if isinstance(delta, bool) or not isinstance(delta, int):
            raise ValidationAppError(
                "La diferencia de precio es un número entero.",
                code="product_variant_delta_invalid",
            )
        limpias.append(
            {
                "sku": sku,
                "name": nombre,
                "options": opciones,
                "price_delta_minor": delta,
                "position": posicion,
            }
        )
    return limpias


def _exigir_galeria(crudas: list[dict] | None) -> list[dict]:
    if not crudas:
        return []
    if len(crudas) > MAXIMO_DE_FOTOS:
        raise ValidationAppError(
            "Demasiadas imágenes para una sola versión.",
            code="product_media_too_many",
            details={"max": MAXIMO_DE_FOTOS},
        )
    vistas: set[str] = set()
    limpias: list[dict] = []
    for posicion, m in enumerate(crudas):
        ruta = str(m.get("storage_path") or "").strip()
        if len(ruta) < 3 or len(ruta) > 512:
            raise ValidationAppError(
                "La ruta de la imagen no es válida.",
                code="product_media_path_invalid",
            )
        # NUNCA UNA URL. Una firmada caduca, y guardarla haría que la galería
        # dejara de cargar sin que nadie tocara nada.
        if "://" in ruta:
            raise ValidationAppError(
                "La galería guarda la ruta del almacenamiento, no una URL.",
                code="product_media_path_invalid",
            )
        if ruta in vistas:
            raise ValidationAppError(
                "La misma imagen dos veces.", code="product_media_repeated"
            )
        vistas.add(ruta)
        tipo = str(m.get("kind") or "image").strip()
        if tipo not in ("image", "video"):
            raise ValidationAppError(
                "Una galería lleva imágenes o vídeos.",
                code="product_media_kind_invalid",
            )
        alternativo = (m.get("alt_text") or "").strip() or None
        if alternativo is not None and len(alternativo) > 300:
            raise ValidationAppError(
                "El texto alternativo es demasiado largo.",
                code="product_media_alt_too_long",
            )
        limpias.append(
            {
                "storage_path": ruta,
                "kind": tipo,
                "alt_text": alternativo,
                "position": posicion,
            }
        )
    return limpias


# --------------------------------------------------------------------------- #
# Crear y editar
# --------------------------------------------------------------------------- #
async def crear(
    db: AsyncSession,
    *,
    usuario_id: str,
    datos: dict[str, Any],
    category_id: str | None = None,
    variantes: list[dict] | None = None,
    galeria: list[dict] | None = None,
) -> tuple[Product, ProductVersion]:
    """Un producto nuevo nace BORRADOR, con su primera versión borrador.

    NADIE PUBLICA POR CREAR. Es el mismo criterio que en eventos (D33): crear no
    es autopublicar, y aquí además hace falta que alguien lo evalúe.
    """
    await esquema.exigir_dominio(db)
    vendedor = await permissions.exigir_vendedor_activo(db, usuario_id)

    if category_id is not None:
        # UNA CATEGORÍA QUE NO EXISTE NO SE INVENTA. La tabla nace vacía a
        # propósito: las categorías iniciales las decide la empresa.
        categoria = await db.get(ProductCategory, category_id)
        if categoria is None or not categoria.active:
            raise ValidationAppError(
                "Esa categoría no existe.", code="product_category_invalid"
            )

    limpio = _exigir_textos(datos)
    limpias = _exigir_variantes(variantes)
    fotos = _exigir_galeria(galeria)

    producto = Product(
        seller_id=vendedor.id,
        category_id=category_id,
        status=BORRADOR,
        created_by=usuario_id,
    )
    db.add(producto)
    await db.flush()

    version = ProductVersion(
        product_id=producto.id,
        version=str(datos.get("version") or "1").strip()[:32] or "1",
        status=VERSION_BORRADOR,
        content_sha256=huella(limpio, variantes=limpias),
        created_by=usuario_id,
        **limpio,
    )
    db.add(version)
    await db.flush()
    await _reemplazar_hijos(db, version=version, variantes=limpias, galeria=fotos)

    await auditoria.anotar(
        db,
        actor_id=usuario_id,
        action="product.create",
        entity_type="product",
        entity_id=producto.id,
        new_state=BORRADOR,
        payload={"seller_id": vendedor.id, "version": version.version},
    )
    return producto, version


async def borrador_de(db: AsyncSession, *, producto_id: str) -> ProductVersion | None:
    """La versión borrador de ese producto. Una como mucho, y lo impone un
    índice parcial de la 0070."""
    return await db.scalar(
        select(ProductVersion).where(
            ProductVersion.product_id == producto_id,
            ProductVersion.status == VERSION_BORRADOR,
        )
    )


async def vigente_de(db: AsyncSession, *, producto_id: str) -> ProductVersion | None:
    return await db.scalar(
        select(ProductVersion).where(
            ProductVersion.product_id == producto_id,
            ProductVersion.status == VERSION_PUBLICADA,
            ProductVersion.effective_to.is_(None),
        )
    )


async def guardar_borrador(
    db: AsyncSession,
    *,
    producto_id: str,
    usuario_id: str,
    datos: dict[str, Any],
    variantes: list[dict] | None = None,
    galeria: list[dict] | None = None,
) -> ProductVersion:
    """Reescribe el borrador, o abre uno nuevo sobre lo publicado.

    SOLO MIENTRAS EL PRODUCTO SEA EDITABLE. Editar lo que alguien está evaluando
    cambia el objeto de la evaluación a mitad de camino, y el sello acabaría
    puesto sobre un texto que el evaluador no vio.
    """
    await esquema.exigir_dominio(db)
    await permissions.exigir_vendedor_activo(db, usuario_id)
    producto = await permissions.exigir_mio(
        db, producto_id=producto_id, user_id=usuario_id
    )
    if producto.status not in maquina.EDITABLES:
        raise ConflictError(
            "Este producto no se puede editar en su estado actual.",
            code="product_not_editable",
            details={"status": producto.status},
        )

    limpio = _exigir_textos(datos)
    limpias = _exigir_variantes(variantes)
    fotos = _exigir_galeria(galeria)
    nombre_de_la_version = str(datos.get("version") or "").strip()[:32] or None

    borrador = await borrador_de(db, producto_id=producto_id)
    if borrador is None:
        # LA VERSIÓN NUEVA NO REUTILIZA EL NOMBRE DE LA PUBLICADA: dos filas con
        # la misma versión son dos verdades sobre qué se publicó.
        vigente = await vigente_de(db, producto_id=producto_id)
        propuesto = nombre_de_la_version or _siguiente_version(vigente)
        if vigente is not None and vigente.version == propuesto:
            raise ConflictError(
                "Ya hay una versión publicada con ese nombre.",
                code="product_version_taken",
            )
        borrador = ProductVersion(
            product_id=producto_id,
            version=propuesto,
            status=VERSION_BORRADOR,
            content_sha256=huella(limpio, variantes=limpias),
            created_by=usuario_id,
            **limpio,
        )
        db.add(borrador)
        await db.flush()
    else:
        if nombre_de_la_version:
            vigente = await vigente_de(db, producto_id=producto_id)
            if vigente is not None and vigente.version == nombre_de_la_version:
                raise ConflictError(
                    "Ya hay una versión publicada con ese nombre.",
                    code="product_version_taken",
                )
            borrador.version = nombre_de_la_version
        for campo, valor in limpio.items():
            setattr(borrador, campo, valor)
        borrador.content_sha256 = huella(limpio, variantes=limpias)
        await db.flush()

    await _reemplazar_hijos(db, version=borrador, variantes=limpias, galeria=fotos)
    producto.updated_at = ahora()
    await db.flush()
    return borrador


def _siguiente_version(vigente: ProductVersion | None) -> str:
    """`1`, o el número siguiente si el anterior era un número."""
    if vigente is None:
        return "1"
    try:
        return str(int(vigente.version) + 1)
    except (TypeError, ValueError):
        return f"{vigente.version}-2"


async def _reemplazar_hijos(
    db: AsyncSession,
    *,
    version: ProductVersion,
    variantes: list[dict],
    galeria: list[dict],
) -> None:
    """Las variantes y la galería de un BORRADOR se reemplazan enteras.

    Es lo que hace que guardar sea idempotente: mandar la misma lista dos veces
    deja lo mismo. Sobre una versión publicada esto no se llama nunca.
    """
    if version.status != VERSION_BORRADOR:  # pragma: no cover - defensa
        raise ConflictError(
            "Una versión publicada no se reescribe.",
            code="product_version_not_editable",
        )
    for fila in await db.scalars(
        select(ProductVariant).where(ProductVariant.version_id == version.id)
    ):
        await db.delete(fila)
    for fila in await db.scalars(
        select(ProductMedia).where(ProductMedia.version_id == version.id)
    ):
        await db.delete(fila)
    await db.flush()
    for v in variantes:
        db.add(ProductVariant(version_id=version.id, **v))
    for m in galeria:
        db.add(ProductMedia(version_id=version.id, created_by=version.created_by, **m))
    await db.flush()


async def variantes_de(db: AsyncSession, *, version_id: str) -> list[ProductVariant]:
    return list(
        await db.scalars(
            select(ProductVariant)
            .where(ProductVariant.version_id == version_id)
            .order_by(ProductVariant.position, ProductVariant.sku)
        )
    )


async def galeria_de(db: AsyncSession, *, version_id: str) -> list[ProductMedia]:
    return list(
        await db.scalars(
            select(ProductMedia)
            .where(ProductMedia.version_id == version_id)
            .order_by(ProductMedia.position, ProductMedia.id)
        )
    )


# --------------------------------------------------------------------------- #
# Mover el producto por su ciclo
# --------------------------------------------------------------------------- #
async def transicionar(
    db: AsyncSession,
    *,
    producto_id: str,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None = None,
) -> Product:
    """Mueve el producto, con UPDATE CONDICIONAL.

    LA CARRERA REAL: dos personas con el mismo producto abierto en pantalla. Las
    dos leen `evaluation`, las dos pulsan. Lo que impide que las dos escrituras
    cuenten no es el `if` de arriba sino el `where status = :desde`, que la base
    resuelve fila a fila: una cambia una fila y la otra cero.
    """
    await esquema.exigir_dominio(db)
    producto = await db.get(Product, producto_id)
    if producto is None:
        raise permissions.NoEsTuProducto("Producto no encontrado.")

    desde = producto.status
    maquina.exigir(desde, hasta, actor_rol)

    momento = ahora()
    valores: dict[str, Any] = {"status": hasta, "updated_at": momento}
    if hasta == SUSPENDIDO:
        if not (motivo or "").strip():
            raise ValidationAppError(
                "Suspender un producto necesita un motivo que se le pueda "
                "enseñar a quien lo vende.",
                code="product_suspension_needs_reason",
            )
        valores["suspended_at"] = momento
        valores["suspension_reason"] = motivo.strip()[:2000]
    if hasta == RETIRADO:
        valores["removed_at"] = momento
    if hasta == PUBLICADO:
        valores["published_at"] = momento

    async with db.begin_nested() as punto:
        cambiadas = await db.execute(
            update(Product)
            .where(Product.id == producto_id, Product.status == desde)
            .values(**valores)
        )
        if cambiadas.rowcount != 1:
            await punto.rollback()
    if cambiadas.rowcount != 1:
        raise ConflictError(
            "Alguien movió este producto mientras decidías. Vuelve a mirarlo.",
            code="product_changed",
            details={"expected": desde},
        )
    await db.refresh(producto)

    await auditoria.anotar(
        db,
        actor_id=actor_id,
        action="product.transition",
        entity_type="product",
        entity_id=producto_id,
        actor_role=maquina.ROL_DE_AUDITORIA.get(actor_rol, "system"),
        previous_state=desde,
        new_state=hasta,
        reason=(motivo.strip()[:500] if (motivo or "").strip() else None),
    )
    return producto


# --------------------------------------------------------------------------- #
# Publicar
# --------------------------------------------------------------------------- #
async def por_que_no_se_publica(
    db: AsyncSession, *, producto: Product
) -> tuple[str, dict] | None:
    """Qué falta para que este producto pueda llevar el sello de Z.

    UNA SOLA PUERTA, y devuelve un CÓDIGO. Repartir estas comprobaciones entre
    la ruta y la pantalla es cómo se publica algo sin evaluación el día que
    alguien añade un camino nuevo.
    """
    if producto.status != APROBADO:
        return "product_not_approved", {"status": producto.status}

    borrador = await borrador_de(db, producto_id=producto.id)
    if borrador is None:
        return "product_version_missing", {}

    fotos = await db.scalar(
        select(func.count())
        .select_from(ProductMedia)
        .where(ProductMedia.version_id == borrador.id)
    )
    if not fotos:
        # FOTOGRAFÍA REAL APROBADA (blueprint §3.1). Una ficha sin imagen no es
        # una tarjeta de producto, es un hueco.
        return "product_media_required", {}

    if not await esquema.hay_admision(db):
        # SIN LA 0071 NO HAY DÓNDE MIRAR LA EVALUACIÓN, y publicar sin poder
        # comprobarla sería publicar sin evaluación.
        return "product_admission_not_available", {}

    evaluacion = await db.scalar(
        select(ProductEvaluation)
        .where(
            ProductEvaluation.version_id == borrador.id,
            ProductEvaluation.status == EVALUACION_DECIDIDA,
            ProductEvaluation.decision == DECISION_APROBADO,
        )
        .order_by(ProductEvaluation.decided_at.desc())
    )
    if evaluacion is None:
        return "product_evaluation_required", {"version_id": borrador.id}

    razones = await db.scalar(
        select(func.count())
        .select_from(ProductApprovalReason)
        .where(ProductApprovalReason.version_id == borrador.id)
    )
    if int(razones or 0) != RAZONES_EXIGIDAS:
        # EXACTAMENTE TRES (blueprint §4.1). Dos razones y un hueco es una
        # promesa a medias; cuatro es un informe.
        return "product_reasons_required", {
            "expected": RAZONES_EXIGIDAS,
            "found": int(razones or 0),
        }
    return None


async def publicar(
    db: AsyncSession, *, producto_id: str, usuario_id: str
) -> tuple[Product, ProductVersion]:
    """Publica la versión borrador y supersede la anterior, EN LA MISMA
    TRANSACCIÓN.

    El estado intermedio de «ninguna vigente» o «dos vigentes» no puede existir:
    en el primero la ficha no tendría nada que enseñar y en el segundo el
    resultado dependería del orden de lectura.
    """
    await esquema.exigir_dominio(db)
    producto = await db.get(Product, producto_id)
    if producto is None:
        raise permissions.NoEsTuProducto("Producto no encontrado.")
    # ANTES QUE EL ROL: ni un administrador publica lo suyo.
    await permissions.exigir_ajeno(db, producto=producto, user_id=usuario_id)
    await permissions.exigir_publicador(db, usuario_id)

    falta = await por_que_no_se_publica(db, producto=producto)
    if falta is not None:
        codigo, detalles = falta
        raise ConflictError(
            "Este producto todavía no puede publicarse.",
            code=codigo,
            details=detalles,
        )

    borrador = await borrador_de(db, producto_id=producto_id)
    momento = ahora()

    vigente = await vigente_de(db, producto_id=producto_id)
    if vigente is not None:
        vigente.status = VERSION_SUPERADA
        vigente.effective_to = momento
        await db.flush()

    borrador.status = VERSION_PUBLICADA
    borrador.published_at = momento
    borrador.published_by = usuario_id
    borrador.effective_from = momento
    await db.flush()

    producto.published_version_id = borrador.id
    await db.flush()
    await transicionar(
        db,
        producto_id=producto_id,
        hasta=PUBLICADO,
        actor_id=usuario_id,
        actor_rol=maquina.ADMINISTRACION,
    )

    await auditoria.anotar(
        db,
        actor_id=usuario_id,
        action="product.publish",
        entity_type="product_version",
        entity_id=borrador.id,
        actor_role=maquina.ROL_DE_AUDITORIA[maquina.ADMINISTRACION],
        new_state=VERSION_PUBLICADA,
        payload={
            "product_id": producto_id,
            "version": borrador.version,
            "content_sha256": borrador.content_sha256,
            "superseded": vigente.id if vigente is not None else None,
        },
    )
    logger.info(
        "[productos] publicada la version %s del producto %s",
        borrador.version,
        producto_id,
    )
    return producto, borrador


async def mis_productos(
    db: AsyncSession, *, usuario_id: str, limite: int = 50
) -> list[Product]:
    """Los del responsable comercial de quien pregunta. Vacío si no lo es."""
    if not await esquema.hay_dominio(db):
        return []
    vendedor = await permissions.vendedor_de(db, usuario_id)
    if vendedor is None:
        return []
    return list(
        await db.scalars(
            select(Product)
            .where(Product.seller_id == vendedor.id)
            .order_by(Product.created_at.desc(), Product.id.desc())
            .limit(max(1, min(int(limite), 200)))
        )
    )


async def responsable_de(db: AsyncSession, *, producto: Product) -> ProductSeller | None:
    return await db.get(ProductSeller, producto.seller_id)


__all__ = [
    "CAMPOS_DE_LA_HUELLA",
    "MAXIMO_DE_FOTOS",
    "MAXIMO_DE_VARIANTES",
    "borrador_de",
    "crear",
    "galeria_de",
    "guardar_borrador",
    "huella",
    "mis_productos",
    "por_que_no_se_publica",
    "publicar",
    "responsable_de",
    "transicionar",
    "variantes_de",
    "vigente_de",
]
