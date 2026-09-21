"""El ciclo de una incidencia. Lógica pura, sin base de datos y sin FastAPI.

QUÉ ES UNA INCIDENCIA Y QUÉ NO. Es que algo llegó mal: dañado, incorrecto,
incompleto, que no funciona, que no es lo que se describía, que se sospecha
falsificado, o que directamente no llegó. **«Ya no lo quiero» NO es una
incidencia**: eso es desistimiento, lo dice el blueprint §10 con esas palabras,
y tiene plazos y consecuencias distintas. Por eso no está en la lista.

LA CUARTA MÁQUINA, Y SIGUE SIENDO SUYA. Pedido, pago, envío e incidencia son
cuatro cosas que cambian por su cuenta. Abrir una incidencia no despaga un
pedido ni devuelve un paquete al almacén: solo anota que hay un caso.

LO QUE ESTA MÁQUINA IMPIDE, Y ES EL PUNTO:

  1. ABRIR NO ES APROBAR. `OPEN` significa «alguien dice que algo llegó mal»,
     nada más. No hay ningún salto que lleve de abrir a un reembolso.
  2. EL PROVEEDOR PROPONE; RESOLVER ES DE Z. Las seis salidas del blueprint
     mueven dinero, mueven mercancía o niegan la reclamación, y ninguna de las
     tres puede decidirla en solitario quien tiene el conflicto. El proveedor
     contesta con una PROPUESTA; la resolución la registra administración.
  3. RESOLVER NO ES PAGAR. Una resolución dice qué se decidió, no que el dinero
     se haya movido: eso es del Incremento 9 y no existe. El efecto financiero
     nace pendiente y nadie lo ejecuta.
  4. EL SILENCIO NO CIERRA NADA. Si el proveedor no contesta en su plazo, el
     caso pasa a mediación, no a «rechazado» ni a «aceptado».
  5. UNA SOLA APELACIÓN, y solo con evidencia nueva. Lo dice el blueprint §10.1,
     y sin la condición de la evidencia una apelación sería repetir la misma
     frase más alto.

LOS PLAZOS QUE SÍ ESTÁN Y EL QUE NO:

  * LAS 48 HORAS DEL PROVEEDOR son del blueprint, exactas y sin ambigüedad: se
    transcriben, igual que se transcribieron los pesos de la matriz de
    evaluación. No son una decisión que estemos tomando por nadie.
  * LOS «TRES DÍAS HÁBILES» DE Z NO SE PUEDEN CALCULAR. «Hábil» depende de un
    calendario de festivos que nadie ha definido, y la empresa no ha dicho de
    qué país. Así que **no se calcula ninguna fecha límite para la decisión de
    Z**: el caso se enseña «en revisión» y punto. Inventarse el calendario sería
    prometer una fecha que no podemos cumplir ni medir.
"""

from __future__ import annotations

from app.core.exceptions import AppError

# --------------------------------------------------------------------------- #
# Los motivos. CERRADOS: lo dice el blueprint §10.
# --------------------------------------------------------------------------- #
DANADO = "DAMAGED"
NO_COMO_SE_DESCRIBE = "NOT_AS_DESCRIBED"
PRODUCTO_INCORRECTO = "WRONG_ITEM"
FALTAN_PIEZAS = "MISSING_PARTS"
NO_FUNCIONA = "NOT_WORKING"
SOSPECHA_DE_FALSIFICACION = "SUSPECTED_COUNTERFEIT"
OTRO = "OTHER"

#: EL OCTAVO NO ES DEL §10, ES DEL §9: «transportista marca entrega pero
#: comprador la niega → congelar y abrir DELIVERY_DISPUTED». Vive aquí porque
#: es el mismo expediente —descripción, evidencia, respuesta, resolución— y una
#: tabla aparte para una sola rama sería una tabla con la misma vida.
#:
#: Y HACE FALTA. El aviso del Incremento 6 le dice a quien compra «ábrelo si no
#: lo has recibido»: sin esto, ese texto prometería un recurso que no existe.
ENTREGA_NEGADA = "DELIVERY_DISPUTED"

MOTIVOS = (
    DANADO,
    NO_COMO_SE_DESCRIBE,
    PRODUCTO_INCORRECTO,
    FALTAN_PIEZAS,
    NO_FUNCIONA,
    SOSPECHA_DE_FALSIFICACION,
    OTRO,
    ENTREGA_NEGADA,
)

