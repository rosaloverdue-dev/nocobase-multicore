import { Plugin } from '@nocobase/server';
import { skipReason } from '../../../shared/src/env';
import { RedisPubSubAdapter } from './adapter';
import { turnOffClusterMode } from '../../../shared/src/safeguard';

export { RedisPubSubAdapter };

export class PluginPubSubAdapterRedis extends Plugin {
  async beforeDisable() {
    turnOffClusterMode(this.app, 'plugin plugin-pubsub-adapter-redis is being disabled');
  }

  async beforeRemove() {
    turnOffClusterMode(this.app, 'plugin plugin-pubsub-adapter-redis is being removed');
  }

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
