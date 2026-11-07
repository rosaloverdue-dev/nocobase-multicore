#!/usr/bin/env bash
# Removes nocobase-multicore from NocoBase safely: switches the cluster off first, then disables and removes the plugins.
#   ./uninstall.sh --docker <container>   |   ./uninstall.sh --local <project-dir>
# Option: --purge   ALSO delete storage/multicore (supervisor files + config). Use it only AFTER you have put the original
#                   container entrypoint / start command back, otherwise the container can no longer start.
set -eu
MODE=""; TARGET=""; PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker; TARGET="${2:-}"; shift 2 ;;
    --local) MODE=local; TARGET="${2:-}"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n 2,6p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$MODE" ] && [ -n "$TARGET" ] || { sed -n 2,6p "$0"; exit 2; }
PLUGINS="plugin-multicore plugin-worker-id-allocator-redis plugin-queue-adapter-redis plugin-lock-adapter-redis plugin-pubsub-adapter-redis"
if [ "$MODE" = docker ]; then
  ROOT=/app/nocobase
  run_in() { docker exec -w "$ROOT" "$TARGET" "$@"; }
else
  ROOT=$(cd "$TARGET" && pwd)
  run_in() { (cd "$ROOT" && "$@"); }
fi
STORAGE="$ROOT/storage"

echo "== 1/4 switching cluster mode off (back to one process)"
run_in sh -c "mkdir -p storage/multicore && printf '{\"enabled\":false,\"workers\":1,\"updatedBy\":\"uninstall.sh\"}' > storage/multicore/config.json"
echo "   waiting for the supervisor to replace the workers (up to 90 s)..."
for _ in $(seq 1 30); do
  n=$(run_in sh -c 'cat storage/multicore/status.json 2>/dev/null' | grep -o '"mode": *"cluster"' | wc -l || true)
  [ "${n:-0}" = 0 ] && break
  sleep 3
done

echo "== 2/4 disabling plugins"
# shellcheck disable=SC2046
run_in yarn nocobase pm disable $(for p in $PLUGINS; do printf '@rosal-nb/%s ' "$p"; done) >/dev/null && echo "   disabled" || echo "   (some plugins were already disabled)"
echo "== 3/4 removing plugins"
for p in $PLUGINS; do run_in yarn nocobase pm remove "@rosal-nb/$p" >/dev/null 2>&1 && echo "   removed @rosal-nb/$p" || echo "   @rosal-nb/$p was not registered"; done
run_in sh -c 'rm -rf storage/plugins/@rosal-nb'
echo "== 4/4 files"
if [ "$PURGE" = 1 ]; then
  run_in sh -c 'rm -rf storage/multicore' && echo "   storage/multicore deleted"
else
  echo "   storage/multicore/supervisor kept on purpose (the container may still start through it)"
fi
cat <<'MSG'

Plugins removed; NocoBase is running as a single process again and the site keeps working.
The supervisor files were left in place, so a restart of the container still works even if it still uses the supervisor
entrypoint. To go back to stock NocoBase completely:
  1. delete the `entrypoint:` line / the docker-compose.multicore.yml override (Docker) or start with `yarn start` (local),
  2. restart the app,
  3. optionally run  uninstall.sh --purge  to delete storage/multicore.
MSG
