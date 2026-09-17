"""Incremento 2 de Productos: admisión y evaluación.

LO QUE DEFIENDEN ESTAS PRUEBAS, y es lo que hace que el sello signifique algo:

  1. NADIE EVALÚA NI DECIDE LO SUYO. Ni siendo administrador, y lo impone
     además un disparador de la 0071: un `insert` por otra vía no pasa por el
     código.
  2. NINGUNA PUNTUACIÓN SIN LAS SEIS DIMENSIONES. Una ausencia leída como cero
     hundiría a un producto bueno; leída como el máximo aprobaría uno que nadie
     miró. `calcular` devuelve `None`, y `None` no es cero.
  3. NINGUNA DIMENSIÓN SIN EVIDENCIA. La columna «evidencia mínima» de la matriz
     no es una sugerencia.
  4. NINGUNA RAZÓN DE APROBACIÓN SIN EVIDENCIA. `evidence_id` es NOT NULL, y la
     evidencia tiene que ser de ESA evaluación.
  5. UNA FALLA CRÍTICA RECHAZA y no compensa con puntaje.
  6. LA MATRIZ ES LA DEL BLUEPRINT, letra por letra, y los pesos se congelan.
  7. MODERAR CONTENIDO NO ES PUBLICAR. Curaduría puntúa; administración decide.
  8. UN RECHAZO SIN MOTIVO no se le puede enseñar a nadie.
"""

from __future__ import annotations

import uuid

import psycopg
import pytest
from sqlalchemy import func, select

from app.core.exceptions import AppError, ForbiddenError
from app.modules.products import applications, evaluations, permissions, service
from app.modules.products import states as maquina
from app.modules.products.models import (
    APROBADO,
    APROBADO_CON_CONDICIONES,
    BORRADOR,
    DECISION_APROBADO,
    DECISION_CONDICIONADO,
    DECISION_RECHAZADO,
    DIMENSIONES,
    ENVIADO,
    EVALUACION,
    EVALUACION_DECIDIDA,
    POSTULACION_ACEPTADA,
    POSTULACION_ENVIADA,
    POSTULACION_RECHAZADA,
    PUBLICADO,
    RAZONES_EXIGIDAS,
    VENDEDOR_ACTIVO,
    Product,
    ProductApprovalReason,
    ProductEvaluation,
    ProductSeller,
    SellerApplication,
)
from tests.test_productos_dominio import (  # noqa: F401
    DATOS,
    foto_aprobada,
    SIN_POSTGRES,
    URL,
    VARIANTES,
    base_aplicada,
    categoria,
    persona,
    producto_en_borrador,
    sesiones,
    vendedor,
)

PROPUESTA = (
    "Fabrico cuchillos forjados a mano en un taller familiar, con acero "
    "trazable por lote y garantía de por vida en el filo."
)


# =========================================================================== #
# Ayudantes
# =========================================================================== #
async def postular(sesiones, quien: str, *, enviar=True) -> str:
    async with sesiones() as db:
        postulacion = await applications.guardar(
            db,
            usuario_id=quien,
            display_name="Taller Andino",
            proposal=PROPUESTA,
            documentos=[
                {"kind": "identity", "note": "DNI presentado en persona"},
                {"kind": "manufacturer", "note": "Taller propio, Cusco"},
            ],
        )
        await db.commit()
        ident = postulacion.id
    if enviar:
        async with sesiones() as db:
            await applications.enviar(db, postulacion_id=ident, usuario_id=quien)
            await db.commit()
    return ident


async def hasta_evaluacion(sesiones, dueno: str, evaluador: str) -> tuple[str, str]:
    """Un producto listo para evaluar, por el camino de la máquina."""
    producto_id, version_id = await producto_en_borrador(sesiones, dueno)
    async with sesiones() as db:
        for hasta, rol in (
            (ENVIADO, maquina.PROVEEDOR),
            ("document_review", maquina.EVALUADOR),
            (EVALUACION, maquina.EVALUADOR),
        ):
            await service.transicionar(
                db,
                producto_id=producto_id,
                hasta=hasta,
                actor_id=evaluador,
                actor_rol=rol,
            )
        await db.commit()
    return producto_id, version_id


