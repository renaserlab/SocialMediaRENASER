"""Lo que las migraciones 0057, 0058 y 0059 sostienen y SQLite no reproduce.

POR QUÉ ESTE FICHERO EXISTE APARTE. Las pruebas de la suite normal corren sobre
SQLite, que no tiene índices únicos PARCIALES, no aplica claves foráneas
compuestas y no tiene RLS. Todas las invariantes de la evaluación y del
certificado que valen algo viven justo ahí: «una sola alternativa correcta»,
«un solo intento abierto», «la alternativa es de esa pregunta», «un intento
enviado tiene nota». En SQLite esas pruebas pasan aunque la base no sostenga
nada, y por eso no se pueden dar por buenas hasta que corren AQUÍ.

CONTRA UNA BASE DESECHABLE Y NUNCA CONTRA OTRA COSA. Se reutiliza el guardia de
`test_migraciones_reales.py`, que rechaza cualquier URL que huela a base de
verdad; sin `MIGRACIONES_DATABASE_URL` estas pruebas se OMITEN, y omitida no es
aprobada.

Cómo correrlas en local:

    docker run --rm -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
    export MIGRACIONES_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres
    pytest tests/test_migraciones_de_aprendizaje.py -v
"""

from __future__ import annotations

import uuid

import pytest

from tests.test_migraciones_reales import (  # noqa: F401  (fixtures)
    SIN_POSTGRES,
    aplicadas,
    conexion,
)


def _nuevo() -> str:
    return str(uuid.uuid4())


def _ejecutar(conexion, sql: str, *args) -> None:
    with conexion.cursor() as cur:
        cur.execute(sql, args)


def _uno(conexion, sql: str, *args):
    with conexion.cursor() as cur:
        cur.execute(sql, args)
        fila = cur.fetchone()
    return fila[0] if fila else None


def _lista(conexion, sql: str, *args) -> list:
    with conexion.cursor() as cur:
        cur.execute(sql, args)
        return [f[0] for f in cur.fetchall()]


@pytest.fixture()
def curso(conexion, aplicadas):
    """Una persona, un curso, un módulo y una lección. Lo mínimo para escribir."""
    persona, curso_id = _nuevo(), _nuevo()
    modulo, leccion = _nuevo(), _nuevo()
    _ejecutar(
        conexion,
        "insert into public.profiles (id, full_name, username) values (%s, %s, %s)",
        persona,
        "Ana",
        f"ana{persona[:8]}",
    )
    _ejecutar(
        conexion,
        """insert into public.courses (id, author_id, title, description, price_minor,
                                       currency, status)
           values (%s, %s, 'Curso', 'Descripcion larga', 4900, 'PEN', 'published')""",
        curso_id,
        persona,
    )
    _ejecutar(
        conexion,
        "insert into public.course_modules (id, course_id, title) values (%s, %s, 'M')",
        modulo,
        curso_id,
    )
    _ejecutar(
        conexion,
        "insert into public.course_lessons (id, module_id, title) values (%s, %s, 'L')",
        leccion,
        modulo,
    )
    return {"persona": persona, "curso": curso_id, "leccion": leccion}


# --------------------------------------------------------------------------- #
# 0057 · Notas privadas
# --------------------------------------------------------------------------- #


@SIN_POSTGRES
def test_una_nota_vacia_la_rechaza_la_base(conexion, curso) -> None:
    """El límite lo pone la base, no solo el formulario."""
    import psycopg

    for texto in ("", "   ", "\n\t "):
        with pytest.raises(psycopg.errors.CheckViolation):
            _ejecutar(
                conexion,
                """insert into public.lesson_notes (user_id, course_id, lesson_id, body)
                   values (%s, %s, %s, %s)""",
                curso["persona"],
                curso["curso"],
                curso["leccion"],
                texto,
            )


@SIN_POSTGRES
def test_una_nota_demasiado_larga_tambien(conexion, curso) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            """insert into public.lesson_notes (user_id, course_id, lesson_id, body)
               values (%s, %s, %s, %s)""",
            curso["persona"],
            curso["curso"],
            curso["leccion"],
            "x" * 2001,
        )


