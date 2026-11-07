#!/usr/bin/env bash
# Installs the whole nocobase-multicore package (5 plugins + supervisor) into an existing NocoBase 2.x.
#
#   ./install.sh --docker <container>        NocoBase runs in Docker (official image nocobase/nocobase)
#   ./install.sh --local  <project-dir>      NocoBase runs from a project directory (yarn nocobase ...)
#
# Options:  --from <dir>   folder with the *.tgz packages (default: next to this script, else ../build)
#           --no-enable    only register the plugins, do not enable them
#           --restart      (docker) restart the container afterwards
# Packages are looked up in: --from, next to this script (unpacked bundle), ../build (after `node scripts/build.mjs`),
# then the newest ../releases/v*/ folder of a repository checkout.
# The script is idempotent: running it again replaces the plugin files and re-registers them.
set -eu

MODE=""; TARGET=""; FROM=""; ENABLE=1; RESTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker; TARGET="${2:-}"; shift 2 ;;
    --local) MODE=local; TARGET="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --no-enable) ENABLE=0; shift ;;
    --restart) RESTART=1; shift ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$MODE" ] && [ -n "$TARGET" ] || { sed -n 2,14p "$0"; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
if [ -z "$FROM" ]; then
  if ls "$HERE"/rosal-nb-plugin-*.tgz >/dev/null 2>&1; then FROM="$HERE"
  elif ls "$HERE"/../build/rosal-nb-plugin-*.tgz >/dev/null 2>&1; then FROM="$HERE/../build"
  else FROM=$(ls -d "$HERE"/../releases/v*/ 2>/dev/null | sort -V | tail -1 || true); FROM="${FROM%/}"; fi
fi
[ -n "$FROM" ] || FROM="$HERE/../build"
ls "$FROM"/rosal-nb-plugin-*.tgz >/dev/null 2>&1 || { echo "No rosal-nb-plugin-*.tgz in $FROM (use --from, or run 'node scripts/build.mjs')" >&2; exit 1; }
SUPERVISOR_TGZ=$(ls "$FROM"/nocobase-multicore-supervisor-*.tgz 2>/dev/null | head -1 || true)

PLUGINS="plugin-pubsub-adapter-redis plugin-lock-adapter-redis plugin-queue-adapter-redis plugin-worker-id-allocator-redis plugin-multicore"
tgz_of() { ls "$FROM"/rosal-nb-"$1"-[0-9]*.tgz 2>/dev/null | sort | tail -1; }

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

echo "== 1/4 plugin files -> $STORAGE/plugins/@rosal-nb"
for p in $PLUGINS; do
  f=$(tgz_of "$p"); [ -n "$f" ] || { echo "missing package for $p in $FROM" >&2; exit 1; }
  put "$f" "$STORAGE/plugins/@rosal-nb/$p"
  echo "   $p <- $(basename "$f")"
done

echo "== 2/4 supervisor -> $STORAGE/multicore/supervisor"
if [ -n "$SUPERVISOR_TGZ" ]; then put "$SUPERVISOR_TGZ" "$STORAGE/multicore/supervisor"; else echo "   (no supervisor package found, skipped)"; fi

echo "== 3/4 registering plugins in NocoBase"
for p in $PLUGINS; do run_in yarn nocobase pm add "@rosal-nb/$p" >/dev/null && echo "   added @rosal-nb/$p"; done

echo "== 4/4 enabling plugins"
if [ "$ENABLE" = 1 ]; then
  # shellcheck disable=SC2046
  run_in yarn nocobase pm enable $(for p in $PLUGINS; do printf '@rosal-nb/%s ' "$p"; done) >/dev/null && echo "   enabled"
else
  echo "   skipped (--no-enable)"
fi

[ "$MODE" = docker ] && [ "$RESTART" = 1 ] && { docker restart "$TARGET" >/dev/null; echo "container restarted"; }

cat <<MSG

Done. The plugins are installed. NocoBase still runs as ONE process until you start it under the supervisor:
MSG
if [ "$MODE" = docker ]; then
cat <<'MSG'

  1. Make sure your compose file has a Redis service and REDIS_URL for the app, e.g.
         environment:  REDIS_URL: redis://redis:6379/0
  2. Switch the app container to the supervisor entrypoint (one line in docker-compose.yml, service `app`):
         entrypoint: ["/bin/sh", "/app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh"]
     (or add docker/docker-compose.multicore.yml as a second -f file)
  3. docker compose up -d app
  4. Open  Settings -> Multi-core mode,  turn the switch on, choose the number of workers, press Apply.
MSG
else
cat <<MSG

  1. Set REDIS_URL in the project's .env (e.g. REDIS_URL=redis://127.0.0.1:6379/0) and make sure Redis is running.
  2. Start NocoBase through the supervisor instead of 'yarn start' (from $ROOT):
         node storage/multicore/supervisor/bin/nocobase-multicore.js
  3. Open  Settings -> Multi-core mode,  turn the switch on, choose the number of workers, press Apply.
MSG
fi
echo
echo "Remove everything again with scripts/uninstall.sh. Docs: https://github.com/rosaloverdue-dev/nocobase-multicore"
