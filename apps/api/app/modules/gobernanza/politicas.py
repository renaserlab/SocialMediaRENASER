"""Qué texto está vigente, y cómo se registra que alguien lo aceptó.

DOS REGLAS QUE ORDENAN TODO ESTO:

1. **La política la elige el servidor, nunca el cliente.** El cliente pide «la
   de recompra», no «la versión 3». Si eligiera él, elegiría la que más le
   conviene, y una aceptación firmada contra un texto que el usuario escogió no
   demuestra nada.
2. **Si no hay política vigente, la operación sensible se bloquea.** No se
   coge «la más parecida» ni se sigue sin ella. Es la regla de fallar en
   cerrado que ya rige el dinero en este proyecto.

LO QUE HOY NO HAY, Y NO SE INVENTA. No existen términos de compra aprobados:
falta decidir entidad vendedora, jurisdicción e impuestos. Así que este módulo
NO exige aceptarlos y no escribe ni una línea de texto legal provisional. Crea
la capacidad de manejarlos y espera. `exigir_terminos_de_compra` es la bandera
que lo encenderá el día que haya texto.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.gobernanza import esquema
from app.modules.gobernanza.models import PolicyVersion

#: Los tipos que la base admite. Solo se siembra el primero.
RECOMPRA = "refund_repurchase"
TERMINOS = "terms"
PRIVACIDAD = "privacy"
GARANTIA = "guarantee"


class PoliticaAusente(RuntimeError):
    """No hay ninguna versión vigente para lo que se pide.

    Es una excepción y no un `None` a propósito: quien llama tiene que pararse.
    Un `None` se cuela en un `if` y acaba en una operación sin política.
    """


def huella(texto: str) -> str:
    """SHA-256 del texto EXACTO que se mostró.

    Del texto ya montado, con sus huecos rellenados. La huella de la plantilla
    no demuestra nada: lo que la persona leyó llevaba una fecha dentro.
    """
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def vigente(
    db: AsyncSession,
    *,
    policy_type: str,
    jurisdiction: str = "PE",
    locale: str = "es",
) -> PolicyVersion | None:
    """La versión publicada y sin fecha de cierre, o `None`.

    Solo puede haber una: lo garantiza el índice parcial
    `policy_versions_vigente_unica`. Por eso aquí no hay ningún criterio de
    desempate — si hiciera falta uno, significaría que el servidor está
    ELIGIENDO entre dos textos legales, que es justo lo que no puede pasar.
    """
    if not await esquema.hay_gobernanza(db):
        return None
    return await db.scalar(
        select(PolicyVersion).where(
            PolicyVersion.policy_type == policy_type,
            PolicyVersion.jurisdiction == jurisdiction,
            PolicyVersion.locale == locale,
            PolicyVersion.status == "published",
            PolicyVersion.effective_to.is_(None),
        )
    )


async def exigir_vigente(
    db: AsyncSession,
    *,
    policy_type: str,
    jurisdiction: str = "PE",
    locale: str = "es",
) -> PolicyVersion:
    """La vigente, o se para. Fallar en cerrado."""
    politica = await vigente(
        db, policy_type=policy_type, jurisdiction=jurisdiction, locale=locale
    )
    if politica is None:
        raise PoliticaAusente(
            f"no hay politica vigente de tipo {policy_type} "
            f"para {jurisdiction}/{locale}"
        )
    return politica


async def publicar(
    db: AsyncSession,
    *,
    policy_type: str,
    version: str,
    body: str,
    checkbox_text: str | None = None,
    jurisdiction: str = "PE",
    locale: str = "es",
    published_by: str | None = None,
) -> PolicyVersion:
    """Publica una versión y cierra la anterior, EN LA MISMA TRANSACCIÓN.

    Las dos cosas juntas porque el momento intermedio —ninguna vigente, o dos—
    no puede existir: en el primero se bloquearían las compras, y en el segundo
    el servidor tendría que elegir. Es también lo que hace que el índice parcial
    no salte: se cierra antes de abrir.

    NO HACE `commit`: lo hace quien llama.
    """
    anterior = await vigente(
        db, policy_type=policy_type, jurisdiction=jurisdiction, locale=locale
    )
    momento = ahora()
    if anterior is not None:
        if anterior.version == version:
            # Republicar la misma versión no es publicar: es un reintento.
            return anterior
        anterior.effective_to = momento
        anterior.status = "superseded"
        await db.flush()

    nueva = PolicyVersion(
        policy_type=policy_type,
        jurisdiction=jurisdiction,
        locale=locale,
        version=version,
        body=body,
        body_sha256=huella(body),
        checkbox_text=checkbox_text,
        status="published",
        effective_from=momento,
        published_at=momento,
        published_by=published_by,
    )
    db.add(nueva)
    await db.flush()
    return nueva


async def sembrar_recompra(db: AsyncSession) -> PolicyVersion | None:
    """Mete en la base la política de recompra que hoy vive en el código.

    POR QUÉ SE SIEMBRA Y NO SE MIGRA A MANO. El texto está en
    `refunds/politica.py` con su versión y su huella, y las aceptaciones ya
    guardadas apuntan a esa versión. Sembrar la misma versión con el mismo texto
    hace que las dos cosas coincidan sin tocar ni una fila del historial: la
    tabla nueva describe lo que la constante ya decía.

    ES IDEMPOTENTE. Si ya está sembrada, no hace nada. No hace `commit`.

    LO QUE NO SE SIEMBRA: términos de compra ni privacidad. No hay texto
    aprobado y escribir uno provisional sería exactamente lo que no se debe
    hacer con un documento que alguien va a firmar.
    """
    from app.modules.refunds import politica as recompra

    if not await esquema.hay_gobernanza(db):
        return None
    ya = await db.scalar(
        select(PolicyVersion).where(
            PolicyVersion.policy_type == RECOMPRA,
            PolicyVersion.version == recompra.VERSION_ACTUAL,
            PolicyVersion.jurisdiction == "PE",
            PolicyVersion.locale == "es",
        )
    )
    if ya is not None:
        return ya
    return await publicar(
        db,
        policy_type=RECOMPRA,
        version=recompra.VERSION_ACTUAL,
        # La PLANTILLA, con su hueco `{fecha}` sin rellenar: es lo que define la
        # versión. Lo que se le enseña a cada persona lleva su fecha dentro, y
        # de ESO se guarda la huella en la aceptación.
        body=recompra.AVISO_DE_RECOMPRA,
        checkbox_text=recompra.CASILLA_DE_ACEPTACION,
    )
