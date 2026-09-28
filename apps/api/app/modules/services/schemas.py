"""Los contratos de la admisión de Servicios: lo que entra y lo que sale.

TRES VISTAS DE LO MISMO, Y NINGUNA SE DERIVA DE OTRA POR DESCUIDO:

    pública          lo que vería cualquiera de un prestador ACTIVO: nombre,
                     tipo y país. Nada legal, nada tributario.
    privada          lo que ve quien postula de SU expediente: sus datos, su
                     estado, el mensaje que Z le dejó y qué le falta.
    administrativa   lo que ve el equipo de Z: además, notas internas, quién
                     decidió, la política aceptada y el historial completo.

LAS SALIDAS SE CONSTRUYEN CAMPO A CAMPO (`desde(...)`), nunca con
`from_attributes`: así una columna nueva en la tabla no aparece sola en una
respuesta. Y NINGUNA lleva `storage_path`: un documento privado se abre con un
enlace firmado y temporal que genera la API (Bloque 1B), nunca con una ruta.

LAS ENTRADAS PROHÍBEN CAMPOS DESCONOCIDOS (`extra="forbid"`). En particular no
existe `status` en ninguna: el estado solo cambia por las acciones explícitas
del mapa de `states`, nunca con un `PATCH` genérico.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.services import states
from app.modules.services.models import (
    PRESTADOR_ACTIVO,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderCredential,
    ServiceProviderDocument,
)

TipoDePrestador = Literal["individual", "company"]
TipoDeDocumento = Literal[
    "identity",
    "legal_representation",
    "tax_registration",
    "proof_of_address",
    "professional_title",
    "professional_license",
    "insurance",
    "portfolio",
    "other",
]
FormatoDeDocumento = Literal["application/pdf", "image/jpeg", "image/png", "image/webp"]
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
# ENTRADAS del Bloque 1A (con ruta)
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


# =========================================================================== #
# ENTRADAS del Bloque 1B (contrato fijado, SIN ruta todavía)
# =========================================================================== #
class DocumentoRegistrar(_Entrada):
    """Registrar un documento YA SUBIDO al depósito privado.

    `storage_path` es la que devolvió el paso de subida de la API; el servidor
    comprueba que empiece por `<perfil>/<postulación>/` antes de aceptarla.
    Reintentar con la misma ruta devuelve el mismo documento.
    """

    kind: TipoDeDocumento
    storage_path: str = Field(min_length=3, max_length=512)
    content_type: FormatoDeDocumento
    byte_size: int = Field(ge=1, le=10 * 1024 * 1024)
    checksum_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


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


class SolicitudEnviar(_Entrada):
    """Enviar (o reenviar tras correcciones).

    El cliente devuelve la política y la huella del texto QUE ENSEÑÓ: si la
    empresa publicó otra versión mientras tanto, la huella no cuadra y no se
    envía nada aceptado a ciegas.
    """

    terms_policy_id: str
    terms_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    declare_truthfulness: Literal[True]


class _Decision(_Entrada):
    #: Lo que solo ve Z.
    internal_note: str | None = Field(default=None, max_length=4000)


class RevisionIniciar(_Decision):
    """Tomar una postulación enviada, reenviada o suspendida."""


class CorreccionesSolicitar(_Decision):
    """Devolverla con lo que hay que corregir. El mensaje es obligatorio."""

    message: str = Field(min_length=3, max_length=2000)


class SolicitudAprobar(_Decision):
    message: str | None = Field(default=None, min_length=3, max_length=2000)


class SolicitudRechazar(_Decision):
    """Un rechazo sin motivo no se le puede enseñar a nadie."""

    message: str = Field(min_length=3, max_length=2000)


class PrestadorSuspender(_Decision):
    """Suspender con motivo. Inmediata no es definitiva: se investiga."""

    message: str = Field(min_length=3, max_length=2000)


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
    """Un documento propio. SIN ruta: se abre con enlace firmado (1B)."""

    id: str
    kind: str
    content_type: str
    byte_size: int
    review_status: str
    #: Lo que Z le dijo al observarlo.
    review_note: str | None = None
    created_at: datetime | None = None

    @classmethod
    def desde(cls, documento: ServiceProviderDocument) -> "DocumentoPrivadoRead":
        return cls(
            id=documento.id,
            kind=documento.kind,
            content_type=documento.content_type,
            byte_size=documento.byte_size,
            review_status=documento.review_status,
            review_note=documento.review_note,
            created_at=documento.created_at,
        )


class DocumentoAdminRead(DocumentoPrivadoRead):
    """Lo mismo más quién y cuándo. TAMPOCO lleva la ruta."""

    application_id: str
    checksum_sha256: str | None = None
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    uploaded_by: str | None = None

    @classmethod
    def desde(cls, documento: ServiceProviderDocument) -> "DocumentoAdminRead":
        return cls(
            **DocumentoPrivadoRead.desde(documento).model_dump(),
            application_id=documento.application_id,
            checksum_sha256=documento.checksum_sha256,
            reviewed_at=documento.reviewed_at,
            reviewed_by=documento.reviewed_by,
            uploaded_by=documento.uploaded_by,
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
    status: str
    review_note: str | None = None
    has_evidence: bool = False

    @classmethod
    def desde(cls, credencial: ServiceProviderCredential) -> "CredencialPrivadaRead":
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
            status=credencial.status,
            review_note=credencial.review_note,
            has_evidence=credencial.evidence_document_id is not None,
        )


class CredencialAdminRead(CredencialPrivadaRead):
    application_id: str | None = None
    evidence_document_id: str | None = None
    verified_at: datetime | None = None
    verified_by: str | None = None
    created_at: datetime | None = None

    @classmethod
    def desde(cls, credencial: ServiceProviderCredential) -> "CredencialAdminRead":
        return cls(
            **CredencialPrivadaRead.desde(credencial).model_dump(),
            application_id=credencial.application_id,
            evidence_document_id=credencial.evidence_document_id,
            verified_at=credencial.verified_at,
            verified_by=credencial.verified_by,
            created_at=credencial.created_at,
        )


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
    terms_accepted_at: datetime | None = None
    documents: list[DocumentoPrivadoRead] = Field(default_factory=list)
    credentials: list[CredencialPrivadaRead] = Field(default_factory=list)
    #: Si todavía puede escribir en el borrador.
    editable: bool = False
    #: LO QUE LE FALTA PARA PODER ENVIAR, como códigos traducibles. Solo se
    #: calcula mientras es editable. No promete que enviar ya exista.
    missing: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def desde(
        cls,
        *,
        solicitud: ServiceProviderApplication,
        prestador: ServiceProvider,
        documentos: list[ServiceProviderDocument],
        credenciales: list[ServiceProviderCredential],
        faltan: list[str],
    ) -> "SolicitudPrivadaRead":
        editable = states.es_editable(solicitud.status)
        return cls(
            id=solicitud.id,
            status=solicitud.status,
            provider=PrestadorPrivadoRead.desde(prestador),
            summary=solicitud.summary,
            requested_category=solicitud.requested_category,
            submitted_at=solicitud.submitted_at,
            last_submitted_at=solicitud.last_submitted_at,
            decided_at=solicitud.decided_at,
            suspended_at=solicitud.suspended_at,
            applicant_message=solicitud.applicant_message,
            terms_accepted_at=solicitud.terms_accepted_at,
            documents=[DocumentoPrivadoRead.desde(d) for d in documentos],
            credentials=[CredencialPrivadaRead.desde(c) for c in credenciales],
            editable=editable,
            missing=list(faltan) if editable else [],
            created_at=solicitud.created_at,
            updated_at=solicitud.updated_at,
        )


class SolicitudAdminRead(BaseModel):
    """El expediente completo, para el equipo de Z."""

    id: str
    status: str
    provider: PrestadorAdminRead
    summary: str | None = None
    requested_category: str | None = None
    terms_policy_id: str | None = None
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
    documents: list[DocumentoAdminRead] = Field(default_factory=list)
    credentials: list[CredencialAdminRead] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def desde(
        cls,
        *,
        solicitud: ServiceProviderApplication,
        prestador: ServiceProvider,
        documentos: list[ServiceProviderDocument],
        credenciales: list[ServiceProviderCredential],
    ) -> "SolicitudAdminRead":
        return cls(
            id=solicitud.id,
            status=solicitud.status,
            provider=PrestadorAdminRead.desde(prestador),
            summary=solicitud.summary,
            requested_category=solicitud.requested_category,
            terms_policy_id=solicitud.terms_policy_id,
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
            documents=[DocumentoAdminRead.desde(d) for d in documentos],
            credentials=[CredencialAdminRead.desde(c) for c in credenciales],
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
    created_at: datetime | None = None

    @classmethod
    def desde(cls, evento: ServiceProviderApplicationEvent) -> "EventoVisibleRead":
        return cls(
            from_status=evento.from_status,
            to_status=evento.to_status,
            by="you" if evento.actor_role == states.PRESTADOR else "z",
            visible_note=evento.visible_note,
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
            created_at=evento.created_at,
        )


__all__ = [
    "BorradorActualizar",
    "CorreccionesSolicitar",
    "CredencialAdminRead",
    "CredencialPrivadaRead",
    "CredencialRegistrar",
    "DocumentoAdminRead",
    "DocumentoPrivadoRead",
    "DocumentoRegistrar",
    "EventoAdminRead",
    "EventoVisibleRead",
    "PaginaDeSolicitudes",
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
]
