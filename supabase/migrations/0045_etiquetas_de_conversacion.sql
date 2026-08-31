-- =============================================================================
-- 0045 — Etiquetas de conversación (el CRM ligero de la bandeja)
-- =============================================================================
--
-- ESTA MIGRACIÓN ESTÁ APLICADA en producción (31 de agosto de 2026, confirmado
-- por quien la ejecutó). Es idempotente —todo con `if not exists` y las
-- políticas con `drop policy if exists` delante— y no toca ni una fila: no hay
-- `insert`, ni `update`, ni `delete`. Volver a pasarla es un no-op.
--
-- Se aplicó ANTES de desplegar el código que la usa, que es el orden correcto
-- para una migración aditiva: las tablas esperan al código, no al revés.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ EL CÓDIGO FUNCIONA SIN ESTA MIGRACIÓN. Quien lo comprueba es              │
-- │ `messaging.esquema.hay_etiquetas_de_conversacion`: mientras las tablas no │
-- │ existan, listar etiquetas devuelve una lista VACÍA y crear una responde   │
-- │ 503 `conversation_labels_not_available`. Nunca un 500: un 500 sin         │
-- │ capturar sale por Starlette sin cabeceras CORS y el navegador lo enseña   │
-- │ como un fallo de red, que manda a mirar al sitio equivocado.              │
-- │ La bandeja, mientras tanto, funciona exactamente igual que hoy: las       │
-- │ etiquetas son una capa ENCIMA de las conversaciones, no una parte de      │
-- │ ellas.                                                                    │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- QUÉ ES. Organizar la bandeja con etiquetas propias —«Seguimiento»,
-- «Interesado», «Alumno», las que cada uno necesite— y poder filtrar por ellas.
-- Es un CRM en el sentido estricto de la palabra: categorías persistentes que
-- pone una persona. NO hay embudo, ni oportunidades, ni importes, ni puntuación
-- de contactos, y no es un olvido: nada de eso se pidió y todo eso arrastraría
-- columnas que después habría que mantener.
--
-- -----------------------------------------------------------------------------
-- LA REGLA QUE JUSTIFICA TODO EL DISEÑO: LAS ETIQUETAS SON PRIVADAS
-- -----------------------------------------------------------------------------
-- La etiqueta que Darren le pone a su conversación con Edson es de Darren.
-- **Edson no puede enterarse jamás**: ni en el detalle de la conversación, ni en
-- la lista, ni en un contador, ni por la diferencia entre dos códigos de error.
--
-- Esto no es una preferencia de producto. Una etiqueta es un juicio sobre otra
-- persona («Pendiente», «No interesado»), y una herramienta de trabajo que
-- filtra ese juicio hacia el juzgado deja de ser una herramienta de trabajo.
--
-- De ahí salen las tres decisiones del modelo:
--
-- 1. LA ETIQUETA CUELGA DE SU DUEÑO, NO DE LA CONVERSACIÓN. `owner_id` está en
--    `conversation_labels`, así que una etiqueta existe aunque no esté asignada
--    a nada y sigue existiendo si la conversación se vacía. La alternativa
--    —columna en `conversations`— habría sido compartida por definición: los
--    dos miembros leen esa misma fila.
--
-- 2. LAS ASIGNACIONES NO SABEN DE PERSONAS, SOLO DE ETIQUETAS.
--    `conversation_label_assignments` NO lleva `owner_id`, y eso es
--    deliberado: el dueño se deduce SIEMPRE de la etiqueta. Repetirlo aquí
--    crearía dos fuentes de verdad que pueden discrepar, y el día que
--    discreparan la que decide quién ve qué sería la equivocada.
--
-- 3. NINGUNA POLÍTICA TIENE PUERTA DE ATRÁS PARA MODERACIÓN. En este proyecto
--    casi todas las tablas llevan `or public.is_admin()`. Aquí NO, y es la
--    excepción a propósito: «privado» que admite un lector más no es privado.
--    Si algún día hiciera falta para una investigación, es una decisión que se
--    toma escribiéndola, no una que se hereda por costumbre.
--
-- -----------------------------------------------------------------------------
-- POR QUÉ DOS TABLAS NUEVAS Y NINGUNA COLUMNA NUEVA
-- -----------------------------------------------------------------------------
-- Es la misma razón que ya está escrita en la 0039 y en la 0042: un
-- `select(Entidad)` de SQLAlchemy pide TODAS las columnas mapeadas, así que una
-- columna nueva en `conversations` —que se consulta en cada apertura de la
-- bandeja— rompe producción en cuanto el modelo se adelanta a la migración. Una
-- tabla aparte solo se consulta cuando existe.
--
-- ES ADITIVA. Crea dos tablas, tres índices y sus políticas. NO borra nada, NO
-- modifica ni una fila existente, NO añade columnas a ninguna tabla que ya haya
-- y NO cambia lo que devuelve ningún endpoint de hoy. Todo con `if not exists`,
-- así que volver a ejecutarla no hace daño.
--
-- LA VUELTA ATRÁS ES QUITAR EL CÓDIGO, NO LAS TABLAS. Si hubiera que revertir,
-- basta con dejar de llamar a estos endpoints: las tablas vacías no molestan a
-- nadie y borrarlas destruiría el trabajo de organización de quien ya hubiera
-- etiquetado. Una vuelta atrás de este proyecto no puede pedir borrar datos.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Las etiquetas de cada persona
-- -----------------------------------------------------------------------------
create table if not exists public.conversation_labels (
  id uuid primary key default gen_random_uuid(),

  -- QUIÉN ORGANIZA SU BANDEJA. No es «la persona etiquetada»: eso no existe
  -- aquí. Si la cuenta desaparece, sus etiquetas se van con ella (`cascade`),
  -- porque no le sirven a nadie más y nadie más puede leerlas.
  owner_id uuid not null references public.profiles(id) on delete cascade,

  -- Como lo escribió su dueño, con mayúsculas y acentos. Es lo que se pinta.
  -- El tope de 40 no es un número redondo por gusto: es lo que cabe en un chip
  -- de la fila horizontal sin partirlo ni empujar a los demás fuera de la
  -- pantalla. Una etiqueta que no se lee entera no ordena nada.
  nombre text not null check (char_length(nombre) between 1 and 40),

  -- El mismo nombre en minúsculas y sin espacios de sobra. NO se pinta nunca:
  -- existe solo para que la restricción de unicidad de abajo pueda decidir.
  --
  -- POR QUÉ UNA COLUMNA Y NO UN ÍNDICE SOBRE `lower(trim(nombre))`. Porque
  -- «normalizar» es una regla de producto que tiene que ser LA MISMA en la base
  -- y en el backend (`etiquetas.normalizar`), y una expresión escondida en un
  -- índice no se puede leer desde el código ni probar. Con la columna, la
  -- consulta de «¿ya existe esta etiqueta?» compara exactamente lo mismo que
  -- comparó la base al escribirla.
  nombre_normalizado text not null,

  created_at timestamptz not null default now(),

  -- DOS ETIQUETAS IGUALES DE LA MISMA PERSONA NO TIENEN SENTIDO: dos chips con
  -- el mismo texto y contenidos distintos es peor que no tener chips. Que sea
  -- por `owner_id` y no global es la otra mitad: «Alumnos» de uno no tiene nada
  -- que ver con «Alumnos» de otro, y reservar nombres entre desconocidos
  -- filtraría —por el error de duplicado— que alguien ya usa ese nombre.
  constraint conversation_labels_unicas unique (owner_id, nombre_normalizado)
);