@SIN_POSTGRES
def test_una_posicion_negativa_la_rechaza_la_base(conexion, curso) -> None:
    """Cero es «al principio»; menos uno no significa nada."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            """insert into public.lesson_notes
                 (user_id, course_id, lesson_id, body, position_seconds)
               values (%s, %s, %s, 'Nota', -1)""",
            curso["persona"],
            curso["curso"],
            curso["leccion"],
        )


# --------------------------------------------------------------------------- #
# 0058 · Evaluación
# --------------------------------------------------------------------------- #


@pytest.fixture()
def evaluacion(conexion, curso):
    """Una evaluación con una pregunta y dos alternativas, la primera correcta."""
    quiz, pregunta = _nuevo(), _nuevo()
    correcta, incorrecta = _nuevo(), _nuevo()
    _ejecutar(
        conexion,
        "insert into public.course_quizzes (id, course_id, status) values (%s, %s, 'published')",
        quiz,
        curso["curso"],
    )
    _ejecutar(
        conexion,
        "insert into public.quiz_questions (id, quiz_id, prompt) values (%s, %s, 'Cual?')",
        pregunta,
        quiz,
    )
    for opcion, es_correcta in ((correcta, True), (incorrecta, False)):
        _ejecutar(
            conexion,
            """insert into public.quiz_options (id, question_id, body, is_correct)
               values (%s, %s, 'texto', %s)""",
            opcion,
            pregunta,
            es_correcta,
        )
    return {**curso, "quiz": quiz, "pregunta": pregunta,
            "correcta": correcta, "incorrecta": incorrecta}


@SIN_POSTGRES
def test_una_sola_evaluacion_por_curso(conexion, evaluacion) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.UniqueViolation):
        _ejecutar(
            conexion,
            "insert into public.course_quizzes (id, course_id) values (%s, %s)",
            _nuevo(),
            evaluacion["curso"],
        )


@SIN_POSTGRES
def test_una_sola_alternativa_correcta_por_pregunta(conexion, evaluacion) -> None:
    """EL índice parcial. En SQLite esto pasa sin que nada lo sostenga.

    Dos peticiones a la vez marcando dos alternativas distintas se pasan por
    delante de cualquier `if` en Python; lo único que las para es la base.
    """
    import psycopg

    with pytest.raises(psycopg.errors.UniqueViolation):
        _ejecutar(
            conexion,
            """insert into public.quiz_options (id, question_id, body, is_correct)
               values (%s, %s, 'otra correcta', true)""",
            _nuevo(),
            evaluacion["pregunta"],
        )


@SIN_POSTGRES
def test_varias_alternativas_incorrectas_no_se_estorban(conexion, evaluacion) -> None:
    """El índice es PARCIAL: si no lo fuera, no habría dos alternativas."""
    for _ in range(3):
        _ejecutar(
            conexion,
            """insert into public.quiz_options (id, question_id, body, is_correct)
               values (%s, %s, 'otra', false)""",
            _nuevo(),
            evaluacion["pregunta"],
        )
    total = _uno(
        conexion,
        "select count(*) from public.quiz_options where question_id = %s",
        evaluacion["pregunta"],
    )
    assert total == 5


@SIN_POSTGRES
def test_un_solo_intento_abierto_por_persona_y_evaluacion(conexion, evaluacion) -> None:
    import psycopg

    primero = _nuevo()
    _ejecutar(
        conexion,
        """insert into public.quiz_attempts (id, quiz_id, user_id, course_id)
           values (%s, %s, %s, %s)""",
        primero,
        evaluacion["quiz"],
        evaluacion["persona"],
        evaluacion["curso"],
    )
    with pytest.raises(psycopg.errors.UniqueViolation):
        _ejecutar(
            conexion,
            """insert into public.quiz_attempts (id, quiz_id, user_id, course_id)
               values (%s, %s, %s, %s)""",
            _nuevo(),
            evaluacion["quiz"],
            evaluacion["persona"],
            evaluacion["curso"],
        )


@SIN_POSTGRES
def test_los_intentos_enviados_se_acumulan_como_historial(conexion, evaluacion) -> None:
    """El índice solo cubre los abiertos: reintentar no puede chocar."""
    for _ in range(3):
        _ejecutar(
            conexion,
            """insert into public.quiz_attempts
                 (id, quiz_id, user_id, course_id, status, score_percent, passed,
                  submitted_at)
               values (%s, %s, %s, %s, 'submitted', 80, true, now())""",
            _nuevo(),
            evaluacion["quiz"],
            evaluacion["persona"],
            evaluacion["curso"],
        )
    total = _uno(
        conexion,
        "select count(*) from public.quiz_attempts where user_id = %s",
        evaluacion["persona"],
    )
    assert total == 3


@SIN_POSTGRES
def test_un_intento_enviado_sin_nota_no_cabe_en_la_base(conexion, evaluacion) -> None:
    """Es lo que separa «lo está haciendo» de «lo hizo», y de ahí sale el fin
    del curso y el certificado."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            """insert into public.quiz_attempts
                 (id, quiz_id, user_id, course_id, status)
               values (%s, %s, %s, %s, 'submitted')""",
            _nuevo(),
            evaluacion["quiz"],
            evaluacion["persona"],
            evaluacion["curso"],
        )


@SIN_POSTGRES
def test_un_intento_abierto_con_nota_tampoco(conexion, evaluacion) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            """insert into public.quiz_attempts
                 (id, quiz_id, user_id, course_id, status, score_percent)
               values (%s, %s, %s, %s, 'in_progress', 50)""",
            _nuevo(),
            evaluacion["quiz"],
            evaluacion["persona"],
            evaluacion["curso"],
        )


@SIN_POSTGRES
def test_no_se_responde_una_pregunta_con_la_alternativa_de_otra(
    conexion, evaluacion
) -> None:
    """La clave foránea COMPUESTA. La API ya lo rechaza con un 422, pero un `if`
    en Python no es un invariante: cualquier otra vía de escritura se lo salta.
    """
    import psycopg

    otra_pregunta, otra_opcion = _nuevo(), _nuevo()
    _ejecutar(
        conexion,
        "insert into public.quiz_questions (id, quiz_id, prompt) values (%s, %s, 'Otra?')",
        otra_pregunta,
        evaluacion["quiz"],
    )
    _ejecutar(
        conexion,
        """insert into public.quiz_options (id, question_id, body, is_correct)
           values (%s, %s, 'de otra pregunta', false)""",
        otra_opcion,
        otra_pregunta,
    )

    intento = _nuevo()
    _ejecutar(
        conexion,
        """insert into public.quiz_attempts (id, quiz_id, user_id, course_id)
           values (%s, %s, %s, %s)""",
        intento,
        evaluacion["quiz"],
        evaluacion["persona"],
        evaluacion["curso"],
    )
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        _ejecutar(
            conexion,
            """insert into public.quiz_answers (attempt_id, question_id, option_id)
               values (%s, %s, %s)""",
            intento,
            evaluacion["pregunta"],
            otra_opcion,
        )


@SIN_POSTGRES
def test_una_respuesta_por_pregunta_e_intento(conexion, evaluacion) -> None:
    import psycopg

    intento = _nuevo()
    _ejecutar(
        conexion,
        """insert into public.quiz_attempts (id, quiz_id, user_id, course_id)
           values (%s, %s, %s, %s)""",
        intento,
        evaluacion["quiz"],
        evaluacion["persona"],
        evaluacion["curso"],
    )
    _ejecutar(
        conexion,
        """insert into public.quiz_answers (attempt_id, question_id, option_id)
           values (%s, %s, %s)""",
        intento,
        evaluacion["pregunta"],
        evaluacion["correcta"],
    )
    with pytest.raises(psycopg.errors.UniqueViolation):
        _ejecutar(
            conexion,
            """insert into public.quiz_answers (attempt_id, question_id, option_id)
               values (%s, %s, %s)""",
            intento,
            evaluacion["pregunta"],
            evaluacion["incorrecta"],
        )


# --------------------------------------------------------------------------- #
# 0059 · Finalización y certificado
# --------------------------------------------------------------------------- #


@SIN_POSTGRES
def test_una_finalizacion_por_persona_y_curso(conexion, curso) -> None:
    """La clave primaria compuesta es lo que hace idempotente el registro: la
    segunda vez choca en vez de reescribir la fecha."""
    import psycopg

    _ejecutar(
        conexion,
        "insert into public.course_completions (user_id, course_id) values (%s, %s)",
        curso["persona"],
        curso["curso"],
    )
    with pytest.raises(psycopg.errors.UniqueViolation):
        _ejecutar(
            conexion,
            "insert into public.course_completions (user_id, course_id) values (%s, %s)",
            curso["persona"],
            curso["curso"],
        )


def _certificado(conexion, curso, codigo: str, **campos) -> None:
    columnas = {
        "id": _nuevo(),
        "public_id": codigo,
        "user_id": curso["persona"],
        "course_id": curso["curso"],
        "display_name": "Ana",
        "course_title": "Curso",
        "completed_at": "now()",
        **campos,
    }
    nombres = ", ".join(columnas)
    marcas = ", ".join(
        "now()" if v == "now()" else "%s" for v in columnas.values()
    )
    valores = [v for v in columnas.values() if v != "now()"]
    _ejecutar(
        conexion,
        f"insert into public.course_certificates ({nombres}) values ({marcas})",
        *valores,
    )


@SIN_POSTGRES
def test_un_certificado_por_persona_y_curso(conexion, curso) -> None:
    import psycopg

    _certificado(conexion, curso, "ZC-" + "a" * 32)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _certificado(conexion, curso, "ZC-" + "b" * 32)


@SIN_POSTGRES
def test_dos_certificados_no_comparten_codigo_publico(conexion, curso) -> None:
    import psycopg

    otra = _nuevo()
    _ejecutar(
        conexion,
        "insert into public.profiles (id, full_name, username) values (%s, 'B', %s)",
        otra,
        f"b{otra[:8]}",
    )
    codigo = "ZC-" + "c" * 32
    _certificado(conexion, curso, codigo)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _certificado(conexion, {**curso, "persona": otra}, codigo)


@SIN_POSTGRES
def test_un_certificado_vigente_no_puede_tener_fecha_de_revocacion(
    conexion, curso
) -> None:
    """Es lo que separa los dos estados, y de ahí sale lo que dice la
    verificación pública."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _certificado(
            conexion, curso, "ZC-" + "d" * 32, status="valid", revoked_at="now()"
        )


