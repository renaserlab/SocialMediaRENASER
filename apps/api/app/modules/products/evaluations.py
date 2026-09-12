"""La evaluación de una versión del producto. La matriz del blueprint §5.2.

LOS NÚMEROS ESTÁN TRANSCRITOS, NO INVENTADOS. Pesos 25/20/20/15/10/10 y los
umbrales 90 y 85 salen del blueprint; están en el código y no en variables de
entorno por la misma razón que las horas de garantía de Cursos: cambiarlos por
entorno alteraría decisiones ya tomadas. Y el peso se COPIA a cada fila al
puntuar, así que una decisión pasada siempre se puede explicar con sus números.

TRES REGLAS QUE HACEN QUE EL SELLO SIGNIFIQUE ALGO:

  1. NO SE DECIDE UNA APROBACIÓN CON DIMENSIONES SIN PUNTUAR. Una ausencia leída
     como cero hundiría a un producto bueno; leída como el máximo aprobaría uno
     que nadie miró. Faltan seis de seis o no se decide.
  2. CADA DIMENSIÓN PUNTUADA NECESITA EVIDENCIA. La columna «evidencia mínima»
     de la matriz no es una sugerencia: una puntuación sin nada detrás es una
     opinión con forma de número.
  3. UNA FALLA CRÍTICA RECHAZA, y no compensa con puntaje. Seguridad,
     falsificación, publicidad engañosa, procedencia no verificable, permisos
     faltantes o evidencia manipulada: el blueprint dice «rechazo directo», y la
     base lo impone con un CHECK además de esto.

Y NADIE EVALÚA SU PROPIO PRODUCTO. Se comprueba aquí y lo impone un disparador
de la 0071: entre leer quién es el responsable y escribir la evaluación cabe un
cambio de responsable, y un `insert` por otra vía no pasa por este código.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.modules.gobernanza import auditoria
from app.modules.products import esquema, permissions, service
from app.modules.products import states as maquina
from app.modules.products.models import (
    APROBADO,
    APROBADO_CON_CONDICIONES,
    BORRADOR,
    DECISION_APROBADO,
    DECISION_CONDICIONADO,
    DECISION_RECHAZADO,
    DIMENSIONES,
    EVALUACION,
    EVALUACION_BORRADOR,
    EVALUACION_DECIDIDA,
    FALLAS_CRITICAS,
    RAZONES_EXIGIDAS,
    TIPOS_DE_EVIDENCIA,
    Product,
    ProductApprovalReason,
    ProductEvaluation,
    ProductEvaluationEvidence,
    ProductEvaluationScore,
    ProductVersion,
)

logger = logging.getLogger("renaser.products")

#: Los umbrales del blueprint, EN CENTÉSIMAS DE PUNTO para no arrastrar
#: decimales: 9 000 son 90,00 y 8 500 son 85,00.
#:
#:   90–100  aprobado
#:   85–89   aprobado con condiciones
#:   < 85    no aprobado
APROBADO_DESDE = 9_000
CONDICIONADO_DESDE = 8_500

#: La suma de los pesos. Se comprueba al importar: una matriz que no sume 100
#: daría puntuaciones que no se pueden comparar entre productos.
PESO_TOTAL = sum(DIMENSIONES.values())
assert PESO_TOTAL == 100, f"la matriz suma {PESO_TOTAL}, no 100"

#: Desde dónde se puede abrir una evaluación. Antes de `document_review` no hay
#: nada revisado que evaluar.
EVALUABLES = (
    "document_review",
    "sample_requested",
    EVALUACION,
    APROBADO_CON_CONDICIONES,
)


def ahora() -> datetime:
    return datetime.now(timezone.utc)


class EvaluacionNoEncontrada(NotFoundError):
    code = "product_evaluation_not_found"


class EvaluacionCerrada(ConflictError):
    code = "product_evaluation_closed"


def decidir_por_puntuacion(total: int) -> str:
    """La decisión automática del blueprint. Una sola lectura, un solo sitio."""
    if total >= APROBADO_DESDE:
        return DECISION_APROBADO
    if total >= CONDICIONADO_DESDE:
        return DECISION_CONDICIONADO
    return DECISION_RECHAZADO


# --------------------------------------------------------------------------- #
# Abrir y puntuar
# --------------------------------------------------------------------------- #
async def abrir(
    db: AsyncSession, *, version_id: str, usuario_id: str
) -> ProductEvaluation:
    """Abre la evaluación de esa versión, o devuelve la que ya esté abierta.

    IDEMPOTENTE: un índice parcial de la 0071 admite una sola viva por versión,
    así que abrir dos veces devuelve la misma.
    """
    await permissions.exigir_evaluador(db, usuario_id)
    await esquema.exigir_admision(db)

    version = await db.get(ProductVersion, version_id)
    if version is None:
        raise EvaluacionNoEncontrada("Versión no encontrada.")
    producto = await db.get(Product, version.product_id)
    if producto is None:
        raise EvaluacionNoEncontrada("Producto no encontrado.")
    # ANTES QUE CUALQUIER OTRA COSA: ni un administrador evalúa lo suyo.
    await permissions.exigir_ajeno(db, producto=producto, user_id=usuario_id)

    if producto.status not in EVALUABLES:
        raise ConflictError(
            "Este producto no está en evaluación.",
            code="product_not_in_evaluation",
            details={"status": producto.status},
        )

    viva = await db.scalar(
        select(ProductEvaluation).where(
            ProductEvaluation.version_id == version_id,
            ProductEvaluation.status == EVALUACION_BORRADOR,
        )
    )
    if viva is not None:
        return viva

    evaluacion = ProductEvaluation(
        product_id=producto.id,
        version_id=version_id,
        evaluator_id=usuario_id,
        status=EVALUACION_BORRADOR,
    )
    db.add(evaluacion)
    await db.flush()
    return evaluacion


async def puntuar(
    db: AsyncSession,
    *,
    evaluacion_id: str,
    usuario_id: str,
    dimension: str,
    score: int,
    note: str | None = None,
) -> ProductEvaluationScore:
    """Puntúa una dimensión de 0 a 100. El peso se congela en la fila."""
    evaluacion = await _abierta(db, evaluacion_id, usuario_id)
    if dimension not in DIMENSIONES:
        raise ValidationAppError(
            "Esa dimensión no está en la matriz.",
            code="product_dimension_invalid",
            details={"allowed": list(DIMENSIONES)},
        )
    if isinstance(score, bool) or not isinstance(score, int) or not (0 <= score <= 100):
        raise ValidationAppError(
            "La puntuación va de 0 a 100.", code="product_score_out_of_range"
        )
    nota = (note or "").strip() or None
    if nota is not None and len(nota) > 2_000:
        raise ValidationAppError(
            "La nota es demasiado larga.", code="product_score_note_too_long"
        )

    fila = await db.get(ProductEvaluationScore, (evaluacion_id, dimension))
    if fila is None:
        fila = ProductEvaluationScore(
            evaluation_id=evaluacion_id,
            dimension=dimension,
            score=score,
            weight=DIMENSIONES[dimension],
            note=nota,
        )
        db.add(fila)
    else:
        fila.score = score
        fila.weight = DIMENSIONES[dimension]
        fila.note = nota
    evaluacion.updated_at = ahora()
    await db.flush()
    return fila


async def registrar_evidencia(
    db: AsyncSession,
    *,
    evaluacion_id: str,
    usuario_id: str,
    dimension: str,
    kind: str,
    summary: str,
    storage_path: str | None = None,
) -> ProductEvaluationEvidence:
    """Registra qué se miró. SOLO AÑADIR: una evidencia no se reescribe."""
    await _abierta(db, evaluacion_id, usuario_id)
    if dimension not in DIMENSIONES:
        raise ValidationAppError(
            "Esa dimensión no está en la matriz.",
            code="product_dimension_invalid",
            details={"allowed": list(DIMENSIONES)},
        )
    if kind not in TIPOS_DE_EVIDENCIA:
        raise ValidationAppError(
            "Ese tipo de evidencia no existe.",
            code="product_evidence_kind_invalid",
            details={"allowed": list(TIPOS_DE_EVIDENCIA)},
        )
    resumen = (summary or "").strip()
    if not (10 <= len(resumen) <= 1_000):
        raise ValidationAppError(
            "El resumen de la evidencia está fuera de lo posible.",
            code="product_evidence_summary_invalid",
            details={"min": 10, "max": 1_000},
        )
    ruta = (storage_path or "").strip() or None
    if ruta is not None and "://" in ruta:
        raise ValidationAppError(
            "Se guarda la ruta del almacenamiento, no una URL.",
            code="product_evidence_path_invalid",
        )
    fila = ProductEvaluationEvidence(
        evaluation_id=evaluacion_id,
        dimension=dimension,
        kind=kind,
        summary=resumen,
        storage_path=ruta,
        created_by=usuario_id,
    )
    db.add(fila)
    await db.flush()
    return fila


async def evidencia_de(
    db: AsyncSession, *, evaluacion_id: str
) -> list[ProductEvaluationEvidence]:
    return list(
        await db.scalars(
            select(ProductEvaluationEvidence)
            .where(ProductEvaluationEvidence.evaluation_id == evaluacion_id)
            .order_by(
                ProductEvaluationEvidence.dimension,
                ProductEvaluationEvidence.created_at,
            )
        )
    )


async def puntuaciones_de(
    db: AsyncSession, *, evaluacion_id: str
) -> list[ProductEvaluationScore]:
    return list(
        await db.scalars(
            select(ProductEvaluationScore)
            .where(ProductEvaluationScore.evaluation_id == evaluacion_id)
            .order_by(ProductEvaluationScore.dimension)
        )
    )


# --------------------------------------------------------------------------- #
# Las tres razones
# --------------------------------------------------------------------------- #
async def elegir_razones(
    db: AsyncSession, *, evaluacion_id: str, usuario_id: str, razones: list[dict]
) -> list[ProductApprovalReason]:
    """Las razones que leerá quien compra. CADA UNA SOBRE UNA EVIDENCIA.

    Se reemplazan enteras, así que mandar la misma lista dos veces deja lo
    mismo. Y una razón cuya evidencia no sea de ESTA evaluación se rechaza:
    apuntar a la evidencia de otro producto es exactamente cómo se acaba
    enseñando una razón que nadie comprobó aquí.
    """
    evaluacion = await _abierta(db, evaluacion_id, usuario_id)
    if len(razones) > RAZONES_EXIGIDAS:
        raise ValidationAppError(
            "Son tres razones, no más.",
            code="product_reasons_too_many",
            details={"max": RAZONES_EXIGIDAS},
        )

    mias = {
        e.id
        for e in await evidencia_de(db, evaluacion_id=evaluacion_id)
    }
    limpias: list[dict] = []
    for posicion, r in enumerate(razones, start=1):
        evidencia_id = str(r.get("evidence_id") or "").strip()
        texto = str(r.get("text") or "").strip()
        if evidencia_id not in mias:
            raise ValidationAppError(
                "Una razón de aprobación sale de la evidencia de esta evaluación.",
                code="product_reason_evidence_invalid",
            )
        if not (10 <= len(texto) <= 240):
            raise ValidationAppError(
                "El texto de una razón está fuera de lo posible.",
                code="product_reason_text_invalid",
                details={"min": 10, "max": 240},
            )
        limpias.append(
            {"evidence_id": evidencia_id, "text": texto, "position": posicion}
        )

    for fila in await db.scalars(
        select(ProductApprovalReason).where(
            ProductApprovalReason.version_id == evaluacion.version_id
        )
    ):
        await db.delete(fila)
    await db.flush()

    puestas: list[ProductApprovalReason] = []
    for r in limpias:
        fila = ProductApprovalReason(
            version_id=evaluacion.version_id,
            evaluation_id=evaluacion_id,
            created_by=usuario_id,
            **r,
        )
        db.add(fila)
        puestas.append(fila)
    await db.flush()
    return puestas


async def razones_de(
    db: AsyncSession, *, version_id: str
) -> list[ProductApprovalReason]:
    if not await esquema.hay_admision(db):
        return []
    return list(
        await db.scalars(
            select(ProductApprovalReason)
            .where(ProductApprovalReason.version_id == version_id)
            .order_by(ProductApprovalReason.position)
        )
    )


# --------------------------------------------------------------------------- #
# Decidir
# --------------------------------------------------------------------------- #
async def calcular(db: AsyncSession, *, evaluacion_id: str) -> int | None:
    """La puntuación ponderada, o `None` si falta alguna dimensión.

    `None` NO ES CERO. Quien lo lea tiene que pararse: una ausencia leída como
    cero hundiría a un producto bueno.
    """
    filas = await puntuaciones_de(db, evaluacion_id=evaluacion_id)
    if {f.dimension for f in filas} != set(DIMENSIONES):
        return None
    return sum(f.score * f.weight for f in filas)


async def por_que_no_se_decide(
    db: AsyncSession, *, evaluacion_id: str
) -> tuple[str, dict] | None:
    """Qué falta para poder aprobar. Devuelve un CÓDIGO, no una frase.

    UNA SOLA PUERTA. Repartir esto entre la ruta y la pantalla es cómo se
    aprueba algo sin evidencia el día que alguien añade un camino nuevo.
    """
    filas = await puntuaciones_de(db, evaluacion_id=evaluacion_id)
    puntuadas = {f.dimension for f in filas}
    faltan = sorted(set(DIMENSIONES) - puntuadas)
    if faltan:
        return "product_dimensions_missing", {"missing": faltan}

    por_dimension: dict[str, int] = {}
    for e in await evidencia_de(db, evaluacion_id=evaluacion_id):
        por_dimension[e.dimension] = por_dimension.get(e.dimension, 0) + 1
    sin_evidencia = sorted(d for d in DIMENSIONES if not por_dimension.get(d))
    if sin_evidencia:
        return "product_evidence_missing", {"dimensions": sin_evidencia}
    return None


async def decidir(
    db: AsyncSession,
    *,
    evaluacion_id: str,
    usuario_id: str,
    critical_failure: str | None = None,
    notes: str | None = None,
) -> ProductEvaluation:
    """Cierra la evaluación y mueve el producto. LA DECISIÓN LA DA LA MATRIZ.

    Quien evalúa puntúa y registra evidencia; qué significa esa puntuación lo
    dice el blueprint, no quien pulsa. Lo único que se decide a mano es si hay
    una falla crítica, y eso solo puede acabar en rechazo.
    """
    evaluacion = await _abierta(db, evaluacion_id, usuario_id)
    producto = await db.get(Product, evaluacion.product_id)
    if producto is None:  # pragma: no cover - la FK lo impide
        raise EvaluacionNoEncontrada("Producto no encontrado.")
    await permissions.exigir_ajeno(db, producto=producto, user_id=usuario_id)

    falla = (critical_failure or "").strip() or None
    if falla is not None and falla not in FALLAS_CRITICAS:
        raise ValidationAppError(
            "Esa falla crítica no existe.",
            code="product_critical_failure_invalid",
            details={"allowed": list(FALLAS_CRITICAS)},
        )

    total: int | None = None
    if falla is not None:
        # RECHAZO DIRECTO, SIN COMPENSACIÓN POR PUNTAJE. No se exige la matriz
        # completa: una falsificación no necesita seis notas para rechazarse.
        decision = DECISION_RECHAZADO
    else:
        falta = await por_que_no_se_decide(db, evaluacion_id=evaluacion_id)
        if falta is not None:
            codigo, detalles = falta
            raise ConflictError(
                "Esta evaluación todavía no se puede decidir.",
                code=codigo,
                details=detalles,
            )
        total = await calcular(db, evaluacion_id=evaluacion_id)
        decision = decidir_por_puntuacion(int(total or 0))

    momento = ahora()
    async with db.begin_nested() as punto:
        cambiadas = await db.execute(
            update(ProductEvaluation)
            .where(
                ProductEvaluation.id == evaluacion_id,
                ProductEvaluation.status == EVALUACION_BORRADOR,
            )
            .values(
                status=EVALUACION_DECIDIDA,
                decision=decision,
                score_total=total,
                critical_failure=falla,
                notes=(notes or "").strip() or None,
                decided_at=momento,
                updated_at=momento,
            )
        )
        if cambiadas.rowcount != 1:
            await punto.rollback()
    if cambiadas.rowcount != 1:
        raise EvaluacionCerrada(
            "Alguien cerró esta evaluación mientras decidías.",
            details={"expected": EVALUACION_BORRADOR},
        )
    await db.refresh(evaluacion)

    # EL PRODUCTO SE MUEVE SOLO, Y LO MUEVE EL SISTEMA. Que esté aprobado es
    # consecuencia de una puntuación con evidencia, no de que alguien pulse.
    destino = {
        DECISION_APROBADO: APROBADO,
        DECISION_CONDICIONADO: APROBADO_CON_CONDICIONES,
        DECISION_RECHAZADO: BORRADOR,
    }[decision]
    if producto.status != EVALUACION:
        # Si estaba en revisión documental o esperando muestra, primero entra en
        # evaluación: saltarse el paso dejaría el historial sin decir cuándo
        # empezó a evaluarse.
        await service.transicionar(
            db,
            producto_id=producto.id,
            hasta=EVALUACION,
            actor_id=usuario_id,
            actor_rol=maquina.EVALUADOR,
        )
    await service.transicionar(
        db,
        producto_id=producto.id,
        hasta=destino,
        actor_id=usuario_id,
        actor_rol=maquina.SISTEMA,
        motivo=falla or decision,
    )

    await auditoria.anotar(
        db,
        actor_id=usuario_id,
        action="product.evaluation.decide",
        entity_type="product_evaluation",
        entity_id=evaluacion_id,
        actor_role="admin",
        previous_state=EVALUACION_BORRADOR,
        new_state=EVALUACION_DECIDIDA,
        payload={
            "product_id": producto.id,
            "version_id": evaluacion.version_id,
            "decision": decision,
            "score_total": total,
            "critical_failure": falla,
        },
    )
    logger.info(
        "[productos] evaluacion %s decidida: %s (puntuacion=%s falla=%s)",
        evaluacion_id,
        decision,
        total,
        falla,
    )
    return evaluacion


async def bandeja(
    db: AsyncSession, *, estado: str | None = None, limite: int = 50
) -> list[ProductEvaluation]:
    if not await esquema.hay_admision(db):
        return []
    consulta = select(ProductEvaluation)
    if estado:
        consulta = consulta.where(ProductEvaluation.status == estado)
    return list(
        await db.scalars(
            consulta.order_by(
                ProductEvaluation.created_at.desc(), ProductEvaluation.id.desc()
            ).limit(max(1, min(int(limite), 200)))
        )
    )


async def de_la_version(
    db: AsyncSession, *, version_id: str
) -> list[ProductEvaluation]:
    if not await esquema.hay_admision(db):
        return []
    return list(
        await db.scalars(
            select(ProductEvaluation)
            .where(ProductEvaluation.version_id == version_id)
            .order_by(ProductEvaluation.created_at.desc())
        )
    )


async def _abierta(
    db: AsyncSession, evaluacion_id: str, usuario_id: str
) -> ProductEvaluation:
    """La evaluación abierta, comprobando el permiso. Cerrada no se toca."""
    await permissions.exigir_evaluador(db, usuario_id)
    await esquema.exigir_admision(db)
    evaluacion = await db.get(ProductEvaluation, evaluacion_id)
    if evaluacion is None:
        raise EvaluacionNoEncontrada("Evaluación no encontrada.")
    if evaluacion.status != EVALUACION_BORRADOR:
        raise EvaluacionCerrada(
            "Esta evaluación ya está decidida y no se reescribe.",
            details={"status": evaluacion.status},
        )
    return evaluacion


async def cuantas_aprobadas(db: AsyncSession, *, version_id: str) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(ProductEvaluation)
            .where(
                ProductEvaluation.version_id == version_id,
                ProductEvaluation.status == EVALUACION_DECIDIDA,
                ProductEvaluation.decision == DECISION_APROBADO,
            )
        )
        or 0
    )


__all__ = [
    "APROBADO_DESDE",
    "CONDICIONADO_DESDE",
    "EVALUABLES",
    "EvaluacionCerrada",
    "EvaluacionNoEncontrada",
    "PESO_TOTAL",
    "abrir",
    "bandeja",
    "calcular",
    "cuantas_aprobadas",
    "de_la_version",
    "decidir",
    "decidir_por_puntuacion",
    "elegir_razones",
    "evidencia_de",
    "por_que_no_se_decide",
    "puntuaciones_de",
    "puntuar",
    "razones_de",
    "registrar_evidencia",
]