#: LOS QUE HABLAN DE CÓMO LLEGÓ EL PRODUCTO. Todos menos el de la entrega
#: negada, que habla de que no llegó.
MOTIVOS_DEL_PRODUCTO = tuple(m for m in MOTIVOS if m != ENTREGA_NEGADA)

# --------------------------------------------------------------------------- #
# La evidencia. Lo que pide el blueprint §10, y lo que no se puede pedir.
# --------------------------------------------------------------------------- #
#: «2–6 fotografías», literal.
FOTOS_MINIMAS = 2
FOTOS_MAXIMAS = 6

#: «descripción mínima de 20 caracteres», literal.
DESCRIPCION_MINIMA = 20
DESCRIPCION_MAXIMA = 2000

#: A LA ENTREGA NEGADA NO SE LE PUEDEN PEDIR DOS FOTOS. No hay nada que
#: fotografiar: el paquete no está. Exigirlas convertiría el único recurso de
#: quien no recibió nada en un requisito imposible.
MOTIVOS_SIN_FOTOS = frozenset({ENTREGA_NEGADA})


def fotos_exigidas(motivo: str) -> int:
    """Cuántas fotografías hacen falta para ese motivo."""
    return 0 if motivo in MOTIVOS_SIN_FOTOS else FOTOS_MINIMAS


# --------------------------------------------------------------------------- #
# Los estados
# --------------------------------------------------------------------------- #
ABIERTA = "OPEN"
MAS_EVIDENCIA = "MORE_EVIDENCE_REQUESTED"
RESPONDIDA = "SELLER_RESPONDED"
MEDIACION = "MEDIATION"
RESUELTA = "RESOLVED"
APELADA = "APPEALED"
RETIRADA = "WITHDRAWN"

ESTADOS = (
    ABIERTA,
    MAS_EVIDENCIA,
    RESPONDIDA,
    MEDIACION,
    RESUELTA,
    APELADA,
    RETIRADA,
)

#: LOS QUE ESPERAN A ALGUIEN. Un caso vivo bloquea acciones incompatibles.
VIVAS = frozenset({ABIERTA, MAS_EVIDENCIA, RESPONDIDA, MEDIACION, APELADA})

#: DONDE EL RELOJ DEL PROVEEDOR CORRE. Solo mientras la pelota es suya.
ESPERAN_AL_PROVEEDOR = frozenset({ABIERTA})

# --------------------------------------------------------------------------- #
# Quién es quién
# --------------------------------------------------------------------------- #
COMPRADOR = "buyer"
PROVEEDOR = "seller"
ADMINISTRACION = "admin"
SISTEMA = "system"
ACTORES = (COMPRADOR, PROVEEDOR, ADMINISTRACION, SISTEMA)

# --------------------------------------------------------------------------- #
# Las salidas. Las seis del blueprint §10.1, menos una que no es una salida.
# --------------------------------------------------------------------------- #
DEVOLVER_Y_REEMBOLSAR_TODO = "RETURN_AND_FULL_REFUND"
REEMBOLSAR_TODO_SIN_DEVOLVER = "FULL_REFUND_WITHOUT_RETURN"
REEMBOLSAR_EN_PARTE = "PARTIAL_REFUND"
REPONER = "REPLACEMENT"
RECHAZAR = "REJECT_CLAIM"

RESOLUCIONES = (
    DEVOLVER_Y_REEMBOLSAR_TODO,
    REEMBOLSAR_TODO_SIN_DEVOLVER,
    REEMBOLSAR_EN_PARTE,
    REPONER,
    RECHAZAR,
)

#: `REQUEST_MORE_EVIDENCE` ESTÁ EN LA LISTA DEL BLUEPRINT Y NO ES UNA SALIDA:
#: es un paso. Un expediente al que se le pide más evidencia no está resuelto,
#: sigue esperando. Tratarlo como resolución dejaría casos «resueltos» que nadie
#: ha decidido, y el día que se cuenten resoluciones saldría un número falso.
PEDIR_MAS_EVIDENCIA = "REQUEST_MORE_EVIDENCE"

#: LO QUE PUEDE PROPONER EL PROVEEDOR: las cinco salidas y pedir más evidencia.
#: Proponer no es resolver.
PROPUESTAS = RESOLUCIONES + (PEDIR_MAS_EVIDENCIA,)

#: LAS QUE DEJAN ALGO DEBIENDO. Dinero en las tres primeras, mercancía en la
#: cuarta. Mientras no se ejecuten, este pedido no puede liberar su saldo:
#: es lo que leerá el Incremento 9.
RESOLUCIONES_CON_DEUDA = frozenset(
    {
        DEVOLVER_Y_REEMBOLSAR_TODO,
        REEMBOLSAR_TODO_SIN_DEVOLVER,
        REEMBOLSAR_EN_PARTE,
        REPONER,
    }
)

