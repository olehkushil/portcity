import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config';

/** Injection token for the shared ioredis client (cache, rate limits, locks). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Lazy ioredis client: nothing connects until the first command, so the API boots
 * without Redis in tests. Reconnects with a capped backoff once a command was issued.
 */
export function createRedisClient(url: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    enableReadyCheck: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    ...overrides,
  });
  const logger = new Logger('Redis');
  client.on('error', (error: Error) => logger.warn(`Redis error: ${error.message}`));
  return client;
}

export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'wait' || client.status === 'end') {
    client.disconnect();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRedisClient(config.REDIS_URL),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedisClient(this.client);
  }
}
