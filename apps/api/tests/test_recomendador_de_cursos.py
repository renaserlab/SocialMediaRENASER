"""Que curso sale primero, y por que.

Funciones PURAS: no hay base de datos, ni red, ni reloj del sistema. Un
escenario entero —«Ana quiere aprender IA; el curso A es de IA; el B es de
marketing»— se escribe aqui y se comprueba el orden sin crear una sola fila en
ninguna parte. Esa es la diferencia entre poder afirmar como ordena Z y
suponerlo.

LAS TRES COSAS QUE ESTAS PRUEBAS IMPIDEN, y que son las que convierten un
recomendador en un escaparate:

1. **Que el precio ordene.** Ni caro es mejor ni gratis es peor.
2. **Que la popularidad mande.** Mas alumnos no hace un curso mas util para TI.
3. **Que un motivo mienta.** Si algo sale primero por su autor, el motivo dice
   eso y no se inventa una coincidencia de tema que no existe.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.modules.recommendations.config import (
    MINIMO_PARA_POPULARIDAD,
    PESOS_DE_CURSOS,
)
from app.modules.recommendations.features import PerfilDeDemanda
from app.modules.recommendations.ranker_de_cursos import (
    MOTIVO_AUTOR,
    MOTIVO_NUEVO,
    MOTIVO_OBJETIVO,
    MOTIVO_POR_DESCUBRIR,
    MOTIVO_TEMA,
    puntuar,
)
from app.modules.recommendations.rasgos_de_curso import CursoCandidato, construir

AHORA = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
SEMILLA = "2026-08-24"

IA = "tema-ia"
PROGRAMACION = "tema-programacion"
MARKETING = "tema-marketing"
MUSICA = "tema-musica"

ANA = "usuario-ana"
CARLOS = "autor-carlos"
LUCIA = "autor-lucia"


def demanda(**cambios) -> PerfilDeDemanda:
    base = {
        "usuario_id": ANA,
        "aprender": frozenset({IA}),
        "objetivos": frozenset({"aprender"}),
    }
    base.update(cambios)
    return PerfilDeDemanda(**base)


def curso(course_id: str, **cambios) -> CursoCandidato:
    base = {
        "id": course_id,
        "author_id": CARLOS,
        "temas": frozenset(),
        "creado": AHORA - timedelta(days=200),
        "inscritos": 0,
    }
    base.update(cambios)
    return CursoCandidato(**base)


def score(d: PerfilDeDemanda, c: CursoCandidato) -> float:
    rasgos = construir(d, c, objetivos=d.objetivos, semilla=SEMILLA, ahora=AHORA)
    return puntuar(rasgos, PESOS_DE_CURSOS).score


def motivos(d: PerfilDeDemanda, c: CursoCandidato) -> list[str]:
    rasgos = construir(d, c, objetivos=d.objetivos, semilla=SEMILLA, ahora=AHORA)
    return [m.code for m in puntuar(rasgos, PESOS_DE_CURSOS).motivos]


# --------------------------------------------------------------------------- #
# 1. El escenario del enunciado
# --------------------------------------------------------------------------- #
def test_el_curso_del_tema_que_quiere_aprender_va_primero():
    """Ana quiere aprender IA. A es de IA y programación; B de marketing; C de
    música. A tiene que ganarles a los dos."""
    ana = demanda(aprender=frozenset({IA}), formatos=frozenset({"curso"}))
    a = curso("A", temas=frozenset({IA, PROGRAMACION}))
    b = curso("B", temas=frozenset({MARKETING}))
    c = curso("C", temas=frozenset({MUSICA}))

    assert score(ana, a) > score(ana, b)
    assert score(ana, a) > score(ana, c)


def test_y_lo_explica_nombrando_el_tema():
    ana = demanda()
    a = curso("A", temas=frozenset({IA}))
    codigos = motivos(ana, a)
    assert codigos[0] == MOTIVO_TEMA


def test_querer_aprender_pesa_mas_que_solo_interesarse():
    """Un curso no necesita declarar que ensena: ensenar es lo que es. Lo que
    cambia es con cuanta fuerza se pide."""
    quiere = demanda(aprender=frozenset({IA}), intereses=frozenset())
    le_suena = demanda(aprender=frozenset(), intereses=frozenset({IA}))
    c = curso("A", temas=frozenset({IA}))
    assert score(quiere, c) > score(le_suena, c)


def test_buscar_orientacion_tambien_pide_curso_con_fuerza():
    orienta = demanda(aprender=frozenset(), orientacion=frozenset({IA}))
    c = curso("A", temas=frozenset({IA}))
    assert score(orienta, c) > 0.5


# --------------------------------------------------------------------------- #
# 2. El precio NO es calidad
# --------------------------------------------------------------------------- #
def test_el_precio_no_entra_en_los_rasgos():
    """La prueba mas importante de este fichero.

    `CursoCandidato` NO tiene precio a proposito: no se puede ordenar por algo
    que el ranker ni siquiera recibe. Si alguien lo anade algun dia, esta
    prueba se cae y obliga a justificarlo.
    """
    campos = CursoCandidato.__dataclass_fields__
    assert "precio" not in campos
    assert "price_minor" not in campos
    assert "currency" not in campos


def test_dos_cursos_identicos_puntuan_igual_cueste_lo_que_cueste():
    """Si el precio influyera de alguna forma indirecta, estos dos se separarian."""
    ana = demanda()
    caro = curso("A", temas=frozenset({IA}))
    gratis = curso("A", temas=frozenset({IA}))  # mismo id: mismo todo
    assert score(ana, caro) == score(ana, gratis)


# --------------------------------------------------------------------------- #
# 3. La popularidad no manda
# --------------------------------------------------------------------------- #
def test_un_curso_popular_de_otro_tema_no_gana_al_del_tema_correcto():
    """Es la misión de Z: no ordena por popular, ordena por util para ti."""
    ana = demanda()
    del_tema = curso("A", temas=frozenset({IA}), inscritos=0)
    popular = curso("B", temas=frozenset({MARKETING}), inscritos=500)
    assert score(ana, del_tema) > score(ana, popular)


def test_con_pocos_datos_la_popularidad_NO_APLICA():
    """Con tres inscritos, la diferencia entre dos cursos es ruido con aspecto
    de metrica. Y meterla como un cero castigaria a todo curso nuevo por serlo.
    """
    ana = demanda()
    rasgos = construir(
        ana,
        curso("A", temas=frozenset({IA}), inscritos=MINIMO_PARA_POPULARIDAD - 1),
        objetivos=ana.objetivos,
        semilla=SEMILLA,
        ahora=AHORA,
    )
    assert rasgos.popularidad is None
    # Y no aparece en el reparto: no es un cero disfrazado.
    assert "popularidad" not in puntuar(rasgos, PESOS_DE_CURSOS).desglose


def test_con_datos_suficientes_si_suma_un_poco():
    ana = demanda()
    solo = curso("A", temas=frozenset({IA}), inscritos=0)
    con_gente = curso("A", temas=frozenset({IA}), inscritos=40)
    assert score(ana, con_gente) > score(ana, solo)
    # Pero poco: no puede ser la diferencia entre el primero y el ultimo.
    assert score(ana, con_gente) - score(ana, solo) < 0.10


# --------------------------------------------------------------------------- #
# 4. El autor ayuda, pero no manda
# --------------------------------------------------------------------------- #
def test_seguir_al_creador_ayuda():
    ana = demanda(tiene_senales=True)
    de_conocido = curso("A", temas=frozenset({IA}), ya_sigue_al_autor=True)
    de_desconocido = curso("A", temas=frozenset({IA}), ya_sigue_al_autor=False)
    assert score(ana, de_conocido) > score(ana, de_desconocido)


def test_pero_no_vence_a_una_coincidencia_tematica_fuerte():
    """El caso del enunciado: sigue a Carlos, pero Lucia ensena justo lo que
    Ana quiere aprender. Gana Lucia."""
    ana = demanda(aprender=frozenset({IA}), tiene_senales=True)
    de_carlos = curso(
        "A",
        author_id=CARLOS,
        temas=frozenset({MUSICA}),
        ya_sigue_al_autor=True,
        senal_del_autor=5.0,
    )
    de_lucia = curso("B", author_id=LUCIA, temas=frozenset({IA}))
    assert score(ana, de_lucia) > score(ana, de_carlos)


def test_sin_ninguna_senal_el_autor_no_aplica():
    ana = demanda(tiene_senales=False)
    rasgos = construir(
        ana, curso("A", temas=frozenset({IA})), objetivos=ana.objetivos,
        semilla=SEMILLA, ahora=AHORA,
    )
    assert rasgos.autor is None


# --------------------------------------------------------------------------- #
# 5. Intencion y formato: empujan, no filtran
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("objetivo", ["aprender", "cursos", "mejorar_profesionalmente"])
def test_quien_vino_a_formarse_ve_mas_cursos(objetivo):
    con = demanda(objetivos=frozenset({objetivo}))
    sin = demanda(objetivos=frozenset({"conectar"}))
    c = curso("A", temas=frozenset({IA}))
    assert score(con, c) > score(sin, c)


def test_pero_quien_no_lo_dijo_sigue_viendo_cursos():
    """Convertir esto en un filtro dejaria sin cursos a media aplicacion por
    una respuesta de una sola pregunta."""
    sin = demanda(objetivos=frozenset({"conectar"}))
    assert score(sin, curso("A", temas=frozenset({IA}))) > 0.3


def test_preferir_el_formato_curso_suma():
    con = demanda(formatos=frozenset({"curso"}))
    otro = demanda(formatos=frozenset({"video"}))
    c = curso("A", temas=frozenset({IA}))
    assert score(con, c) > score(otro, c)


def test_no_haber_contestado_el_formato_no_es_un_cero():
    ana = demanda(formatos=frozenset())
    rasgos = construir(
        ana, curso("A", temas=frozenset({IA})), objetivos=ana.objetivos,
        semilla=SEMILLA, ahora=AHORA,
    )
    assert rasgos.formato is None


# --------------------------------------------------------------------------- #
# 6. Un curso sin temas
# --------------------------------------------------------------------------- #
def test_un_curso_sin_temas_no_hereda_los_de_su_autor():
    """A diferencia de las publicaciones. Un curso es una obra deliberada y
    quien lo publica elige sus temas al publicarlo; suponerlos pondria cursos
    de cocina delante de quien pidio carpinteria solo porque los firma la
    misma persona."""
    ana = demanda()
    sin_temas = curso("A", temas=frozenset())
    rasgos = construir(
        ana, sin_temas, objetivos=ana.objetivos, semilla=SEMILLA, ahora=AHORA
    )
    assert rasgos.tema == 0.0
    assert rasgos.tiene_temas is False


def test_y_su_motivo_no_menciona_ningun_tema():
    """Un sistema que explica mal ensena a desconfiar de lo que dice."""
    ana = demanda()
    codigos = motivos(ana, curso("A", temas=frozenset()))
    assert MOTIVO_TEMA not in codigos


def test_sigue_pudiendo_aparecer_por_otras_vias():
    """No tener temas no es estar prohibido: puede salir por su autor o por
    exploracion. Lo que cambia es el motivo."""
    ana = demanda(tiene_senales=True)
    c = curso("A", temas=frozenset(), ya_sigue_al_autor=True, senal_del_autor=4.0)
    assert score(ana, c) > 0
    assert MOTIVO_AUTOR in motivos(ana, c)


# --------------------------------------------------------------------------- #
# 7. Rechazar un tema enfria, no borra
# --------------------------------------------------------------------------- #
def test_rechazar_un_tema_baja_sus_cursos():
    limpia = demanda()
    harta = demanda(penalizacion_por_tema={IA: 0.6})
    c = curso("A", temas=frozenset({IA}))
    assert score(harta, c) < score(limpia, c)


def test_pero_no_lo_hunde_del_todo():
    """La persona cambia, y un sistema que no la deja volver deja de servirle."""
    harta = demanda(penalizacion_por_tema={IA: 0.6})
    del_tema = curso("A", temas=frozenset({IA}))
    de_otro = curso("B", temas=frozenset({MUSICA}))
    assert score(harta, del_tema) > score(harta, de_otro)


# --------------------------------------------------------------------------- #
# 8. Explicabilidad
# --------------------------------------------------------------------------- #
def test_sin_nada_que_contar_se_dice_la_verdad():
    """Es preferible a inventarse una coincidencia."""
    nadie = PerfilDeDemanda(usuario_id=ANA)
    assert motivos(nadie, curso("A")) == [MOTIVO_POR_DESCUBRIR]


def test_no_se_repite_la_misma_frase_dos_veces():
    """«Quieres aprender IA y esto es IA» y «venias a aprender» son lo mismo."""
    ana = demanda(objetivos=frozenset({"cursos"}))
    codigos = motivos(ana, curso("A", temas=frozenset({IA})))
    assert MOTIVO_TEMA in codigos
    assert MOTIVO_OBJETIVO not in codigos


def test_un_curso_nuevo_lo_dice():
    ana = demanda()
    reciente = curso("A", temas=frozenset(), creado=AHORA - timedelta(days=3))
    assert MOTIVO_NUEVO in motivos(ana, reciente)


def test_nunca_mas_de_tres_motivos():
    """Mas de tres y la tarjeta se convierte en un informe."""
    ana = demanda(
        formatos=frozenset({"curso"}),
        objetivos=frozenset({"cursos"}),
        tiene_senales=True,
        afinidad_por_tema={IA: 8.0},
    )
    c = curso(
        "A",
        temas=frozenset({IA}),
        creado=AHORA - timedelta(days=1),
        ya_sigue_al_autor=True,
        senal_del_autor=5.0,
        inscritos=100,
    )
    assert len(motivos(ana, c)) <= 3


def test_el_score_no_sale_en_los_motivos():
    """«0.8734261» no significa nada para quien lo lee y aparenta una precision
    que no existe."""
    ana = demanda()
    rasgos = construir(
        ana, curso("A", temas=frozenset({IA})), objetivos=ana.objetivos,
        semilla=SEMILLA, ahora=AHORA,
    )
    resultado = puntuar(rasgos, PESOS_DE_CURSOS)
    for motivo in resultado.motivos:
        assert not any(char.isdigit() for char in motivo.code)


# --------------------------------------------------------------------------- #
# 9. Exploracion determinista
# --------------------------------------------------------------------------- #
def test_la_exploracion_no_es_azar():
    """Con azar de verdad, pasar a la pagina 2 repetiria cursos, y ninguna
    prueba podria comprobar un orden."""
    ana = demanda()
    c = curso("A", temas=frozenset({IA}))
    primera = score(ana, c)
    for _ in range(20):
        assert score(ana, c) == primera


def test_dos_personas_distintas_exploran_distinto():
    c = curso("A", temas=frozenset())
    una = construir(
        PerfilDeDemanda(usuario_id="persona-1"), c, objetivos=frozenset(),
        semilla=SEMILLA, ahora=AHORA,
    )
    otra = construir(
        PerfilDeDemanda(usuario_id="persona-2"), c, objetivos=frozenset(),
        semilla=SEMILLA, ahora=AHORA,
    )
    assert una.exploracion != otra.exploracion


def test_la_misma_semilla_da_el_mismo_orden():
    ana = demanda()
    cursos = [curso(f"curso-{i}", temas=frozenset({IA})) for i in range(10)]
    orden = lambda: sorted(cursos, key=lambda c: (-score(ana, c), c.id))  # noqa: E731
    assert [c.id for c in orden()] == [c.id for c in orden()]


# --------------------------------------------------------------------------- #
# 10. El reparto de pesos
# --------------------------------------------------------------------------- #
def test_los_pesos_suman_uno():
    """Si no sumaran 1, el score dejaria de ser comparable entre superficies."""
    assert abs(PESOS_DE_CURSOS.total() - 1.0) < 1e-9


def test_el_tema_es_el_componente_que_mas_pesa():
    """La mision manda sobre el reparto."""
    pesos = PESOS_DE_CURSOS
    assert pesos.tema > pesos.autor
    assert pesos.tema > pesos.popularidad
    assert pesos.tema >= 0.40


def test_la_popularidad_apenas_pesa():
    assert PESOS_DE_CURSOS.popularidad <= 0.05


def test_lo_que_no_aplica_sale_del_reparto():
    """Sin esto, dos personas con respuestas distintas tendrian scores que no
    se pueden comparar, y apagar un componente hundiria todos los numeros."""
    ana = PerfilDeDemanda(usuario_id=ANA, aprender=frozenset({IA}))
    rasgos = construir(
        ana, curso("A", temas=frozenset({IA})), objetivos=frozenset(),
        semilla=SEMILLA, ahora=AHORA,
    )
    desglose = puntuar(rasgos, PESOS_DE_CURSOS).desglose
    assert "formato" not in desglose  # no dijo formatos
    assert "intencion" not in desglose  # no dijo objetivos
    assert "comportamiento" not in desglose  # no tiene senales
    assert "popularidad" not in desglose  # nadie inscrito
    assert desglose["final"] > 0