comment on table public.conversation_labels is
  'CRM ligero: las etiquetas con las que UNA persona organiza su bandeja. Son '
  'PRIVADAS: el otro participante de la conversacion no las ve jamas.';


-- Las etiquetas de una persona, de la más antigua a la más nueva: es
-- exactamente como se leen (una sola consulta al abrir la bandeja). El orden va
-- en el índice porque los chips se pintan siempre en el mismo sitio; una fila
-- de filtros que se reordena sola es una fila en la que no se puede confiar la
-- memoria muscular.
create index if not exists conversation_labels_owner_idx
  on public.conversation_labels (owner_id, created_at);


-- -----------------------------------------------------------------------------
-- 2. Qué conversación lleva qué etiqueta
-- -----------------------------------------------------------------------------
create table if not exists public.conversation_label_assignments (
  label_id uuid not null
    references public.conversation_labels(id) on delete cascade,
  conversation_id uuid not null
    references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- LA CLAVE PRIMARIA COMPUESTA ES LO QUE HACE IDEMPOTENTE ASIGNAR DOS VECES.
  -- No hace falta comprobarlo en código, y no se comprueba: un `select` antes
  -- del `insert` deja siempre una ventana entre los dos —el doble toque, el
  -- reintento de una red lenta— y esa ventana es justo el fallo que la 0039 y
  -- la 0043 tuvieron que cerrar en otras tablas. Aquí la cierra la base desde
  -- el primer día, y el backend inserta con `on conflict do nothing`.
  primary key (label_id, conversation_id)
);

