-- ---------------------------------------------------------------------------
-- 0036 — Acceso v2: el derecho manda, la compra vieja se respeta
--
-- QUE CAMBIA. `has_course_access()` (migracion 0016) sabia mirar en un solo
-- sitio: `purchases`. Con el dominio comercial de la 0035, el acceso lo
-- concede `entitlements`. Esta migracion enseña a la funcion a mirar los dos.
--
-- LA REGLA QUE MANDA AQUI, POR ENCIMA DE TODO LO DEMAS:
--
--     QUIEN TENIA ACCESO ANTES LO CONSERVA DESPUES.
--
-- Por eso `purchases` NO se borra, NO se vacia y NO se le cambia ni una
-- politica. Sigue ahi, entera, y `has_course_access()` la sigue consultando.
-- El dia que se quiera retirar ese respaldo sera otra migracion, con las filas
-- ya trasvasadas y comprobadas, y se podra volver atras. Quitarlo hoy —el
-- mismo dia que se estrena el dominio nuevo— significaria que un fallo en el
-- trasvase deja sin su curso a gente que pago, y eso no se arregla con un
-- «vuelve a intentarlo».
--
-- LAS CINCO VIAS DE ACCESO, y ninguna se puede perder:
--
--   1. Curso GRATUITO          -> no hay nada que cobrar.
--   2. AUTOR del curso         -> siempre entra a su propio material.
--   3. ADMINISTRACION          -> gestiona el catalogo entero.
--   4. ENTITLEMENT activo      -> lo nuevo. La fuente de verdad.
--   5. `purchases` en 'paid'   -> el respaldo del trasvase. Lo que ya habia.
--
-- La numero 1 es la mas facil de perder de vista y la que mas daño hace:
-- sin ella, esta migracion dejaria sin acceso a TODO EL MUNDO de golpe.
--
-- LO NUEVO: `has_lesson_access()`. Hasta ahora una leccion valia lo que valia
-- su curso, asi que no habia forma de enseñar una muestra: o se compraba todo
-- o no se veia nada. Con las lecciones marcadas `is_preview` (migracion 0034)
-- una muestra se reproduce sin comprar, y —esto es lo que importa— se
-- reproduce DE VERDAD, porque quien decide es la politica del almacenamiento
-- y no la aplicacion. El bucket `course-media` sigue PRIVADO: lo que cambia es
-- a quien deja firmar una URL, no que deje de haber puerta.
--
-- SI LA 0034 TODAVIA NO ESTA APLICADA, este script se aplica igual: crea
-- `has_lesson_access()` sin la via de muestra, que es exactamente lo que hay
-- hoy. Cuando llegue la 0034 se vuelve a correr este fichero y la via aparece.
-- La regla del proyecto —desplegar no puede exigir que otra migracion concreta
-- ya este puesta— vale tambien para el SQL.
--
-- El script es REPETIBLE e IDEMPOTENTE. El trasvase usa `on conflict do
-- nothing`: correrlo diez veces deja lo mismo que correrlo una.
--
-- DESPUES DE APLICARLA, REINICIA LA API.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 0. Dependencia dura: la 0035
-- ---------------------------------------------------------------------------
-- Sin las tablas del comercio, `has_course_access()` no puede consultar
-- derechos. Se corta aqui, antes de tocar nada, con un mensaje que dice que
-- falta: dejar la funcion a medias seria peor que no aplicarla.
do $$
begin
  if to_regclass('public.entitlements') is null
     or to_regclass('public.commerce_products') is null then
    raise exception
      'Falta la migracion 0035_comercio.sql: no existen entitlements/commerce_products. Aplicala antes que esta.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 1. has_course_access v2
