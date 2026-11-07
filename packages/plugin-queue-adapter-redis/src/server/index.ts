import { Plugin } from '@nocobase/server';
import { skipReason } from '../../../shared/src/env';
import { RedisQueueAdapter } from './adapter';
import { turnOffClusterMode } from '../../../shared/src/safeguard';

export { RedisQueueAdapter };

export class PluginQueueAdapterRedis extends Plugin {
  async beforeDisable() {
    turnOffClusterMode(this.app, 'plugin plugin-queue-adapter-redis is being disabled');
  }

  async beforeRemove() {
    turnOffClusterMode(this.app, 'plugin plugin-queue-adapter-redis is being removed');
  }

  async beforeLoad() {
    const reason = skipReason();
    if (reason) {
      this.app.logger.info(`[multicore] queue adapter not activated: ${reason}`);
      return;
    }
    // EventQueue connects the adapter on "afterStart" and subscribes the channels registered so far.
    this.app.eventQueue.setAdapter(new RedisQueueAdapter(this.app) as any);
    this.app.logger.info('[multicore] queue adapter: redis streams');
  }
}

export default PluginQueueAdapterRedis;
