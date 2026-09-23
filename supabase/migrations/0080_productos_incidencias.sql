-- 0080 · Incidencias de un pedido entregado: expediente, evidencia y resolucion.
--
-- AL APLICARLA, REINICIAR LA API. La puerta de esquema cachea tambien el «no»
-- en la memoria del proceso: sin reiniciar, las rutas siguen contestando 503
-- aunque las tablas ya esten.
--
-- SIN APLICAR. Requiere la 0070, la 0078 y la 0079.
--
-- QUE ES UNA INCIDENCIA Y QUE NO. Es que algo llego mal: danado, incorrecto,
-- incompleto, que no funciona, que no es lo que se describia, que se sospecha
-- falsificado, o que directamente no llego. «YA NO LO QUIERO» NO ES UNA
-- INCIDENCIA: eso es desistimiento, lo dice el blueprint §10 con esas palabras,
-- y tiene plazos y consecuencias distintas. Por eso no esta en la lista.
--
-- LA CUARTA MAQUINA, Y SIGUE SIENDO SUYA. Pedido, pago, envio e incidencia son
-- cuatro cosas que cambian por su cuenta. Esta migracion NO anade ni un valor
-- a `product_orders.status` ni a `product_shipments.status`, y hay una
-- comprobacion abajo que se pone roja si alguien lo intenta.
--
-- LO QUE ESTA MIGRACION NO HACE, Y ES LA MITAD DE SU TRABAJO:
--
--   * NO DEVUELVE DINERO. No hay columna de importe reembolsado, ni referencia
--     de reembolso, ni estado de pasarela. Una resolucion dice QUE SE DECIDIO;
--     que el dinero se haya movido es del Incremento 9 y no existe.
--   * NO REPONE INVENTARIO. No hay ninguna escritura sobre `product_inventory`
--     ni sobre `inventory_movements`. Donde esta una unidad danada lo decide
--     una persona, no un disparador.
--   * NO FIJA NINGUN PLAZO DE Z. El blueprint pide «tres dias habiles», y
--     «habil» depende de un calendario de festivos que nadie ha definido: no
--     hay columna de fecha limite de la decision. Inventarsela seria prometer
--     una fecha que no podemos cumplir ni medir.
--
-- LAS 48 HORAS DEL PROVEEDOR SI ESTAN, y no son una decision nuestra: el
-- blueprint §10.1 dice «48 horas exactas desde la notificacion», que es exacto
-- y sin ambiguedad. Se transcribe, igual que se transcribieron los pesos de la
-- matriz de evaluacion. Lo que la migracion guarda es la FECHA LIMITE ya
-- calculada, para que el barrido de escalada no tenga que saber el numero.
--
-- UN CASO VIVO POR LINEA, Y UNO POR PEDIDO. Dos indices unicos parciales y no
-- uno: `order_item_id` es nulo cuando el caso es de todo el pedido —la entrega
-- negada— y en PostgreSQL dos nulos no chocan entre si, asi que un solo indice
-- dejaria abrir diez veces el mismo caso de «no me llego».
--
-- ROLLBACK, en este orden:
--   drop table public.product_incident_events;
--   drop table public.product_incident_evidence;
--   drop table public.product_incidents;
--   drop function public.product_incident_solo_se_anade();
--   delete from storage.buckets where id = 'product-incidents';  -- si esta vacio
--
--   LIMITACION DEL ROLLBACK: los archivos de evidencia que ya se subieron
--   siguen en el deposito. Borrar el deposito con archivos dentro falla a
--   proposito: son las pruebas de una disputa y no se tiran sin que alguien lo
--   decida.

-- ------------------------------------------------------------------------- --
-- 1. El deposito privado de la evidencia
-- ------------------------------------------------------------------------- --
-- OTRO DEPOSITO Y NO `product-media`. Aquel guarda el catalogo, que se firma
-- para cualquiera que mire un producto; esto son las fotos del salon de quien
-- compro, y solo pueden verlas quien abrio el caso, quien tiene que responder y
-- quien lo resuelve. Mezclarlos haria que un fallo de permisos en uno se
-- llevara por delante el otro.
insert into storage.buckets (id, name, public)
values ('product-incidents', 'product-incidents', false)
on conflict (id) do nothing;