-- ---------------------------------------------------------------------------
--
-- `security definer` sigue siendo obligatorio: la funcion consulta
-- `entitlements` y `purchases`, y las dos tienen RLS de «solo lo mio». Sin el,
-- la propia RLS recortaria la consulta que hace la funcion y una compra
-- legitima no se veria: acceso denegado a quien pago.
--
-- `search_path` fijado por seguridad: sin el, quien pueda crear objetos en un
-- esquema del search_path del llamante podria colar su propia `purchases`.
create or replace function public.has_course_access(target_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.courses c
    where c.id = target_course_id
      and (
        -- 1. Gratuito: no hay nada que cobrar.
        c.price_minor = 0
        -- 2. Quien lo creo siempre entra a su propio material.
        or c.author_id = auth.uid()
        -- 3. La administracion gestiona el catalogo entero.
        or public.is_admin()
        -- 4. DERECHO ACTIVO. La fuente de verdad del acceso.
        --    `expires_at` nulo = permanente, que es todo lo que hay hoy. La
        --    comparacion se escribe igualmente para que el dia que exista una
        --    suscripcion no haya que acordarse de anadirla aqui: un derecho
        --    caducado no da acceso aunque nadie haya pasado a marcarlo.
        or exists (
          select 1
          from public.entitlements e
          join public.commerce_products cp on cp.id = e.commerce_product_id
          where e.user_id = auth.uid()
            and e.status = 'active'
            and (e.expires_at is null or e.expires_at > now())
            and cp.kind = 'course_lifetime'
            and cp.course_id = c.id
        )
        -- 5. RESPALDO DEL TRASVASE. Compra confirmada en la tabla vieja.
        --    'pending' NO basta: un cobro iniciado y no completado no da
        --    derecho al contenido. Esta via se conserva para que nadie pierda
        --    lo que ya tenia; se retirara en otra migracion, no en esta.
        or exists (
          select 1 from public.purchases p
          where p.course_id = c.id
            and p.user_id = auth.uid()
            and p.status = 'paid'
        )
      )
  );
$$;

comment on function public.has_course_access(uuid) is
  'true si la sesion actual puede ver el contenido de pago de un curso: gratuito, autor, administracion, entitlement activo o compra heredada en paid.';


