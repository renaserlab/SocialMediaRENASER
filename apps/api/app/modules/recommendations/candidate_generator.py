"""Quienes podrian servir. Todavia no en que orden.

Separar «quienes» de «en que orden» no es ceremonia: son dos problemas con
costes distintos. Buscar candidatos toca la base de datos y tiene que ser
barato; ordenarlos es aritmetica sobre lo ya traido. Mezclarlos obligaria a
puntuar a toda la comunidad para quedarse con veinte.

VARIAS VIAS, NO UNA. Una sola consulta dejaria fuera casos que importan: quien
no declaro temas se quedaria sin nadie, y quien los declaro no veria jamas a
una persona nueva que aun no ha rellenado su perfil. Cada via aporta un tipo
distinto de candidato y se dice cual fue, porque de eso depende que se pueda
explicar despues por que aparece cada persona.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.recommendations import repository as repo
from app.modules.recommendations.config import (
    CANDIDATOS_MAXIMOS,
    VENTANA_DE_ACTIVIDAD_DIAS,
)
from app.modules.recommendations.features import PerfilDeDemanda

#: De donde salio cada candidato. Se conserva para poder decir con honestidad
#: si la lista es una recomendacion o un respaldo.
VIA_OFERTA = "oferta"
VIA_INTERES_COMUN = "interes_comun"
VIA_ACTIVIDAD = "actividad"
VIA_DESTACADOS = "destacados"


@dataclass
class Candidatos:
    ids: list[str] = field(default_factory=list)
    #: id -> via por la que entro (la primera que lo encontro).
    origen: dict[str, str] = field(default_factory=dict)

    def anadir(self, nuevos: list[str], via: str) -> None:
        for candidato in nuevos:
            if candidato in self.origen:
                continue
            self.origen[candidato] = via
            self.ids.append(candidato)

    @property
    def hubo_coincidencia_real(self) -> bool:
        """Si alguien entro por lo que ofrece, esto es una recomendacion.

        Si no, es un respaldo, y la respuesta lo dice (`strategy`). Presentar
        un respaldo como si fuera una coincidencia seria mentir sobre lo que el
        sistema sabe.
        """
        return any(via == VIA_OFERTA for via in self.origen.values())


async def generar(
    db: AsyncSession,
    demanda: PerfilDeDemanda,
    *,
    excluidos: set[str],
    ahora: datetime,
    limite: int = CANDIDATOS_MAXIMOS,
) -> Candidatos:
    """Reune candidatos por las cuatro vias, sin repetir y en orden de calidad.

    El orden en que se preguntan importa: la primera via que encuentra a
    alguien es la que queda registrada como su origen, y las mejores van
    primero. Ademas el `limite` se reparte de forma que una via generosa no
    consuma el cupo entero.
    """
    candidatos = Candidatos()

    # 1. Quien ofrece lo que la persona busca. La via principal.
    if demanda.tiene_demanda:
        candidatos.anadir(
            await repo.candidatos_por_oferta(
                db,
                topic_ids=set(demanda.temas_buscados),
                relaciones=_relaciones_a_buscar(demanda),
                excluidos=excluidos,
                limite=limite,
            ),
            VIA_OFERTA,
        )

    # 2. Quien comparte intereses. Solo si lo pidio: cruzar intereses de quien
    #    no lo pidio seria usar informacion privada para algo que nadie busco.
    if demanda.busca_afines and demanda.tiene_demanda and len(candidatos.ids) < limite:
        candidatos.anadir(
            await repo.candidatos_por_interes_comun(
                db,
                topic_ids=set(demanda.temas_buscados),
                excluidos=excluidos | set(candidatos.origen),
                limite=limite - len(candidatos.ids),
            ),
            VIA_INTERES_COMUN,
        )

    # 3. Quien publica. Es lo que evita que un usuario sin preferencias —o con
    #    preferencias que nadie cubre todavia— se quede sin nada que ver.
    if len(candidatos.ids) < limite:
        candidatos.anadir(
            await repo.candidatos_activos(
                db,
                excluidos=excluidos | set(candidatos.origen),
                desde=ahora - timedelta(days=VENTANA_DE_ACTIVIDAD_DIAS),
                limite=limite - len(candidatos.ids),
            ),
            VIA_ACTIVIDAD,
        )

    # 4. Los perfiles que el producto destaca. Ultimo recurso para que la
    #    pantalla nunca salga vacia el primer dia de una cuenta nueva.
    if len(candidatos.ids) < limite:
        candidatos.anadir(
            await repo.candidatos_destacados(
                db,
                excluidos=excluidos | set(candidatos.origen),
                limite=limite - len(candidatos.ids),
            ),
            VIA_DESTACADOS,
        )

    return candidatos


def _relaciones_a_buscar(demanda: PerfilDeDemanda) -> tuple[str, ...]:
    """Que lado de la oferta hay que mirar.

    Si la persona pidio un tipo de conexion concreto se busca eso; si no dijo
    nada, se busca cualquier forma de ofrecer. Reducirlo a «ensena» por defecto
    dejaria fuera a quien puede ayudar sin considerarse profesor, que es
    justamente mucha de la gente valiosa.
    """
    if demanda.relaciones_buscadas:
        return tuple(sorted(demanda.relaciones_buscadas))
    from app.modules.recommendations.config import RELACIONES_DE_OFERTA

    return RELACIONES_DE_OFERTA
