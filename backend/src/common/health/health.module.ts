import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis-health.indicator';

@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json', logger: false })],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
