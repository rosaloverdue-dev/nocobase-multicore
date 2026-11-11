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
  if (process.env.MULTICORE_APP_ENTRY) return process.env.MULTICORE_APP_ENTRY;
  if (process.env.APP_PACKAGE_ROOT) return path.resolve(process.cwd(), process.env.APP_PACKAGE_ROOT, 'lib/index.js');
  // bare .env without APP_PACKAGE_ROOT (typical for a local install): the app package is a normal dependency
  return require.resolve('@nocobase/app/lib/index.js', { paths: [process.cwd()] });
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
 * Two things happen at the first TCP listen() of the process, which is the HTTP server of the NocoBase gateway
 * (IPC sockets listen on paths and are untouched):
 *
 * 1. Keep-alive. Node closes an idle keep-alive connection after 5 s by default. The supervisor's balancer keeps
 *    connections to the worker open and reuses them; if the worker's event loop is busy for longer than those 5 s,
 *    the overdue keep-alive timer fires first when the loop wakes up and destroys connections that already carry a
 *    request the worker has not even read yet (the client then gets "Bad gateway"). So the worker keeps idle
 *    connections for a long time (MULTICORE_KEEPALIVE_MS, default 10 min) and the balancer is the one that closes them.
 *
 * 2. Deferred listen. The gateway opens the HTTP port first and loads the app afterwards, answering 503 ("app is
 *    starting") meanwhile. In a cluster the primary would already route live traffic to such a worker. So the worker
 *    defers the listen() until the app reports status "running". The gateway does not wait for the listen callback,
 *    so deferring is safe. MULTICORE_DEFER_LISTEN=0 disables this.
 */
{
  const net = require('node:net');
  const originalListen = net.Server.prototype.listen;
  const KEEPALIVE_MS = Number(process.env.MULTICORE_KEEPALIVE_MS) || 600_000;
  const DEFER = process.env.MULTICORE_DEFER_LISTEN !== '0';
  let seen = false;
  const isTcpPort = (arg) =>
    typeof arg === 'number' || (typeof arg === 'string' && /^\d+$/.test(arg)) || (arg && typeof arg === 'object' && Number(arg.port) > 0);

  const appIsRunning = async () => {
    try {
      const serverPkg = require(require.resolve('@nocobase/server', { paths: [process.cwd()] }));
      return (await serverPkg.AppSupervisor.getInstance().getAppStatus('main')) === 'running';
    } catch (e) {
      return false;
    }
  };

  net.Server.prototype.listen = function (...args) {
    if (seen || !isTcpPort(args[0])) return originalListen.apply(this, args);
    seen = true;
    if (typeof this.keepAliveTimeout === 'number' && this.keepAliveTimeout < KEEPALIVE_MS) this.keepAliveTimeout = KEEPALIVE_MS;
    if (!DEFER) return originalListen.apply(this, args);
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

// Tell the supervisor's balancer that this event loop is alive, and how late the timer fired (= event-loop lag).
// A worker that is busy for seconds (a huge query being serialised) stops sending these, so the balancer sends new
// requests elsewhere until it answers again; a worker that answers late gets fewer new requests.
if (process.send && process.env.MULTICORE_SUPERVISED === '1') {
  const EVERY = 500;
  let expected = Date.now() + EVERY;
  const beat = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - expected);
    expected = now + EVERY;
    try {
      process.send({ cmd: 'multicore', type: 'hb', lag });
    } catch (e) {
      // supervisor gone
    }
  }, EVERY);
  beat.unref?.();
}

require(load());
