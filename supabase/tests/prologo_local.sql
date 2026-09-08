-- Lo que Supabase trae puesto y un PostgreSQL pelado no.
--
-- PARA QUE SIRVE. Para poder aplicar las 49 migraciones del proyecto sobre un
-- contenedor `postgres:16-alpine` vacio y comprobar que el SQL es valido de
-- verdad. Sin esto no aplica ninguna: 207 usos de `auth.uid()`, 29 de
-- `storage.objects`, la extension `pg_trgm` en su esquema propio y una
-- publicacion de tiempo real que en Supabase existen desde el primer dia.
--
-- LO QUE ESTO **NO** ES. No es una imitacion de Supabase ni pretende serlo. Son
-- los andamios minimos para que el SQL se pueda ANALIZAR Y EJECUTAR. En
-- particular:
--
--   * `auth.uid()` devuelve NULL. Es lo mismo que ocurre cuando la API se
--     conecta con la clave de servicio, asi que las politicas RLS quedan
--     escritas y comprobables, pero no se ejerce su semantica. Comprobar que
--     una politica FILTRA de verdad necesita sesiones autenticadas, y eso es
--     otra prueba distinta que hoy no existe.
--   * `storage.objects` y `storage.buckets` tienen las columnas que las
--     migraciones nombran, no las de Supabase.
--
-- CERO CREDENCIALES. Nada de aqui toca ningun servicio externo: la base es
-- efimera, anonima y se tira al terminar.

-- Roles a los que las migraciones conceden permisos.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- LO QUE SUPABASE CONCEDE POR DEFECTO, Y SIN ESTO LA PRUEBA ES UNA MENTIRA
-- PIADOSA.
--
-- En un proyecto de Supabase, cada tabla nueva nace con TODOS los privilegios
-- concedidos a `anon` y `authenticated`. Comprobado en la base real:
--
--     select defaclacl from pg_default_acl;  ->  anon=arwdDxtm/postgres
--
-- Aqui solo se creaban los roles, asi que las tablas nacian sin ninguna
-- concesion. Consecuencia: las migraciones 0052 y 0053, que existen ENTERAS
-- para retirar esa concesion, se aplicaban sobre una base donde no habia nada
-- que retirar, y sus bloques de verificacion no podian ponerse en rojo aunque
-- el `revoke` estuviera mal escrito. Se habrian dado por buenas sin haber
-- probado lo unico que hacen.
--
-- Reproduciendo aqui el punto de partida de Supabase, la prueba pasa a
-- significar algo: si un `revoke` se queda corto, CI lo dice.
alter default privileges in schema public
  grant all on tables to anon, authenticated;
alter default privileges in schema public
  grant all on sequences to anon, authenticated;
alter default privileges in schema public
  grant execute on functions to anon, authenticated;

-- `pg_trgm` se instala en su propio esquema porque asi lo pide la 0040.
create schema if not exists extensions;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to public;

-- ------------------------------------------------------------------------- --
-- auth
-- ------------------------------------------------------------------------- --
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- NULL a proposito: ver la cabecera. Es exactamente lo que ve la API cuando
-- entra con la clave de servicio.
create or replace function auth.uid() returns uuid
language sql stable as $$ select null::uuid $$;

create or replace function auth.role() returns text
language sql stable as $$ select 'service_role'::text $$;

grant usage on schema auth to public;

-- ------------------------------------------------------------------------- --
-- storage
-- ------------------------------------------------------------------------- --
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now()
);

-- Parte la ruta por `/`, como la de Supabase: las politicas de Storage la usan
-- para exigir que el primer tramo sea el identificador de quien sube.
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$ select string_to_array(coalesce(name, ''), '/') $$;

grant usage on schema storage to public;

-- ------------------------------------------------------------------------- --
-- Tiempo real
-- ------------------------------------------------------------------------- --
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
