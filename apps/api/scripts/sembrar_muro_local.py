# -*- coding: utf-8 -*-
"""Publicaciones de muestra para una base LOCAL. Nunca para producción.

PARA QUÉ. Una base local recién migrada está VACÍA: no tiene perfiles, ni muro,
ni cursos, así que la aplicación enseña «Todavía no hay videos» en todas las
pantallas. Eso no es una avería ni una cuenta caducada: es una base sin datos.
Esto le pone unos cuantos, para poder revisar las vistas.

LO QUE NO HACE, Y ES LO MÁS IMPORTANTE:

  * NO COPIA NADA DE LA BASE GESTIONADA. Ni un perfil, ni una publicación, ni
    una foto. Los textos de aquí son inventados a propósito y se nota que lo
    son: traer datos reales de otra base a una copia local es exactamente cómo
    se filtra información de personas que no lo pidieron.
  * NO TOCA LA BASE GESTIONADA. Tres guardias lo impiden, los mismos que
    `sembrar_productos_local.py`.
  * NO SE ENCHUFA EN NINGÚN CAMINO DE PRODUCCIÓN. Es un script suelto que hay
    que ejecutar a mano; no lo llama la aplicación, ni el arranque, ni un
    despliegue.

    python scripts/sembrar_muro_local.py --cuenta <uuid de tu perfil>

`--cuenta` mete ese identificador en `auth.users` para que `/profiles/me` deje
de contestar 404 al entrar con una sesión real de Supabase contra datos locales.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from scripts.sembrar_productos_local import exigir_local  # noqa: E402

#: Gente inventada. Los nombres son de mentira y los textos también.
PERSONAS = [
    ("Ana Quispe", "anaquispe", "Diseño de producto y cerámica."),
    ("Bruno Salas", "brunosalas", "Carpintería y herramienta de mano."),
    ("Carla Medina", "carlamedina", "Fotografía de objeto."),
    ("Diego Rojas", "diegorojas", "Metal y forja."),
]

PUBLICACIONES = [
    "Terminé el lote de esta semana. Doce piezas, todas con su marca de lote.",
    "Probando un acabado nuevo para la madera. Tres capas y lija entre cada una.",
    "Hoy toca inventario. Contar es la mitad del oficio.",
    "Una pieza mal hecha enseña más que diez bien hechas.",
    "Subiendo las fotografías del catálogo. Luz natural y fondo liso.",
    "Cambié el proveedor de acero. Mismo grosor, mejor trazabilidad del lote.",
    "El taller abre el sábado por la mañana para quien quiera ver el proceso.",
    "Reparación en garantía terminada. Cuatro días desde que llegó.",
]


async def sembrar(url: str, cuenta: str | None) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    motor = create_async_engine(
        url.replace("postgresql://", "postgresql+asyncpg://", 1), echo=False
    )
    Sesion = async_sessionmaker(motor, expire_on_commit=False)

    async def persona(nombre: str, usuario: str, bio: str) -> str:
        ident = str(uuid.uuid4())
        async with Sesion() as db:
            await db.execute(
                text(
                    "insert into auth.users (id, email, raw_user_meta_data) values "
                    "(cast(:i as uuid), cast(:e as text), "
                    " jsonb_build_object('full_name', cast(:n as text),"
                    "                    'username', cast(:u as text)))"
                ),
                {"i": ident, "e": f"{usuario}@local.test", "n": nombre, "u": usuario},
            )
            await db.execute(
                text("update public.profiles set bio = :b where id = cast(:i as uuid)"),
                {"b": bio, "i": ident},
            )
            await db.commit()
        return ident

    if cuenta:
        async with Sesion() as db:
            existe = await db.scalar(
                text("select 1 from auth.users where id = cast(:i as uuid)"),
                {"i": cuenta},
            )
            if not existe:
                await db.execute(
                    text(
                        "insert into auth.users (id, email, raw_user_meta_data) values "
                        "(cast(:i as uuid), 'tu-cuenta@local.test', "
                        " jsonb_build_object('full_name','Tu cuenta',"
                        "                    'username','tucuenta'))"
                    ),
                    {"i": cuenta},
                )
            await db.execute(
                text("update public.profiles set role='admin' where id=cast(:i as uuid)"),
                {"i": cuenta},
            )
            await db.commit()
        print(f"cuenta local lista con rol admin: {cuenta}")

    autores = [await persona(*datos) for datos in PERSONAS]

    async with Sesion() as db:
        for indice, cuerpo in enumerate(PUBLICACIONES):
            await db.execute(
                text(
                    "insert into public.posts (author_id, body, status, visibility,"
                    "                          created_at)"
                    " values (cast(:a as uuid), cast(:b as text), 'published', 'public',"
                    "         now() - (cast(:h as int) * interval '1 hour'))"
                ),
                {"a": autores[indice % len(autores)], "b": cuerpo, "h": indice * 5},
            )
        await db.commit()

    # Que se sigan entre ellos, para que «Siguiendo» tampoco salga vacío.
    async with Sesion() as db:
        for i, quien in enumerate(autores):
            a_quien = autores[(i + 1) % len(autores)]
            await db.execute(
                text(
                    "insert into public.follows (follower_id, following_id)"
                    " values (cast(:f as uuid), cast(:g as uuid))"
                    " on conflict do nothing"
                ),
                {"f": quien, "g": a_quien},
            )
        if cuenta:
            for a_quien in autores:
                await db.execute(
                    text(
                        "insert into public.follows (follower_id, following_id)"
                        " values (cast(:f as uuid), cast(:g as uuid))"
                        " on conflict do nothing"
                    ),
                    {"f": cuenta, "g": a_quien},
                )
        await db.commit()

    await motor.dispose()
    print(f"{len(PERSONAS)} personas y {len(PUBLICACIONES)} publicaciones de muestra.")
    print("Todo inventado: no se copió nada de la base gestionada.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cuenta", default=None, help="uuid del perfil con el que entrarás")
    args = parser.parse_args()
    url = exigir_local(
        os.environ.get("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    )
    asyncio.run(sembrar(url, args.cuenta))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
