-- =============================================================================
-- 0039 — Una sola conversación directa por pareja
-- =============================================================================
--
-- ESTA MIGRACIÓN NO SE HA APLICADO. Se deja preparada a propósito, igual que la
-- 0037 y la 0038: aplicar cambios de esquema contra la base real es una
-- decisión que se toma mirando, no un efecto secundario de arreglar un fallo.
--
-- -----------------------------------------------------------------------------
-- QUÉ FALLO ARREGLA
-- -----------------------------------------------------------------------------
-- Lo reportó una persona usando la aplicación: abrir el perfil de alguien,
-- pulsar «Mensaje», entrar al chat, NO escribir nada, volver atrás y repetir.
-- La bandeja acababa enseñando a la misma persona varias veces, todas con
-- «Sin mensajes aún».
--
-- La causa está en `POST /conversations/direct`: buscaba la conversación y, si
-- no la encontraba, la creaba. Eso NO es atómico. Dos peticiones simultáneas
-- —un doble toque, o un toque más el reintento de una red lenta— hacen las dos
-- el SELECT, las dos no encuentran nada, y las dos insertan. Nada en la base
-- lo impedía.
--
-- El cerrojo que ya tenía la pantalla de perfil es de CLIENTE: vale para dos
-- toques en el mismo teléfono y no cubre el reintento de la red, ni dos
-- pestañas, ni un cliente que no sea el nuestro. La única protección que no
-- depende de que nadie se equivoque es la de la base, y es esto.
--
-- -----------------------------------------------------------------------------
-- QUÉ HACE Y QUÉ NO HACE
-- -----------------------------------------------------------------------------
-- Crea UNA tabla nueva, su índice y sus políticas de lectura. Nada más.
--
-- NO borra ninguna conversación, ningún mensaje y ningún adjunto. NO modifica
-- ni una sola fila existente. NO añade columnas a `conversations` (a propósito:
-- cualquier `select(Entidad)` de SQLAlchemy pide TODAS las columnas mapeadas, y
-- una columna nueva en una tabla tan usada rompe producción en cuanto el modelo
-- se adelanta a la migración; una tabla aparte solo se consulta cuando existe).
-- NO rellena la tabla con las parejas que ya existen — ver más abajo por qué, y
-- por qué eso es justamente lo que hace que este script no pueda fallar aunque
-- hoy haya duplicados.
--
-- Es ADITIVO, REPETIBLE e IDEMPOTENTE de principio a fin.
--
-- -----------------------------------------------------------------------------
-- POR QUÉ UNA TABLA Y NO UN ÍNDICE ÚNICO SOBRE `conversation_members`
-- -----------------------------------------------------------------------------
-- Porque la pareja de un chat directo son DOS filas de `conversation_members`,
-- y un índice único solo puede hablar de UNA fila. No existe forma de decir
-- «no puede haber otra conversación cuyas dos filas sean estas mismas dos
-- personas» con un índice sobre esa tabla.
--
-- Aquí la pareja es UNA fila, y su clave primaria es la garantía entera.
--
-- `user_low` / `user_high` son los dos identificadores ORDENADOS. Sin
-- normalizar, (Ana, Bruno) y (Bruno, Ana) serían dos claves distintas y la
-- restricción no impediría nada: bastaría con que cada uno pulsara desde su
-- lado. El `check` de abajo obliga a que el orden se respete siempre, para que
-- una escritura futura que se olvide de ordenar falle en el sitio correcto en
-- vez de colar un duplicado silencioso.
--
-- -----------------------------------------------------------------------------
-- QUÉ PASA MIENTRAS ESTO NO ESTÉ APLICADO
-- -----------------------------------------------------------------------------
-- La aplicación funciona exactamente igual que hoy, sin errores y sin
-- degradarse. El backend comprueba UNA VEZ por proceso si esta tabla existe
-- (`app/modules/messaging/esquema.py`, `hay_pares_directos`) y:
--
--   - Si NO existe: abrir un chat directo hace lo de siempre —buscar y, si no
--     hay, crear— y la única protección contra el doble toque sigue siendo la
--     del cliente. Es decir: nada mejora, pero nada empeora.
--   - Si existe: además se escribe la fila de pareja dentro de la MISMA
--     transacción, y quien pierda la carrera recibe el error de integridad, lo
--     deshace, vuelve a buscar y devuelve la conversación de quien ganó. Las
--     dos peticiones responden lo mismo y solo hay una conversación.
--
-- Lo que YA está arreglado sin esperar a esta migración: los chats directos
-- SIN NINGÚN MENSAJE han dejado de aparecer en la bandeja (el filtro está en la
-- consulta del listado, no aquí). Curiosear perfiles ya no ensucia Mensajes, y
-- los duplicados vacíos que pudieran existir de antes dejan de verse solos.
--
-- DESPUÉS DE APLICARLA, REINICIA LA API. La comprobación de arriba se hace una
-- vez por proceso y se cachea: sin reiniciar, la API seguirá creyendo que la
-- tabla no existe y no escribirá las filas de pareja.
--
-- -----------------------------------------------------------------------------
-- POR QUÉ NO HAY RELLENO DE LAS PAREJAS QUE YA EXISTEN (y por qué eso es bueno)
-- -----------------------------------------------------------------------------
-- Un `insert ... select` de todas las parejas actuales es exactamente lo que
-- haría que este script FALLARA en producción si hoy ya hay duplicados: dos
-- conversaciones para la misma pareja producen dos filas con la misma clave
-- primaria, y la migración se caería a mitad. Un despliegue roto por intentar
-- arreglar un fallo cosmético es un intercambio pésimo.
--
-- Y no hace falta. La restricción solo tiene que actuar cuando se CREA una
-- conversación directa nueva; para una pareja que ya tiene conversación, el
-- SELECT del backend siempre la encuentra y nunca llega a crear otra. La tabla
-- vacía protege el 100% de los casos que pueden generar un duplicado NUEVO.
--
-- Los duplicados que ya existan NO se tocan aquí. Consolidarlos es una decisión
-- de persona, no de script: implica elegir qué conversación sobrevive y qué
-- pasa con los mensajes de la otra. La consulta de diagnóstico está al final,
-- es de SOLO LECTURA, y sirve para verlo antes de decidir nada.
--
-- -----------------------------------------------------------------------------
-- SOBRE EL BLOQUEO
-- -----------------------------------------------------------------------------
-- `create table` sobre una tabla que no existe no bloquea nada de lo que ya
-- hay. Las claves ajenas toman un `SHARE ROW EXCLUSIVE` momentáneo sobre
-- `profiles` y `conversations` —milisegundos, no bloquean lecturas—. No hay
-- reescritura de tablas ni construcción de índices sobre datos existentes.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La tabla
-- -----------------------------------------------------------------------------
create table if not exists public.direct_conversation_pairs (
  -- Los dos participantes, SIEMPRE en orden. La clave primaria compuesta es
  -- toda la garantía de esta migración: una pareja, una fila, una conversación.
  user_low uuid not null references public.profiles(id) on delete cascade,
  user_high uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  -- Que el orden no sea una convención que alguien pueda olvidar. Sin esto,
  -- una escritura futura que insertara (Bruno, Ana) crearía una segunda clave
  -- para la misma pareja y la restricción dejaría de servir sin avisar.
  constraint direct_conversation_pairs_orden check (user_low < user_high)
);

