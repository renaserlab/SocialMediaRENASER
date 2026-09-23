"""Incremento 1 de Productos: el dominio mínimo, contra PostgreSQL de verdad.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. NADIE VENDE POR REGISTRARSE. Sin capacidad comercial activa no se crea ni
     se postula un producto, y eso es lo que hace que Z no sea un marketplace
     abierto.
  2. UN PRODUCTO AJENO ES UN 404. Decir «existe pero no es tuyo» ya cuenta que
     existe.
  3. LO PUBLICADO NO SE TOCA. Un borrador se edita; una versión publicada no, y
     sus variantes y su galería tampoco, porque son lo que se evaluó.
  4. NADIE PUBLICA POR CREAR. Crear no es autopublicar, y publicar exige una
     evaluación que en este incremento todavía no existe.
  5. NINGÚN VALOR INVENTADO. Un precio nulo no es gratis, una categoría que no
     existe no se acepta, y una moneda sin importe no es un importe.
  6. LAS RESTRICCIONES REALES. Los índices parciales y los CHECK de la 0070 se
     comprueban contra PostgreSQL, no contra el ORM: la suite monta SQLite desde
     los modelos y un CHECK que solo viva en el `.sql` sería invisible.
"""

from __future__ import annotations

import inspect
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import pytest
import pytest_asyncio
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.exceptions import AppError
from app.modules.products import esquema, permissions, service
from app.modules.products import states as maquina
from app.modules.products.models import (
    BORRADOR,
    ENVIADO,
    PUBLICADO,
    VENDEDOR_ACTIVO,
    VENDEDOR_PENDIENTE,
    VERSION_BORRADOR,
    Product,
    ProductCategory,
    FOTO_APROBADA,
    ProductMedia,
    ProductSeller,
    ProductVariant,
    ProductVersion,
)
from app.modules.profiles import models as _perfiles  # noqa: F401
from tests.test_migraciones_reales import exigir_url_desechable

RAIZ = Path(__file__).resolve().parents[3]
MIGRACIONES = RAIZ / "supabase" / "migrations"
PROLOGO = RAIZ / "supabase" / "tests" / "prologo_local.sql"
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()

SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)


@pytest.fixture(scope="module")
def base_aplicada():
    """Las 75 migraciones desde cero, una vez por módulo.

    UNA SOLA EJECUCIÓN A LA VEZ POR BASE. Esto hace `drop schema public cascade`
    antes de migrar, así que DOS pasadas de pytest contra la misma
    `MIGRACIONES_DATABASE_URL` se destruyen entre ellas: lo que se ve son
    `InvalidSchemaName: schema "public" does not exist` y algún interbloqueo
    entre el DDL de esta fixture y una sesión que aún no cerró.

    Parece una suite que no repite y no lo es: seis pasadas seguidas en
    solitario dan el mismo número. Si hace falta correr dos a la vez, cada una
    necesita SU PROPIA BASE —`create database ...` y otra URL—, no otro
    proceso sobre la misma.
    """
    if not URL:
        pytest.skip("sin PostgreSQL desechable")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        with conexion.cursor() as cur:
            cur.execute("drop schema if exists public cascade")
            cur.execute("drop schema if exists auth cascade")
            cur.execute("drop schema if exists storage cascade")
            cur.execute("create schema public")
            cur.execute(PROLOGO.read_text(encoding="utf-8"))
        for ruta in sorted(MIGRACIONES.glob("*.sql")):
            with conexion.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))
    esquema.olvidar()
    return True


@pytest_asyncio.fixture()
async def sesiones(base_aplicada):
    motor = create_async_engine(URL.replace("postgresql://", "postgresql+asyncpg://", 1))
    yield async_sessionmaker(motor, expire_on_commit=False)
    await motor.dispose()


def ahora() -> datetime:
    return datetime.now(timezone.utc)


