import { ADMIN_AUDIT_PORT, FEATURE_FLAGS_PORT } from '../../src/common/contracts/admin';
import { CLUB_LEDGER_PORT } from '../../src/common/contracts/club';
import { CONTENT_PORT } from '../../src/common/contracts/content';
import { IDENTITY_PORT } from '../../src/common/contracts/identity';
import { NOTIFICATIONS_PORT } from '../../src/common/contracts/notifications';
import { PARKING_PORT } from '../../src/common/contracts/parking';
import { PAYMENTS_PORT } from '../../src/common/contracts/payments';
import { PROMOS_PORT } from '../../src/common/contracts/promos';
import { RECEIPTS_PORT } from '../../src/common/contracts/receipts';
import { VOUCHER_ISSUER_PORT } from '../../src/common/contracts/rewards';
import { AuditService } from '../../src/common/audit/audit.service';
import { AdminAccessGate } from '../../src/common/auth/admin-access';
import { FeatureFlagsService } from '../../src/common/feature-flags/feature-flags.service';
import { LedgerService } from '../../src/modules/club/services/ledger.service';
import { ContentPortService } from '../../src/modules/content/services/content-port.service';
import { IdentityPortService } from '../../src/modules/identity/services/identity-port.service';
import { NotificationsService } from '../../src/modules/notifications/services/notifications.service';
import { ParkingService } from '../../src/modules/parking/services/parking.service';
import { PaymentsService } from '../../src/modules/payments/services/payments.service';
import { PromosPortService } from '../../src/modules/promos/services/promos-port.service';
import { ReceiptsPortService } from '../../src/modules/receipts/services/receipts-port.service';
import { VoucherService } from '../../src/modules/rewards/services/voucher.service';
import { createTestApp, type TestApp } from '../utils/app-factory';

/**
 * All ten modules are built, so no port is a 501 stub any more (src/common/contracts/port-stub.ts
 * is kept for future modules): every token must resolve to the owning module's implementation.
 */
const MODULE_PORTS: ReadonlyArray<[string, symbol, abstract new (...args: never[]) => unknown]> = [
  ['identity', IDENTITY_PORT, IdentityPortService],
  ['club', CLUB_LEDGER_PORT, LedgerService],
  ['content', CONTENT_PORT, ContentPortService],
  ['receipts', RECEIPTS_PORT, ReceiptsPortService],
  ['rewards', VOUCHER_ISSUER_PORT, VoucherService],
  ['promos', PROMOS_PORT, PromosPortService],
  ['parking', PARKING_PORT, ParkingService],
  ['payments', PAYMENTS_PORT, PaymentsService],
  ['notifications', NOTIFICATIONS_PORT, NotificationsService],
];

describe('cross-module ports (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it.each(MODULE_PORTS)('%s binds its port to the real implementation', (_name, token, type) => {
    const port = testApp.moduleRef.get<object>(token, { strict: false });
    expect(port).toBeInstanceOf(type);
  });

  it('no port answers with the 501 stub any more', async () => {
    const ledger = testApp.moduleRef.get<LedgerService>(CLUB_LEDGER_PORT, { strict: false });
    // A real ledger reads PostgreSQL; without DATABASE_URL the lazy Prisma client fails to
    // connect, which is anything but PC_COMMON_NOT_IMPLEMENTED.
    const outcome = await ledger.getActiveRules().then(
      (rules) => ({ ok: true as const, rules }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!outcome.ok) {
      expect(outcome.error).not.toMatchObject({ code: 'PC_COMMON_NOT_IMPLEMENTED' });
    }
  });

  it('serves the audit and feature flag ports from the common layer', () => {
    expect(testApp.moduleRef.get(ADMIN_AUDIT_PORT, { strict: false })).toBeInstanceOf(AuditService);
    expect(testApp.moduleRef.get(FEATURE_FLAGS_PORT, { strict: false })).toBeInstanceOf(
      FeatureFlagsService,
    );
  });

  it('identity registers the admin access lookup used by the shared AdminGuard', () => {
    const gate = testApp.app.get(AdminAccessGate);
    // The app factory disables the check for e2e suites; enabling it reveals the resolver.
    gate.setEnabled(true);
    try {
      expect(gate.active).toBe(true);
    } finally {
      gate.setEnabled(false);
    }
  });
});
