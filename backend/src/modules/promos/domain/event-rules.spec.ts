import {
  type EventRuleInput,
  MAX_PERSONS_PER_REGISTRATION,
  type RegistrationContext,
  type RegistrationDecision,
  canCancelRegistration,
  decideRegistration,
  effectiveMaxPersons,
  eventCancelDeadline,
  eventWindowState,
  isValidAgeRange,
  isValidPersonsLimit,
  maxPersonsFromFlagPayload,
  isRegistrationOpenAt,
  isValidCapacityChange,
  isValidEventWindow,
  registrationCancelDeadline,
  seatsLeft,
  shouldFinishEvent,
  validatePersons,
} from './event-rules';

const now = new Date('2026-10-30T10:00:00.000Z');

function event(overrides: Partial<EventRuleInput> = {}): EventRuleInput {
  return {
    id: 'event-1',
    status: 'published',
    // Saturday 2026-10-31 15:00 Kyiv (UTC+2 after the DST switch on 2026-10-25)
    startsAt: new Date('2026-10-31T13:00:00.000Z'),
    endsAt: new Date('2026-10-31T14:30:00.000Z'),
    capacity: 30,
    registeredCount: 0,
    registrationOpen: true,
    ...overrides,
  };
}

function context(overrides: Partial<RegistrationContext> = {}): RegistrationContext {
  return { now, registrationEnabled: true, ...overrides };
}

describe('validatePersons', () => {
  const table: Array<[number, number, boolean, string | undefined]> = [
    [1, 0, true, undefined],
    [2, 1, true, undefined],
    [1, 3, true, undefined],
    [4, 0, true, undefined],
    [0, 1, false, 'At least one adult (the member) must attend'],
    [0, 0, false, 'At least one adult (the member) must attend'],
    [1, -1, false, 'children cannot be negative'],
    [3, 2, false, `At most ${MAX_PERSONS_PER_REGISTRATION} persons per registration`],
    [5, 0, false, `At most ${MAX_PERSONS_PER_REGISTRATION} persons per registration`],
    [1.5, 0, false, 'adults and children must be integers'],
  ];

  it.each(table)('adults %d children %d -> ok %s', (adults, children, ok, detail) => {
    const result = validatePersons({ adults, children });
    expect(result.ok).toBe(ok);
    if (result.ok) {
      expect(result.persons).toBe(adults + children);
    } else {
      expect(result.detail).toBe(detail);
    }
  });
});

describe('decideRegistration', () => {
  const table: Array<
    [
      string,
      EventRuleInput | null,
      { adults: number; children: number },
      RegistrationContext,
      RegistrationDecision,
    ]
  > = [
    ['happy path', event(), { adults: 2, children: 1 }, context(), { allowed: true, persons: 3 }],
    [
      'missing event',
      null,
      { adults: 1, children: 0 },
      context(),
      { allowed: false, code: 'PC_EVENT_NOT_FOUND', detail: 'Event does not exist' },
    ],
    [
      'draft event looks missing',
      event({ status: 'draft' }),
      { adults: 1, children: 0 },
      context(),
      { allowed: false, code: 'PC_EVENT_NOT_FOUND', detail: 'Event does not exist' },
    ],
    [
      'feature flag off',
      event(),
      { adults: 1, children: 0 },
      context({ registrationEnabled: false }),
      {
        allowed: false,
        code: 'PC_EVENT_REGISTRATION_CLOSED',
        detail: 'Event registration is temporarily disabled',
      },
    ],
    [
      'cancelled event',
      event({ status: 'cancelled' }),
      { adults: 1, children: 0 },
      context(),
      { allowed: false, code: 'PC_EVENT_REGISTRATION_CLOSED', detail: 'Event is cancelled' },
    ],
    [
      'finished event',
      event({ status: 'finished' }),
      { adults: 1, children: 0 },
      context(),
      { allowed: false, code: 'PC_EVENT_REGISTRATION_CLOSED', detail: 'Event is finished' },
    ],
    [
      'registration flag closed',
      event({ registrationOpen: false }),
      { adults: 1, children: 0 },
      context(),
      {
        allowed: false,
        code: 'PC_EVENT_REGISTRATION_CLOSED',
        detail: 'Registration for this event is closed',
      },
    ],
    [
      'event already started',
      event(),
      { adults: 1, children: 0 },
      context({ now: new Date('2026-10-31T13:00:00.000Z') }),
      {
        allowed: false,
        code: 'PC_EVENT_REGISTRATION_CLOSED',
        detail: 'Registration closes when the event starts',
      },
    ],
    [
      'invalid persons',
      event(),
      { adults: 0, children: 2 },
      context(),
      {
        allowed: false,
        code: 'PC_EVENT_PERSONS_INVALID',
        detail: 'At least one adult (the member) must attend',
      },
    ],
    [
      'too many persons',
      event(),
      { adults: 3, children: 2 },
      context(),
      {
        allowed: false,
        code: 'PC_EVENT_PERSONS_INVALID',
        detail: 'At most 4 persons per registration',
      },
    ],
    [
      'full event',
      event({ capacity: 30, registeredCount: 30 }),
      { adults: 1, children: 0 },
      context(),
      { allowed: false, code: 'PC_EVENT_FULL', detail: 'No seats left' },
    ],
    [
      'not enough seats for the group',
      event({ capacity: 30, registeredCount: 28 }),
      { adults: 2, children: 1 },
      context(),
      { allowed: false, code: 'PC_EVENT_FULL', detail: 'Only 2 seat(s) left' },
    ],
    [
      'exactly the last seats',
      event({ capacity: 30, registeredCount: 27 }),
      { adults: 2, children: 1 },
      context(),
      { allowed: true, persons: 3 },
    ],
    [
      'unlimited capacity',
      event({ capacity: null, registeredCount: 5000 }),
      { adults: 4, children: 0 },
      context(),
      { allowed: true, persons: 4 },
    ],
  ];

  it.each(table)('%s', (_name, eventInput, persons, ctx, expected) => {
    expect(decideRegistration(eventInput, persons, ctx)).toEqual(expected);
  });
});