# =========================================================================== #
# Ayudantes
# =========================================================================== #
async def persona(sesiones, etiqueta="p", *, rol: str | None = None) -> str:
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:i as uuid), cast(:e as text), "
                " jsonb_build_object('full_name','P','username',cast(:u as text)))"
            ),
            {
                "i": ident,
                "e": f"{etiqueta}-{ident[:8]}@x.test",
                "u": f"{etiqueta}{ident[:8]}",
            },
        )
        if rol:
            await db.execute(
                text("update public.profiles set role = :r where id = cast(:i as uuid)"),
                {"r": rol, "i": ident},
            )
        await db.commit()
    return ident


async def vendedor(sesiones, perfil: str, *, estado=VENDEDOR_ACTIVO) -> str:
    """Capacidad comercial escrita a mano: la admisión es del incremento 2."""
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        db.add(
            ProductSeller(
                id=ident,
                profile_id=perfil,
                display_name="Taller de pruebas",
                status=estado,
                activated_at=ahora() if estado == VENDEDOR_ACTIVO else None,
            )
        )
        await db.commit()
    return ident


async def categoria(sesiones, slug="utiles") -> str:
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        db.add(ProductCategory(id=ident, slug=f"{slug}-{ident[:6]}", name="Útiles"))
        await db.commit()
    return ident


DATOS = {
    "name": "Cuchillo de cocina forjado",
    "summary": "Acero al carbono, mango de madera local.",
    "description": "Una descripción suficientemente larga para leerla.",
    "materials": "Acero al carbono 1095, nogal",
    "origin_country": "PE",
    "manufacturer": "Taller Andino",
    "price_minor": 18_000,
    "currency": "PEN",
}

VARIANTES = [
    {"sku": "CUCH-20", "name": "20 cm", "options": {"largo": "20cm"}},
    {"sku": "CUCH-24", "name": "24 cm", "options": {"largo": "24cm"},
     "price_delta_minor": 3_000},
]

#: Una fotografía COMO LA DEJA EL CAMINO REAL: con su tipo, su peso, sus
#: medidas y su huella. Escribirla sin nada de eso pasaría los CHECK de la 0073
#: por casualidad y dejaría sin probar que aprobar exige un archivo detrás.
async def foto_aprobada(
    sesiones, version_id: str, *, quien: str | None = None, ruta: str | None = None
) -> str:
    """Deja una foto APROBADA en esa versión y devuelve su identificador."""
    identificador = str(uuid.uuid4())
    async with sesiones() as db:
        db.add(
            ProductMedia(
                id=identificador,
                version_id=version_id,
                kind="image",
                storage_path=ruta or f"vend/prod/{version_id}/{identificador}.jpg",
                alt_text="Cuchillo de cocina forjado sobre una tabla",
                position=0,
                status=FOTO_APROBADA,
                content_type="image/jpeg",
                byte_size=48_120,
                width=1200,
                height=900,
                checksum_sha256="a" * 64,
                reviewed_at=ahora(),
                reviewed_by=quien,
            )
        )
        await db.commit()
    return identificador


async def producto_en_borrador(
    sesiones, perfil: str, *, con_foto: bool = True, **extra
) -> tuple[str, str]:
    async with sesiones() as db:
        producto, version = await service.crear(
            db,
            usuario_id=perfil,
            datos={**DATOS, **extra},
            variantes=VARIANTES,
        )
        await db.commit()
        producto_id, version_id = producto.id, version.id
    if con_foto:
        await foto_aprobada(sesiones, version_id)
    return producto_id, version_id


