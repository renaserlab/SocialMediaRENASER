"""Los contratos de la admisión de Servicios: lo que entra y lo que sale.

TRES VISTAS DE LO MISMO, Y NINGUNA SE DERIVA DE OTRA POR DESCUIDO:

    pública          lo que vería cualquiera de un prestador ACTIVO: nombre,
                     tipo y país. Nada legal, nada tributario.
    privada          lo que ve quien postula de SU expediente: sus datos, su
                     estado, el mensaje que Z le dejó y qué le falta.
    administrativa   lo que ve el equipo de Z: además, notas internas, quién
                     decidió, la política aceptada, los envíos congelados y
                     el historial completo.

LAS SALIDAS SE CONSTRUYEN CAMPO A CAMPO (`desde(...)`), nunca con
`from_attributes`: así una columna nueva en la tabla no aparece sola en una
respuesta. Y NINGUNA lleva `storage_path`, el depósito ni un enlace: un
documento privado se abre pidiendo un enlace firmado de dos minutos, uno por
petición.

LAS ENTRADAS PROHÍBEN CAMPOS DESCONOCIDOS (`extra="forbid"`). En particular no
existe `status` en ninguna: el estado solo cambia por las acciones explícitas
de `admision`, nunca con un `PATCH` genérico.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.services import states
from app.modules.services.models import (
    ACTIVO,
    CREDENCIAL_DECLARADA,
    PRESTADOR_ACTIVO,
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderApplicationSubmission,
    ServiceProviderCredential,
    ServiceProviderDocument,
)

TipoDePrestador = Literal["individual", "company"]
TipoDeCredencial = Literal[
    "professional_title",
    "professional_license",
    "professional_registration",
    "certification",
    "insurance",
    "other",
]


class _Entrada(BaseModel):
    """Toda entrada: sin campos desconocidos y sin espacios de sobra."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _pais_en_mayusculas(valor: object) -> object:
    return valor.strip().upper() if isinstance(valor, str) else valor


# =========================================================================== #
# ENTRADAS: quien postula
# =========================================================================== #
class SolicitudIniciar(_Entrada):
    """Empezar la postulación, o recuperar la que ya está viva.

    Es IDEMPOTENTE: si ya hay una postulación viva, se devuelve esa y este
    cuerpo no cambia nada. Repetir la petición no crea otra.
    """

    provider_type: TipoDePrestador
    display_name: str = Field(min_length=2, max_length=120)


class BorradorActualizar(_Entrada):
    """Cambiar el borrador propio. SOLO en `draft` o `changes_requested`.

    Un campo AUSENTE no se toca; un campo con `null` se vacía (los que admiten
    vacío). `provider_type` y `display_name` no se pueden vaciar.
    """

    provider_type: TipoDePrestador | None = None
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    legal_name: str | None = Field(default=None, min_length=2, max_length=200)
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    tax_id: str | None = Field(default=None, min_length=5, max_length=20)
    representative_name: str | None = Field(default=None, min_length=2, max_length=200)
    summary: str | None = Field(default=None, min_length=20, max_length=4000)
    requested_category: str | None = Field(default=None, min_length=2, max_length=80)

    @field_validator("country_code", mode="before")
    @classmethod
    def _pais(cls, valor: object) -> object:
        return _pais_en_mayusculas(valor)

    @model_validator(mode="after")
    def _algo_que_cambiar(self) -> "BorradorActualizar":
        if not self.model_fields_set:
            raise ValueError("No hay nada que actualizar.")
        for campo in ("provider_type", "display_name"):
            if campo in self.model_fields_set and getattr(self, campo) is None:
                raise ValueError(f"{campo} no se puede vaciar.")
        return self

    def cambios(self) -> dict[str, object]:
        """Solo lo que vino en la petición, con sus `null` explícitos."""
        return {campo: getattr(self, campo) for campo in self.model_fields_set}


