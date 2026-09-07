-- 0051 · El disparador de inmutabilidad de versiones protege también el origen.
--
-- POR QUÉ EXISTE ESTA MIGRACIÓN Y NO SE EDITÓ LA 0050. Porque la 0050 YA ESTÁ
-- APLICADA. Editarla en el repositorio dejaría dos versiones del mismo fichero
-- —la que corrió de verdad y la que dice el proyecto—, y la próxima persona no
-- tendría forma de saber cuál está en cada base. Una corrección posterior a una
-- migración aplicada es siempre otra migración.
--
-- QUÉ SE ENCONTRÓ. Al verificar la 0050 contra la base donde se aplicó, la
-- definición real de `impedir_reescritura_de_version` protegía `snapshot`,
-- `content_hash`, `version` y `course_id`, pero NO `origin`. Y `origin` es
-- justamente lo que distingue una versión publicada de verdad de una
-- reconstruida por el backfill:
--
--     update public.course_versions set origin = 'publish' where origin = 'backfill';
--
-- Con eso, una fotografía armada en SQL a partir del estado actual del curso
-- —incompleta por construcción— pasaría a presentarse como prueba de lo que se
-- vendió. Es exactamente la mentira que el backfill se cuida de no contar.
--
-- `published_at` y `published_by` entran con ella por lo mismo: son la firma de
-- la publicación, y una firma que se puede reescribir no firma nada.
--
-- SOBRE UNA BASE NUEVA ESTA MIGRACIÓN NO CAMBIA NADA, y conviene saberlo para
-- no leerla como si sostuviera algo. El fichero 0050 de este repositorio YA
-- lleva las tres comparaciones —se añadieron antes de esta fase—, así que quien
-- monte una base desde cero aplicando las migraciones en orden ya tiene la
-- función correcta y la 0051 se limita a reescribirla igual. Existe por la base
-- donde alguien aplicó a mano una revisión anterior de la 0050: allí sí falta.
--
-- ES IDEMPOTENTE Y NO TOCA NI UNA FILA. `create or replace function` sustituye
-- el cuerpo; los disparadores ya existentes pasan a usar el nuevo sin
-- recrearlos. Aplicarla dos veces no hace nada la segunda.
--
-- ROLLBACK. Volver a la definición de la 0050, que es esta misma sin las tres
-- comparaciones nuevas. No hay datos que deshacer.

create or replace function public.impedir_reescritura_de_version()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Una version de curso no se borra: es lo que alguien compro'
      using errcode = 'restrict_violation';
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

-- El disparador no se recrea: ya apunta a esta función por nombre. Se comprueba
-- que sigue en pie, porque una función corregida sin disparador que la llame no
-- protege nada.
do $$
begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal
      and c.relname = 'course_versions'
      and t.tgname = 'course_versions_inmutable'
  ) then
    raise exception '0051: falta el disparador course_versions_inmutable';
  end if;
end $$;

notify pgrst, 'reload schema';
