import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { Clock } from '../time/clock';
import { InMemoryStorageAdapter } from './in-memory-storage.adapter';
import { S3StorageAdapter, type S3StorageOptions } from './s3-storage.adapter';
import { StoragePort } from './storage.port';

export function createStorageAdapter(config: AppConfig, clock: Clock): StoragePort {
  if (config.STORAGE_DRIVER === 's3') {
    const options: S3StorageOptions = {
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      presignTtlSeconds: config.S3_PRESIGN_TTL_SECONDS,
    };
    if (config.S3_ENDPOINT) {
      options.endpoint = config.S3_ENDPOINT;
    }
    if (config.S3_ACCESS_KEY_ID) {
      options.accessKeyId = config.S3_ACCESS_KEY_ID;
    }
    if (config.S3_SECRET_ACCESS_KEY) {
      options.secretAccessKey = config.S3_SECRET_ACCESS_KEY;
    }
    if (config.S3_PUBLIC_BASE_URL) {
      options.publicBaseUrl = config.S3_PUBLIC_BASE_URL;
    }
    return new S3StorageAdapter(options);
  }
  if (!config.isTest) {
    new Logger('StorageModule').warn(
      'STORAGE_DRIVER=memory: uploaded files live in process memory only (development mode)',
    );
  }
  return new InMemoryStorageAdapter(
    config.S3_BUCKET,
    clock,
    config.S3_PRESIGN_TTL_SECONDS,
    config.S3_PUBLIC_BASE_URL,
  );
}

@Global()
@Module({
  providers: [
    {
      provide: StoragePort,
      inject: [APP_CONFIG, Clock],
      useFactory: createStorageAdapter,
    },
  ],
  exports: [StoragePort],
})
export class StorageModule {}
