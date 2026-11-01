import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { API_PREFIX } from './common/app-info';
import type { AppConfig } from './common/config';

type OriginCallback = (error: Error | null, allow?: boolean) => void;

/** Exact-match allowlist; requests without an Origin header (mobile apps, curl) are allowed. */
export function corsOriginChecker(
  allowlist: readonly string[],
): (origin: string | undefined, callback: OriginCallback) => void {
  const allowAll = allowlist.includes('*');
  return (origin, callback) => {
    callback(null, !origin || allowAll || allowlist.includes(origin));
  };
}

/**
 * HTTP settings shared by src/main.ts and test/utils/app-factory.ts so e2e tests run
 * the same pipeline as production: proxy trust, helmet, CORS, prefix, shutdown hooks.
 * Global pipe/filter/guard are registered in AppModule via APP_* providers.
 */
export function configureHttpApp(app: NestExpressApplication, config: AppConfig): void {
  // false | hop count | trusted proxy networks (see src/common/config/trust-proxy.ts). Never
  // `true`: trusting every hop would let any client choose its own IP through X-Forwarded-For.
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  app.enableCors({
    origin: corsOriginChecker(config.CORS_ORIGINS),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Validator-Key',
      'X-Validator-Shift',
    ],
    exposedHeaders: ['x-request-id', 'Idempotent-Replayed'],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'ready'] });
  app.enableShutdownHooks();
}