# =========================================================================== #
# Capacidad comercial
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_vende_por_registrarse(sesiones) -> None:
    """SIN CAPACIDAD COMERCIAL ACTIVA NO SE CREA NADA.

    Es la puerta que distingue una casa de selección de un marketplace abierto,
    y `pending` no es «casi activo».
    """
    quien = await persona(sesiones, "sin")
    async with sesiones() as db:
        with pytest.raises(permissions.SinCapacidadComercial) as fallo:
            await service.crear(db, usuario_id=quien, datos=DATOS)
    assert fallo.value.code == "product_seller_not_active"

    # `pending` tampoco: nadie le concedió nada todavía.
    await vendedor(sesiones, quien, estado=VENDEDOR_PENDIENTE)
    async with sesiones() as db:
        with pytest.raises(permissions.SinCapacidadComercial):
            await service.crear(db, usuario_id=quien, datos=DATOS)

    async with sesiones() as db:
        assert (await db.scalar(select(func.count()).select_from(Product))) == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_activo_sin_fecha_lo_rechaza_la_base(sesiones) -> None:
    """UNA CAPACIDAD QUE NADIE CONCEDIÓ no puede existir.

    El CHECK de la 0070 no es decorativo: sin él, un `update` que pusiera
    `active` dejaría a alguien vendiendo sin que constara quién lo autorizó.
    """
    quien = await persona(sesiones, "org")
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                "insert into public.product_sellers (profile_id, display_name, status)"
                " values (cast(%s as uuid), 'Sin fecha', 'active')",
                (quien,),
            )


