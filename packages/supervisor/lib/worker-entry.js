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

/**
 * NocoBase's gateway opens the HTTP port first and loads the app afterwards, answering 503 ("app is starting") meanwhile.
 * In a cluster the primary would already route live traffic to such a worker. So the worker defers its first TCP listen()
 * (the gateway's HTTP server; IPC sockets listen on paths and are untouched) until the app reports status "running".
 * The gateway does not wait for the listen callback, so deferring is safe. MULTICORE_DEFER_LISTEN=0 disables this.
 */
if (process.env.MULTICORE_DEFER_LISTEN !== '0') {
  const net = require('node:net');
  const originalListen = net.Server.prototype.listen;
  let deferred = false;
  const isTcpPort = (arg) => typeof arg === 'number' || (typeof arg === 'string' && /^\d+$/.test(arg));

  const appIsRunning = async () => {
    try {
      const serverPkg = require(require.resolve('@nocobase/server', { paths: [process.cwd()] }));
      return (await serverPkg.AppSupervisor.getInstance().getAppStatus('main')) === 'running';
    } catch (e) {
      return false;
    }
  };

  net.Server.prototype.listen = function (...args) {
    if (deferred || !isTcpPort(args[0])) return originalListen.apply(this, args);
    deferred = true;
    const startedAt = Date.now();
    const timeoutMs = Number(process.env.MULTICORE_READY_TIMEOUT_MS) || 300_000;
    const poll = async () => {
      while (Date.now() - startedAt < timeoutMs && !(await appIsRunning())) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      originalListen.apply(this, args);
    };
    poll();
    return this;
  };
}

require(load());
