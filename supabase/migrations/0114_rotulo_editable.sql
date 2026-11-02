-- 0114 · El rótulo del directo se mueve, se gira y se viste
--
-- QUÉ RESUELVE (propuesta aprobada el 02/11/2026, «Rótulo del directo»):
--
--   · que quien emite —o la administración— pueda ARRASTRAR el texto que pone
--     sobre la imagen a cualquier sitio de la zona libre, cambiarle el TAMAÑO
--     y GIRARLO, como en TikTok;
--   · que pueda elegir su COLOR (paleta cerrada de ocho), su FONDO (sin fondo
--     con sombra, velo o sólido) y su LETRA (clásica, fuerte o máquina).
--
-- Sigue siendo UN solo texto por emisión, y lo siguen editando los mismos de
-- siempre: lo decide la API (`_puede_gestionar`). El texto NO entra en la
-- grabación: es una capa que pinta cada teléfono encima de la imagen.
--
-- QUÉ HACE. Añade siete columnas a `live_spotlights` (0099), todas con un
-- valor que reproduce el rótulo de antes: arriba, centrado, al 100 %, recto,
-- en blanco, sobre velo y con la letra de la aplicación.
--
--   · `banner_x`, `banner_y`: el CENTRO del texto, en fracciones de la pantalla
--     (0 a 1). Nulas = «el sitio de siempre», debajo de la cabecera. Van
--     juntas: o las dos o ninguna. Cada teléfono encaja ese punto en SU zona
--     libre (entre su cabecera y su chat), así que nunca tapa nada aunque las
--     pantallas midan distinto.
--   · `banner_scale`: el tamaño, en tanto por ciento, de 70 a 240 y de cinco
--     en cinco.
--   · `banner_rotation`: el giro, en grados enteros, de -180 a 180.
--   · `banner_color`, `banner_background`, `banner_font`: nombres, no colores.
--     Qué color es cada nombre lo decide la aplicación con sus tokens, igual
--     que `banner_style` dice cómo se mueve sin decir cuántos milisegundos.
--
-- QUÉ NO HACE.
--   · No crea tablas, ni índices, ni políticas. La RLS de `live_spotlights`
--     sigue activada y SIN políticas: estas filas solo las lee y escribe la API.
--   · No toca ninguna fila: las columnas nuevas nacen con su valor por
--     omisión, que es exactamente como se pintaba el rótulo hasta hoy. Añadir
--     una columna con un valor fijo no reescribe la tabla en PostgreSQL 11+.
--   · No entra en la publicación de tiempo real: el aviso sigue siendo la
--     difusión vacía `live-destacado:{id}` y cada teléfono vuelve a preguntar.
--
-- SE PUEDE DESPLEGAR EL CÓDIGO ANTES O DESPUÉS. Sin estas columnas la API
-- sigue poniendo y quitando el texto como hasta hoy, contesta 503
-- (`live_spotlight_layout_not_available`) a moverlo, y dice
-- `banner_layout: false` para que la aplicación no ofrezca arrastrarlo ni
-- vestirlo (`recommendations/esquema.py::hay_rotulo_editable`). Tras aplicarla
-- hay que REINICIAR la API: lo que averigua del esquema lo recuerda por proceso.
--
-- IDEMPOTENTE: se puede ejecutar dos veces.
--
-- VUELTA ATRÁS (y REINICIAR la API):
--   alter table public.live_spotlights
--     drop column if exists banner_x, drop column if exists banner_y,
--     drop column if exists banner_scale, drop column if exists banner_rotation,
--     drop column if exists banner_color, drop column if exists banner_background,
--     drop column if exists banner_font;
-- Se pierde dónde estaba cada texto y de qué color; el texto se queda.

alter table public.live_spotlights
  add column if not exists banner_x real,
  add column if not exists banner_y real,
  add column if not exists banner_scale smallint not null default 100,
  add column if not exists banner_rotation smallint not null default 0,
  add column if not exists banner_color text not null default 'blanco',
  add column if not exists banner_background text not null default 'velo',
  add column if not exists banner_font text not null default 'clasica';

-- El centro, dentro de la pantalla. `NaN` no pasa: en PostgreSQL es mayor que
-- cualquier número, así que falla el «<= 1».
alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_x_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_x_check
  check (banner_x is null or (banner_x >= 0 and banner_x <= 1));

alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_y_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_y_check
  check (banner_y is null or (banner_y >= 0 and banner_y <= 1));

-- Un punto con una sola coordenada no es un sitio.
alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_xy_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_xy_check
  check ((banner_x is null) = (banner_y is null));

alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_scale_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_scale_check
  check (banner_scale between 70 and 240 and banner_scale % 5 = 0);

alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_rotation_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_rotation_check
  check (banner_rotation between -180 and 180);

alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_color_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_color_check
  check (banner_color in ('blanco', 'negro', 'esmeralda', 'oro', 'rojo', 'azul', 'amarillo', 'rosa'));

alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_background_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_background_check
  check (banner_background in ('ninguno', 'velo', 'solido'));

alter table public.live_spotlights
  drop constraint if exists live_spotlights_banner_font_check;
alter table public.live_spotlights
  add constraint live_spotlights_banner_font_check
  check (banner_font in ('clasica', 'fuerte', 'maquina'));

-- Comprobación: las siete columnas están y la tabla sigue cerrada al cliente.
do $$
declare
  columnas integer;
  con_rls boolean;
  politicas integer;
begin
  select count(*) into columnas
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'live_spotlights'
    and column_name in (
      'banner_x', 'banner_y', 'banner_scale', 'banner_rotation',
      'banner_color', 'banner_background', 'banner_font'
    );
  if columnas <> 7 then
    raise exception 'La 0114 esperaba 7 columnas nuevas en live_spotlights y hay %.', columnas;
  end if;

  select relrowsecurity into con_rls
  from pg_class
  where oid = 'public.live_spotlights'::regclass;
  if not coalesce(con_rls, false) then
    raise exception 'live_spotlights ha perdido la RLS.';
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

select
  count(*) as rotulos,
  count(*) filter (where banner_x is not null) as con_sitio_propio
from public.live_spotlights;
