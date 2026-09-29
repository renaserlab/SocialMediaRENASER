-- 0089 · Borrar una cuenta sin borrar la historia: quien actuó queda anónimo.
--
-- SIN APLICAR. Escrita el 29/09/2026 y probada solo contra PostgreSQL local:
-- desde cero (0001–0089), sobre una base con la 0088 y datos, reejecutada y
-- con un fallo a mitad (`tests/test_migracion_0089.py`). Requiere la 0088, que
-- está aplicada en Supabase y verificada sin divergencias. NO TOCA la 0050, la
-- 0051, la 0060, la 0064, la 0067–0069, la 0081, la 0082 ni la 0086–0088: sus
-- ficheros siguen como se aplicaron y lo que cambia aquí son CUERPOS DE
-- FUNCIÓN, una clave ajena y una nulabilidad, con nombres de siempre.
-- Al aplicarla no hace falta reiniciar la API (no cambia ninguna tabla que la
-- API cachee), pero conviene hacerlo por costumbre.
--
-- QUÉ FALLABA. `DELETE /me` borra el perfil y de él cuelgan en cascada sus
-- datos. Pero trece columnas que guardan QUIÉN hizo algo en un historial de
-- solo añadir se declararon `on delete set null` —la historia se conserva y
-- deja de nombrar a la persona— y a la vez su disparador rechaza CUALQUIER
-- `UPDATE`. La puesta a NULL que pide la clave ajena ES un `UPDATE`:
--
--     UPDATE ONLY "public"."audit_events" SET "actor_id" = NULL
--       WHERE $1 OPERATOR(pg_catalog.=) "actor_id"
--     → 23001 restrict_violation, «La tabla audit_events es de solo anadir»
--
-- y aborta la transacción entera: la cuenta no se borra. Lo mismo en
-- `course_versions.published_by`, `event_versions.created_by`,
-- `event_policies.created_by/published_by`, las cuatro tablas de historial de
-- disputas, devoluciones y posventa, las dos de moderación de reseñas y
-- `event_order_policy_acceptances.accepted_by`. Y tres borrados EN CASCADA
-- chocaban con su disparador de «no se borra»: las versiones de un curso cuyo
-- autor se va, las políticas de un evento cuyo organizador se va, la
-- moderación de una reseña cuyo autor se va y las aceptaciones de una orden
-- cuyo comprador se va. `consent_records.subject_id`, por último, era
-- `restrict`: cualquiera que hubiera aceptado un texto no podía irse nunca.
--
-- LA REGLA (decidida el 29/09/2026): al borrar una cuenta se borran los datos
-- personales y los archivos privados, y se CONSERVAN los registros históricos
-- necesarios para seguridad, trazabilidad, operación, disputas y auditoría,
-- sin que sigan identificando directamente a la persona.
--
-- LO QUE HACE:
--
--   1. `es_anonimizacion_por_baja(...)`: el ÚNICO camino por el que una fila
--      de historial admite un cambio. Solo es verdad si, a la vez:
--        a) viene de dentro de la cascada de una clave ajena (profundidad de
--           disparador 2 o más; un UPDATE escrito a mano llega con 1);
--        b) cada columna que cambia es de persona, va de un uuid a NULL y ese
--           perfil YA NO EXISTE (es el que se está borrando);
--        c) NADA MÁS cambia en la fila, y algo se anuló.
--      No reasigna a otra persona, no restaura un actor, no toca fechas,
--      acciones, recursos, resultados, detalles ni cuerpos.
--   2. Cada disparador de solo añadir la consulta ANTES de rechazar. Su
--      mensaje, su código de error y su nombre no cambian.
--   3. Los borrados que solo son legítimos EN CASCADA (versiones de curso,
--      políticas de evento, moderación de reseñas de eventos y aceptaciones
--      de una orden) se admiten cuando la fila madre ya no existe: es el mismo
--      patrón que la 0060 puso en las versiones de evento y la 0086 en
--      Servicios. Suelta, una fila de estas sigue sin poder borrarse.
--   4. `consent_records.subject_id` pasa a admitir NULL y su clave ajena a
--      `on delete set null`: la prueba de lo que se aceptó se queda, anónima.
--   5. `audit_events` deja de compartir `impedir_reescritura()` (que siguen
--      usando `consent_records` y `policy_versions` para NO BORRAR) y usa su
--      propia función, con el mismo nombre de disparador.
--   6. UNA ORDEN EN LA QUE SE MOVIÓ DINERO NO SE BORRA (`event_orders` y
--      `orders`). Las dos caen en cascada con quien compró, y lo único que lo
--      frenaba era el saldo del vendedor (`owner_sale_balances`, `restrict`),
--      que NO SE CREA sin comisión configurada (`PLATFORM_FEE_BPS=-1`, el valor
--      por defecto). Sin este freno, una compra pagada desaparecía con la
--      cuenta, y con ella la referencia del cobro: un contracargo posterior no
--      tendría a qué agarrarse. Hallado en la revisión del 29/09/2026.
--
-- LO QUE NO HACE, Y ES DELIBERADO:
--
--   * No borra ni reescribe ninguna fila, ni de auditoría ni de nada.
--   * No quita ningún `restrict` de ventas, saldos, transferencias, pedidos,
--     incidencias, disputas o decisiones de personal: una cuenta con esas
--     obligaciones —o con una orden pagada (6)— SIGUE SIN PODER BORRARSE
--     SOLA, y la API responde un 409 que lo explica en vez de un 500. Qué
--     hacer con esos registros (plazo de retención, anonimización de pedidos)
--     es una decisión de la empresa.
--   * No limpia `ip_hash`, `ip_prefix` ni `user_agent_family`: son datos de
--     seguridad y su retención también es una decisión pendiente.
--   * No concede nada a `anon` ni a `authenticated`, ni toca la RLS.
--
-- UNA ÚNICA TRANSACCIÓN que primero comprueba que el esquema es EXACTAMENTE
-- el esperado —tablas, columnas, claves ajenas, disparadores y el cuerpo de
-- cada función que sustituye, por su huella— y se detiene si no. REEJECUTABLE:
-- `create or replace`, `drop constraint if exists` + `add`, y las huellas
-- admiten la versión anterior o la de esta migración.
--
-- ROLLBACK. Volver a crear las doce funciones con el cuerpo de su migración
-- original (0050/0051, 0060, 0064, 0067, 0068, 0069, 0081, 0082), devolver el
-- disparador `audit_events_solo_anadir` a `impedir_reescritura()`, borrar
-- `auditoria_solo_anadir()` y `es_anonimizacion_por_baja()` y, SOLO si ningún
-- consentimiento quedó anónimo, `alter column subject_id set not null` y la
-- clave ajena con `on delete restrict`. Con consentimientos anónimos, la
-- vuelta atrás real es retirar el código y dejar las filas: son historia.
--
-- CÓMO VERIFICARLA (solo lectura): ver `docs/Z_BAJA_DE_CUENTA.md`, apartado
-- «Verificar la 0089».

