-- Habilita Supabase Realtime para mensajería.
-- Añade las tablas de mensajería a la publicación supabase_realtime para que
-- los cambios (INSERT de mensajes, updates de conversaciones) se entreguen en
-- vivo a los clientes suscritos (respetando RLS).

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
end
$$;
