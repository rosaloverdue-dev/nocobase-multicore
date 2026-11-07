#!/usr/bin/env bash
# Installs the whole nocobase-multicore package (5 plugins + supervisor) into an existing NocoBase 2.x.
#
#   ./install.sh --docker <container>     NocoBase runs in Docker (official image nocobase/nocobase)
#   ./install.sh --local  <project-dir>   NocoBase runs from a project directory (yarn nocobase ...)
#
# Docker + docker compose (the usual setup): ONE command does everything - installs and enables the plugins, adds a
# Redis container to your compose project (unless the app already has REDIS_URL), switches the app to the supervisor
# entrypoint and recreates the app container. Then open Settings -> Multi-core mode (or pass --workers N).
#
# Options:
#   --workers N        also switch multi-core mode on right away with N workers (default: leave it off, switch in the UI)
#   --redis-url URL    use this Redis instead of creating one (also the only way to give a Redis to --local installs)
#   --no-switch        install the plugins only; do not touch compose / the entrypoint / Redis
#   --no-enable        only register the plugins, do not enable them
#   --from <dir>       folder with the *.tgz packages (default: next to this script, ../build, newest ../releases/v*/)
#   --restart          (docker, with --no-switch) restart the container afterwards
# The script is idempotent: running it again replaces the plugin files and re-registers them.
set -eu

MODE=""; TARGET=""; FROM=""; ENABLE=1; RESTART=0; SWITCH=1; WORKERS=""; REDIS_URL_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker; TARGET="${2:-}"; shift 2 ;;
    --local) MODE=local; TARGET="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --workers) WORKERS="${2:-}"; shift 2 ;;
    --redis-url) REDIS_URL_ARG="${2:-}"; shift 2 ;;
    --no-switch) SWITCH=0; shift ;;
    --no-enable) ENABLE=0; shift ;;
    --restart) RESTART=1; shift ;;
    -h|--help) sed -n 2,22p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$MODE" ] && [ -n "$TARGET" ] || { sed -n 2,22p "$0"; exit 2; }
case "$WORKERS" in ""|[0-9]*) ;; *) echo "--workers needs a number" >&2; exit 2 ;; esac

HERE=$(cd "$(dirname "$0")" && pwd)
if [ -z "$FROM" ]; then
  if ls "$HERE"/nb-multicore-plugin-*.tgz >/dev/null 2>&1; then FROM="$HERE"
  elif ls "$HERE"/../build/nb-multicore-plugin-*.tgz >/dev/null 2>&1; then FROM="$HERE/../build"
  else FROM=$(ls -d "$HERE"/../releases/v*/ 2>/dev/null | sort -V | tail -1 || true); FROM="${FROM%/}"; fi
fi
[ -n "$FROM" ] || FROM="$HERE/../build"
ls "$FROM"/nb-multicore-plugin-*.tgz >/dev/null 2>&1 || { echo "No nb-multicore-plugin-*.tgz in $FROM (use --from, or run 'node scripts/build.mjs')" >&2; exit 1; }
SUPERVISOR_TGZ=$(ls "$FROM"/nocobase-multicore-supervisor-*.tgz 2>/dev/null | head -1 || true)

PLUGINS="plugin-pubsub-adapter-redis plugin-lock-adapter-redis plugin-queue-adapter-redis plugin-worker-id-allocator-redis plugin-multicore"
tgz_of() { ls "$FROM"/nb-multicore-"$1"-[0-9]*.tgz 2>/dev/null | sort | tail -1; }

if [ "$MODE" = docker ]; then
  [ "$(docker inspect -f '{{.State.Running}}' "$TARGET" 2>/dev/null)" = true ] || { echo "Container '$TARGET' is not running (docker ps)" >&2; exit 1; }
  ROOT=/app/nocobase
  run_in() { docker exec -w "$ROOT" "$TARGET" "$@"; }
  put() { # put <tgz> <dir-inside-container>
    docker exec -i "$TARGET" sh -c "rm -rf '$2' && mkdir -p '$2' && tar xzf - -C '$2'" < "$1"
  }
else
  ROOT=$(cd "$TARGET" && pwd)
  [ -f "$ROOT/package.json" ] || { echo "$ROOT is not a NocoBase project (no package.json)" >&2; exit 1; }
  run_in() { (cd "$ROOT" && "$@"); }
  put() { rm -rf "$2" && mkdir -p "$2" && tar xzf "$1" -C "$2"; }
fi
STORAGE="$ROOT/storage"