#: EL EFECTO DE UNA RESOLUCIÓN NACE PENDIENTE Y NADIE LO EJECUTA. Resolver dice
#: qué se decidió, no que el dinero se haya movido.
EFECTO_PENDIENTE = "PENDING"
EFECTO_NO_APLICA = "NOT_APPLICABLE"
EFECTOS = (EFECTO_PENDIENTE, EFECTO_NO_APLICA)

#: `(desde, hasta) -> quiénes`. Lo que no está aquí, no existe.
TRANSICIONES: dict[tuple[str, str], frozenset[str]] = {
    # --- La pelota va y viene antes de que decida nadie ------------------- #
    (ABIERTA, RESPONDIDA): frozenset({PROVEEDOR}),
    (ABIERTA, MAS_EVIDENCIA): frozenset({PROVEEDOR, ADMINISTRACION}),
    # EL SILENCIO NO CIERRA NADA: pasa a mediación, no a rechazado.
    (ABIERTA, MEDIACION): frozenset({SISTEMA, ADMINISTRACION, COMPRADOR}),
    # APORTAR LA EVIDENCIA QUE LE PIDIERON devuelve la pelota, y el plazo del
    # proveedor vuelve a empezar: no puede correrle el reloj mientras espera.
    (MAS_EVIDENCIA, ABIERTA): frozenset({COMPRADOR}),
    (MAS_EVIDENCIA, MEDIACION): frozenset({SISTEMA, ADMINISTRACION, COMPRADOR}),
    (RESPONDIDA, MEDIACION): frozenset({COMPRADOR, ADMINISTRACION}),
    # --- Resolver es de Z, y de nadie más --------------------------------- #
    (RESPONDIDA, RESUELTA): frozenset({ADMINISTRACION}),
    (MEDIACION, RESUELTA): frozenset({ADMINISTRACION}),
    (APELADA, RESUELTA): frozenset({ADMINISTRACION}),
    # UNA SOLA APELACIÓN, dentro del plazo y con evidencia nueva. Lo comprueba
    # el servicio; aquí solo consta quién puede pedirla.
    (RESUELTA, APELADA): frozenset({COMPRADOR}),
    # --- Retirarla es de quien la abrió, y solo antes de que se resuelva --- #
    (ABIERTA, RETIRADA): frozenset({COMPRADOR}),
    (MAS_EVIDENCIA, RETIRADA): frozenset({COMPRADOR}),
    (RESPONDIDA, RETIRADA): frozenset({COMPRADOR}),
    (MEDIACION, RETIRADA): frozenset({COMPRADOR}),
}

#: LOS SALTOS QUE EXIGEN UN TEXTO. Los que deciden algo y los que dan una mala
#: noticia: sin el porqué, el expediente no se puede revisar después.
CON_MOTIVO: frozenset[tuple[str, str]] = frozenset(
    {
        (ABIERTA, MAS_EVIDENCIA),
        (ABIERTA, RETIRADA),
        (MAS_EVIDENCIA, RETIRADA),
        (RESPONDIDA, RETIRADA),
        (MEDIACION, RETIRADA),
        (RESPONDIDA, RESUELTA),
        (MEDIACION, RESUELTA),
        (APELADA, RESUELTA),
        (RESUELTA, APELADA),
    }
)

MINIMO_DEL_MOTIVO = 3
MAXIMO_DEL_MOTIVO = 1000


class SaltoInexistente(AppError):
    status_code = 409
    code = "product_incident_transition_invalid"


class SaltoNoPermitido(AppError):
    status_code = 403
    code = "product_incident_transition_forbidden"


class MotivoNecesario(AppError):
    status_code = 422
    code = "product_incident_reason_required"


def existe(desde: str, hasta: str) -> bool:
    return (desde, hasta) in TRANSICIONES


def quienes(desde: str, hasta: str) -> frozenset[str]:
    return TRANSICIONES.get((desde, hasta), frozenset())


def esta_viva(estado: str) -> bool:
    """Si ese caso todavía espera a alguien."""
    return estado in VIVAS


def exige_motivo(desde: str, hasta: str) -> bool:
    return (desde, hasta) in CON_MOTIVO


def deja_deuda(resolucion: str | None) -> bool:
    """Si esa resolución deja algo debiendo: dinero o mercancía."""
    return resolucion in RESOLUCIONES_CON_DEUDA


