#!/usr/bin/env bash
# Deja el entorno listo para Maestro: emulador arrancado, puertos redirigidos,
# barra de estado fija, animaciones apagadas y el backend local respondiendo.
#
# Idempotente: si todo ya esta en marcha solo lo comprueba (tarda ~2 s).
# Lo llama `correr.sh` antes de cada ejecucion; tambien se puede lanzar suelto.
#
# Variables opcionales:
#   ANDROID_HOME   SDK de Android (por defecto ~/Android/Sdk)
#   ZETA_AVD       AVD a arrancar (por defecto Pixel_6_API_36)
#   ZETA_REPO      checkout PRINCIPAL desde el que corre Metro
#                  (por defecto ~/Documentos/Proyectos-Renaser/SocialMediaRENASER)
#   ZETA_REINICIO_PREVENTIVO=1
#                  reinicia el emulador si su memoria (RAM anonima + swap)
#                  pasa de ZETA_LIMITE_MB (6000 por omision). Lo pone correr.sh,
#                  que tiene el cerrojo del dispositivo: a mano NO, que mataria
#                  la ejecucion de otro.
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
AVD="${ZETA_AVD:-Pixel_6_API_36}"
REPO="${ZETA_REPO:-$HOME/Documentos/Proyectos-Renaser/SocialMediaRENASER}"
CACHE="$HOME/.cache/zeta-e2e"
LOGS="$HOME/.cache/zeta-emulador"
PUERTOS=(8081 54321 8000)

mkdir -p "$CACHE" "$LOGS"

# Un solo arranque a la vez (dos agentes llamando a la vez no lanzan dos emuladores).
exec 9>"$CACHE/arranque.lock"
flock 9

# Lanza "$@" en segundo plano SIN heredar ningun descriptor por encima de 2.
# Imprescindible: si el emulador (o la API, o Metro) heredara el descriptor de
# arranque.lock —o el de dispositivo.lock, cuando a este script lo llama
# `flock dispositivo.lock ...`— retendria ese cerrojo mientras viva y la
# siguiente ejecucion se quedaria esperando para siempre.
en_segundo_plano() {
  (
    for fd in /proc/$BASHPID/fd/*; do
      fd=${fd##*/}
      if [ "$fd" -gt 2 ] 2>/dev/null; then eval "exec $fd>&-" 2>/dev/null || true; fi
    done
    exec "$@"
  ) &
}

log() { printf '[emulador] %s\n' "$*" >&2; }

