-- 0076 · Quitar las dos claves ajenas que dejan una cuenta sin poder borrarse.
--
-- AL APLICARLA NO HACE FALTA REINICIAR LA API: no cambia ninguna columna ni
-- ninguna tabla, solo dos claves ajenas. El ORM ya dice lo que esta migracion
-- deja.
--
-- SIN APLICAR.
--
-- QUÉ CORRIGE, Y POR QUÉ EXISTE. La 0074 se aplicó a la base gestionada tal y
-- como estaba en el commit `efc9084`; el commit siguiente, `aee7c60`, le quitó
-- dos claves ajenas al revisar el incremento, pero la base ya llevaba la
-- versión anterior. El fichero de la 0074 NO se toca —una migración aplicada no
-- se reescribe—: la diferencia se corrige aquí.
--
-- LO QUE PASA HOY EN LA BASE GESTIONADA, reproducido en PostgreSQL desechable:
--
--   1. BORRAR UNA CUENTA QUE MOVIÓ INVENTARIO FALLA. `actor_id` tiene
--      `on delete set null`, y «poner a null» es un UPDATE sobre
--      `inventory_movements`. El disparador `inventory_movements_inmutable`
--      rechaza cualquier UPDATE, así que el borrado de la cuenta muere con
--      «El historial de inventario solo se añade: UPDATE no está permitido».
--      Una persona que subió existencias una vez ya no puede irse.
--
--   2. BORRAR UN PRODUCTO CON HISTORIAL FALLA IGUAL DE MAL. `product_id` tiene
--      `on delete cascade`, y el cascade intenta un DELETE que el mismo
--      disparador rechaza: el mensaje habla del historial y no de que el
--      producto tiene almacén.
--
-- QUÉ DEJA EN SU LUGAR:
--
--   * `actor_id` SIN CLAVE AJENA. Quien firmó un movimiento es un hecho del
--     pasado; si esa cuenta desaparece, el hecho sigue siendo cierto y el
--     identificador se queda escrito. Un histórico que se edita solo cuando
--     alguien se va no es un histórico.
--
--   * `product_id` CON `restrict`. Borrar un producto con almacén sigue sin
--     poder hacerse —y debe ser así—, pero ahora lo dice PostgreSQL con su
--     propio mensaje, nombrando la tabla que lo impide.
--
-- NO BORRA NI CAMBIA NINGUNA FILA.
--
-- ROLLBACK: volver a poner las dos claves como estaban.
--   alter table public.inventory_movements
--     add constraint inventory_movements_actor_id_fkey
--     foreign key (actor_id) references public.profiles(id) on delete set null;
--   alter table public.inventory_movements
--     drop constraint inventory_movements_product_id_fkey,
--     add constraint inventory_movements_product_id_fkey
--     foreign key (product_id) references public.products(id) on delete cascade;
-- (Deshacerlo devuelve el defecto: es un rollback, no una alternativa.)

-- ------------------------------------------------------------------------- --
-- 1. El actor se queda escrito, sin clave ajena
-- ------------------------------------------------------------------------- --
alter table public.inventory_movements
  drop constraint if exists inventory_movements_actor_id_fkey;

-- ------------------------------------------------------------------------- --
-- 2. El producto, con `restrict`
-- ------------------------------------------------------------------------- --
-- Se quita y se vuelve a poner con el mismo nombre: en una base donde la 0074
-- se aplicó ya corregida, esto la deja exactamente igual que estaba.
alter table public.inventory_movements
  drop constraint if exists inventory_movements_product_id_fkey;

alter table public.inventory_movements
  add constraint inventory_movements_product_id_fkey
  foreign key (product_id) references public.products(id) on delete restrict;

-- ------------------------------------------------------------------------- --
-- 3. Verificación
-- ------------------------------------------------------------------------- --
do $$
declare
  definicion text;
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.inventory_movements'::regclass
       and contype = 'f'
       and confrelid = 'public.profiles'::regclass
  ) then
    raise exception 'inventory_movements sigue teniendo una clave ajena a profiles';
  end if;

  select pg_get_constraintdef(oid) into definicion
    from pg_constraint
   where conrelid = 'public.inventory_movements'::regclass
     and conname = 'inventory_movements_product_id_fkey';
  if definicion is null then
    raise exception 'la 0076 no dejó la clave ajena al producto';
  end if;
  if definicion not like '%ON DELETE RESTRICT%' then
    raise exception 'la clave ajena al producto no es restrict: %', definicion;
  end if;
end;
$$;