update storage.buckets
set
  -- 10 MB, lo mismo que la galeria: es una foto hecha con un telefono.
  file_size_limit = 10::bigint * 1024 * 1024,
  -- LISTA EXPLICITA Y CERRADA, nunca `null` —que admite cualquier cosa— y
  -- nunca `image/*`, que deja pasar SVG: un SVG es un documento con scripts.
  --
  -- SIN VIDEO, Y NO ES UN OLVIDO. El blueprint pide video para una falla
  -- funcional, pero un video no se puede validar como se valida una imagen:
  -- de una imagen se abre el contenido y se comprueba que es lo que dice ser;
  -- de un contenedor de video solo se puede mirar la cabecera. Aceptar un
  -- binario sin validar dentro del expediente de una disputa es justo donde no
  -- se recortan esquinas. Queda anotado como pendiente.
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'product-incidents';

-- SIN POLITICAS A PROPOSITO. La unica puerta es la API, que es la que sabe si
-- quien pregunta es parte de ese caso. Se borran por si una ejecucion anterior
-- las dejo puestas.
drop policy if exists product_incidents_read on storage.objects;
drop policy if exists product_incidents_write on storage.objects;

-- ------------------------------------------------------------------------- --
-- 2. El expediente
-- ------------------------------------------------------------------------- --
create table if not exists public.product_incidents (
  id uuid primary key default gen_random_uuid(),

  -- `restrict` en los tres: un pedido con un caso abierto no se borra, y la
  -- linea reclamada tiene que seguir siendo legible.
  order_id uuid not null
    references public.product_orders(id) on delete restrict,
  -- NULO CUANDO EL CASO ES DE TODO EL PEDIDO. Hoy solo pasa con la entrega
  -- negada: no hay una linea concreta de la que quejarse porque no llego nada.
  order_item_id uuid
    references public.product_order_items(id) on delete restrict,

  -- SE COPIAN LOS DOS LADOS. Quien reclama y quien responde son un hecho de
  -- este caso, y leerlos del pedido cada vez haria que un cambio de
  -- responsable comercial reescribiera quien tenia que contestar.
  buyer_id uuid not null
    references public.profiles(id) on delete restrict,
  seller_id uuid not null
    references public.product_sellers(id) on delete restrict,

  reason text not null
    constraint product_incidents_motivo
    check (
      reason in (
        'DAMAGED',
        'NOT_AS_DESCRIBED',
        'WRONG_ITEM',
        'MISSING_PARTS',
        'NOT_WORKING',
        'SUSPECTED_COUNTERFEIT',
        'OTHER',
        'DELIVERY_DISPUTED'
      )
    ),
  -- «descripcion minima de 20 caracteres», literal del blueprint §10.
  description text not null
    constraint product_incidents_descripcion
    check (length(trim(description)) between 20 and 2000),

  status text not null default 'OPEN'
    constraint product_incidents_estado
    check (
      status in (
        'OPEN',
        'MORE_EVIDENCE_REQUESTED',
        'SELLER_RESPONDED',
        'MEDIATION',
        'RESOLVED',
        'APPEALED',
        'WITHDRAWN'
      )
    ),

  -- LAS 48 HORAS DEL PROVEEDOR, ya calculadas. Nulo mientras la pelota no sea
  -- suya: no puede correrle el reloj mientras espera a que le manden evidencia.
  seller_response_due_at timestamptz,
  seller_responded_at timestamptz,
  -- LO QUE PROPUSO, que no es lo que se decidio.
  seller_proposal text
    constraint product_incidents_propuesta
    check (
      seller_proposal is null
      or seller_proposal in (
        'RETURN_AND_FULL_REFUND',
        'FULL_REFUND_WITHOUT_RETURN',
        'PARTIAL_REFUND',
        'REPLACEMENT',
        'REJECT_CLAIM',
        'REQUEST_MORE_EVIDENCE'
      )
    ),

  -- LA RESOLUCION LA REGISTRA Z, Y NUNCA ES `REQUEST_MORE_EVIDENCE`: pedir mas
  -- evidencia es un paso, no una salida. Un expediente al que se le pide mas
  -- evidencia no esta resuelto, y contarlo como resuelto daria un numero falso.
  resolution text
    constraint product_incidents_resolucion
    check (
      resolution is null
      or resolution in (
        'RETURN_AND_FULL_REFUND',
        'FULL_REFUND_WITHOUT_RETURN',
        'PARTIAL_REFUND',
        'REPLACEMENT',
        'REJECT_CLAIM'
      )
    ),
  resolved_at timestamptz,
  -- Sin clave ajena: quien resolvio un caso es un hecho del pasado.
  resolved_by uuid,

  -- RESOLVER NO ES PAGAR. El efecto nace PENDIENTE y nadie lo ejecuta: mover
  -- el dinero es del Incremento 9 y no existe. `NOT_APPLICABLE` es para las
  -- resoluciones que no deben nada, como rechazar la reclamacion.
  financial_effect text
    constraint product_incidents_efecto
    check (financial_effect is null or financial_effect in ('PENDING', 'NOT_APPLICABLE')),

  -- UNA SOLA APELACION, y el blueprint dice dentro de 48 horas. Que ademas
  -- lleve evidencia NUEVA lo comprueba el servidor, porque «nueva» es
  -- «posterior a la resolucion» y eso se sabe mirando las fechas.
  appeal_due_at timestamptz,
  appealed_at timestamptz,
  appeals_used integer not null default 0
    constraint product_incidents_una_apelacion
    check (appeals_used between 0 and 1),

  withdrawn_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UNA RESOLUCION TIENE FECHA, AUTOR Y EFECTO DECLARADO.
  constraint product_incidents_resuelta_completa
    check (
      status <> 'RESOLVED'
      or (
        resolution is not null
        and resolved_at is not null
        and resolved_by is not null
        and financial_effect is not null
      )
    ),
  -- Y AL REVES: no hay resolucion sin estar resuelta o apelada. Una resolucion
  -- escrita sobre un caso abierto seria una decision que nadie tomo.
  constraint product_incidents_resolucion_con_estado
    check (resolution is null or status in ('RESOLVED', 'APPEALED')),
  constraint product_incidents_apelada_con_fecha
    check (status <> 'APPEALED' or appealed_at is not null),
  constraint product_incidents_retirada_con_fecha
    check (status <> 'WITHDRAWN' or withdrawn_at is not null),
  constraint product_incidents_respondida_con_fecha
    check (
      seller_responded_at is null
      or (seller_proposal is not null)
    ),
  -- EL CASO DE TODO EL PEDIDO ES SOLO EL DE LA ENTREGA NEGADA. Cualquier otro
  -- motivo habla de algo que llego mal, y para eso hay una linea concreta.
  constraint product_incidents_linea_salvo_entrega
    check (order_item_id is not null or reason = 'DELIVERY_DISPUTED')
);

