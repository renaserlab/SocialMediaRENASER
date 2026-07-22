-- La fecha del evento pasa a ser opcional.
--
-- Un evento suele anunciarse antes de cerrar fecha, hora o sede ("Ecuador -
-- por confirmar"). Con `starts_at not null` no habia forma de publicarlo, asi
-- que la agenda no podia reflejar lo que ya estaba anunciado.
--
-- El indice sobre starts_at se mantiene: en Postgres los NULL se ordenan al
-- final en ASC, que es justo donde queremos lo que aun no tiene fecha.

alter table public.events
  alter column starts_at drop not null;
