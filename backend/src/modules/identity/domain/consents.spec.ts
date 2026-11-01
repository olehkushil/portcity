import { captureError } from '../testing/errors';
import {
  type ConsentRowLike,
  currentConsents,
  hasActiveConsent,
  planConsentChanges,
} from './consents';

const t1 = new Date('2026-01-01T00:00:00Z');
const t2 = new Date('2026-01-10T00:00:00Z');

const rows: ConsentRowLike[] = [
  { id: 'c1', purpose: 'program', version: '2026-10', grantedAt: t1, revokedAt: null },
  { id: 'c2', purpose: 'marketing', version: '2026-10', grantedAt: t1, revokedAt: null },
  { id: 'c3', purpose: 'marketing', version: '2026-11', grantedAt: t2, revokedAt: t2 },
];

describe('currentConsents / hasActiveConsent', () => {
  it('uses the latest row per purpose and lists missing purposes as not granted', () => {
    expect(currentConsents(rows)).toEqual([
      { purpose: 'program', granted: true, version: '2026-10', grantedAt: t1, revokedAt: null },
      { purpose: 'marketing', granted: false, version: '2026-11', grantedAt: t2, revokedAt: t2 },
      { purpose: 'profiling', granted: false, version: null, grantedAt: null, revokedAt: null },
    ]);
    expect(hasActiveConsent(rows, 'program')).toBe(true);
    expect(hasActiveConsent(rows, 'marketing')).toBe(false);
    expect(hasActiveConsent(rows, 'profiling')).toBe(false);
  });

  it('breaks ties on grantedAt by id (time-ordered UUID v7)', () => {
    const tie: ConsentRowLike[] = [
      { id: 'a', purpose: 'profiling', version: 'v1', grantedAt: t1, revokedAt: null },
      { id: 'b', purpose: 'profiling', version: 'v2', grantedAt: t1, revokedAt: t2 },
    ];
    expect(hasActiveConsent(tie, 'profiling')).toBe(false);
  });
});

describe('planConsentChanges', () => {
  it.each([
    [
      'granting an already active version is a no-op',
      [{ purpose: 'program', granted: true, version: '2026-10' }],
      [],
    ],
    [
      'granting a new version creates a row',
      [{ purpose: 'program', granted: true, version: '2026-11' }],
      [{ kind: 'grant', purpose: 'program', version: '2026-11' }],
    ],
    [
      'granting a revoked purpose creates a row',
      [{ purpose: 'marketing', granted: true, version: '2026-11' }],
      [{ kind: 'grant', purpose: 'marketing', version: '2026-11' }],
    ],
    [
      'revoking a purpose that is not active does nothing',
      [{ purpose: 'marketing', granted: false }],
      [],
    ],
    [
      'revoking an active optional purpose revokes the latest row',
      [{ purpose: 'profiling', granted: false }],
      [],
    ],
    [
      'mixed batch',
      [
        { purpose: 'profiling', granted: true, version: 'v1' },
        { purpose: 'marketing', granted: true, version: '2026-11' },
      ],
      [
        { kind: 'grant', purpose: 'profiling', version: 'v1' },
        { kind: 'grant', purpose: 'marketing', version: '2026-11' },
      ],
    ],
  ] as const)('%s', (_name, changes, expected) => {
    expect(planConsentChanges(rows, [...changes])).toEqual(expected);
  });

  it('revokes the latest active row of an optional purpose', () => {
    const active: ConsentRowLike[] = [
      { id: 'm1', purpose: 'marketing', version: 'v1', grantedAt: t1, revokedAt: null },
    ];
    expect(planConsentChanges(active, [{ purpose: 'marketing', granted: false }])).toEqual([
      { kind: 'revoke', consentId: 'm1' },
    ]);
  });

  it('refuses to revoke the program consent', () => {
    expect(
      captureError(() => planConsentChanges(rows, [{ purpose: 'program', granted: false }])),
    ).toMatchObject({ code: 'PC_CONSENT_PROGRAM_REQUIRED', status: 422 });
  });

  it.each([
    [[{ purpose: 'marketing', granted: true }], /requires the version/],
    [[{ purpose: 'marketing', granted: true, version: 'bad version!' }], /requires the version/],
    [
      [
        { purpose: 'marketing', granted: true, version: 'v1' },
        { purpose: 'marketing', granted: false },
      ],
      /more than once/,
    ],
  ] as const)('rejects malformed batches', (changes, message) => {
    expect(() => planConsentChanges(rows, [...changes])).toThrow(message);
  });
});
