"""Qué falta para ENVIAR, para REENVIAR y para APROBAR. Lógica pura.

Sin base de datos: recibe el expediente ya cargado y la política que aplica, y
devuelve CÓDIGOS estables (`legal_name`, `document:identity`, …) que el
teléfono traduce. Una lista vacía significa «nada pendiente».

DE DÓNDE SALE CADA REQUISITO, Y NADA MÁS:

  * LO MÍNIMO DEL ALCANCE APROBADO (decisión 2, «Todos los prestadores deberán
    presentar como mínimo…»): nombre legal, país, qué ofrece, documento de
    identidad y, si es empresa, dato tributario, representante y documento que
    acredite la representación. Está aquí porque ya está decidido.
  * LO DE CADA CATEGORÍA NO SE ESCRIBE AQUÍ. Qué documentos o credenciales
    exige cada categoría es una decisión pendiente de la empresa: vive en los
    `parameters` de la política publicada (`required_documents`,
    `required_credentials`). Sin nada configurado, no se exige nada más.
  * LAS CONDICIONES: sin política publicada no se envía
    (`provider_terms_not_published`), y aceptar una versión que ya no es la
    vigente tampoco vale (`provider_terms_changed`).

NADA «PENDIENTE» CUENTA COMO APROBADO. Para aprobar, cada documento exigido
tiene que estar ACEPTADO, cada credencial exigida VERIFICADA y vigente, y no
puede quedar ninguna evidencia sin revisar.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from app.modules.services.models import (
    ACTIVO,
    CREDENCIAL_DECLARADA,
    CREDENCIAL_RECHAZADA,
    CREDENCIAL_VERIFICADA,
    DOCUMENTO_ACEPTADO,
    DOCUMENTO_OBSERVADO,
    DOCUMENTO_PENDIENTE,
    EMPRESA,
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderCredential,
    ServiceProviderDocument,
)

#: Lo mínimo del alcance aprobado, por tipo de prestador.
DOCUMENTOS_BASE: dict[str, tuple[str, ...]] = {
    "individual": ("identity",),
    "company": ("identity", "legal_representation"),
}

#: Los campos del borrador que Z puede señalar al pedir correcciones.
CAMPOS_OBSERVABLES = (
    "provider_type",
    "display_name",
    "legal_name",
    "country_code",
    "tax_id",
    "representative_name",
    "summary",
    "requested_category",
)


@dataclass
class Evidencia:
    """Lo que se mira de un expediente para decidir qué falta."""

    solicitud: ServiceProviderApplication
    prestador: ServiceProvider
    documentos: list[ServiceProviderDocument] = field(default_factory=list)
    credenciales: list[ServiceProviderCredential] = field(default_factory=list)

    @property
    def documentos_activos(self) -> list[ServiceProviderDocument]:
        return [d for d in self.documentos if d.lifecycle == ACTIVO]

    @property
    def credenciales_activas(self) -> list[ServiceProviderCredential]:
        return [c for c in self.credenciales if c.lifecycle == ACTIVO]


def exigidos(politica: ServicePolicy | None, tipo_de_prestador: str) -> tuple[list[str], list[str]]:
    """(documentos, credenciales) exigidos: lo mínimo + lo que diga la política."""
    documentos = list(DOCUMENTOS_BASE.get(tipo_de_prestador, ("identity",)))
    credenciales: list[str] = []
    parametros = (politica.parameters if politica is not None else None) or {}
    por_tipo = parametros.get("required_documents") or {}
    for kind in por_tipo.get(tipo_de_prestador, []) or []:
        if kind not in documentos:
            documentos.append(kind)
    for kind in parametros.get("required_credentials", []) or []:
        if kind not in credenciales:
            credenciales.append(kind)
    return documentos, credenciales


def estado_visible_de_credencial(credencial: ServiceProviderCredential, hoy: date) -> str:
    """`pending`, `observed`, `verified`, `rejected` o `expired`.

    VENCIDA SE CALCULA, no se guarda: una credencial verificada cuyo
    vencimiento ya pasó deja de contar, aunque nadie haya pasado a marcarla.
    """
    if credencial.status == CREDENCIAL_RECHAZADA:
        return "rejected"
    if credencial.expires_on is not None and credencial.expires_on < hoy:
        return "expired"
    if credencial.status == CREDENCIAL_VERIFICADA:
        return "verified"
    if credencial.status == CREDENCIAL_DECLARADA and credencial.observed_at is not None:
        return "observed"
    if credencial.status == CREDENCIAL_DECLARADA:
        return "pending"
    return credencial.status


def _terminos(
    solicitud: ServiceProviderApplication, vigente: ServicePolicy | None
) -> list[str]:
    if vigente is None:
        return ["provider_terms_not_published"]
    if solicitud.terms_policy_id is None or solicitud.terms_sha256 is None:
        return ["provider_terms_not_accepted"]
    if solicitud.terms_policy_id != vigente.id or solicitud.terms_sha256 != vigente.body_sha256:
        return ["provider_terms_changed"]
    return []


def para_enviar(
    evidencia: Evidencia,
    *,
    vigente: ServicePolicy | None,
    hoy: date,
    terminos_consultables: bool = True,
) -> list[str]:
    """Lo que falta para enviar (o reenviar). Vacío = se puede.

    `terminos_consultables` en falso es «sin país no se sabe qué política
    rige»: entonces solo se dice que falta el país, sin inventar ni un sí ni un
    no sobre las condiciones.
    """
    p = evidencia.prestador
    s = evidencia.solicitud
    faltan: list[str] = []
    if not p.legal_name:
        faltan.append("legal_name")
    if not p.country_code:
        faltan.append("country_code")
    if not s.summary:
        faltan.append("summary")
    if p.provider_type == EMPRESA:
        if not p.tax_id:
            faltan.append("tax_id")
        if not p.representative_name:
            faltan.append("representative_name")

    documentos, credenciales = exigidos(vigente, p.provider_type)
    presentados = {
        d.kind for d in evidencia.documentos_activos if d.review_status != DOCUMENTO_OBSERVADO
    }
    faltan += [f"document:{k}" for k in documentos if k not in presentados]

    activas = evidencia.credenciales_activas
    vivas = {
        c.kind
        for c in activas
        if estado_visible_de_credencial(c, hoy) not in ("rejected", "expired")
    }
    faltan += [f"credential:{k}" for k in credenciales if k not in vivas]
    # LA EVIDENCIA TIENE QUE ESTAR: sin documento, o con uno que ya no está
    # activo (una credencial aún por verificar). Una VERIFICADA puede apuntar
    # a un documento reemplazado: es el que Z miró, y se conserva.
    activos = {d.id for d in evidencia.documentos_activos}
    for c in activas:
        visible = estado_visible_de_credencial(c, hoy)
        if visible in ("rejected", "expired"):
            continue
        if c.evidence_document_id is None or (
            visible in ("pending", "observed") and c.evidence_document_id not in activos
        ):
            faltan.append("credential_evidence")
            break

    if terminos_consultables:
        faltan += _terminos(s, vigente)
    return faltan


def correcciones_pendientes(
    evidencia: Evidencia,
    *,
    campos_observados: list[str],
    ultimo_envio: dict | None,
    hoy: date,
) -> list[str]:
    """Lo que Z pidió corregir y sigue igual. Vacío = se puede reenviar.

    Un documento observado se corrige REEMPLAZÁNDOLO; una credencial observada,
    editándola. Un campo señalado tiene que ser distinto del que se envió.
    """
    faltan: list[str] = []
    for d in evidencia.documentos_activos:
        if d.review_status == DOCUMENTO_OBSERVADO:
            faltan.append(f"document_observed:{d.kind}")
    if any(
        estado_visible_de_credencial(c, hoy) == "observed" for c in evidencia.credenciales_activas
    ):
        faltan.append("credential_observed")
    enviado = (ultimo_envio or {}).get("fields", {})
    actual = datos_del_borrador(evidencia)
    for campo in campos_observados:
        if campo in CAMPOS_OBSERVABLES and actual.get(campo) == enviado.get(campo):
            faltan.append(f"field_not_corrected:{campo}")
    return faltan


def para_aprobar(
    evidencia: Evidencia,
    *,
    aceptada: ServicePolicy | None,
    hoy: date,
) -> list[str]:
    """Lo que impide aprobar. Vacío = se puede.

    Se mide contra la política QUE ACEPTÓ quien postula (la congelada al
    enviar), no contra otra publicada después: cambiar las reglas no puede
    cambiar lo que se le exigió.
    """
    p = evidencia.prestador
    if aceptada is None:
        return ["provider_terms_not_accepted"]
    documentos, credenciales = exigidos(aceptada, p.provider_type)
    bloqueos: list[str] = []

    activos = evidencia.documentos_activos
    for d in activos:
        if d.review_status == DOCUMENTO_PENDIENTE:
            bloqueos.append(f"document_pending_review:{d.kind}")
        elif d.review_status == DOCUMENTO_OBSERVADO:
            bloqueos.append(f"document_observed:{d.kind}")
    aceptados = {d.kind for d in activos if d.review_status == DOCUMENTO_ACEPTADO}
    bloqueos += [f"document_not_accepted:{k}" for k in documentos if k not in aceptados]

    for c in evidencia.credenciales_activas:
        visible = estado_visible_de_credencial(c, hoy)
        if visible in ("pending", "observed"):
            bloqueos.append("credential_pending_review")
            break
    verificadas = {
        c.kind
        for c in evidencia.credenciales_activas
        if estado_visible_de_credencial(c, hoy) == "verified"
    }
    bloqueos += [f"credential_not_verified:{k}" for k in credenciales if k not in verificadas]
    # Sin duplicados y en orden estable.
    return list(dict.fromkeys(bloqueos))


def datos_del_borrador(evidencia: Evidencia) -> dict[str, object]:
    """Los campos del borrador, tal y como se congelan en cada envío."""
    p = evidencia.prestador
    s = evidencia.solicitud
    return {
        "provider_type": p.provider_type,
        "display_name": p.display_name,
        "legal_name": p.legal_name,
        "country_code": p.country_code,
        "tax_id": p.tax_id,
        "representative_name": p.representative_name,
        "summary": s.summary,
        "requested_category": s.requested_category,
    }


__all__ = [
    "CAMPOS_OBSERVABLES",
    "DOCUMENTOS_BASE",
    "Evidencia",
    "correcciones_pendientes",
    "datos_del_borrador",
    "estado_visible_de_credencial",
    "exigidos",
    "para_aprobar",
    "para_enviar",
]
