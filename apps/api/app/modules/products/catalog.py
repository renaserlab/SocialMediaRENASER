"""El catálogo público: portada, búsqueda, categorías, ficha y guardados.

TODO LO SIRVE EL SERVIDOR. Qué cuenta como publicado, qué entra en la selección
y qué se puede enseñar de un producto no lo decide la aplicación: si lo decidiera
ella, bastaría una versión vieja instalada en un teléfono para que apareciera
algo que Z retiró.

LO QUE AQUÍ NO SE INVENTA, Y ES LA MITAD DEL TRABAJO:

  * NINGUNA VALORACIÓN. No hay reseñas de productos todavía —son de un
    incremento posterior— así que la ficha no trae media, ni histograma, ni
    «4,8 estrellas». Trae `null`, y la pantalla dice que aún no hay
    valoraciones.
  * NINGUNA COMPRA VERIFICADA. No hay pedidos físicos, así que no se puede
    contar ninguna.
  * NINGÚN PLAZO DE ENTREGA NI DE DEVOLUCIÓN. No hay transportista, ni
    cobertura, ni condiciones aprobadas. El bloque viaja vacío y la pantalla lo
    deja fuera.
  * NINGUNA SELECCIÓN EDITORIAL A MANO. «Selección Z» se ordena por la
    PUNTUACIÓN DE LA EVALUACIÓN APROBADA, que es un dato verificado. Una lista
    escrita a dedo sería una decisión de producto que nadie ha tomado.
  * «ELEGIDOS PARA TI» NO ESTÁ PERSONALIZADO. No hay recomendador de productos,
    y ordenar por lo más reciente y llamarlo «para ti» sería mentir con el
    título. El contrato manda `personalized: false` para que la pantalla ponga
    el título que corresponde.

EL ÚNICO INDICADOR DE CONFIANZA (blueprint §3.1) es el ORIGEN, porque es el
único de los cuatro que se puede demostrar hoy: recomendación y compras
verificadas necesitan reseñas y pedidos, y la garantía necesita condiciones
aprobadas.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.modules.products import esquema
from app.modules.products.models import (
    DECISION_APROBADO,
    EVALUACION_DECIDIDA,
    FOTO_APROBADA,
    Product,
    ProductApprovalReason,
    ProductCategory,
    ProductEvaluation,
    ProductEvaluationEvidence,
    ProductMedia,
    ProductSeller,
    ProductVariant,
    ProductVersion,
    SavedProduct,
)
from app.modules.products import media as fotos
from app.modules.products.states import EN_CATALOGO

#: EL TEXTO EXACTO del blueprint §4.1. Está aquí y no en la aplicación porque es
#: una promesa de la empresa: si cada pantalla lo escribiera, tres pantallas
#: dirían tres cosas parecidas.
SELLO = "Producto de Excelencia Z · Evaluado y aprobado por nuestro estándar"

#: La promesa pública (§1). Texto, no banner.
MANIFIESTO = "No está todo. Está lo que merece estar."

#: Cuántas tarjetas trae cada bloque de la portada. Dos columnas como máximo
#: (§3), así que un número par se pinta sin huecos.
POR_BLOQUE = 8

#: Tope de la búsqueda por página. Más que esto no se pinta de una vez.
POR_PAGINA = 20

#: Largo mínimo de una búsqueda. Con una letra se devuelve el catálogo entero y
#: parece un buscador que no filtra.
LARGO_MINIMO_DE_LA_BUSQUEDA = 2


@dataclass(frozen=True)
class Tarjeta:
    """Lo que se enseña de un producto en una lista. Nada más.

    `trust` es UNO SOLO (§3.1) y hoy solo puede ser `origin`: los otros tres
    necesitan datos que todavía no existen.
    """

    product_id: str
    name: str
    seller_id: str
    seller_name: str
    price_minor: int | None
    currency: str | None
    image_path: str | None
    trust: str | None
    trust_value: str | None
    saved: bool = False
    #: LA URL FIRMADA, emitida en el momento y con vencimiento. `null` cuando
    #: no hay foto aprobada o el almacenamiento no contesta: la pantalla enseña
    #: entonces el texto alternativo, que es la verdad y no un hueco.
    image_url: str | None = None
    image_alt: str | None = None


@dataclass(frozen=True)
class Portada:
    manifest: str = MANIFIESTO
    #: Ordenada por la puntuación de su evaluación aprobada.
    seleccion: list[Tarjeta] = field(default_factory=list)
    #: Lo más reciente. NO está personalizado, y el contrato lo dice.
    para_ti: list[Tarjeta] = field(default_factory=list)
    personalized: bool = False
    #: Responsables comerciales con algo publicado.
    creadores: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class Ficha:
    """El detalle, en el ORDEN INALTERABLE del blueprint §4.

    Los bloques que no tienen datos viajan vacíos o nulos; ninguno se rellena
    con un valor razonable.
    """

    product_id: str
    version_id: str
    version: str
    name: str
    summary: str | None
    description: str | None
    materials: str | None
    origin_country: str | None
    manufacturer: str | None
    price_minor: int | None
    currency: str | None
    content_sha256: str
    published_at: datetime | None
    status: str

    seller_id: str
    seller_name: str
    seller_profile_id: str

    gallery: list[dict] = field(default_factory=list)
    variants: list[dict] = field(default_factory=list)
    #: Las TRES razones, cada una con la evidencia que la respalda.
    reasons: list[dict] = field(default_factory=list)
    seal: str = SELLO
    #: El identificador del informe de evaluación que abre el sello.
    evaluation_id: str | None = None
    #: `null` porque no hay reseñas de productos todavía. NO es cero.
    rating: dict | None = None
    #: Vacío porque no hay condiciones de entrega ni devolución aprobadas.
    delivery: dict | None = None
    related: list[Tarjeta] = field(default_factory=list)
    saved: bool = False
    #: Si se puede comprar. HOY SIEMPRE `false`: no hay compra física.
    purchasable: bool = False


# --------------------------------------------------------------------------- #
# Piezas comunes
# --------------------------------------------------------------------------- #
def _en_catalogo():
    """El filtro de «visible en el catálogo». UNA SOLA VEZ, y se reutiliza.

    Repetirlo en cada consulta es cómo una de ellas se queda con `published` y
    deja fuera `observation`, o peor: incluye `suspended`.
    """
    return (
        Product.status.in_(tuple(EN_CATALOGO)),
        Product.published_version_id.is_not(None),
    )


def _confianza(version: ProductVersion) -> tuple[str | None, str | None]:
    """El único indicador de confianza que hoy se puede demostrar."""
    if version.origin_country:
        return "origin", version.origin_country
    if version.manufacturer:
        return "origin", version.manufacturer
    return None, None


async def _tarjetas(
    db: AsyncSession, filas: list[tuple], *, guardados: set[str]
) -> list[Tarjeta]:
    """Monta las tarjetas de una lista de `(producto, version, vendedor)`.

    LA PRIMERA IMAGEN APROBADA, EN UNA SOLA CONSULTA. Una por tarjeta serían
    nueve viajes para pintar una portada.

    SOLO LAS APROBADAS (0073). Una fotografía pendiente o rechazada no se firma
    y no se enseña: si se enseñara, aprobar el producto aprobaría también
    cualquier imagen que le añadieran después.
    """
    if not filas:
        return []
    versiones = [v.id for _, v, _ in filas]
    primeras: dict[str, tuple[str, str | None]] = {}
    if versiones:
        for version_id, ruta, alt in (
            await db.execute(
                select(
                    ProductMedia.version_id,
                    ProductMedia.storage_path,
                    ProductMedia.alt_text,
                )
                .where(
                    ProductMedia.version_id.in_(versiones),
                    ProductMedia.status == FOTO_APROBADA,
                )
                .order_by(ProductMedia.version_id, ProductMedia.position, ProductMedia.id)
            )
        ).all():
            primeras.setdefault(version_id, (ruta, alt))

    #: UNA SOLA FIRMA PARA TODA LA LISTA. Y si el almacenamiento no contesta,
    #: `firmar` devuelve un diccionario vacío en vez de tumbar la portada.
    firmadas = await fotos.firmar([r for r, _ in primeras.values()])

    tarjetas: list[Tarjeta] = []
    for producto, version, vendedor in filas:
        clase, valor = _confianza(version)
        ruta, alt = primeras.get(version.id, (None, None))
        tarjetas.append(
            Tarjeta(
                product_id=producto.id,
                name=version.name,
                seller_id=vendedor.id,
                seller_name=vendedor.display_name,
                price_minor=version.price_minor,
                currency=version.currency,
                image_path=ruta,
                trust=clase,
                trust_value=valor,
                saved=producto.id in guardados,
                image_url=firmadas.get(ruta) if ruta else None,
                image_alt=alt,
            )
        )
    return tarjetas


async def _guardados_de(
    db: AsyncSession, *, usuario_id: str | None, productos: list[str]
) -> set[str]:
    if not usuario_id or not productos or not await esquema.hay_guardados(db):
        return set()
    return set(
        await db.scalars(
            select(SavedProduct.product_id).where(
                SavedProduct.user_id == usuario_id,
                SavedProduct.product_id.in_(productos),
            )
        )
    )


def _base():
    """`(producto, version publicada, vendedor)` de lo que está en catálogo."""
    return (
        select(Product, ProductVersion, ProductSeller)
        .join(ProductVersion, ProductVersion.id == Product.published_version_id)
        .join(ProductSeller, ProductSeller.id == Product.seller_id)
        .where(*_en_catalogo())
    )


# --------------------------------------------------------------------------- #
# Portada
# --------------------------------------------------------------------------- #
async def portada(db: AsyncSession, *, usuario_id: str | None = None) -> Portada:
    """Los tres bloques del blueprint §3. Vacíos si no hay nada publicado."""
    if not await esquema.hay_dominio(db):
        return Portada()

    #: LA SELECCIÓN, POR PUNTUACIÓN DE EVALUACIÓN APROBADA. Es un dato
    #: verificado; una lista a dedo sería una decisión que nadie ha tomado.
    seleccion: list[tuple] = []
    if await esquema.hay_admision(db):
        seleccion = list(
            (
                await db.execute(
                    _base()
                    .join(
                        ProductEvaluation,
                        ProductEvaluation.version_id == Product.published_version_id,
                    )
                    .where(
                        ProductEvaluation.status == EVALUACION_DECIDIDA,
                        ProductEvaluation.decision == DECISION_APROBADO,
                        ProductEvaluation.score_total.is_not(None),
                    )
                    .order_by(
                        ProductEvaluation.score_total.desc(),
                        Product.published_at.desc(),
                        Product.id.desc(),
                    )
                    .limit(POR_BLOQUE)
                )
            ).all()
        )

    recientes = list(
        (
            await db.execute(
                _base()
                .order_by(Product.published_at.desc(), Product.id.desc())
                .limit(POR_BLOQUE)
            )
        ).all()
    )

    todos = [p.id for p, _, _ in seleccion] + [p.id for p, _, _ in recientes]
    guardados = await _guardados_de(db, usuario_id=usuario_id, productos=todos)

    #: CREADORES DE EXCELENCIA: los que tienen algo publicado. Con su propuesta
    #: —el resumen de su producto más reciente— porque un creador sin nada que
    #: enseñar es una tarjeta vacía.
    creadores: list[dict] = []
    vistos: set[str] = set()
    for producto, version, vendedor in recientes + seleccion:
        if vendedor.id in vistos:
            continue
        vistos.add(vendedor.id)
        creadores.append(
            {
                "seller_id": vendedor.id,
                "profile_id": vendedor.profile_id,
                "name": vendedor.display_name,
                "proposal": version.summary,
                "product_id": producto.id,
            }
        )

    return Portada(
        seleccion=await _tarjetas(db, seleccion, guardados=guardados),
        para_ti=await _tarjetas(db, recientes, guardados=guardados),
        personalized=False,
        creadores=creadores[:POR_BLOQUE],
    )


# --------------------------------------------------------------------------- #
# Búsqueda y categorías
# --------------------------------------------------------------------------- #
async def categorias(db: AsyncSession) -> list[ProductCategory]:
    """Las activas. VACÍO significa que la empresa no las ha definido."""
    if not await esquema.hay_dominio(db):
        return []
    return list(
        await db.scalars(
            select(ProductCategory)
            .where(ProductCategory.active.is_(True))
            .order_by(ProductCategory.position, ProductCategory.slug)
        )
    )


async def buscar(
    db: AsyncSession,
    *,
    q: str | None = None,
    category_id: str | None = None,
    usuario_id: str | None = None,
    cursor: str | None = None,
    limite: int = POR_PAGINA,
) -> tuple[list[Tarjeta], str | None]:
    """Busca en lo publicado. EL FILTRO LO APLICA EL SERVIDOR.

    Devuelve las tarjetas y el cursor de la página siguiente, o `None` si se
    acabó. El cursor es el identificador del último producto: paginar por
    desplazamiento repite y se salta filas cuando alguien publica a mitad.
    """
    if not await esquema.hay_dominio(db):
        return [], None

    consulta = _base()
    texto = (q or "").strip()
    if texto:
        if len(texto) < LARGO_MINIMO_DE_LA_BUSQUEDA:
            # CON UNA LETRA NO SE BUSCA. Devolver el catálogo entero parecería
            # un buscador que no filtra.
            return [], None
        patron = f"%{texto}%"
        consulta = consulta.where(
            or_(
                ProductVersion.name.ilike(patron),
                ProductVersion.summary.ilike(patron),
                ProductVersion.materials.ilike(patron),
                ProductVersion.manufacturer.ilike(patron),
                ProductSeller.display_name.ilike(patron),
            )
        )
    if category_id:
        consulta = consulta.where(Product.category_id == category_id)

    tope = max(1, min(int(limite), POR_PAGINA))
    if cursor:
        ancla = await db.get(Product, cursor)
        if ancla is None or ancla.published_at is None:
            # UN CURSOR QUE YA NO EXISTE no es un error del cliente: el producto
            # pudo retirarse entre dos páginas. Se empieza de nuevo.
            cursor = None
        else:
            consulta = consulta.where(
                or_(
                    Product.published_at < ancla.published_at,
                    (Product.published_at == ancla.published_at)
                    & (Product.id < ancla.id),
                )
            )

    filas = list(
        (
            await db.execute(
                consulta.order_by(
                    Product.published_at.desc(), Product.id.desc()
                ).limit(tope + 1)
            )
        ).all()
    )
    hay_mas = len(filas) > tope
    filas = filas[:tope]
    guardados = await _guardados_de(
        db, usuario_id=usuario_id, productos=[p.id for p, _, _ in filas]
    )
    siguiente = filas[-1][0].id if hay_mas and filas else None
    return await _tarjetas(db, filas, guardados=guardados), siguiente


# --------------------------------------------------------------------------- #
# La ficha
# --------------------------------------------------------------------------- #
async def ficha(
    db: AsyncSession, *, producto_id: str, usuario_id: str | None = None
) -> Ficha:
    """El detalle de un producto publicado. 404 si no lo está.

    NO SE ENSEÑA UN BORRADOR NI UN SUSPENDIDO. Que exista una ficha de algo que
    Z no publicó es cómo se acaba compartiendo un enlace a un producto retirado.
    """
    await esquema.exigir_dominio(db)
    fila = (
        await db.execute(_base().where(Product.id == producto_id))
    ).first()
    if fila is None:
        raise NotFoundError("Producto no encontrado.", code="product_not_found")
    producto, version, vendedor = fila

    aprobadas = list(
        await db.scalars(
            select(ProductMedia)
            .where(
                ProductMedia.version_id == version.id,
                ProductMedia.status == FOTO_APROBADA,
            )
            .order_by(ProductMedia.position, ProductMedia.id)
        )
    )
    firmadas = await fotos.firmar([m.storage_path for m in aprobadas])
    galeria = [
        {
            "id": m.id,
            "kind": m.kind,
            "storage_path": m.storage_path,
            "alt_text": m.alt_text,
            # LA URL SE EMITE AHORA Y CADUCA. Guardarla haría que la galería
            # dejara de cargar sin que nadie tocara nada.
            "url": firmadas.get(m.storage_path),
            "width": m.width,
            "height": m.height,
        }
        for m in aprobadas
    ]
    variantes = [
        {
            "id": v.id,
            "sku": v.sku,
            "name": v.name,
            "options": dict(v.options or {}),
            "price_delta_minor": v.price_delta_minor,
        }
        for v in await db.scalars(
            select(ProductVariant)
            .where(ProductVariant.version_id == version.id)
            .order_by(ProductVariant.position, ProductVariant.sku)
        )
    ]

    razones: list[dict] = []
    evaluacion_id: str | None = None
    if await esquema.hay_admision(db):
        for razon, evidencia in (
            await db.execute(
                select(ProductApprovalReason, ProductEvaluationEvidence)
                .join(
                    ProductEvaluationEvidence,
                    ProductEvaluationEvidence.id == ProductApprovalReason.evidence_id,
                )
                .where(ProductApprovalReason.version_id == version.id)
                .order_by(ProductApprovalReason.position)
            )
        ).all():
            evaluacion_id = razon.evaluation_id
            razones.append(
                {
                    "position": razon.position,
                    "text": razon.text,
                    # DE QUÉ SALE. Es lo que hace que la razón se pueda
                    # comprobar en vez de creer.
                    "evidence_kind": evidencia.kind,
                    "evidence_dimension": evidencia.dimension,
                }
            )

    guardados = await _guardados_de(
        db, usuario_id=usuario_id, productos=[producto.id]
    )
    return Ficha(
        product_id=producto.id,
        version_id=version.id,
        version=version.version,
        name=version.name,
        summary=version.summary,
        description=version.description,
        materials=version.materials,
        origin_country=version.origin_country,
        manufacturer=version.manufacturer,
        price_minor=version.price_minor,
        currency=version.currency,
        content_sha256=version.content_sha256,
        published_at=version.published_at,
        status=producto.status,
        seller_id=vendedor.id,
        seller_name=vendedor.display_name,
        seller_profile_id=vendedor.profile_id,
        gallery=galeria,
        variants=variantes,
        reasons=razones,
        evaluation_id=evaluacion_id,
        # NULOS A PROPÓSITO: ver la cabecera del módulo.
        rating=None,
        delivery=None,
        related=await relacionados(db, producto=producto, usuario_id=usuario_id),
        saved=producto.id in guardados,
        #: SE CALCULA, COMO EN LA BOLSA, y no se escribe a fuego. Estaba en
        #: `False` fijo: el dia que se encendieran las ventas, la ficha seguiria
        #: diciendo «en Z todavia no se compran productos» con el recorrido
        #: entero hasta la pasarela funcionando debajo. Encender Stripe tiene
        #: que ser configuracion y nada mas.
        #:
        #: Son las MISMAS cinco condiciones que usa la ruta de pago, leidas del
        #: mismo sitio. El inventario y la politica del pais los comprueban la
        #: bolsa y el checkout, que son los que saben de que variante y de que
        #: direccion se habla.
        purchasable=_se_vende_hoy(),
    )


def _se_vende_hoy() -> bool:
    """Si la venta de productos fisicos esta encendida de verdad, hoy."""
    #: Importacion local: `pedidos` importa `carts`, y aqui no hace falta nada
    #: mas que esta pregunta.
    from app.modules.products import pedidos

    return not pedidos.por_que_no_se_puede_vender()


async def relacionados(
    db: AsyncSession,
    *,
    producto: Product,
    usuario_id: str | None = None,
    limite: int = 6,
) -> list[Tarjeta]:
    """Otros de la misma categoría. Sin categoría, los más recientes.

    NO ES UN RECOMENDADOR. Es lo que se puede decir con los datos que hay, y se
    llama «relacionados» y no «para ti» por eso mismo.
    """
    consulta = _base().where(Product.id != producto.id)
    if producto.category_id:
        consulta = consulta.where(Product.category_id == producto.category_id)
    filas = list(
        (
            await db.execute(
                consulta.order_by(
                    Product.published_at.desc(), Product.id.desc()
                ).limit(max(1, min(int(limite), POR_BLOQUE)))
            )
        ).all()
    )
    guardados = await _guardados_de(
        db, usuario_id=usuario_id, productos=[p.id for p, _, _ in filas]
    )
    return await _tarjetas(db, filas, guardados=guardados)


async def informe_de_evaluacion(
    db: AsyncSession, *, producto_id: str
) -> dict | None:
    """El informe que abre el sello. SOLO DE LA VERSIÓN PUBLICADA.

    Se enseña la puntuación, la decisión y qué evidencia se miró en cada
    dimensión. NO se enseña la nota interna del evaluador: es para uso interno,
    igual que en los expedientes de eventos.
    """
    await esquema.exigir_dominio(db)
    if not await esquema.hay_admision(db):
        return None
    fila = (await db.execute(_base().where(Product.id == producto_id))).first()
    if fila is None:
        raise NotFoundError("Producto no encontrado.", code="product_not_found")
    _, version, _ = fila

    evaluacion = await db.scalar(
        select(ProductEvaluation)
        .where(
            ProductEvaluation.version_id == version.id,
            ProductEvaluation.status == EVALUACION_DECIDIDA,
            ProductEvaluation.decision == DECISION_APROBADO,
        )
        .order_by(ProductEvaluation.decided_at.desc())
    )
    if evaluacion is None:
        return None

    dimensiones: dict[str, dict] = {}
    for e in await db.scalars(
        select(ProductEvaluationEvidence).where(
            ProductEvaluationEvidence.evaluation_id == evaluacion.id
        )
    ):
        entrada = dimensiones.setdefault(e.dimension, {"evidence": []})
        entrada["evidence"].append({"kind": e.kind, "summary": e.summary})
    from app.modules.products.models import ProductEvaluationScore

    for s in await db.scalars(
        select(ProductEvaluationScore).where(
            ProductEvaluationScore.evaluation_id == evaluacion.id
        )
    ):
        entrada = dimensiones.setdefault(s.dimension, {"evidence": []})
        entrada["score"] = s.score
        entrada["weight"] = s.weight

    return {
        "evaluation_id": evaluacion.id,
        "version_id": version.id,
        "seal": SELLO,
        "decision": evaluacion.decision,
        #: En centésimas de punto: 9 000 son 90,00. La pantalla decide cómo lo
        #: escribe; el servidor no manda un texto con coma.
        "score_total": evaluacion.score_total,
        "decided_at": evaluacion.decided_at,
        "dimensions": dimensiones,
    }


# --------------------------------------------------------------------------- #
# Guardados
# --------------------------------------------------------------------------- #
async def guardar(db: AsyncSession, *, producto_id: str, usuario_id: str) -> bool:
    """Guarda el producto. IDEMPOTENTE: guardar dos veces es guardar una.

    Solo lo publicado: guardar un borrador ajeno sería enterarse de que existe.
    """
    await esquema.exigir_guardados(db)
    fila = (await db.execute(_base().where(Product.id == producto_id))).first()
    if fila is None:
        raise NotFoundError("Producto no encontrado.", code="product_not_found")
    ya = await db.get(SavedProduct, (usuario_id, producto_id))
    if ya is not None:
        return False
    db.add(SavedProduct(user_id=usuario_id, product_id=producto_id))
    await db.flush()
    return True


async def quitar(db: AsyncSession, *, producto_id: str, usuario_id: str) -> bool:
    """Lo quita de guardados. Quitar lo que no está tampoco es un error."""
    await esquema.exigir_guardados(db)
    fila = await db.get(SavedProduct, (usuario_id, producto_id))
    if fila is None:
        return False
    await db.delete(fila)
    await db.flush()
    return True


async def guardados(
    db: AsyncSession, *, usuario_id: str, limite: int = POR_PAGINA
) -> list[Tarjeta]:
    """Lo que guardó esta persona, y que sigue publicado.

    UN PRODUCTO RETIRADO NO SE ENSEÑA aunque esté guardado: la fila se conserva
    —por si vuelve— pero la lista no promete algo que ya no está.
    """
    if not await esquema.hay_guardados(db):
        return []
    filas = list(
        (
            await db.execute(
                _base()
                .join(SavedProduct, SavedProduct.product_id == Product.id)
                .where(SavedProduct.user_id == usuario_id)
                .order_by(SavedProduct.created_at.desc(), Product.id.desc())
                .limit(max(1, min(int(limite), 200)))
            )
        ).all()
    )
    return await _tarjetas(
        db, filas, guardados={p.id for p, _, _ in filas}
    )


async def cuantos_guardados(db: AsyncSession, *, usuario_id: str) -> int:
    if not await esquema.hay_guardados(db):
        return 0
    return int(
        await db.scalar(
            select(func.count())
            .select_from(SavedProduct)
            .where(SavedProduct.user_id == usuario_id)
        )
        or 0
    )


__all__ = [
    "LARGO_MINIMO_DE_LA_BUSQUEDA",
    "MANIFIESTO",
    "POR_BLOQUE",
    "POR_PAGINA",
    "SELLO",
    "Ficha",
    "Portada",
    "Tarjeta",
    "buscar",
    "categorias",
    "cuantos_guardados",
    "ficha",
    "guardados",
    "guardar",
    "informe_de_evaluacion",
    "portada",
    "quitar",
    "relacionados",
]