echo "== 1/5 plugin files -> $STORAGE/plugins/@nb-multicore"
for p in $PLUGINS; do
  f=$(tgz_of "$p"); [ -n "$f" ] || { echo "missing package for $p in $FROM" >&2; exit 1; }
  put "$f" "$STORAGE/plugins/@nb-multicore/$p"
  echo "   $p <- $(basename "$f")"
done

echo "== 2/5 supervisor -> $STORAGE/multicore/supervisor"
if [ -n "$SUPERVISOR_TGZ" ]; then put "$SUPERVISOR_TGZ" "$STORAGE/multicore/supervisor"; else echo "   (no supervisor package found, skipped)"; fi

echo "== 3/5 linking plugins into NocoBase"
# NocoBase 2.x: 'pm add <name>' does nothing for plugins that are already in storage/plugins; what registers them is
# the postinstall step (symlinks into node_modules) followed by 'pm enable' (which creates the database rows).
run_in yarn nocobase postinstall >/dev/null && echo "   linked"

echo "== 4/5 enabling plugins"
if [ "$ENABLE" = 1 ]; then
  # shellcheck disable=SC2046
  run_in yarn nocobase pm enable $(for p in $PLUGINS; do printf '@nb-multicore/%s ' "$p"; done) >/dev/null && echo "   enabled"
else
  echo "   skipped (--no-enable)"
fi

SUP_ENTRY="/app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh"
CONFIG_JSON='{"enabled":true,"workers":'"${WORKERS:-0}"',"updatedBy":"installer"}'

write_config() { # write storage/multicore/config.json when --workers was given
  [ -n "$WORKERS" ] && [ "$WORKERS" -ge 1 ] || return 0
  if [ "$MODE" = docker ]; then
    docker exec "$TARGET" sh -c "mkdir -p '$STORAGE/multicore' && printf '%s' '$CONFIG_JSON' > '$STORAGE/multicore/config.json'"
  else
    mkdir -p "$STORAGE/multicore" && printf '%s' "$CONFIG_JSON" > "$STORAGE/multicore/config.json"
  fi
  echo "   multi-core mode switched on: $WORKERS workers"
}

if [ "$MODE" = docker ]; then
  write_config
  LABEL() { docker inspect -f "{{ index .Config.Labels \"$1\" }}" "$TARGET" 2>/dev/null; }
  PROJECT_DIR=$(LABEL com.docker.compose.project.working_dir); SERVICE=$(LABEL com.docker.compose.service)
  CONFIG_FILES=$(LABEL com.docker.compose.project.config_files)
  STORAGE_MOUNTED=$(docker inspect -f '{{ range .Mounts }}{{ .Destination }} {{ end }}' "$TARGET" | tr ' ' '\n' | grep -cx '/app/nocobase/storage' || true)
  CUR_ENTRY=$(docker inspect -f '{{ join .Config.Entrypoint " " }}' "$TARGET")
  EXISTING_REDIS=$(docker inspect -f '{{ range .Config.Env }}{{ println . }}{{ end }}' "$TARGET" | sed -n 's/^REDIS_URL=//p' | head -1)

  if [ "$SWITCH" = 1 ] && [ -n "$PROJECT_DIR" ] && [ -n "$SERVICE" ] && [ -n "$CONFIG_FILES" ] && [ "$STORAGE_MOUNTED" -ge 1 ] && docker compose version >/dev/null 2>&1; then
    echo "== 5/5 Redis + supervisor entrypoint (docker compose project in $PROJECT_DIR, service '$SERVICE')"
    OVERRIDE="$PROJECT_DIR/docker-compose.multicore.yml"
    NETWORK=$(docker inspect -f '{{ range $k, $v := .NetworkSettings.Networks }}{{ $k }} {{ end }}' "$TARGET" | awk '{print $1}')
    REDIS_URL_USED="${REDIS_URL_ARG:-$EXISTING_REDIS}"
    {
      echo "# Generated by nocobase-multicore install.sh - delete this file (and re-run 'docker compose up -d') to return to stock NocoBase."
      echo "services:"
      echo "  $SERVICE:"
      echo "    entrypoint: [\"/bin/sh\", \"$SUP_ENTRY\"]"
      if [ -z "$REDIS_URL_USED" ]; then
        REDIS_URL_USED="redis://multicore-redis:6379/0"
        echo "    environment:"
        echo "      REDIS_URL: $REDIS_URL_USED"
        echo "    depends_on:"
        echo "      - multicore-redis"
        echo "  multicore-redis:"
        echo "    image: redis:7-alpine"
        echo "    restart: unless-stopped"
        echo "    command: [\"redis-server\", \"--maxmemory-policy\", \"noeviction\", \"--appendonly\", \"yes\"]"
        echo "    volumes:"
        echo "      - multicore-redis-data:/data"
        echo "    networks:"
        echo "      - multicore_net"
        echo "volumes:"
        echo "  multicore-redis-data: {}"
        echo "networks:"
        echo "  multicore_net:"
        echo "    name: $NETWORK"
        echo "    external: true"
      elif [ -n "$REDIS_URL_ARG" ]; then
        echo "    environment:"
        echo "      REDIS_URL: $REDIS_URL_ARG"
      fi
    } > "$OVERRIDE"
    echo "   wrote $OVERRIDE (Redis: $REDIS_URL_USED)"
    FILES=""; OLDIFS=$IFS; IFS=,; for f in $CONFIG_FILES; do [ "$f" = "$OVERRIDE" ] || FILES="$FILES -f $f"; done; IFS=$OLDIFS
    echo "   recreating '$SERVICE' (a short restart of the site)..."
    # shellcheck disable=SC2086
    docker compose --project-directory "$PROJECT_DIR" $FILES -f "$OVERRIDE" up -d --no-build $( [ -z "${EXISTING_REDIS}${REDIS_URL_ARG}" ] && echo multicore-redis ) "$SERVICE" >/dev/null 2>&1 \
      || { echo "   docker compose failed - run it by hand: docker compose$FILES -f $OVERRIDE up -d" >&2; exit 1; }
    NEW=$(docker compose --project-directory "$PROJECT_DIR" $FILES -f "$OVERRIDE" ps -q "$SERVICE" | head -1)
    echo -n "   waiting for the supervisor"
    for _ in $(seq 1 90); do
      if docker logs "$NEW" 2>&1 | grep -q '\[multicore\] reconcile done'; then break; fi
      echo -n "."; sleep 4
    done
    echo
    docker logs "$NEW" 2>&1 | grep '\[multicore\]' | tail -3 | sed 's/^/   /'
    SWITCHED=1
  else
    SWITCHED=0
    if [ "$SWITCH" = 1 ]; then echo "(not a docker compose service with a mounted storage volume - cannot switch the entrypoint automatically)"; fi
    [ "$RESTART" = 1 ] && { docker restart "$TARGET" >/dev/null; echo "container restarted"; }
  fi
  if [ "${SWITCHED:-0}" = 1 ]; then
    cat <<MSG