begin;

-- ------------------------------------------------------------------------- --
-- 1. Lo que tiene que haber, y exactamente como se espera.
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  distintas text;
begin
  -- 1.1 La 0088, aplicada. Esta migración va detrás.
  if to_regclass('public.service_provider_application_submissions') is null
     or to_regprocedure('public.servicios_prestador_coherente()') is null then
    raise exception 'La 0089 requiere la 0088 aplicada';
  end if;

  -- 1.2 Las columnas de persona, cada una con su clave ajena a `profiles`.
  --     `consent_records.subject_id` puede estar en `restrict` (antes de esta
  --     migración) o en `set null` (reejecución); las demás, en `set null`.
  select string_agg(format('%s.%s', e.tabla, e.columna), ', ') into faltan
    from (values
      ('audit_events', 'actor_id', 'n'),
      ('consent_records', 'subject_id', 'rn'),
      ('course_versions', 'published_by', 'n'),
      ('event_versions', 'created_by', 'n'),
      ('event_policies', 'created_by', 'n'),
      ('event_policies', 'published_by', 'n'),
      ('event_review_moderation', 'actor_id', 'n'),
      ('product_review_moderation', 'actor_id', 'n'),
      ('product_refund_events', 'actor_id', 'n'),
      ('product_dispute_events', 'actor_id', 'n'),
      ('event_dispute_events', 'actor_id', 'n'),
      ('event_aftersale_case_events', 'actor_id', 'n'),
      ('event_order_policy_acceptances', 'accepted_by', 'n')
    ) as e(tabla, columna, acciones)
   where not exists (
     select 1
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f'
        and c.conrelid = to_regclass('public.' || e.tabla)
        and c.confrelid = 'public.profiles'::regclass
        and array_length(c.conkey, 1) = 1
        and a.attname = e.columna
        and position(c.confdeltype in e.acciones) > 0
   );
  if faltan is not null then
    raise exception 'La 0089 no encontró como esperaba las columnas de persona: %', faltan;
  end if;

  -- 1.3 Las madres de las cascadas que se admiten.
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'courses', 'events', 'event_reviews', 'event_review_replies', 'event_orders', 'orders', 'profiles'
    ]) as t
   where to_regclass('public.' || t) is null;
  if faltan is not null then
    raise exception 'La 0089 no encontró las tablas %', faltan;
  end if;

  -- 1.3b Lo que mira el freno de las órdenes con dinero (sección 8).
  select string_agg(format('%s.%s', e.tabla, e.columna), ', ') into faltan
    from (values
      ('event_orders', 'provider'), ('event_orders', 'status'), ('event_orders', 'paid_at'),
      ('event_orders', 'external_payment_id'), ('event_orders', 'environment'),
      ('event_orders', 'updated_at'), ('orders', 'status'), ('orders', 'paid_at'),
      ('orders', 'environment')
    ) as e(tabla, columna)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = e.tabla and c.column_name = e.columna
   );
  if faltan is not null then
    raise exception 'La 0089 no encontró las columnas de las órdenes: %', faltan;
  end if;

  -- 1.3c UNA SOLA clave ajena sobre `consent_records.subject_id`: la que se
  --      sustituye. Otra (`restrict`, puesta a mano) seguiría frenando la baja
  --      aunque esta migración dijera haberla cambiado.
  if (select count(*)
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f'
         and c.conrelid = 'public.consent_records'::regclass
         and a.attname = 'subject_id') <> 1 then
    raise exception 'La 0089 esperaba una sola clave ajena sobre consent_records.subject_id';
  end if;

  -- 1.4 Cada disparador, en su tabla, llamando a su función y con su forma
  --     exacta: `tgtype` codifica fila o sentencia, antes o después y los
  --     eventos (27 = before update or delete, por fila; 19 = before update;
  --     11 = before delete). Uno cambiado a mano a solo `before delete`
  --     dejaría el UPDATE sin vigilar aunque conservara nombre y función.
  select string_agg(format('%s.%s', e.tabla, e.disparador), ', ') into faltan
    from (values
      ('audit_events', 'audit_events_solo_anadir', 'impedir_reescritura|auditoria_solo_anadir', 27),
      ('consent_records', 'consent_records_inmutable', 'sellar_consumo_una_vez', 19),
      ('consent_records', 'consent_records_no_se_borra', 'impedir_reescritura', 11),
      ('course_versions', 'course_versions_inmutable', 'impedir_reescritura_de_version', 27),
      ('event_versions', 'event_versions_inmutables', 'impedir_reescritura_de_version_de_evento', 27),
      ('event_policies', 'event_policies_inmutable', 'event_policies_publicada_es_inmutable', 19),
      ('event_policies', 'event_policies_no_se_borra', 'event_policies_publicada_no_se_borra', 11),
      ('event_review_moderation', 'event_review_moderation_inmutable', 'event_review_moderation_solo_anadir', 27),
      ('product_review_moderation', 'product_review_moderation_inmutable', 'product_review_moderation_solo_anadir', 27),
      ('product_refund_events', 'product_refund_events_inmutables', 'product_finanzas_solo_se_anaden', 27),
      ('product_dispute_events', 'product_dispute_events_inmutables', 'product_finanzas_solo_se_anaden', 27),
      ('event_dispute_events', 'event_dispute_events_inmutable', 'event_dispute_events_solo_anadir', 27),
      ('event_aftersale_case_events', 'event_aftersale_case_events_inmutables', 'event_aftersale_case_events_solo_anadir', 27),
      ('event_order_policy_acceptances', 'event_order_policy_acceptances_inmutable', 'event_order_policy_acceptances_solo_anadir', 27)
    ) as e(tabla, disparador, funciones, tipo)
   where not exists (
     select 1
       from pg_trigger t
       join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal
        and t.tgrelid = to_regclass('public.' || e.tabla)
        and t.tgname = e.disparador
        and t.tgenabled = 'O'
        and t.tgtype = e.tipo
        and p.pronamespace = 'public'::regnamespace
        and p.proname = any (string_to_array(e.funciones, '|'))
   );
  if faltan is not null then
    raise exception 'La 0089 no encontró como esperaba los disparadores: %', faltan;
  end if;

  -- 1.5 EL CUERPO DE CADA FUNCIÓN QUE SE SUSTITUYE, por su huella (md5 del
  --     texto con los espacios colapsados). Vale la versión que dejó su
  --     migración o la de esta. Otra cosa es un cambio hecho a mano en la base
  --     que `create or replace` pisaría sin avisar: se para aquí.
  select string_agg(e.funcion, ', ') into distintas
    from (values
      ('sellar_consumo_una_vez', 'c715501add1cf9e712db607ce25093e7', '3dab99dea6429ec8f74721a11e1a0480'),
      ('impedir_reescritura_de_version', '279a594daaf9bc3e983e7cfdcde442ab', 'dbc2e4cf08face07369f4f020cd24742'),
      ('impedir_reescritura_de_version_de_evento', '08baf4fea1e657e8efb9d089faf45aca', '64ac6c5b8201b051d87002ffe27a2d6c'),
      ('event_policies_publicada_es_inmutable', '79afbac9355b2f3033aafc232c44c97b', '675e87c61eb41f6afd34b67dbd1c1fc3'),
      ('event_policies_publicada_no_se_borra', 'd1f6d9fc252c77d61f7d039ad76c1cad', '432b62dfeb0cb4bf88188e5267730856'),
      ('event_review_moderation_solo_anadir', 'ebf536507d92d44d9b046ed71a327078', 'd8dab887f89a3c5519f7a8c7cdfbeb45'),
      ('product_review_moderation_solo_anadir', '5d55589faed2465d7562862fcb3481f8', '72d54ab378cccdf3961b64f4d3e79350'),
      ('product_finanzas_solo_se_anaden', '0a20a3dac39608197e074ffd5a21bb81', 'c0bd49b5e89a6afc316f8e78ce199f09'),
      ('event_dispute_events_solo_anadir', 'a709bab805aa0aaa1e05432296d1e4a0', '0f7bd033f231982d1deb8757c6fa8258'),
      ('event_aftersale_case_events_solo_anadir', '4fd2867fd20a71cd4c06fd4ddff83e6a', '8f76ab678cc39f4972cfcff40ff0077c'),
      ('event_order_policy_acceptances_solo_anadir', '87834477eef82402b526bcb816de783c', '6e8bc5698569b633ef76ec3560d90630')
    ) as e(funcion, antes, despues)
   where not exists (
     select 1
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = e.funcion
        and p.pronargs = 0
        and md5(regexp_replace(replace(p.prosrc, E'\r', ''), '\s+', ' ', 'g')) in (e.antes, e.despues)
   );
  if distintas is not null then
    raise exception 'La 0089 encontró funciones con un cuerpo distinto del esperado: %. Revísalas antes de aplicarla', distintas;
  end if;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 2. La única excepción: anular la persona cuando se borra su perfil.
