"""La API de Productos.

EL ORDEN DE LAS RUTAS IMPORTA. `/products/categories` va ANTES de
`/products/{product_id}`, y las del proveedor antes también: si no, FastAPI
resolvería `categories` como un identificador de producto y la pantalla recibiría
un 404 sin saber por qué.

QUIÉN PUEDE QUÉ LO DECIDE EL SERVIDOR. Cada ruta comprueba la propiedad del
producto y el rol de quien llama, y en las de administración el ROL VA ANTES DE
LA PUERTA DE ESQUEMA: si fuera al revés, una cuenta sin permisos distinguiría un
503 de un 403 y averiguaría qué migraciones están aplicadas en producción.

Y NINGUNA RUTA DE COMPRA. No hay carrito, ni checkout, ni pedido: eso es de
incrementos posteriores, y una ruta vacía que devolviera 501 ya sería una promesa.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ServiceUnavailableError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.gobernanza import auditoria
from app.modules.products import applications, carts, catalog, esquema, evaluations
from app.modules.products import inventory as almacen
from app.modules.products import media as fotos
from app.modules.products import permissions as permisos
from app.modules.products import service
from app.modules.products import states as maquina
from app.modules.products.models import (
    ACTOR_ADMINISTRACION,
    ACTOR_PROVEEDOR,
    DIMENSIONES,
    MAXIMO_BYTES_DE_LA_FOTO,
    MAXIMO_DE_FOTOS,
    Product,
    ProductMedia,
    ProductSeller,
    ProductVersion,
)
from app.modules.products.schemas import (
    AjusteRequest,
    AnadirAlCarrito,
    BusquedaRead,
    CantidadDeLaLinea,
    CarritoRead,
    ContadoresRead,
    DecisionDeLaFoto,
    EntradaRequest,
    ExistenciasRead,
    FotoDelProveedor,
    FotoPendiente,
    InventarioRead,
    LineaDelCarrito,
    MovimientoRead,
    OrdenDeLasFotos,
    UnidadDeInventario,
    CategoriaRead,
    CategoriasRead,
    CreadorRead,
    DecisionDeEvaluacion,
    DecisionDePostulacion,
    DocumentoRead,
    EstadoDelProveedor,
    EvaluacionRead,
    EvidenciaRead,
    EvidenciaRequest,
    FichaRead,
    GuardadoRead,
    InformeRead,
    MediaRead,
    MotivoRequest,
    PortadaRead,
    PostulacionRead,
    PostulacionRequest,
    ProductoDeAdministracion,
    ProductoDelProveedor,
    ProductoNuevoRequest,
    PuntuacionRead,
    PuntuacionRequest,
    RazonRead,
    RazonesRequest,
    TarjetaRead,
    TransicionRequest,
    VarianteRead,
    VersionRead,
    VersionRequest,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(prefix="/products", tags=["products"])
admin_router = APIRouter(prefix="/admin/products", tags=["products-admin"])


# --------------------------------------------------------------------------- #
# Moldes
# --------------------------------------------------------------------------- #
def _tarjeta(t: catalog.Tarjeta) -> TarjetaRead:
    return TarjetaRead(**t.__dict__)


def _carrito(c: carts.Carrito) -> CarritoRead:
    return CarritoRead(
        items=[LineaDelCarrito(**linea.__dict__) for linea in c.items],
        currency=c.currency,
        subtotal_minor=c.subtotal_minor,
        units=c.units,
        lines=c.lines,
        blocked_lines=c.blocked_lines,
        #: NO SE LEE DE `c`: se escribe aquí para que encender la compra tenga
        #: que pasar por este fichero y no por un campo que alguien copie.
        purchasable=False,
        disponible=c.disponible,
    )


async def _version_leida(
    db: AsyncSession, version: ProductVersion | None
) -> VersionRead | None:
    if version is None:
        return None
    return VersionRead(
        id=version.id,
        version=version.version,
        status=version.status,
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
        effective_to=version.effective_to,
        variants=[
            VarianteRead(
                id=v.id,
                sku=v.sku,
                name=v.name,
                options=dict(v.options or {}),
                price_delta_minor=v.price_delta_minor,
            )
            for v in await service.variantes_de(db, version_id=version.id)
        ],
        gallery=await _galeria_del_proveedor(db, version_id=version.id),
    )


async def _galeria_del_proveedor(
    db: AsyncSession, *, version_id: str
) -> list[FotoDelProveedor]:
    """Las fotografias como las ve quien las subio: CON su estado.

    Se firman TODAS, no solo las aprobadas: quien vende tiene que poder mirar la
    que le rechazaron para entender el motivo. En el catalogo solo se firman las
    aprobadas, y esa diferencia es el punto.
    """
    filas = await service.galeria_de(db, version_id=version_id)
    firmadas = await fotos.firmar([m.storage_path for m in filas])
    return [
        FotoDelProveedor(
            id=m.id,
            kind=m.kind,
            storage_path=m.storage_path,
            alt_text=m.alt_text,
            position=m.position,
            status=getattr(m, "status", "pending"),
            content_type=getattr(m, "content_type", None),
            byte_size=getattr(m, "byte_size", None),
            width=getattr(m, "width", None),
            height=getattr(m, "height", None),
            url=firmadas.get(m.storage_path),
            reviewed_at=getattr(m, "reviewed_at", None),
            rejection_reason=getattr(m, "rejection_reason", None),
            created_at=m.created_at,
        )
        for m in filas
    ]


async def _del_proveedor(
    db: AsyncSession, producto: Product, *, actor: str
) -> ProductoDelProveedor:
    bloqueo = await service.por_que_no_se_publica(db, producto=producto)
    return ProductoDelProveedor(
        id=producto.id,
        status=producto.status,
        category_id=producto.category_id,
        published_at=producto.published_at,
        suspension_reason=producto.suspension_reason,
        created_at=producto.created_at,
        draft=await _version_leida(
            db, await service.borrador_de(db, producto_id=producto.id)
        ),
        published=await _version_leida(
            db, await service.vigente_de(db, producto_id=producto.id)
        ),
        acciones=list(maquina.siguientes(producto.status, actor)),
        bloqueo=bloqueo[0] if bloqueo is not None else None,
    )


def _postulacion(
    postulacion: applications.SellerApplication, documentos: list
) -> PostulacionRead:
    return PostulacionRead(
        id=postulacion.id,
        status=postulacion.status,
        display_name=postulacion.display_name,
        proposal=postulacion.proposal,
        submitted_at=postulacion.submitted_at,
        decided_at=postulacion.decided_at,
        decision_reason=postulacion.decision_reason,
        documents=[
            DocumentoRead(
                id=d.id, kind=d.kind, storage_path=d.storage_path, note=d.note
            )
            for d in documentos
        ],
    )


# --------------------------------------------------------------------------- #
# Catálogo. Rutas estáticas ANTES de `/{product_id}`.
# --------------------------------------------------------------------------- #
@router.get("", response_model=PortadaRead)
async def portada(
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> PortadaRead:
    """La portada de Productos Z. ANÓNIMA: el catálogo se puede mirar sin entrar.

    Sin las migraciones aplicadas contesta `disponible: false` con los bloques
    vacíos, y no un 503: la portada es la puerta de entrada y un error aquí
    parecería que la aplicación está rota.
    """
    p = await catalog.portada(
        db, usuario_id=current_user.id if current_user else None
    )
    return PortadaRead(
        manifest=p.manifest,
        seleccion=[_tarjeta(t) for t in p.seleccion],
        para_ti=[_tarjeta(t) for t in p.para_ti],
        personalized=p.personalized,
        creadores=[CreadorRead(**c) for c in p.creadores],
        disponible=await esquema.hay_dominio(db),
    )


@router.get("/search", response_model=BusquedaRead)
async def buscar(
    q: str | None = Query(default=None, max_length=120),
    category_id: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=catalog.POR_PAGINA, ge=1, le=catalog.POR_PAGINA),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> BusquedaRead:
    """Busca en lo publicado. EL FILTRO LO APLICA EL SERVIDOR."""
    if category_id:
        ensure_uuid(category_id, "Categoría no encontrada.")
    if cursor:
        ensure_uuid(cursor, "Página no encontrada.")
    items, siguiente = await catalog.buscar(
        db,
        q=q,
        category_id=category_id,
        usuario_id=current_user.id if current_user else None,
        cursor=cursor,
        limite=limit,
    )
    return BusquedaRead(
        items=[_tarjeta(t) for t in items], next_cursor=siguiente
    )


@router.get("/categories", response_model=CategoriasRead)
async def categorias(db: AsyncSession = Depends(get_db)) -> CategoriasRead:
    """Las categorías activas. VACÍO = la empresa no las ha definido."""
    return CategoriasRead(
        items=[
            CategoriaRead(id=c.id, slug=c.slug, name=c.name, position=c.position)
            for c in await catalog.categorias(db)
        ]
    )


@router.get("/saved", response_model=list[TarjetaRead])
async def mis_guardados(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TarjetaRead]:
    """Lo que guardé, y que sigue publicado."""
    return [
        _tarjeta(t) for t in await catalog.guardados(db, usuario_id=current_user.id)
    ]


# --------------------------------------------------------------------------- #
# Proveedor. También ANTES de `/{product_id}`.
# --------------------------------------------------------------------------- #
@router.get("/seller/application", response_model=EstadoDelProveedor)
async def mi_postulacion(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EstadoDelProveedor:
    """Dónde estoy: sin postular, en revisión, aceptado o rechazado con motivo."""
    disponible = await esquema.hay_admision(db) and await esquema.hay_dominio(db)
    vendedor = (
        await permisos.vendedor_de(db, current_user.id)
        if await esquema.hay_dominio(db)
        else None
    )
    postulacion = await applications.mia(db, usuario_id=current_user.id)
    documentos = (
        await applications.documentos_de(db, postulacion_id=postulacion.id)
        if postulacion is not None
        else []
    )
    activo = vendedor is not None and vendedor.status == "active"
    viva = postulacion is not None and postulacion.status in (
        applications.POSTULACION_BORRADOR,
        applications.POSTULACION_ENVIADA,
        applications.POSTULACION_EN_REVISION,
    )
    return EstadoDelProveedor(
        seller_status=vendedor.status if vendedor is not None else None,
        seller_id=vendedor.id if vendedor is not None else None,
        application=(
            _postulacion(postulacion, documentos) if postulacion is not None else None
        ),
        puede_postular=disponible and not activo and not viva,
        disponible=disponible,
    )


@router.put("/seller/application", response_model=PostulacionRead)
async def guardar_postulacion(
    cuerpo: PostulacionRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostulacionRead:
    """Escribe o reescribe el borrador. UNA VIVA por perfil."""
    postulacion = await applications.guardar(
        db,
        usuario_id=current_user.id,
        display_name=cuerpo.display_name,
        proposal=cuerpo.proposal,
        documentos=[d.model_dump() for d in cuerpo.documents],
    )
    await db.commit()
    return _postulacion(
        postulacion,
        await applications.documentos_de(db, postulacion_id=postulacion.id),
    )


@router.post("/seller/application/submit", response_model=PostulacionRead)
async def enviar_postulacion(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostulacionRead:
    postulacion = await applications.mia(db, usuario_id=current_user.id)
    if postulacion is None:
        raise applications.PostulacionNoEncontrada("Postulación no encontrada.")
    await applications.enviar(
        db, postulacion_id=postulacion.id, usuario_id=current_user.id
    )
    await db.commit()
    return _postulacion(
        postulacion,
        await applications.documentos_de(db, postulacion_id=postulacion.id),
    )


@router.post("/seller/application/withdraw", response_model=PostulacionRead)
async def retirar_postulacion(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostulacionRead:
    postulacion = await applications.mia(db, usuario_id=current_user.id)
    if postulacion is None:
        raise applications.PostulacionNoEncontrada("Postulación no encontrada.")
    await applications.retirar(
        db, postulacion_id=postulacion.id, usuario_id=current_user.id
    )
    await db.commit()
    return _postulacion(
        postulacion,
        await applications.documentos_de(db, postulacion_id=postulacion.id),
    )


@router.get("/seller/products", response_model=list[ProductoDelProveedor])
async def mis_productos(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProductoDelProveedor]:
    """Los míos. Lista vacía si todavía no soy responsable comercial."""
    return [
        await _del_proveedor(db, p, actor=maquina.PROVEEDOR)
        for p in await service.mis_productos(db, usuario_id=current_user.id)
    ]


@router.post("/seller/products", response_model=ProductoDelProveedor, status_code=201)
async def crear_producto(
    cuerpo: ProductoNuevoRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    """Un producto nuevo nace BORRADOR. Crear no es publicar."""
    if cuerpo.category_id:
        ensure_uuid(cuerpo.category_id, "Categoría no encontrada.")
    datos = cuerpo.model_dump()
    producto, _ = await service.crear(
        db,
        usuario_id=current_user.id,
        datos=datos,
        category_id=cuerpo.category_id,
        variantes=[v.model_dump() for v in cuerpo.variants],
    )
    await db.commit()
    return await _del_proveedor(db, producto, actor=maquina.PROVEEDOR)


@router.get("/seller/products/{product_id}", response_model=ProductoDelProveedor)
async def mi_producto(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    await esquema.exigir_dominio(db)
    ensure_uuid(product_id, "Producto no encontrado.")
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    return await _del_proveedor(db, producto, actor=maquina.PROVEEDOR)


@router.put("/seller/products/{product_id}/draft", response_model=ProductoDelProveedor)
async def guardar_borrador(
    product_id: str,
    cuerpo: VersionRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    """Reescribe el borrador. SOLO mientras el producto sea editable."""
    ensure_uuid(product_id, "Producto no encontrado.")
    await service.guardar_borrador(
        db,
        producto_id=product_id,
        usuario_id=current_user.id,
        datos=cuerpo.model_dump(),
        variantes=[v.model_dump() for v in cuerpo.variants],
    )
    await db.commit()
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    return await _del_proveedor(db, producto, actor=maquina.PROVEEDOR)


@router.post("/seller/products/{product_id}/submit", response_model=ProductoDelProveedor)
async def postular_producto(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    """«Postula tu producto». Lo manda a admisión y deja de ser editable."""
    ensure_uuid(product_id, "Producto no encontrado.")
    await permisos.exigir_vendedor_activo(db, current_user.id)
    await permisos.exigir_mio(db, producto_id=product_id, user_id=current_user.id)
    producto = await service.transicionar(
        db,
        producto_id=product_id,
        hasta="submitted",
        actor_id=current_user.id,
        actor_rol=maquina.PROVEEDOR,
    )
    await db.commit()
    return await _del_proveedor(db, producto, actor=maquina.PROVEEDOR)


@router.post("/seller/products/{product_id}/withdraw", response_model=ProductoDelProveedor)
async def retirar_producto(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    """Lo devuelve a borrador. Solo mientras nadie lo haya mirado."""
    ensure_uuid(product_id, "Producto no encontrado.")
    await permisos.exigir_mio(db, producto_id=product_id, user_id=current_user.id)
    producto = await service.transicionar(
        db,
        producto_id=product_id,
        hasta="draft",
        actor_id=current_user.id,
        actor_rol=maquina.PROVEEDOR,
    )
    await db.commit()
    return await _del_proveedor(db, producto, actor=maquina.PROVEEDOR)


# --------------------------------------------------------------------------- #
# Fotografías del borrador (0073)
#
# EL ARCHIVO VIAJA AQUÍ, NO AL ALMACENAMIENTO. El depósito `product-media` es
# privado y no tiene ninguna política: la aplicación no puede escribir en él ni
# leerlo. Esta ruta comprueba de quién es el borrador, mira los bytes, genera el
# nombre y escribe con la clave de servicio, que nunca sale del servidor.
# --------------------------------------------------------------------------- #
@router.get(
    "/seller/products/{product_id}/media", response_model=list[FotoDelProveedor]
)
async def mis_fotos(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FotoDelProveedor]:
    """Las fotografías del borrador, CON su estado y el motivo del rechazo."""
    ensure_uuid(product_id, "Producto no encontrado.")
    await esquema.exigir_fotografias(db)
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    borrador = await service.borrador_de(db, producto_id=producto.id)
    if borrador is None:
        return []
    return await _galeria_del_proveedor(db, version_id=borrador.id)


@router.post(
    "/seller/products/{product_id}/media",
    response_model=FotoDelProveedor,
    status_code=201,
)
async def subir_foto(
    product_id: str,
    archivo: UploadFile = File(..., alias="file"),
    alt_text: str = Form(...),
    idempotency_key: str | None = Header(
        default=None, alias="Idempotency-Key", max_length=200
    ),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FotoDelProveedor:
    """Sube una fotografía al borrador. NACE PENDIENTE de aprobación.

    NO SE ACEPTA UNA RUTA: se acepta el archivo. Antes quien vendía escribía la
    ruta del almacenamiento a mano, y eso permitía apuntar a un archivo ajeno o
    a ninguno.
    """
    ensure_uuid(product_id, "Producto no encontrado.")
    await permisos.exigir_vendedor_activo(db, current_user.id)
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    #: SE LEE CON TOPE. Sin él, un archivo enorme se carga entero en memoria
    #: antes de que nadie pueda decir que pesa demasiado.
    datos = await archivo.read(MAXIMO_BYTES_DE_LA_FOTO + 1)
    fila = await fotos.subir(
        db,
        producto=producto,
        datos=datos,
        declarado=archivo.content_type,
        alt_text=alt_text,
        actor_id=current_user.id,
        clave=idempotency_key,
    )
    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        actor_role="user",
        action="product_media.upload",
        entity_type="product",
        entity_id=producto.id,
        payload={"media_id": fila.id, "byte_size": fila.byte_size},
    )
    await db.commit()
    galeria = await _galeria_del_proveedor(db, version_id=fila.version_id)
    return next(f for f in galeria if f.id == fila.id)


@router.put(
    "/seller/products/{product_id}/media/order",
    response_model=list[FotoDelProveedor],
)
async def ordenar_fotos(
    product_id: str,
    cuerpo: OrdenDeLasFotos,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FotoDelProveedor]:
    """Deja la galería en ese orden. TODAS o ninguna."""
    ensure_uuid(product_id, "Producto no encontrado.")
    #: MISMA PUERTA QUE SUBIR. Quien tiene la capacidad comercial suspendida no
    #: sube fotos; tampoco debería reordenarlas ni quitarlas.
    await permisos.exigir_vendedor_activo(db, current_user.id)
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    filas = await fotos.ordenar(db, producto=producto, en_orden=cuerpo.media_ids)
    await db.commit()
    return await _galeria_del_proveedor(db, version_id=filas[0].version_id)


@router.delete("/seller/products/{product_id}/media/{media_id}", status_code=204)
async def quitar_foto(
    product_id: str,
    media_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Quita una fotografía. El archivo solo se borra si nadie más lo nombra."""
    ensure_uuid(product_id, "Producto no encontrado.")
    ensure_uuid(media_id, "Fotografía no encontrada.")
    await permisos.exigir_vendedor_activo(db, current_user.id)
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    borrado = await fotos.quitar(db, producto=producto, media_id=media_id)
    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        actor_role="user",
        action="product_media.remove",
        entity_type="product",
        entity_id=producto.id,
        payload={"media_id": media_id, "file_deleted": borrado},
    )
    await db.commit()