-- UN CASO VIVO POR LINEA. Parcial por los estados vivos: cerrado uno, se puede
-- abrir otro, que es lo razonable si aparece un problema distinto.
create unique index if not exists product_incidents_uno_vivo_por_linea
  on public.product_incidents (order_id, order_item_id)
  where order_item_id is not null
    and status in ('OPEN', 'MORE_EVIDENCE_REQUESTED', 'SELLER_RESPONDED',
                   'MEDIATION', 'APPEALED');

-- Y UNO VIVO POR PEDIDO cuando no hay linea. Hace falta el segundo indice
-- porque en PostgreSQL dos nulos NO chocan entre si: con uno solo se podria
-- abrir diez veces el mismo «no me llego».
create unique index if not exists product_incidents_uno_vivo_por_pedido
  on public.product_incidents (order_id)
  where order_item_id is null
    and status in ('OPEN', 'MORE_EVIDENCE_REQUESTED', 'SELLER_RESPONDED',
                   'MEDIATION', 'APPEALED');

-- LO QUE MIRA QUIEN COMPRO: sus casos, los mas nuevos primero.
create index if not exists product_incidents_del_comprador
  on public.product_incidents (buyer_id, created_at desc, id desc);

-- LO QUE TIENE QUE CONTESTAR EL PROVEEDOR.
create index if not exists product_incidents_del_proveedor
  on public.product_incidents (seller_id, created_at desc, id desc);

-- LA COLA DE MEDIACION: lo que espera a una persona de Z.
create index if not exists product_incidents_en_mediacion
  on public.product_incidents (created_at, id)
  where status in ('MEDIATION', 'APPEALED');

-- LO QUE BUSCA EL BARRIDO DE ESCALADA: casos cuyo plazo del proveedor vencio.
-- POR EL PLAZO Y NO POR EL ESTADO, igual que el vencimiento de reservas: si se
-- filtrara solo por estado, un caso que cambia de estado se escaparia del
-- barrido con el reloj corriendo.
create index if not exists product_incidents_por_escalar
  on public.product_incidents (seller_response_due_at, id)
  where seller_response_due_at is not null and status = 'OPEN';

