#!/usr/bin/env bash
# Corre la suite E2E (o parte) en el emulador, con el cerrojo del dispositivo.
#
# Uso:
#   e2e/scripts/correr.sh                       # todo, modulo a modulo
#   e2e/scripts/correr.sh auth                  # un modulo (carpeta de e2e/flujos)
#   e2e/scripts/correr.sh e2e/flujos/auth/03-login.yaml   # un flujo
#   e2e/scripts/correr.sh auth mensajes         # varios
#
# Opciones:
#   --actualizar-referencias   promueve las capturas de esta ejecucion a
#                              e2e/referencias/<modulo>/ (lineas base)
#   --referencias-nuevas       solo crea las referencias que falten; el resto
#                              se compara como siempre
#   --sin-sembrar              no reponer los datos de prueba antes de correr
#   --etiquetas=a,b            solo los flujos con esas etiquetas (--include-tags)
#   --excluir=a,b              sin los flujos con esas etiquetas; p. ej.
#                              --excluir=bug-conocido deja fuera los que
#                              reproducen un fallo conocido de la app
#
# Al correr todo o un modulo entero quedan fuera los flujos `pendiente` (aun no
# pasan enteros) y `bloqueado-expo-go`. Se corren nombrando el archivo o con
# --etiquetas=pendiente.
#
# Salida en e2e/salida/<fecha>/: junit.xml, capturas/ (reducidas a 540 px),
# informe-visual.txt, diferencias/ y, si algo falla, depuracion/. Se conservan
# las 10 ultimas ejecuciones.
#
# Codigo de salida: el de Maestro; si Maestro pasa pero alguna pantalla cambia
# respecto a su referencia, 3.
set -euo pipefail

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
CERROJO="$HOME/.cache/zeta-e2e/dispositivo.lock"
CONSERVAR=10

export E2E_EMAIL="${E2E_EMAIL:-ana.e2e@zeta.test}"
export E2E_PASSWORD="${E2E_PASSWORD:-Zeta-e2e-2026}"
export E2E_EMAIL_B="${E2E_EMAIL_B:-beto.e2e@zeta.test}"

log() { printf '[correr] %s\n' "$*" >&2; }

actualizar=0; nuevas=0; sembrar=1; etiquetas=""; excluir="comun"; objetivos=()
for a in "$@"; do
  case "$a" in
    --actualizar-referencias) actualizar=1 ;;
    --referencias-nuevas) nuevas=1 ;;
    --sin-sembrar) sembrar=0 ;;
    --etiquetas=*) etiquetas="${a#--etiquetas=}" ;;
    --excluir=*) excluir="$excluir,${a#--excluir=}" ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) log "opcion desconocida: $a"; exit 2 ;;
    *)
      if [ -e "$a" ]; then objetivos+=("$(realpath "$a")")
      elif [ -e "$E2E/flujos/$a" ]; then objetivos+=("$E2E/flujos/$a")
      else log "no existe: $a"; exit 2
      fi ;;
  esac
done

