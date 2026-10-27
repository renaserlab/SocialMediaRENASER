#!/usr/bin/env bash
# Levanta el Supabase LOCAL de Zeta con los mismos permisos que produccion.
#
# POR QUE EXISTE. Las migraciones no conceden nada a `anon` ni a
# `authenticated`: solo lo retiran (la 0052, la 0053 y las de despues). Dan por
# hecho lo que Supabase concedia por defecto cuando se creo el proyecto real:
# todos los privilegios sobre cada tabla nueva. La CLI actual de Supabase ya no
# lo concede, asi que una base local creada con ella nace con TODAS las tablas
# cerradas. La app recibe «permission denied for table stories» y, al subir
# una foto o un video, «No tienes permiso para subir este archivo»: la politica
# de Storage de la media de cursos lee `courses`, y Postgres la evalua en
# cualquier subida.
#
# Conceder a mano despues no sirve: hay que repetirlo cada vez que se recrea la
# base y se lleva por delante los `revoke` de las migraciones. Lo que hace este
# guion es reproducir el punto de partida de produccion ANTES de la primera
# migracion, como hace `supabase/tests/prologo_local.sql` en CI. Asi cada
# `revoke` tiene algo que retirar y la base local queda como la real.
#
# Uso:
#   scripts/supabase_local.sh iniciar   # prepara la carpeta, arranca y aplica migraciones nuevas
#   scripts/supabase_local.sh recrear   # BORRA los datos locales y aplica todo desde cero
#   scripts/supabase_local.sh parar     # para los contenedores; los datos se quedan
#
# La carpeta de trabajo es `.supabase-local/` (fuera de git). Puertos 543xx:
# renaser-8x ocupa los 553xx.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${ZETA_LOCAL_DIR:-$RAIZ/.supabase-local}"
ID="${ZETA_LOCAL_ID:-zeta-local}"
# Prefijo de los puertos: con 543 la API queda en 54321 y la base en 54322.
PUERTOS="${ZETA_LOCAL_PUERTOS:-543}"

preparar() {
  local config="$DIR/supabase/config.toml"
  if [ ! -f "$config" ]; then
    mkdir -p "$DIR"
    (cd "$DIR" && supabase init >/dev/null)
    # Sin Studio, funciones ni analitica: la app no los usa y ocupan memoria.
    awk -v id="$ID" '
      /^\[/ { seccion = $0 }
      /^project_id *=/ { print "project_id = \"" id "\""; next }
      /^enabled *=/ && (seccion == "[studio]" || seccion == "[edge_runtime]" || seccion == "[analytics]") {
        print "enabled = false"; next
      }
      { print }
    ' "$config" | sed -E "s/\b543([0-9]{2})\b/${PUERTOS}\1/g" > "$config.nuevo"
    mv "$config.nuevo" "$config"
  fi

  # La fuente de las migraciones es el repositorio: se copian en cada arranque.
  rm -rf "$DIR/supabase/migrations"
  mkdir -p "$DIR/supabase/migrations"
  cat > "$DIR/supabase/migrations/0000_privilegios_por_defecto_de_supabase.sql" <<'SQL'
-- Lo que produccion tenia puesto antes de la 0001. Lo escribe
-- scripts/supabase_local.sh SOLO en la copia local; no esta en
-- supabase/migrations porque produccion ya lo tiene.
--
-- Solo actua sobre una base recien creada. En una que ya tiene tablas no hace
-- nada: volver a conceder por defecto ahi reabriria lo que cerro la 0053.
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public') then
    return;
  end if;
  execute 'alter default privileges for role postgres in schema public
             grant all on tables to anon, authenticated, service_role';
  execute 'alter default privileges for role postgres in schema public
             grant all on sequences to anon, authenticated, service_role';
  execute 'alter default privileges for role postgres in schema public
             grant execute on functions to public, anon, authenticated, service_role';
end $$;
SQL
  cp "$RAIZ"/supabase/migrations/*.sql "$DIR/supabase/migrations/"
}

case "${1:-}" in
  iniciar)
    preparar
    supabase start --workdir "$DIR"
    # Una base que ya existia no recibe sola las migraciones nuevas del repo.
    # `--include-all` deja pasar la 0000 en una base anterior a este guion; ahi
    # no hace nada, por la condicion de arriba.
    supabase migration up --local --include-all --workdir "$DIR"
    ;;
  recrear)
    preparar
    echo "Se borran los datos de la base local '$ID' (usuarios de prueba incluidos)."
    supabase db reset --local --no-seed --workdir "$DIR"
    ;;
  parar)
    supabase stop --workdir "$DIR"
    ;;
  *)
    echo "Uso: $0 iniciar|recrear|parar" >&2
    exit 2
    ;;
esac