# PIDs del emulador Android (no el qemu de Docker): se mira el ejecutable real.
pids_emulador() {
  local p exe
  for p in $(pgrep -x emulator 2>/dev/null) $(pgrep -x qemu-system-x86 2>/dev/null); do
    exe=$(readlink "/proc/$p/exe" 2>/dev/null) || continue
    case "$exe" in */emulator/emulator|*/emulator/qemu/*) echo "$p" ;; esac
  done
}

dispositivo_listo() {
  [ "$("$ADB" get-state 2>/dev/null)" = device ] &&
    [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]
}

responde() { curl -s -m 3 -o /dev/null "$1"; }

# Memoria (MB) del scope del emulador: RAM anonima MAS lo que tiene en swap.
# El emulador crece con las horas (~3,7 GB al arrancar, ~4,5 GB mas por hora de
# pruebas). La RAM se queda en el tope del scope (4500 MB) y lo demas se va a
# swap, asi que mirar solo la RAM no lo ve nunca: el 28-10 llevaba 10 GB en
# swap, el sistema se quedo sin swap y cada toque iba a paso de tortuga.
memoria_mb() {
  local p cg anon swap
  p="$(pids_emulador | head -1)"
  [ -n "$p" ] || { echo 0; return; }
  cg="/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$p/cgroup" 2>/dev/null)"
  anon="$(awk '/^anon /{ print int($2 / 1048576) }' "$cg/memory.stat" 2>/dev/null)"
  swap="$(awk '{ print int($1 / 1048576) }' "$cg/memory.swap.current" 2>/dev/null)"
  echo $(( ${anon:-0} + ${swap:-0} ))
}

# ---- 1. Emulador ---------------------------------------------------------
if [ "${ZETA_REINICIO_PREVENTIVO:-0}" = 1 ] && dispositivo_listo; then
  usada="$(memoria_mb)"
  if [ "${usada:-0}" -gt "${ZETA_LIMITE_MB:-6000}" ]; then
    log "el emulador usa ${usada} MB entre RAM y swap: reinicio preventivo"
    viejos="$(pids_emulador | tr '\n' ' ')"
    "$ADB" emu kill >/dev/null 2>&1 || true
    for p in $viejos; do
      timeout 90 bash -c "while [ -e /proc/$p ]; do sleep 2; done" || true
    done
    timeout 30 bash -c "while [ \"\$('$ADB' get-state 2>/dev/null)\" = device ]; do sleep 2; done" || true
  fi
fi

if ! dispositivo_listo; then
  if [ -z "$(pids_emulador)" ]; then
    # MemorySwapMax: sin el, el emulador se come el swap de todo el sistema.
    log "arrancando $AVD (CPU 300%, RAM 4.5 GB + 8 GB de swap, render por software)..."
    en_segundo_plano setsid nohup systemd-run --user --scope --unit="zeta-emulador-$(date +%s)" -p CPUQuota=300% -p MemoryMax=4500M -p MemorySwapMax=8G \
      env QT_QPA_PLATFORM=xcb __GLX_VENDOR_LIBRARY_NAME=mesa LIBGL_ALWAYS_SOFTWARE=1 \
      nice -n 10 "$ANDROID_HOME/emulator/emulator" -avd "$AVD" -gpu swiftshader_indirect \
      -no-snapshot-load -no-snapshot-save -memory 2048 -cores 2 -no-boot-anim -no-audio \
      > "$LOGS/emulador.log" 2>&1 < /dev/null
  else
    log "el emulador ya corre (pid $(pids_emulador | tr '\n' ' ')); esperando a adb..."
  fi
  log "esperando a sys.boot_completed (max 6 min)..."
  if ! timeout 360 bash -c "until [ \"\$('$ADB' shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')\" = 1 ]; do sleep 2; done"; then
    log "ERROR: el emulador no termino de arrancar. Mira $LOGS/emulador.log"
    exit 1
  fi
  log "arrancado"
  RECIEN_ARRANCADO=1
fi

# ---- 2. Puertos del PC dentro del emulador -----------------------------------
for p in "${PUERTOS[@]}"; do "$ADB" reverse "tcp:$p" "tcp:$p" >/dev/null; done

# ---- 3. Pantalla determinista ---------------------------------------------
sh_adb() { "$ADB" shell "$@" >/dev/null 2>&1 || true; }
demo() { sh_adb am broadcast -a com.android.systemui.demo -e command "$@"; }

for k in window_animation_scale transition_animation_scale animator_duration_scale; do
  sh_adb settings put global "$k" 0
done
sh_adb svc power stayon true                       # sin bloqueo de pantalla
sh_adb settings put system screen_off_timeout 1800000
sh_adb cmd uimode night no                         # tema claro
sh_adb settings put secure show_ime_with_hard_keyboard 1
if [ "${RECIEN_ARRANCADO:-0}" = 1 ]; then
  sh_adb input keyevent 82                          # desbloquea tras el arranque
  sh_adb wm dismiss-keyguard
fi

# Tras un arranque en frio, Google Play Services pasa 10-15 min recompilando
# sus modulos y se come los 2 nucleos: cada tecla de Maestro tarda ~10 s y el
# login no llega a escribirse (el 28-10 fallaron asi los tres primeros flujos
# de la suite). Se espera a que el sistema quede en reposo: dos medidas
# seguidas de 5 s con mas del 85 % de CPU libre.
cpu_libre_pct() {  # % de CPU libre del emulador en los proximos 5 s
  local a b
  a="$("$ADB" shell head -1 /proc/stat 2>/dev/null)"; sleep 5
  b="$("$ADB" shell head -1 /proc/stat 2>/dev/null)"
  awk -v a="$a" -v b="$b" 'BEGIN {
    n = split(a, x); split(b, y); t = 0
    for (i = 2; i <= n; i++) t += y[i] - x[i]
    print (t > 0 ? int(100 * (y[5] - x[5]) / t) : 0) }'
}
if [ "${RECIEN_ARRANCADO:-0}" = 1 ]; then
  log "esperando a que el emulador quede en reposo (max 20 min)..."
  seguidas=0; fin=$((SECONDS + 1200))
  while [ "$seguidas" -lt 2 ] && [ "$SECONDS" -lt "$fin" ]; do
    if [ "$(cpu_libre_pct)" -gt 85 ]; then seguidas=$((seguidas + 1)); else seguidas=0; fi
  done
  [ "$seguidas" -ge 2 ] && log "en reposo" || log "AVISO: sigue ocupado tras 20 min; se sigue igual"
fi

sh_adb settings put global sysui_demo_allowed 1
demo enter
demo clock -e hhmm 1200
demo battery -e level 100 -e plugged false -e powersave false
demo network -e wifi show -e level 4 -e fully true
demo network -e mobile hide -e nosim hide
demo notifications -e visible false
demo status -e volume hide -e bluetooth hide -e location hide -e alarm hide -e sync hide

if ! "$ADB" shell pm list packages host.exp.exponent 2>/dev/null | grep -q exponent; then
  log "AVISO: Expo Go (host.exp.exponent) no esta instalado en el emulador"
fi

# ---- 4. Backend local y Metro ----------------------------------------------
if ! responde http://127.0.0.1:54321/auth/v1/health; then
  log "ERROR: Supabase local (127.0.0.1:54321) no responde."
  log "       Levantalo con scripts/supabase_local.sh desde el checkout principal."
  exit 1
fi

if ! responde http://127.0.0.1:8000/health; then
  log "la API (8000) no responde: arrancando ~/.cache/zeta-emulador/api.sh"
  en_segundo_plano setsid nohup "$LOGS/api.sh" > "$LOGS/api.log" 2>&1 < /dev/null
  if ! timeout 90 bash -c 'until curl -s -m 2 -o /dev/null http://127.0.0.1:8000/health; do sleep 2; done'; then
    log "ERROR: la API no arranco. Mira $LOGS/api.log"; exit 1
  fi
fi

# Un Metro ajeno en el 8081 (otra sesion sirviendo su rama desde otro
# worktree) haria que la suite probara ese codigo sin enterarse.
if curl -s -m 3 http://127.0.0.1:8081/status | grep -q running; then
  pid_metro="$(ss -ltnpH 'sport = :8081' 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
  dir_metro="$(readlink "/proc/${pid_metro:-0}/cwd" 2>/dev/null || true)"
  if [ -n "$dir_metro" ] && [ "$dir_metro" != "$REPO/apps/mobile" ]; then
    log "ERROR: el Metro del 8081 (pid $pid_metro) sirve $dir_metro, no $REPO/apps/mobile."
    log "       Paralo (o espera a que lo pare quien lo arranco) y vuelve a lanzar."
    exit 1
  fi
fi
if ! curl -s -m 3 http://127.0.0.1:8081/status | grep -q running; then
  log "Metro (8081) no responde: arrancando desde $REPO/apps/mobile"
  ( cd "$REPO/apps/mobile" && export CI=1 && en_segundo_plano setsid nohup npx expo start --port 8081 \
      > "$LOGS/metro.log" 2>&1 < /dev/null )
  if ! timeout 180 bash -c 'until curl -s -m 2 http://127.0.0.1:8081/status | grep -q running; do sleep 2; done'; then
    log "ERROR: Metro no arranco. Mira $LOGS/metro.log"; exit 1
  fi
fi

log "listo: $("$ADB" get-serialno) con 8081/54321/8000 redirigidos"
