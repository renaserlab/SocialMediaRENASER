-- Grupo de WhatsApp de un evento.
--
-- Los detalles finos (logistica, dudas, cambios de ultima hora) se dan en un
-- grupo, no en la ficha: la tarjeta del evento enlaza directamente ahi.
--
-- Se guarda la URL completa de la invitacion (https://chat.whatsapp.com/...).
-- Sin CHECK: el formato de esos enlaces lo decide WhatsApp y ya ha cambiado
-- antes; validarlo aqui obligaria a migrar cuando cambie.

alter table public.events
  add column if not exists whatsapp_url text;