class TerminosAceptar(_Entrada):
    """Aceptar EXPRESAMENTE una versión de las condiciones.

    El cliente devuelve la política y la huella del texto QUE ENSEÑÓ: si la
    empresa publicó otra versión mientras tanto, no cuadra y no se acepta nada
    a ciegas (`provider_terms_changed`).
    """

    terms_policy_id: str
    terms_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class CredencialRegistrar(_Entrada):
    """Declarar una credencial. Nace `declared`: SOLO Z VERIFICA.

    `number` llega completo y el servidor guarda solo su forma enmascarada.
    La idempotencia va en la cabecera `Idempotency-Key`.
    """

    kind: TipoDeCredencial
    title: str = Field(min_length=2, max_length=200)
    issuer: str = Field(min_length=2, max_length=200)
    jurisdiction: str | None = Field(default=None, min_length=2, max_length=120)
    number: str | None = Field(default=None, min_length=1, max_length=64)
    specialty: str | None = Field(default=None, min_length=2, max_length=200)
    issued_on: date | None = None
    expires_on: date | None = None
    evidence_document_id: str | None = None

    @model_validator(mode="after")
    def _vigencia(self) -> "CredencialRegistrar":
        if self.issued_on and self.expires_on and self.expires_on < self.issued_on:
            raise ValueError("La credencial no puede vencer antes de emitirse.")
        return self


class CredencialEditar(_Entrada):
    """Cambiar una credencial DECLARADA. Editar una observada la devuelve a
    pendiente. Un campo ausente no se toca."""

    title: str | None = Field(default=None, min_length=2, max_length=200)
    issuer: str | None = Field(default=None, min_length=2, max_length=200)
    jurisdiction: str | None = Field(default=None, min_length=2, max_length=120)
    number: str | None = Field(default=None, min_length=1, max_length=64)
    specialty: str | None = Field(default=None, min_length=2, max_length=200)
    issued_on: date | None = None
    expires_on: date | None = None
    evidence_document_id: str | None = None

    @model_validator(mode="after")
    def _algo_que_cambiar(self) -> "CredencialEditar":
        if not self.model_fields_set:
            raise ValueError("No hay nada que actualizar.")
        for campo in ("title", "issuer"):
            if campo in self.model_fields_set and getattr(self, campo) is None:
                raise ValueError(f"{campo} no se puede vaciar.")
        return self

    def cambios(self) -> dict[str, object]:
        return {campo: getattr(self, campo) for campo in self.model_fields_set}


class SolicitudEnviar(_Entrada):
    """Enviar o reenviar: exige la DECLARACIÓN DE VERACIDAD, expresa.

    Las condiciones se aceptan antes (`TerminosAceptar`); al enviar se
    comprueba que lo aceptado sigue siendo lo vigente.
    """

    declare_truthfulness: Literal[True]


class SolicitudRetirar(_Entrada):
    """Retirar la postulación PROPIA. Solo quien postula, antes de la decisión.

    Exige confirmación explícita. El motivo es opcional y es lo que queda en la
    nota visible del historial: nunca lleva nada interno de Z. Es final: la
    postulación queda solo para consulta y se puede empezar otra nueva, que NO
    hereda la política aceptada ni los documentos de esta.
    """

    confirm: Literal[True]
    reason: str | None = Field(default=None, min_length=3, max_length=500)


# =========================================================================== #
# ENTRADAS: el equipo de Z
# =========================================================================== #
class _Decision(_Entrada):
    #: Lo que solo ve Z.
    internal_note: str | None = Field(default=None, max_length=4000)


class RevisionIniciar(_Decision):
    """Tomar una postulación enviada o reenviada, o devolver a revisión una
    suspendida."""


class CorreccionesSolicitar(_Decision):
    """Devolverla con lo que hay que corregir. El mensaje es obligatorio.

    `fields` señala los campos del borrador que hay que cambiar; los documentos
    y credenciales se observan con sus propias acciones.
    """

    message: str = Field(min_length=3, max_length=2000)
    fields: list[str] = Field(default_factory=list, max_length=20)


class SolicitudAprobar(_Decision):
    message: str | None = Field(default=None, min_length=3, max_length=2000)


class SolicitudRechazar(_Decision):
    """Un rechazo sin motivo no se le puede enseñar a nadie."""

    message: str = Field(min_length=3, max_length=2000)


