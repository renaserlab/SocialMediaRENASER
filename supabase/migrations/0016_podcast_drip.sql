-- Momento en que arranca la liberacion progresiva del podcast.
--
-- Los primeros episodios no se abren todos a la vez: el 1 esta libre y cada
-- siguiente se desbloquea 8 horas despues del anterior.
--
-- El instante se guarda en el SERVIDOR, no en el dispositivo, por tres motivos:
--   1) el reloj sigue corriendo con la app cerrada,
--   2) no se puede adelantar cambiando la hora del telefono,
--   3) es el mismo progreso en todos los dispositivos de la persona.
--
-- Se rellena la primera vez que se abre el podcast (no al registrarse): asi la
-- cuenta atras empieza cuando la persona empieza a escuchar, no antes.
--
-- Nulo = todavia no ha abierto el podcast.

alter table public.profiles
  add column if not exists podcast_started_at timestamptz;

comment on column public.profiles.podcast_started_at is
  'Inicio de la liberacion progresiva del podcast (un episodio cada 8 h).';