-- ------------------------------------------------------------------------- --
-- 3. La evidencia
-- ------------------------------------------------------------------------- --
-- SE GUARDA LA RUTA DEL ALMACENAMIENTO, NUNCA UNA URL. Una firmada caduca, y
-- guardarla haria que la evidencia de una disputa dejara de cargar sin que
-- nadie tocara nada. Hay un CHECK que rechaza cualquier cosa con `://`.
create table if not exists public.product_incident_evidence (
  id uuid primary key default gen_random_uuid(),

  incident_id uuid not null
    references public.product_incidents(id) on delete restrict,

  -- QUIEN LA APORTO. Sin clave ajena: es un hecho del pasado, y hace falta para
  -- distinguir la evidencia de quien reclama de la de quien responde.
  uploaded_by uuid,
  uploaded_role text not null
    constraint product_incident_evidence_rol
    check (uploaded_role in ('buyer', 'seller', 'admin')),

  storage_path text not null
    constraint product_incident_evidence_ruta
    check (length(trim(storage_path)) between 1 and 500 and storage_path not like '%://%'),
  content_type text not null
    constraint product_incident_evidence_tipo
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null
    constraint product_incident_evidence_peso
    check (byte_size > 0 and byte_size <= 10485760),
  -- DOS CHECK Y NO UNO. El de la expresion regular es el bueno, pero ese
  -- operador es de PostgreSQL y la suite monta su esquema desde los modelos de
  -- SQLAlchemy sobre SQLite, donde `~` es un error de sintaxis. Asi que el
  -- de la LONGITUD se declara en los dos sitios —y lo ve la suite— y el de la
  -- forma vive solo aqui, que es donde puede vivir. Es la misma decision que
  -- ya estaba tomada para `product_orders_huella`.
  checksum_sha256 text not null
    constraint product_incident_evidence_huella_larga
    check (length(checksum_sha256) = 64)
    constraint product_incident_evidence_huella
    check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null constraint product_incident_evidence_ancho check (width > 0),
  height integer not null constraint product_incident_evidence_alto check (height > 0),

  caption text
    constraint product_incident_evidence_texto
    check (caption is null or length(trim(caption)) between 1 and 300),

  created_at timestamptz not null default now(),

  -- EL MISMO ARCHIVO NO SE CUENTA DOS VECES. Subir dos veces la misma foto para
  -- llegar al minimo de dos no es aportar dos evidencias.
  constraint product_incident_evidence_una_vez
    unique (incident_id, checksum_sha256)
);

create index if not exists product_incident_evidence_del_caso
  on public.product_incident_evidence (incident_id, created_at, id);

-- ------------------------------------------------------------------------- --
-- 4. El historial
-- ------------------------------------------------------------------------- --
create table if not exists public.product_incident_events (
  id uuid primary key default gen_random_uuid(),

  incident_id uuid not null
    references public.product_incidents(id) on delete restrict,

  from_status text
    constraint product_incident_events_desde
    check (from_status is null or length(from_status) <= 40),
  to_status text not null
    constraint product_incident_events_hasta
    check (length(to_status) <= 40),

  -- Sin clave ajena: quien movio un caso es un hecho del pasado.
  actor_id uuid,
  actor_role text not null
    constraint product_incident_events_rol
    check (actor_role in ('buyer', 'seller', 'admin', 'system')),

  -- AQUI SI VA EL TEXTO LIBRE, y es correcto que vaya: este expediente lo leen
  -- quien reclama, quien responde y quien resuelve, que son las tres personas
  -- que ya conocen el caso. Lo que NO puede pasar es que salga de aqui a una
  -- lista general o a la auditoria compartida.
  note text
    constraint product_incident_events_nota
    check (note is null or length(trim(note)) between 3 and 1000),

  created_at timestamptz not null default now()

  -- NADA DE DATOS DE PAGO. Ni referencia de cobro, ni importe, ni tarjeta: un
  -- expediente de incidencia no necesita saber con que se pago.
);

create index if not exists product_incident_events_del_caso
  on public.product_incident_events (incident_id, created_at, id);

-- ------------------------------------------------------------------------- --
-- 5. Lo que se escribe no se reescribe
-- ------------------------------------------------------------------------- --
-- EL HISTORIAL Y LA EVIDENCIA SOLO SE ANADEN. Es la misma proteccion que el
-- historial de inventario, el del pedido y el del envio. Aqui pesa mas que en
-- ninguno: esto es el expediente de una disputa, y un expediente que se puede
-- editar no es un expediente, es una version de los hechos.
--
-- Y LA EVIDENCIA TAMPOCO SE BORRA, ni siquiera por quien la subio. Retirar una
-- foto despues de que la otra parte la haya visto es reescribir lo que se
-- discutio. Si una evidencia no vale, se dice en el historial.
create or replace function public.product_incident_solo_se_anade()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'El expediente de una incidencia solo se anade: % no esta permitido', tg_op;
end;
$$;

