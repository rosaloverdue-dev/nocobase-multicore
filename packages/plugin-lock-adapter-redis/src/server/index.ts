import { Plugin } from '@nocobase/server';
import { skipReason } from '../../../shared/src/env';
import { RedisLockAdapter } from './adapter';
import { turnOffClusterMode } from '../../../shared/src/safeguard';

export { RedisLockAdapter };

export class PluginLockAdapterRedis extends Plugin {
  async beforeDisable() {
    turnOffClusterMode(this.app, 'plugin plugin-lock-adapter-redis is being disabled');
  }

  async beforeRemove() {
    turnOffClusterMode(this.app, 'plugin plugin-lock-adapter-redis is being removed');
  }

  async beforeLoad() {
    const reason = skipReason();
    if (reason) {
      this.app.logger.info(`[multicore] lock adapter not activated: ${reason}`);
      return;
    }
    const lockManager: any = this.app.lockManager;
    lockManager.registerAdapter('redis', { Adapter: RedisLockAdapter, options: { app: this.app } });
    // LockManager reads LOCK_ADAPTER_DEFAULT once in the Application constructor; switch it here instead of
    // requiring the operator to export an env var that would break the app when this plugin is disabled.
    lockManager.options = { ...(lockManager.options || {}), defaultAdapter: 'redis' };
    this.app.logger.info('[multicore] lock adapter: redis');
  }
}

export default PluginLockAdapterRedis;
