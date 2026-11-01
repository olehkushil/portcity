import { AdminErrors } from '../../modules/admin/domain/errors';
import { ClubErrors } from '../../modules/club/domain/errors';
import { ContentErrors } from '../../modules/content/domain/errors';
import { IdentityErrors } from '../../modules/identity/domain/errors';
import { NotificationErrors } from '../../modules/notifications/domain/errors';
import { ParkingErrors } from '../../modules/parking/domain/errors';
import { PaymentErrors } from '../../modules/payments/domain/errors';
import { PromosErrors } from '../../modules/promos/domain/errors';
import { ReceiptErrors } from '../../modules/receipts/domain/errors';
import { RewardsErrors } from '../../modules/rewards/domain/errors';
import { ADMIN_ERROR_CODES } from './admin';
import { CLUB_ERROR_CODES } from './club';
import { CONTENT_ERROR_CODES } from './content';
import { IDENTITY_ERROR_CODES } from './identity';
import { NOTIFICATIONS_ERROR_CODES } from './notifications';
import { PARKING_ERROR_CODES } from './parking';
import { PAYMENTS_ERROR_CODES } from './payments';
import { PROMOS_ERROR_CODES } from './promos';
import { RECEIPT_ERROR_CODES } from './receipts';
import { REWARDS_ERROR_CODES } from './rewards';

/**
 * Integration check: the `*_ERROR_CODES` lists in the contracts are the public registry the
 * back-office and app clients read, so every code a module registers with defineErrorCodes must
 * be listed in its contract, and every listed code must be registered.
 */
const MODULES: ReadonlyArray<[string, Record<string, string>, readonly string[]]> = [
  ['identity', IdentityErrors, IDENTITY_ERROR_CODES],
  ['club', ClubErrors, CLUB_ERROR_CODES],
  ['content', ContentErrors, CONTENT_ERROR_CODES],
  ['receipts', ReceiptErrors, RECEIPT_ERROR_CODES],
  ['rewards', RewardsErrors, REWARDS_ERROR_CODES],
  ['promos', PromosErrors, PROMOS_ERROR_CODES],
  ['parking', ParkingErrors, PARKING_ERROR_CODES],
  ['payments', PaymentErrors, PAYMENTS_ERROR_CODES],
  ['notifications', NotificationErrors, NOTIFICATIONS_ERROR_CODES],
  ['admin', AdminErrors, ADMIN_ERROR_CODES],
];

describe('contract error code registries', () => {
  it.each(MODULES)('%s lists exactly the codes it registers', (_name, registered, listed) => {
    expect([...listed].sort()).toEqual(Object.keys(registered).sort());
  });

  it('no code is claimed by two modules', () => {
    const all = MODULES.flatMap(([, , listed]) => [...listed]);
    expect(new Set(all).size).toBe(all.length);
  });
});