describe('event helpers', () => {
  it('computes seats left with a floor of zero', () => {
    expect(seatsLeft({ capacity: null, registeredCount: 3 })).toBeNull();
    expect(seatsLeft({ capacity: 30, registeredCount: 12 })).toBe(18);
    expect(seatsLeft({ capacity: 30, registeredCount: 31 })).toBe(0);
  });

  it('classifies the time window', () => {
    const item = event();
    expect(eventWindowState(item, now)).toBe('upcoming');
    expect(eventWindowState(item, item.startsAt)).toBe('ongoing');
    expect(eventWindowState(item, new Date('2026-10-31T14:00:00.000Z'))).toBe('ongoing');
    expect(eventWindowState(item, item.endsAt)).toBe('past');
  });

  it('isRegistrationOpenAt combines status, flag, time and seats', () => {
    expect(isRegistrationOpenAt(event(), now)).toBe(true);
    expect(isRegistrationOpenAt(event({ status: 'draft' }), now)).toBe(false);
    expect(isRegistrationOpenAt(event({ registrationOpen: false }), now)).toBe(false);
    expect(isRegistrationOpenAt(event({ registeredCount: 30 }), now)).toBe(false);
    expect(isRegistrationOpenAt(event(), new Date('2026-10-31T13:30:00.000Z'))).toBe(false);
    expect(isRegistrationOpenAt(event({ capacity: null, registeredCount: 999 }), now)).toBe(true);
  });

  it('validates the time window and capacity changes', () => {
    expect(isValidEventWindow(new Date('2026-01-01T10:00Z'), new Date('2026-01-01T11:00Z'))).toBe(
      true,
    );
    expect(isValidEventWindow(new Date('2026-01-01T11:00Z'), new Date('2026-01-01T10:00Z'))).toBe(
      false,
    );
    expect(isValidEventWindow(new Date('2026-01-01T10:00Z'), new Date('2026-01-01T10:00Z'))).toBe(
      false,
    );
    expect(isValidCapacityChange(null, 50)).toBe(true);
    expect(isValidCapacityChange(30, 30)).toBe(true);
    expect(isValidCapacityChange(29, 30)).toBe(false);
    expect(isValidCapacityChange(0, 0)).toBe(false);
  });

  it('finishes published events once they ended', () => {
    expect(shouldFinishEvent(event(), now)).toBe(false);
    expect(shouldFinishEvent(event(), new Date('2026-10-31T14:30:00.000Z'))).toBe(true);
    expect(shouldFinishEvent(event({ status: 'draft' }), new Date('2026-12-01T00:00Z'))).toBe(
      false,
    );
    expect(shouldFinishEvent(event({ status: 'cancelled' }), new Date('2026-12-01T00:00Z'))).toBe(
      false,
    );
  });
});

