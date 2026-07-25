-- Poder agendar una sesion 1:1.
--
-- La tabla `notifications` tiene RLS activada y politicas de lectura y de
-- marcado como leida, pero NINGUNA de insercion. Con RLS, lo que no esta
-- permitido esta prohibido: cada intento de reservar era rechazado en silencio,
-- la pantalla anunciaba «sesion agendada» y la otra persona no se enteraba
-- jamas. Se comprobo en la base: cero reservas registradas.
--
-- El resto de avisos (seguir, me gusta) no se veian afectados porque los crea
-- el backend con credenciales de servicio, que no pasan por RLS.
--
-- Se abre la insercion con dos condiciones, que es lo que evita que esto se
-- convierta en un buzon de spam anonimo:
--
--   1. `actor_id = auth.uid()`: el aviso va firmado por quien lo envia. No se
--      puede suplantar a otra persona.
--   2. `type = 'session_booked'`: solo este tipo. Los demas los sigue creando
--      el backend, que es quien sabe cuando corresponden.
--
-- No se toca ninguna fila existente.
--
-- El script es REPETIBLE.

drop policy if exists notifications_insert_booking on public.notifications;
create policy notifications_insert_booking on public.notifications
  for insert to authenticated
  with check (
    actor_id = auth.uid()
    and type = 'session_booked'
    -- Avisarse a uno mismo no tiene sentido y ensuciaria la bandeja.
    and user_id <> auth.uid()
  );

notify pgrst, 'reload schema';

-- Comprobacion final.
select
  (select count(*) from pg_policies
     where tablename = 'notifications' and cmd = 'INSERT') as politicas_insert,
  (select count(*) from public.notifications) as avisos_conservados;
-- Esperado: politicas_insert = 1, y los avisos que ya hubiera.
