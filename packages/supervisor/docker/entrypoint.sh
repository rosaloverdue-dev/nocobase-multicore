#!/bin/sh
# Entrypoint for the official nocobase/nocobase image: the stock boot sequence (client assets, nginx, ...) with its
# last step, `yarn start --quickstart`, replaced by the nocobase-multicore supervisor. See docs/OPERATIONS.md.
# This file lives inside the supervisor package (<supervisor>/docker/entrypoint.sh), so it finds the launcher itself.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SUP="${MULTICORE_SUPERVISOR_DIR:-}"
if [ -z "$SUP" ]; then
  if [ -f "$HERE/../bin/nocobase-multicore.js" ]; then SUP=$(cd "$HERE/.." && pwd); else SUP=/multicore; fi
fi
if [ ! -f "$SUP/bin/nocobase-multicore.js" ]; then
  echo "multicore: supervisor not found at $SUP (set MULTICORE_SUPERVISOR_DIR)" >&2
  exit 1
fi
export MULTICORE_APP_ENTRY="${MULTICORE_APP_ENTRY:-/app/nocobase/node_modules/@nocobase/app/lib/index.js}"
sed "s#^cd /app/nocobase && yarn start --quickstart#cd /app/nocobase \&\& exec node $SUP/bin/nocobase-multicore.js#" /app/docker-entrypoint.sh > /tmp/entrypoint-multicore.sh
if ! grep -q 'nocobase-multicore.js' /tmp/entrypoint-multicore.sh; then
  echo "multicore: could not patch the stock image entrypoint (its last step changed); see docs/OPERATIONS.md" >&2
  exit 1
fi
exec sh /tmp/entrypoint-multicore.sh "$@"
