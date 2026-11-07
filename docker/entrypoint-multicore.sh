#!/bin/sh
# Same boot sequence as the stock NocoBase image (client assets, nginx, scripts), but the last step,
# `yarn start --quickstart`, is replaced by the nocobase-multicore supervisor. See docs/OPERATIONS.md.
set -e
sed 's#^cd /app/nocobase && yarn start --quickstart#cd /app/nocobase \&\& exec node /multicore/bin/nocobase-multicore.js#' /app/docker-entrypoint.sh > /tmp/entrypoint-multicore.sh
if ! grep -q 'nocobase-multicore.js' /tmp/entrypoint-multicore.sh; then
  echo "multicore: could not patch the stock image entrypoint (its last step changed); see docs/OPERATIONS.md" >&2
  exit 1
fi
exec sh /tmp/entrypoint-multicore.sh "$@"