-- ---------------------------------------------------------------------------
-- 2. has_lesson_access — la muestra se ve sin comprar
-- ---------------------------------------------------------------------------
--
-- Se crea de dos formas segun exista o no `course_lessons.is_preview`, para
-- que este fichero se pueda aplicar antes o despues de la 0034. La version sin
-- muestra se comporta EXACTAMENTE como hoy: la leccion vale lo que vale su
-- curso.
--
-- Ojo con el orden de las condiciones: `is_preview` va PRIMERO. Es una lectura
-- de una fila por su clave; `has_course_access()` son varios EXISTS. En una
-- politica de almacenamiento esto se evalua por cada objeto listado.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'course_lessons'
      and column_name = 'is_preview'
  ) then
    execute $funcion$
      create or replace function public.has_lesson_access(target_lesson_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $cuerpo$
        select exists (
          select 1
          from public.course_lessons l
          join public.course_modules m on m.id = l.module_id
          where l.id = target_lesson_id
            and (
              -- Muestra: el autor la marco para que se pueda ver antes de
              -- comprar. Es la unica via nueva.
              coalesce(l.is_preview, false)
              -- O el acceso de siempre al curso entero.
              or public.has_course_access(m.course_id)
            )
        );
      $cuerpo$;
    $funcion$;
  else
    raise notice
      'La migracion 0034 no esta aplicada: course_lessons.is_preview no existe. has_lesson_access() se crea SIN la via de muestra (se comporta como hoy). Vuelve a correr este fichero despues de la 0034.';
    execute $funcion$
      create or replace function public.has_lesson_access(target_lesson_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $cuerpo$
        select exists (
          select 1
          from public.course_lessons l
          join public.course_modules m on m.id = l.module_id
          where l.id = target_lesson_id
            and public.has_course_access(m.course_id)
        );
      $cuerpo$;
    $funcion$;
  end if;
end
$$;

comment on function public.has_lesson_access(uuid) is
  'true si la sesion actual puede ver una leccion concreta: es una muestra (is_preview) o tiene acceso al curso.';


-- ---------------------------------------------------------------------------
-- 3. Donde se aplica: el almacenamiento
-- ---------------------------------------------------------------------------
--
-- Es la politica que de verdad cierra la puerta. Una URL firmada solo se puede
-- emitir si esta politica deja leer el objeto, asi que no importa lo que
-- decida la aplicacion: fue exactamente el agujero que corrigio la 0016 y no
-- se reabre aqui. Lo unico que cambia es que la pregunta pasa de «¿tienes el
-- curso?» a «¿puedes ver ESTA leccion?».
--
-- El bucket sigue PRIVADO. No se toca `storage.buckets`.
drop policy if exists course_media_read on storage.objects;
create policy course_media_read on storage.objects
  for select to authenticated using (
    bucket_id = 'course-media'
    and (
      public.is_admin()
      -- Video de una leccion.
      or exists (
        select 1
        from public.course_lessons l
        where l.media_path = storage.objects.name
          and public.has_lesson_access(l.id)
      )
      -- Documento adjunto de una leccion. Va por leccion y no por curso a
      -- proposito: si la leccion es una muestra, su material tambien lo es.
      -- Preguntar cosas distintas al video y a su PDF acaba en la
      -- incoherencia de siempre —la pantalla promete algo que el
      -- almacenamiento niega—, que es justo lo que se quiere evitar.
      or exists (
        select 1
        from public.course_lesson_resources r
        where r.storage_path = storage.objects.name
          and public.has_lesson_access(r.lesson_id)
      )
    )
  );

-- La tabla de recursos, alineada con la politica de arriba por la misma razon.
drop policy if exists course_lesson_resources_read on public.course_lesson_resources;
create policy course_lesson_resources_read on public.course_lesson_resources
  for select using (public.has_lesson_access(lesson_id));

-- La comprobacion se hace en CADA lectura de contenido, asi que los indices
-- importan tanto como las politicas.
create index if not exists course_lessons_media_path_idx
  on public.course_lessons (media_path);
create index if not exists course_lesson_resources_path_idx
  on public.course_lesson_resources (storage_path);
create index if not exists purchases_user_course_idx
  on public.purchases (user_id, course_id, status);


-- ---------------------------------------------------------------------------
-- 4. EL TRASVASE. Aditivo, idempotente y sin destruir nada.
-- ---------------------------------------------------------------------------
--
-- Nada de lo que viene borra, vacia ni actualiza una sola fila de `purchases`.
-- Solo LEE de ahi y ESCRIBE en las tablas nuevas. Si el trasvase saliera mal,
-- el acceso sigue funcionando por la via 5 y se puede rehacer.
--
-- Dos casos distintos, y confundirlos seria inventar cobros que no existieron:
--
--   a) `provider = 'manual'` con `amount_minor = 0`: alguien concedio el curso
--      a mano —una beca, una compensacion, una prueba—. NO hubo compra. Se
--      traduce a MATRICULA, no a derecho comprado.
--   b) Cualquier otra compra en 'paid': hubo dinero. Se traduce a ENTITLEMENT,
--      que es lo que de verdad concede acceso.
--
-- `source = 'legacy'` marca las del caso (a) para poder distinguirlas siempre
-- de las de quien pulso «apuntarme» en un curso gratuito ('free'). Sin esa
-- marca, el dia que se limpien matriculas nadie sabria cual era cual.

-- 4.1 Los productos que faltan. Un `course_lifetime` por cada curso con
--     compras reales pagadas. El indice unico parcial de la 0035 hace que
--     repetir esto no cree duplicados.
insert into public.commerce_products (kind, course_id, active)
select distinct 'course_lifetime', p.course_id, true
from public.purchases p
where p.status = 'paid'
  and not (p.provider = 'manual' and p.amount_minor = 0)
on conflict (course_id) where kind = 'course_lifetime' do nothing;

-- 4.2 Caso (b): compra real -> derecho activo.
--     `granted_at` conserva la fecha original: el historial no se reescribe.
--     `transaction_id` queda nulo porque no hay fila en `payment_transactions`
--     que corresponda; inventarla seria inventar un cobro.
--
--     `distinct on` porque nada impide que la misma persona tenga dos filas
--     pagadas del mismo curso —`purchases` solo es unica por (proveedor,
--     transaccion)—. Se queda la MAS ANTIGUA: la fecha en que esa persona
--     obtuvo el acceso por primera vez es la verdadera.
insert into public.entitlements
  (user_id, commerce_product_id, status, source_provider, granted_at)
select distinct on (p.user_id, cp.id)
       p.user_id, cp.id, 'active', p.provider, p.purchased_at
from public.purchases p
join public.commerce_products cp
  on cp.course_id = p.course_id and cp.kind = 'course_lifetime'
where p.status = 'paid'
  and not (p.provider = 'manual' and p.amount_minor = 0)