-- ------------------------------------------------------------------------- --
--
-- VOLÁTIL A PROPÓSITO (la de por defecto). Una función `stable` consulta con la
-- foto de la sentencia que la llamó, y en esa foto el perfil que se está
-- borrando todavía existe: la excepción no se abriría nunca. Volátil, cada
-- consulta ve lo que la cascada ya hizo.
--
-- `security invoker` y `search_path` vacío: no da ningún privilegio y todo va
-- cualificado. Dentro de la cascada de una clave ajena PostgreSQL ejecuta como
-- dueño de la tabla, así que ve `profiles` entera sin elevar nada.
--
-- Solo DEVUELVE un booleano; no escribe. Llamarla a mano no abre nada: fuera
-- de un disparador la profundidad es 0 y responde `false`.
create or replace function public.es_anonimizacion_por_baja(
  viejo jsonb,
  nuevo jsonb,
  columnas text[]
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  columna text;
  anuladas integer := 0;
begin
  -- a) DESDE LA CASCADA. La clave ajena pone el NULL desde su disparador
  --    interno, así que el de la tabla llega con profundidad 2 o más.
  if pg_catalog.pg_trigger_depth() < 2 then
    return false;
  end if;

  foreach columna in array columnas loop
    if (viejo -> columna) is distinct from (nuevo -> columna) then
      -- b) De una persona a NADIE. Ni de una a otra, ni de nadie a alguien.
      if coalesce(viejo ->> columna, '') = ''
         or (nuevo -> columna) is distinct from 'null'::jsonb then
        return false;
      end if;
      -- b) Y esa persona YA NO ESTÁ: es su perfil lo que se está borrando.
      if exists (
        select 1 from public.profiles p where p.id = (viejo ->> columna)::uuid
      ) then
        return false;
      end if;
      anuladas := anuladas + 1;
    end if;
    viejo := viejo - columna;
    nuevo := nuevo - columna;
  end loop;

  -- c) NADA MÁS cambia, y algo se anuló.
  return anuladas > 0 and viejo = nuevo;