comment on table public.conversation_label_assignments is
  'Que conversacion lleva que etiqueta. NO lleva owner_id a proposito: el dueno '
  'sale SIEMPRE de conversation_labels, para que no haya dos fuentes de verdad '
  'sobre quien puede ver esto.';


-- «Qué etiquetas tiene ESTA conversación» (para mí). La clave primaria empieza
-- por `label_id`, así que no sirve para buscar por conversación: sin este
-- índice, pintar la bandeja recorrería la tabla entera por cada fila.
create index if not exists conversation_label_assignments_conversacion_idx
  on public.conversation_label_assignments (conversation_id);

-- «Las conversaciones de ESTA etiqueta, las más recientes primero.» Es el
-- filtro de los chips, y es el único acceso que además pagina: sin la fecha en
-- el índice, cada página ordenaría a mano el conjunto entero.
--
-- (El prefijo `label_id` ya lo cubre la clave primaria; lo que añade este
-- índice es el ORDEN, que es lo que la paginación necesita.)
create index if not exists conversation_label_assignments_etiqueta_fecha_idx
  on public.conversation_label_assignments (label_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 3. RLS — la privacidad, dicha otra vez donde no depende del backend
-- -----------------------------------------------------------------------------
-- El acceso preferente es por BACKEND, que es donde vive la política completa
-- (incluida la pertenencia a la conversación, que RLS también comprueba abajo).
-- Estas políticas son la segunda cerradura: si mañana alguien lee estas tablas
-- con el `anon key` desde el móvil —como ya se hace con `messages` para
-- Realtime—, la privacidad no puede depender de que se acuerde de filtrar.
--
-- SIN NINGUNA POLÍTICA, `enable row level security` ya lo niega todo. Cada
-- política de abajo es un permiso que se CONCEDE, y no hay ninguna que conceda
-- leer lo de otro.
alter table public.conversation_labels enable row level security;
alter table public.conversation_label_assignments enable row level security;

-- Cada uno ve las suyas y solo las suyas. Sin `or public.is_admin()`, a
-- diferencia de casi todas las demás tablas del proyecto: ver arriba.
drop policy if exists conversation_labels_read on public.conversation_labels;
create policy conversation_labels_read on public.conversation_labels for select
  using (owner_id = auth.uid());

-- Solo se crean etiquetas en nombre propio. Sin esto, bastaría con mandar el
-- `owner_id` de otra persona para meterle un chip en su bandeja.
drop policy if exists conversation_labels_insert_own on public.conversation_labels;
create policy conversation_labels_insert_own on public.conversation_labels for insert
  with check (owner_id = auth.uid());

-- Renombrar. El `with check` va además del `using` a propósito: el `using`
-- decide qué filas se pueden tocar y el `with check` cómo pueden quedar. Sin el
-- segundo, se podría renombrar una etiqueta propia y de paso CAMBIARLE el
-- dueño, o sea regalársela a alguien que no la ha pedido.
drop policy if exists conversation_labels_update_own on public.conversation_labels;
create policy conversation_labels_update_own on public.conversation_labels for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Borrar la etiqueta se lleva sus asignaciones por `cascade` y NO TOCA NINGUNA
-- CONVERSACIÓN. Quitar una carpeta no quita lo que había dentro.
drop policy if exists conversation_labels_delete_own on public.conversation_labels;
create policy conversation_labels_delete_own on public.conversation_labels for delete
  using (owner_id = auth.uid());


-- Una asignación se ve si se ve su etiqueta. Es la regla entera, y por eso el
-- dueño vive en un solo sitio: aquí no hay nada que se pueda quedar desfasado.
drop policy if exists conversation_label_assignments_read
  on public.conversation_label_assignments;
create policy conversation_label_assignments_read
  on public.conversation_label_assignments for select using (
    exists (
      select 1 from public.conversation_labels l
      where l.id = label_id and l.owner_id = auth.uid()
    )
  );

-- Asignar exige DOS cosas, y la segunda es la que no es evidente:
--
--   a) que la etiqueta sea mía;
--   b) que yo pertenezca a la conversación.
--
-- Sin (b), cualquiera podría intentar etiquetar identificadores de conversación
-- al azar y AVERIGUAR CUÁLES EXISTEN por la diferencia entre «guardado» y
-- «clave ajena inválida». No haría falta poder leer nada: la respuesta ya es la
-- información. Es el mismo razonamiento por el que `borrar_mensaje` comprueba
-- la pertenencia ANTES de buscar el mensaje.
--
-- `is_conversation_member` es la función `security definer` de la 0001, y se
-- usa en vez de un `exists` sobre `conversation_members` porque esa tabla tiene
-- su propia RLS: un `exists` corriente aquí se evaluaría con ella puesta y
-- podría decir que no soy miembro de un sitio donde sí estoy.
drop policy if exists conversation_label_assignments_insert_own
  on public.conversation_label_assignments;
