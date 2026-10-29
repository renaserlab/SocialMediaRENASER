#!/usr/bin/env bash
# Escribe `true` si este evento tiene que ejecutar las pruebas de la API en
# ci.yml, y `false` si puede saltarselas. Lo usa el trabajo `cambios`.
#
# Entorno: EVENTO (github.event_name), RAMA (github.ref_name) y ANTES
# (github.event.before, solo en push). Necesita la historia completa.
#
# ANTE LA DUDA, TRUE. Un «antes» que no existe (rama nueva, historia
# reescrita) no deja saber que cambio, y saltarse la bateria por no saberlo es
# justo lo que no puede pasar.
set -euo pipefail

RAIZ="$(git rev-parse --show-toplevel)"
RUTAS="$RAIZ/.github/rutas-que-prueba-la-api.txt"

if [ "${EVENTO:-}" = pull_request ]; then
  # En un PR se prueba la FUSION con su base, y su primer padre ES la base: el
  # diff contra el es exactamente lo que trae el PR.
  DESDE="HEAD^1"
elif [ -n "${ANTES:-}" ] && git cat-file -e "${ANTES}^{commit}" 2>/dev/null; then
  DESDE="$ANTES"
else
  echo true
  exit 0
fi

CAMBIADOS="$(git diff --name-only "$DESDE" HEAD)"
PATRONES="$(grep -v -e '^#' -e '^$' "$RUTAS")"

if ! printf '%s\n' "$CAMBIADOS" | grep -q -E -e "$PATRONES"; then
  echo false
  exit 0
fi

# En `main`, un cambio en apps/api ya lo prueba ENTERO la puerta del
# despliegue antes de publicar (desplegar-aws.yml se dispara con las mismas
# rutas). Repetirlo aqui eran otros ~55 minutos para el mismo resultado.
if [ "${EVENTO:-}" = push ] && [ "${RAMA:-}" = main ] \
  && printf '%s\n' "$CAMBIADOS" | grep -q -E -e '^apps/api/' -e '^\.github/workflows/desplegar-aws\.yml$'; then
  echo false
  exit 0
fi

echo true