end;
$$;

revoke all on function public.es_anonimizacion_por_baja(jsonb, jsonb, text[]) from public;
revoke all on function public.es_anonimizacion_por_baja(jsonb, jsonb, text[]) from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 3. La auditoría: su propia función, el mismo disparador.
-- ------------------------------------------------------------------------- --
create or replace function public.auditoria_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['actor_id']) then
    return new;
  end if;
  raise exception 'La tabla % es de solo anadir: no admite % ', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.auditoria_solo_anadir() from public;
revoke all on function public.auditoria_solo_anadir() from anon, authenticated;

create or replace trigger audit_events_solo_anadir
  before update or delete on public.audit_events
  for each row execute function public.auditoria_solo_anadir();

-- ------------------------------------------------------------------------- --
-- 4. Consentimientos: la prueba se queda; la persona, no.
-- ------------------------------------------------------------------------- --
alter table public.consent_records
  alter column subject_id drop not null;

alter table public.consent_records
  drop constraint if exists consent_records_subject_id_fkey;
alter table public.consent_records
  add constraint consent_records_subject_id_fkey
  foreign key (subject_id) references public.profiles(id) on delete set null;

create or replace function public.sellar_consumo_una_vez()
returns trigger language plpgsql as $$
begin
  -- 0089: lo único que admite además un consentimiento YA CONSUMIDO es dejar
  -- de nombrar a quien lo aceptó, cuando esa persona borra su cuenta.
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['subject_id']) then
    return new;
  end if;
  -- Lo único que puede cambiar de un consentimiento es sellar su consumo, y
  -- una sola vez. Todo lo demás es la prueba de lo que se aceptó.
  if old.consumed_at is not null then
    raise exception 'El consentimiento % ya estaba consumido', old.id
      using errcode = 'restrict_violation';
  end if;
  if (new.subject_id, new.policy_version_id, new.policy_hash, new.accepted_at)
     is distinct from
     (old.subject_id, old.policy_version_id, old.policy_hash, old.accepted_at) then
    raise exception 'No se puede reescribir un consentimiento, solo sellar su consumo'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 5. Versiones de curso: se van con su curso; quien publicó, anónimo.