class PrestadorSuspender(_Decision):
    """Suspender con motivo. Inmediata no es definitiva: se investiga."""

    message: str = Field(min_length=3, max_length=2000)


class EvidenciaObservar(_Entrada):
    """Observar un documento, u observar o rechazar una credencial: con motivo."""

    note: str = Field(min_length=3, max_length=1000)


class PoliticaBorradorCrear(_Entrada):
    """Crear el borrador de las condiciones de un país (o recuperar el que hay)."""

    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    category: str | None = Field(default=None, min_length=2, max_length=80)
    title: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=50, max_length=100_000)
    parameters: dict = Field(default_factory=dict)

    @field_validator("country_code", mode="before")
    @classmethod
    def _pais(cls, valor: object) -> object:
        return _pais_en_mayusculas(valor)


class PoliticaEditar(_Entrada):
    title: str | None = Field(default=None, min_length=3, max_length=200)
    body: str | None = Field(default=None, min_length=50, max_length=100_000)
    parameters: dict | None = None

    @model_validator(mode="after")
    def _algo_que_cambiar(self) -> "PoliticaEditar":
        if not self.model_fields_set:
            raise ValueError("No hay nada que actualizar.")
        for campo in self.model_fields_set:
            if getattr(self, campo) is None:
                raise ValueError(f"{campo} no se puede vaciar.")
        return self

    def cambios(self) -> dict[str, object]:
        return {campo: getattr(self, campo) for campo in self.model_fields_set}


# =========================================================================== #
# SALIDAS
# =========================================================================== #
class PrestadorPublicoRead(BaseModel):
    """Lo PÚBLICO de un prestador. Solo existe para un prestador ACTIVO."""

    id: str
    provider_type: str
    display_name: str
    country_code: str | None = None

    @classmethod
    def desde(cls, prestador: ServiceProvider) -> "PrestadorPublicoRead | None":
        """`None` si no está activo: un prestador pendiente o suspendido no
        tiene cara pública."""
        if prestador.status != PRESTADOR_ACTIVO:
            return None
        return cls(
            id=prestador.id,
            provider_type=prestador.provider_type,
            display_name=prestador.display_name,
            country_code=prestador.country_code,
        )


class PrestadorPrivadoRead(BaseModel):
    """Los datos del prestador, para él mismo."""

    id: str
    provider_type: str
    display_name: str
    legal_name: str | None = None
    country_code: str | None = None
    tax_id: str | None = None
    representative_name: str | None = None
    status: str

    @classmethod
    def desde(cls, prestador: ServiceProvider) -> "PrestadorPrivadoRead":
        return cls(
            id=prestador.id,
            provider_type=prestador.provider_type,
            display_name=prestador.display_name,
            legal_name=prestador.legal_name,
            country_code=prestador.country_code,
            tax_id=prestador.tax_id,
            representative_name=prestador.representative_name,
            status=prestador.status,
        )


class PrestadorAdminRead(PrestadorPrivadoRead):
    profile_id: str
    activated_at: datetime | None = None
    suspended_at: datetime | None = None
    created_at: datetime | None = None

    @classmethod
    def desde(cls, prestador: ServiceProvider) -> "PrestadorAdminRead":
        return cls(
            **PrestadorPrivadoRead.desde(prestador).model_dump(),
            profile_id=prestador.profile_id,
            activated_at=prestador.activated_at,
            suspended_at=prestador.suspended_at,
            created_at=prestador.created_at,
        )


class DocumentoPrivadoRead(BaseModel):
    """Un documento propio. SIN ruta: se abre pidiendo un enlace de 2 minutos."""

    id: str
    kind: str
    content_type: str
    byte_size: int
    review_status: str
    #: Lo que Z le dijo al observarlo.
    review_note: str | None = None
    created_at: datetime | None = None
    #: Retirar solo cabe si nunca se envió; reemplazar, mientras sea editable.
    can_remove: bool = False
    can_replace: bool = False

    @classmethod
    def desde(
        cls,
        documento: ServiceProviderDocument,
        *,
        editable: bool = False,
        enviado: bool = False,
    ) -> "DocumentoPrivadoRead":
        activo = documento.lifecycle == ACTIVO
        return cls(
            id=documento.id,
            kind=documento.kind,
            content_type=documento.content_type,
            byte_size=documento.byte_size,
            review_status=documento.review_status,
            review_note=documento.review_note,
            created_at=documento.created_at,
            can_remove=editable and activo and not enviado,
            can_replace=editable and activo,
        )