drop trigger if exists product_incident_events_inmutables
  on public.product_incident_events;
create trigger product_incident_events_inmutables
  before update or delete on public.product_incident_events
  for each row execute function public.product_incident_solo_se_anade();

drop trigger if exists product_incident_evidence_inmutable
  on public.product_incident_evidence;
create trigger product_incident_evidence_inmutable
  before update or delete on public.product_incident_evidence
  for each row execute function public.product_incident_solo_se_anade();

-- ------------------------------------------------------------------------- --
-- 6. RLS y permisos
-- ------------------------------------------------------------------------- --
-- Ninguna politica y ningun permiso suelto, igual que en la 0078 y la 0079.
-- Aqui es todavia mas claro: una politica de lectura sobre estas tablas seria
-- repartir las fotos del salon de quien compro y el texto de una disputa.
alter table public.product_incidents enable row level security;
alter table public.product_incident_evidence enable row level security;
alter table public.product_incident_events enable row level security;

revoke all on public.product_incidents from anon, authenticated;
revoke all on public.product_incident_evidence from anon, authenticated;
revoke all on public.product_incident_events from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 7. Verificacion
-- ------------------------------------------------------------------------- --
do $$
declare
  faltan text;
  permisos bigint;
  publico boolean;
  tipos text[];
  politicas bigint;
begin
  select string_agg(t, ', ') into faltan
    from unnest(array[
      'product_incidents', 'product_incident_evidence', 'product_incident_events'
    ]) as t
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
   );
  if faltan is not null then
    raise exception 'La 0080 no dejo estas tablas: %', faltan;
  end if;

  -- LOS DOS DISPARADORES DEL EXPEDIENTE.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.product_incident_events'::regclass
       and tgname = 'product_incident_events_inmutables'
  ) then
    raise exception 'La 0080 no dejo el disparador del historial';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.product_incident_evidence'::regclass
       and tgname = 'product_incident_evidence_inmutable'
  ) then
    raise exception 'La 0080 no dejo el disparador de la evidencia';
  end if;

  -- LOS DOS INDICES QUE IMPIDEN ABRIR EL MISMO CASO DOS VECES. Hacen falta los
  -- dos: con uno solo, dos nulos no chocan y el caso de todo el pedido se
  -- podria abrir diez veces.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'product_incidents_uno_vivo_por_linea'
  ) then
    raise exception 'La 0080 no dejo el indice de un caso vivo por linea';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'product_incidents_uno_vivo_por_pedido'
  ) then
    raise exception 'La 0080 no dejo el indice de un caso vivo por pedido';
  end if;

  -- LAS OTRAS TRES MAQUINAS NO SE ENTERAN DE ESTA. Si alguien mete un estado de
  -- incidencia en el pedido o en el envio, las junto sin decirlo.
  if exists (
    select 1 from pg_constraint
     where conname in ('product_orders_estado', 'product_shipments_estado')
       and (pg_get_constraintdef(oid) like '%MEDIATION%'
            or pg_get_constraintdef(oid) like '%RESOLVED%')
  ) then
    raise exception 'El estado del pedido ni el del envio pueden hablar de incidencias';
  end if;

  -- NI IMPORTES, NI REFERENCIAS DE REEMBOLSO, NI PLAZOS DE Z. Si aparecen, es
  -- que alguien amplio el alcance sin decirlo: devolver dinero es del
  -- Incremento 9 y «tres dias habiles» no se puede calcular.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'product_incidents'
       and column_name in (
         'refund_amount_minor', 'refund_reference', 'refunded_at',
         'decision_due_at', 'transfer_status'
       )
  ) then
    raise exception 'La incidencia no devuelve dinero ni fija plazos de Z';
  end if;

  -- EL DEPOSITO, PRIVADO Y CON LISTA CERRADA.
  select public, allowed_mime_types into publico, tipos
    from storage.buckets where id = 'product-incidents';
  if publico is null then
    raise exception 'La 0080 no dejo el deposito product-incidents';
  end if;
  if publico then
    raise exception 'El deposito product-incidents es PUBLICO y no debe serlo';
  end if;
  if tipos is null or array_length(tipos, 1) is null then
    raise exception 'El deposito product-incidents admite cualquier tipo';
  end if;

  select count(*) into politicas
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and qual like '%product-incidents%';
  if politicas > 0 then
    raise exception
      'El deposito product-incidents tiene % politicas; solo entra por la API',
      politicas;
  end if;

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in (
       'product_incidents', 'product_incident_evidence', 'product_incident_events'
     )
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'Las incidencias tienen % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';