-- ------------------------------------------------------------------------- --
--
-- Una versión VENDIDA sigue sin poder irse: `orders.course_version_id` es
-- `restrict`, y compras, productos de tienda y saldos también frenan el
-- borrado del curso. Lo que se admite es la cascada de un curso sin ventas.
create or replace function public.impedir_reescritura_de_version()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    -- 0089: SI EL CURSO YA NO ESTA, es la cascada de su borrado (su autor
    -- borro la cuenta). Suelta, una version no se borra.
    if not exists (select 1 from public.courses where id = old.course_id) then
      return old;
    end if;
    raise exception 'Una version de curso no se borra: es lo que alguien compro'
      using errcode = 'restrict_violation';
  end if;
  -- 0089: quien la publico borro su cuenta.
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['published_by']) then
    return new;
  end if;
  -- `origin` ESTA EN LA LISTA, y es la que menos se ve venir: es lo que
  -- distingue una version publicada de verdad de una reconstruida por el
  -- backfill. `published_at` y `published_by` son la firma de esa publicacion.
  if new.snapshot is distinct from old.snapshot
     or new.content_hash is distinct from old.content_hash
     or new.version is distinct from old.version
     or new.course_id is distinct from old.course_id
     or new.origin is distinct from old.origin
     or new.published_at is distinct from old.published_at
     or new.published_by is distinct from old.published_by then
    raise exception 'Una version de curso es inmutable: publica otra'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------------- --
