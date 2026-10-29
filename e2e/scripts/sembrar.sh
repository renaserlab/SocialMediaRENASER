#!/usr/bin/env bash
# Datos de prueba para la suite E2E. SOLO contra el Supabase LOCAL (zeta-local).
#
# Idempotente: se puede lanzar las veces que haga falta; deja siempre el mismo
# estado de partida.
#
#   1. Crea (o repone) a Ana y Beto en Supabase Auth con la API de admin,
#      con UUID fijos para que los .sql puedan nombrarlos sin buscarlos.
#   2. Sube las imagenes de e2e/datos/medios/ a Storage (nada externo).
#   3. Ejecuta e2e/datos/*.sql por orden de nombre (00-base.sql primero).
#
# La clave service_role se lee al vuelo de `supabase status`; nunca se escribe
# en disco.
set -euo pipefail

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${ZETA_REPO:-$HOME/Documentos/Proyectos-Renaser/SocialMediaRENASER}"
CONTENEDOR_DB="${ZETA_DB_CONTAINER:-supabase_db_zeta-local}"

# UUID fijos de los usuarios de prueba (los mismos que usan los .sql).
ANA_ID=e2e0a0a0-0000-4000-8000-000000000001
BETO_ID=e2e0b0b0-0000-4000-8000-000000000002
CLAVE="${E2E_PASSWORD:-Zeta-e2e-2026}"

log() { printf '[sembrar] %s\n' "$*" >&2; }

# ---- Credenciales locales, solo en memoria -------------------------------
estado="$(cd "$REPO" && supabase status --workdir .supabase-local -o env 2>/dev/null)" || {
  log "ERROR: 'supabase status' fallo. ¿Esta levantado el Supabase local?"; exit 1; }
leer() { printf '%s\n' "$estado" | sed -n "s/^$1=\"\(.*\)\"$/\1/p"; }
API_URL="$(leer API_URL)"
SERVICE_KEY="$(leer SERVICE_ROLE_KEY)"
unset estado

# Guardia: jamas contra un proyecto gestionado.
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) log "ERROR: API_URL no es local ($API_URL). Abortado."; exit 1 ;;
esac
[ -n "$SERVICE_KEY" ] || { log "ERROR: sin SERVICE_ROLE_KEY"; exit 1; }

psql_local() {
  docker exec -i "$CONTENEDOR_DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q "$@"
}

admin() {  # admin METODO RUTA [JSON]
  curl -sS -m 20 -X "$1" "$API_URL/auth/v1/admin$2" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H 'Content-Type: application/json' ${3:+--data "$3"} \
    -o /dev/null -w '%{http_code}'
}

# ---- 1. Usuarios ----------------------------------------------------------
asegurar_usuario() {  # id correo nombre usuario
  local id="$1" correo="$2" nombre="$3" usuario="$4" actual codigo
  actual="$(psql_local -At -c "select id from auth.users where lower(email) = lower('$correo')")"
  if [ -n "$actual" ] && [ "$actual" != "$id" ]; then
    # Alguien lo creo a mano con otro id: se rehace con el fijo.
    log "$correo existia con otro id ($actual): se recrea"
    codigo="$(admin DELETE "/users/$actual")"
    [ "$codigo" = 200 ] || { log "ERROR al borrar $correo ($codigo)"; exit 1; }
    actual=""
  fi
  local meta="{\"full_name\":\"$nombre\",\"username\":\"$usuario\"}"
  if [ -z "$actual" ]; then
    codigo="$(admin POST /users "{\"id\":\"$id\",\"email\":\"$correo\",\"password\":\"$CLAVE\",\"email_confirm\":true,\"user_metadata\":$meta}")"
    [ "$codigo" = 200 ] || { log "ERROR al crear $correo ($codigo)"; exit 1; }
    log "creado $correo"
  elif [ "$(psql_local -At -c "select encrypted_password = extensions.crypt('$CLAVE', encrypted_password)
             and email_confirmed_at is not null and (banned_until is null or banned_until < now())
             and raw_user_meta_data->>'full_name' = '$nombre' and raw_user_meta_data->>'username' = '$usuario'
           from auth.users where id = '$id'")" = t ]; then
    # Ya esta como debe: no se toca. Reponer la contraseña sin necesidad tira
    # la sesion que la app tenga abierta y el flujo siguiente se queda fuera.
    log "al dia $correo"
  else
    # Ya existe pero una prueba lo cambio: se repone.
    codigo="$(admin PUT "/users/$id" "{\"password\":\"$CLAVE\",\"email_confirm\":true,\"ban_duration\":\"none\",\"user_metadata\":$meta}")"
    [ "$codigo" = 200 ] || { log "ERROR al actualizar $correo ($codigo)"; exit 1; }
    log "repuesto $correo"
  fi
}

# Cuentas desechables que crean las pruebas de registro (auth/07 y auth/11).
borradas="$(psql_local -At -c "with b as (delete from auth.users where email like '%@e2e.zeta.test' or email like 'sin-dominio-%@e2e' returning 1) select count(*) from b")"
[ "$borradas" = 0 ] || log "borradas $borradas cuentas de registro de pruebas anteriores"

asegurar_usuario "$ANA_ID"  ana.e2e@zeta.test  'Ana Prueba'  ana_e2e
asegurar_usuario "$BETO_ID" beto.e2e@zeta.test 'Beto Prueba' beto_e2e

# ---- 2. Imagenes en Storage ------------------------------------------------
subir() {  # bucket ruta archivo
  local codigo
  codigo="$(curl -sS -m 30 -X POST "$API_URL/storage/v1/object/$1/$2" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H 'Content-Type: image/jpeg' -H 'x-upsert: true' -H 'Cache-Control: max-age=3600' \
    --data-binary "@$3" -o /dev/null -w '%{http_code}')"
  [ "$codigo" = 200 ] || { log "ERROR al subir $1/$2 ($codigo)"; exit 1; }
}

M="$E2E/datos/medios"
subir avatars    "$ANA_ID/e2e/avatar.jpg"  "$M/avatar-ana.jpg"
subir avatars    "$BETO_ID/e2e/avatar.jpg" "$M/avatar-beto.jpg"
subir post-media "$ANA_ID/e2e/foto-1.jpg"  "$M/foto-1.jpg"
subir post-media "$ANA_ID/e2e/foto-2.jpg"  "$M/foto-2.jpg"
subir post-media "$BETO_ID/e2e/foto-3.jpg" "$M/foto-3.jpg"
subir post-media "$BETO_ID/e2e/foto-4.jpg" "$M/foto-4.jpg"
log "imagenes subidas a Storage"

# ---- 3. SQL por modulo -----------------------------------------------------
for sql in "$E2E"/datos/*.sql; do
  [ -e "$sql" ] || continue
  log "aplicando $(basename "$sql")"
  psql_local -v ana="$ANA_ID" -v beto="$BETO_ID" < "$sql" >/dev/null
done

log "listo"
