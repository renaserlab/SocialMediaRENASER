"""El descubrimiento de Servicios (Incremento 3): lo que ve cualquiera.

UNA SOLA AUTORIDAD DE LO PÚBLICO. `condiciones_publicas()` decide qué servicio
puede verse, y la usan el catálogo, la búsqueda, la ficha, el perfil del
prestador, las sugerencias y los guardados. Solo sale un servicio:

  * publicado (ni borrador, ni suspendido, ni retirado),
  * con su versión PUBLICADA (nunca una enviada, en revisión, observada o
    aprobada sin publicar),
  * de un prestador ACTIVO,
  * en una categoría ACTIVA, cuya madre (si la tiene) también lo está, y del
    país del prestador cuando la categoría es de un país,
  * con su imagen de portada,
  * y de alguien que no esté bloqueado con quien mira (en los dos sentidos,
    como la búsqueda global).

EL FILTRO LO APLICA LA BASE, SIEMPRE: nada se trae entero para recortarlo aquí
ni en el teléfono, y cada lista pagina por cursor con un orden total.

BUSCAR NO NECESITA ESQUEMA. Se reutiliza la normalización de la búsqueda global
(`search.normalizacion`): minúsculas, tildes plegadas, palabras vacías fuera,
plurales y un patrón que tolera las tildes de lo que está escrito en la base.
Sin `unaccent`, sin índices nuevos y sin ningún motor externo.

NADA INVENTADO. No hay popularidad, ni valoraciones, ni disponibilidad, ni
«más contratado»: no existen todavía. Las reseñas de un servicio son `0` y su
media es `None`, nunca un cero que parezca una nota; no se reutilizan las de
perfiles, cursos, eventos ni productos.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, case, delete, exists, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import ValidationAppError
from app.modules.search import normalizacion
from app.modules.services import catalogo_estados as estados
from app.modules.services import catalogo_imagenes as imagenes
from app.modules.services import esquema
from app.modules.services.catalogo_models import (
    A_CONSULTAR,
    A_DOMICILIO,
    CATEGORIA_ACTIVA,
    CON_IMPORTE,
    GRATIS,
    MODALIDADES,
    PRESENCIAL,
    VIRTUAL,
    Service,
    ServiceCategory,
    ServiceVersion,
    ServiceVersionImage,
)
from app.modules.services.descubrimiento_models import SavedService
from app.modules.services.models import (
    ACTIVO,
    CREDENCIAL_VERIFICADA,
    DOCUMENTO_ACEPTADO,
    PRESTADOR_ACTIVO,
    ServiceProvider,
    ServiceProviderCredential,
    ServiceProviderDocument,
)
from app.modules.services.service import CursorInvalido
from app.modules.services.service import hoy as _hoy
from app.modules.social_graph.service import blocked_either_way

POR_PAGINA = 20
LIMITE_MAXIMO = 50
#: Cuántas tarjetas lleva cada sección de sugerencias y de «relacionados».
POR_SECCION = 8
RELACIONADOS = 6
#: «Publicado recientemente» es VERDAD solo dentro de esta ventana. Fuera de
#: ella, la sección no sale: nunca se rellena con lo que haya.
DIAS_DE_RECIENTE = 30

ORDEN_RELEVANCIA = "relevance"
ORDEN_RECIENTE = "recent"
ORDEN_PRECIO_ASC = "price_asc"
ORDEN_PRECIO_DESC = "price_desc"
ORDENES = (ORDEN_RELEVANCIA, ORDEN_RECIENTE, ORDEN_PRECIO_ASC, ORDEN_PRECIO_DESC)

PRECIO_GRATIS = "free"
PRECIO_CON_IMPORTE = "priced"
PRECIO_A_CONSULTAR = "on_request"
TIPOS_DE_PRECIO = (PRECIO_GRATIS, PRECIO_CON_IMPORTE, PRECIO_A_CONSULTAR)

#: Los motivos, CÓDIGOS estables que la app traduce. Nunca una frase.
MOTIVO_BUSQUEDA = "matches_search"
MOTIVO_GUARDADOS = "similar_to_saved"
MOTIVO_RECIENTE = "recently_published"
MOTIVO_MISMO_PRESTADOR = "same_provider"
MOTIVO_MISMA_CATEGORIA = "same_category"
MOTIVOS = (MOTIVO_BUSQUEDA, MOTIVO_GUARDADOS, MOTIVO_RECIENTE, MOTIVO_MISMO_PRESTADOR, MOTIVO_MISMA_CATEGORIA)

#: Cuánto suma que un término aparezca en cada sitio. Enteros, para que el
#: cursor compare puntuaciones sin decimales. El ORDEN es la decisión: primero
#: el título; después la categoría y el resumen; después la descripción, el
#: prestador, la zona y la modalidad.
PESO_TITULO = 8
PESO_CATEGORIA = 4
PESO_RESUMEN = 4
PESO_DESCRIPCION = 2
PESO_PRESTADOR = 2
PESO_ZONA = 2
PESO_MODALIDAD = 2

#: Palabras que nombran una modalidad (ya plegadas, como las devuelve
#: `normalizacion.terminos`).
MODALIDAD_POR_PALABRA = {
    "virtual": VIRTUAL,
    "online": VIRTUAL,
    "linea": VIRTUAL,
    "remoto": VIRTUAL,
    "remota": VIRTUAL,
    "videollamada": VIRTUAL,
    "presencial": PRESENCIAL,
    "domicilio": A_DOMICILIO,
}


# --------------------------------------------------------------------------- #
# Errores
# --------------------------------------------------------------------------- #
class ConsultaMuyCorta(ValidationAppError):
    code = "service_catalog_query_too_short"
    message = "Escribe al menos dos letras para buscar."


class FiltroInvalido(ValidationAppError):
    code = "service_catalog_filter_invalid"
    message = "Ese filtro no es válido."


class MonedaRequerida(ValidationAppError):
    code = "service_catalog_currency_required"
    message = "Elige la moneda para filtrar u ordenar por precio: no se comparan importes de monedas distintas."


# --------------------------------------------------------------------------- #
# Los filtros, validados sin base de datos
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Filtros:
    """Lo que se pidió, YA VALIDADO. Se construye con `filtros(...)`."""

    q: str | None = None
    terminos: tuple[str, ...] = ()
    categoria: str | None = None
    modalidad: str | None = None
    precio: str | None = None
    moneda: str | None = None
    minimo: int | None = None
    maximo: int | None = None
    zona: tuple[str, ...] = ()
    con_credencial: bool = False
    orden: str = ORDEN_RECIENTE


def _uuid_valido(valor: str) -> bool:
    try:
        UUID(str(valor))
    except ValueError:
        return False
    return True


def filtros(
    *,
    q: str | None = None,
    categoria: str | None = None,
    modalidad: str | None = None,
    precio: str | None = None,
    moneda: str | None = None,
    minimo: int | None = None,
    maximo: int | None = None,
    zona: str | None = None,
    con_credencial: bool = False,
    orden: str | None = None,
) -> Filtros:
    """Valida y normaliza. Un filtro que no se entiende es un 422 con el campo
    en `details`, nunca un filtro ignorado en silencio."""
    texto = " ".join((q or "").split())
    terminos: tuple[str, ...] = ()
    if texto:
        terminos = tuple(normalizacion.terminos(texto))
        if not terminos:
            raise ConsultaMuyCorta()

    if categoria is not None and not _uuid_valido(categoria):
        raise FiltroInvalido(details={"field": "category_id"})
    if modalidad is not None and modalidad not in MODALIDADES:
        raise FiltroInvalido(details={"field": "modality"})
    if precio is not None and precio not in TIPOS_DE_PRECIO:
        raise FiltroInvalido(details={"field": "price"})

    if moneda is not None:
        moneda = moneda.strip().upper()
        if len(moneda) != 3 or not moneda.isalpha() or not moneda.isascii():
            raise FiltroInvalido(details={"field": "currency"})
    for nombre, valor in (("min_price", minimo), ("max_price", maximo)):
        if valor is not None and valor < 0:
            raise FiltroInvalido(details={"field": nombre})
    if (minimo is not None or maximo is not None) and moneda is None:
        # SIN MONEDA NO HAY RANGO: 100 soles y 100 dólares no son lo mismo, y
        # aquí no se convierte nada.
        raise MonedaRequerida()
    if minimo is not None and maximo is not None and minimo > maximo:
        raise FiltroInvalido(details={"field": "min_price"})
    if precio in (PRECIO_GRATIS, PRECIO_A_CONSULTAR) and (moneda or minimo is not None or maximo is not None):
        # «Gratis» y «a consultar» no tienen importe: un rango con ellos es una
        # contradicción, no un filtro.
        raise FiltroInvalido(details={"field": "price"})
    if moneda is not None:
        precio = PRECIO_CON_IMPORTE

    zona_texto = " ".join((zona or "").split())
    terminos_de_zona: tuple[str, ...] = ()
    if zona_texto:
        if len(zona_texto) > 80:
            raise FiltroInvalido(details={"field": "area"})
        terminos_de_zona = tuple(normalizacion.terminos(zona_texto))
        if not terminos_de_zona:
            raise FiltroInvalido(details={"field": "area"})

    if orden is not None and orden not in ORDENES:
        raise FiltroInvalido(details={"field": "sort"})
    if orden is None or (orden == ORDEN_RELEVANCIA and not terminos):
        # Sin consulta no hay relevancia que medir: lo más reciente primero.
        orden = ORDEN_RELEVANCIA if terminos else ORDEN_RECIENTE
    if orden in (ORDEN_PRECIO_ASC, ORDEN_PRECIO_DESC):
        if moneda is None:
            raise MonedaRequerida()
        precio = PRECIO_CON_IMPORTE

    return Filtros(
        q=texto or None, terminos=terminos, categoria=categoria, modalidad=modalidad,
        precio=precio, moneda=moneda, minimo=minimo, maximo=maximo, zona=terminos_de_zona,
        con_credencial=bool(con_credencial), orden=orden,
    )


# --------------------------------------------------------------------------- #
# El cursor: opaco, con el orden dentro
# --------------------------------------------------------------------------- #
def cursor_de(orden: str, claves: list) -> str:
    crudo = json.dumps({"o": orden, "k": claves}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(crudo).decode().rstrip("=")


def leer_cursor(cursor: str, orden: str) -> list:
    """Las claves del cursor, validadas una a una. Un cursor de OTRO orden es
    inválido: seguir con él saltaría o repetiría filas."""
    try:
        relleno = "=" * (-len(cursor) % 4)
        datos = json.loads(base64.urlsafe_b64decode(cursor + relleno))
        claves = datos["k"]
        if datos["o"] != orden or not isinstance(claves, list):
            raise ValueError
        if orden == ORDEN_RECIENTE:
            momento, ident = claves
            return [_momento(momento), _ident(ident)]
        if orden == ORDEN_RELEVANCIA:
            puntos, momento, ident = claves
            if not isinstance(puntos, int) or isinstance(puntos, bool):
                raise ValueError
            return [puntos, _momento(momento), _ident(ident)]
        importe, ident = claves
        if not isinstance(importe, int) or isinstance(importe, bool):
            raise ValueError
        return [importe, _ident(ident)]
    except (ValueError, TypeError, KeyError, binascii.Error, UnicodeDecodeError):
        raise CursorInvalido() from None


def _momento(valor) -> datetime:
    momento = datetime.fromisoformat(valor)
    return momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)


def _ident(valor) -> str:
    return str(UUID(str(valor)))


def _iso(momento: datetime) -> str:
    return (momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)).isoformat()


# --------------------------------------------------------------------------- #
# Lo público: UNA definición
# --------------------------------------------------------------------------- #
def condiciones_publicas() -> tuple:
    """Lo que hace público a un servicio, sobre `Service`, la `ServiceVersion`
    publicada, su `ServiceProvider` y su `ServiceCategory` ya unidos."""
    madre = aliased(ServiceCategory)
    return (
        Service.status.in_(tuple(estados.VISIBLE_AL_PUBLICO)),
        ServiceVersion.status == estados.PUBLICADA,
        ServiceProvider.status == PRESTADOR_ACTIVO,
        ServiceCategory.status == CATEGORIA_ACTIVA,
        or_(
            ServiceCategory.parent_id.is_(None),
            exists().where(madre.id == ServiceCategory.parent_id, madre.status == CATEGORIA_ACTIVA),
        ),
        or_(
            ServiceCategory.country_code.is_(None),
            ServiceCategory.country_code == ServiceProvider.country_code,
        ),
        exists().where(
            ServiceVersionImage.version_id == ServiceVersion.id, ServiceVersionImage.is_cover.is_(True)
        ),
    )


def base(mira: str | None = None):
    """`(servicio, versión publicada, prestador, categoría)` de lo público."""
    consulta = (
        select(Service, ServiceVersion, ServiceProvider, ServiceCategory)
        .join(
            ServiceVersion,
            and_(ServiceVersion.service_id == Service.id, ServiceVersion.status == estados.PUBLICADA),
        )
        .join(ServiceProvider, ServiceProvider.id == Service.provider_id)
        .join(ServiceCategory, ServiceCategory.id == Service.category_id)
        .where(*condiciones_publicas())
    )
    if mira:
        consulta = consulta.where(ServiceProvider.profile_id.not_in(blocked_either_way(mira)))
    return consulta


def _credencial_vigente(hoy: date):
    """Una credencial VERIFICADA por Z, activa y sin vencer: la misma regla
    que `requisitos.estado_visible_de_credencial`, escrita en SQL, y con el
    MISMO «hoy» que la admisión (UTC, `service.hoy()`)."""
    return and_(
        ServiceProviderCredential.status == CREDENCIAL_VERIFICADA,
        ServiceProviderCredential.lifecycle == ACTIVO,
        or_(ServiceProviderCredential.expires_on.is_(None), ServiceProviderCredential.expires_on >= hoy),
    )


def _coincide(columna, patrones: list[str]):
    return or_(*(func.lower(columna).like(p) for p in patrones))


def _patrones(termino: str) -> list[str]:
    salida: list[str] = []
    for forma in sorted(normalizacion.raices(termino)):
        for patron in normalizacion.patrones(forma):
            if patron not in salida:
                salida.append(patron)
    return salida


# --------------------------------------------------------------------------- #
# Las tarjetas: un número FIJO de consultas por página
# --------------------------------------------------------------------------- #
@dataclass
class Tarjeta:
    servicio: Service
    version: ServiceVersion
    prestador: ServiceProvider
    categoria: ServiceCategory
    portada_url: str | None = None
    portada_alt: str | None = None
    credencial_verificada: bool = False
    guardado: bool = False
    motivo: str | None = None
    campos: list[str] = field(default_factory=list)


async def _guardados_de(db: AsyncSession, mira: str | None, servicios: list[str]) -> set[str]:
    if not mira or not servicios or not await esquema.hay_guardados(db):
        return set()
    return set(
        await db.scalars(
            select(SavedService.service_id).where(
                SavedService.profile_id == mira, SavedService.service_id.in_(servicios)
            )
        )
    )


async def _con_credencial(db: AsyncSession, prestadores: list[str]) -> set[str]:
    if not prestadores:
        return set()
    return set(
        await db.scalars(
            select(ServiceProviderCredential.provider_id)
            .where(
                ServiceProviderCredential.provider_id.in_(prestadores),
                _credencial_vigente(_hoy()),
            )
            .distinct()
        )
    )


async def tarjetas(
    db: AsyncSession,
    filas: list,
    *,
    mira: str | None,
    motivo: str | None = None,
    campos: dict[str, list[str]] | None = None,
) -> list[Tarjeta]:
    """Las tarjetas de `(servicio, versión, prestador, categoría)`. Portadas,
    credenciales y guardados, cada uno EN UNA CONSULTA para toda la página, y
    todas las portadas firmadas en una sola llamada."""
    if not filas:
        return []
    versiones = [v.id for _, v, _, _ in filas]
    portadas: dict[str, tuple[str, str]] = {}
    for version_id, ruta, alt in (
        await db.execute(
            select(ServiceVersionImage.version_id, ServiceVersionImage.storage_path, ServiceVersionImage.alt_text)
            .where(ServiceVersionImage.version_id.in_(versiones), ServiceVersionImage.is_cover.is_(True))
        )
    ).all():
        portadas[version_id] = (ruta, alt)
    firmadas = await imagenes.firmar(sorted({r for r, _ in portadas.values()}))
    con_credencial = await _con_credencial(db, sorted({p.id for _, _, p, _ in filas}))
    guardados = await _guardados_de(db, mira, [s.id for s, _, _, _ in filas])
    salida = []
    for servicio, version, prestador, categoria in filas:
        ruta, alt = portadas.get(version.id, (None, None))
        salida.append(
            Tarjeta(
                servicio=servicio, version=version, prestador=prestador, categoria=categoria,
                portada_url=firmadas.get(ruta) if ruta else None, portada_alt=alt,
                credencial_verificada=prestador.id in con_credencial,
                guardado=servicio.id in guardados, motivo=motivo,
                campos=(campos or {}).get(servicio.id, []),
            )
        )
    return salida


# --------------------------------------------------------------------------- #
# El catálogo: buscar, filtrar, ordenar y paginar
# --------------------------------------------------------------------------- #
@dataclass
class Pagina:
    items: list[Tarjeta]
    siguiente: str | None
    orden: str


_CAMPOS_BUSCADOS = ("title", "category", "summary", "description", "provider", "area", "modality")


async def catalogo(
    db: AsyncSession, f: Filtros, *, mira: str | None, cursor: str | None, limite: int = POR_PAGINA
) -> Pagina:
    tope = max(1, min(int(limite), LIMITE_MAXIMO))
    consulta = base(mira)
    madre = aliased(ServiceCategory)
    coincidencias: dict[str, list] = {c: [] for c in _CAMPOS_BUSCADOS}
    puntos = literal(0)

    if f.terminos:
        consulta = consulta.outerjoin(madre, madre.id == ServiceCategory.parent_id)
        for termino in f.terminos:
            p = _patrones(termino)
            por_campo = {
                "title": _coincide(ServiceVersion.title, p),
                "category": or_(
                    _coincide(ServiceCategory.name, p), _coincide(ServiceCategory.name_en, p),
                    _coincide(ServiceCategory.name_pt, p), _coincide(madre.name, p),
                    _coincide(madre.name_en, p), _coincide(madre.name_pt, p),
                ),
                "summary": _coincide(ServiceVersion.summary, p),
                "description": _coincide(ServiceVersion.description, p),
                "provider": _coincide(ServiceProvider.display_name, p),
                "area": and_(ServiceVersion.modality != VIRTUAL, _coincide(ServiceVersion.location_area, p)),
            }
            modalidad = MODALIDAD_POR_PALABRA.get(termino)
            if modalidad is not None:
                por_campo["modality"] = ServiceVersion.modality == modalidad
            # CADA PALABRA TIENE QUE APARECER EN ALGÚN SITIO. Una frase de dos
            # palabras no puede traer lo que solo coincide con una de ellas.
            consulta = consulta.where(or_(*por_campo.values()))
            pesos = {
                "title": PESO_TITULO, "category": PESO_CATEGORIA, "summary": PESO_RESUMEN,
                "description": PESO_DESCRIPCION, "provider": PESO_PRESTADOR, "area": PESO_ZONA,
                "modality": PESO_MODALIDAD,
            }
            for campo, condicion in por_campo.items():
                coincidencias[campo].append(condicion)
                puntos = puntos + case((condicion, pesos[campo]), else_=0)

    if f.categoria:
        consulta = consulta.where(
            or_(Service.category_id == f.categoria, ServiceCategory.parent_id == f.categoria)
        )
    if f.modalidad:
        consulta = consulta.where(ServiceVersion.modality == f.modalidad)
    if f.precio == PRECIO_GRATIS:
        consulta = consulta.where(ServiceVersion.price_model == GRATIS)
    elif f.precio == PRECIO_A_CONSULTAR:
        consulta = consulta.where(ServiceVersion.price_model == A_CONSULTAR)
    elif f.precio == PRECIO_CON_IMPORTE:
        consulta = consulta.where(
            ServiceVersion.price_model.in_(CON_IMPORTE), ServiceVersion.price_minor.is_not(None)
        )
    if f.moneda:
        consulta = consulta.where(ServiceVersion.currency == f.moneda)
    if f.minimo is not None:
        consulta = consulta.where(ServiceVersion.price_minor >= f.minimo)
    if f.maximo is not None:
        consulta = consulta.where(ServiceVersion.price_minor <= f.maximo)
    for termino in f.zona:
        consulta = consulta.where(
            ServiceVersion.modality != VIRTUAL, _coincide(ServiceVersion.location_area, _patrones(termino))
        )
    if f.con_credencial:
        consulta = consulta.where(
            exists().where(
                ServiceProviderCredential.provider_id == ServiceProvider.id,
                _credencial_vigente(_hoy()),
            )
        )

    columnas_de_campo = [
        or_(*coincidencias[c]).label(f"m_{c}") if coincidencias[c] else literal(False).label(f"m_{c}")
        for c in _CAMPOS_BUSCADOS
    ]
    puntos = puntos.label("puntos")
    consulta = consulta.add_columns(puntos, *columnas_de_campo)

    publicado = Service.first_published_at
    claves = leer_cursor(cursor, f.orden) if cursor else None
    if f.orden == ORDEN_RELEVANCIA:
        orden = (puntos.desc(), publicado.desc(), Service.id.desc())
        if claves:
            s, t, i = claves
            expresion = puntos.element if hasattr(puntos, "element") else puntos
            consulta = consulta.where(
                or_(
                    expresion < s,
                    and_(expresion == s, publicado < t),
                    and_(expresion == s, publicado == t, Service.id < i),
                )
            )
    elif f.orden == ORDEN_RECIENTE:
        orden = (publicado.desc(), Service.id.desc())
        if claves:
            t, i = claves
            consulta = consulta.where(or_(publicado < t, and_(publicado == t, Service.id < i)))
    else:
        precio = ServiceVersion.price_minor
        if f.orden == ORDEN_PRECIO_ASC:
            orden = (precio.asc(), Service.id.asc())
            if claves:
                x, i = claves
                consulta = consulta.where(or_(precio > x, and_(precio == x, Service.id > i)))
        else:
            orden = (precio.desc(), Service.id.desc())
            if claves:
                x, i = claves
                consulta = consulta.where(or_(precio < x, and_(precio == x, Service.id < i)))

    filas = (await db.execute(consulta.order_by(*orden).limit(tope + 1))).all()
    hay_mas = len(filas) > tope
    filas = filas[:tope]

    campos: dict[str, list[str]] = {}
    for fila in filas:
        servicio = fila[0]
        campos[servicio.id] = [c for c, valor in zip(_CAMPOS_BUSCADOS, fila[5:]) if valor]
    cuatro = [tuple(fila[:4]) for fila in filas]
    items = await tarjetas(
        db, cuatro, mira=mira,
        motivo=MOTIVO_BUSQUEDA if f.terminos else None,
        campos=campos if f.terminos else None,
    )

    siguiente = None
    if hay_mas and filas:
        ultima = filas[-1]
        servicio, version = ultima[0], ultima[1]
        if f.orden == ORDEN_RELEVANCIA:
            siguiente = cursor_de(f.orden, [int(ultima[4]), _iso(servicio.first_published_at), servicio.id])
        elif f.orden == ORDEN_RECIENTE:
            siguiente = cursor_de(f.orden, [_iso(servicio.first_published_at), servicio.id])
        else:
            siguiente = cursor_de(f.orden, [int(version.price_minor), servicio.id])
    return Pagina(items=items, siguiente=siguiente, orden=f.orden)


# --------------------------------------------------------------------------- #
# Las categorías que tienen algo público
# --------------------------------------------------------------------------- #
async def categorias_publicas(db: AsyncSession, *, mira: str | None) -> list[ServiceCategory]:
    """Las categorías con al menos un servicio público, y sus madres. Una
    categoría sin nada que ver no se ofrece como filtro: llevaría a un vacío."""
    usadas = set(await db.scalars(base(mira).with_only_columns(Service.category_id).distinct()))
    if not usadas:
        return []
    hijas = list(await db.scalars(select(ServiceCategory).where(ServiceCategory.id.in_(usadas))))
    madres = {c.parent_id for c in hijas if c.parent_id}
    todas = {c.id: c for c in hijas}
    if madres - set(todas):
        for c in await db.scalars(select(ServiceCategory).where(ServiceCategory.id.in_(madres - set(todas)))):
            todas[c.id] = c
    activas = [c for c in todas.values() if c.status == CATEGORIA_ACTIVA]
    return sorted(activas, key=lambda c: (c.parent_id is not None, c.sort_order, c.name.lower(), c.id))


# --------------------------------------------------------------------------- #
# Las señales de confianza: SOLO lo que Z comprobó
# --------------------------------------------------------------------------- #
@dataclass
class Confianza:
    #: Admitido por Z: prestador activo tras la admisión. Con su fecha real.
    admitido_desde: datetime | None
    #: Z revisó y aceptó su documento de identidad en la admisión.
    identidad_revisada: bool
    #: Tiene al menos una credencial VERIFICADA por Z, activa y vigente. Sin
    #: su nombre ni su número: qué credenciales se publican es una decisión
    #: pendiente de la empresa.
    credencial_verificada: bool


async def confianza(db: AsyncSession, prestador: ServiceProvider) -> Confianza:
    identidad = await db.scalar(
        select(
            exists().where(
                ServiceProviderDocument.provider_id == prestador.id,
                ServiceProviderDocument.kind == "identity",
                ServiceProviderDocument.review_status == DOCUMENTO_ACEPTADO,
                ServiceProviderDocument.lifecycle == ACTIVO,
            )
        )
    )
    credencial = await db.scalar(
        select(
            exists().where(
                ServiceProviderCredential.provider_id == prestador.id, _credencial_vigente(_hoy())
            )
        )
    )
    return Confianza(
        admitido_desde=prestador.activated_at if prestador.status == PRESTADOR_ACTIVO else None,
        identidad_revisada=bool(identidad),
        credencial_verificada=bool(credencial),
    )


# --------------------------------------------------------------------------- #
# La ficha
# --------------------------------------------------------------------------- #
class ServicioNoPublico(Exception):
    """Se traduce al mismo 404 de siempre (`service_not_found`)."""


@dataclass
class Ficha:
    servicio: Service
    version: ServiceVersion
    prestador: ServiceProvider
    categoria: ServiceCategory
    confianza: Confianza
    guardado: bool
    del_prestador: list[Tarjeta]
    relacionados: list[Tarjeta]


async def publico(db: AsyncSession, servicio_id: str, *, mira: str | None = None) -> tuple:
    if not _uuid_valido(servicio_id):
        raise ServicioNoPublico()
    fila = (await db.execute(base(mira).where(Service.id == servicio_id))).first()
    if fila is None:
        raise ServicioNoPublico()
    return fila[0], fila[1], fila[2], fila[3]


async def ficha(db: AsyncSession, servicio_id: str, *, mira: str | None) -> Ficha:
    servicio, version, prestador, categoria = await publico(db, servicio_id, mira=mira)
    guardados = await _guardados_de(db, mira, [servicio.id])
    ajenos = [] if mira is None else [ServiceProvider.profile_id != mira]
    del_prestador = (
        await db.execute(
            base(mira)
            .where(ServiceProvider.id == prestador.id, Service.id != servicio.id)
            .order_by(Service.first_published_at.desc(), Service.id.desc())
            .limit(RELACIONADOS)
        )
    ).all()
    # RELACIONADOS: de la misma categoría, de OTROS prestadores, y nunca lo
    # propio de quien mira (un prestador no necesita que le sugieran lo suyo).
    relacionados = (
        await db.execute(
            base(mira)
            .where(
                Service.category_id == categoria.id,
                ServiceProvider.id != prestador.id,
                Service.id != servicio.id,
                *ajenos,
            )
            .order_by(Service.first_published_at.desc(), Service.id.desc())
            .limit(RELACIONADOS)
        )
    ).all()
    return Ficha(
        servicio=servicio, version=version, prestador=prestador, categoria=categoria,
        confianza=await confianza(db, prestador),
        guardado=servicio.id in guardados,
        del_prestador=await tarjetas(db, [tuple(f) for f in del_prestador], mira=mira, motivo=MOTIVO_MISMO_PRESTADOR),
        relacionados=await tarjetas(db, [tuple(f) for f in relacionados], mira=mira, motivo=MOTIVO_MISMA_CATEGORIA),
    )


# --------------------------------------------------------------------------- #
# El perfil público del prestador
# --------------------------------------------------------------------------- #
class PrestadorNoPublico(Exception):
    """404 `service_provider_not_found`."""


@dataclass
class Perfil:
    prestador: ServiceProvider
    confianza: Confianza
    categorias: list[ServiceCategory]
    modalidades: list[str]
    zonas: list[str]


async def _prestador_publico(db: AsyncSession, prestador_id: str, mira: str | None) -> ServiceProvider:
    """Un prestador es público solo si tiene ALGO público. Así no se puede
    recorrer la lista de admitidos probando identificadores."""
    if not _uuid_valido(prestador_id):
        raise PrestadorNoPublico()
    fila = (await db.execute(base(mira).where(ServiceProvider.id == prestador_id).limit(1))).first()
    if fila is None:
        raise PrestadorNoPublico()
    return fila[2]


async def perfil(db: AsyncSession, prestador_id: str, *, mira: str | None) -> Perfil:
    prestador = await _prestador_publico(db, prestador_id, mira)
    filas = (
        await db.execute(
            base(mira)
            .where(ServiceProvider.id == prestador.id)
            .with_only_columns(ServiceCategory, ServiceVersion.modality, ServiceVersion.location_area)
        )
    ).all()
    categorias: dict[str, ServiceCategory] = {}
    modalidades: set[str] = set()
    zonas: dict[str, str] = {}
    for categoria, modalidad, zona in filas:
        categorias[categoria.id] = categoria
        if modalidad:
            modalidades.add(modalidad)
        if zona and modalidad != VIRTUAL:
            zonas.setdefault(" ".join(zona.split()).lower(), " ".join(zona.split()))
    return Perfil(
        prestador=prestador,
        confianza=await confianza(db, prestador),
        categorias=sorted(categorias.values(), key=lambda c: (c.sort_order, c.name.lower(), c.id)),
        modalidades=[m for m in MODALIDADES if m in modalidades],
        zonas=sorted(zonas.values(), key=str.lower),
    )


async def servicios_del_prestador(
    db: AsyncSession, prestador_id: str, *, mira: str | None, cursor: str | None, limite: int = POR_PAGINA
) -> Pagina:
    prestador = await _prestador_publico(db, prestador_id, mira)
    tope = max(1, min(int(limite), LIMITE_MAXIMO))
    consulta = base(mira).where(ServiceProvider.id == prestador.id)
    publicado = Service.first_published_at
    if cursor:
        t, i = leer_cursor(cursor, ORDEN_RECIENTE)
        consulta = consulta.where(or_(publicado < t, and_(publicado == t, Service.id < i)))
    filas = (await db.execute(consulta.order_by(publicado.desc(), Service.id.desc()).limit(tope + 1))).all()
    hay_mas = len(filas) > tope
    filas = [tuple(f) for f in filas[:tope]]
    siguiente = None
    if hay_mas and filas:
        ultimo = filas[-1][0]
        siguiente = cursor_de(ORDEN_RECIENTE, [_iso(ultimo.first_published_at), ultimo.id])
    return Pagina(items=await tarjetas(db, filas, mira=mira), siguiente=siguiente, orden=ORDEN_RECIENTE)


# --------------------------------------------------------------------------- #
# Guardados
# --------------------------------------------------------------------------- #
async def guardar(db: AsyncSession, *, mira: str, servicio_id: str) -> None:
    """IDEMPOTENTE Y SIN CARRERAS: `on conflict do nothing` en la clave
    (perfil, servicio). Solo se guarda lo público; guardar no avisa a nadie."""
    await publico(db, servicio_id, mira=mira)
    if (await db.connection()).dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    await db.execute(
        insert(SavedService)
        .values(profile_id=mira, service_id=servicio_id)
        .on_conflict_do_nothing(index_elements=["profile_id", "service_id"])
    )


async def quitar(db: AsyncSession, *, mira: str, servicio_id: str) -> None:
    """IDEMPOTENTE: quitar lo que no está tampoco es un error. Vale aunque el
    servicio ya no sea público, para poder limpiar la lista."""
    if not _uuid_valido(servicio_id):
        raise ServicioNoPublico()
    await db.execute(
        delete(SavedService).where(SavedService.profile_id == mira, SavedService.service_id == servicio_id)
    )


@dataclass
class Guardado:
    servicio_id: str
    guardado_en: datetime
    #: `None` si el servicio ya no está disponible: entonces no hay tarjeta.
    tarjeta: Tarjeta | None
    titulo: str | None


async def guardados(
    db: AsyncSession, *, mira: str, cursor: str | None, limite: int = POR_PAGINA
) -> tuple[list[Guardado], str | None]:
    """Lo que guardó esta persona, lo más reciente primero. LO QUE YA NO ES
    PÚBLICO SE QUEDA, pero sin contenido: solo su título y «ya no está
    disponible», para que se pueda quitar. Nunca parece contratable."""
    tope = max(1, min(int(limite), LIMITE_MAXIMO))
    consulta = (
        select(SavedService.service_id, SavedService.created_at, ServiceVersion.title)
        .outerjoin(
            ServiceVersion,
            and_(ServiceVersion.service_id == SavedService.service_id, ServiceVersion.status == estados.PUBLICADA),
        )
        .where(SavedService.profile_id == mira)
    )
    if cursor:
        t, i = leer_cursor(cursor, ORDEN_RECIENTE)
        consulta = consulta.where(
            or_(SavedService.created_at < t, and_(SavedService.created_at == t, SavedService.service_id < i))
        )
    filas = (
        await db.execute(
            consulta.order_by(SavedService.created_at.desc(), SavedService.service_id.desc()).limit(tope + 1)
        )
    ).all()
    hay_mas = len(filas) > tope
    filas = filas[:tope]
    ids = [f[0] for f in filas]
    visibles = (await db.execute(base(mira).where(Service.id.in_(ids)))).all() if ids else []
    por_id = {t.servicio.id: t for t in await tarjetas(db, [tuple(f) for f in visibles], mira=mira)}
    salida = [
        Guardado(
            servicio_id=sid, guardado_en=momento, tarjeta=por_id.get(sid),
            titulo=por_id[sid].version.title if sid in por_id else titulo,
        )
        for sid, momento, titulo in filas
    ]
    siguiente = cursor_de(ORDEN_RECIENTE, [_iso(filas[-1][1]), filas[-1][0]]) if hay_mas and filas else None
    return salida, siguiente


# --------------------------------------------------------------------------- #
# Sugerencias: señales que existen y se pueden explicar
# --------------------------------------------------------------------------- #
@dataclass
class Seccion:
    motivo: str
    items: list[Tarjeta]


async def sugerencias(db: AsyncSession, *, mira: str | None, ahora: datetime | None = None) -> list[Seccion]:
    """DOS señales, y ninguna más:

      * `similar_to_saved`: de las categorías (o sus madres) de lo que guardó;
      * `recently_published`: publicado por primera vez en los últimos
        `DIAS_DE_RECIENTE` días.

    Nunca lo propio de quien mira ni lo ya guardado; un servicio sale en una
    sola sección. SIN SEÑAL, NO HAY SECCIÓN: no se rellena con lo que haya.
    """
    ahora = ahora or datetime.now(timezone.utc)
    secciones: list[Seccion] = []
    vistos: set[str] = set()
    ajenos = [] if mira is None else [ServiceProvider.profile_id != mira]

    guardados_ids: list[str] = []
    if mira and await esquema.hay_guardados(db):
        guardados_ids = list(await db.scalars(select(SavedService.service_id).where(SavedService.profile_id == mira)))
    if guardados_ids:
        # ALIAS PROPIOS: con `Service` o `ServiceCategory` a secas, la
        # subconsulta se correlacionaría con la de fuera y dejaría de ser
        # «las categorías de lo guardado».
        guardado, suya = aliased(Service), aliased(ServiceCategory)
        cats = select(guardado.category_id).where(guardado.id.in_(guardados_ids))
        madres = select(suya.parent_id).where(suya.id.in_(cats), suya.parent_id.is_not(None))
        familia = or_(
            Service.category_id.in_(cats),
            ServiceCategory.parent_id.in_(cats),
            Service.category_id.in_(madres),
            ServiceCategory.parent_id.in_(madres),
        )
        filas = (
            await db.execute(
                base(mira)
                .where(familia, Service.id.not_in(guardados_ids), *ajenos)
                .order_by(Service.first_published_at.desc(), Service.id.desc())
                .limit(POR_SECCION)
            )
        ).all()
        if filas:
            secciones.append(
                Seccion(MOTIVO_GUARDADOS, await tarjetas(db, [tuple(f) for f in filas], mira=mira, motivo=MOTIVO_GUARDADOS))
            )
            vistos.update(f[0].id for f in filas)

    desde = ahora - timedelta(days=DIAS_DE_RECIENTE)
    excluidos = list(vistos | set(guardados_ids))
    consulta = base(mira).where(Service.first_published_at >= desde, *ajenos)
    if excluidos:
        consulta = consulta.where(Service.id.not_in(excluidos))
    filas = (
        await db.execute(
            consulta.order_by(Service.first_published_at.desc(), Service.id.desc()).limit(POR_SECCION)
        )
    ).all()
    if filas:
        secciones.append(
            Seccion(MOTIVO_RECIENTE, await tarjetas(db, [tuple(f) for f in filas], mira=mira, motivo=MOTIVO_RECIENTE))
        )
    return secciones


__all__ = [
    "LIMITE_MAXIMO",
    "MOTIVOS",
    "ORDENES",
    "POR_PAGINA",
    "TIPOS_DE_PRECIO",
    "ConsultaMuyCorta",
    "Filtros",
    "FiltroInvalido",
    "MonedaRequerida",
    "PrestadorNoPublico",
    "ServicioNoPublico",
    "base",
    "catalogo",
    "categorias_publicas",
    "condiciones_publicas",
    "confianza",
    "cursor_de",
    "ficha",
    "filtros",
    "guardados",
    "guardar",
    "leer_cursor",
    "perfil",
    "publico",
    "quitar",
    "servicios_del_prestador",
    "sugerencias",
    "tarjetas",
]
