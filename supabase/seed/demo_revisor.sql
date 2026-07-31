-- ===========================================================================
-- Cuenta de demostración para la revisión de App Store y Google Play
-- ===========================================================================
--
-- Apple exige credenciales que funcionen para poder revisar la app: sin ellas,
-- quien revisa se queda en la pantalla de acceso y rechaza por «app
-- incompleta» (directriz 2.1). Google Play pide lo mismo en la ficha.
--
-- ANTES de ejecutar esto hay que crear la persona usuaria en el panel de
-- Supabase: Authentication → Users → Add user, marcando «Auto Confirm User».
--
-- Se hace ahí a propósito y no aquí. Escribir en `auth.users` a mano obliga a
-- cifrar la contraseña y a crear la fila de `auth.identities` por nuestra
-- cuenta, sobre un esquema que mantiene Supabase y que cambia entre versiones.
-- Si algo saliera mal, el síntoma sería que quien revisa no puede entrar: el
-- peor fallo posible, y justo el que esta cuenta existe para evitar.
--
-- La CONTRASEÑA no aparece en este archivo ni debe hacerlo. Vive solo en el
-- panel de Supabase y en la ficha de App Store Connect. Este repositorio es
-- exactamente el sitio donde no debe estar.
--
-- Este script se puede repetir sin miedo: no crea nada dos veces.
-- ===========================================================================

do $$
declare
  -- Único sitio que hay que tocar si se cambia la dirección.
  v_email    text := 'testgoogle@gmail.com';
  v_user_id  uuid;
  v_cursos   integer;
begin
  select id into v_user_id from auth.users where email = v_email;

  if v_user_id is null then
    raise exception
      'No existe ninguna cuenta con el correo %. Créala primero en '
      'Authentication → Users → Add user, marcando «Auto Confirm User», y '
      'vuelve a ejecutar este script.', v_email;
  end if;

  -- -------------------------------------------------------------------------
  -- Perfil
  -- -------------------------------------------------------------------------
  -- El disparador `handle_new_user` ya creó la fila al darse de alta; aquí solo
  -- se completa. Un perfil vacío hace pensar que la app no carga los datos.
  --
  -- `role = 'user'` es deliberado: quien revisa debe ver EXACTAMENTE lo que ve
  -- cualquier miembro. Con permisos de administración vería botones y pantallas
  -- que el público no tiene, y aprobaría una app distinta de la publicada.
  update public.profiles
     set full_name  = 'Revisión App Store',
         username   = 'revision_tiendas',
         bio        = 'Cuenta de demostración para la revisión de las tiendas.',
         role       = 'user',
         -- -------------------------------------------------------------------
         -- Podcast: se adelanta el origen de la liberación progresiva.
         --
         -- Los episodios 2 a 5 se abren a las 8, 16, 24 y 32 horas de la fecha
         -- de alta. Quien revisa dedica MINUTOS a la app, así que con la fecha
         -- real solo podría escuchar el primero y encontraría el resto con una
         -- cuenta atrás. Poniéndola diez días atrás, los cinco están abiertos
         -- desde el primer momento y puede comprobar que el audio funciona.
         --
         -- Del sexto en adelante siguen siendo contenido de membresía: eso no
         -- se toca, es el producto. No ofrecen ninguna compra, solo aparecen
         -- atenuados, así que no entran en conflicto con la directriz 3.1.1.
         -- -------------------------------------------------------------------
         podcast_started_at = now() - interval '10 days',
         updated_at = now()
   where id = v_user_id;

  -- -------------------------------------------------------------------------
  -- Acceso a los cursos de pago
  -- -------------------------------------------------------------------------
  -- `has_course_access` (migración 0016) abre los cursos gratuitos a cualquier
  -- persona autenticada, pero los de precio mayor que cero exigen una compra en
  -- estado 'paid'. Sin esto, quien revisa vería la ficha del curso y ningún
  -- vídeo se reproduciría: leería la app como rota.
  --
  -- `provider = 'manual'` existe justo para esto —accesos concedidos a mano, no
  -- cobrados por una pasarela— y es uno de los cuatro valores que admite el
  -- CHECK de la tabla.
  --
  -- El identificador de transacción es determinista para que el `unique
  -- (provider, provider_transaction_id)` convierta una segunda ejecución en un
  -- `do nothing`. Con el identificador a NULL no habría tal protección: en
  -- Postgres los nulos no chocan entre sí y se acumularían filas repetidas.
  insert into public.purchases (
    user_id, course_id, provider, provider_transaction_id,
    amount_minor, currency, status
  )
  select
    v_user_id,
    c.id,
    'manual',
    'demo-revision-' || c.id,
    0,                    -- concedido, no cobrado: no ensucia ningún informe
    c.currency,
    'paid'
  from public.courses c
  where c.price_minor > 0
  on conflict (provider, provider_transaction_id) do nothing;

  get diagnostics v_cursos = row_count;

  raise notice 'Cuenta lista: % (id %). Cursos de pago concedidos ahora: %.',
    v_email, v_user_id, v_cursos;
end;
$$;

-- ---------------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------------
-- `sin_acceso` tiene que dar 0. Si diera más, quien revisa se encontraría un
-- curso cuyo vídeo no carga.
select
  p.username,
  p.role,
  p.podcast_started_at,
  (select count(*) from public.courses)                        as cursos_totales,
  (select count(*) from public.courses where price_minor > 0)  as cursos_de_pago,
  (
    select count(*)
    from public.courses c
    where c.price_minor > 0
      and not exists (
        select 1 from public.purchases pu
        where pu.course_id = c.id
          and pu.user_id = p.id
          and pu.status = 'paid'
      )
  ) as sin_acceso
from public.profiles p
where p.id = (
  select id from auth.users where email = 'testgoogle@gmail.com'
);