# --------------------------------------------------------------------------- #
# Inventario del proveedor (0074)
# --------------------------------------------------------------------------- #
@router.get(
    "/seller/products/{product_id}/inventory", response_model=InventarioRead
)
async def mi_inventario(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InventarioRead:
    """Las variantes con lo que hay de cada SKU.

    `stock` en `null` NO ES CERO: es que nadie lo cargó todavía.
    """
    ensure_uuid(product_id, "Producto no encontrado.")
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    if not await esquema.hay_inventario(db):
        return InventarioRead(product_id=producto.id, disponible=False)
    version = await service.borrador_de(
        db, producto_id=producto.id
    ) or await service.vigente_de(db, producto_id=producto.id)
    if version is None:
        return InventarioRead(product_id=producto.id)
    return InventarioRead(
        product_id=producto.id,
        version_id=version.id,
        units=[
            UnidadDeInventario(
                variant_id=v.id,
                sku=v.sku,
                name=v.name,
                options=dict(v.options or {}),
                price_delta_minor=v.price_delta_minor,
                stock=(
                    None
                    if hay is None
                    else ExistenciasRead(
                        sku=hay.sku,
                        on_hand=hay.on_hand,
                        reserved=hay.reserved,
                        available=hay.available,
                    )
                ),
            )
            for v, hay in await almacen.de_la_version(
                db, product_id=producto.id, version_id=version.id
            )
        ],
    )


@router.post(
    "/seller/products/{product_id}/inventory/intake", response_model=ExistenciasRead
)
async def cargar_existencias(
    product_id: str,
    cuerpo: EntradaRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExistenciasRead:
    """Entran unidades. IDEMPOTENTE por la clave: un doble toque no carga dos."""
    ensure_uuid(product_id, "Producto no encontrado.")
    await permisos.exigir_vendedor_activo(db, current_user.id)
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    hay, _ = await almacen.entrada(
        db,
        product_id=producto.id,
        sku=cuerpo.sku,
        cantidad=cuerpo.quantity,
        clave=cuerpo.idempotency_key,
        actor_id=current_user.id,
        actor_rol=ACTOR_PROVEEDOR,
        motivo=cuerpo.reason,
    )
    await db.commit()
    return ExistenciasRead(
        sku=hay.sku,
        on_hand=hay.on_hand,
        reserved=hay.reserved,
        available=hay.available,
    )


@router.post(
    "/seller/products/{product_id}/inventory/adjust", response_model=ExistenciasRead
)
async def ajustar_existencias(
    product_id: str,
    cuerpo: AjusteRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExistenciasRead:
    """Corrige la existencia, con signo y CON MOTIVO."""
    ensure_uuid(product_id, "Producto no encontrado.")
    await permisos.exigir_vendedor_activo(db, current_user.id)
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    hay, _ = await almacen.ajustar(
        db,
        product_id=producto.id,
        sku=cuerpo.sku,
        cantidad=cuerpo.quantity,
        motivo=cuerpo.reason,
        clave=cuerpo.idempotency_key,
        actor_id=current_user.id,
        actor_rol=ACTOR_PROVEEDOR,
    )
    await db.commit()
    return ExistenciasRead(
        sku=hay.sku,
        on_hand=hay.on_hand,
        reserved=hay.reserved,
        available=hay.available,
    )


@router.get(
    "/seller/products/{product_id}/inventory/{sku}/movements",
    response_model=list[MovimientoRead],
)
async def mis_movimientos(
    product_id: str,
    sku: str,
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MovimientoRead]:
    """El historial de un SKU. SOLO SE AÑADE: nada de aquí se edita ni se borra."""
    ensure_uuid(product_id, "Producto no encontrado.")
    producto = await permisos.exigir_mio(
        db, producto_id=product_id, user_id=current_user.id
    )
    return [
        MovimientoRead(
            id=m.id,
            sku=m.sku,
            kind=m.kind,
            quantity=m.quantity,
            on_hand_after=m.on_hand_after,
            reserved_after=m.reserved_after,
            available_after=m.on_hand_after - m.reserved_after,
            reason=m.reason,
            actor_id=m.actor_id,
            actor_role=m.actor_role,
            created_at=m.created_at,
        )
        for m in await almacen.movimientos(
            db, product_id=producto.id, sku=sku, limite=limit
        )
    ]


# --------------------------------------------------------------------------- #
# El carrito (0075). ANTES de `/{product_id}`.
#
# TODAVÍA NO SE COMPRA. No hay checkout, ni pedido, ni pago, y no hay ninguna
# ruta que lo insinúe: una que devolviera 501 ya sería una promesa.
# --------------------------------------------------------------------------- #
@router.get("/cart", response_model=CarritoRead)
async def mi_carrito(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CarritoRead:
    """La bolsa, con los avisos de lo que cambió desde que se metió."""
    return _carrito(await carts.leer(db, usuario_id=current_user.id, firmar=fotos.firmar))


@router.post("/cart/items", response_model=CarritoRead, status_code=201)
async def anadir_al_carrito(
    cuerpo: AnadirAlCarrito,
    idempotency_key: str | None = Header(
        default=None, alias="Idempotency-Key", max_length=200
    ),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CarritoRead:
    """Añade unidades. AÑADIR DOS VECES AJUSTA LA LÍNEA, no la duplica, y un
    reintento con la misma clave no vuelve a sumar."""
    ensure_uuid(cuerpo.product_id, "Producto no encontrado.")
    ensure_uuid(cuerpo.variant_id, "Esa opción no existe en este producto.")
    await carts.anadir(
        db,
        usuario_id=current_user.id,
        producto_id=cuerpo.product_id,
        variante_id=cuerpo.variant_id,
        cantidad=cuerpo.quantity,
        clave=idempotency_key,
    )
    await db.commit()
    return _carrito(await carts.leer(db, usuario_id=current_user.id, firmar=fotos.firmar))


@router.put("/cart/items/{item_id}", response_model=CarritoRead)
async def cambiar_la_linea(
    item_id: str,
    cuerpo: CantidadDeLaLinea,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CarritoRead:
    """Deja la línea en esa cantidad. CERO LA QUITA, y repetirlo deja lo mismo."""
    ensure_uuid(item_id, "Esa línea no está en tu bolsa.")
    await carts.cambiar_cantidad(
        db, usuario_id=current_user.id, item_id=item_id, cantidad=cuerpo.quantity
    )
    await db.commit()
    return _carrito(await carts.leer(db, usuario_id=current_user.id, firmar=fotos.firmar))


@router.delete("/cart/items/{item_id}", response_model=CarritoRead)
async def quitar_la_linea(
    item_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CarritoRead:
    """Quita la línea. QUITAR LO QUE YA NO ESTÁ tampoco es un error."""
    ensure_uuid(item_id, "Esa línea no está en tu bolsa.")
    await carts.quitar(db, usuario_id=current_user.id, item_id=item_id)
    await db.commit()
    return _carrito(await carts.leer(db, usuario_id=current_user.id, firmar=fotos.firmar))


@router.delete("/cart", response_model=CarritoRead)
async def vaciar_el_carrito(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CarritoRead:
    """Deja la bolsa vacía."""
    await carts.vaciar(db, usuario_id=current_user.id)
    await db.commit()
    return _carrito(await carts.leer(db, usuario_id=current_user.id, firmar=fotos.firmar))


@router.get("/counts", response_model=ContadoresRead)
async def contadores(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ContadoresRead:
    """Los dos números del encabezado, SEPARADOS.

    La bolsa cuenta unidades del carrito; guardados cuenta productos marcados.
    Son cosas distintas y por eso son dos números.
    """
    return ContadoresRead(
        cart_units=await carts.cuantas_unidades(db, usuario_id=current_user.id),
        saved_products=await catalog.cuantos_guardados(db, usuario_id=current_user.id),
    )


# --------------------------------------------------------------------------- #
# La ficha. AL FINAL, para no comerse las rutas estáticas.
# --------------------------------------------------------------------------- #
@router.get("/{product_id}", response_model=FichaRead)
async def ficha(
    product_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> FichaRead:
    """El detalle, en el orden inalterable del blueprint. 404 si no está
    publicado."""
    ensure_uuid(product_id, "Producto no encontrado.")
    f = await catalog.ficha(
        db,
        producto_id=product_id,
        usuario_id=current_user.id if current_user else None,
    )
    datos = dict(f.__dict__)
    datos["related"] = [_tarjeta(t) for t in f.related]
    return FichaRead(**datos)


@router.get("/{product_id}/evaluation", response_model=InformeRead)
async def informe(
    product_id: str, db: AsyncSession = Depends(get_db)
) -> InformeRead:
    """El informe que abre el sello. Sin la nota interna del evaluador."""
    ensure_uuid(product_id, "Producto no encontrado.")
    datos = await catalog.informe_de_evaluacion(db, producto_id=product_id)
    if datos is None:
        # NO HAY INFORME QUE ENSEÑAR. Puede ser que la admisión no esté
        # desplegada; en los dos casos el sello no debería haberse pintado.
        raise ServiceUnavailableError(
            "Este producto no tiene un informe de evaluación publicado.",
            code="product_evaluation_not_available",
        )
    return InformeRead(**datos)


@router.post("/{product_id}/save", response_model=GuardadoRead)
async def guardar_producto(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GuardadoRead:
    """Guarda. IDEMPOTENTE, y NO reserva nada: no es un carrito."""
    ensure_uuid(product_id, "Producto no encontrado.")
    await catalog.guardar(db, producto_id=product_id, usuario_id=current_user.id)
    await db.commit()
    return GuardadoRead(
        saved=True,
        count=await catalog.cuantos_guardados(db, usuario_id=current_user.id),
    )


@router.delete("/{product_id}/save", response_model=GuardadoRead)
async def quitar_producto(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GuardadoRead:
    ensure_uuid(product_id, "Producto no encontrado.")
    await catalog.quitar(db, producto_id=product_id, usuario_id=current_user.id)
    await db.commit()
    return GuardadoRead(
        saved=False,
        count=await catalog.cuantos_guardados(db, usuario_id=current_user.id),
    )


# --------------------------------------------------------------------------- #
# Administración: postulaciones
# --------------------------------------------------------------------------- #
@admin_router.get("/applications", response_model=list[PostulacionRead])
async def bandeja_de_postulaciones(
    estado: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PostulacionRead]:
    """Lo que hay que mirar. EL ROL ANTES DE LA PUERTA DE ESQUEMA."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    return [
        _postulacion(
            p, await applications.documentos_de(db, postulacion_id=p.id)
        )
        for p in await applications.bandeja(db, estado=estado, limite=limit)
    ]


@admin_router.post("/applications/{application_id}/take", response_model=PostulacionRead)
async def tomar_postulacion(
    application_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostulacionRead:
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(application_id, "Postulación no encontrada.")
    postulacion = await applications.tomar(
        db, postulacion_id=application_id, usuario_id=current_user.id
    )
    await db.commit()
    return _postulacion(
        postulacion,
        await applications.documentos_de(db, postulacion_id=postulacion.id),
    )


@admin_router.post(
    "/applications/{application_id}/decide", response_model=PostulacionRead
)
async def decidir_postulacion(
    application_id: str,
    cuerpo: DecisionDePostulacion,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostulacionRead:
    """Acepta o rechaza. Aceptar CREA la capacidad comercial, a la vez."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(application_id, "Postulación no encontrada.")
    postulacion, _ = await applications.decidir(
        db,
        postulacion_id=application_id,
        usuario_id=current_user.id,
        aceptar=cuerpo.aceptar,
        motivo=cuerpo.motivo,
        notas=cuerpo.notas,
    )
    await db.commit()
    return _postulacion(
        postulacion,
        await applications.documentos_de(db, postulacion_id=postulacion.id),
    )


# --------------------------------------------------------------------------- #
# Administración: evaluación
# --------------------------------------------------------------------------- #
async def _evaluacion_leida(
    db: AsyncSession, evaluacion, *, con_bloqueo: bool = True
) -> EvaluacionRead:
    bloqueo, faltan = None, []
    if con_bloqueo and evaluacion.status == "draft":
        falta = await evaluations.por_que_no_se_decide(
            db, evaluacion_id=evaluacion.id
        )
        if falta is not None:
            bloqueo = falta[0]
            faltan = list(falta[1].get("missing") or falta[1].get("dimensions") or [])
    return EvaluacionRead(
        id=evaluacion.id,
        product_id=evaluacion.product_id,
        version_id=evaluacion.version_id,
        evaluator_id=evaluacion.evaluator_id,
        status=evaluacion.status,
        score_total=evaluacion.score_total,
        decision=evaluacion.decision,
        critical_failure=evaluacion.critical_failure,
        decided_at=evaluacion.decided_at,
        scores=[
            PuntuacionRead(
                dimension=s.dimension, score=s.score, weight=s.weight, note=s.note
            )
            for s in await evaluations.puntuaciones_de(
                db, evaluacion_id=evaluacion.id
            )
        ],
        evidence=[
            EvidenciaRead(
                id=e.id,
                dimension=e.dimension,
                kind=e.kind,
                summary=e.summary,
                storage_path=e.storage_path,
            )
            for e in await evaluations.evidencia_de(db, evaluacion_id=evaluacion.id)
        ],
        reasons=[],
        matriz=dict(DIMENSIONES),
        bloqueo=bloqueo,
        faltan=faltan,
    )


@admin_router.get("/evaluations", response_model=list[EvaluacionRead])
async def bandeja_de_evaluaciones(
    estado: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EvaluacionRead]:
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    return [
        await _evaluacion_leida(db, e)
        for e in await evaluations.bandeja(db, estado=estado, limite=limit)
    ]


@admin_router.post(
    "/versions/{version_id}/evaluation", response_model=EvaluacionRead, status_code=201
)
async def abrir_evaluacion(
    version_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionRead:
    """Abre la evaluación de esa versión. IDEMPOTENTE."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(version_id, "Versión no encontrada.")
    evaluacion = await evaluations.abrir(
        db, version_id=version_id, usuario_id=current_user.id
    )
    await db.commit()
    return await _evaluacion_leida(db, evaluacion)


@admin_router.get("/evaluations/{evaluation_id}", response_model=EvaluacionRead)
async def leer_evaluacion(
    evaluation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionRead:
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(evaluation_id, "Evaluación no encontrada.")
    evaluacion = await db.get(evaluations.ProductEvaluation, evaluation_id)
    if evaluacion is None:
        raise evaluations.EvaluacionNoEncontrada("Evaluación no encontrada.")
    leida = await _evaluacion_leida(db, evaluacion)
    # CON SU EVIDENCIA. Una razón sin decir de qué sale no se puede comprobar,
    # y comprobarla es lo único que la distingue de una frase escrita a mano.
    evidencias = {
        e.id: e
        for e in await evaluations.evidencia_de(db, evaluacion_id=evaluation_id)
    }
    razones = []
    for r in await evaluations.razones_de(db, version_id=evaluacion.version_id):
        evidencia = evidencias.get(r.evidence_id)
        razones.append(
            RazonRead(
                position=r.position,
                text=r.text,
                evidence_kind=evidencia.kind if evidencia is not None else "",
                evidence_dimension=(
                    evidencia.dimension if evidencia is not None else ""
                ),
            )
        )
    leida.reasons = razones
    return leida


@admin_router.put(
    "/evaluations/{evaluation_id}/scores/{dimension}", response_model=EvaluacionRead
)
async def puntuar(
    evaluation_id: str,
    dimension: str,
    cuerpo: PuntuacionRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionRead:
    """Puntúa una dimensión de 0 a 100. El peso lo pone la matriz."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(evaluation_id, "Evaluación no encontrada.")
    await evaluations.puntuar(
        db,
        evaluacion_id=evaluation_id,
        usuario_id=current_user.id,
        dimension=dimension,
        score=cuerpo.score,
        note=cuerpo.note,
    )
    await db.commit()
    evaluacion = await db.get(evaluations.ProductEvaluation, evaluation_id)
    return await _evaluacion_leida(db, evaluacion)


@admin_router.post(
    "/evaluations/{evaluation_id}/evidence", response_model=EvaluacionRead, status_code=201
)
async def registrar_evidencia(
    evaluation_id: str,
    cuerpo: EvidenciaRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionRead:
    """Registra qué se miró. SOLO AÑADIR."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(evaluation_id, "Evaluación no encontrada.")
    await evaluations.registrar_evidencia(
        db,
        evaluacion_id=evaluation_id,
        usuario_id=current_user.id,
        dimension=cuerpo.dimension,
        kind=cuerpo.kind,
        summary=cuerpo.summary,
        storage_path=cuerpo.storage_path,
    )
    await db.commit()
    evaluacion = await db.get(evaluations.ProductEvaluation, evaluation_id)
    return await _evaluacion_leida(db, evaluacion)


@admin_router.put("/evaluations/{evaluation_id}/reasons", response_model=EvaluacionRead)
async def elegir_razones(
    evaluation_id: str,
    cuerpo: RazonesRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionRead:
    """Las tres razones que leerá quien compra, cada una sobre una evidencia."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(evaluation_id, "Evaluación no encontrada.")
    for r in cuerpo.razones:
        ensure_uuid(r.evidence_id, "Evidencia no encontrada.")
    await evaluations.elegir_razones(
        db,
        evaluacion_id=evaluation_id,
        usuario_id=current_user.id,
        razones=[r.model_dump() for r in cuerpo.razones],
    )
    await db.commit()
    evaluacion = await db.get(evaluations.ProductEvaluation, evaluation_id)
    return await _evaluacion_leida(db, evaluacion)


@admin_router.post("/evaluations/{evaluation_id}/decide", response_model=EvaluacionRead)
async def decidir_evaluacion(
    evaluation_id: str,
    cuerpo: DecisionDeEvaluacion,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionRead:
    """Cierra la evaluación. LA DECISIÓN LA DA LA MATRIZ, no quien pulsa."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_admision(db)
    ensure_uuid(evaluation_id, "Evaluación no encontrada.")
    evaluacion = await evaluations.decidir(
        db,
        evaluacion_id=evaluation_id,
        usuario_id=current_user.id,
        critical_failure=cuerpo.critical_failure,
        notes=cuerpo.notes,
    )
    await db.commit()
    return await _evaluacion_leida(db, evaluacion, con_bloqueo=False)


# --------------------------------------------------------------------------- #
# Administración: el producto
# --------------------------------------------------------------------------- #
@admin_router.get("", response_model=list[ProductoDeAdministracion])
async def listar(
    estado: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProductoDeAdministracion]:
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_dominio(db)
    consulta = select(Product, ProductSeller).join(
        ProductSeller, ProductSeller.id == Product.seller_id
    )
    if estado:
        consulta = consulta.where(Product.status == estado)
    filas = (
        await db.execute(
            consulta.order_by(Product.created_at.desc(), Product.id.desc()).limit(limit)
        )
    ).all()
    salida: list[ProductoDeAdministracion] = []
    for producto, vendedor in filas:
        base = await _del_proveedor(db, producto, actor=maquina.ADMINISTRACION)
        salida.append(
            ProductoDeAdministracion(
                **base.model_dump(),
                seller_id=vendedor.id,
                seller_name=vendedor.display_name,
                seller_profile_id=vendedor.profile_id,
            )
        )
    return salida


@admin_router.post("/{product_id}/transition", response_model=ProductoDelProveedor)
async def transicionar(
    product_id: str,
    cuerpo: TransicionRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    """Mueve el producto por su ciclo. La máquina dice qué salto existe.

    NI UN ADMINISTRADOR MUEVE LO SUYO por aquí: se comprueba antes que el rol.
    """
    await esquema.exigir_dominio(db)
    ensure_uuid(product_id, "Producto no encontrado.")
    producto = await db.get(Product, product_id)
    if producto is None:
        raise permisos.NoEsTuProducto("Producto no encontrado.")
    await permisos.exigir_ajeno(db, producto=producto, user_id=current_user.id)
    await permisos.exigir_evaluador(db, current_user.id)
    # RETIRAR Y SUSPENDER son de administración, no de curaduría. La máquina ya
    # lo dice: el actor es `admin` solo si el rol lo permite.
    actor = (
        maquina.ADMINISTRACION
        if await permisos.puede_publicar(db, current_user.id)
        else maquina.EVALUADOR
    )
    producto = await service.transicionar(
        db,
        producto_id=product_id,
        hasta=cuerpo.hasta,
        actor_id=current_user.id,
        actor_rol=actor,
        motivo=cuerpo.motivo,
    )
    await db.commit()
    return await _del_proveedor(db, producto, actor=actor)


@admin_router.post("/{product_id}/publish", response_model=ProductoDelProveedor)
async def publicar(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    """Publica la versión aprobada. EXIGE evaluación, tres razones y una foto."""
    await esquema.exigir_dominio(db)
    ensure_uuid(product_id, "Producto no encontrado.")
    producto, _ = await service.publicar(
        db, producto_id=product_id, usuario_id=current_user.id
    )
    await db.commit()
    return await _del_proveedor(db, producto, actor=maquina.ADMINISTRACION)


@admin_router.post("/{product_id}/suspend", response_model=ProductoDelProveedor)
async def suspender(
    product_id: str,
    cuerpo: MotivoRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProductoDelProveedor:
    """Lo saca del catálogo, con motivo. Suspender no es retirar."""
    await esquema.exigir_dominio(db)
    ensure_uuid(product_id, "Producto no encontrado.")
    producto = await db.get(Product, product_id)
    if producto is None:
        raise permisos.NoEsTuProducto("Producto no encontrado.")
    await permisos.exigir_ajeno(db, producto=producto, user_id=current_user.id)
    await permisos.exigir_publicador(db, current_user.id)
    producto = await service.transicionar(
        db,
        producto_id=product_id,
        hasta="suspended",
        actor_id=current_user.id,
        actor_rol=maquina.ADMINISTRACION,
        motivo=cuerpo.motivo,
    )
    await db.commit()
    return await _del_proveedor(db, producto, actor=maquina.ADMINISTRACION)


# --------------------------------------------------------------------------- #
# Administración: las fotografías pendientes (0073)
#
# QUIÉN EVALUA EL PRODUCTO EVALUA SUS FOTOS. Es curaduría, el mismo conjunto de
# `is_admin` que puntúa la matriz: separar los dos permisos exigiría decidir
# quién puede ser evaluador, y esa decisión la empresa no la ha tomado.
# --------------------------------------------------------------------------- #
@admin_router.get("/media/pending", response_model=list[FotoPendiente])
async def fotos_pendientes(
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FotoPendiente]:
    """Lo que espera revisión, LO MÁS VIEJO PRIMERO."""
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_fotografias(db)
    filas = await fotos.pendientes(db, limite=limit)
    firmadas = await fotos.firmar([m.storage_path for m, _, _ in filas])
    return [
        FotoPendiente(
            id=m.id,
            product_id=p.id,
            version_id=v.id,
            product_name=v.name,
            alt_text=m.alt_text,
            storage_path=m.storage_path,
            url=firmadas.get(m.storage_path),
            width=m.width,
            height=m.height,
            byte_size=m.byte_size,
            content_type=m.content_type,
            created_at=m.created_at,
        )
        for m, v, p in filas
    ]


@admin_router.post("/media/{media_id}/decide", response_model=FotoPendiente)
async def decidir_foto(
    media_id: str,
    cuerpo: DecisionDeLaFoto,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FotoPendiente:
    """Aprueba o rechaza una fotografía. UN RECHAZO LLEVA MOTIVO.

    NADIE APRUEBA LA FOTO DE SU PROPIO PRODUCTO. Se comprueba antes que el rol,
    igual que con la evaluación: si se comprobara después, un administrador
    dueño del producto recibiría un 403 genérico en vez del motivo real.
    """
    #: EL ROL, LO PRIMERO. Si fuera después, cualquier cuenta autenticada
    #: distinguiría por el código de respuesta si la 0073 está aplicada en
    #: producción y si un identificador de fotografía existe. Es la regla que
    #: este fichero se puso a sí mismo en la cabecera.
    if not await permisos.puede_evaluar(db, current_user.id):
        await permisos.exigir_evaluador(db, current_user.id)

    ensure_uuid(media_id, "Fotografía no encontrada.")
    await esquema.exigir_fotografias(db)
    fila = await db.get(ProductMedia, media_id)
    if fila is None:
        raise fotos.FotoNoEncontrada("Fotografía no encontrada.")
    version = await db.get(ProductVersion, fila.version_id)
    producto = await db.get(Product, version.product_id)
    #: Y LA COMPROBACIÓN DE «NO ES TUYO» SIGUE YENDO ANTES QUE NADA MÁS sobre
    #: el producto: un administrador dueño del producto recibe el motivo real y
    #: no un 403 genérico.
    await permisos.exigir_ajeno(db, producto=producto, user_id=current_user.id)

    decidida = await fotos.decidir(
        db,
        media_id=media_id,
        aprobada=cuerpo.approved,
        motivo=cuerpo.reason,
        actor_id=current_user.id,
    )
    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        actor_role="moderator",
        action="product_media.approve" if cuerpo.approved else "product_media.reject",
        entity_type="product",
        entity_id=producto.id,
        reason=(cuerpo.reason or None) if not cuerpo.approved else None,
        new_state=decidida.status,
        payload={"media_id": media_id},
    )
    await db.commit()
    firmadas = await fotos.firmar([decidida.storage_path])
    return FotoPendiente(
        id=decidida.id,
        product_id=producto.id,
        version_id=version.id,
        product_name=version.name,
        alt_text=decidida.alt_text,
        storage_path=decidida.storage_path,
        url=firmadas.get(decidida.storage_path),
        width=decidida.width,
        height=decidida.height,
        byte_size=decidida.byte_size,
        content_type=decidida.content_type,
        created_at=decidida.created_at,
    )


# --------------------------------------------------------------------------- #
# Administración: intervenir el inventario (0074)
#
# UNA SOLA RUTA Y SIEMPRE AUDITADA. Administración no carga existencias por
# quien vende —eso es suyo— pero sí puede corregir un número, y ese ajuste queda
# escrito con su motivo y con quién lo firmó.
#
# MODERACIÓN NO MUEVE INVENTARIO. Esta ruta exige `exigir_publicador`, que es
# solo `admin`: `is_admin` incluye a quien modera, y mover existencias no es
# curaduría.
# --------------------------------------------------------------------------- #
@admin_router.get("/{product_id}/inventory", response_model=InventarioRead)
async def inventario_de(
    product_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InventarioRead:
    """Lo que hay de cada SKU de ese producto."""
    await permisos.exigir_publicador(db, current_user.id)
    await esquema.exigir_dominio(db)
    ensure_uuid(product_id, "Producto no encontrado.")
    producto = await db.get(Product, product_id)
    if producto is None:
        raise permisos.NoEsTuProducto("Producto no encontrado.")
    if not await esquema.hay_inventario(db):
        return InventarioRead(product_id=producto.id, disponible=False)
    version = await service.vigente_de(
        db, producto_id=producto.id
    ) or await service.borrador_de(db, producto_id=producto.id)
    if version is None:
        return InventarioRead(product_id=producto.id)
    return InventarioRead(
        product_id=producto.id,
        version_id=version.id,
        units=[
            UnidadDeInventario(
                variant_id=v.id,
                sku=v.sku,
                name=v.name,
                options=dict(v.options or {}),
                price_delta_minor=v.price_delta_minor,
                stock=(
                    None
                    if hay is None
                    else ExistenciasRead(
                        sku=hay.sku,
                        on_hand=hay.on_hand,
                        reserved=hay.reserved,
                        available=hay.available,
                    )
                ),
            )
            for v, hay in await almacen.de_la_version(
                db, product_id=producto.id, version_id=version.id
            )
        ],
    )


@admin_router.post("/{product_id}/inventory/adjust", response_model=ExistenciasRead)
async def intervenir_inventario(
    product_id: str,
    cuerpo: AjusteRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExistenciasRead:
    """Corrige un número del almacén. CON MOTIVO y con rastro de quién fue."""
    await permisos.exigir_publicador(db, current_user.id)
    await esquema.exigir_dominio(db)
    ensure_uuid(product_id, "Producto no encontrado.")
    producto = await db.get(Product, product_id)
    if producto is None:
        raise permisos.NoEsTuProducto("Producto no encontrado.")
    hay, _ = await almacen.ajustar(
        db,
        product_id=producto.id,
        sku=cuerpo.sku,
        cantidad=cuerpo.quantity,
        motivo=cuerpo.reason,
        clave=cuerpo.idempotency_key,
        actor_id=current_user.id,
        actor_rol=ACTOR_ADMINISTRACION,
    )
    await db.commit()
    return ExistenciasRead(
        sku=hay.sku,
        on_hand=hay.on_hand,
        reserved=hay.reserved,
        available=hay.available,
    )


__all__ = ["admin_router", "router"]
