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

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ServiceUnavailableError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.products import applications, catalog, esquema, evaluations
from app.modules.products import permissions as permisos
from app.modules.products import service
from app.modules.products import states as maquina
from app.modules.products.models import (
    DIMENSIONES,
    Product,
    ProductSeller,
    ProductVersion,
)
from app.modules.products.schemas import (
    BusquedaRead,
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
        gallery=[
            MediaRead(
                id=m.id, kind=m.kind, storage_path=m.storage_path, alt_text=m.alt_text
            )
            for m in await service.galeria_de(db, version_id=version.id)
        ],
    )


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
        galeria=[m.model_dump() for m in cuerpo.gallery],
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
        galeria=[m.model_dump() for m in cuerpo.gallery],
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


__all__ = ["admin_router", "router"]