def bloquea_el_dinero(estado: str, resolucion: str | None, efecto: str | None) -> bool:
    """Si este caso impide liberar el saldo de ese pedido.

    DOS COSAS LO BLOQUEAN, Y LA SEGUNDA ES LA QUE SE OLVIDA. Un caso vivo,
    evidentemente; pero también uno YA RESUELTO cuya resolución dejó algo
    debiendo y todavía no se ha ejecutado. Liberar el dinero al proveedor con un
    reembolso aprobado y sin pagar es pagarle dos veces.

    ESTO NO LO USA NADIE TODAVÍA: las transferencias son del Incremento 9. Vive
    aquí, escrito y probado, porque es la pregunta que ese incremento tendrá que
    hacer y el sitio donde tiene que estar la respuesta.
    """
    if esta_viva(estado):
        return True
    return estado == RESUELTA and deja_deuda(resolucion) and efecto != EFECTO_NO_APLICA


def exigir(desde: str, hasta: str, actor: str, motivo: str | None = None) -> str | None:
    """Se para si el salto no existe, no es de quien lo pide o le falta texto."""
    limpio = (motivo or "").strip()

    if desde == hasta:
        raise SaltoInexistente(
            f"La incidencia ya está {desde}.", details={"status": desde}
        )
    if not existe(desde, hasta):
        raise SaltoInexistente(
            f"Una incidencia {desde} no puede pasar a {hasta}.",
            details={"from": desde, "to": hasta},
        )
    if actor not in quienes(desde, hasta):
        raise SaltoNoPermitido(
            "No tienes permiso para dar ese paso.",
            details={"from": desde, "to": hasta},
        )
    if exige_motivo(desde, hasta) and len(limpio) < MINIMO_DEL_MOTIVO:
        raise MotivoNecesario(
            "Ese paso lleva una explicación.",
            details={
                "from": desde,
                "to": hasta,
                "field": "note",
                "min": MINIMO_DEL_MOTIVO,
            },
        )
    return limpio[:MAXIMO_DEL_MOTIVO] or None


def siguientes(desde: str, actor: str) -> tuple[str, ...]:
    """Lo que ESTE actor puede hacer ahora. Para pintar botones, no para
    decidir."""
    return tuple(
        sorted(h for (d, h), q in TRANSICIONES.items() if d == desde and actor in q)
    )


__all__ = [
    "ABIERTA",
    "ACTORES",
    "ADMINISTRACION",
    "APELADA",
    "COMPRADOR",
    "CON_MOTIVO",
    "DANADO",
    "DESCRIPCION_MAXIMA",
    "DESCRIPCION_MINIMA",
    "DEVOLVER_Y_REEMBOLSAR_TODO",
    "EFECTOS",
    "EFECTO_NO_APLICA",
    "EFECTO_PENDIENTE",
    "ENTREGA_NEGADA",
    "ESPERAN_AL_PROVEEDOR",
    "ESTADOS",
    "FALTAN_PIEZAS",
    "FOTOS_MAXIMAS",
    "FOTOS_MINIMAS",
    "MAS_EVIDENCIA",
    "MAXIMO_DEL_MOTIVO",
    "MEDIACION",
    "MINIMO_DEL_MOTIVO",
    "MOTIVOS",
    "MOTIVOS_DEL_PRODUCTO",
    "MOTIVOS_SIN_FOTOS",
    "MotivoNecesario",
    "NO_COMO_SE_DESCRIBE",
    "NO_FUNCIONA",
    "OTRO",
    "PEDIR_MAS_EVIDENCIA",
    "PROPUESTAS",
    "PRODUCTO_INCORRECTO",
    "PROVEEDOR",
    "RECHAZAR",
    "REEMBOLSAR_EN_PARTE",
    "REEMBOLSAR_TODO_SIN_DEVOLVER",
    "REPONER",
    "RESOLUCIONES",
    "RESOLUCIONES_CON_DEUDA",
    "RESPONDIDA",
    "RESUELTA",
    "RETIRADA",
    "SISTEMA",
    "SOSPECHA_DE_FALSIFICACION",
    "SaltoInexistente",
    "SaltoNoPermitido",
    "TRANSICIONES",
    "VIVAS",
    "bloquea_el_dinero",
    "deja_deuda",
    "esta_viva",
    "exige_motivo",
    "exigir",
    "existe",
    "fotos_exigidas",
    "quienes",
    "siguientes",
]
