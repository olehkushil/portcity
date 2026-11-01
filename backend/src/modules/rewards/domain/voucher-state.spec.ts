import { VOUCHER_STATUSES, type VoucherStatus } from '../../../common/contracts/rewards';
import {
  type SweepAction,
  type VoucherLifecycleSnapshot,
  type VoucherTransition,
  VOUCHER_FINAL_STATUSES,
  VOUCHER_LIVE_STATUSES,
  canTransitionVoucher,
  effectiveVoucherStatus,
  isActivationLive,
  isFinalVoucherStatus,
  isLiveVoucherStatus,
  nextVoucherStatus,
  planSweepAction,
} from './voucher-state';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const at = (offsetSeconds: number): Date => new Date(NOW.getTime() + offsetSeconds * 1000);

describe('voucher state machine', () => {
  const transitions: Array<[VoucherStatus, VoucherTransition, VoucherStatus | null]> = [
    ['issued', 'activate', 'active'],
    ['issued', 'deactivate', null],
    ['issued', 'redeem', null],
    ['issued', 'expire', 'expired'],
    ['issued', 'cancel', 'cancelled'],
    ['active', 'activate', 'active'],
    ['active', 'deactivate', 'issued'],
    ['active', 'redeem', 'redeemed'],
    ['active', 'expire', 'expired'],
    ['active', 'cancel', 'cancelled'],
    ['redeemed', 'activate', null],
    ['redeemed', 'deactivate', null],
    ['redeemed', 'redeem', null],
    ['redeemed', 'expire', null],
    ['redeemed', 'cancel', null],
    ['expired', 'activate', null],
    ['expired', 'redeem', null],
    ['expired', 'cancel', null],
    ['cancelled', 'activate', null],
    ['cancelled', 'redeem', null],
    ['cancelled', 'expire', null],
  ];

  it.each(transitions)('%s --%s--> %s', (from, transition, expected) => {
    expect(nextVoucherStatus(from, transition)).toBe(expected);
    expect(canTransitionVoucher(from, transition)).toBe(expected !== null);
  });

  it('final and live statuses partition the status list', () => {
    expect([...VOUCHER_FINAL_STATUSES, ...VOUCHER_LIVE_STATUSES].sort()).toEqual(
      [...VOUCHER_STATUSES].sort(),
    );
    for (const status of VOUCHER_STATUSES) {
      expect(isFinalVoucherStatus(status)).toBe(!isLiveVoucherStatus(status));
    }
  });

  it.each(VOUCHER_FINAL_STATUSES)('final status %s has no outgoing transition', (status) => {
    const all: VoucherTransition[] = ['activate', 'deactivate', 'redeem', 'expire', 'cancel'];
    expect(all.filter((transition) => canTransitionVoucher(status, transition))).toEqual([]);
  });
});

describe('effectiveVoucherStatus / planSweepAction', () => {
  const cases: Array<{
    name: string;
    voucher: VoucherLifecycleSnapshot;
    effective: VoucherStatus;
    sweep: SweepAction;
    live: boolean;
  }> = [
    {
      name: 'issued without expiry stays issued',
      voucher: { status: 'issued', activationExpiresAt: null, expiresAt: null },
      effective: 'issued',
      sweep: 'none',
      live: false,
    },
    {
      name: 'issued past expiresAt reads as expired',
      voucher: { status: 'issued', activationExpiresAt: null, expiresAt: at(-1) },
      effective: 'expired',
      sweep: 'expire',
      live: false,
    },
    {
      name: 'issued exactly at expiresAt is expired (bound is exclusive)',
      voucher: { status: 'issued', activationExpiresAt: null, expiresAt: at(0) },
      effective: 'expired',
      sweep: 'expire',
      live: false,
    },
    {
      name: 'active inside the window stays active',
      voucher: { status: 'active', activationExpiresAt: at(60), expiresAt: at(3600) },
      effective: 'active',
      sweep: 'none',
      live: true,
    },
    {
      name: 'active with a lapsed window returns to issued',
      voucher: { status: 'active', activationExpiresAt: at(-1), expiresAt: at(3600) },
      effective: 'issued',
      sweep: 'deactivate',
      live: false,
    },
    {
      name: 'active at the exact end of the window has lapsed',
      voucher: { status: 'active', activationExpiresAt: at(0), expiresAt: null },
      effective: 'issued',
      sweep: 'deactivate',
      live: false,
    },
    {
      name: 'active without a window end is treated as lapsed',
      voucher: { status: 'active', activationExpiresAt: null, expiresAt: null },
      effective: 'issued',
      sweep: 'deactivate',
      live: false,
    },
    {
      name: 'active past expiresAt expires even with a live window',
      voucher: { status: 'active', activationExpiresAt: at(60), expiresAt: at(-5) },
      effective: 'expired',
      sweep: 'expire',
      live: false,
    },
    {
      name: 'active with lapsed window and passed expiresAt expires (no return to issued)',
      voucher: { status: 'active', activationExpiresAt: at(-30), expiresAt: at(-10) },
      effective: 'expired',
      sweep: 'expire',
      live: false,
    },
    {
      name: 'redeemed is final whatever the dates',
      voucher: { status: 'redeemed', activationExpiresAt: at(-30), expiresAt: at(-10) },
      effective: 'redeemed',
      sweep: 'none',
      live: false,
    },
    {
      name: 'cancelled is final',
      voucher: { status: 'cancelled', activationExpiresAt: null, expiresAt: at(-10) },
      effective: 'cancelled',
      sweep: 'none',
      live: false,
    },
    {
      name: 'expired is final',
      voucher: { status: 'expired', activationExpiresAt: null, expiresAt: at(-10) },
      effective: 'expired',
      sweep: 'none',
      live: false,
    },
  ];

  it.each(cases)('$name', ({ voucher, effective, sweep, live }) => {
    expect(effectiveVoucherStatus(voucher, NOW)).toBe(effective);
    expect(planSweepAction(voucher, NOW)).toBe(sweep);
    expect(isActivationLive(voucher, NOW)).toBe(live);
  });
});