class DocumentoAdminRead(BaseModel):
    """Lo mismo más quién, cuándo y su ciclo. TAMPOCO lleva la ruta."""

    id: str
    kind: str
    content_type: str
    byte_size: int
    review_status: str
    review_note: str | None = None
    created_at: datetime | None = None
    application_id: str
    checksum_sha256: str | None = None
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    uploaded_by: str | None = None
    lifecycle: str
    replaced_by: str | None = None

    @classmethod
    def desde(cls, documento: ServiceProviderDocument) -> "DocumentoAdminRead":
        return cls(
            id=documento.id,
            kind=documento.kind,
            content_type=documento.content_type,
            byte_size=documento.byte_size,
            review_status=documento.review_status,
            review_note=documento.review_note,
            created_at=documento.created_at,
            application_id=documento.application_id,
            checksum_sha256=documento.checksum_sha256,
            reviewed_at=documento.reviewed_at,
            reviewed_by=documento.reviewed_by,
            uploaded_by=documento.uploaded_by,
            lifecycle=documento.lifecycle,
            replaced_by=documento.replaced_by,
        )


class CredencialPrivadaRead(BaseModel):
    id: str
    kind: str
    title: str
    issuer: str
    jurisdiction: str | None = None
    #: SOLO ENMASCARADO. El número completo nunca viaja.
    number_masked: str | None = None
    specialty: str | None = None
    issued_on: date | None = None
    expires_on: date | None = None
    #: `pending`, `observed`, `verified`, `rejected` o `expired`.
    display_status: str
    review_note: str | None = None
    evidence_document_id: str | None = None
    can_edit: bool = False
    can_remove: bool = False

    @classmethod
    def desde(
        cls,
        credencial: ServiceProviderCredential,
        *,
        hoy: date,
        editable: bool = False,
        enviada: bool = False,
    ) -> "CredencialPrivadaRead":
        from app.modules.services.requisitos import estado_visible_de_credencial

        declarada = credencial.status == CREDENCIAL_DECLARADA and credencial.lifecycle == ACTIVO
        return cls(
            id=credencial.id,
            kind=credencial.kind,
            title=credencial.title,
            issuer=credencial.issuer,
            jurisdiction=credencial.jurisdiction,
            number_masked=credencial.number_masked,
            specialty=credencial.specialty,
            issued_on=credencial.issued_on,
            expires_on=credencial.expires_on,
            display_status=estado_visible_de_credencial(credencial, hoy),
            review_note=credencial.review_note,
            evidence_document_id=credencial.evidence_document_id,
            can_edit=editable and declarada,
            can_remove=editable and credencial.lifecycle == ACTIVO and not enviada,
        )


class CredencialAdminRead(CredencialPrivadaRead):
    application_id: str | None = None
    status: str
    verified_at: datetime | None = None
    verified_by: str | None = None
    observed_at: datetime | None = None
    created_at: datetime | None = None

    @classmethod
    def desde_admin(cls, credencial: ServiceProviderCredential, *, hoy: date) -> "CredencialAdminRead":
        base = CredencialPrivadaRead.desde(credencial, hoy=hoy).model_dump()
        return cls(
            **base,
            application_id=credencial.application_id,
            status=credencial.status,
            verified_at=credencial.verified_at,
            verified_by=credencial.verified_by,
            observed_at=credencial.observed_at,
            created_at=credencial.created_at,
        )


class TerminosRead(BaseModel):
    """Las condiciones vigentes, para leerlas y aceptarlas."""

    policy_id: str
    version: int
    country_code: str
    category: str | None = None
    title: str
    body: str
    sha256: str
    effective_at: datetime | None = None

    @classmethod
    def desde(cls, politica: ServicePolicy) -> "TerminosRead":
        return cls(
            policy_id=politica.id,
            version=politica.version,
            country_code=politica.country_code,
            category=politica.category,
            title=politica.title,
            body=politica.body,
            sha256=politica.body_sha256,
            effective_at=politica.effective_at,
        )


