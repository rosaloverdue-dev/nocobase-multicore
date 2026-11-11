/**
 * Removal safety. If any multicore plugin is disabled or removed while cluster mode is switched on, the remaining
 * workers would keep running WITHOUT the shared Redis adapters (locks, events, queue, ids would stop being shared).
 * So the first thing a disabled/removed plugin does is switch the cluster off in the config file; the supervisor then
 * replaces every worker with one plain single-process NocoBase (rolling, no downtime).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cfg = require('../../supervisor/lib/config.js');

export function turnOffClusterMode(app: any, why: string): boolean {
  try {
    const current = cfg.readConfig();
    if (!current.enabled) return false;
    cfg.writeConfig({ ...current, enabled: false, workers: 1, updatedBy: `auto: ${why}` });
    app.logger.warn(`[multicore] ${why}: cluster mode switched off in ${cfg.configPath()}; the supervisor will return to a single process`);
    // A worker has an IPC channel to the supervisor (instant); otherwise the supervisor notices the file within ~10 s.
    if (typeof process.send === 'function' && process.env.MULTICORE_SUPERVISED === '1') {
      process.send({ cmd: 'multicore', type: 'apply' });
    }
    return true;
  } catch (error: any) {
    app.logger.error(`[multicore] could not switch cluster mode off: ${error?.message}`);
    return false;
  }
}