# ---- Todo: modulo a modulo ---------------------------------------------------
# El emulador crece ~4,5 GB por hora y la suite entera tarda mas de lo que
# aguanta su tope: el 29-10 lo mato el OOM a la 1 h 50 min, a mitad de Perfil.
# Corriendo cada modulo por separado, entre uno y otro se resiembra y
# `emulador.sh` lo reinicia si hace falta. De paso cada modulo arranca de los
# mismos datos, sin lo que dejaron los anteriores (la agenda salia «reservada»
# o la bandeja con mensajes de otra prueba segun el orden).
if [ ${#objetivos[@]} -eq 0 ]; then
  fallaron=(); cambiaron=()
  for m in "$E2E"/flujos/[!_]*/; do
    m="${m%/}"
    log "==== modulo ${m##*/}"
    set +e; "${BASH_SOURCE[0]}" "$@" "$m"; c=$?; set -e
    case "$c" in
      0) ;;
      3) cambiaron+=("${m##*/}") ;;
      *) fallaron+=("${m##*/}") ;;
    esac
  done
  [ ${#cambiaron[@]} -eq 0 ] || log "pantallas que cambian en: ${cambiaron[*]}"
  if [ ${#fallaron[@]} -gt 0 ]; then log "FALLO en: ${fallaron[*]}"; exit 1; fi
  if [ ${#cambiaron[@]} -gt 0 ]; then exit 3; fi
  log "OK: todos los modulos"
  exit 0
fi

# Los `pendiente` y `bloqueado-expo-go` solo entran si se nombran (archivo o
# --etiquetas): en una carpeta entera se apartan.
solo_archivos=1
for o in "${objetivos[@]}"; do [ -d "$o" ] && solo_archivos=0; done
if [ "$solo_archivos" = 0 ]; then
  for t in pendiente bloqueado-expo-go; do
    case ",$etiquetas," in *",$t,"*) ;; *) excluir="$excluir,$t" ;; esac
  done
fi

# ---- Cerrojo del dispositivo (todo lo de abajo va con el puesto) -----------
mkdir -p "$(dirname "$CERROJO")"
exec 8>"$CERROJO"
if ! flock -n 8; then
  log "el dispositivo esta ocupado por otra ejecucion; esperando..."
  flock 8
fi

# `8>&-`: ni el emulador, ni Metro, ni Maestro deben heredar el cerrojo.
# Con el cerrojo puesto se puede reiniciar el emulador si va justo de memoria.
ZETA_REINICIO_PREVENTIVO=1 "$E2E/scripts/emulador.sh" 8>&-
if [ "$sembrar" = 1 ]; then "$E2E/scripts/sembrar.sh" 8>&-; fi

SALIDA="$E2E/salida/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SALIDA"

args=(test --format junit --output "$SALIDA/junit.xml"
      --test-output-dir "$SALIDA/maestro" --debug-output "$SALIDA/depuracion"
      --exclude-tags "$excluir"
      -e "E2E_EMAIL=$E2E_EMAIL" -e "E2E_PASSWORD=$E2E_PASSWORD" -e "E2E_EMAIL_B=$E2E_EMAIL_B")
[ -n "$etiquetas" ] && args+=(--include-tags "$etiquetas")
args+=("${objetivos[@]}")

log "salida en ${SALIDA#$E2E/}"
set +e
"$MAESTRO" "${args[@]}" 8>&-
codigo=$?
set -e

# ---- Capturas: reducidas y en una sola carpeta -----------------------------
mkdir -p "$SALIDA/capturas"
while IFS= read -r -d '' png; do
  ffmpeg -loglevel error -y -i "$png" -vf scale=540:-2 "$SALIDA/capturas/$(basename "$png")" </dev/null
done < <(find "$SALIDA/maestro" -path '*/takeScreenshot/*.png' -print0 2>/dev/null)
# Las originales (1080x2400) pesan mucho y ya estan copiadas.
find "$SALIDA/maestro" -path '*/takeScreenshot/*.png' -delete 2>/dev/null || true
log "$(find "$SALIDA/capturas" -name '*.png' | wc -l) capturas"

# Si todo paso, la depuracion de Maestro no hace falta.
if [ "$codigo" = 0 ]; then rm -rf "$SALIDA/depuracion"; fi

# ---- Comparacion visual ----------------------------------------------------
comparar=("$E2E/scripts/comparar.sh" "$SALIDA")
[ "$actualizar" = 1 ] && comparar+=(--actualizar-referencias)
[ "$nuevas" = 1 ] && comparar+=(--referencias-nuevas)
set +e
"${comparar[@]}" 8>&-
visual=$?
set -e

# ---- Limpieza: solo las ultimas ejecuciones --------------------------------
ls -1dt "$E2E"/salida/*/ 2>/dev/null | tail -n +$((CONSERVAR + 1)) | xargs -r rm -rf

if [ "$codigo" != 0 ]; then
  log "FALLO: Maestro salio con $codigo (mira ${SALIDA#$E2E/}/junit.xml y depuracion/)"
  exit "$codigo"
fi
if [ "$visual" = 3 ]; then
  log "Maestro paso, pero hay pantallas que cambian (mira informe-visual.txt)"
  exit 3
fi
log "OK"