-- 6. Eventos: versiones, políticas, moderación de reseñas, disputas,
--    posventa y aceptaciones.
-- ------------------------------------------------------------------------- --
create or replace function public.impedir_reescritura_de_version_de_evento()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- SI EL EVENTO YA NO ESTA, esto es la cascada de su borrado y no un intento
    -- de arrancarle una version. Sin esta salida el disparador impide borrar el
    -- evento entero, y por la cascada de `events.organizer_id` tambien impide
    -- dar de baja la cuenta de quien lo organizo. Lo que se protege es que
    -- nadie borre una version SUELTA, dejando un expediente que ya no cuadra.
    if not exists (select 1 from public.events where id = old.event_id) then
      return old;
    end if;
    raise exception 'Una version de evento no se borra: es lo que se reviso'
      using errcode = 'restrict_violation';
  end if;
  -- 0089: quien la congelo borro su cuenta.
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['created_by']) then
    return new;
  end if;
  if new.snapshot is distinct from old.snapshot
     or new.version is distinct from old.version
     or new.event_id is distinct from old.event_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Una version de evento es inmutable: congela otra'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create or replace function public.event_policies_publicada_es_inmutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.status = 'draft' then
    return new;
  end if;

  -- 0089: quien la creó o la publicó borró su cuenta.
  if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['created_by', 'published_by']) then
    return new;
  end if;

  -- El paso a superada: solo el estado y la fecha de fin.
  if old.status = 'published' and new.status = 'superseded' then
    if (new.policy_type, new.scope, new.event_id, new.jurisdiction, new.locale,
        new.version, new.params, new.params_sha256, new.body,
        new.effective_from, new.published_at, new.published_by,
        new.created_by) is distinct from
       (old.policy_type, old.scope, old.event_id, old.jurisdiction, old.locale,
        old.version, old.params, old.params_sha256, old.body,
        old.effective_from, old.published_at, old.published_by,
        old.created_by)
    then
      raise exception
        'Al superseder una política solo cambian su estado y su fecha de fin'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  raise exception 'Una política % no se modifica: se publica una versión nueva',
    old.status
    using errcode = 'restrict_violation';
end;
$$;

-- Una política DE EVENTO se va con su evento. Si alguien compró con ella, las
-- aceptaciones, los expedientes, las disputas y las reservas de saldo la
-- sujetan (`restrict`) y el evento no se borra. Una global no tiene evento y
-- sigue sin poder borrarse publicada.
create or replace function public.event_policies_publicada_no_se_borra()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.status = 'draft' then
    return old;
  end if;
  -- 0089: la cascada del borrado de su evento.
  if old.event_id is not null
     and not exists (select 1 from public.events where id = old.event_id) then
    return old;
  end if;
  raise exception 'Una política % no se borra', old.status
    using errcode = 'restrict_violation';
