"""Las rutas del descubrimiento de Servicios (Incremento 3).

LO QUE VE CUALQUIERA, con o sin sesión: el catálogo (buscar, filtrar,
ordenar), las categorías que tienen algo publicado, las sugerencias, el
perfil público de un prestador y sus servicios. La ficha es la del Incremento
2 (`GET /services/catalog/{id}`), ampliada en `catalogo_router.py`.

LO QUE EXIGE SESIÓN: guardar, quitar y la lista propia de guardados.

LA PUERTA, antes de todo: `FEATURE_SERVICES` apagada → 503
`services_disabled` sin mirar la base; sin la 0090 → 503 `services_not_ready`;
y guardar sin la 0091 completa → 503 `services_not_ready`. Nunca un 500.

Lo que no es público es el mismo 404 que no existe.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.services import catalogo as dominio
from app.modules.services import descubrimiento as d
from app.modules.services import esquema, posventa
from app.modules.services.catalogo_router import catalogo_disponible
from app.modules.services.descubrimiento_schemas import (
    CategoriaDelCatalogoRead,
    ConfianzaRead,
    EstadoDeGuardadoRead,
    GuardadoRead,
    PaginaDeGuardadosRead,
    PaginaDelCatalogoRead,
    PerfilDePrestadorRead,
    ResenasRead,
    SeccionDeSugerenciasRead,
    SugerenciasRead,
    TarjetaDeServicioRead,
)
from app.shared.database import get_db

router = APIRouter(prefix="/services", tags=["services-discovery"])


class PrestadorNoEncontrado(NotFoundError):
    code = "service_provider_not_found"
    message = "No encontramos a ese prestador."


async def guardados_disponibles(db: AsyncSession = Depends(get_db)) -> None:
    """El catálogo y, además, la 0091."""
    await esquema.exigir_guardados(db)


def _mira(usuario: AuthUser | None) -> str | None:
    return usuario.id if usuario is not None else None


def _pagina(p: d.Pagina) -> PaginaDelCatalogoRead:
    return PaginaDelCatalogoRead(
        items=[TarjetaDeServicioRead.desde(t) for t in p.items], next_cursor=p.siguiente, sort=p.orden
    )


# =========================================================================== #
# El catálogo
# =========================================================================== #
@router.get("/catalog", response_model=PaginaDelCatalogoRead)
async def catalogo_publico(
    q: str | None = Query(default=None, max_length=120),
    category_id: str | None = Query(default=None, max_length=64),
    modality: str | None = Query(default=None, max_length=32),
    price: str | None = Query(default=None, max_length=32),
    currency: str | None = Query(default=None, max_length=8),
    min_price: int | None = Query(default=None, ge=0, le=10_000_000_000),
    max_price: int | None = Query(default=None, ge=0, le=10_000_000_000),
    area: str | None = Query(default=None, max_length=120),
    credential_verified: bool = Query(default=False),
    sort: str | None = Query(default=None, max_length=32),
    cursor: str | None = Query(default=None, max_length=400),
    limit: int = Query(default=d.POR_PAGINA, ge=1, le=d.LIMITE_MAXIMO),
    current_user: AuthUser | None = Depends(get_optional_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDelCatalogoRead:
    """Lo publicado, buscado, filtrado y ordenado EN LA BASE, por cursor.

    Filtros combinables: categoría (incluye sus subcategorías), modalidad,
    precio (`free`, `priced`, `on_request`), moneda con rango en unidades
    menores, zona general y credencial verificada. Ordenar por precio y un
    rango EXIGEN moneda: no se comparan monedas ni se convierte nada.
    """
    filtros = d.filtros(
        q=q, categoria=category_id, modalidad=modality, precio=price, moneda=currency,
        minimo=min_price, maximo=max_price, zona=area, con_credencial=credential_verified, orden=sort,
    )
    return _pagina(await d.catalogo(db, filtros, mira=_mira(current_user), cursor=cursor, limite=limit))


@router.get("/public-categories", response_model=list[CategoriaDelCatalogoRead])
async def categorias_publicas(
    current_user: AuthUser | None = Depends(get_optional_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> list[CategoriaDelCatalogoRead]:
    """Las categorías (y sus madres) con al menos un servicio público."""
    return [
        CategoriaDelCatalogoRead.desde(c)
        for c in await d.categorias_publicas(db, mira=_mira(current_user))
    ]


@router.get("/suggestions", response_model=SugerenciasRead)
async def sugerencias(
    current_user: AuthUser | None = Depends(get_optional_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> SugerenciasRead:
    """Secciones con una razón de verdad (`similar_to_saved`,
    `recently_published`). Sin señal, sin sección: puede ir vacía."""
    return SugerenciasRead(
        sections=[
            SeccionDeSugerenciasRead(
                reason=s.motivo, items=[TarjetaDeServicioRead.desde(t) for t in s.items]
            )
            for s in await d.sugerencias(db, mira=_mira(current_user))
        ]
    )


# =========================================================================== #
# El perfil público del prestador
# =========================================================================== #
@router.get("/providers/{provider_id}", response_model=PerfilDePrestadorRead)
async def perfil_de_prestador(
    provider_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> PerfilDePrestadorRead:
    """Solo lo autorizado: nombre público, tipo, lo que Z comprobó, sus
    categorías, modalidades y zonas generales. Un prestador sin nada público
    es un 404, igual que uno que no existe."""
    try:
        p = await d.perfil(db, provider_id, mira=_mira(current_user))
    except d.PrestadorNoPublico:
        raise PrestadorNoEncontrado() from None
    cuantas, promedio = await posventa.resenas_visibles(db, prestador_id=p.prestador.id)
    return PerfilDePrestadorRead(
        id=p.prestador.id,
        display_name=p.prestador.display_name,
        provider_type=p.prestador.provider_type,
        trust=ConfianzaRead.desde(p.confianza),
        categories=[CategoriaDelCatalogoRead.desde(c) for c in p.categorias],
        modalities=p.modalidades,
        areas=p.zonas,
        reviews=ResenasRead(count=cuantas, average=promedio),
    )


@router.get("/providers/{provider_id}/services", response_model=PaginaDelCatalogoRead)
async def servicios_de_prestador(
    provider_id: str,
    cursor: str | None = Query(default=None, max_length=400),
    limit: int = Query(default=d.POR_PAGINA, ge=1, le=d.LIMITE_MAXIMO),
    current_user: AuthUser | None = Depends(get_optional_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDelCatalogoRead:
    try:
        return _pagina(
            await d.servicios_del_prestador(
                db, provider_id, mira=_mira(current_user), cursor=cursor, limite=limit
            )
        )
    except d.PrestadorNoPublico:
        raise PrestadorNoEncontrado() from None


# =========================================================================== #
# Guardados
# =========================================================================== #
@router.post("/catalog/{service_id}/save", response_model=EstadoDeGuardadoRead)
async def guardar(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponibles: None = Depends(guardados_disponibles),
    db: AsyncSession = Depends(get_db),
) -> EstadoDeGuardadoRead:
    """IDEMPOTENTE. No reserva, no avisa al prestador y no se cuenta en
    ninguna parte. Solo lo público: lo demás es 404."""
    try:
        await d.guardar(db, mira=current_user.id, servicio_id=service_id)
    except d.ServicioNoPublico:
        raise dominio.ServicioNoEncontrado() from None
    await db.commit()
    return EstadoDeGuardadoRead(saved=True)


@router.delete("/catalog/{service_id}/save", response_model=EstadoDeGuardadoRead)
async def quitar(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponibles: None = Depends(guardados_disponibles),
    db: AsyncSession = Depends(get_db),
) -> EstadoDeGuardadoRead:
    """IDEMPOTENTE, y vale aunque el servicio ya no sea público."""
    try:
        await d.quitar(db, mira=current_user.id, servicio_id=service_id)
    except d.ServicioNoPublico:
        raise dominio.ServicioNoEncontrado() from None
    await db.commit()
    return EstadoDeGuardadoRead(saved=False)


@router.get("/saved", response_model=PaginaDeGuardadosRead)
async def mis_guardados(
    cursor: str | None = Query(default=None, max_length=400),
    limit: int = Query(default=d.POR_PAGINA, ge=1, le=d.LIMITE_MAXIMO),
    current_user: AuthUser = Depends(get_current_user),
    _disponibles: None = Depends(guardados_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeGuardadosRead:
    """Lo guardado, lo más reciente primero. Lo que dejó de estar disponible
    sale sin contenido y con `available: false`, para poder quitarlo."""
    filas, siguiente = await d.guardados(db, mira=current_user.id, cursor=cursor, limite=limit)
    return PaginaDeGuardadosRead(
        items=[
            GuardadoRead(
                service_id=g.servicio_id,
                saved_at=g.guardado_en,
                available=g.tarjeta is not None,
                title=g.titulo,
                service=TarjetaDeServicioRead.desde(g.tarjeta) if g.tarjeta is not None else None,
            )
            for g in filas
        ],
        next_cursor=siguiente,
    )


__all__ = ["router"]