@SIN_POSTGRES
def test_un_certificado_revocado_sin_fecha_tampoco(conexion, curso) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _certificado(conexion, curso, "ZC-" + "e" * 32, status="revoked")


@SIN_POSTGRES
def test_un_codigo_publico_demasiado_corto_no_cabe(conexion, curso) -> None:
    """Dieciséis caracteres es el mínimo: por debajo se puede recorrer."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _certificado(conexion, curso, "ZC-123")


# --------------------------------------------------------------------------- #
# RLS y permisos de las ocho tablas nuevas
# --------------------------------------------------------------------------- #

NUEVAS = (
    "lesson_notes",
    "course_quizzes",
    "quiz_questions",
    "quiz_options",
    "quiz_attempts",
    "quiz_answers",
    "course_completions",
    "course_certificates",
)


@SIN_POSTGRES
def test_las_ocho_tablas_nuevas_tienen_rls(conexion, aplicadas) -> None:
    sin_rls = _lista(
        conexion,
        """select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public' and c.relkind='r'
             and c.relname = any(%s) and not c.relrowsecurity""",
        list(NUEVAS),
    )
    assert sin_rls == [], f"sin RLS: {sin_rls}"


@SIN_POSTGRES
def test_ninguna_se_sirve_por_postgrest(conexion, aplicadas) -> None:
    """Nacen cerradas, como manda la 0053. `quiz_options` lleva `is_correct`: una
    sola concesión de SELECT ahí entregaría las respuestas del examen."""
    concedidas = _lista(
        conexion,
        """select distinct table_name from information_schema.role_table_grants
           where table_schema='public' and table_name = any(%s)
             and grantee in ('anon','authenticated')""",
        list(NUEVAS),
    )
    assert concedidas == [], f"concedidas a anon/authenticated: {concedidas}"


@SIN_POSTGRES
def test_ninguna_politica_permite_escribir(conexion, aplicadas) -> None:
    """Escribe la API. Una política de INSERT o UPDATE aquí sería otra vía."""
    escriben = _lista(
        conexion,
        """select tablename || ':' || policyname || ':' || cmd
           from pg_policies
           where schemaname='public' and tablename = any(%s)
             and cmd in ('INSERT','UPDATE','DELETE','ALL')""",
        list(NUEVAS),
    )
    assert escriben == [], f"politicas de escritura: {escriben}"


@SIN_POSTGRES
def test_lo_privado_solo_lo_lee_su_dueno(conexion, aplicadas) -> None:
    """Las tres tablas con política de lectura la tienen atada a `auth.uid()`."""
    for tabla in ("lesson_notes", "course_completions", "course_certificates"):
        condiciones = _lista(
            conexion,
            "select qual from pg_policies where schemaname='public' and tablename=%s",
            tabla,
        )
        assert condiciones, f"{tabla} no tiene ninguna politica de lectura"
        for condicion in condiciones:
            assert "auth.uid()" in condicion, f"{tabla}: {condicion}"


@SIN_POSTGRES
def test_la_evaluacion_no_tiene_ninguna_politica(conexion, aplicadas) -> None:
    """Y es a propósito: una política de SELECT entrega la FILA ENTERA, con
    `is_correct` dentro. La evaluación se sirve solo por la API, que elige las
    columnas."""
    con_politica = _lista(
        conexion,
        """select distinct tablename from pg_policies
           where schemaname='public'
             and tablename in ('course_quizzes','quiz_questions','quiz_options',
                               'quiz_attempts','quiz_answers')""",
    )
    assert con_politica == [], f"tienen politica: {con_politica}"


@SIN_POSTGRES
def test_los_indices_parciales_del_aprendizaje_existen(conexion, aplicadas) -> None:
    definiciones = {
        nombre: definicion
        for nombre, definicion in zip(
            _lista(
                conexion,
                "select indexname from pg_indexes where schemaname='public'",
            ),
            _lista(
                conexion,
                "select indexdef from pg_indexes where schemaname='public'",
            ),
        )
    }
    for nombre, dentro in (
        ("quiz_options_una_correcta", "is_correct"),
        ("quiz_attempts_uno_abierto", "in_progress"),
    ):
        assert nombre in definiciones, f"falta el indice {nombre}"
        definicion = definiciones[nombre].lower()
        assert "unique" in definicion, nombre
        assert "where" in definicion, f"{nombre} no es parcial"
        assert dentro in definiciones[nombre], f"{nombre}: {definiciones[nombre]}"
