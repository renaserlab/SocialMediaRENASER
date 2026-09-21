"""La API de Productos.

EL ORDEN DE LAS RUTAS IMPORTA. `/products/categories` va ANTES de
`/products/{product_id}`, y las del proveedor antes también: si no, FastAPI
resolvería `categories` como un identificador de producto y la pantalla recibiría
un 404 sin saber por qué.

QUIÉN PUEDE QUÉ LO DECIDE EL SERVIDOR. Cada ruta comprueba la propiedad del
producto y el rol de quien llama, y en las de administración el ROL VA ANTES DE
LA PUERTA DE ESQUEMA: si fuera al revés, una cuenta sin permisos distinguiría un
503 de un 403 y averiguaría qué migraciones están aplicadas en producción.

HAY RUTAS DE COMPRA Y NO HAY RUTA DE COBRO. Carrito, checkout, pedido, reserva y
envío existen; lo que no existe es mover dinero de verdad, y por eso el checkout
contesta 503 con la lista de lo que falta —cinco banderas, una clave de la
pasarela y una política publicada— en vez de fingir que la compra no está. Un
501 vacío ya sería una promesa; un 503 que dice qué falta es la verdad.

Y NINGUNA RUTA FABRICA UNA ENTREGA. Administración puede reabrir un paquete y
registrar que la entrega falló, pero no puede escribir «entregado»: no tiene
cómo saberlo, y escribirlo arrancaría plazos de posventa que nadie ha cumplido.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ServiceUnavailableError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.gobernanza import auditoria
from app.modules.products import applications, carts, catalog, esquema, evaluations
from app.modules.products import envios
from app.modules.products import estados_de_envio
from app.modules.products import estados_de_incidencia as maquina_de_incidencias
from app.modules.products import incidencias
from app.modules.products import inventory as almacen
from app.modules.products import media as fotos
from app.modules.products import pagos as cobros
from app.modules.products import pedidos
from app.modules.products import politicas
from app.modules.products import permissions as permisos
from app.modules.products import service
from app.modules.products import states as maquina
from app.modules.products.models import (
    ACTOR_ADMINISTRACION,
    PEDIDO_PAGADO,
    ACTOR_PROVEEDOR,
    DIMENSIONES,
    MAXIMO_BYTES_DE_LA_FOTO,
    MAXIMO_DE_FOTOS,
    Product,
    ProductMedia,
    ProductOrder,
    ProductIncident,
    ProductPolicy,
    ProductSeller,
    ProductVersion,
)
from app.shared import storage as almacenamiento
from app.modules.products.schemas import (
    AbrirIncidencia,
    CheckoutProductoRead,
    EscaladaRead,
    IncidenciaRead,
    IncidenciaResumen,
    NotaDelCaso,
    PasoDelCaso,
    PruebaRead,
    ResolverIncidencia,
    RespuestaDelProveedor,
    DespacharRequest,
    EnvioPendienteRead,
    EnvioRead,
    LineaPreparadaRead,
    MotivoRequest,
    PedidoDelProveedorConEnvio,
    PrepararRequest,
    TransicionDeEnvioRequest,
    CondicionesRead,
    DireccionRead,
    EventoDelPedido,
    GrupoDelCarrito,
    LineaDelPedido,
    PedidoDelProveedor,
    PedidoRead,
    PedidoRequest,
    PedidoResumen,
    PoliticaRead,
    PreparacionRead,
    PublicarPolitica,
    VencimientoRead,
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
        #: SE ESCRIBE AQUÍ, y las dos condiciones a la vez: que la bolsa
        #: tenga algo comprable Y que la venta esté habilitada de verdad. La
        #: segunda son cinco banderas y no se lee de `c`: encenderla tiene que
        #: pasar por este fichero, no por un campo que alguien copie.
        purchasable=bool(c.purchasable) and not pedidos.por_que_no_se_puede_vender(),
        disponible=c.disponible,
    )


def _condiciones(politica) -> CondicionesRead:
    return CondicionesRead(**politicas.condiciones_de(politica).__dict__)


def _politica(politica) -> PoliticaRead:
    return PoliticaRead(
        **politicas.condiciones_de(politica).__dict__,
        status=politica.status,
        published_at=politica.published_at,
    )


def _linea_del_pedido(linea) -> LineaDelPedido:
    return LineaDelPedido(
        id=linea.id,
        product_id=linea.product_id,
        version_id=linea.version_id,
        variant_id=linea.variant_id,
        sku=linea.sku,
        name=linea.name_snapshot,
        variant_name=linea.variant_name_snapshot,
        unit_price_minor=int(linea.unit_price_minor),
        quantity=int(linea.quantity),
        subtotal_minor=int(linea.subtotal_minor),
    )


def _direccion(fila) -> DireccionRead | None:
    if fila is None:
        return None
    return DireccionRead(
        recipient_name=fila.recipient_name,
        phone=fila.phone,
        country_code=fila.country_code,
        region=fila.region,
        city=fila.city,
        district=fila.district,
        address_line=fila.address_line,
        reference=fila.reference,
        postal_code=fila.postal_code,
        instructions=fila.instructions,
    )


async def _pedido(db: AsyncSession, orden, *, con_direccion: bool = True) -> PedidoRead:
    """El pedido entero, para quien lo hizo.

    `con_direccion=False` para la cola de conciliacion: cuadrar un cobro no
    necesita saber donde vive nadie.
    """
    lineas = await pedidos.lineas_de(db, orden.id)
    direccion = await pedidos.direccion_de(db, orden.id) if con_direccion else None
    historial = await pedidos.historial_de(db, orden.id)
    vendedor = await db.get(ProductSeller, orden.seller_id)
    politica = await db.get(ProductPolicy, orden.policy_id)
    return PedidoRead(
        id=orden.id,
        status=orden.status,
        seller_id=orden.seller_id,
        seller_name=vendedor.display_name if vendedor is not None else None,
        currency=orden.currency,
        subtotal_minor=int(orden.subtotal_minor),
        total_minor=int(orden.total_minor),
        reserved_until=orden.reserved_until,
        paid_at=orden.paid_at,
        cancelled_at=orden.cancelled_at,
        expired_at=orden.expired_at,
        failed_at=orden.failed_at,
        review_reason=orden.review_reason,
        #: LA POLITICA QUE ACEPTO, leida por su identificador. Si alguien la
        #: retirase, el pedido sigue diciendo cual fue: por eso la fila no se
        #: borra nunca.
        policy=_condiciones(politica) if politica is not None else None,
        address=_direccion(direccion),
        items=[_linea_del_pedido(l) for l in lineas],
        history=[
            EventoDelPedido(
                from_status=e.from_status,
                to_status=e.to_status,
                actor_role=e.actor_role,
                reason=e.reason,
                created_at=e.created_at,
            )
            for e in historial
        ],
        #: EL SEGUIMIENTO VIAJA CON EL PEDIDO. Quien compra ve su paquete en la
        #: misma ficha, y `available_transitions` se calcula para `buyer`: lo
        #: unico que puede hacer es confirmar que lo recibio.
        shipment=await _envio(
            db,
            await envios.del_pedido(db, orden=orden, lineas=lineas),
            actor="buyer",
        ),
        created_at=orden.created_at,
    )


async def _envio(
    db: AsyncSession,
    envio: envios.Envio | None,
    *,
    actor: str | None = None,
    con_historial: bool = True,
) -> EnvioRead | None:
    """El envío tal como lo lee una pantalla.

    `actor` decide qué botones puede pintar el cliente, y NO decide nada más:
    quien decide de verdad es el servidor con la fila bloqueada delante. Una
    lista vacía aquí no es una puerta; es que no hay nada que ofrecer.
    """
    if envio is None:
        return None
    historial = (
        await envios.historial(db, orden_id=envio.order_id) if con_historial else []
    )
    return EnvioRead(
        order_id=envio.order_id,
        status=envio.status,
        exists=envio.existe,
        carrier_name=envio.carrier_name,
        tracking_reference=envio.tracking_reference,
        prepared_at=envio.prepared_at,
        ready_at=envio.ready_at,
        dispatched_at=envio.dispatched_at,
        delivered_at=envio.delivered_at,
        failed_at=envio.failed_at,
        cancelled_at=envio.cancelled_at,
        delivered_source=envio.delivered_source,
        buyer_confirmed_at=envio.buyer_confirmed_at,
        failure_reason=envio.failure_reason,
        cancellation_reason=envio.cancellation_reason,
        items=[
            LineaPreparadaRead(
                order_item_id=l.order_item_id,
                sku=l.sku,
                name=l.name,
                variant_name=l.variant_name,
                ordered_quantity=l.ordered_quantity,
                prepared_quantity=l.prepared_quantity,
            )
            for l in envio.items
        ],
        history=[
            EventoDelPedido(
                from_status=e.from_status,
                to_status=e.to_status,
                actor_role=e.actor_role,
                reason=e.reason,
                created_at=e.created_at,
            )
            for e in historial
        ],
        available_transitions=(
            list(estados_de_envio.siguientes(envio.status, actor))
            if actor is not None
            else []
        ),
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
# Condiciones de venta y pedido (Incremento 5)
#
# TODAS ANTES DE `/{product_id}`: si fueran despues, FastAPI resolveria
# `orders` como un identificador de producto y la pantalla recibiria un 404 sin
# saber por que.
# --------------------------------------------------------------------------- #
@router.get("/policies", response_model=CondicionesRead)
async def condiciones_de_venta(
    country: str = Query(min_length=2, max_length=2),
    db: AsyncSession = Depends(get_db),
) -> CondicionesRead:
    """Las condiciones que rigen HOY en ese pais.

    SIN POLITICA PUBLICADA CONTESTA 409 con `product_policy_not_configured`, y
    no 404: la ruta existe y el pais puede estar bien escrito; lo que falta es
    una decision de la empresa. Esta ruta es publica a proposito: las
    condiciones de venta se leen antes de tener una sesion.
    """
    await esquema.exigir_politicas(db)
    return _condiciones(await politicas.exigir_vigente(db, pais=country))


@router.get("/checkout/preparation", response_model=PreparacionRead)
async def preparacion_del_checkout(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PreparacionRead:
    """Si hoy se puede comprar, y QUE FALTA si no.

    NO FALLA CON 503 CUANDO LA VENTA ESTA APAGADA, y es deliberado: esta ruta
    existe justamente para contar por que. Un 503 dejaria a la pantalla sin
    poder explicar nada.
    """
    p = await pedidos.preparar(db, usuario_id=current_user.id)
    return PreparacionRead(
        disponible=p.disponible,
        pending_configuration=p.pending_configuration,
        countries_with_policy=p.countries_with_policy,
        groups=[GrupoDelCarrito(**g.__dict__) for g in p.groups],
        open_order_id=p.open_order_id,
    )


@router.get("/orders", response_model=list[PedidoResumen])
async def mis_pedidos(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PedidoResumen]:
    """Mis pedidos, los mas nuevos primero."""
    ordenes = await pedidos.mis_pedidos(db, usuario_id=current_user.id)
    salida: list[PedidoResumen] = []
    for orden in ordenes:
        lineas = await pedidos.lineas_de(db, orden.id)
        vendedor = await db.get(ProductSeller, orden.seller_id)
        salida.append(
            PedidoResumen(
                id=orden.id,
                status=orden.status,
                seller_name=vendedor.display_name if vendedor is not None else None,
                currency=orden.currency,
                total_minor=int(orden.total_minor),
                units=sum(int(l.quantity) for l in lineas),
                reserved_until=orden.reserved_until,
                created_at=orden.created_at,
            )
        )
    return salida


@router.post("/orders", response_model=PedidoRead, status_code=201)
async def crear_pedido(
    cuerpo: PedidoRequest,
    idempotency_key: str | None = Header(
        default=None, alias="Idempotency-Key", max_length=200
    ),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoRead:
    """Convierte lo que hay en la bolsa de UN proveedor en un pedido reservado.

    NO COBRA NADA. Reserva las unidades y deja el pedido esperando pago; abrir
    el cobro es la ruta siguiente, y a proposito: es una llamada a un tercero
    que no puede ocurrir con las filas del almacen bloqueadas.

    LA MISMA `Idempotency-Key` NO CREA DOS PEDIDOS, y reutilizarla con otro
    cuerpo es un conflicto: quien reintenta con otro contenido no reintenta.
    """
    ensure_uuid(cuerpo.seller_id, "Proveedor no encontrado.")
    ensure_uuid(cuerpo.policy_id, "Condiciones de venta no encontradas.")
    creado = await pedidos.crear(
        db,
        usuario_id=current_user.id,
        seller_id=cuerpo.seller_id,
        direccion=cuerpo.address.model_dump(),
        policy_id=cuerpo.policy_id,
        policy_terms_sha256=cuerpo.policy_terms_sha256,
        clave=idempotency_key or "",
    )
    return await _pedido(db, creado.orden)


@router.get("/orders/{order_id}", response_model=PedidoRead)
async def mi_pedido(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoRead:
    """Un pedido mio. EL AJENO ES UN 404, nunca un 403.

    ES TAMBIEN LA RUTA DE LA VUELTA DEL NAVEGADOR: quien regresa de Stripe
    pregunta aqui, porque un parametro en la URL no confirma dinero.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await pedidos.leer(db, orden_id=order_id, usuario_id=current_user.id)
    return await _pedido(db, orden)


