-- 0099 · Lo destacado de un directo: el mensaje fijado y el rótulo de quien emite
--
-- QUÉ RESUELVE (documento «Z bugs y nuevas funcionalidades», 07/10/2026):
--
--   · que quien emite pueda FIJAR un mensaje del chat, para que no se lo lleve
--     la conversación y lo vea también quien entra después;
--   · que quien emite pueda poner un TEXTO PROPIO sobre la imagen, a la vista
--     de toda la audiencia —un aviso, un tema, una llamada—.
--
-- Ninguna de las dos cosas tenía dónde guardarse: el chat es una lista que
-- corre, y la emisión solo tiene título y descripción.
--
-- QUÉ HACE. Crea `live_spotlights`: UNA fila por emisión, con lo que está
-- destacado AHORA. Se guarda lo vigente, no un historial: fijar otro mensaje
-- sustituye al anterior, y quitar el rótulo lo deja a nulo.
--
-- QUÉ NO HACE.
--   · No toca `live_sessions`, `live_messages`, `live_guests` ni una sola fila
--     existente. Las columnas van en una tabla aparte A PROPÓSITO: añadidas a
--     `live_sessions`, el código nuevo desplegado antes que esta migración no
--     podría ni leer una emisión, y se caerían todos los directos.
--   · No entra en la publicación de tiempo real: el aviso de «lo destacado
--     cambió» viaja por difusión entre los clientes y cada uno le pregunta
--     después a la API, que es la que manda (igual que los invitados, 0098).
--   · No deja leer ni escribir al cliente. Ver más abajo.
--
-- SE PUEDE DESPLEGAR EL CÓDIGO ANTES O DESPUÉS. Sin esta tabla la API contesta
-- 503 (`live_spotlight_not_available`) a lo de destacar, la aplicación no
-- enseña esas opciones y el resto del directo funciona igual que antes
-- (`recommendations/esquema.py::hay_destacado_de_directo`). Tras aplicarla hay
-- que REINICIAR la API: lo que averigua del esquema lo recuerda por proceso.
--
-- IDEMPOTENTE: se puede ejecutar dos veces.
--
-- VUELTA ATRÁS: `drop table public.live_spotlights;` Y REINICIAR LA API. Las
-- emisiones, su chat y sus invitados no se enteran.

create table if not exists public.live_spotlights (
  session_id uuid primary key references public.live_sessions(id) on delete cascade,

  -- El mensaje fijado. `SET NULL`: los mensajes no se borran (se esconden),
  -- pero si un día se borrara uno, lo fijado desaparece con él y la fila —que
  -- puede llevar además el rótulo— se queda.
  pinned_message_id uuid references public.live_messages(id) on delete set null,
  pinned_by uuid references public.profiles(id) on delete set null,
  pinned_at timestamptz,

  -- El rótulo: el texto que quien emite pone sobre la imagen.
  banner_text text,
  -- Cómo se mueve. La aplicación sabe pintar estos tres; uno que no conozca
  -- lo pinta como el primero.
  banner_style text not null default 'slide',
  banner_by uuid references public.profiles(id) on delete set null,
  banner_at timestamptz,

  updated_at timestamptz not null default now()
);

-- Ochenta caracteres: es un rótulo, no un párrafo. Tiene que leerse de un
-- vistazo encima de un vídeo, en un teléfono, sin tapar a quien habla.
alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_text_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_text_check
  check (banner_text is null or char_length(banner_text) between 1 and 80);

alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_style_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_style_check
  check (banner_style in ('slide', 'pulse', 'ticker'));

-- Al esconder un mensaje se mira si era el fijado.
create index if not exists live_spotlights_pinned_message_idx
  on public.live_spotlights (pinned_message_id)
  where pinned_message_id is not null;

alter table public.live_spotlights enable row level security;

-- NINGUNA POLÍTICA, NI DE LECTURA. Con RLS activada eso significa que desde el
-- cliente no se puede ni leer ni escribir: estas filas solo las toca la API.
-- Si el cliente pudiera escribirlas, cualquiera pondría su texto sobre el
-- directo de otra persona, delante de su público. Y la lectura pasa por la API
-- porque ahí se aplican las mismas reglas que al chat: un mensaje escondido no
-- se enseña fijado, ni el de alguien a quien quien mira tiene bloqueado.

do $$
declare
  con_rls boolean;
  politicas integer;
begin
  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.live_spotlights'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'La 0099 no ha dejado RLS activada en live_spotlights.';
  end if;

  select count(*) into politicas
  from pg_policies
  where schemaname = 'public'
    and tablename = 'live_spotlights';
  if politicas > 0 then
    raise exception
      'live_spotlights tiene % política(s). No debe tener ninguna: estas '
      'filas solo las lee y las escribe la API.',
      politicas;
  end if;
end
$$;

notify pgrst, 'reload schema';