-- Por conversación: es como lo barrería un borrado y como se comprueba «¿de qué
-- pareja es este chat?». PostgreSQL no indexa las claves ajenas por su cuenta,
-- y la primaria empieza por `user_low`, así que no sirve para esta pregunta.
create index if not exists direct_conversation_pairs_conversacion_idx
  on public.direct_conversation_pairs (conversation_id);


-- -----------------------------------------------------------------------------
-- 2. RLS
--
-- La tabla dice con quién habla cada persona, así que es tan privada como la
-- conversación que apunta. Solo leen los dos implicados. No hay política de
-- `insert`, `update` ni `delete`: quien escribe aquí es la API con su propia
-- conexión, y RLS sin política es «nadie», que es exactamente lo que se quiere
-- para un cliente. `enable row level security` sin ninguna política de lectura
-- dejaría la tabla ilegible incluso para sus dueños, de ahí la de abajo.
-- -----------------------------------------------------------------------------
alter table public.direct_conversation_pairs enable row level security;

drop policy if exists direct_conversation_pairs_read on public.direct_conversation_pairs;
create policy direct_conversation_pairs_read on public.direct_conversation_pairs
  for select using (auth.uid() = user_low or auth.uid() = user_high);

notify pgrst, 'reload schema';


-- =============================================================================
-- 3. COMPROBACIONES — ejecutar ANTES y DESPUÉS. Todas de SOLO LECTURA.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.a DIAGNÓSTICO DE DUPLICADOS HISTÓRICOS — ejecutar ANTES de aplicar.
--
-- Esta consulta NO cambia nada. Solo enseña qué parejas tienen más de una
-- conversación directa hoy, cuántos mensajes vivos tiene cada una y cuándo se
-- creó, que es lo que hace falta para decidir. No la incluye la migración a
-- propósito: reportar antes que consolidar.
--
-- Cómo se lee el resultado:
--
--   - Filas donde TODAS las conversaciones tienen `mensajes = 0`: son las que
--     produjo el fallo del doble toque. Ya no se ven en la bandeja (el listado
--     esconde los chats directos sin mensajes), así que no hay nada urgente que
--     hacer con ellas. Se quedan donde están: borrar es irreversible.
--   - Filas donde MÁS DE UNA tiene mensajes: son las que de verdad piden una
--     decisión humana, porque hay historial repartido entre dos hilos. NO las
--     toca ningún script de este repositorio.
--
--   with pares as (
--     -- `a.user_id < b.user_id` hace dos cosas de una vez: ordena la pareja
--     -- igual que lo hace la tabla, y evita que cada conversación salga dos
--     -- veces (una por cada sentido del auto-JOIN).
--     select
--       c.id         as conversacion,
--       c.created_at,
--       a.user_id    as user_low,
--       b.user_id    as user_high
--     from public.conversations c
--     join public.conversation_members a on a.conversation_id = c.id
--     join public.conversation_members b on b.conversation_id = c.id
--     where c.kind = 'direct' and a.user_id < b.user_id
--   )
--   select
--     p.user_low,
--     p.user_high,
--     count(*) as conversaciones,
--     jsonb_agg(
--       jsonb_build_object(
--         'conversacion', p.conversacion,
--         'creada', p.created_at,
--         'mensajes', (
--           select count(*) from public.messages m
--           where m.conversation_id = p.conversacion and m.deleted_at is null
--         )
--       ) order by p.created_at
--     ) as detalle
--   from pares p
--   group by p.user_low, p.user_high
--   having count(*) > 1
--   order by count(*) desc;
--
-- Esperado si nunca ocurrió el fallo: cero filas.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 3.b La tabla existe, con su clave primaria compuesta y su check.
-- -----------------------------------------------------------------------------
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.direct_conversation_pairs'::regclass
-- order by conname;
-- Esperado: la primaria PRIMARY KEY (user_low, user_high), el check
--           CHECK ((user_low < user_high)) y las tres claves ajenas.

-- -----------------------------------------------------------------------------
-- 3.c La política de lectura está puesta y es la única.
-- -----------------------------------------------------------------------------
-- select policyname, cmd, qual
-- from pg_policies
-- where schemaname = 'public' and tablename = 'direct_conversation_pairs';
-- Esperado: una sola fila, direct_conversation_pairs_read (SELECT).

-- -----------------------------------------------------------------------------
-- 3.d DESPUÉS de aplicar y de reiniciar la API: abrir un chat nuevo escribe su
--     pareja. Si esto sigue vacío después de estrenar una conversación, la API
--     no se ha reiniciado y sigue creyendo que la tabla no existe.
-- -----------------------------------------------------------------------------
-- select count(*) from public.direct_conversation_pairs;