@router.post("/orders/{order_id}/checkout", response_model=CheckoutProductoRead)
async def iniciar_el_pago(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CheckoutProductoRead:
    """Abre el cobro en la pasarela. NO MARCA NADA COMO PAGADO."""
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await pedidos.leer(db, orden_id=order_id, usuario_id=current_user.id)
    intento = await cobros.iniciar_pago(
        db, orden=orden, correo=current_user.email or ""
    )
    return CheckoutProductoRead(
        order_id=orden.id,
        checkout_url=intento.checkout_url,
        provider=intento.provider,
        amount_minor=int(orden.total_minor),
        currency=orden.currency,
    )


@router.post("/orders/{order_id}/cancel", response_model=PedidoRead)
async def cancelar_el_pedido(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoRead:
    """Cancela un pedido ANTES de pagarlo y suelta lo que apartaba.

    CANCELAR LO YA CANCELADO NO ES UN ERROR: devuelve lo mismo.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await pedidos.cancelar(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    return await _pedido(db, orden)


@router.post("/orders/{order_id}/shipment/confirm-receipt", response_model=PedidoRead)
async def confirmar_que_llego(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoRead:
    """Confirmo que recibi mi pedido. NO ES DAR LA CONFORMIDAD.

    LA DIFERENCIA IMPORTA Y NO ES SUTIL. Confirmar que llego es un hecho de
    logistica; dar la conformidad es decir que el producto esta bien, y en el
    blueprint eso LIBERA EL DINERO al proveedor. Lo segundo no existe todavia:
    no hay transferencias, ni comision, ni plazo aprobado. Aqui no se mueve ni
    un centimo, y la pantalla lo dice con palabras.

    Y NO PIERDE NINGUN DERECHO. Los plazos para reportar una incidencia son del
    Incremento 7 y salen de la politica publicada; confirmar que algo llego no
    renuncia a nada, porque no hay nada a lo que renunciar todavia.

    IDEMPOTENTE. Confirmarlo dos veces no cambia nada ni vuelve a escribir en el
    historial: el hecho ya estaba anotado.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await envios.pedido_del_comprador(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    await envios.registrar_entrega(
        db,
        orden=orden,
        actor_id=current_user.id,
        actor_rol=estados_de_envio.COMPRADOR,
    )
    #: SIN AVISO. Contarle a quien acaba de escribirlo que su pedido figura
    #: entregado es contarle lo que acaba de hacer.
    await db.commit()
    return await _pedido(db, orden)


# --------------------------------------------------------------------------- #
# Lo del proveedor: los pedidos de mi tienda y su envio
#
# TODO LO DE AQUI ES DE UN PEDIDO PAGADO Y MIO. `envios.pedido_del_proveedor`
# comprueba las dos cosas a la vez y contesta 404 cuando falla cualquiera de
# ellas: decir «existe pero no es tuyo» contaria que alguien compro eso, y
# distinguir «no es tuyo» de «no esta pagado» contaria cuantos intentos hubo.
# --------------------------------------------------------------------------- #
@router.get("/seller/orders", response_model=list[PedidoDelProveedorConEnvio])
async def pedidos_del_proveedor(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PedidoDelProveedorConEnvio]:
    """Los pedidos PAGADOS de mi tienda, y solo los mios.

    NI COBROS NI COMPRADORES. Lo que hace falta para preparar un paquete es que
    mandar y a donde; con quien pago y con que tarjeta no se prepara nada.

    EL ENVIO VIENE SIN HISTORIAL. En una lista no se lee el historial de nadie,
    y traerlo serian tantas consultas como pedidos.
    """
    vendedor = await permisos.exigir_vendedor_activo(db, current_user.id)
    ordenes = await pedidos.del_proveedor(db, seller_id=vendedor.id)
    salida: list[PedidoDelProveedorConEnvio] = []
    for orden in ordenes:
        #: LAS LINEAS, UNA SOLA VEZ POR PEDIDO. Se leen para el albaran y se
        #: le pasan hechas al envio; sin esto se leian dos veces cada una, y
        #: lo conto la revision independiente.
        lineas = await pedidos.lineas_de(db, orden.id)
        salida.append(
            PedidoDelProveedorConEnvio(
                id=orden.id,
                status=orden.status,
                currency=orden.currency,
                total_minor=int(orden.total_minor),
                paid_at=orden.paid_at,
                address=_direccion(await pedidos.direccion_de(db, orden.id)),
                items=[_linea_del_pedido(l) for l in lineas],
                shipment=await _envio(
                    db,
                    await envios.del_pedido(db, orden=orden, lineas=lineas),
                    actor="seller",
                    con_historial=False,
                ),
                created_at=orden.created_at,
            )
        )
    return salida


async def _del_proveedor(
    db: AsyncSession, *, orden, con_historial: bool = True
) -> PedidoDelProveedorConEnvio:
    """El pedido como lo ve quien tiene que preparar el paquete."""
    lineas = await pedidos.lineas_de(db, orden.id)
    return PedidoDelProveedorConEnvio(
        id=orden.id,
        status=orden.status,
        currency=orden.currency,
        total_minor=int(orden.total_minor),
        paid_at=orden.paid_at,
        address=_direccion(await pedidos.direccion_de(db, orden.id)),
        items=[_linea_del_pedido(l) for l in lineas],
        shipment=await _envio(
            db,
            await envios.del_pedido(db, orden=orden, lineas=lineas),
            actor="seller",
            con_historial=con_historial,
        ),
        created_at=orden.created_at,
    )


@router.get("/seller/orders/{order_id}", response_model=PedidoDelProveedorConEnvio)
async def pedido_del_proveedor(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """Uno de mis pedidos pagados, con lo que hace falta para prepararlo.

    EL DE OTRO PROVEEDOR ES UN 404, y el que no esta pagado tambien: un pedido
    sin pagar no le ensena a nadie donde vive quien lo intento.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    return await _del_proveedor(db, orden=orden)


@router.post(
    "/seller/orders/{order_id}/shipment/prepare",
    response_model=PedidoDelProveedorConEnvio,
)
async def preparar_el_paquete(
    order_id: str,
    cuerpo: PrepararRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """Apunta cuantas unidades de cada linea llevas metidas en la caja.

    ES UNA LISTA DE COMPROBACION Y SE CORRIGE. Quien empaqueta saca una unidad
    y la vuelve a meter; obligar a que cada correccion fuera un hecho inmutable
    convertiria la lista en un expediente. Lo que si es historial —cada cambio
    de ESTADO, con actor y motivo— no se puede reescribir.

    ENTRAR AQUI ARRANCA LA PREPARACION: la primera anotacion mueve el envio de
    pendiente a preparando, porque eso es exactamente lo que acaba de pasar.

    NO MUEVE INVENTARIO. Contar lo que va en la caja no saca nada del almacen:
    eso pasa al despachar, y solo entonces.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    for linea in cuerpo.items:
        ensure_uuid(linea.order_item_id, "Linea no encontrada.")
    await envios.anotar_preparado(
        db,
        orden=orden,
        cantidades={l.order_item_id: l.prepared_quantity for l in cuerpo.items},
        actor_id=current_user.id,
    )
    await db.commit()
    return await _del_proveedor(db, orden=orden)


@router.post(
    "/seller/orders/{order_id}/shipment/ready",
    response_model=PedidoDelProveedorConEnvio,
)
async def cerrar_el_paquete(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """Cierra el paquete. EXIGE QUE ESTE TODO DENTRO.

    UN PAQUETE SALE ENTERO O NO SALE. Cerrarlo a medias obliga a decidir que
    pasa con lo que se quedo fuera —segundo envio, devolucion parcial, quien
    paga el porte— y ninguna politica publicada lo dice. El 409 lleva en los
    detalles que linea falta y cuanto.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    await envios.marcar_listo(db, orden=orden, actor_id=current_user.id)
    await db.commit()
    return await _del_proveedor(db, orden=orden)


@router.post(
    "/seller/orders/{order_id}/shipment/reopen",
    response_model=PedidoDelProveedorConEnvio,
)
async def reabrir_el_paquete(
    order_id: str,
    cuerpo: MotivoRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """Vuelve a abrir un paquete cerrado. SOLO ANTES DE QUE SALGA, y con motivo.

    Es el unico paso atras de esta maquina, y se permite porque nada ha salido
    del almacen y nada se ha consumido. Prohibirlo dejaria un paquete atascado
    en «listo» cuando se rompe algo al embalar, y un estado atascado se acaba
    resolviendo mintiendo en el siguiente.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    await envios.reabrir(
        db,
        orden=orden,
        actor_id=current_user.id,
        actor_rol=estados_de_envio.PROVEEDOR,
        motivo=cuerpo.reason,
    )
    await db.commit()
    return await _del_proveedor(db, orden=orden)


@router.post(
    "/seller/orders/{order_id}/shipment/dispatch",
    response_model=PedidoDelProveedorConEnvio,
)
async def despachar_el_paquete(
    order_id: str,
    cuerpo: DespacharRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """Saca el paquete del almacen. AQUI SE CONSUME LA RESERVA, UNA SOLA VEZ.

    ES EL UNICO SITIO DE PRODUCTOS DONDE SALEN UNIDADES. Ni el cobro ni la
    entrega tocan el almacen: al cobrar las unidades siguen en la caja, y al
    entregar ya salieron hace rato.

    REPETIR LA LLAMADA NO DESPACHA DOS VECES. Un envio ya despachado se
    devuelve tal cual, sin tocar el inventario y sin pisar el transportista que
    ya tenia: un POST que se perdio por el camino y se reintenta no es un
    despacho nuevo.

    Y SOLO EL PROVEEDOR. Administracion no puede despachar: es el unico que
    puede afirmar que la caja salio de su almacen.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    antes = await envios.del_pedido(db, orden=orden)
    envio = await envios.despachar(
        db,
        orden=orden,
        actor_id=current_user.id,
        carrier_name=cuerpo.carrier_name,
        tracking_reference=cuerpo.tracking_reference,
    )
    #: EL AVISO SOLO CUANDO ACABA DE PASAR. Un reintento no vuelve a avisar, y
    #: se encola DENTRO de la transaccion: asi no anuncia algo que no llego a
    #: ocurrir.
    if antes is not None and antes.status != envio.status:
        await envios.avisar(db, orden=orden, estado=envio.status)
    await db.commit()
    return await _del_proveedor(db, orden=orden)


@router.post(
    "/seller/orders/{order_id}/shipment/delivered",
    response_model=PedidoDelProveedorConEnvio,
)
async def registrar_la_entrega(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """Deja constancia de que el paquete llego, segun quien vende.

    SE GUARDA QUIEN LO AFIRMA. El blueprint contempla que el transportista
    marque la entrega y quien compro la niegue; sin saber quien lo dijo, esa
    discusion —que es del Incremento 7— no se puede tener.

    Y SE AVISA A QUIEN COMPRO. No para darle una buena noticia: para que pueda
    desmentirlo si no es verdad.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    antes = await envios.del_pedido(db, orden=orden)
    envio = await envios.registrar_entrega(
        db,
        orden=orden,
        actor_id=current_user.id,
        actor_rol=estados_de_envio.PROVEEDOR,
    )
    if antes is not None and antes.status != envio.status:
        await envios.avisar(db, orden=orden, estado=envio.status)
    await db.commit()
    return await _del_proveedor(db, orden=orden)


@router.post(
    "/seller/orders/{order_id}/shipment/failed",
    response_model=PedidoDelProveedorConEnvio,
)
async def registrar_el_fallo(
    order_id: str,
    cuerpo: MotivoRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """El intento de entrega no salio. CON MOTIVO, siempre.

    EL PAQUETE NO VUELVE AL ALMACEN. Una entrega fallida no repone nada: donde
    esta esa unidad y que se hace con ella es inspeccion de posventa, y es de
    los Incrementos 7 a 9. Reponerla aqui la pondria a la venta estando en un
    camion.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    envio = await envios.registrar_fallo(
        db,
        orden=orden,
        actor_id=current_user.id,
        actor_rol=estados_de_envio.PROVEEDOR,
        motivo=cuerpo.reason,
    )
    await envios.avisar(db, orden=orden, estado=envio.status)
    await db.commit()
    return await _del_proveedor(db, orden=orden)


@router.post(
    "/seller/orders/{order_id}/shipment/retry",
    response_model=PedidoDelProveedorConEnvio,
)
async def reintentar_la_entrega(
    order_id: str,
    cuerpo: MotivoRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PedidoDelProveedorConEnvio:
    """El transportista vuelve a intentarlo. NO ES MARCHA ATRAS.

    El paquete no vuelve al almacen y el inventario no se toca: sigue fuera. Es
    un intento nuevo, y lleva motivo para que se pueda leer por que fallo el
    anterior.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden, _ = await envios.pedido_del_proveedor(
        db, orden_id=order_id, usuario_id=current_user.id
    )
    await envios.reintentar_entrega(
        db,
        orden=orden,
        actor_id=current_user.id,
        actor_rol=estados_de_envio.PROVEEDOR,
        motivo=cuerpo.reason,
    )
    await db.commit()
    return await _del_proveedor(db, orden=orden)




# --------------------------------------------------------------------------- #
# Las incidencias (Incremento 7)
#
# TRES PUERTAS DISTINTAS Y NINGUNA DE CORTESIA. Quien compro entra por
# `de_quien_compra`, quien vende por `de_quien_vende` —que ademas exige
# capacidad comercial activa— y administracion por `exigir_mediador`, que es
# `admin` y no `is_admin`: resolver decide sobre dinero y sobre mercancia.
#
# Y EL AJENO ES UN 404 EN LOS DOS PRIMEROS. Decir «existe pero no es tuyo» ya
# cuenta que alguien abrio una disputa sobre ese pedido.
# --------------------------------------------------------------------------- #
async def _caso(
    db: AsyncSession, fila, *, actor: str | None = None
) -> IncidenciaRead:
    """El expediente como lo lee una pantalla, con las pruebas firmadas."""
    caso = await incidencias.leer(db, incidencia_id=fila.id)
    firmadas = await incidencias.firmar([p.storage_path for p in caso.evidence])
    return IncidenciaRead(
        id=caso.id,
        order_id=caso.order_id,
        order_item_id=caso.order_item_id,
        reason=caso.reason,
        description=caso.description,
        status=caso.status,
        seller_response_due_at=caso.seller_response_due_at,
        seller_responded_at=caso.seller_responded_at,
        seller_proposal=caso.seller_proposal,
        resolution=caso.resolution,
        resolved_at=caso.resolved_at,
        financial_effect=caso.financial_effect,
        appeal_due_at=caso.appeal_due_at,
        appealed_at=caso.appealed_at,
        appeals_used=caso.appeals_used,
        withdrawn_at=caso.withdrawn_at,
        evidence=[
            PruebaRead(
                id=p.id,
                uploaded_role=p.uploaded_role,
                content_type=p.content_type,
                byte_size=p.byte_size,
                width=p.width,
                height=p.height,
                caption=p.caption,
                #: LA URL SE FIRMA AQUI Y NO SE GUARDA. Nula si el
                #: almacenamiento no contesta: el caso se lee igual.
                url=firmadas.get(p.storage_path),
                created_at=p.created_at,
            )
            for p in caso.evidence
        ],
        history=[
            PasoDelCaso(
                from_status=e.from_status,
                to_status=e.to_status,
                actor_role=e.actor_role,
                note=e.note,
                created_at=e.created_at,
            )
            for e in caso.history
        ],
        available_transitions=(
            list(maquina_de_incidencias.siguientes(caso.status, actor))
            if actor is not None
            else []
        ),
        created_at=caso.created_at,
    )


def _resumen_del_caso(fila) -> IncidenciaResumen:
    return IncidenciaResumen(
        id=fila.id,
        order_id=fila.order_id,
        order_item_id=fila.order_item_id,
        reason=fila.reason,
        status=fila.status,
        seller_response_due_at=fila.seller_response_due_at,
        resolution=fila.resolution,
        created_at=fila.created_at,
    )


@router.get("/incidents", response_model=list[IncidenciaResumen])
async def mis_incidencias(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[IncidenciaResumen]:
    """Mis casos, los mas nuevos primero. SIN LA DESCRIPCION.

    Lo que hace falta para elegir cual abrir es de que pedido es y en que
    estado esta; el texto de lo que paso se lee entrando.
    """
    return [
        _resumen_del_caso(c)
        for c in await incidencias.mias(db, usuario_id=current_user.id)
    ]


@router.post(
    "/orders/{order_id}/incidents", response_model=IncidenciaRead, status_code=201
)
async def abrir_incidencia(
    order_id: str,
    cuerpo: AbrirIncidencia,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Reporta un problema con un pedido entregado. ABRIR NO ES APROBAR NADA.

    EL CASO NACE SIN EVIDENCIA Y SIN PLAZO CORRIENDO. El blueprint pide 2-6
    fotografias, y exigirlas aqui obligaria a subirlas antes de que exista el
    caso del que cuelgan. Asi que se abre, se le anaden las pruebas y se ENVIA:
    ahi se comprueba el minimo y ahi empieza a correr el plazo del proveedor,
    que el blueprint cuenta «desde la notificacion».

    NO SE RECLAMA SOBRE ALGO QUE NO SALIO. Si el paquete sigue en el almacen, lo
    que hay que mirar es el envio, y el 409 lo dice con su estado dentro.
    """
    ensure_uuid(order_id, "Pedido no encontrado.")
    if cuerpo.order_item_id is not None:
        ensure_uuid(cuerpo.order_item_id, "Articulo no encontrado.")
    caso = await incidencias.abrir(
        db,
        orden_id=order_id,
        usuario_id=current_user.id,
        motivo=cuerpo.reason,
        descripcion=cuerpo.description,
        order_item_id=cuerpo.order_item_id,
    )
    await db.commit()
    return await _caso(db, caso, actor="buyer")


@router.get("/incidents/{incident_id}", response_model=IncidenciaRead)
async def mi_incidencia(
    incident_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Un caso mio. EL AJENO ES UN 404, nunca un 403."""
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_compra(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    return await _caso(db, caso, actor="buyer")


@router.post(
    "/incidents/{incident_id}/evidence", response_model=IncidenciaRead, status_code=201
)
async def anadir_evidencia(
    incident_id: str,
    archivo: UploadFile = File(...),
    caption: str | None = Form(default=None),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Cuelga una fotografia del expediente. SOLO SE ANADE, Y NO SE QUITA.

    EL ARCHIVO VIAJA A LA API, no al almacenamiento, y aqui SE MIRAN LOS BYTES:
    los primeros para descartar barato, y despues se abre la imagen de verdad,
    porque una cabecera de JPEG se puede pegar delante de cualquier cosa. Tres
    tipos y ninguno mas, sin `image/*`, que dejaria pasar SVG.

    EL NOMBRE LO GENERA EL SERVIDOR. El que trae quien sube puede llevar `../`.

    Y NI SIQUIERA QUIEN LA SUBIO PUEDE QUITARLA DESPUES: retirar una foto
    despues de que la otra parte la haya visto es reescribir lo que se discutio.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_compra(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    datos = await archivo.read()
    medida = fotos.medir(datos, declarado=archivo.content_type)

    prueba = await incidencias.anadir_prueba(
        db,
        caso=caso,
        medida=medida,
        actor_id=current_user.id,
        actor_rol="buyer",
        pie=caption,
    )
    #: LA FILA PRIMERO Y EL ARCHIVO DESPUES. Si la subida falla, la transaccion
    #: se deshace y no queda una fila apuntando a un archivo que no existe; al
    #: reves quedaria un archivo huerfano en el deposito, que es menos grave
    #: pero tambien hay que evitarlo, y por eso la ruta se genera con el
    #: identificador de la fila.
    await almacenamiento.subir_objeto(
        incidencias.DEPOSITO, prueba.storage_path, datos, medida.content_type
    )
    await db.commit()
    return await _caso(db, caso, actor="buyer")


@router.post("/incidents/{incident_id}/submit", response_model=IncidenciaRead)
async def enviar_incidencia(
    incident_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Manda el caso al proveedor y ARRANCA SU PLAZO DE 48 HORAS.

    AQUI SE COMPRUEBA EL MINIMO DE FOTOGRAFIAS. A la entrega negada no se le
    piden: no hay nada que fotografiar porque el paquete no esta, y exigirlas
    convertiria el unico recurso de quien no recibio nada en un requisito
    imposible.

    REPETIRLO NO REINICIA EL PLAZO del proveedor: seria una forma de darle menos
    tiempo del que tiene.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_compra(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    antes = caso.seller_response_due_at
    await incidencias.enviar(db, caso=caso, usuario_id=current_user.id)
    if antes is None and caso.seller_response_due_at is not None:
        #: EL AVISO SOLO CUANDO ACABA DE PASAR, y dentro de la transaccion: asi
        #: no anuncia algo que no llego a ocurrir.
        await incidencias.avisar(db, caso=caso, estado=maquina_de_incidencias.ABIERTA)
    await db.commit()
    return await _caso(db, caso, actor="buyer")


@router.post("/incidents/{incident_id}/reply", response_model=IncidenciaRead)
async def responder_a_lo_pedido(
    incident_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """He aportado lo que me pidieron: la pelota vuelve al proveedor.

    Y SU PLAZO EMPIEZA DE NUEVO: no puede correrle el reloj mientras espera la
    evidencia que el mismo pidio, ni empezar con el tiempo ya gastado.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_compra(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    await incidencias.mover(
        db,
        incidencia_id=caso.id,
        hasta=maquina_de_incidencias.ABIERTA,
        actor_id=current_user.id,
        actor_rol="buyer",
    )
    await incidencias.avisar(db, caso=caso, estado=maquina_de_incidencias.ABIERTA)
    await db.commit()
    return await _caso(db, caso, actor="buyer")


@router.post("/incidents/{incident_id}/escalate", response_model=IncidenciaRead)
async def pedir_mediacion(
    incident_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """No acepto lo que proponen: que lo mire Z.

    NO CIERRA NADA NI DECIDE NADA. Pasa el caso a la cola de mediacion, que es
    donde una persona lo lee.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_compra(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    await incidencias.mover(
        db,
        incidencia_id=caso.id,
        hasta=maquina_de_incidencias.MEDIACION,
        actor_id=current_user.id,
        actor_rol="buyer",
    )
    await db.commit()
    return await _caso(db, caso, actor="buyer")


@router.post("/incidents/{incident_id}/appeal", response_model=IncidenciaRead)
async def apelar(
    incident_id: str,
    cuerpo: NotaDelCaso,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Una sola apelacion, dentro de 48 horas y CON EVIDENCIA NUEVA.

    «NUEVA» ES «POSTERIOR A LA RESOLUCION», y se sabe mirando las fechas. Sin
    esa condicion, apelar seria repetir la misma frase mas alto: el blueprint
    pide evidencia nueva precisamente para que la segunda vuelta mire algo que
    la primera no vio.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_compra(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    await incidencias.mover(
        db,
        incidencia_id=caso.id,
        hasta=maquina_de_incidencias.APELADA,
        actor_id=current_user.id,
        actor_rol="buyer",
        nota=cuerpo.note,
    )
    await db.commit()
    return await _caso(db, caso, actor="buyer")


@router.post("/incidents/{incident_id}/withdraw", response_model=IncidenciaRead)
async def retirar_incidencia(
    incident_id: str,
    cuerpo: NotaDelCaso,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Retiro mi caso. CON MOTIVO, y queda en el historial.

    RETIRAR NO BORRA NADA. El expediente sigue entero —descripcion, evidencia e
    historial— y el renglon dice que se retiro y por que: un caso que
    desapareciera dejaria a la otra parte sin poder demostrar que existio.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_compra(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    await incidencias.mover(
        db,
        incidencia_id=caso.id,
        hasta=maquina_de_incidencias.RETIRADA,
        actor_id=current_user.id,
        actor_rol="buyer",
        nota=cuerpo.note,
    )
    await db.commit()
    return await _caso(db, caso, actor="buyer")


# --------------------------------------------------------------------------- #
# Lo del proveedor
# --------------------------------------------------------------------------- #
@router.get("/seller/incidents", response_model=list[IncidenciaResumen])
async def incidencias_de_mi_tienda(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[IncidenciaResumen]:
    """Los casos de mi tienda. SIN LA DESCRIPCION, que se lee entrando."""
    vendedor = await permisos.exigir_vendedor_activo(db, current_user.id)
    return [
        _resumen_del_caso(c)
        for c in await incidencias.de_mi_tienda(db, seller_id=vendedor.id)
    ]


@router.get("/seller/incidents/{incident_id}", response_model=IncidenciaRead)
async def incidencia_de_mi_tienda(
    incident_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Un caso de mi tienda. EL DE OTRA ES UN 404."""
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_vende(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    return await _caso(db, caso, actor="seller")


@router.post("/seller/incidents/{incident_id}/respond", response_model=IncidenciaRead)
async def responder_incidencia(
    incident_id: str,
    cuerpo: RespuestaDelProveedor,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Respondo con una PROPUESTA. PROPONER NO ES RESOLVER.

    Las cinco salidas mueven dinero, mueven mercancia o niegan la reclamacion, y
    ninguna de las tres puede decidirla en solitario quien tiene el conflicto.
    Lo que se escribe aqui es `seller_proposal`; `resolution` la registra
    administracion, y no hay ninguna ruta por la que el proveedor la escriba.

    PEDIR MAS EVIDENCIA ES OTRO PASO, no una propuesta: tiene su propia ruta
    porque para el expediente significa algo distinto —el caso no avanza, se
    para— y porque para el reloj del proveedor tambien: se le para.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_vende(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    await incidencias.mover(
        db,
        incidencia_id=caso.id,
        hasta=maquina_de_incidencias.RESPONDIDA,
        actor_id=current_user.id,
        actor_rol="seller",
        nota=cuerpo.note,
        propuesta=cuerpo.proposal,
    )
    await incidencias.avisar(
        db, caso=caso, estado=maquina_de_incidencias.RESPONDIDA
    )
    await db.commit()
    return await _caso(db, caso, actor="seller")


@router.post(
    "/seller/incidents/{incident_id}/request-evidence", response_model=IncidenciaRead
)
async def pedir_mas_evidencia(
    incident_id: str,
    cuerpo: NotaDelCaso,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Pido mas evidencia. CON MOTIVO, y MI PLAZO SE PARA.

    No puede correrle el reloj al proveedor mientras espera la evidencia que el
    mismo pidio: seria cobrarle el tiempo de la otra parte.
    """
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await incidencias.de_quien_vende(
        db, incidencia_id=incident_id, usuario_id=current_user.id
    )
    await incidencias.mover(
        db,
        incidencia_id=caso.id,
        hasta=maquina_de_incidencias.MAS_EVIDENCIA,
        actor_id=current_user.id,
        actor_rol="seller",
        nota=cuerpo.note,
    )
    await incidencias.avisar(
        db, caso=caso, estado=maquina_de_incidencias.MAS_EVIDENCIA
    )
    await db.commit()
    return await _caso(db, caso, actor="seller")
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


# --------------------------------------------------------------------------- #
# Condiciones de venta y conciliacion (Incremento 5)
#
# EL ROL VA ANTES DE LA PUERTA DE ESQUEMA, como en el resto: si fuera al reves,
# una cuenta sin permisos distinguiria un 503 de un 403 y averiguaria que
# migraciones estan aplicadas en produccion.
# --------------------------------------------------------------------------- #
@admin_router.get("/policies", response_model=list[PoliticaRead])
async def politicas_de_un_pais(
    country: str = Query(min_length=2, max_length=2),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PoliticaRead]:
    """Todas las versiones de un pais, las mas nuevas primero."""
    await permisos.exigir_publicador(db, current_user.id)
    await esquema.exigir_politicas(db)
    return [_politica(p) for p in await politicas.historial(db, pais=country)]


@admin_router.post("/policies", response_model=PoliticaRead, status_code=201)
async def publicar_politica(
    cuerpo: PublicarPolitica,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Publica la version siguiente de un pais.

    ES LO QUE HABILITA LA VENTA EN ESA JURISDICCION, y por eso lo hace
    administracion y no curaduria: es el mismo permiso que poner el sello de Z
    en el catalogo.

    LA VERSION LA PONE EL SERVIDOR. Dejarla al cliente permitiria publicar la 7
    antes que la 6, y un pedido que dice «version 6» apuntaria a la que se
    escribio despues.
    """
    await permisos.exigir_publicador(db, current_user.id)
    await esquema.exigir_politicas(db)
    politica = await politicas.publicar(
        db,
        pais=cuerpo.country_code,
        entidad=cuerpo.seller_entity,
        moneda=cuerpo.currency,
        texto=cuerpo.terms,
        incident_report_hours=cuerpo.incident_report_hours,
        return_shipment_days=cuerpo.return_shipment_days,
        withdrawal_days=cuerpo.withdrawal_days,
        buyer_pays_return_for_remorse=cuerpo.buyer_pays_return_for_remorse,
        seller_pays_return_for_defect=cuerpo.seller_pays_return_for_defect,
        warranty_rules_url=cuerpo.warranty_rules_url,
        effective_at=cuerpo.effective_at,
        actor_id=current_user.id,
    )
    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        actor_role="admin",
        action="product_policy.publish",
        entity_type="product_policy",
        entity_id=politica.id,
        payload={
            "country": politica.country_code,
            "version": int(politica.version),
            "terms_sha256": politica.terms_sha256,
        },
    )
    await db.commit()
    return _politica(politica)


@admin_router.post("/policies/{policy_id}/retire", response_model=PoliticaRead)
async def retirar_politica(
    policy_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Deja de vender bajo esa version. NO TOCA NINGUN PEDIDO."""
    await permisos.exigir_publicador(db, current_user.id)
    await esquema.exigir_politicas(db)
    ensure_uuid(policy_id, "Condiciones de venta no encontradas.")
    politica = await politicas.retirar(
        db, politica_id=policy_id, actor_id=current_user.id
    )
    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        actor_role="admin",
        action="product_policy.retire",
        entity_type="product_policy",
        entity_id=politica.id,
        payload={"country": politica.country_code, "version": int(politica.version)},
    )
    await db.commit()
    return _politica(politica)


@admin_router.get("/orders/review", response_model=list[PedidoRead])
async def pedidos_en_revision(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PedidoRead]:
    """Los pedidos que necesitan que los mire una persona.

    HOY SON LOS PAGOS QUE LLEGARON TARDE: el dinero entro y la reserva ya no
    estaba. Ni se cobra en silencio ni se niega en silencio.

    SIN NINGUNA DIRECCION, y por eso no usa el molde completo. Conciliar un
    cobro es cuadrar importe, moneda, entorno y referencia; para eso no hace
    falta saber donde vive nadie. La 0078 justifica no poner politicas de
    lectura sobre estas tablas diciendo que las direcciones solo las ven quien
    compra, quien tiene que entregar y una revision AUDITADA: esta ruta
    entregaba la lista entera de domicilios a cualquier cuenta de curaduria y
    sin dejar rastro de quien la miro.

    Y SOLO `admin`. Publicar o retirar una politica ya exigia el rol estrecho;
    leer una cola de pedidos con dinero de por medio no puede exigir menos.
    """
    await permisos.exigir_publicador(db, current_user.id)
    await esquema.exigir_pedidos(db)
    ordenes = await pedidos.en_revision(db)
    #: EL ACCESO DEJA RASTRO, Y UNA FILA POR PEDIDO. Una sola fila diria «miro
    #: la cola» y no cuales; con una por pedido se puede contestar «quien vio
    #: este expediente y cuando», que es lo que de verdad se pregunta despues.
    for orden in ordenes:
        await auditoria.anotar(
            db,
            actor_id=current_user.id,
            actor_role="admin",
            action="product_order.review_queue",
            entity_type="product_order",
            entity_id=orden.id,
            reason=orden.review_reason,
        )
    await db.commit()
    return [await _pedido(db, o, con_direccion=False) for o in ordenes]


@admin_router.post("/orders/expire", response_model=VencimientoRead)
async def vencer_pedidos(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VencimientoRead:
    """Suelta lo que apartaban los pedidos cuya reserva ya expiro.

    NO HAY NINGUN TEMPORIZADOR DENTRO DE FASTAPI, y no es un olvido: la API
    puede correr con varias replicas y un temporizador por replica es el mismo
    barrido ejecutandose tantas veces como procesos haya. Esta ruta la llama un
    planificador de fuera.

    IDEMPOTENTE: llamarla dos veces seguidas devuelve cero la segunda porque ya
    no queda nada que vencer.
    """
    await permisos.exigir_publicador(db, current_user.id)
    await esquema.exigir_pedidos(db)
    return VencimientoRead(expired=await pedidos.vencer(db))


@admin_router.get("/shipments", response_model=list[EnvioPendienteRead])
async def envios_pendientes(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EnvioPendienteRead]:
    """Los pedidos pagados cuyo paquete todavia no ha llegado.

    LOS QUE MAS LLEVAN ESPERANDO, PRIMERO. Y NO SE MARCA NINGUNO COMO
    «ATRASADO»: ninguna politica publicada fija un plazo de despacho, y
    llamarle tarde a algo sin plazo es inventarse el plazo. Lo que se da es el
    tiempo transcurrido, que es un hecho; quien mira decide.

    SIN NINGUN DATO PERSONAL. Ni direccion, ni nombre de quien compro, ni
    importe: para saber si un paquete esta parado hace falta de quien es, en
    que estado esta y cuanto lleva asi. Por eso esta cola NO usa el molde del
    pedido, y por eso —a diferencia de la de conciliacion— la puede leer
    curaduria sin que eso reparta domicilios.

    INCLUYE LOS QUE NADIE HA TOCADO. Son precisamente los mas importantes de
    esta lista, y un `join` normal los dejaria fuera.
    """
    await permisos.exigir_evaluador(db, current_user.id)
    await esquema.exigir_pedidos(db)
    return [
        EnvioPendienteRead(**fila.__dict__)
        for fila in await envios.para_administracion(db)
    ]


@admin_router.post("/shipments/{order_id}/transition", response_model=EnvioRead)
async def intervenir_el_envio(
    order_id: str,
    cuerpo: TransicionDeEnvioRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EnvioRead:
    """Mueve un envio parado. SIEMPRE CON MOTIVO Y SIEMPRE CON RASTRO.

    LO QUE ADMINISTRACION PUEDE HACER AQUI ES ESTRECHO A PROPOSITO:

      * reabrir un paquete cerrado que no ha salido;
      * registrar que la entrega fallo —eso se lo cuenta el transportista—;
      * registrar que el transportista vuelve a intentarlo.

    LO QUE NO PUEDE, Y LO IMPIDE LA MAQUINA:

      * DESPACHAR. Sacar unidades del almacen es del proveedor: es el unico que
        puede afirmar que la caja salio.
      * ESCRIBIR «ENTREGADO». No tiene como saberlo, y fabricar una entrega
        arrancaria plazos de posventa que nadie ha cumplido.
      * CANCELAR un pedido ya pagado. El salto existe en la maquina, pero
        devolver el dinero exige una politica que nadie ha publicado: el
        servicio lo para con su propio codigo y dice que falta.

    Y MODERACION NO ENTRA. Un envio mueve inventario, y mover inventario no es
    moderar: la puerta es `admin`, la misma que ya guarda el ajuste de
    existencias.
    """
    await envios.exigir_interventor(db, current_user.id)
    await esquema.exigir_pedidos(db)
    await esquema.exigir_envios(db)
    ensure_uuid(order_id, "Pedido no encontrado.")
    orden = await db.get(ProductOrder, order_id)
    if orden is None:
        raise NotFoundError("Pedido no encontrado.", code="product_order_not_found")

    if cuerpo.to == estados_de_envio.CANCELADO:
        #: SE PARA ANTES DE TOCAR NADA. `envios.cancelar` explica por que.
        await envios.cancelar(
            db, orden=orden, actor_id=current_user.id, motivo=cuerpo.reason
        )

    envio = await envios.mover(
        db,
        orden=orden,
        hasta=cuerpo.to,
        actor_id=current_user.id,
        actor_rol=estados_de_envio.ADMINISTRACION,
        motivo=cuerpo.reason,
    )
    if envio.status == estados_de_envio.ENTREGA_FALLIDA:
        await envios.avisar(db, orden=orden, estado=envio.status)
    await db.commit()
    return await _envio(db, envio, actor=estados_de_envio.ADMINISTRACION)




@admin_router.get("/incidents", response_model=list[IncidenciaResumen])
async def cola_de_mediacion(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[IncidenciaResumen]:
    """Los casos que esperan a una persona de Z. LOS MAS VIEJOS PRIMERO.

    NO SE MARCA NINGUNO COMO FUERA DE PLAZO. El blueprint pide que Z decida en
    «tres dias habiles», y «habil» depende de un calendario de festivos que
    nadie ha definido: llamarle tarde a algo sin plazo medible es inventarse el
    plazo. Lo que se da es el orden, que es un hecho.

    SIN LA DESCRIPCION, que es donde esta el texto libre de lo que le paso a
    alguien. Se lee entrando al caso.

    Y SOLO `admin`. Resolver decide sobre dinero y sobre mercancia, asi que
    tambien mirar la cola: no tiene sentido abrir la lista a quien no puede
    hacer nada con ella, y esta lista dice quien tiene una disputa abierta.
    """
    await incidencias.exigir_mediador(db, current_user.id)
    await esquema.exigir_incidencias(db)
    return [_resumen_del_caso(c) for c in await incidencias.en_mediacion(db)]


@admin_router.post("/incidents/escalate-overdue", response_model=EscaladaRead)
async def escalar_las_vencidas(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EscaladaRead:
    """Manda a mediacion los casos cuyo plazo del proveedor vencio.

    EL SILENCIO NO CIERRA NADA: pasa a mediacion, no a «rechazado» ni a
    «aceptado». Que el proveedor no conteste no significa que tenga razon ni
    que no la tenga.

    NO HAY NINGUN TEMPORIZADOR DENTRO DE FASTAPI, igual que con el vencimiento
    de reservas: la API puede correr con varias replicas y un temporizador por
    replica es el mismo barrido ejecutandose tantas veces como procesos haya.
    Esta ruta la llama un planificador de fuera.

    IDEMPOTENTE: llamarla dos veces seguidas devuelve cero la segunda porque ya
    no queda ninguno con el plazo vencido y abierto.
    """
    await incidencias.exigir_mediador(db, current_user.id)
    await esquema.exigir_incidencias(db)
    return EscaladaRead(escalated=await incidencias.escalar_las_vencidas(db))
@admin_router.get("/incidents/{incident_id}", response_model=IncidenciaRead)
async def expediente(
    incident_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """El expediente entero, para poder decidir.

    AQUI SI SE VE TODO: la descripcion, la evidencia firmada y el historial con
    sus notas. Es lo que hace falta para resolver, y por eso esta detras de
    `admin` y no de curaduria.
    """
    await incidencias.exigir_mediador(db, current_user.id)
    await esquema.exigir_incidencias(db)
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await db.get(ProductIncident, incident_id)
    if caso is None:
        raise NotFoundError(
            "Incidencia no encontrada.", code="product_incident_not_found"
        )
    #: EL ACCESO DEJA RASTRO. Igual que la cola de conciliacion de pedidos: con
    #: una fila por expediente se puede contestar «quien vio este caso y
    #: cuando», que es lo que de verdad se pregunta despues.
    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        actor_role="admin",
        action="product_incident.read",
        entity_type="product_order",
        entity_id=caso.order_id,
        payload={"incident_id": caso.id, "status": caso.status},
    )
    await db.commit()
    return await _caso(db, caso, actor="admin")


@admin_router.post("/incidents/{incident_id}/resolve", response_model=IncidenciaRead)
async def resolver_incidencia(
    incident_id: str,
    cuerpo: ResolverIncidencia,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IncidenciaRead:
    """Registra la resolucion. RESOLVER NO ES PAGAR.

    LO QUE ESTA RUTA ESCRIBE es `resolution` —una de las cinco salidas— y un
    `financial_effect` que nace PENDIENTE. LO QUE NO HACE, Y NO ES UN OLVIDO:

      * NO LLAMA A NINGUN ADAPTADOR DE REEMBOLSOS. Devolver el dinero es del
        Incremento 9 y no existe; que exista una decision no significa que el
        dinero se haya movido.
      * NO TOCA EL INVENTARIO. Una resolucion de reposicion no saca una unidad
        del almacen ni devuelve la dañada: donde esta esa unidad lo decide una
        persona, y sacarla aqui la venderia dos veces.
      * NO FIJA NINGUN IMPORTE. «Reembolso parcial» dice que se decidio
        devolver parte; cuanto es una decision que nadie ha tomado y para la
        que no hay ni columna.

    Y NUNCA ES `REQUEST_MORE_EVIDENCE`: pedir mas evidencia es un paso, no una
    salida, y contarlo como resolucion daria un numero falso.
    """
    await incidencias.exigir_mediador(db, current_user.id)
    await esquema.exigir_incidencias(db)
    ensure_uuid(incident_id, "Incidencia no encontrada.")
    caso = await db.get(ProductIncident, incident_id)
    if caso is None:
        raise NotFoundError(
            "Incidencia no encontrada.", code="product_incident_not_found"
        )
    await incidencias.mover(
        db,
        incidencia_id=caso.id,
        hasta=maquina_de_incidencias.RESUELTA,
        actor_id=current_user.id,
        actor_rol="admin",
        nota=cuerpo.note,
        resolucion=cuerpo.resolution,
    )
    await incidencias.avisar(db, caso=caso, estado=maquina_de_incidencias.RESUELTA)
    await db.commit()
    return await _caso(db, caso, actor="admin")


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
