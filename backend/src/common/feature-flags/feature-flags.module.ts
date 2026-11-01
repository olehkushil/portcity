import { Global, Module } from '@nestjs/common';
import { FEATURE_FLAGS_PORT } from '../contracts/admin';
import { FeatureFlagsService } from './feature-flags.service';

/** Provides FEATURE_FLAGS_PORT (and FeatureFlagsService) to every module without imports. */
@Global()
@Module({
  providers: [
    FeatureFlagsService,
    { provide: FEATURE_FLAGS_PORT, useExisting: FeatureFlagsService },
  ],
  exports: [FeatureFlagsService, FEATURE_FLAGS_PORT],
})
export class FeatureFlagsModule {}
