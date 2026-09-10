-- 0065 · El efecto de un expediente sobre cada entrada.
--
-- SIN APLICAR.
--
-- QUÉ RESUELVE. La 0064 dejó constancia de QUÉ entradas toca un expediente y
-- de cómo estaban al abrirlo, pero no de qué se le hizo a cada una. Sin eso,
-- «esta entrada está en revisión» o «está bloqueada temporalmente» no existen
-- en ningún sitio, y la puerta no puede negarse por un motivo que nadie ha
-- escrito.
--
-- POR QUÉ NO SE AÑADEN ESTADOS A `event_tickets`. Una entrada tiene tres
-- estados y son los de su ciclo propio: válida, usada, revocada. «En revisión»
-- y «bloqueada» no son propiedades de la entrada: son consecuencias de un
-- expediente, y viven donde vive su causa. Guardarlas como un cuarto y quinto
-- estado de la entrada obligaría a saber, mirando solo la entrada, por qué está
-- así —y no se podría—.
--
-- UN SOLO EFECTO VIVO POR ENTRADA, y lo impone un índice parcial. Hoy ya no
-- puede haber dos expedientes vivos sobre el mismo pedido, así que esto es la
-- segunda cerradura: dos procesos concurrentes no pueden dejar la misma entrada
-- «en revisión» por un caso y «bloqueada» por otro.
--
-- Y LA PUERTA APRENDE UN VEREDICTO NUEVO. `ON_HOLD` es «esta entrada está
-- retenida por un expediente». No es `REVOKED` —no se ha retirado nada— ni
-- `NOT_ADMITTING`, que habla del evento entero. Decirlo con uno de esos dos
-- sería mentir sobre lo que pasó.
--
-- SEGURA EN LOS DOS ÓRDENES DE DESPLIEGUE. Esquema antes que código: columnas
-- nuevas con valor por defecto que significa «ningún efecto», y nadie las lee.
-- Código antes que esquema: la posventa responde 503 y la puerta funciona
-- exactamente igual que hoy.
--
-- BACKFILL: NINGUNO. `effect` nace en `none` por defecto, que es la verdad de
-- todas las filas anteriores: ningún expediente les aplicó nada.
--
-- ROLLBACK: quitar las tres columnas y el índice, y devolver el CHECK de
-- `event_checkins.result` a sus seis valores. Solo es seguro si no se ha
-- escrito ningún `ON_HOLD`; el comentario del final dice cómo comprobarlo.

-- ------------------------------------------------------------------------- --
-- 1. El efecto aplicado a cada entrada del expediente.
-- ------------------------------------------------------------------------- --
alter table public.event_aftersale_case_tickets
  add column if not exists effect text not null default 'none';

alter table public.event_aftersale_case_tickets
  add column if not exists effect_reason text;

alter table public.event_aftersale_case_tickets
  add column if not exists effect_at timestamptz;

alter table public.event_aftersale_case_tickets
  add column if not exists effect_by uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_aftersale_case_tickets'
      and c.conname = 'event_aftersale_case_tickets_efecto'
  ) then
    alter table public.event_aftersale_case_tickets
      add constraint event_aftersale_case_tickets_efecto
      check (effect in (
        'none',
        'under_review',
        'blocked',
        'cancelled',
        'revoked',
        'restored'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_aftersale_case_tickets'
      and c.conname = 'event_aftersale_case_tickets_motivo_del_efecto'
  ) then
    alter table public.event_aftersale_case_tickets
      add constraint event_aftersale_case_tickets_motivo_del_efecto
      check (effect_reason is null or length(effect_reason) <= 500);
  end if;

  -- UN EFECTO SIN FECHA NO SE PUEDE AUDITAR, y `none` no es un efecto.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_aftersale_case_tickets'
      and c.conname = 'event_aftersale_case_tickets_efecto_con_fecha'
  ) then
    alter table public.event_aftersale_case_tickets
      add constraint event_aftersale_case_tickets_efecto_con_fecha
      check ((effect = 'none') = (effect_at is null));
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_aftersale_case_tickets'
      and c.conname = 'event_aftersale_case_tickets_quien'
  ) then
    alter table public.event_aftersale_case_tickets
      add constraint event_aftersale_case_tickets_quien
      foreign key (effect_by) references public.profiles(id) on delete set null;
  end if;
end;
$$;

-- UN SOLO EFECTO QUE RETIENE POR ENTRADA. `cancelled`, `revoked` y `restored`
-- son terminales y sí pueden convivir en el histórico de varios expedientes;
-- los que RETIENEN, no: dos a la vez sobre la misma entrada serían dos motivos
-- distintos para lo mismo y nadie sabría cuál levantar.
create unique index if not exists event_aftersale_case_tickets_retencion_unica
  on public.event_aftersale_case_tickets (ticket_id)
  where effect in ('under_review', 'blocked');

create index if not exists event_aftersale_case_tickets_por_efecto
  on public.event_aftersale_case_tickets (effect, effect_at desc);

-- ------------------------------------------------------------------------- --
-- 2. La puerta aprende a decir «retenida».
--
-- Se amplía el CHECK, no se sustituye por otro más laxo: los seis valores
-- anteriores siguen siendo los únicos válidos, más este.
-- ------------------------------------------------------------------------- --
do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'event_checkins'
      and c.conname = 'event_checkins_resultado'
  ) then
    alter table public.event_checkins drop constraint event_checkins_resultado;
  end if;

  alter table public.event_checkins
    add constraint event_checkins_resultado
    check (result in (
      'OK',
      'ALREADY_USED',
      'REVOKED',
      'NOT_FOUND',
      'WRONG_EVENT',
      'NOT_ADMITTING',
      'ON_HOLD'
    ));
end;
$$;

-- ------------------------------------------------------------------------- --
-- 3. Permisos: los mismos, reafirmados. Columnas nuevas no conceden nada.
-- ------------------------------------------------------------------------- --
alter table public.event_aftersale_case_tickets enable row level security;
revoke all on public.event_aftersale_case_tickets from anon, authenticated;
alter table public.event_checkins enable row level security;
revoke all on public.event_checkins from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 4. Verificación posterior.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  permisos bigint;
begin
  select string_agg(c.columna, ', ')
    into faltan
    from (values ('effect'), ('effect_reason'), ('effect_at'), ('effect_by')) as c(columna)
   where not exists (
     select 1 from pg_attribute a
     join pg_class t on t.oid = a.attrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'event_aftersale_case_tickets'
       and a.attname = c.columna
       and a.attnum > 0 and not a.attisdropped
   );
  if faltan is not null then
    raise exception 'La 0065 no dejó las columnas: %', faltan;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'event_aftersale_case_tickets_retencion_unica'
  ) then
    raise exception 'La 0065 no dejó el índice de retención única';
  end if;

  -- El veredicto nuevo tiene que caber, y los seis anteriores seguir cabiendo.
  begin
    insert into public.event_checkins (event_id, result)
    select id, 'ON_HOLD' from public.events limit 0;
  exception when others then
    raise exception 'La 0065 no amplió el CHECK de event_checkins.result';
  end;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in ('event_aftersale_case_tickets', 'event_checkins')
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Hay % permisos sueltos para anon/authenticated', permisos;
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 5. ROLLBACK. Antes de revertir el CHECK de `event_checkins.result`,
--    comprobar que nadie escribió el veredicto nuevo:
--
--      select count(*) from public.event_checkins where result = 'ON_HOLD';
--
--    Si devuelve algo distinto de cero, revertir el CHECK dejaría filas que
--    la restricción ya no admite y cualquier escritura posterior fallaría.
-- ------------------------------------------------------------------------- --