end;
$$;

-- La moderación de una reseña se va con la reseña (su autor borró la cuenta);
-- quien moderó, si se va, queda anónimo.
create or replace function public.event_review_moderation_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['actor_id']) then
      return new;
    end if;
  elsif (old.review_id is not null
         and not exists (select 1 from public.event_reviews where id = old.review_id))
     or (old.reply_id is not null
         and not exists (select 1 from public.event_review_replies where id = old.reply_id)) then
    return old;
  end if;
  raise exception 'El historial de moderación no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

create or replace function public.event_dispute_events_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['actor_id']) then
    return new;
  end if;
  raise exception 'El historial de una disputa no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

create or replace function public.event_aftersale_case_events_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['actor_id']) then
    return new;
  end if;
  raise exception 'El historial de un expediente no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

-- Las aceptaciones se van con su orden. La orden de un comprador cae en cascada
-- con su cuenta (`event_orders.buyer_id`) SOLO si no movió dinero: una orden
-- pagada no se borra (sección 8), y la aceptación se queda con ella.
create or replace function public.event_order_policy_acceptances_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['accepted_by']) then
      return new;
    end if;
  elsif not exists (select 1 from public.event_orders where id = old.order_id) then
    return old;
  end if;
  raise exception 'Una aceptación de política no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

-- ------------------------------------------------------------------------- --
-- 7. Productos: moderación de reseñas y el historial de dinero.
-- ------------------------------------------------------------------------- --
--
-- Solo la anonimización. Aquí no hace falta ninguna salida de cascada: una
-- reseña de producto cuelga de un pedido, y un pedido impide borrar la cuenta
-- de quien compra (`product_orders.buyer_id` es `restrict`).
create or replace function public.product_review_moderation_solo_anadir()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['actor_id']) then
    return new;
  end if;
  raise exception 'El historial de moderacion no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

create or replace function public.product_finanzas_solo_se_anaden()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and public.es_anonimizacion_por_baja(to_jsonb(old), to_jsonb(new), array['actor_id']) then
    return new;
  end if;
  raise exception 'El historial financiero no se modifica ni se borra'
    using errcode = 'restrict_violation';
end;
$$;

-- ------------------------------------------------------------------------- --
-- 8. Una orden en la que se movió dinero no se borra.
-- ------------------------------------------------------------------------- --
--
-- Las dos órdenes caen en cascada con la cuenta de quien compró
-- (`event_orders.buyer_id`, `orders.user_id`). Eso está bien para lo que no
-- movió dinero —una reserva caducada, una entrada gratuita, un pago que nunca
-- empezó— y mal para lo que sí: el pedido lleva el importe y la referencia del
-- cobro, y es lo que hace falta para conciliar y para contestar un contracargo.
-- Lo único que lo frenaba era el saldo del vendedor, que sin comisión
-- configurada no se crea.
--
-- SOLO DINERO DE VERDAD (`production`): una orden de pruebas (`sandbox`) no se
-- concilia ni admite contracargos, y no puede impedir que alguien que probó la
-- beta se vaya. Y un pago EN CURSO solo mientras todavía puede cobrarse: la
-- sesión de cobro de Stripe caduca a las 24 horas; pasado ese margen, un
-- checkout abandonado no frena la baja.
--
-- ANTES DEL BORRADO, fila a fila, y con la tabla en el error: la API lo
-- convierte en 409 `account_deletion_blocked` con su área (`events` o
-- `courses`), sin haber tocado ningún archivo.
create or replace function public.event_orders_con_dinero_no_se_borran()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.provider <> 'none'
     and old.environment = 'production'
     and (old.paid_at is not null
          or old.external_payment_id is not null
          or old.status = 'PAID'
          or (old.status = 'PAYMENT_PROCESSING' and old.updated_at > now() - interval '25 hours')) then
    raise exception 'Una orden de evento en la que se movió dinero no se borra'
      using errcode = 'restrict_violation', table = 'event_orders';
  end if;
  return old;
