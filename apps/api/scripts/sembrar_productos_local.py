# -*- coding: utf-8 -*-
"""Datos de muestra de Productos para una base LOCAL. Nunca para producción.

PARA QUÉ. Para poder mirar las pantallas de Productos con algo dentro sin tocar
la base gestionada. Crea proveedores, productos, evaluaciones, fotografías,
inventario y —si se pide— un carrito, todo por el CAMINO REAL del servidor:
postular, evaluar, publicar. Escribir las filas a mano no probaría nada y
además dejaría estados que el código nunca produce.

TRES GUARDIAS, Y NINGUNO ES OPCIONAL:

  1. LA URL TIENE QUE SER LOCAL. Solo `localhost` o `127.0.0.1`. Si apunta a
     cualquier otra cosa, se para antes de abrir la conexión.
  2. NO PUEDE SER LA DE `apps/api/.env`. Aunque alguien pusiera un túnel local
     hacia la base gestionada, la cadena coincidiría y esto se niega.
  3. `ENVIRONMENT` NO PUEDE SER `production`.

LO QUE NO INVENTA. Ninguna valoración, ninguna compra verificada, ningún plazo
de entrega, ninguna garantía y ningún descuento: esos datos no existen en el
sistema, y sembrarlos aquí los haría aparecer en pantalla como si existieran.
Los productos llevan precio y existencias porque el precio y el inventario SÍ
son columnas reales.

    python scripts/sembrar_productos_local.py --cuenta <uuid del perfil>

`--cuenta` mete ese identificador en `auth.users` para poder entrar en la
aplicación local con una sesión de Supabase real contra datos locales.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import os
import re
import sys
import uuid
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))


def url_del_env() -> str:
    fichero = RAIZ / ".env"
    if not fichero.exists():
        return ""
    for linea in io.open(fichero, encoding="utf-8", errors="replace").read().splitlines():
        if linea.strip().startswith("DATABASE_URL="):
            return linea.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def exigir_local(url: str) -> str:
    """Se para si esto no es, sin lugar a dudas, una base local."""
    if not url:
        raise SystemExit("define DATABASE_URL apuntando a la base local")
    sin_credenciales = re.sub(r"//[^@]*@", "//", url)
    if not re.search(r"@(localhost|127\.0\.0\.1)[:/]", url):
        raise SystemExit(f"esto solo siembra en local; recibí {sin_credenciales}")
    gestionada = url_del_env()
    if gestionada and url.split("?")[0] == gestionada.split("?")[0]:
        raise SystemExit("esa es la cadena de apps/api/.env: NO se siembra ahí")
    if os.environ.get("ENVIRONMENT", "").lower() == "production":
        raise SystemExit("ENVIRONMENT=production: no se siembra")
    return url


CATEGORIAS = [
    ("escritorio", "Escritorio", 0),
    ("cocina", "Cocina", 1),
    ("taller", "Taller", 2),
]

#: Cada uno con su proveedor, su precio real y sus variantes. Los textos
#: describen objetos; ninguno promete plazos, garantías ni valoraciones.
CATALOGO = [
    {
        "vendedor": "Estudio Origen",
        "propuesta": "Objetos para una vida más consciente.",
        "productos": [
            {
                "name": "Planner Atemporal",
                "summary": "Cuaderno de planificación sin fechas impresas.",
                "description": (
                    "Cuaderno cosido de 208 páginas, papel de 120 g y tapa dura "
                    "forrada en tela. Sin fechas impresas: se empieza el día que "
                    "se abra."
                ),
                "materials": "Papel de 120 g, tapa de cartón forrada en tela de algodón.",
                "origin_country": "PE",
                "manufacturer": "Estudio Origen",
                "price_minor": 28_900,
                "currency": "PEN",
                "categoria": "escritorio",
                "nota": 94,
                "variantes": [
                    {"sku": "PLAN-NEG", "name": "Negro", "options": {"color": "negro"}},
                    {
                        "sku": "PLAN-ARE",
                        "name": "Arena",
                        "options": {"color": "arena"},
                        "price_delta_minor": 1_000,
                    },
                ],
                "existencias": {"PLAN-NEG": 14, "PLAN-ARE": 3},
            }
        ],
    },
    {
        "vendedor": "Noma Diseño",
        "propuesta": "Luz que acompaña el trabajo.",
        "productos": [
            {
                "name": "Luz Noma",
                "summary": "Lámpara de escritorio de brazo articulado.",
                "description": (
                    "Lámpara de escritorio con brazo articulado y base de acero. "
                    "Temperatura de color regulable en tres pasos."
                ),
                "materials": "Acero, aluminio anodizado y difusor de policarbonato.",
                "origin_country": "PE",
                "manufacturer": "Noma Diseño",
                "price_minor": 69_000,
                "currency": "PEN",
                "categoria": "escritorio",
                "nota": 91,
                "variantes": [
                    {"sku": "NOMA-GRA", "name": "Grafito", "options": {"color": "grafito"}},
                ],
                #: A PROPÓSITO SIN EXISTENCIAS CARGADAS: es lo que hace visible
                #: que «sin inventario» no se pinta como «agotado».
                "existencias": {},
            }
        ],
    },
    {
        "vendedor": "Forja Andina",
        "propuesta": "Herramienta de cocina hecha para durar.",
        "productos": [
            {
                "name": "Cuchillo de cocina forjado",
                "summary": "Hoja forjada en una pieza, mango de madera estabilizada.",
                "description": (
                    "Cuchillo de cocina forjado en una sola pieza. Mango de madera "
                    "estabilizada remachado en tres puntos."
                ),
                "materials": "Acero al carbono 1075 y madera de nogal estabilizada.",
                "origin_country": "PE",
                "manufacturer": "Forja Andina",
                "price_minor": 32_000,
                "currency": "PEN",
                "categoria": "cocina",
                "nota": 92,
                "variantes": [
                    {"sku": "CUCH-20", "name": "20 cm", "options": {"largo": "20 cm"}},
                    {
                        "sku": "CUCH-24",
                        "name": "24 cm",
                        "options": {"largo": "24 cm"},
                        "price_delta_minor": 3_000,
                    },
                ],
                "existencias": {"CUCH-20": 6, "CUCH-24": 1},
            }
        ],
    },
]


async def sembrar(
    url: str,
    cuenta: str | None,
    *,
    limpiar: bool = False,
    pedido_pagado: bool = False,
    pedido_entregado: bool = False,
) -> None:
    from sqlalchemy import select, text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.modules.products import evaluations, service
    from app.modules.products import states as maquina
    from app.modules.products.models import (
        DIMENSIONES,
        FOTO_APROBADA,
        VENDEDOR_ACTIVO,
        ProductCategory,
        ProductMedia,
        ProductSeller,
    )
    from app.modules.products import inventory as almacen

    #: ENTREGAR IMPLICA PAGAR. No hay forma de despachar un pedido que nadie
    #: cobro, y pedir las dos banderas por separado solo daria un error mas
    #: tarde y mas raro.
    pedido_pagado = pedido_pagado or pedido_entregado

    motor = create_async_engine(
        url.replace("postgresql://", "postgresql+asyncpg://", 1), echo=False
    )
    Sesion = async_sessionmaker(motor, expire_on_commit=False)

    if limpiar:
        # SOLO LAS DE PRODUCTOS, y solo en local: el guardia de arriba ya
        # comprobó que esta base no es la gestionada.
        async with Sesion() as db:
            await db.execute(
                text(
                    "truncate table public.product_incident_events,"
                    " public.product_incident_evidence, public.product_incidents,"
                    " public.product_shipment_events,"
                    " public.product_shipment_items, public.product_shipments,"
                    " public.product_order_events, public.product_order_addresses,"
                    " public.product_order_items, public.product_orders,"
                    " public.product_policies,"
                    " public.product_cart_items, public.product_carts,"
                    " public.inventory_movements, public.product_inventory,"
                    " public.saved_products, public.product_approval_reasons,"
                    " public.product_evaluation_evidence,"
                    " public.product_evaluation_scores, public.product_evaluations,"
                    " public.seller_application_documents, public.seller_applications,"
                    " public.product_media, public.product_variants,"
                    " public.product_versions, public.products,"
                    " public.product_sellers, public.product_categories cascade"
                )
            )
            await db.commit()
        print("tablas de Productos vaciadas en la base local")

    async def persona(etiqueta: str, *, rol: str | None = None) -> str:
        ident = str(uuid.uuid4())
        async with Sesion() as db:
            await db.execute(
                text(
                    "insert into auth.users (id, email, raw_user_meta_data) values "
                    "(cast(:i as uuid), cast(:e as text), "
                    " jsonb_build_object('full_name', cast(:n as text),"
                    "                    'username', cast(:u as text)))"
                ),
                {
                    "i": ident,
                    "e": f"{etiqueta}-{ident[:8]}@local.test",
                    "n": etiqueta,
                    "u": f"{etiqueta.lower().replace(' ', '')}{ident[:6]}",
                },
            )
            if rol:
                await db.execute(
                    text("update public.profiles set role=:r where id=cast(:i as uuid)"),
                    {"r": rol, "i": ident},
                )
            await db.commit()
        return ident

    # ------------------------------------------------------------------ #
    # La cuenta con la que se va a entrar, si se pidió
    # ------------------------------------------------------------------ #
    if cuenta:
        async with Sesion() as db:
            existe = await db.scalar(
                text("select 1 from auth.users where id = cast(:i as uuid)"),
                {"i": cuenta},
            )
            if not existe:
                await db.execute(
                    text(
                        "insert into auth.users (id, email, raw_user_meta_data) values "
                        "(cast(:i as uuid), 'tu-cuenta@local.test', "
                        " jsonb_build_object('full_name','Tu cuenta','username','tucuenta'))"
                    ),
                    {"i": cuenta},
                )
            await db.execute(
                text("update public.profiles set role='admin' where id=cast(:i as uuid)"),
                {"i": cuenta},
            )
            await db.commit()
        print(f"cuenta local lista con rol admin: {cuenta}")

    curador = await persona("Curaduria Z", rol="admin")

    # ------------------------------------------------------------------ #
    # Categorías. Son de muestra LOCAL: las de verdad las decide la empresa.
    # ------------------------------------------------------------------ #
    por_slug: dict[str, str] = {}
    async with Sesion() as db:
        for slug, nombre, posicion in CATEGORIAS:
            fila = await db.scalar(
                select(ProductCategory).where(ProductCategory.slug == slug)
            )
            if fila is None:
                fila = ProductCategory(slug=slug, name=nombre, position=posicion)
                db.add(fila)
                await db.flush()
            por_slug[slug] = fila.id
        await db.commit()

    creados = 0
    for casa in CATALOGO:
        dueno = await persona(casa["vendedor"])
        async with Sesion() as db:
            db.add(
                ProductSeller(
                    profile_id=dueno,
                    display_name=casa["vendedor"],
                    status=VENDEDOR_ACTIVO,
                    activated_at=service.ahora(),
                    activated_by=curador,
                )
            )
            await db.commit()

        for datos in casa["productos"]:
            variantes = datos.pop("variantes")
            existencias = datos.pop("existencias")
            nota = datos.pop("nota")
            categoria = por_slug[datos.pop("categoria")]

            async with Sesion() as db:
                producto, version = await service.crear(
                    db,
                    usuario_id=dueno,
                    datos=datos,
                    category_id=categoria,
                    variantes=variantes,
                )
                await db.commit()
                producto_id, version_id = producto.id, version.id

            # LA FOTOGRAFÍA. En local no hay depósito de almacenamiento, así que
            # la fila queda aprobada y SIN archivo detrás no se podría aprobar:
            # se le ponen sus medidas y su tipo, que es lo que deja el camino
            # real. La pantalla enseñará el texto alternativo porque la URL
            # firmada no se puede emitir sin credenciales de Storage.
            async with Sesion() as db:
                identificador = str(uuid.uuid4())
                db.add(
                    ProductMedia(
                        id=identificador,
                        version_id=version_id,
                        kind="image",
                        storage_path=f"local/{producto_id}/{version_id}/{identificador}.jpg",
                        alt_text=datos["summary"],
                        position=0,
                        status=FOTO_APROBADA,
                        content_type="image/jpeg",
                        byte_size=120_000,
                        width=1400,
                        height=1400,
                        reviewed_at=service.ahora(),
                        reviewed_by=curador,
                    )
                )
                await db.commit()

            # EL CAMINO REAL: postular, admitir, evaluar, publicar.
            async with Sesion() as db:
                for hasta, rol in (
                    ("submitted", maquina.PROVEEDOR),
                    ("document_review", maquina.EVALUADOR),
                    ("evaluation", maquina.EVALUADOR),
                ):
                    await service.transicionar(
                        db,
                        producto_id=producto_id,
                        hasta=hasta,
                        actor_id=dueno if rol == maquina.PROVEEDOR else curador,
                        actor_rol=rol,
                    )
                await db.commit()

            async with Sesion() as db:
                evaluacion = await evaluations.abrir(
                    db, version_id=version_id, usuario_id=curador
                )
                await db.commit()
                evaluacion_id = evaluacion.id

            async with Sesion() as db:
                evidencias = {}
                for dimension in DIMENSIONES:
                    fila = await evaluations.registrar_evidencia(
                        db,
                        evaluacion_id=evaluacion_id,
                        usuario_id=curador,
                        dimension=dimension,
                        kind="inspection",
                        summary=(
                            f"Inspección de {dimension} realizada sobre la muestra."
                        ),
                    )
                    evidencias[dimension] = fila.id
                    await evaluations.puntuar(
                        db,
                        evaluacion_id=evaluacion_id,
                        usuario_id=curador,
                        dimension=dimension,
                        score=nota,
                    )
                await db.commit()

            async with Sesion() as db:
                await evaluations.elegir_razones(
                    db,
                    evaluacion_id=evaluacion_id,
                    usuario_id=curador,
                    razones=[
                        {
                            "text": texto,
                            "evidence_id": evidencias[dimension],
                        }
                        for texto, dimension in (
                            ("Materiales de alta duración", "durability"),
                            ("Origen y creador verificados", "origin"),
                            ("Funciona como promete", "quality"),
                        )
                    ],
                )
                await db.commit()

            async with Sesion() as db:
                await evaluations.decidir(
                    db, evaluacion_id=evaluacion_id, usuario_id=curador
                )
                await db.commit()

            async with Sesion() as db:
                from app.modules.products.models import Product as _P

                bloqueo = await service.por_que_no_se_publica(
                    db, producto=await db.get(_P, producto_id)
                )
                if bloqueo is not None:
                    raise SystemExit(f"no se puede publicar {datos['name']}: {bloqueo}")
                await service.publicar(
                    db, producto_id=producto_id, usuario_id=curador
                )
                await db.commit()

            # EL INVENTARIO, por el camino real: una entrada con su clave.
            async with Sesion() as db:
                for sku, cuantas in existencias.items():
                    await almacen.entrada(
                        db,
                        product_id=producto_id,
                        sku=sku,
                        cantidad=cuantas,
                        clave=f"siembra-{producto_id}-{sku}",
                        actor_id=dueno,
                    )
                await db.commit()
            creados += 1
            print(f"  publicado: {datos['name']}")

    # ------------------------------------------------------------------ #
    # Las condiciones de venta, PARA PODER RECORRER EL CHECKOUT EN LOCAL
    # ------------------------------------------------------------------ #
    # ESTE TEXTO NO ES UNA POLÍTICA DE VERDAD, y lo dice en su primera línea.
    # Existe para que las pantallas del Incremento 5 se puedan ver funcionando
    # en la base local; la política real la escribe una persona y la publica
    # administración por su ruta, con los plazos que decida la empresa.
    #
    # NO SE PUEDE APLICAR A LA BASE GESTIONADA: el guardián de arriba solo
    # admite `localhost`, y además rechaza la URL del `.env`.
    from app.modules.products import politicas as _politicas

    async with Sesion() as db:
        if await _politicas.vigente(db, pais="PE") is None:
            await _politicas.publicar(
                db,
                pais="PE",
                entidad="ENTIDAD DE PRUEBA LOCAL (no es la vendedora real)",
                moneda="PEN",
                texto=(
                    "CONDICIONES DE PRUEBA PARA REVISAR LA APLICACIÓN EN LOCAL. "
                    "No son las condiciones de venta de Z y no obligan a nadie. "
                    "Los plazos que aparecen abajo están puestos para que las "
                    "pantallas tengan algo que enseñar; los de verdad los decide "
                    "la empresa con su abogado y se publican por la ruta de "
                    "administración."
                ),
                incident_report_hours=72,
                return_shipment_days=7,
                withdrawal_days=7,
                buyer_pays_return_for_remorse=True,
                seller_pays_return_for_defect=True,
                warranty_rules_url=None,
                effective_at=None,
                actor_id=None,
            )
            await db.commit()
            print("  condiciones de venta de PRUEBA publicadas para PE")

    # ------------------------------------------------------------------ #
    # UN PEDIDO YA PAGADO, PARA PODER VER LA ENTREGA EN LOCAL (Incremento 6)
    # ------------------------------------------------------------------ #
    # POR QUÉ HACE FALTA UNA PASARELA FALSA. Un pedido solo llega a `PAID` por
    # un aviso verificado de la pasarela; escribir `PAID` a mano dejaría un
    # estado que el código nunca produce —sin fecha de pago y sin referencia
    # del cobro— y el CHECK `product_orders_pagada_con_cobro` lo rechazaría.
    # Así que se recorre el camino real con el borde del proveedor simulado.
    #
    # NO SE MUEVE UN CÉNTIMO. La pasarela falsa no sale a la red, la clave es
    # una cadena de mentira y esto solo corre contra `localhost`: los tres
    # guardias de la cabecera lo comprobaron antes de abrir la conexión.
    #
    # LAS CINCO BANDERAS SE ENCIENDEN SOLO EN ESTE PROCESO, en memoria. No se
    # toca el `.env` ni se escribe ninguna configuración, y nada de esto
    # sobrevive al final del script: que la configuración de fábrica NO venda
    # es justamente lo que comprueba una prueba del servidor.
    if pedido_pagado:
        from app.core.config import get_settings
        from app.modules.payments.providers import CheckoutSession
        from app.modules.products import carts as _bolsa
        from app.modules.products import pagos as _cobros
        from app.modules.products import pedidos as _pedidos
        from app.modules.products.models import ProductOrder as _Pedido
        from app.modules.products.models import ProductVariant as _Variante
        from app.modules.products.models import ProductVersion as _Version

        ajustes = get_settings()
        for nombre, valor in (
            ("feature_product_sales", True),
            ("payments_enabled", True),
            ("stripe_payments_enabled", True),
            ("product_reservation_minutes", 30),
            ("stripe_secret_key", "sk_local_de_mentira_no_es_una_clave"),
        ):
            object.__setattr__(ajustes, nombre, valor)

        class _PasarelaLocal:
            """El BORDE del proveedor, simulado. No sale a la red."""

            name = "stripe"

            async def create_checkout(self, peticion):
                return CheckoutSession(
                    checkout_url=f"https://local.invalido/{peticion.purchase_id}",
                    provider_reference=f"cs_local_{peticion.purchase_id[:12]}",
                )

        class _AvisoLocal:
            """Un aviso YA VERIFICADO, como el que entrega el webhook."""

            def __init__(self, orden) -> None:
                self.purchase_id = orden.id
                self.status = "paid"
                self.amount_minor = int(orden.total_minor)
                self.currency = orden.currency
                self.environment = orden.environment
                self.provider_transaction_id = "pi_local_de_prueba"
                self.event_type = "checkout.session.completed"
                self.event_id = "evt_local_" + uuid.uuid4().hex[:12]
                self.dominio = _cobros.DOMINIO
                self.payload: dict = {}

        _cobros.get_provider = lambda _n: _PasarelaLocal()

        comprador = await persona("Compra de prueba")
        async with Sesion() as db:
            elegida = (
                await db.execute(
                    select(_Variante, _Version)
                    .join(_Version, _Version.id == _Variante.version_id)
                    .where(_Version.status == "published")
                    .limit(1)
                )
            ).first()
            if elegida is None:
                raise SystemExit("no hay ninguna versión publicada que comprar")
            variante, version = elegida
            await _bolsa.anadir(
                db,
                usuario_id=comprador,
                producto_id=version.product_id,
                variante_id=variante.id,
                cantidad=2,
            )
            await db.commit()

        async with Sesion() as db:
            bolsa = await _bolsa.leer(db, usuario_id=comprador)
            vendedor_id = bolsa.items[0].seller_id
            politica = await _politicas.exigir_vigente(db, pais="PE")
            creado = await _pedidos.crear(
                db,
                usuario_id=comprador,
                seller_id=vendedor_id,
                direccion={
                    "recipient_name": "Quien recibe (local)",
                    "phone": "+51900000000",
                    "country_code": "PE",
                    "region": "Lima",
                    "city": "Lima",
                    "district": "Miraflores",
                    "address_line": "Calle de prueba 123",
                    "reference": "Datos inventados para revisar en local",
                    "postal_code": "15074",
                    "instructions": None,
                },
                policy_id=politica.id,
                policy_terms_sha256=politica.terms_sha256,
                clave="siembra-" + uuid.uuid4().hex[:10],
            )
            orden_id = creado.orden.id

        async with Sesion() as db:
            orden = await db.get(_Pedido, orden_id)
            await _cobros.iniciar_pago(db, orden=orden, correo="compra@local.test")
        async with Sesion() as db:
            orden = await db.get(_Pedido, orden_id)
            await _cobros.atender_aviso(db, _AvisoLocal(orden))
            await db.commit()

        async with Sesion() as db:
            orden = await db.get(_Pedido, orden_id)
            estado = orden.status
            dueno_del_pedido = await db.scalar(
                text(
                    "select profile_id from public.product_sellers"
                    " where id = cast(:i as uuid)"
                ),
                {"i": orden.seller_id},
            )
        if estado != "PAID":
            raise SystemExit(f"el pedido de muestra quedó en {estado}, no en PAID")

        if not pedido_entregado:
            print("\nUn pedido PAGADO listo para preparar (pasarela falsa, sin dinero):")
            print(f"  pedido:      {orden_id}")
            print(f"  compra:      {comprador}")
            print(f"               -> /productos/pedidos/{orden_id}")
            print(f"  proveedor:   {dueno_del_pedido}")
            print("               -> /proveedor/pedidos")
            print("  administra:  la cuenta de --cuenta")
            print("               -> /admin/productos/envios")
            print("  el envío nace en «pendiente de preparación»: nadie lo ha tocado.")

        # ------------------------------------------------------------- #
        # Y el paquete, hasta la puerta
        # ------------------------------------------------------------- #
        #
        # POR EL CAMINO REAL, paso a paso: apuntar lo que va en la caja,
        # cerrarla, despachar —que es donde salen las unidades del almacén de
        # verdad, con su movimiento y su clave de idempotencia— y registrar la
        # entrega. Escribir «DELIVERED» a mano dejaría un estado que el código
        # nunca produce, sin movimiento de inventario y sin historial, y las
        # pantallas lo enseñarían como si fuera real.
        #
        # PARA QUÉ HACE FALTA: no se reclama sobre un paquete que no consta
        # entregado, así que sin esto las pantallas del Incremento 7 no se
        # pueden mirar en local.
        if pedido_entregado:
            from app.modules.products import envios as _envios
            from app.modules.products import estados_de_envio as _maquina_envio

            async with Sesion() as db:
                lineas = await _pedidos.lineas_de(db, orden_id)
                cuantas = {l.id: int(l.quantity) for l in lineas}
            async with Sesion() as db:
                orden = await db.get(_Pedido, orden_id)
                await _envios.anotar_preparado(
                    db, orden=orden, cantidades=cuantas, actor_id=dueno_del_pedido
                )
                await db.commit()

            async with Sesion() as db:
                orden = await db.get(_Pedido, orden_id)
                await _envios.marcar_listo(db, orden=orden, actor_id=dueno_del_pedido)
                await db.commit()

            async with Sesion() as db:
                orden = await db.get(_Pedido, orden_id)
                #: SIN TRANSPORTISTA NI REFERENCIA, a propósito: la empresa no
                #: ha elegido ninguno, y sembrar uno inventado lo pintaría en
                #: pantalla como si existiera.
                await _envios.despachar(db, orden=orden, actor_id=dueno_del_pedido)
                await db.commit()

            async with Sesion() as db:
                orden = await db.get(_Pedido, orden_id)
                envio = await _envios.registrar_entrega(
                    db,
                    orden=orden,
                    actor_id=dueno_del_pedido,
                    actor_rol=_maquina_envio.PROVEEDOR,
                )
                await db.commit()
                estado_del_envio = envio.status
            if estado_del_envio != "DELIVERED":
                raise SystemExit(
                    f"el envío quedó en {estado_del_envio}, no en DELIVERED"
                )

            print("")
            print("Un pedido ENTREGADO, listo para reclamar (sin dinero de por medio):")
            print(f"  pedido:      {orden_id}")
            print(f"  compra:      {comprador}")
            print(f"               -> /productos/pedidos/{orden_id}")
            print("               -> ahí abajo: «Reportar un problema»")
            print(f"  proveedor:   {dueno_del_pedido}")
            print("               -> /proveedor/reclamaciones")
            print("  administra:  la cuenta de --cuenta")
            print("               -> /admin/productos/reclamaciones")
            print("  las unidades YA SALIERON del almacén: el despacho las consumió.")
            print("  ninguna reclamación sembrada: abrirla es parte de lo que se revisa.")

    await motor.dispose()
    print(f"\n{creados} productos publicados en la base local.")
    print("Ninguna valoración, ninguna compra verificada y ningún plazo: no existen.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cuenta", default=None, help="uuid del perfil con el que entrarás")
    parser.add_argument(
        "--limpiar",
        action="store_true",
        help="vacía antes las tablas de Productos de la base LOCAL",
    )
    parser.add_argument(
        "--pedido-pagado",
        action="store_true",
        help=(
            "deja además un pedido YA PAGADO listo para preparar, con una "
            "pasarela FALSA. Sin esto no hay forma de ver las pantallas de la "
            "entrega, porque un pedido solo llega a pagado por un aviso de la "
            "pasarela y en local no hay ninguna"
        ),
    )
    parser.add_argument(
        "--pedido-entregado",
        action="store_true",
        help=(
            "lleva ese pedido hasta ENTREGADO por el camino real —preparar, "
            "cerrar, despachar y registrar la entrega—. Implica "
            "--pedido-pagado. Sin esto no hay forma de ver las pantallas de "
            "las reclamaciones, porque no se reclama sobre algo que no consta "
            "entregado"
        ),
    )
    args = parser.parse_args()
    url = exigir_local(
        os.environ.get("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    )
    asyncio.run(
        sembrar(
            url,
            args.cuenta,
            limpiar=args.limpiar,
            pedido_pagado=args.pedido_pagado,
            pedido_entregado=args.pedido_entregado,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