describe('registration cancellation deadline', () => {
  it('is 11:00 Kyiv on the event day for an afternoon event (winter time)', () => {
    // 2026-10-31 15:00 Kyiv = 13:00Z; 11:00 Kyiv = 09:00Z
    const deadline = registrationCancelDeadline(new Date('2026-10-31T13:00:00.000Z'));
    expect(deadline).toEqual(new Date('2026-10-31T09:00:00.000Z'));
  });

  it('is 11:00 Kyiv on the event day in summer time', () => {
    // 2026-07-04 15:00 Kyiv = 12:00Z; 11:00 Kyiv = 08:00Z
    const deadline = registrationCancelDeadline(new Date('2026-07-04T12:00:00.000Z'));
    expect(deadline).toEqual(new Date('2026-07-04T08:00:00.000Z'));
  });

  it('falls back to the start time for morning events', () => {
    // 2026-10-31 10:00 Kyiv = 08:00Z, earlier than 11:00 Kyiv
    const startsAt = new Date('2026-10-31T08:00:00.000Z');
    expect(registrationCancelDeadline(startsAt)).toEqual(startsAt);
  });

  it('canCancelRegistration compares strictly against the deadline', () => {
    const startsAt = new Date('2026-10-31T13:00:00.000Z');
    expect(canCancelRegistration(startsAt, new Date('2026-10-31T08:59:59.999Z'))).toBe(true);
    expect(canCancelRegistration(startsAt, new Date('2026-10-31T09:00:00.000Z'))).toBe(false);
    expect(canCancelRegistration(startsAt, new Date('2026-10-30T20:00:00.000Z'))).toBe(true);
  });
});

describe('persons limit per registration', () => {
  it.each<[number | null | undefined, number | null | undefined, number]>([
    [null, null, 4],
    [undefined, undefined, 4],
    [null, 6, 6],
    [3, 6, 3],
    [0, 6, 6],
    [21, null, 4],
  ])('event %s, flag default %s -> %d', (eventLimit, flagDefault, expected) => {
    expect(effectiveMaxPersons({ maxPersonsPerRegistration: eventLimit }, flagDefault)).toBe(
      expected,
    );
  });

  it('reads the flag payload defensively', () => {
    expect(maxPersonsFromFlagPayload({ maxPersonsPerRegistration: 6 })).toBe(6);
    expect(maxPersonsFromFlagPayload({ maxPersonsPerRegistration: '6' })).toBeNull();
    expect(maxPersonsFromFlagPayload({ maxPersonsPerRegistration: 2.5 })).toBeNull();
    expect(maxPersonsFromFlagPayload({})).toBeNull();
    expect(maxPersonsFromFlagPayload(null)).toBeNull();
    expect(isValidPersonsLimit(null)).toBe(true);
    expect(isValidPersonsLimit(0)).toBe(false);
  });

  it('validates persons against the effective limit', () => {
    expect(validatePersons({ adults: 2, children: 4 }, 6)).toEqual({ ok: true, persons: 6 });
    expect(validatePersons({ adults: 2, children: 1 }, 2)).toEqual({
      ok: false,
      detail: 'At most 2 persons per registration',
    });
    expect(
      decideRegistration(
        event({ maxPersonsPerRegistration: null }),
        { adults: 3, children: 3 },
        context({ defaultMaxPersons: 6 }),
      ),
    ).toEqual({ allowed: true, persons: 6 });
  });
});

describe('external admission and audience', () => {
  it('takes no registrations and has no cancel deadline', () => {
    const external = event({ admission: 'external' });
    expect(decideRegistration(external, { adults: 1, children: 0 }, context())).toEqual({
      allowed: false,
      code: 'PC_EVENT_REGISTRATION_CLOSED',
      detail: 'Admission to this event is external; follow externalUrl',
    });
    expect(isRegistrationOpenAt(external, now)).toBe(false);
    expect(eventCancelDeadline(external)).toBeNull();
    expect(eventCancelDeadline(event())).toEqual(registrationCancelDeadline(event().startsAt));
  });

  it.each<[number | null, number | null, boolean]>([
    [null, null, true],
    [5, null, true],
    [null, 12, true],
    [5, 10, true],
    [7, 7, true],
    [10, 5, false],
    [-1, 5, false],
    [5, 100, false],
  ])('age range %s-%s valid = %s', (min, max, valid) => {
    expect(isValidAgeRange(min, max)).toBe(valid);
  });
});
