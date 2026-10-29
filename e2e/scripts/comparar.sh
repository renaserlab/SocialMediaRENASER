#!/usr/bin/env bash
# Compara las capturas de una ejecucion con las lineas base (SSIM de ffmpeg).
#
# Uso:
#   e2e/scripts/comparar.sh [e2e/salida/<fecha>] [--actualizar-referencias | --referencias-nuevas] [--umbral=0.97]
#
# Sin carpeta usa la ejecucion mas reciente. Cada captura `<modulo>-<pantalla>.png`
# se compara con `e2e/referencias/<modulo>/<modulo>-<pantalla>.png`; el modulo
# es la carpeta de e2e/flujos con el prefijo mas largo que encaje en el nombre.
#
# Antes de comparar se recorta la barra de estado (arriba) y se pasa a grises.
# SSIM >= umbral = igual. Las que cambian dejan una imagen de diferencias en
# <salida>/diferencias/. El resumen va a la terminal y a <salida>/informe-visual.txt.
#
# --actualizar-referencias copia TODAS las capturas de la ejecucion como nuevas
# lineas base (a 540 px de ancho, que es como las deja correr.sh).
# --referencias-nuevas solo crea las que faltan (flujos o pantallas nuevas) y
# compara el resto: sirve para estrenar un flujo sin pisar las que ya existen.
#
# Codigo de salida: 0 si nada cambia (las nuevas sin referencia no cuentan), 3 si
# alguna cambia, 2 si no hay nada que comparar.
set -euo pipefail

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REFS="$E2E/referencias"
UMBRAL="${UMBRAL_SSIM:-0.97}"
ANCHO=540          # ancho al que se guardan capturas y referencias
BARRA=64           # alto de la barra de estado a ese ancho (128 px a 1080)

salida=""; actualizar=0; solo_nuevas=0
for a in "$@"; do
  case "$a" in
    --actualizar-referencias) actualizar=1 ;;
    --referencias-nuevas) solo_nuevas=1 ;;
    --umbral=*) UMBRAL="${a#--umbral=}" ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) salida="$a" ;;
  esac
done
if [ -z "$salida" ]; then
  salida="$(ls -1dt "$E2E"/salida/*/ 2>/dev/null | head -1)"
  salida="${salida%/}"
fi
CAPTURAS="$salida/capturas"
if [ ! -d "$CAPTURAS" ] || [ -z "$(ls -A "$CAPTURAS" 2>/dev/null)" ]; then
  echo "[comparar] no hay capturas en ${salida:-e2e/salida}" >&2; exit 2
fi

# Modulos conocidos, de mas largo a mas corto (para el prefijo mas largo).
mapfile -t MODULOS < <(find "$E2E/flujos" -mindepth 1 -maxdepth 1 -type d ! -name '_*' -printf '%f\n' \
  | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)
modulo_de() {
  local m
  for m in "${MODULOS[@]}"; do
    case "$1" in "$m"-*) echo "$m"; return ;; esac
  done
  echo otros
}

# Normaliza a ANCHO, quita la barra de estado y pasa a grises.
FILTRO="scale=${ANCHO}:-2,crop=iw:ih-${BARRA}:0:${BARRA},format=gray"

ssim() {  # actual referencia -> imprime el SSIM global
  ffmpeg -hide_banner -nostats -i "$1" -i "$2" \
    -lavfi "[0]${FILTRO}[a];[1]${FILTRO}[b];[a][b]ssim" -f null - 2>&1 </dev/null \
    | sed -n 's/.*All:\([0-9.]*\).*/\1/p' | tail -1
}

informe="$salida/informe-visual.txt"
: > "$informe"
iguales=0; cambian=0; nuevas=0; actualizadas=0

for actual in "$CAPTURAS"/*.png; do
  nombre="$(basename "$actual")"
  modulo="$(modulo_de "${nombre%.png}")"
  ref="$REFS/$modulo/$nombre"

  if [ "$actualizar" = 1 ]; then
    mkdir -p "$REFS/$modulo"
    ffmpeg -loglevel error -y -i "$actual" -vf "scale=${ANCHO}:-2" "$ref" </dev/null
    printf 'ACTUALIZADA  %s/%s\n' "$modulo" "$nombre" | tee -a "$informe"
    actualizadas=$((actualizadas + 1))
    continue
  fi

  if [ ! -f "$ref" ] && [ "$solo_nuevas" = 1 ]; then
    mkdir -p "$REFS/$modulo"
    ffmpeg -loglevel error -y -i "$actual" -vf "scale=${ANCHO}:-2" "$ref" </dev/null
    printf 'CREADA       %s/%s\n' "$modulo" "$nombre" | tee -a "$informe"
    actualizadas=$((actualizadas + 1))
    continue
  fi

  if [ ! -f "$ref" ]; then
    printf 'NUEVA        %s/%s (sin referencia)\n' "$modulo" "$nombre" | tee -a "$informe"
    nuevas=$((nuevas + 1))
    continue
  fi

  valor="$(ssim "$actual" "$ref")"
  if [ -z "$valor" ]; then
    printf 'ERROR        %s/%s (ffmpeg no pudo comparar)\n' "$modulo" "$nombre" | tee -a "$informe"
    cambian=$((cambian + 1))
  elif awk -v v="$valor" -v u="$UMBRAL" 'BEGIN { exit !(v >= u) }'; then
    printf 'IGUAL        %s/%s  ssim=%s\n' "$modulo" "$nombre" "$valor" >> "$informe"
    iguales=$((iguales + 1))
  else
    mkdir -p "$salida/diferencias"
    # Diferencia absoluta realzada: lo que cambia sale claro sobre negro.
    ffmpeg -loglevel error -y -i "$actual" -i "$ref" \
      -lavfi "[0]scale=${ANCHO}:-2,format=rgb24[a];[1]scale=${ANCHO}:-2,format=rgb24[b];[a][b]blend=all_mode=difference,eq=brightness=0.1:contrast=3" \
      "$salida/diferencias/$nombre" </dev/null || true
    printf 'CAMBIA       %s/%s  ssim=%s < %s\n' "$modulo" "$nombre" "$valor" "$UMBRAL" | tee -a "$informe"
    cambian=$((cambian + 1))
  fi
done

if [ "$actualizar" = 1 ]; then
  resumen="$actualizadas referencias actualizadas en ${REFS#$E2E/}/"
else
  resumen="$iguales iguales, $cambian cambian, $nuevas sin referencia (umbral ssim $UMBRAL)"
  [ "$solo_nuevas" = 1 ] && resumen="$resumen, $actualizadas referencias creadas"
fi
echo "$resumen" | tee -a "$informe"
[ "$cambian" -gt 0 ] && exit 3
exit 0
