"""Los contratos de Productos: qué entra y qué sale.

DOS PRINCIPIOS QUE SE VEN EN CADA MOLDE:

  1. LO QUE NO EXISTE VIAJA NULO, no en cero y no con un valor razonable. Un
     precio nulo es «sin precio configurado» y una valoración nula es «todavía
     nadie ha valorado»; ceros en su lugar se leen como decisiones tomadas.
  2. LO INTERNO NO SALE. La nota del evaluador y las notas internas de una
     postulación no están en ningún molde de lectura pública.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.modules.products.catalog import MANIFIESTO, SELLO
from app.modules.products.models import DIMENSIONES, RAZONES_EXIGIDAS

# --------------------------------------------------------------------------- #
# Catálogo
# --------------------------------------------------------------------------- #
class TarjetaRead(BaseModel):
    """Lo que se enseña en una lista (blueprint §3.1)."""

    product_id: str
    name: str
    seller_id: str
    seller_name: str
    #: `null` es SIN PRECIO CONFIGURADO. Nunca cero.
    price_minor: int | None = None
    currency: str | None = None
    #: La ruta en el almacenamiento. Se guarda la RUTA y nunca una URL: una
    #: firmada caduca, y guardarla haría que la imagen dejara de cargar sin que
    #: nadie tocara nada.
    image_path: str | None = None
    #: LA URL FIRMADA, emitida al servir esta respuesta y con vencimiento.
    #: `null` cuando no hay fotografía APROBADA o el almacenamiento no contesta:
    #: la pantalla enseña entonces el texto alternativo, que es la verdad.
    image_url: str | None = None
    image_alt: str | None = None
    #: UNO SOLO (§3.1). Hoy solo puede ser `origin`.
    trust: str | None = None
    trust_value: str | None = None
    saved: bool = False


class CreadorRead(BaseModel):
    seller_id: str
    profile_id: str
    name: str
    #: Su propuesta: el resumen de su producto más reciente. Puede no haberlo.
    proposal: str | None = None
    product_id: str


class PortadaRead(BaseModel):
    """La portada de Productos Z (§3)."""

    manifest: str = MANIFIESTO
    seleccion: list[TarjetaRead] = Field(default_factory=list)
    para_ti: list[TarjetaRead] = Field(default_factory=list)
    #: `false` SIEMPRE hoy: no hay recomendador de productos, y llamar «para ti»
    #: a lo más reciente sería mentir con el título.
    personalized: bool = False
    creadores: list[CreadorRead] = Field(default_factory=list)
    #: `false` significa que las migraciones de Productos no están aplicadas en
    #: esta base. No es «no hay productos».
    disponible: bool = True


class BusquedaRead(BaseModel):
    items: list[TarjetaRead] = Field(default_factory=list)
    #: El identificador del último producto de esta página, o `null` si se
    #: acabó. NO es un número de página: paginar por desplazamiento repite y se
    #: salta filas cuando alguien publica a mitad.
    next_cursor: str | None = None


class CategoriaRead(BaseModel):
    id: str
    slug: str
    name: str
    position: int


class CategoriasRead(BaseModel):
    #: VACÍO significa que la empresa no ha definido las categorías. No es un
    #: fallo, y la pantalla lo dice así.
    items: list[CategoriaRead] = Field(default_factory=list)


class MediaRead(BaseModel):
    """Una fotografía de la galería pública. SOLO SALEN LAS APROBADAS."""

    id: str
    kind: str
    storage_path: str
    alt_text: str | None = None
    #: Firmada ahora y con vencimiento. `null` si no se pudo firmar.
    url: str | None = None
    width: int | None = None
    height: int | None = None


class FotoDelProveedor(BaseModel):
    """La misma fotografía vista por quien la subió: CON su estado.

    Aquí sí viaja `status` y el motivo del rechazo, porque es lo único que le
    permite corregirla. En el catálogo no aparece ninguna de las dos cosas.
    """

    id: str
    kind: str
    storage_path: str
    alt_text: str | None = None
    position: int = 0
    status: str
    content_type: str | None = None
    byte_size: int | None = None
    width: int | None = None
    height: int | None = None
    url: str | None = None
    reviewed_at: datetime | None = None
    rejection_reason: str | None = None
    created_at: datetime | None = None


class OrdenDeLasFotos(BaseModel):
    """TODAS las fotografías, en el orden que se quiere. Una lista parcial
    dejaría las que faltan en una posición que nadie eligió."""

    media_ids: list[str] = Field(min_length=1, max_length=20)


class DecisionDeLaFoto(BaseModel):
    approved: bool
    #: OBLIGATORIO al rechazar: sin motivo no se puede corregir.
    reason: str | None = Field(default=None, max_length=500)


class FotoPendiente(BaseModel):
    """Una fila de la bandeja de quien revisa fotografías."""

    id: str
    product_id: str
    version_id: str
    product_name: str
    alt_text: str | None = None
    storage_path: str
    url: str | None = None
    width: int | None = None
    height: int | None = None
    byte_size: int | None = None
    content_type: str | None = None
    created_at: datetime | None = None


class VarianteRead(BaseModel):
    id: str
    sku: str
    name: str
    options: dict[str, Any] = Field(default_factory=dict)
    price_delta_minor: int = 0


class RazonRead(BaseModel):
    """Una de las tres razones, CON de qué evidencia sale (§4.1)."""

    position: int
    text: str
    evidence_kind: str
    evidence_dimension: str


class FichaRead(BaseModel):
    """El detalle, en el orden inalterable del blueprint §4."""

    product_id: str
    version_id: str
    version: str
    name: str
    summary: str | None = None
    description: str | None = None
    materials: str | None = None
    origin_country: str | None = None
    manufacturer: str | None = None
    price_minor: int | None = None
    currency: str | None = None
    #: La huella de lo publicado. Es lo que hace demostrable qué se evaluó.
    content_sha256: str
    published_at: datetime | None = None
    status: str

    seller_id: str
    seller_name: str
    seller_profile_id: str

    gallery: list[MediaRead] = Field(default_factory=list)
    variants: list[VarianteRead] = Field(default_factory=list)
    reasons: list[RazonRead] = Field(default_factory=list)
    seal: str = SELLO
    #: El informe que abre el sello. `null` si la admisión no está desplegada.
    evaluation_id: str | None = None
    #: `null` PORQUE NO HAY RESEÑAS DE PRODUCTOS todavía. No es cero, y la
    #: pantalla no puede inventarse «4,8».
    rating: dict[str, Any] | None = None
    #: `null` porque no hay transportista, ni cobertura, ni condiciones
    #: aprobadas de entrega y devolución.
    delivery: dict[str, Any] | None = None
    related: list[TarjetaRead] = Field(default_factory=list)
    saved: bool = False
    #: HOY SIEMPRE `false`. No existe la compra física, y un botón que prometa
    #: comprar sin ella es una promesa que no se puede cumplir.
    purchasable: bool = False


class InformeRead(BaseModel):
    """El informe de evaluación que abre el sello. Sin notas internas."""

    evaluation_id: str
    version_id: str
    seal: str = SELLO
    decision: str
    #: EN CENTÉSIMAS DE PUNTO: 9 000 son 90,00.
    score_total: int | None = None
    decided_at: datetime | None = None
    dimensions: dict[str, Any] = Field(default_factory=dict)


class GuardadoRead(BaseModel):
    saved: bool
    #: Cuántos tiene guardados ahora. La bolsa enseña contador solo si hay algo.
    count: int


# --------------------------------------------------------------------------- #
# Proveedor: la postulación
# --------------------------------------------------------------------------- #
class DocumentoRequest(BaseModel):
    kind: str
    #: La RUTA del almacenamiento, no una URL.
    storage_path: str | None = Field(default=None, max_length=512)
    note: str | None = Field(default=None, max_length=2_000)


class PostulacionRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)
    proposal: str = Field(min_length=20, max_length=4_000)
    documents: list[DocumentoRequest] = Field(default_factory=list)


class DocumentoRead(BaseModel):
    id: str
    kind: str
    storage_path: str | None = None
    note: str | None = None


class PostulacionRead(BaseModel):
    id: str
    status: str
    display_name: str
    proposal: str
    submitted_at: datetime | None = None
    decided_at: datetime | None = None
    #: El motivo que se le ENSEÑA. Las notas internas no salen de aquí.
    decision_reason: str | None = None
    documents: list[DocumentoRead] = Field(default_factory=list)


class EstadoDelProveedor(BaseModel):
    """Lo que la pantalla necesita para no adivinar nada.

    `puede_postular` distingue «ya eres responsable comercial» de «tu
    postulación está en revisión», que no es lo mismo que «no puedes».
    """

    #: `null` = no tiene capacidad comercial. `pending`/`active`/`suspended`.
    seller_status: str | None = None
    seller_id: str | None = None
    application: PostulacionRead | None = None
    puede_postular: bool = False
    disponible: bool = True


# --------------------------------------------------------------------------- #
# Proveedor: el producto
# --------------------------------------------------------------------------- #
class VarianteRequest(BaseModel):
    sku: str = Field(min_length=2, max_length=48)
    name: str = Field(min_length=1, max_length=80)
    options: dict[str, Any] = Field(default_factory=dict)
    price_delta_minor: int = 0


class VersionRequest(BaseModel):
    """Lo que se escribe de una versión. Todo opcional menos el nombre.

    El PRECIO va con su MONEDA o no va: un importe sin moneda no es un importe.
    """

    version: str | None = Field(default=None, max_length=32)
    name: str = Field(min_length=3, max_length=140)
    summary: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=8_000)
    materials: str | None = Field(default=None, max_length=2_000)
    origin_country: str | None = Field(default=None, max_length=2)
    manufacturer: str | None = Field(default=None, max_length=160)
    price_minor: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    variants: list[VarianteRequest] = Field(default_factory=list)


class ProductoNuevoRequest(VersionRequest):
    category_id: str | None = None


class VersionRead(BaseModel):
    id: str
    version: str
    status: str
    name: str
    summary: str | None = None
    description: str | None = None
    materials: str | None = None
    origin_country: str | None = None
    manufacturer: str | None = None
    price_minor: int | None = None
    currency: str | None = None
    content_sha256: str
    published_at: datetime | None = None
    effective_to: datetime | None = None
    variants: list[VarianteRead] = Field(default_factory=list)
    #: CON ESTADO: quien vende necesita saber cuáles están pendientes y por qué
    #: se rechazó una. El catálogo usa `MediaRead`, que no lleva ninguna de las
    #: dos cosas.
    gallery: list[FotoDelProveedor] = Field(default_factory=list)


class ProductoDelProveedor(BaseModel):
    """El producto como lo ve quien lo vende, con lo que puede hacer ahora."""

    id: str
    status: str
    category_id: str | None = None
    published_at: datetime | None = None
    suspension_reason: str | None = None
    created_at: datetime
    draft: VersionRead | None = None
    published: VersionRead | None = None
    #: Lo que ESTE actor puede hacer. Para pintar botones, no para decidir: el
    #: servidor vuelve a comprobarlo en cada ruta.
    acciones: list[str] = Field(default_factory=list)
    #: Por qué todavía no se puede publicar, como CÓDIGO. `null` = se puede.
    bloqueo: str | None = None


class MotivoRequest(BaseModel):
    motivo: str | None = Field(default=None, max_length=2_000)


# --------------------------------------------------------------------------- #
# Administración
# --------------------------------------------------------------------------- #
class DecisionDePostulacion(BaseModel):
    aceptar: bool
    #: Obligatorio para rechazar: un «no» sin motivo no se le puede enseñar a
    #: nadie, y la base también lo exige.
    motivo: str | None = Field(default=None, max_length=2_000)
    notas: str | None = Field(default=None, max_length=4_000)


class PuntuacionRequest(BaseModel):
    #: De 0 a 100. La ponderación la hace el servidor con el peso de la matriz.
    score: int = Field(ge=0, le=100)
    note: str | None = Field(default=None, max_length=2_000)


class EvidenciaRequest(BaseModel):
    dimension: str
    kind: str
    summary: str = Field(min_length=10, max_length=1_000)
    storage_path: str | None = Field(default=None, max_length=512)


class RazonRequest(BaseModel):
    #: La evidencia de ESTA evaluación de la que sale la razón.
    evidence_id: str
    text: str = Field(min_length=10, max_length=240)


class RazonesRequest(BaseModel):
    #: Como mucho tres (§4.1). Que estén las tres al publicar lo comprueba el
    #: servidor.
    razones: list[RazonRequest] = Field(default_factory=list, max_length=RAZONES_EXIGIDAS)


class DecisionDeEvaluacion(BaseModel):
    """Lo único que se decide a mano es si hay una falla crítica.

    Qué significa la puntuación lo dice la matriz del blueprint, no quien pulsa.
    """

    critical_failure: str | None = None
    notes: str | None = Field(default=None, max_length=4_000)


class PuntuacionRead(BaseModel):
    dimension: str
    score: int
    #: CONGELADO al puntuar. La matriz puede cambiar; lo decidido no.
    weight: int
    note: str | None = None


class EvidenciaRead(BaseModel):
    id: str
    dimension: str
    kind: str
    summary: str
    storage_path: str | None = None


class EvaluacionRead(BaseModel):
    id: str
    product_id: str
    version_id: str
    evaluator_id: str
    status: str
    score_total: int | None = None
    decision: str | None = None
    critical_failure: str | None = None
    decided_at: datetime | None = None
    scores: list[PuntuacionRead] = Field(default_factory=list)
    evidence: list[EvidenciaRead] = Field(default_factory=list)
    reasons: list[RazonRead] = Field(default_factory=list)
    #: Los pesos de la matriz, para que la pantalla no los copie.
    matriz: dict[str, int] = Field(default_factory=lambda: dict(DIMENSIONES))
    #: Por qué todavía no se puede decidir, como CÓDIGO. `null` = se puede.
    bloqueo: str | None = None
    #: Qué falta exactamente: dimensiones sin puntuar o sin evidencia.
    faltan: list[str] = Field(default_factory=list)


class TransicionRequest(BaseModel):
    hasta: str
    motivo: str | None = Field(default=None, max_length=2_000)


class ProductoDeAdministracion(ProductoDelProveedor):
    seller_id: str
    seller_name: str
    seller_profile_id: str


__all__ = [
    "BusquedaRead",
    "CategoriaRead",
    "CategoriasRead",
    "CreadorRead",
    "DecisionDeEvaluacion",
    "DecisionDePostulacion",
    "DocumentoRead",
    "DocumentoRequest",
    "EstadoDelProveedor",
    "EvaluacionRead",
    "EvidenciaRead",
    "EvidenciaRequest",
    "FichaRead",
    "GuardadoRead",
    "InformeRead",
    "MediaRead",
    "MediaRequest",
    "MotivoRequest",
    "PortadaRead",
    "PostulacionRead",
    "PostulacionRequest",
    "ProductoDeAdministracion",
    "ProductoDelProveedor",
    "ProductoNuevoRequest",
    "PuntuacionRead",
    "PuntuacionRequest",
    "RazonRead",
    "RazonRequest",
    "RazonesRequest",
    "TarjetaRead",
    "TransicionRequest",
    "VarianteRead",
    "VarianteRequest",
    "VersionRead",
    "VersionRequest",
]


# --------------------------------------------------------------------------- #
# Inventario (0074)
# --------------------------------------------------------------------------- #
class ExistenciasRead(BaseModel):
    """Lo que hay de un SKU. `available` LO CALCULA EL SERVIDOR."""

    sku: str
    on_hand: int
    reserved: int
    available: int


class UnidadDeInventario(BaseModel):
    """Una variante con su inventario, o con la constancia de que no tiene.

    `stock` en `null` NO ES CERO: es que nadie cargó existencias de ese SKU. La
    pantalla lo dice con esas palabras, porque «agotado» mandaría a quien vende
    a buscar un problema que no existe.
    """

    variant_id: str
    sku: str
    name: str
    options: dict[str, Any] = Field(default_factory=dict)
    price_delta_minor: int = 0
    stock: ExistenciasRead | None = None


class InventarioRead(BaseModel):
    product_id: str
    version_id: str | None = None
    units: list[UnidadDeInventario] = Field(default_factory=list)
    #: `false` significa que la 0074 no está aplicada en esta base.
    disponible: bool = True


class MovimientoRead(BaseModel):
    """Una línea del historial. SOLO SE AÑADEN: ninguna se edita ni se borra."""

    id: str
    sku: str
    kind: str
    quantity: int
    on_hand_after: int
    reserved_after: int
    available_after: int
    reason: str | None = None
    actor_id: str | None = None
    actor_role: str
    created_at: datetime


class EntradaRequest(BaseModel):
    sku: str = Field(min_length=1, max_length=48)
    quantity: int = Field(gt=0, le=1_000_000)
    reason: str | None = Field(default=None, max_length=500)
    #: LA CLAVE DE IDEMPOTENCIA. Sin ella, un doble toque carga el doble.
    idempotency_key: str = Field(min_length=1, max_length=200)


class AjusteRequest(BaseModel):
    sku: str = Field(min_length=1, max_length=48)
    #: CON SIGNO: es el único movimiento que puede restar.
    quantity: int = Field(le=1_000_000, ge=-1_000_000)
    #: OBLIGATORIO. Es el único que cambia el número sin que haya pasado nada
    #: fuera del sistema.
    reason: str = Field(min_length=3, max_length=500)
    idempotency_key: str = Field(min_length=1, max_length=200)


# --------------------------------------------------------------------------- #
# Carrito (0075)
# --------------------------------------------------------------------------- #
class LineaDelCarrito(BaseModel):
    """Una línea, con lo que el servidor sabe de ella AHORA."""

    item_id: str
    product_id: str
    version_id: str
    variant_id: str
    name: str
    variant_name: str | None = None
    sku: str | None = None
    seller_id: str
    seller_name: str
    image_path: str | None = None
    image_url: str | None = None
    alt_text: str | None = None
    quantity: int
    #: El precio de AHORA. `null` es «sin precio configurado», nunca gratis.
    unit_price_minor: int | None = None
    currency: str | None = None
    line_total_minor: int | None = None
    #: Lo que se veía al añadir. SOLO PARA AVISAR de que cambió.
    seen_price_minor: int
    seen_currency: str
    #: `null` cuando ese SKU no tiene inventario cargado. No es cero.
    available: int | None = None
    #: Códigos, no frases: la pantalla los traduce.
    issues: list[str] = Field(default_factory=list)
    purchasable: bool = False
    added_at: datetime | None = None


class CarritoRead(BaseModel):
    """La bolsa entera. TODOS los importes los calcula el servidor."""

    items: list[LineaDelCarrito] = Field(default_factory=list)
    currency: str | None = None
    #: `null` cuando no hay nada comprable. Un cero con moneda parecería una
    #: compra de cero.
    subtotal_minor: int | None = None
    units: int = 0
    lines: int = 0
    blocked_lines: int = 0
    #: SIEMPRE `false`. No existe la compra física: no hay checkout, ni pedido,
    #: ni pago, y la pantalla no pinta ningún botón que lo prometa.
    purchasable: bool = False
    #: `false` significa que la 0075 no está aplicada en esta base.
    disponible: bool = True


class AnadirAlCarrito(BaseModel):
    product_id: str
    variant_id: str
    quantity: int = Field(default=1, ge=1, le=1_000)


class CantidadDeLaLinea(BaseModel):
    #: CERO QUITA LA LÍNEA. Es un destino, no un paso: mandar lo mismo dos veces
    #: deja lo mismo.
    quantity: int = Field(ge=0, le=1_000)


class ContadoresRead(BaseModel):
    """Los dos contadores del encabezado, SEPARADOS.

    La bolsa cuenta UNIDADES del carrito; guardados cuenta PRODUCTOS marcados.
    Juntarlos haría que el número no quisiera decir nada concreto.
    """

    cart_units: int = 0
    saved_products: int = 0