# =========================================================================== #
# Crear y editar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_producto_nace_borrador_y_no_publicado(sesiones) -> None:
    """CREAR NO ES AUTOPUBLICAR. Es el mismo criterio que en eventos."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    producto_id, version_id = await producto_en_borrador(sesiones, quien)

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        version = await db.get(ProductVersion, version_id)
        assert producto.status == BORRADOR
        assert producto.published_version_id is None
        assert producto.published_at is None
        assert version.status == VERSION_BORRADOR
        assert version.published_at is None
        # LA HUELLA SE CALCULA SOLA, y es la del contenido con sus variantes.
        assert version.content_sha256 == service.huella(DATOS, variantes=VARIANTES)
        assert len(version.content_sha256) == 64


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_huella_cambia_con_cualquier_cosa_que_se_lea(sesiones) -> None:
    """SI LA HUELLA NO CAMBIA, NO DEMUESTRA NADA.

    Se comprueba campo por campo: uno que faltara en el cálculo haría que
    cambiarlo pasara sin rastro, y la huella dejaría de servir para decir qué se
    evaluó.
    """
    base = service.huella(DATOS, variantes=VARIANTES)
    for campo in service.CAMPOS_DE_LA_HUELLA:
        cambiado = dict(DATOS)
        cambiado[campo] = 999 if isinstance(DATOS.get(campo), int) else "otra cosa"
        assert service.huella(cambiado, variantes=VARIANTES) != base, campo
    # Y con las variantes: cambiar un SKU o un precio también cuenta.
    otras = [dict(VARIANTES[0], sku="OTRO"), VARIANTES[1]]
    assert service.huella(DATOS, variantes=otras) != base
    # EL ORDEN NO CUENTA: es canónica.
    assert service.huella(DATOS, variantes=list(reversed(VARIANTES))) == base


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_precio_sin_moneda_no_es_un_precio(sesiones) -> None:
    """Y UN NULO NO ES GRATIS: es «sin precio configurado»."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await service.crear(
                db, usuario_id=quien, datos={**DATOS, "currency": None}
            )
    assert fallo.value.code == "product_price_without_currency"

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await service.crear(
                db, usuario_id=quien, datos={**DATOS, "price_minor": None}
            )
    assert fallo.value.code == "product_price_without_currency"

    # SIN NINGUNO DE LOS DOS SÍ SE PUEDE: es un producto sin precio decidido.
    async with sesiones() as db:
        _, version = await service.crear(
            db,
            usuario_id=quien,
            datos={**DATOS, "price_minor": None, "currency": None},
        )
        await db.commit()
    assert version.price_minor is None
    assert version.currency is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_categoria_que_no_existe_no_se_inventa(sesiones) -> None:
    """LA TABLA NACE VACÍA a propósito: las categorías las decide la empresa."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await service.crear(
                db, usuario_id=quien, datos=DATOS, category_id=str(uuid.uuid4())
            )
    assert fallo.value.code == "product_category_invalid"

    real = await categoria(sesiones)
    async with sesiones() as db:
        producto, _ = await service.crear(
            db, usuario_id=quien, datos=DATOS, category_id=real
        )
        await db.commit()
    assert producto.category_id == real


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_edita_el_producto_de_otro(sesiones) -> None:
    """404 PARA EL AJENO, nunca 403: un 403 ya cuenta que existe."""
    mio = await persona(sesiones, "org")
    ajeno = await persona(sesiones, "otro")
    await vendedor(sesiones, mio)
    await vendedor(sesiones, ajeno)
    producto_id, _ = await producto_en_borrador(sesiones, mio)

    async with sesiones() as db:
        with pytest.raises(permissions.NoEsTuProducto) as fallo:
            await service.guardar_borrador(
                db, producto_id=producto_id, usuario_id=ajeno, datos=DATOS
            )
    assert fallo.value.status_code == 404
    assert fallo.value.code == "product_not_found"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_guardar_reemplaza_las_variantes_y_no_las_acumula(sesiones) -> None:
    """GUARDAR ES IDEMPOTENTE. Mandar la misma lista dos veces deja lo mismo."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    producto_id, version_id = await producto_en_borrador(sesiones, quien)

    for _ in range(2):
        async with sesiones() as db:
            await service.guardar_borrador(
                db,
                producto_id=producto_id,
                usuario_id=quien,
                datos=DATOS,
                variantes=VARIANTES,
            )
            await db.commit()

    async with sesiones() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(ProductVariant)
                .where(ProductVariant.version_id == version_id)
            )
        ) == 2
        assert (
            await db.scalar(
                select(func.count())
                .select_from(ProductMedia)
                .where(ProductMedia.version_id == version_id)
            )
        ) == 1

    # Y quitar una variante la QUITA: no queda huérfana enseñándose en la ficha.
    async with sesiones() as db:
        await service.guardar_borrador(
            db,
            producto_id=producto_id,
            usuario_id=quien,
            datos=DATOS,
            variantes=[VARIANTES[0]],
        )
        await db.commit()
    async with sesiones() as db:
        skus = list(
            await db.scalars(
                select(ProductVariant.sku).where(
                    ProductVariant.version_id == version_id
                )
            )
        )
    assert skus == ["CUCH-20"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_galeria_guarda_rutas_y_no_urls(sesiones) -> None:
    """UNA URL FIRMADA CADUCA. Guardarla haría que la galería dejara de cargar
    sin que nadie tocara nada.

    Y DESDE LA 0073 NO HAY FORMA DE PEGAR UNA: el borrador ya no acepta rutas
    —`service.crear` no tiene parámetro de galería— y la ruta la genera el
    servidor. Lo que queda por comprobar es que la BASE también lo rechaza, para
    el día que alguien escriba por otra vía.
    """
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    _, version_id = await producto_en_borrador(sesiones, quien, con_foto=False)

    assert "galeria" not in inspect.signature(service.crear).parameters
    assert "galeria" not in inspect.signature(service.guardar_borrador).parameters

    async with sesiones() as db:
        db.add(
            ProductMedia(
                version_id=version_id,
                storage_path="https://cdn.example/1.jpg?firma=x",
                alt_text="una URL donde iba una ruta",
            )
        )
        with pytest.raises(IntegrityError) as violado:
            await db.commit()
    assert "product_media_ruta_no_es_url" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_variantes_con_el_mismo_sku_no_pasan(sesiones) -> None:
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await service.crear(
                db,
                usuario_id=quien,
                datos=DATOS,
                variantes=[VARIANTES[0], dict(VARIANTES[1], sku="CUCH-20")],
            )
    assert fallo.value.code == "product_variant_sku_repeated"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_producto_enviado_deja_de_ser_editable(sesiones) -> None:
    """EDITAR LO QUE ALGUIEN ESTÁ EVALUANDO cambia el objeto de la evaluación a
    mitad de camino, y el sello acabaría puesto sobre un texto que nadie vio."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien)

    async with sesiones() as db:
        await service.transicionar(
            db,
            producto_id=producto_id,
            hasta=ENVIADO,
            actor_id=quien,
            actor_rol=maquina.PROVEEDOR,
        )
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await service.guardar_borrador(
                db, producto_id=producto_id, usuario_id=quien, datos=DATOS
            )
    assert fallo.value.code == "product_not_editable"


# =========================================================================== #
# La base impone lo que el código promete
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_solo_borrador_por_producto(sesiones) -> None:
    """DOS `PUT` SIMULTÁNEOS creaban dos borradores y el servicio leía uno: el
    otro quedaba huérfano. Esto no lo resuelve una comprobación en Python."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien)

    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.UniqueViolation):
            cur.execute(
                "insert into public.product_versions (product_id, version, status,"
                " name, content_sha256) values (cast(%s as uuid), 'otra', 'draft',"
                " 'Segundo borrador', repeat('a', 64))",
                (producto_id,),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_sola_version_vigente_por_producto(sesiones) -> None:
    """DOS PUBLICADAS SIN CERRAR serían dos fichas del mismo producto según el
    orden de lectura."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien)

    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        cur.execute(
            "insert into public.product_versions (product_id, version, status,"
            " name, content_sha256, published_at) values (cast(%s as uuid), 'p1',"
            " 'published', 'Uno', repeat('b', 64), now())",
            (producto_id,),
        )
        with pytest.raises(psycopg.errors.UniqueViolation):
            cur.execute(
                "insert into public.product_versions (product_id, version, status,"
                " name, content_sha256, published_at) values (cast(%s as uuid),"
                " 'p2', 'published', 'Dos', repeat('c', 64), now())",
                (producto_id,),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_publicado_exige_version_publicada(sesiones) -> None:
    """UN PRODUCTO EN CATÁLOGO SIN NADA QUE ENSEÑAR reventaría la ficha."""
    quien = await persona(sesiones, "org")
    vendedor_id = await vendedor(sesiones, quien)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                "insert into public.products (seller_id, status, published_at)"
                " values (cast(%s as uuid), 'published', now())",
                (vendedor_id,),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_tablas_de_productos_no_las_lee_la_aplicacion(sesiones) -> None:
    """RLS ACTIVA Y CERO PRIVILEGIOS. Se entra por la API, que comprueba la
    propiedad y el rol; una política de lectura sobre `products` dejaría a la
    aplicación decidiendo qué cuenta como publicado."""
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        cur.execute(
            "select c.relname, c.relrowsecurity from pg_class c"
            " join pg_namespace n on n.oid = c.relnamespace"
            " where n.nspname = 'public' and c.relkind = 'r'"
            " and (c.relname like 'product%' or c.relname like 'seller%'"
            "      or c.relname in ('saved_products', 'inventory_movements'))"
        )
        tablas = dict(cur.fetchall())
        # LAS TRECE DE LOS INCREMENTOS 1-3, LAS CUATRO DEL 4, LAS CINCO DEL 5,
        # LAS TRES DEL 6, LAS TRES DEL 7, LAS TRES DEL 8 Y LAS CUATRO DEL 9.
        # El número se escribe entero a propósito: si mañana aparece una tabla
        # de Productos sin RLS, esta prueba se pone roja antes de que nadie la
        # despliegue.
        assert len(tablas) == 35, sorted(tablas)
        for nueva in (
            "product_refunds",
            "product_refund_events",
            "product_disputes",
            "product_dispute_events",
            "product_reviews",
            "product_review_replies",
            "product_review_moderation",
            "product_inventory",
            "inventory_movements",
            "product_carts",
            "product_cart_items",
            "product_policies",
            "product_orders",
            "product_order_items",
            "product_order_addresses",
            "product_order_events",
            "product_shipments",
            "product_shipment_items",
            "product_shipment_events",
            "product_incidents",
            "product_incident_evidence",
            "product_incident_events",
        ):
            assert nueva in tablas, nueva
        sin_rls = sorted(t for t, activa in tablas.items() if not activa)
        assert sin_rls == [], sin_rls

        cur.execute(
            "select table_name, grantee from information_schema.table_privileges"
            " where table_schema = 'public' and grantee in ('anon','authenticated')"
            " and (table_name like 'product%' or table_name like 'seller%'"
            "      or table_name in ('saved_products', 'inventory_movements'))"
        )
        assert cur.fetchall() == []

        cur.execute(
            "select tablename, policyname from pg_policies where schemaname='public'"
            " and (tablename like 'product%' or tablename like 'seller%'"
            "      or tablename = 'saved_products')"
        )
        assert cur.fetchall() == []


# =========================================================================== #
# El ciclo
# =========================================================================== #
def test_el_ciclo_es_el_del_blueprint() -> None:
    """LA CADENA, LETRA POR LETRA, y ningún estado atascado.

    Un estado sin salida que no sea final es un producto parado para siempre, y
    nadie se entera hasta que hay uno.
    """
    from app.modules.products.models import ESTADOS_DE_PRODUCTO

    assert ESTADOS_DE_PRODUCTO == (
        "draft",
        "submitted",
        "document_review",
        "sample_requested",
        "evaluation",
        "conditionally_approved",
        "approved",
        "published",
        "observation",
        "suspended",
        "removed",
    )
    for estado in ESTADOS_DE_PRODUCTO:
        salidas = [h for (d, h) in maquina.TRANSICIONES if d == estado]
        if maquina.es_final(estado):
            assert salidas == [], estado
        else:
            assert salidas, f"{estado} no tiene salida y no es final"


def test_un_condicionado_no_puede_publicar() -> None:
    """LA EMPRESA NO HA DEFINIDO LAS CONDICIONES de una aprobación condicionada.

    Publicarlo «mientras tanto» sería ponerle el sello de Z a algo que nadie
    autorizó del todo. No hay salto, y falla en cerrado.
    """
    assert not maquina.existe("conditionally_approved", PUBLICADO)
    with pytest.raises(maquina.SaltoInexistente):
        maquina.exigir("conditionally_approved", PUBLICADO, maquina.ADMINISTRACION)
    # Y vuelve a evaluación, que es el camino que sí existe.
    maquina.exigir("conditionally_approved", "evaluation", maquina.ADMINISTRACION)


def test_solo_administracion_publica_y_retira() -> None:
    """CURADURÍA PUNTÚA, ADMINISTRACIÓN DECIDE. Es el patrón de eventos (D34).

    Y el veredicto lo escribe el SISTEMA: que un producto esté aprobado es
    consecuencia de una puntuación con evidencia, no de que alguien pulse.
    """
    maquina.exigir("approved", PUBLICADO, maquina.ADMINISTRACION)
    for quien in (maquina.PROVEEDOR, maquina.EVALUADOR, maquina.SISTEMA):
        with pytest.raises(maquina.SaltoNoPermitido):
            maquina.exigir("approved", PUBLICADO, quien)
    for destino in ("approved", "conditionally_approved"):
        maquina.exigir("evaluation", destino, maquina.SISTEMA)
        for quien in (maquina.PROVEEDOR, maquina.EVALUADOR, maquina.ADMINISTRACION):
            with pytest.raises(maquina.SaltoNoPermitido):
                maquina.exigir("evaluation", destino, quien)


def test_un_producto_retirado_no_vuelve() -> None:
    """QUITARLO DEL CATÁLOGO Y DEVOLVERLO sin que nadie lo mire otra vez es cómo
    se cuela algo retirado por un motivo."""
    assert maquina.es_final("removed")
    for quien in (
        maquina.PROVEEDOR,
        maquina.EVALUADOR,
        maquina.ADMINISTRACION,
        maquina.SISTEMA,
    ):
        assert maquina.siguientes("removed", quien) == ()


def test_un_suspendido_no_esta_en_catalogo_y_un_observado_si() -> None:
    """OBSERVAR ES VIGILAR, NO ESCONDER. Y suspender es lo contrario."""
    assert PUBLICADO in maquina.EN_CATALOGO
    assert "observation" in maquina.EN_CATALOGO
    assert "suspended" not in maquina.EN_CATALOGO
    assert "removed" not in maquina.EN_CATALOGO
    assert BORRADOR not in maquina.EN_CATALOGO


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_suspender_exige_un_motivo(sesiones) -> None:
    """SACARLE EL PRODUCTO A ALGUIEN SIN DECIRLE POR QUÉ no es una decisión."""
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    producto_id, version_id = await producto_en_borrador(sesiones, quien)
    async with sesiones() as db:
        # Se lleva a publicado a mano: publicar de verdad exige evaluación, y
        # eso es del incremento 2.
        version = await db.get(ProductVersion, version_id)
        version.status = "published"
        version.published_at = ahora()
        version.effective_from = ahora()
        producto = await db.get(Product, producto_id)
        producto.published_version_id = version_id
        producto.status = PUBLICADO
        producto.published_at = ahora()
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await service.transicionar(
                db,
                producto_id=producto_id,
                hasta="suspended",
                actor_id=quien,
                actor_rol=maquina.ADMINISTRACION,
            )
    assert fallo.value.code == "product_suspension_needs_reason"

    async with sesiones() as db:
        producto = await service.transicionar(
            db,
            producto_id=producto_id,
            hasta="suspended",
            actor_id=quien,
            actor_rol=maquina.ADMINISTRACION,
            motivo="el lote no coincide con la muestra",
        )
        await db.commit()
    assert producto.suspension_reason == "el lote no coincide con la muestra"
    assert producto.suspended_at is not None


# =========================================================================== #
# Publicar exige evaluación
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_publicar_sin_evaluacion_no_se_puede(sesiones) -> None:
    """EL SELLO DE Z NO ES UNA ETIQUETA QUE SE PONE UNO MISMO.

    `por_que_no_se_publica` es UNA SOLA PUERTA y devuelve un código: repartir
    estas comprobaciones entre la ruta y la pantalla es cómo se publica algo sin
    evaluación el día que alguien añade un camino nuevo.
    """
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    admin = await persona(sesiones, "adm", rol="admin")
    producto_id, version_id = await producto_en_borrador(sesiones, quien)

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        # EN BORRADOR NO SE PUBLICA: primero hay que aprobarlo.
        falta = await service.por_que_no_se_publica(db, producto=producto)
        assert falta is not None and falta[0] == "product_not_approved"

    # Se lleva a `approved` por el camino de la máquina.
    async with sesiones() as db:
        for desde, hasta, rol in (
            (BORRADOR, ENVIADO, maquina.PROVEEDOR),
            (ENVIADO, "document_review", maquina.EVALUADOR),
            ("document_review", "evaluation", maquina.EVALUADOR),
            ("evaluation", "approved", maquina.SISTEMA),
        ):
            await service.transicionar(
                db,
                producto_id=producto_id,
                hasta=hasta,
                actor_id=admin,
                actor_rol=rol,
            )
        await db.commit()

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        falta = await service.por_que_no_se_publica(db, producto=producto)
        # LA EVALUACIÓN FALTA, y eso es lo que bloquea.
        assert falta is not None
        assert falta[0] == "product_evaluation_required"
        with pytest.raises(AppError) as fallo:
            await service.publicar(db, producto_id=producto_id, usuario_id=admin)
    assert fallo.value.code == "product_evaluation_required"

    # Y SIN FOTO tampoco, aunque hubiera evaluación: una ficha sin imagen no es
    # una tarjeta de producto, es un hueco.
    async with sesiones() as db:
        for m in await db.scalars(
            select(ProductMedia).where(ProductMedia.version_id == version_id)
        ):
            await db.delete(m)
        await db.commit()
    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        falta = await service.por_que_no_se_publica(db, producto=producto)
        assert falta is not None and falta[0] == "product_media_required"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_publica_su_propio_producto(sesiones) -> None:
    """NI SIENDO ADMINISTRADOR, y se comprueba ANTES que el rol: si fuera
    después, el error sería un 403 genérico en vez del motivo real."""
    quien = await persona(sesiones, "adm", rol="admin")
    await vendedor(sesiones, quien)
    producto_id, _ = await producto_en_borrador(sesiones, quien)

    async with sesiones() as db:
        with pytest.raises(permissions.EsTuPropioProducto) as fallo:
            await service.publicar(db, producto_id=producto_id, usuario_id=quien)
    assert fallo.value.code == "product_self_review_forbidden"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_personas_moviendo_el_mismo_producto(sesiones) -> None:
    """LA CARRERA REAL: dos revisores con el mismo producto abierto.

    Lo que impide que las dos escrituras cuenten no es el `if` sino el
    `where status = :desde`, que la base resuelve fila a fila.
    """
    quien = await persona(sesiones, "org")
    await vendedor(sesiones, quien)
    admin = await persona(sesiones, "adm", rol="admin")
    producto_id, _ = await producto_en_borrador(sesiones, quien)

    async with sesiones() as primera, sesiones() as segunda:
        producto = await primera.get(Product, producto_id)
        assert producto.status == BORRADOR
        # La segunda sesión se adelanta y confirma.
        await service.transicionar(
            segunda,
            producto_id=producto_id,
            hasta=ENVIADO,
            actor_id=quien,
            actor_rol=maquina.PROVEEDOR,
        )
        await segunda.commit()
        # La primera todavía cree que está en borrador.
        with pytest.raises(AppError) as fallo:
            await service.transicionar(
                primera,
                producto_id=producto_id,
                hasta=ENVIADO,
                actor_id=quien,
                actor_rol=maquina.PROVEEDOR,
            )
    assert fallo.value.code in ("product_changed", "product_transition_invalid")


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_las_migraciones_las_rutas_contestan_503(sesiones) -> None:
    """503 CON SU CÓDIGO, y no 404 —que haría pensar que la ruta está mal
    escrita— ni 500 —que haría pensar que algo se rompió—."""
    from app.core.exceptions import ServiceUnavailableError

    esquema.olvidar()
    esquema._cache["dominio"] = False
    esquema._cache["admision"] = False
    esquema._cache["guardados"] = False
    try:
        async with sesiones() as db:
            for puerta, codigo in (
                (esquema.exigir_dominio, "products_not_available"),
                (esquema.exigir_admision, "product_admission_not_available"),
                (esquema.exigir_guardados, "product_saves_not_available"),
            ):
                with pytest.raises(ServiceUnavailableError) as fallo:
                    await puerta(db)
                assert fallo.value.code == codigo
                assert fallo.value.status_code == 503
    finally:
        esquema.olvidar()


def test_ningun_AppError_pide_un_status_code_que_no_existe() -> None:
    """UN 409 QUE LLEGABA COMO 500.

    `AppError.__init__` no admite `status_code`: el estado va en el ATRIBUTO DE
    CLASE. Seis sitios lo pasaban como argumento, así que en vez del 409 con su
    código salía un `TypeError` —y con él un 500 que hacía pensar que algo se
    había roto—. El más grave era abrir una solicitud de posventa sobre una
    compra no elegible: el camino normal de quien pulsa un botón que no le toca.

    Esta prueba recorre el árbol para que no vuelva a colarse: quien necesite
    409 usa `ConflictError`, que es lo que ya existía.
    """
    import re as _re
    from pathlib import Path as _Path

    raiz = _Path(__file__).resolve().parents[1] / "app"
    culpables: list[str] = []
    for ruta in raiz.rglob("*.py"):
        texto = ruta.read_text(encoding="utf-8")
        for bloque in _re.findall(
            r"raise\s+(\w*Error)\(((?:[^()]|\([^()]*\))*)\)", texto, _re.S
        ):
            clase, argumentos = bloque
            if "status_code=" in argumentos:
                culpables.append(f"{ruta.name}: {clase}")
    assert culpables == [], culpables
