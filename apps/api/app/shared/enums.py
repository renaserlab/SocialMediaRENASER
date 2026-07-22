"""Tipos ENUM de PostgreSQL, reutilizados por los modelos ORM.

El esquema (incluidos los tipos enum) lo crean las migraciones de Supabase,
por eso create_type=False: SQLAlchemy NO intenta crearlos. En SQLite (dev) estos
tipos degradan a VARCHAR automaticamente.

Tipar las columnas con el enum correcto evita el error
'operator does not exist: content_status = character varying' al comparar en
consultas contra PostgreSQL.
"""

from sqlalchemy.dialects.postgresql import ENUM

content_status = ENUM(
    "draft",
    "published",
    "hidden",
    "deleted",
    name="content_status",
    create_type=False,
)

app_role = ENUM(
    "user",
    "mentor",
    "moderator",
    "admin",
    name="app_role",
    create_type=False,
)

purchase_status = ENUM(
    "pending",
    "paid",
    "refunded",
    "cancelled",
    name="purchase_status",
    create_type=False,
)

member_role = ENUM(
    "member",
    "moderator",
    "owner",
    name="member_role",
    create_type=False,
)
