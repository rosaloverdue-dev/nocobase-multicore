'use strict';
/**
 * Entry of every worker process (cluster.setupPrimary({ exec })). It reproduces what `nocobase start` does before
 * it launches the app (load .env, resolve APP_PACKAGE_ROOT and the other variables set by the CLI's initEnv),
 * then loads the NocoBase app entry in THIS process, so the worker shares the supervisor's listening port.
 */
const path = require('node:path');

function load() {
  if (process.env.MULTICORE_APP_ENTRY && process.env.MULTICORE_SKIP_INITENV === '1') return process.env.MULTICORE_APP_ENTRY;
  let util;
  try {
    util = require(require.resolve('@nocobase/cli-v1/src/util', { paths: [process.cwd()] }));
  } catch (e) {
    util = require(require.resolve('@nocobase/cli/src/util', { paths: [process.cwd()] }));
  }
  util.initEnv();
  return process.env.MULTICORE_APP_ENTRY || path.resolve(process.cwd(), process.env.APP_PACKAGE_ROOT, 'lib/index.js');
}

// NocoBase stops the app on SIGTERM but leaves the process alive (open handles), which would make every rolling
// replace wait for the supervisor's SIGKILL. Give the app time to stop gracefully, then exit.
const EXIT_GRACE_MS = Number(process.env.MULTICORE_EXIT_GRACE_MS) || 10_000;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    const timer = setTimeout(() => process.exit(0), EXIT_GRACE_MS);
    timer.unref?.();
  });
}

require(load());