class TerminosAceptadosRead(BaseModel):
    policy_id: str
    version: int | None = None
    accepted_at: datetime | None = None


class SolicitudPrivadaRead(BaseModel):
    """El expediente, visto por quien postula. Sin notas internas, sin quién
    decidió y sin rutas de archivos."""

    id: str
    status: str
    provider: PrestadorPrivadoRead
    summary: str | None = None
    requested_category: str | None = None
    submitted_at: datetime | None = None
    last_submitted_at: datetime | None = None
    decided_at: datetime | None = None
    suspended_at: datetime | None = None
    #: Lo que Z le dejó dicho: qué corregir, por qué se rechazó o se suspendió.
    applicant_message: str | None = None
    #: Los campos que Z pidió corregir (solo en `changes_requested`).
    observed_fields: list[str] = Field(default_factory=list)
    terms: TerminosAceptadosRead | None = None
    documents: list[DocumentoPrivadoRead] = Field(default_factory=list)
    credentials: list[CredencialPrivadaRead] = Field(default_factory=list)
    #: Si todavía puede escribir en el borrador.
    editable: bool = False
    #: LO QUE LE FALTA PARA PODER ENVIAR O REENVIAR, como códigos traducibles.
    missing: list[str] = Field(default_factory=list)
    can_submit: bool = False
    can_resubmit: bool = False
    can_withdraw: bool = False
    submissions_count: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def desde(cls, expediente, *, faltan: list[str], hoy: date) -> "SolicitudPrivadaRead":
        solicitud = expediente.solicitud
        editable = states.es_editable(solicitud.status)
        aceptada = expediente.politica_aceptada
        return cls(
            id=solicitud.id,
            status=solicitud.status,
            provider=PrestadorPrivadoRead.desde(expediente.prestador),
            summary=solicitud.summary,
            requested_category=solicitud.requested_category,
            submitted_at=solicitud.submitted_at,
            last_submitted_at=solicitud.last_submitted_at,
            decided_at=solicitud.decided_at,
            suspended_at=solicitud.suspended_at,
            applicant_message=solicitud.applicant_message,
            observed_fields=list(expediente.campos_observados),
            terms=(
                TerminosAceptadosRead(
                    policy_id=solicitud.terms_policy_id,
                    version=aceptada.version if aceptada else None,
                    accepted_at=solicitud.terms_accepted_at,
                )
                if solicitud.terms_policy_id
                else None
            ),
            documents=[
                DocumentoPrivadoRead.desde(
                    d, editable=editable, enviado=d.id in expediente.documentos_enviados
                )
                for d in expediente.documentos
            ],
            credentials=[
                CredencialPrivadaRead.desde(
                    c,
                    hoy=hoy,
                    editable=editable,
                    enviada=c.id in expediente.credenciales_enviadas,
                )
                for c in expediente.credenciales
            ],
            editable=editable,
            missing=list(faltan) if editable else [],
            can_submit=solicitud.status == states.BORRADOR and not faltan,
            can_resubmit=solicitud.status == states.CORRECCIONES_PEDIDAS and not faltan,
            # Antes de la decisión: una aprobada que volvió a revisión tras una
            # suspensión ya se decidió y no se retira.
            can_withdraw=(
                solicitud.status in states.RETIRABLES and solicitud.decided_at is None
            ),
            submissions_count=len(expediente.envios),
            created_at=solicitud.created_at,
            updated_at=solicitud.updated_at,
        )


class EnvioRead(BaseModel):
    """Un envío congelado. La foto solo la ve administración."""

    sequence: int
    kind: str
    terms_policy_id: str
    terms_version: int
    terms_sha256: str
    snapshot: dict
    snapshot_sha256: str
    created_at: datetime | None = None

    @classmethod
    def desde(cls, envio: ServiceProviderApplicationSubmission) -> "EnvioRead":
        return cls(
            sequence=envio.sequence,
            kind=envio.kind,
            terms_policy_id=envio.terms_policy_id,
            terms_version=envio.terms_version,
            terms_sha256=envio.terms_sha256,
            snapshot=dict(envio.snapshot or {}),
            snapshot_sha256=envio.snapshot_sha256,
            created_at=envio.created_at,
        )


