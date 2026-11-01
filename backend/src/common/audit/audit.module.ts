import { Global, Module } from '@nestjs/common';
import { ADMIN_AUDIT_PORT } from '../contracts/admin';
import { AuditService } from './audit.service';

/** Provides ADMIN_AUDIT_PORT (and AuditService) to every module without imports. */
@Global()
@Module({
  providers: [AuditService, { provide: ADMIN_AUDIT_PORT, useExisting: AuditService }],
  exports: [AuditService, ADMIN_AUDIT_PORT],
})
export class AuditModule {}
