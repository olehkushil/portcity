import { Module } from '@nestjs/common';
import { envSectionProvider } from '../../common/config/env-section';
import { CONTENT_PORT } from '../../common/contracts/content';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { ClubModule } from '../club/club.module';
import { AdminContentImportController } from './controllers/admin-content-import.controller';
import { AdminFiscalNumbersController } from './controllers/admin-fiscal-numbers.controller';
import { AdminMallInfoController } from './controllers/admin-mall-info.controller';
import { AdminTenantRulesController } from './controllers/admin-tenant-rules.controller';
import { AdminTenantsController } from './controllers/admin-tenants.controller';
import { MallController } from './controllers/mall.controller';
import { TenantsController } from './controllers/tenants.controller';
import { ContentImportProcessor } from './jobs/content-import.processor';
import { BaseRateService } from './services/base-rate.service';
import { CONTENT_CONFIG, contentEnvSchema } from './services/content.config';
import { ContentImportQueue } from './services/content-import.queue';
import { ContentImportService } from './services/content-import.service';
import { ContentPortService } from './services/content-port.service';
import { FiscalNumbersService } from './services/fiscal-numbers.service';
import { MallInfoRepository } from './services/mall-info.repository';
import { MallInfoService } from './services/mall-info.service';
import { TenantDirectoryService } from './services/tenant-directory.service';
import { TenantRulesService } from './services/tenant-rules.service';
import { TenantsService } from './services/tenants.service';

/**
 * Content: tenants, the fiscal number whitelist, per-tenant loyalty rules, mall info and the
 * WordPress import stub, plus their /admin endpoints (audited through ADMIN_AUDIT_PORT).
 *
 * Provides CONTENT_PORT (ContentPortService). Depends on club (CLUB_LEDGER_PORT: base rate for
 * the tenant cards; club depends only on identity, so the graph stays acyclic) and the global
 * common layer (PrismaService, Clock, OutboxService, ADMIN_AUDIT_PORT, APP_CONFIG). Consumed by
 * receipts, rewards, promos and admin. Publishes tenant.updated, tenant.fiscal_number_seen,
 * tenant.fiscal_number_confirmed; consumes no events; owns the `content-import` queue
 * (asynchronous WordPress import runs).
 */
@Module({
  imports: [ClubModule, QueueModule.registerQueue(QUEUES.contentImport)],
  controllers: [
    TenantsController,
    MallController,
    AdminTenantsController,
    AdminFiscalNumbersController,
    AdminTenantRulesController,
    AdminContentImportController,
    AdminMallInfoController,
  ],
  providers: [
    envSectionProvider(CONTENT_CONFIG, contentEnvSchema, 'content'),
    TenantsService,
    FiscalNumbersService,
    TenantRulesService,
    MallInfoRepository,
    MallInfoService,
    BaseRateService,
    TenantDirectoryService,
    ContentImportQueue,
    ContentImportService,
    ContentImportProcessor,
    ContentPortService,
    { provide: CONTENT_PORT, useExisting: ContentPortService },
  ],
  exports: [CONTENT_PORT, ContentPortService, TenantsService, FiscalNumbersService],
})
export class ContentModule {}