create policy conversation_label_assignments_insert_own
  on public.conversation_label_assignments for insert with check (
    exists (
      select 1 from public.conversation_labels l
      where l.id = label_id and l.owner_id = auth.uid()
    )
    and public.is_conversation_member(conversation_id)
  );

-- Quitar la etiqueta de una conversación. NO se exige seguir siendo miembro: si
-- a alguien lo sacaron de un grupo, tiene que poder limpiar su propia bandeja.
drop policy if exists conversation_label_assignments_delete_own
  on public.conversation_label_assignments;
create policy conversation_label_assignments_delete_own
  on public.conversation_label_assignments for delete using (
    exists (
      select 1 from public.conversation_labels l
      where l.id = label_id and l.owner_id = auth.uid()
    )
  );

-- NO HAY POLÍTICA DE UPDATE PARA LAS ASIGNACIONES, y es deliberado: las dos
-- columnas que importan SON la clave primaria, así que «cambiar» una asignación
-- es quitarla y poner otra. Una política de update aquí solo podría servir para
-- mover una fila de una etiqueta a otra saltándose las comprobaciones del
-- insert.


-- -----------------------------------------------------------------------------
-- 4. Que PostgREST se entere del esquema nuevo sin reiniciar nada
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- =============================================================================
-- COMPROBACIONES (ejecutar a mano DESPUÉS, una a una)
-- =============================================================================
--
-- 1. Las dos tablas existen con sus columnas.
-- select table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('conversation_labels', 'conversation_label_assignments')
-- order by table_name, ordinal_position;
-- Esperado: conversation_label_assignments → label_id, conversation_id, created_at.
--           conversation_labels → id, owner_id, nombre, nombre_normalizado, created_at.
--           Ninguna columna admite nulos salvo ninguna: todas son `not null`.
--
-- 2. La unicidad por dueño y las claves ajenas están puestas.
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.conversation_labels'::regclass
-- order by conname;
-- Esperado: la primaria, conversation_labels_unicas UNIQUE (owner_id,
--           nombre_normalizado), el check del nombre y la clave ajena a profiles.
--
-- 3. La clave primaria compuesta —la que hace idempotente asignar dos veces—.
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.conversation_label_assignments'::regclass
-- order by conname;
-- Esperado: PRIMARY KEY (label_id, conversation_id) y las dos claves ajenas,
--           las dos con ON DELETE CASCADE.
--
-- 4. Los tres índices.
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public'
--   and tablename in ('conversation_labels', 'conversation_label_assignments')
-- order by tablename, indexname;
-- Esperado: los dos de clave primaria, conversation_labels_owner_idx,
--           conversation_label_assignments_conversacion_idx y
--           conversation_label_assignments_etiqueta_fecha_idx.
--
-- 5. LA RLS ESTÁ ACTIVADA EN LAS DOS. Si esto devuelve `false` en alguna, la
--    tabla es legible por cualquier cuenta autenticada: parar y arreglarlo
--    antes de seguir.
-- select relname, relrowsecurity from pg_class
-- where oid in ('public.conversation_labels'::regclass,
--               'public.conversation_label_assignments'::regclass);
-- Esperado: las dos a `t`.
--
-- 6. Las políticas están puestas y NO HAY NINGUNA MÁS.
-- select tablename, policyname, cmd, qual, with_check from pg_policies
-- where schemaname = 'public'
--   and tablename in ('conversation_labels', 'conversation_label_assignments')
-- order by tablename, policyname;
-- Esperado: 4 sobre conversation_labels (read/insert/update/delete) y 3 sobre
--           conversation_label_assignments (read/insert/delete). Ninguna con
--           `is_admin()`, y ninguna de UPDATE sobre las asignaciones.
--
-- 7. NADA se ha tocado de lo que ya había: las conversaciones y los mensajes
--    siguen exactamente igual, porque esta migración no los menciona.
-- select
--   (select count(*) from public.conversations) as conversaciones,
--   (select count(*) from public.messages) as mensajes,
--   (select count(*) from public.conversation_labels) as etiquetas,
--   (select count(*) from public.conversation_label_assignments) as asignaciones;
-- Esperado: los dos primeros, los mismos números que antes de ejecutar esto;
--           los dos últimos, 0.