async def evaluar_completo(
    sesiones, version_id: str, evaluador: str, *, nota=95
) -> str:
    """Puntúa las seis dimensiones con una evidencia cada una."""
    async with sesiones() as db:
        evaluacion = await evaluations.abrir(
            db, version_id=version_id, usuario_id=evaluador
        )
        ident = evaluacion.id
        for dimension in DIMENSIONES:
            await evaluations.puntuar(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension=dimension,
                score=nota,
            )
            await evaluations.registrar_evidencia(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension=dimension,
                kind="inspection",
                summary=f"Se inspeccionó {dimension} con el producto en mano.",
            )
        await db.commit()
    return ident


# =========================================================================== #
# La postulación
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_aceptar_una_postulacion_crea_la_capacidad_comercial(sesiones) -> None:
    """UNA ACEPTADA SIN `product_sellers` sería una persona a la que se le dijo
    que sí y que no puede postular nada. Van en la misma transacción."""
    quien = await persona(sesiones, "prov")
    admin = await persona(sesiones, "adm", rol="admin")
    postulacion_id = await postular(sesiones, quien)

    async with sesiones() as db:
        assert await permissions.vendedor_de(db, quien) is None

    async with sesiones() as db:
        postulacion, vendedor_nuevo = await applications.decidir(
            db,
            postulacion_id=postulacion_id,
            usuario_id=admin,
            aceptar=True,
            motivo="cumple el estándar documental",
        )
        await db.commit()
    assert postulacion.status == POSTULACION_ACEPTADA
    assert vendedor_nuevo is not None
    assert vendedor_nuevo.status == VENDEDOR_ACTIVO
    assert vendedor_nuevo.activated_at is not None
    assert vendedor_nuevo.activated_by == admin
    # EL NOMBRE CON EL QUE FIRMA se copia de lo que pidió.
    assert vendedor_nuevo.display_name == "Taller Andino"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_rechazo_sin_motivo_no_existe(sesiones) -> None:
    """UN «NO» QUE NO SE LE PUEDE ENSEÑAR A LA PERSONA no es una decisión.

    Lo exige el código y también un CHECK de la 0071.
    """
    quien = await persona(sesiones, "prov")
    admin = await persona(sesiones, "adm", rol="admin")
    postulacion_id = await postular(sesiones, quien)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await applications.decidir(
                db,
                postulacion_id=postulacion_id,
                usuario_id=admin,
                aceptar=False,
            )
    assert fallo.value.code == "seller_application_reject_needs_reason"

    # Y la base lo impone por su cuenta.
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                "update public.seller_applications set status = 'rejected',"
                " decided_at = now(), decision_reason = null"
                " where id = cast(%s as uuid)",
                (postulacion_id,),
            )

    async with sesiones() as db:
        postulacion, _ = await applications.decidir(
            db,
            postulacion_id=postulacion_id,
            usuario_id=admin,
            aceptar=False,
            motivo="el lote no es trazable",
        )
        await db.commit()
    assert postulacion.status == POSTULACION_RECHAZADA
    assert postulacion.decision_reason == "el lote no es trazable"
    # Y NO se le concedió capacidad comercial.
    async with sesiones() as db:
        assert await permissions.vendedor_de(db, quien) is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_decide_su_propia_postulacion(sesiones) -> None:
    """NI SIENDO ADMINISTRADOR. Se comprueba antes que el rol."""
    quien = await persona(sesiones, "adm", rol="admin")
    postulacion_id = await postular(sesiones, quien)
    async with sesiones() as db:
        with pytest.raises(ForbiddenError) as fallo:
            await applications.decidir(
                db,
                postulacion_id=postulacion_id,
                usuario_id=quien,
                aceptar=True,
            )
    assert fallo.value.code == "seller_application_self_review_forbidden"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_postulacion_viva_por_perfil(sesiones) -> None:
    """DOS ABIERTAS DE LA MISMA PERSONA son dos respuestas posibles a la misma
    pregunta. Lo impone un índice parcial de la 0071."""
    quien = await persona(sesiones, "prov")
    await postular(sesiones, quien, enviar=False)
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.UniqueViolation):
            cur.execute(
                "insert into public.seller_applications (profile_id, display_name,"
                " proposal) values (cast(%s as uuid), 'Otro nombre', %s)",
                (quien, PROPUESTA),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_enviada_ya_no_se_reescribe(sesiones) -> None:
    """CAMBIARLA A MITAD haría que se decidiera sobre algo distinto de lo que se
    leyó."""
    quien = await persona(sesiones, "prov")
    await postular(sesiones, quien)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await applications.guardar(
                db,
                usuario_id=quien,
                display_name="Nombre cambiado",
                proposal=PROPUESTA,
            )
    assert fallo.value.code == "seller_application_not_editable"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_guardar_reemplaza_los_documentos_y_no_los_acumula(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    for _ in range(2):
        await postular(sesiones, quien, enviar=False)
    async with sesiones() as db:
        postulacion = await applications.mia(db, usuario_id=quien)
        documentos = await applications.documentos_de(
            db, postulacion_id=postulacion.id
        )
    assert len(documentos) == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_documento_vacio_no_es_un_documento(sesiones) -> None:
    """NI UNA RUTA NI UNA NOTA: entonces no se presentó nada."""
    quien = await persona(sesiones, "prov")
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await applications.guardar(
                db,
                usuario_id=quien,
                display_name="Taller",
                proposal=PROPUESTA,
                documentos=[{"kind": "identity"}],
            )
    assert fallo.value.code == "seller_application_document_empty"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_tomar_dos_veces_la_misma_postulacion(sesiones) -> None:
    """UPDATE CONDICIONAL: dos revisores, una fila cambiada y otra cero."""
    quien = await persona(sesiones, "prov")
    uno = await persona(sesiones, "adm1", rol="admin")
    dos = await persona(sesiones, "adm2", rol="admin")
    postulacion_id = await postular(sesiones, quien)

    async with sesiones() as db:
        await applications.tomar(
            db, postulacion_id=postulacion_id, usuario_id=uno
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await applications.tomar(
                db, postulacion_id=postulacion_id, usuario_id=dos
            )
    assert fallo.value.code == "seller_application_not_editable"


# =========================================================================== #
# La matriz
# =========================================================================== #
def test_la_matriz_es_la_del_blueprint() -> None:
    """PESOS 25/20/20/15/10/10 y umbrales 90 y 85. Transcritos, no inventados.

    Si no sumaran 100, las puntuaciones no se podrían comparar entre productos.
    """
    assert DIMENSIONES == {
        "quality": 25,
        "design": 20,
        "usefulness": 20,
        "durability": 15,
        "origin": 10,
        "warranty": 10,
    }
    assert sum(DIMENSIONES.values()) == 100
    assert evaluations.PESO_TOTAL == 100
    # EN CENTÉSIMAS DE PUNTO: 9 000 son 90,00 y 8 500 son 85,00.
    assert evaluations.APROBADO_DESDE == 9_000
    assert evaluations.CONDICIONADO_DESDE == 8_500


def test_la_decision_automatica_no_tiene_zonas_grises() -> None:
    """LA FRONTERA, EXACTA. 8 999 es condicionado y 9 000 es aprobado."""
    d = evaluations.decidir_por_puntuacion
    assert d(10_000) == DECISION_APROBADO
    assert d(9_000) == DECISION_APROBADO
    assert d(8_999) == DECISION_CONDICIONADO
    assert d(8_500) == DECISION_CONDICIONADO
    assert d(8_499) == DECISION_RECHAZADO
    assert d(0) == DECISION_RECHAZADO


# =========================================================================== #
# Evaluar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_evalua_su_propio_producto(sesiones) -> None:
    """DOS CAPAS, y las dos hacen falta.

    El código lo comprueba; el disparador de la 0071 lo impone incluso para un
    `insert` que no pase por aquí —un script, la consola de la base—.
    """
    quien = await persona(sesiones, "adm", rol="admin")
    await vendedor(sesiones, quien)
    otro = await persona(sesiones, "adm2", rol="admin")
    producto_id, version_id = await hasta_evaluacion(sesiones, quien, otro)

    async with sesiones() as db:
        with pytest.raises(permissions.EsTuPropioProducto) as fallo:
            await evaluations.abrir(
                db, version_id=version_id, usuario_id=quien
            )
    assert fallo.value.code == "product_self_review_forbidden"

    # Y LA BASE, por su cuenta.
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "insert into public.product_evaluations (product_id, version_id,"
                " evaluator_id) values (cast(%s as uuid), cast(%s as uuid),"
                " cast(%s as uuid))",
                (producto_id, version_id, quien),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_aprueba_con_dimensiones_sin_puntuar(sesiones) -> None:
    """`None` NO ES CERO.

    Una ausencia leída como cero hundiría a un producto bueno; leída como el
    máximo aprobaría uno que nadie miró.
    """
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    _, version_id = await hasta_evaluacion(sesiones, quien, evaluador)

    async with sesiones() as db:
        evaluacion = await evaluations.abrir(
            db, version_id=version_id, usuario_id=evaluador
        )
        ident = evaluacion.id
        # Cinco de seis, todas perfectas.
        for dimension in list(DIMENSIONES)[:5]:
            await evaluations.puntuar(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension=dimension,
                score=100,
            )
            await evaluations.registrar_evidencia(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension=dimension,
                kind="inspection",
                summary="Se inspeccionó el producto en mano, sin defectos.",
            )
        await db.commit()

    async with sesiones() as db:
        assert await evaluations.calcular(db, evaluacion_id=ident) is None
        falta = await evaluations.por_que_no_se_decide(db, evaluacion_id=ident)
        assert falta is not None
        assert falta[0] == "product_dimensions_missing"
        assert falta[1]["missing"] == ["warranty"]
        with pytest.raises(AppError) as fallo:
            await evaluations.decidir(
                db, evaluacion_id=ident, usuario_id=evaluador
            )
    assert fallo.value.code == "product_dimensions_missing"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_dimension_sin_evidencia_no_se_puede_decidir(sesiones) -> None:
    """UNA PUNTUACIÓN SIN NADA DETRÁS es una opinión con forma de número."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    _, version_id = await hasta_evaluacion(sesiones, quien, evaluador)

    async with sesiones() as db:
        evaluacion = await evaluations.abrir(
            db, version_id=version_id, usuario_id=evaluador
        )
        ident = evaluacion.id
        for i, dimension in enumerate(DIMENSIONES):
            await evaluations.puntuar(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension=dimension,
                score=95,
            )
            if i == 0:
                continue  # la primera se queda SIN evidencia
            await evaluations.registrar_evidencia(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension=dimension,
                kind="inspection",
                summary="Se inspeccionó el producto en mano, sin defectos.",
            )
        await db.commit()

    async with sesiones() as db:
        # LA PUNTUACIÓN SÍ SE CALCULA —están las seis— pero no se puede decidir.
        assert await evaluations.calcular(db, evaluacion_id=ident) == 9_500
        falta = await evaluations.por_que_no_se_decide(db, evaluacion_id=ident)
        assert falta is not None
        assert falta[0] == "product_evidence_missing"
        assert falta[1]["dimensions"] == ["quality"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_evaluacion_completa_aprueba_y_mueve_el_producto(sesiones) -> None:
    """QUE ESTÉ APROBADO ES CONSECUENCIA DE LA PUNTUACIÓN, no de pulsar.

    Lo mueve el SISTEMA, y el peso de cada dimensión queda congelado en su fila.
    """
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    producto_id, version_id = await hasta_evaluacion(sesiones, quien, evaluador)
    ident = await evaluar_completo(sesiones, version_id, evaluador, nota=95)

    async with sesiones() as db:
        evaluacion = await evaluations.decidir(
            db, evaluacion_id=ident, usuario_id=evaluador
        )
        await db.commit()
    assert evaluacion.status == EVALUACION_DECIDIDA
    assert evaluacion.decision == DECISION_APROBADO
    assert evaluacion.score_total == 9_500
    assert evaluacion.critical_failure is None

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        assert producto.status == APROBADO
        pesos = {
            s.dimension: s.weight
            for s in await evaluations.puntuaciones_de(db, evaluacion_id=ident)
        }
    assert pesos == DIMENSIONES


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_85_queda_condicionado_y_no_publica(sesiones) -> None:
    """LAS CONDICIONES EXACTAS no las ha definido la empresa, así que un
    condicionado no puede publicar. Falla en cerrado."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    producto_id, version_id = await hasta_evaluacion(sesiones, quien, evaluador)
    ident = await evaluar_completo(sesiones, version_id, evaluador, nota=86)

    async with sesiones() as db:
        evaluacion = await evaluations.decidir(
            db, evaluacion_id=ident, usuario_id=evaluador
        )
        await db.commit()
    assert evaluacion.decision == DECISION_CONDICIONADO

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        assert producto.status == APROBADO_CON_CONDICIONES
        falta = await service.por_que_no_se_publica(db, producto=producto)
        assert falta is not None and falta[0] == "product_not_approved"
        with pytest.raises(AppError) as fallo:
            await service.publicar(
                db, producto_id=producto_id, usuario_id=evaluador
            )
    assert fallo.value.code == "product_not_approved"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_falla_critica_rechaza_aunque_la_puntuacion_sea_perfecta(
    sesiones,
) -> None:
    """RECHAZO DIRECTO, SIN COMPENSACIÓN POR PUNTAJE (blueprint §5.2).

    Y no hace falta la matriz completa: una falsificación no necesita seis notas.
    """
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    producto_id, version_id = await hasta_evaluacion(sesiones, quien, evaluador)
    ident = await evaluar_completo(sesiones, version_id, evaluador, nota=100)

    async with sesiones() as db:
        evaluacion = await evaluations.decidir(
            db,
            evaluacion_id=ident,
            usuario_id=evaluador,
            critical_failure="counterfeit",
        )
        await db.commit()
    assert evaluacion.decision == DECISION_RECHAZADO
    assert evaluacion.critical_failure == "counterfeit"
    # NO SE GUARDA PUNTUACIÓN: la decisión no salió de ella.
    assert evaluacion.score_total is None

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
    # VUELVE A BORRADOR: la cadena no tiene «rechazado», y dejarlo parado en
    # evaluación sería un producto atascado para siempre.
    assert producto.status == BORRADOR

    # Y LA BASE NO ADMITE una falla crítica con «aprobado».
    #
    # SE EXIGE EL NOMBRE DEL CHECK. Sin eso la prueba se contentaba con
    # cualquier violación, y al retirar el que importa saltaba el de «aprobar
    # exige puntuación»: verde por el motivo equivocado. La puntuación se
    # rellena justo para que ese otro no pueda disparar.
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation) as violado:
            cur.execute(
                "update public.product_evaluations set decision = 'approved',"
                " score_total = 10000 where id = cast(%s as uuid)",
                (ident,),
            )
    assert "product_evaluations_falla_rechaza" in str(violado.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_evaluacion_decidida_no_se_reescribe(sesiones) -> None:
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    _, version_id = await hasta_evaluacion(sesiones, quien, evaluador)
    ident = await evaluar_completo(sesiones, version_id, evaluador)
    async with sesiones() as db:
        await evaluations.decidir(db, evaluacion_id=ident, usuario_id=evaluador)
        await db.commit()

    async with sesiones() as db:
        for accion in (
            evaluations.puntuar(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension="quality",
                score=10,
            ),
            evaluations.registrar_evidencia(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                dimension="quality",
                kind="inspection",
                summary="Se vuelve a mirar después de decidir.",
            ),
        ):
            with pytest.raises(evaluations.EvaluacionCerrada):
                await accion


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_moderar_contenido_no_publica(sesiones) -> None:
    """CURADURÍA PUNTÚA, ADMINISTRACIÓN DECIDE. El patrón de eventos (D34).

    Un `moderator` puede evaluar; poner el sello de Z en el catálogo es otra
    cosa. Y ningún permiso financiero por herencia.
    """
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    moderador = await persona(sesiones, "mod", rol="moderator")

    async with sesiones() as db:
        assert await permissions.puede_evaluar(db, moderador) is True
        assert await permissions.puede_publicar(db, moderador) is False
        with pytest.raises(AppError) as fallo:
            await permissions.exigir_publicador(db, moderador)
    assert fallo.value.code == "product_publish_forbidden"


# =========================================================================== #
# Las tres razones
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_razon_sin_evidencia_no_existe(sesiones) -> None:
    """`evidence_id` ES NOT NULL, y la evidencia tiene que ser de ESTA
    evaluación: apuntar a la de otro producto es cómo se acaba enseñando una
    razón que nadie comprobó aquí."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    _, version_id = await hasta_evaluacion(sesiones, quien, evaluador)
    ident = await evaluar_completo(sesiones, version_id, evaluador)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await evaluations.elegir_razones(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                razones=[
                    {
                        "evidence_id": str(uuid.uuid4()),
                        "text": "Una razón inventada que nadie comprobó.",
                    }
                ],
            )
    assert fallo.value.code == "product_reason_evidence_invalid"

    # Y LA BASE tampoco admite una razón sin evidencia.
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.NotNullViolation):
            cur.execute(
                "insert into public.product_approval_reasons (version_id,"
                " evaluation_id, evidence_id, text, position) values"
                " (cast(%s as uuid), cast(%s as uuid), null, 'Sin respaldo', 1)",
                (version_id, ident),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_son_tres_razones_ni_dos_ni_cuatro(sesiones) -> None:
    """DOS Y UN HUECO es una promesa a medias; cuatro es un informe."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    producto_id, version_id = await hasta_evaluacion(sesiones, quien, evaluador)
    ident = await evaluar_completo(sesiones, version_id, evaluador)

    async with sesiones() as db:
        evidencias = [
            e.id for e in await evaluations.evidencia_de(db, evaluacion_id=ident)
        ]

    # CUATRO no se admiten.
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await evaluations.elegir_razones(
                db,
                evaluacion_id=ident,
                usuario_id=evaluador,
                razones=[
                    {"evidence_id": e, "text": f"Razón respaldada número {i}."}
                    for i, e in enumerate(evidencias[:4])
                ],
            )
    assert fallo.value.code == "product_reasons_too_many"

    # DOS se guardan —un borrador a medias es normal— pero NO se publica.
    async with sesiones() as db:
        await evaluations.elegir_razones(
            db,
            evaluacion_id=ident,
            usuario_id=evaluador,
            razones=[
                {"evidence_id": e, "text": f"Razón respaldada número {i}."}
                for i, e in enumerate(evidencias[:2])
            ],
        )
        await evaluations.decidir(db, evaluacion_id=ident, usuario_id=evaluador)
        await db.commit()

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        falta = await service.por_que_no_se_publica(db, producto=producto)
        assert falta is not None
        assert falta[0] == "product_reasons_required"
        assert falta[1] == {"expected": RAZONES_EXIGIDAS, "found": 2}

    # Y LA POSICIÓN va de 1 a 3: la base no admite una cuarta.
    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                "insert into public.product_approval_reasons (version_id,"
                " evaluation_id, evidence_id, text, position) values"
                " (cast(%s as uuid), cast(%s as uuid), cast(%s as uuid),"
                " 'Una cuarta razón que no cabe', 4)",
                (version_id, ident, evidencias[0]),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_tres_razones_y_evaluacion_aprobada_se_publica(sesiones) -> None:
    """EL CAMINO COMPLETO: proveedor postula, Z evalúa, Z publica.

    Y al publicar, la versión se congela con su huella y el producto entra en
    catálogo. Nada de esto habilita comprar: `purchasable` sigue siendo falso.
    """
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    producto_id, version_id = await hasta_evaluacion(sesiones, quien, evaluador)
    ident = await evaluar_completo(sesiones, version_id, evaluador, nota=97)

    async with sesiones() as db:
        evidencias = [
            e.id for e in await evaluations.evidencia_de(db, evaluacion_id=ident)
        ]
        await evaluations.elegir_razones(
            db,
            evaluacion_id=ident,
            usuario_id=evaluador,
            razones=[
                {"evidence_id": e, "text": f"Razón respaldada número {i}."}
                for i, e in enumerate(evidencias[:3])
            ],
        )
        await evaluations.decidir(db, evaluacion_id=ident, usuario_id=evaluador)
        await db.commit()

    async with sesiones() as db:
        producto = await db.get(Product, producto_id)
        assert producto.status == APROBADO
        assert await service.por_que_no_se_publica(db, producto=producto) is None
        producto, version = await service.publicar(
            db, producto_id=producto_id, usuario_id=evaluador
        )
        await db.commit()

    assert producto.status == PUBLICADO
    assert producto.published_version_id == version.id
    assert producto.published_at is not None
    assert version.status == "published"
    assert version.published_by == evaluador
    assert version.effective_to is None
    assert version.content_sha256 == service.huella(DATOS, variantes=VARIANTES)

    async with sesiones() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(ProductApprovalReason)
                .where(ProductApprovalReason.version_id == version.id)
            )
        ) == RAZONES_EXIGIDAS


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_abrir_dos_veces_la_evaluacion_devuelve_la_misma(sesiones) -> None:
    """IDEMPOTENTE. Un índice parcial de la 0071 admite una sola viva por
    versión, así que abrir dos veces no crea dos veredictos."""
    quien = await persona(sesiones, "prov")
    await vendedor(sesiones, quien)
    evaluador = await persona(sesiones, "adm", rol="admin")
    _, version_id = await hasta_evaluacion(sesiones, quien, evaluador)

    async with sesiones() as db:
        una = await evaluations.abrir(
            db, version_id=version_id, usuario_id=evaluador
        )
        await db.commit()
    async with sesiones() as db:
        otra = await evaluations.abrir(
            db, version_id=version_id, usuario_id=evaluador
        )
        await db.commit()
    assert una.id == otra.id

    async with sesiones() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(ProductEvaluation)
                .where(ProductEvaluation.version_id == version_id)
            )
        ) == 1
