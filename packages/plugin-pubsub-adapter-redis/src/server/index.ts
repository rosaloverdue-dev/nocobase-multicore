import { Plugin } from '@nocobase/server';
import { skipReason } from '../../../shared/src/env';
import { RedisPubSubAdapter } from './adapter';

export { RedisPubSubAdapter };

export class PluginPubSubAdapterRedis extends Plugin {
  async beforeLoad() {
    const reason = skipReason();
    if (reason) {
      this.app.logger.info(`[multicore] pub/sub adapter not activated: ${reason}`);
      return;
    }
    // Must be set before the app emits "afterStart": PubSubManager.connect() runs there.
    this.app.pubSubManager.setAdapter(new RedisPubSubAdapter(this.app));
    this.app.logger.info('[multicore] pub/sub adapter: redis');
  }
}

export default PluginPubSubAdapterRedis;
