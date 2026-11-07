/**
 * Environment contract between the supervisor (or any external orchestrator such as Docker replicas) and the plugins.
 *
 *   MULTICORE_MODE=cluster        activate the Redis adapters in this process (anything else = stock single-process behaviour)
 *   REDIS_URL=redis://host:6379/0 the shared Redis (same variable the NocoBase core uses for its Redis cache)
 *   MULTICORE_NAMESPACE           isolates several NocoBase installations that share one Redis (default: DB_DATABASE)
 *   MULTICORE_REDIS_PREFIX        key prefix inside Redis (default: "mcore")
 */
export function isClusterMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTICORE_MODE === 'cluster';
}

export function redisUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.REDIS_URL || env.MULTICORE_REDIS_URL || undefined;
}

export function namespace(env: NodeJS.ProcessEnv = process.env): string {
  return env.MULTICORE_NAMESPACE || env.DB_DATABASE || 'nocobase';
}

export function keyPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.MULTICORE_REDIS_PREFIX || 'mcore'}:${namespace(env)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Common guard used by every adapter plugin: returns a reason string when the adapter must NOT activate. */
export function skipReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isClusterMode(env)) return 'MULTICORE_MODE is not "cluster" (single-process mode, stock adapters stay active)';
  if (!redisUrl(env)) return 'REDIS_URL is not set';
  return null;
}
