import { Plugin } from '@nocobase/server';
import { skipReason } from '../../../shared/src/env';
import { RedisQueueAdapter } from './adapter';

export { RedisQueueAdapter };

export class PluginQueueAdapterRedis extends Plugin {
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
