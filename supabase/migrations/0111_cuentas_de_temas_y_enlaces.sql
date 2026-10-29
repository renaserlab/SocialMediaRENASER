-- =============================================================================
-- 0111 · Dos cuentas del chat que dejan de recorrer el historial entero
-- =============================================================================
--
-- QUÉ RESUELVE (auditoría de rendimiento, § 5.7, 28/10/2026). Dos números que
-- la API calcula cada vez que se abre una pantalla leían TODOS los mensajes de
-- una conversación para contarlos:
--
--   · `own` de cada tema (`GET /{grupo}/topics`): cuántos mensajes vivos hay en
--     el chat propio del tema. Con 200 000 mensajes, 75,8 ms medidos.
--   · «Enlaces» de `GET /{id}/views`: cuántos mensajes vivos llevan un enlace.
--     Con 200 000 mensajes, 285 ms medidos. Y la aplicación lo vuelve a pedir
--     cada vez que algo cambia en la conversación.
--
-- POR QUÉ UN ÍNDICE Y NO UN TOPE. Lo más barato habría sido contar «hasta 100»
-- y decir «99+». No vale: los dos números se ENSEÑAN tal cual. El de los temas
-- dice «37 escritos aquí» y se repite al confirmar que se elimina el tema. El
-- de los enlaces lo pintaba la pantalla «Contenido» del 09/10 en la pestaña
-- («Enlaces · 1234»), y un teléfono puede seguir con ese código: la
-- aplicación nativa no se actualiza al instante. Con un índice la respuesta de
-- la API es la misma, byte a byte; solo cambia lo que cuesta calcularla.
--
-- QUÉ HACE. Dos índices PARCIALES sobre `messages`. No crea tablas, no añade
-- columnas, no toca ni una fila y no cambia ninguna política.
--
--   1. `messages_vivos_idx` — `(conversation_id, created_at)` de los mensajes
--      NO borrados. Contar los vivos de un chat se contesta leyendo solo el
--      índice, sin abrir la tabla. Lleva `created_at` aunque la cuenta no lo
--      mire, a propósito: uno solo de `conversation_id` sería algo más
--      pequeño, pero podría tentar al planificador, en las consultas de «los
--      vivos de este chat desde tal fecha» (los no leídos), a recorrer el chat
--      entero. Con `created_at` dentro, ese tramo sale del propio índice.
--   2. `messages_con_enlace_idx` — lo mismo, pero solo de los mensajes vivos
--      cuyo texto lleva un enlace. La cuenta de «Enlaces» —y la lista de esa
--      pestaña— lee solo esas filas, no el resto del historial. `created_at`
--      va porque quien vació el chat solo cuenta lo posterior.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ LA CONDICIÓN DEL SEGUNDO ÍNDICE ES UNA COPIA LITERAL de `_MARCAS_DE_ENLACE│
-- │ en `apps/api/app/modules/messaging/vistas.py`. PostgreSQL solo usa un     │
-- │ índice parcial cuando la consulta pide lo mismo que él guarda. Si alguien │
-- │ cambia allí una marca y no rehace este índice, ninguna cuenta sale mal:   │
-- │ simplemente vuelve a ser lenta. Por eso la API escribe esas marcas como   │
-- │ constantes del SQL y no como parámetros: con parámetros, el plan genérico │
-- │ de una sentencia preparada no puede usar el índice.                       │
-- │ `tests/test_cuentas_de_temas_y_enlaces_postgres.py` lo comprueba.         │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- EL CÓDIGO FUNCIONA SIN ELLA, y da los mismos números. La API no pregunta si
-- estos índices existen: sin ellos, cuenta como antes, recorriendo filas. Por
-- eso no hace falta reiniciar la API después de aplicarla.
--
-- LO ÚNICO QUE PUEDE MORDER: EL BLOQUEO AL CREAR LOS ÍNDICES. Como en la 0046,
-- `create index` no deja ESCRIBIR en `messages` mientras se construye (leer
-- sí). Con medio millón de mensajes son menos de un segundo por índice. Si
-- `messages` llegara a ser mucho más grande, se crean a mano, una sentencia
-- cada vez y FUERA de cualquier transacción —el editor de Supabase envuelve el
-- script en una, así que no se puede pegar este fichero tal cual—:
--
--     create index concurrently if not exists messages_vivos_idx
--       on public.messages (conversation_id, created_at)
--       where deleted_at is null;
--     create index concurrently if not exists messages_con_enlace_idx
--       on public.messages (conversation_id, created_at)
--       where deleted_at is null
--         and (body ilike '%http://%' or body ilike '%https://%' or body ilike '%www.%');
--
-- y después se pega este fichero entero, que ya no crea nada y solo comprueba.
-- Si una construcción concurrente se corta, el índice queda INVALID: el
-- bloque de comprobación de abajo lo dice, se borra y se repite.
--
-- LO QUE CUESTA ESCRIBIR. Cada mensaje nuevo añade una entrada al primero y, si
-- lleva enlace, al segundo; mirar si lleva enlace son tres `ILIKE` sobre su
-- texto, una vez. Borrar un mensaje (poner `deleted_at`) ya no puede hacerse
-- sin tocar los índices, porque `deleted_at` entra en su condición: es una
-- escritura algo más cara en algo que pasa pocas veces.
--
-- ES REPETIBLE: se puede ejecutar dos veces sin error y sin cambiar nada.
--
-- CÓMO SE DESHACE (no se pierde nada; las cuentas vuelven a costar lo de antes):
--   drop index if exists public.messages_vivos_idx;
--   drop index if exists public.messages_con_enlace_idx;
-- -----------------------------------------------------------------------------


create index if not exists messages_vivos_idx
  on public.messages (conversation_id, created_at)
  where deleted_at is null;

-- El orden de las tres marcas da igual para el planificador; que sean las
-- mismas, no. Sin `escape`: la API tampoco lo pone para estas tres.
create index if not exists messages_con_enlace_idx
  on public.messages (conversation_id, created_at)
  where deleted_at is null
    and (body ilike '%http://%' or body ilike '%https://%' or body ilike '%www.%');


-- =============================================================================
-- COMPROBACIÓN — aborta (y revierte todo) si algún índice no quedó usable
-- =============================================================================
-- Un índice INVALID existe para `pg_indexes`, pero el planificador no lo usa:
-- las cuentas seguirían saliendo bien y seguirían siendo lentas, sin que nadie
-- se enterase. Lo que falla en silencio se comprueba, no se supone.
do $$
declare
  indice text;
  valido boolean;
begin
  foreach indice in array array['messages_vivos_idx', 'messages_con_enlace_idx'] loop
    select i.indisvalid into valido
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = indice and n.nspname = 'public';

    if valido is null then
      raise exception 'La 0111 no ha creado %.', indice;
    end if;
    if not valido then
      raise exception
        'El índice % existe pero está INVALID (una construcción concurrente '
        'interrumpida). Bórralo con `drop index public.%;` y vuelve a crearlo.',
        indice, indice;
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';

-- Esperado: dos filas, las dos con `valido = true`.
select c.relname as indice,
       i.indisvalid as valido,
       pg_get_expr(i.indpred, i.indrelid) as condicion
from pg_index i
join pg_class c on c.oid = i.indexrelid
where c.relname in ('messages_vivos_idx', 'messages_con_enlace_idx')
order by c.relname;
