-- 0063 · El código de admisión deja de estar en claro.
--
-- SIN APLICAR.
--
-- QUÉ PROBLEMA CIERRA. `event_tickets.code` es el código que se teclea en la
-- puerta cuando la cámara falla, y `_buscar` lo acepta como credencial de pleno
-- derecho: admite por sí solo. Estaba guardado en texto legible, así que un
-- volcado de esa tabla —una copia de seguridad, una réplica de análisis, una
-- consulta de más desde soporte— entregaba un juego completo de códigos
-- utilizables. La cabecera del módulo prometía lo contrario, y para el QR era
-- cierto: la credencial nunca se guarda, se guarda su `sha256`. Esta migración
-- le da al código el mismo tratamiento.
--
-- ADITIVA Y SIN DESTRUIR NADA. Añade `code_hash`, lo rellena a partir del
-- código que YA existe —no inventa ninguno— y relaja `code` para que la
-- aplicación pueda dejar de escribirlo. El texto legible que ya hubiera se
-- queda donde está: borrarlo es una decisión con consecuencias y la toma una
-- persona, con el `UPDATE` que está escrito al final de este comentario.
--
-- ENTRADAS ANTERIORES A LA MIGRACIÓN. Siguen funcionando: su `code_hash` se
-- calcula del código que ya tienen. Y la aplicación acepta el texto legible
-- SOLO mientras esa fila no tenga hash; en cuanto lo tiene —es decir, desde
-- esta migración— manda el hash. Así una rotación invalida de verdad el código
-- anterior aunque su texto siga en la columna.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE.
--   * Esquema antes que código: la columna existe y nadie la lee. El código
--     viejo sigue escribiendo `code` en claro y todo funciona igual.
--   * Código antes que esquema: el código nuevo pregunta por `code_hash`, la
--     columna no está, y la puerta responde 503 `event_orders_not_available`
--     como cualquier otra ruta sin su esquema. No se emite ninguna entrada rota.
--
-- ROLLBACK. Hoy es gratis: `FEATURE_EVENT_TICKETING` está apagada y no hay ni
-- una entrada emitida, así que revertir el código y ejecutar el `alter table`
-- inverso no le quita nada a nadie. Cuando existan entradas emitidas con el
-- código nuevo, revertir el CÓDIGO deja esas entradas sin texto legible que
-- enseñar hasta que su dueño vuelva a abrir la entrada, que rota y le entrega
-- uno nuevo. El QR no se ve afectado en ningún caso. Revertir el ESQUEMA
-- —quitar la columna— exige revertir el código primero, o la puerta deja de
-- reconocer cualquier código.
--
-- SIN CRIPTOGRAFÍA CASERA Y SIN EXTENSIONES. `sha256(bytea)` es una función del
-- núcleo de PostgreSQL desde la 11. Es el mismo resumen que la aplicación
-- calcula para la credencial del QR, así que los dos caminos usan lo mismo.

-- ------------------------------------------------------------------------- --
-- 1. La columna del resumen.
-- ------------------------------------------------------------------------- --
alter table public.event_tickets
  add column if not exists code_hash text;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_tickets'
      and c.conname = 'event_tickets_codigo_resumido'
  ) then
    alter table public.event_tickets
      add constraint event_tickets_codigo_resumido
      check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$');
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. Relleno: del código que YA existe. No se inventa ninguno.
-- ------------------------------------------------------------------------- --
update public.event_tickets
   set code_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex')
 where code is not null
   and code_hash is null;

-- ------------------------------------------------------------------------- --
-- 3. Un resumen no se repite. Parcial: las filas sin hash no compiten.
-- ------------------------------------------------------------------------- --
create unique index if not exists event_tickets_codigo_resumido_unico
  on public.event_tickets (code_hash)
  where code_hash is not null;

-- ------------------------------------------------------------------------- --
-- 4. `code` deja de ser obligatorio, para poder dejar de escribirlo.
--
-- La restricción vieja exigía el formato SIEMPRE. La nueva lo exige solo
-- cuando hay algo escrito, que es lo que permite que una entrada nueva no
-- guarde texto legible.
-- ------------------------------------------------------------------------- --
alter table public.event_tickets
  alter column code drop not null;

do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_tickets'
      and c.conname = 'event_tickets_codigo'
  ) then
    alter table public.event_tickets drop constraint event_tickets_codigo;
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_tickets'
      and c.conname = 'event_tickets_codigo_opcional'
  ) then
    alter table public.event_tickets
      add constraint event_tickets_codigo_opcional
      check (code is null or code ~ '^[A-Z0-9]{10,24}$');
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 5. Permisos: los mismos de la 0062, reafirmados.
--
-- Una columna nueva hereda los privilegios de la tabla, y la tabla no tiene
-- ninguno para `anon` ni `authenticated`. Se vuelve a revocar de todos modos:
-- es idempotente y deja el estado escrito donde se lee.
-- ------------------------------------------------------------------------- --
alter table public.event_tickets enable row level security;
revoke all on public.event_tickets from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 6. Verificación posterior. Si algo no cuadra, la migración no pasa.
-- ------------------------------------------------------------------------- --
do $$
declare
  sin_resumen bigint;
  permisos bigint;
begin
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'event_tickets'
      and a.attname = 'code_hash' and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'La 0063 no dejó la columna code_hash';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'event_tickets_codigo_resumido_unico'
  ) then
    raise exception 'La 0063 no dejó el índice único del resumen';
  end if;

  select count(*) into sin_resumen
    from public.event_tickets
   where code is not null and code_hash is null;
  if sin_resumen > 0 then
    raise exception 'Quedan % entradas con código en claro y sin resumen', sin_resumen;
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public' and table_name = 'event_tickets'
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'event_tickets tiene % permisos para anon/authenticated', permisos;
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 7. LIMPIEZA DEL TEXTO LEGIBLE. NO SE EJECUTA AQUÍ.
--
-- Esta migración no borra los códigos que ya estaban escritos, porque borrar
-- datos es una decisión con consecuencias y no la toma una migración. Cuando
-- se haya comprobado que la puerta funciona con el resumen, esto los retira:
--
--   update public.event_tickets set code = null where code_hash is not null;
--
-- Hasta entonces esos textos siguen ahí, y siguen sin admitir: la aplicación
-- solo acepta el texto legible de una fila que TODAVÍA NO tenga resumen, y
-- después de esta migración no queda ninguna.
-- ------------------------------------------------------------------------- --