class SolicitudAdminRead(BaseModel):
    """El expediente completo, para el equipo de Z."""

    id: str
    status: str
    provider: PrestadorAdminRead
    summary: str | None = None
    requested_category: str | None = None
    terms_policy_id: str | None = None
    terms_version: int | None = None
    terms_sha256: str | None = None
    terms_accepted_at: datetime | None = None
    truthfulness_declared_at: datetime | None = None
    submitted_at: datetime | None = None
    last_submitted_at: datetime | None = None
    review_started_at: datetime | None = None
    decided_at: datetime | None = None
    decided_by: str | None = None
    suspended_at: datetime | None = None
    applicant_message: str | None = None
    internal_notes: str | None = None
    observed_fields: list[str] = Field(default_factory=list)
    documents: list[DocumentoAdminRead] = Field(default_factory=list)
    replaced_documents: list[DocumentoAdminRead] = Field(default_factory=list)
    credentials: list[CredencialAdminRead] = Field(default_factory=list)
    submissions: list[EnvioRead] = Field(default_factory=list)
    #: Lo que impide aprobar ahora mismo (vacío si no está en revisión).
    approval_blockers: list[str] = Field(default_factory=list)
    #: Lo que QUIEN MIRA puede hacer ahora. Para pintar botones: decide el
    #: servidor al ejecutar.
    available_actions: list[str] = Field(default_factory=list)
    #: Si quien mira es el dueño: entonces no decide nada.
    is_own: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def desde(
        cls,
        expediente,
        *,
        hoy: date,
        bloqueos: list[str],
        acciones: list[str],
        propia: bool,
    ) -> "SolicitudAdminRead":
        solicitud = expediente.solicitud
        aceptada = expediente.politica_aceptada
        return cls(
            id=solicitud.id,
            status=solicitud.status,
            provider=PrestadorAdminRead.desde(expediente.prestador),
            summary=solicitud.summary,
            requested_category=solicitud.requested_category,
            terms_policy_id=solicitud.terms_policy_id,
            terms_version=aceptada.version if aceptada else None,
            terms_sha256=solicitud.terms_sha256,
            terms_accepted_at=solicitud.terms_accepted_at,
            truthfulness_declared_at=solicitud.truthfulness_declared_at,
            submitted_at=solicitud.submitted_at,
            last_submitted_at=solicitud.last_submitted_at,
            review_started_at=solicitud.review_started_at,
            decided_at=solicitud.decided_at,
            decided_by=solicitud.decided_by,
            suspended_at=solicitud.suspended_at,
            applicant_message=solicitud.applicant_message,
            internal_notes=solicitud.internal_notes,
            observed_fields=list(expediente.campos_observados),
            documents=[DocumentoAdminRead.desde(d) for d in expediente.documentos],
            replaced_documents=[DocumentoAdminRead.desde(d) for d in expediente.reemplazados],
            credentials=[
                CredencialAdminRead.desde_admin(c, hoy=hoy) for c in expediente.credenciales
            ],
            submissions=[EnvioRead.desde(e) for e in expediente.envios],
            approval_blockers=list(bloqueos),
            available_actions=list(acciones),
            is_own=propia,
            created_at=solicitud.created_at,
            updated_at=solicitud.updated_at,
        )


class SolicitudResumenRead(BaseModel):
    """Una fila de la bandeja de administración."""

    id: str
    status: str
    provider_type: str
    display_name: str
    requested_category: str | None = None
    submitted_at: datetime | None = None
    last_submitted_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def desde(
        cls, solicitud: ServiceProviderApplication, prestador: ServiceProvider
    ) -> "SolicitudResumenRead":
        return cls(
            id=solicitud.id,
            status=solicitud.status,
            provider_type=prestador.provider_type,
            display_name=prestador.display_name,
            requested_category=solicitud.requested_category,
            submitted_at=solicitud.submitted_at,
            last_submitted_at=solicitud.last_submitted_at,
            updated_at=solicitud.updated_at,
        )