Done. NocoBase now runs under the supervisor (Redis: ${REDIS_URL_USED}).
Open  Settings -> Multi-core mode  and $( [ -n "$WORKERS" ] && echo "check the worker table (multi-core is ON with $WORKERS workers)" || echo "turn the switch on" ).
To undo: ./uninstall.sh --docker $TARGET
MSG
  else
    cat <<'MSG'

Done. The plugins are installed, but NocoBase still runs as ONE process until it is started under the supervisor:
  1. give the app a Redis:        environment:  REDIS_URL: redis://redis:6379/0
  2. use the supervisor entrypoint (service of the app):
         entrypoint: ["/bin/sh", "/app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh"]
  3. docker compose up -d
  4. Open  Settings -> Multi-core mode  and turn the switch on.
MSG
  fi
else
  write_config
  if [ -n "$REDIS_URL_ARG" ]; then
    if grep -qs '^REDIS_URL=' "$ROOT/.env"; then echo "   .env already has REDIS_URL - left untouched"; else printf '\nREDIS_URL=%s\n' "$REDIS_URL_ARG" >> "$ROOT/.env"; echo "   REDIS_URL added to $ROOT/.env"; fi
  fi
  cat <<MSG

Done. The plugins are installed. NocoBase still runs as ONE process until you start it under the supervisor:

  1. $( grep -qs '^REDIS_URL=' "$ROOT/.env" && echo "REDIS_URL is set in .env - make sure that Redis is running" || echo "Set REDIS_URL in $ROOT/.env (e.g. REDIS_URL=redis://127.0.0.1:6379/0) and run Redis, or re-run this script with --redis-url" )
  2. Stop the running NocoBase and start it through the supervisor instead of 'yarn start' (from $ROOT):
         node storage/multicore/supervisor/bin/nocobase-multicore.js
     (PM2 / systemd: use that command as the process to run)
  3. Open  Settings -> Multi-core mode,  turn the switch on, choose the number of workers, press Apply.
MSG
fi
echo
echo "Remove everything again with uninstall.sh. Docs: https://github.com/rosaloverdue-dev/nocobase-multicore"