end;
$$;

create or replace function public.orders_con_dinero_no_se_borran()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.environment = 'production'
     and (old.paid_at is not null or old.status in ('paid', 'refunded')) then
    raise exception 'Una orden de curso en la que se movió dinero no se borra'
      using errcode = 'restrict_violation', table = 'orders';
  end if;
  return old;
end;
$$;

revoke all on function public.event_orders_con_dinero_no_se_borran() from public;
revoke all on function public.event_orders_con_dinero_no_se_borran() from anon, authenticated;
revoke all on function public.orders_con_dinero_no_se_borran() from public;
revoke all on function public.orders_con_dinero_no_se_borran() from anon, authenticated;

create or replace trigger event_orders_con_dinero_no_se_borran
  before delete on public.event_orders
  for each row execute function public.event_orders_con_dinero_no_se_borran();

create or replace trigger orders_con_dinero_no_se_borran
  before delete on public.orders
  for each row execute function public.orders_con_dinero_no_se_borran();

-- ------------------------------------------------------------------------- --
-- 9. Verificación.
-- ------------------------------------------------------------------------- --
do $$
declare
  tablas text[] := array[
    'audit_events', 'consent_records', 'course_versions', 'event_versions',
    'event_policies', 'event_review_moderation', 'product_review_moderation',
    'product_refund_events', 'product_dispute_events', 'event_dispute_events',
    'event_aftersale_case_events', 'event_order_policy_acceptances'
  ];
  sin_rls text;
  expuestas bigint;
begin
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.audit_events'::regclass
       and t.tgname = 'audit_events_solo_anadir'
       and p.proname = 'auditoria_solo_anadir'
       and t.tgenabled = 'O'
  ) then
    raise exception 'La 0089 no dejó la auditoría con su disparador';
  end if;

  if (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal and t.tgenabled = 'O' and t.tgtype = 11
         and ((t.tgrelid = 'public.event_orders'::regclass and p.proname = 'event_orders_con_dinero_no_se_borran')
           or (t.tgrelid = 'public.orders'::regclass and p.proname = 'orders_con_dinero_no_se_borran'))) <> 2 then
    raise exception 'La 0089 no dejó los frenos de las órdenes con dinero';
  end if;

  -- Los que NO se tocan siguen sin dejar borrar.
  if (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'impedir_reescritura'
         and t.tgname in ('consent_records_no_se_borra', 'policy_versions_no_se_borra')) <> 2 then
    raise exception 'La 0089 dejó sin su disparador de no borrar a consentimientos o políticas';
  end if;

  if not exists (
    select 1 from pg_constraint c
     where c.conname = 'consent_records_subject_id_fkey'
       and c.conrelid = 'public.consent_records'::regclass
       and c.confrelid = 'public.profiles'::regclass
       and c.confdeltype = 'n'
  ) or exists (
    select 1 from pg_attribute
     where attrelid = 'public.consent_records'::regclass
       and attname = 'subject_id' and attnotnull
  ) then
    raise exception 'La 0089 no dejó el consentimiento anonimizable';
  end if;

  if not exists (
    select 1 from pg_proc
     where oid = 'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])'::regprocedure
       and not prosecdef
       and proconfig = array['search_path=""']
  ) then
    raise exception 'La 0089 no dejó la excepción con search_path fijo y sin privilegios';
  end if;

  select count(*) into expuestas
    from unnest(array['anon', 'authenticated']) as r(rol)
   cross join unnest(array[
     'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])',
     'public.auditoria_solo_anadir()',
     'public.event_orders_con_dinero_no_se_borran()',
     'public.orders_con_dinero_no_se_borran()'
   ]) as f(firma)
   where has_function_privilege(r.rol, f.firma, 'execute');
  if expuestas > 0 then
    raise exception 'La 0089 dejó % funciones ejecutables por anon/authenticated', expuestas;
  end if;

  select string_agg(c.relname, ', ') into sin_rls
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname = any (tablas)
     and not c.relrowsecurity;
  if sin_rls is not null then
    raise exception 'La 0089 encontró sin RLS: %', sin_rls;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