order by p.user_id, cp.id, p.purchased_at asc
on conflict (user_id, commerce_product_id) where status = 'active' do nothing;

-- 4.3 Caso (b): y su matricula, para que el curso aparezca en «mis cursos».
insert into public.course_enrollments (user_id, course_id, source, created_at)
select distinct on (p.user_id, p.course_id)
       p.user_id, p.course_id, 'entitlement', p.purchased_at
from public.purchases p
where p.status = 'paid'
  and not (p.provider = 'manual' and p.amount_minor = 0)
order by p.user_id, p.course_id, p.purchased_at asc
on conflict (user_id, course_id) do nothing;

-- 4.4 Caso (a): concesion manual sin importe -> matricula, sin derecho.
--     Su acceso lo sigue sosteniendo la via 5 (`purchases` en 'paid'), que es
--     justo por lo que esa via no se retira en esta migracion.
--
--     Va DESPUES del 4.3 y con `do nothing`: si alguien tiene las dos cosas
--     —una concesion manual y una compra real del mismo curso— gana la que
--     dice que pago, que es mas informativa.
insert into public.course_enrollments (user_id, course_id, source, created_at)
select distinct on (p.user_id, p.course_id)
       p.user_id, p.course_id, 'legacy', p.purchased_at
from public.purchases p
where p.status = 'paid'
  and p.provider = 'manual'
  and p.amount_minor = 0
order by p.user_id, p.course_id, p.purchased_at asc
on conflict (user_id, course_id) do nothing;


-- ---------------------------------------------------------------------------
-- 5. Refrescar el cache de esquema de PostgREST
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- 6. Comprobaciones
-- ---------------------------------------------------------------------------

-- Las dos funciones existen. Esperado: dos filas en OK.
select 'has_course_access' as comprobacion,
       case when exists (select 1 from pg_proc where proname = 'has_course_access')
            then 'OK' else 'FALTA' end as estado
union all
select 'has_lesson_access',
       case when exists (select 1 from pg_proc where proname = 'has_lesson_access')
            then 'OK' else 'FALTA' end;

-- La politica del almacenamiento pregunta por LECCION. Esperado: una fila que
-- contenga has_lesson_access.
select policyname, qual::text like '%has_lesson_access%' as pregunta_por_leccion
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'course_media_read';

-- El bucket sigue PRIVADO. Esperado: course-media | false
select id, public from storage.buckets where id = 'course-media';

-- EL TRASVASE ESTA COMPLETO. Esperado: CERO filas.
-- Cada fila que salga es una compra REAL y pagada que no genero derecho: esa
-- persona sigue entrando por la via 5, pero el dia que se retire el respaldo
-- se quedaria fuera. Se arregla volviendo a correr el apartado 4.
select p.user_id, p.course_id, p.provider, p.amount_minor
from public.purchases p
where p.status = 'paid'
  and not (p.provider = 'manual' and p.amount_minor = 0)
  and not exists (
    select 1
    from public.entitlements e
    join public.commerce_products cp on cp.id = e.commerce_product_id
    where e.user_id = p.user_id
      and e.status = 'active'
      and cp.course_id = p.course_id
      and cp.kind = 'course_lifetime'
  );

-- CUANTA GENTE DEPENDE TODAVIA DEL RESPALDO. Son las concesiones manuales sin
-- importe: a proposito no tienen derecho, porque no hubo compra. Este numero
-- es el que hay que mirar ANTES de retirar la via 5 en una migracion futura;
-- si es mayor que cero, retirarla les quita el curso.
select count(*) as accesos_que_solo_sostiene_purchases
from public.purchases p
join public.courses c on c.id = p.course_id
where p.status = 'paid'
  and p.provider = 'manual'
  and p.amount_minor = 0
  and c.price_minor > 0
  and c.author_id <> p.user_id;

-- Cuanto se trasvaso, para poder cuadrarlo a ojo.
select
  (select count(*) from public.purchases where status = 'paid') as compras_pagadas,
  (select count(*) from public.entitlements where status = 'active') as derechos_activos,
  (select count(*) from public.course_enrollments) as matriculas,
  (select count(*) from public.commerce_products) as productos;

-- `purchases` INTACTA: sigue teniendo su politica de lectura y ninguna nueva.
-- Esperado: purchases_read_own | SELECT
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'purchases'
order by policyname;