class PaginaDeSolicitudes(BaseModel):
    items: list[SolicitudResumenRead] = Field(default_factory=list)
    #: `null` cuando no hay más. Por cursor y no por página: con filas que se
    #: crean mientras alguien mira, el desplazamiento repite y se salta.
    next_cursor: str | None = None


class EventoVisibleRead(BaseModel):
    """Un paso del historial, visto por quien postula.

    NO DICE QUIÉN de Z actuó ni lleva la nota interna: dice que fue Z.
    """

    from_status: str | None = None
    to_status: str
    by: Literal["you", "z"]
    visible_note: str | None = None
    fields: list[str] = Field(default_factory=list)
    created_at: datetime | None = None

    @classmethod
    def desde(cls, evento: ServiceProviderApplicationEvent) -> "EventoVisibleRead":
        return cls(
            from_status=evento.from_status,
            to_status=evento.to_status,
            by="you" if evento.actor_role == states.PRESTADOR else "z",
            visible_note=evento.visible_note,
            fields=[str(c) for c in (evento.details or {}).get("fields", [])],
            created_at=evento.created_at,
        )


class EventoAdminRead(BaseModel):
    id: str
    from_status: str | None = None
    to_status: str
    actor_id: str | None = None
    actor_role: str
    visible_note: str | None = None
    internal_note: str | None = None
    details: dict = Field(default_factory=dict)
    created_at: datetime | None = None

    @classmethod
    def desde(cls, evento: ServiceProviderApplicationEvent) -> "EventoAdminRead":
        return cls(
            id=evento.id,
            from_status=evento.from_status,
            to_status=evento.to_status,
            actor_id=evento.actor_id,
            actor_role=evento.actor_role,
            visible_note=evento.visible_note,
            internal_note=evento.internal_note,
            details=dict(evento.details or {}),
            created_at=evento.created_at,
        )


class EnlaceTemporalRead(BaseModel):
    """Un enlace para MIRAR un documento ahora. No se guarda ni se lista."""

    url: str
    expires_in: int


class PoliticaRead(BaseModel):
    id: str
    kind: str
    country_code: str
    category: str | None = None
    version: int
    status: str
    title: str
    body: str
    body_sha256: str
    parameters: dict = Field(default_factory=dict)
    effective_at: datetime | None = None
    published_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def desde(cls, politica: ServicePolicy) -> "PoliticaRead":
        return cls(
            id=politica.id,
            kind=politica.kind,
            country_code=politica.country_code,
            category=politica.category,
            version=politica.version,
            status=politica.status,
            title=politica.title,
            body=politica.body,
            body_sha256=politica.body_sha256,
            parameters=dict(politica.parameters or {}),
            effective_at=politica.effective_at,
            published_at=politica.published_at,
            created_at=politica.created_at,
            updated_at=politica.updated_at,
        )


__all__ = [
    "BorradorActualizar",
    "CorreccionesSolicitar",
    "CredencialAdminRead",
    "CredencialEditar",
    "CredencialPrivadaRead",
    "CredencialRegistrar",
    "DocumentoAdminRead",
    "DocumentoPrivadoRead",
    "EnlaceTemporalRead",
    "EnvioRead",
    "EventoAdminRead",
    "EventoVisibleRead",
    "EvidenciaObservar",
    "PaginaDeSolicitudes",
    "PoliticaBorradorCrear",
    "PoliticaEditar",
    "PoliticaRead",
    "PrestadorAdminRead",
    "PrestadorPrivadoRead",
    "PrestadorPublicoRead",
    "PrestadorSuspender",
    "RevisionIniciar",
    "SolicitudAdminRead",
    "SolicitudAprobar",
    "SolicitudEnviar",
    "SolicitudIniciar",
    "SolicitudPrivadaRead",
    "SolicitudRechazar",
    "SolicitudResumenRead",
    "SolicitudRetirar",
    "TerminosAceptadosRead",
    "TerminosAceptar",
    "TerminosRead",
]
