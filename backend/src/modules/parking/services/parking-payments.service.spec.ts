import { FEATURE_FLAG_KEYS } from '../../../common/contracts/admin';
import { PARKING_EVENTS } from '../../../common/contracts/events';
import type { SessionRecord } from '../domain/session-view';
import { EMULATOR_DEMO_REF } from '../provider/emulator.provider';
import { snapshot } from '../testing/fake-parking-provider';
import { OTHER_USER_ID, ParkingHarness, USER_ID } from '../testing/parking-harness';

const at = ParkingHarness.at;

async function payableAt1520(): Promise<{ h: ParkingHarness; sessionId: string }> {
  const h = new ParkingHarness({ provider: 'emulator', scenario: 'payable' });
  await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
  await h.addVehicle(USER_ID, 'AC1234BC');
  h.setTime('15:20');
  const hero = await h.sessions.getHero(USER_ID);
  return { h, sessionId: hero.session!.id };
}

/** Operator session of the fake provider entered at 14:00, stored at `time`. */
async function fakeSession(time = '15:20'): Promise<{ h: ParkingHarness; sessionId: string }> {
  const h = new ParkingHarness();
  await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
  await h.addVehicle(USER_ID, 'AC1234BC');
  h.setTime(time);
  h.fakeProvider.set(snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }));
  const hero = await h.sessions.getHero(USER_ID);
  return { h, sessionId: hero.session!.id };
}

async function sessionRow(h: ParkingHarness, sessionId: string): Promise<SessionRecord> {
  return (await h.prisma.parkingSession.findUnique({
    where: { id: sessionId },
  })) as unknown as SessionRecord;
}

function link(h: ParkingHarness, paymentId: string): Record<string, unknown> | undefined {
  return h.prisma.parkingPaymentLink.rows.find((row) => row['paymentId'] === paymentId);
}

describe('ParkingPaymentsService.pay', () => {
  it('creates a 60 UAH payment buying the exit until 16:00 and links it after the payment is committed', async () => {
    const { h, sessionId } = await payableAt1520();
    const result = await h.payments.pay(USER_ID, sessionId);
    expect(result).toMatchObject({ sessionId, amountKopecks: 6000, includesNextHour: false });
    expect(result.paidUntil.toISOString()).toBe(at('16:00').toISOString());
    expect(result.payment.checkoutUrl).toContain('https://pay.example.test/checkout/');
    expect(result.breakdown.map((line) => line.kind)).toEqual(['free', 'first_hour', 'hour']);

    const call = h.paymentsPort.createCalls[0]!;
    expect(call).toMatchObject({
      userId: USER_ID,
      purpose: 'parking',
      amountKopecks: 6000,
      idempotencyKey: `parking:${sessionId}:${at('16:00').toISOString()}`,
      meta: {
        sessionId,
        paidUntil: at('16:00').toISOString(),
        plate: 'AC1234BC',
        plateDisplay: 'AC 1234 BC',
        providerRef: EMULATOR_DEMO_REF,
        includesNextHour: false,
      },
    });
    expect(call.description).toBe('Паркінг Порт City, AC 1234 BC, виїзд до 16:00, 60 ₴');
    // Finding 3: the payments port is never handed our transaction.
    expect(h.paymentsPort.lastCallArgs).toBe(1);
    expect(h.prisma.parkingPaymentLink.rows).toEqual([
      expect.objectContaining({
        sessionId,
        paymentId: result.payment.id,
        paidUntil: at('16:00'),
        outcome: null,
        registeredAt: null,
      }),
    ]);
  });

  it('returns the same payment for the same paid hour while it is open (a retried tap)', async () => {
    const { h, sessionId } = await payableAt1520();
    const first = await h.payments.pay(USER_ID, sessionId);
    h.setTime('15:40');
    const second = await h.payments.pay(USER_ID, sessionId);
    expect(second.payment.id).toBe(first.payment.id);
    expect(h.paymentsPort.payments.size).toBe(1);
    expect(h.prisma.parkingPaymentLink.rows).toHaveLength(1);
  });

  it.each(['failed', 'cancelled', 'expired'] as const)(
    'finding 1: after a %s checkout the same hour can be paid again as a new attempt',
    async (status) => {
      const { h, sessionId } = await payableAt1520();
      const first = await h.payments.pay(USER_ID, sessionId);
      h.paymentsPort.setStatus(first.payment.id, status);
      h.setTime('15:25');

      const retry = await h.payments.pay(USER_ID, sessionId);

      expect(retry.payment.id).not.toBe(first.payment.id);
      expect(retry.payment.status).toBe('created');
      expect(retry.payment.meta['_idempotencyKey']).toBe(
        `parking:${sessionId}:${at('16:00').toISOString()}:a2`,
      );
      expect(h.prisma.parkingPaymentLink.rows.map((row) => row['paymentId'])).toEqual([
        first.payment.id,
        retry.payment.id,
      ]);
    },
  );

  it('finding 5: with fewer than 5 minutes left in the hour the next hour is included', async () => {
    const { h, sessionId } = await payableAt1520();
    h.setTime('15:56');
    const result = await h.payments.pay(USER_ID, sessionId);
    expect(result).toMatchObject({ amountKopecks: 10_000, includesNextHour: true });
    expect(result.paidUntil.toISOString()).toBe(at('17:00').toISOString());
    expect(result.breakdown.at(-1)).toMatchObject({
      from: at('16:00'),
      to: at('17:00'),
      kind: 'hour',
      amountKopecks: 4000,
    });
    expect(h.paymentsPort.createCalls[0]).toMatchObject({
      idempotencyKey: `parking:${sessionId}:${at('17:00').toISOString()}`,
      meta: { includesNextHour: true },
    });
    expect(h.paymentsPort.createCalls[0]?.description).toBe(
      'Паркінг Порт City, AC 1234 BC, виїзд до 17:00, 100 ₴',
    );

    // Five or more minutes left: only the running hour.
    const { h: h2, sessionId: other } = await payableAt1520();
    h2.setTime('15:55');
    await expect(h2.payments.pay(USER_ID, other)).resolves.toMatchObject({
      amountKopecks: 6000,
      includesNextHour: false,
    });
  });

  it('finding 5: PARKING_PAY_MIN_MINUTES_LEFT = 0 switches the rule off', async () => {
    const h = new ParkingHarness({
      provider: 'emulator',
      scenario: 'payable',
      config: { PARKING_PAY_MIN_MINUTES_LEFT: 0 },
    });
    await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:58');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.session?.payNow).toMatchObject({ amountKopecks: 6000, includesNextHour: false });
    await expect(h.payments.pay(USER_ID, hero.session!.id)).resolves.toMatchObject({
      amountKopecks: 6000,
      includesNextHour: false,
    });
  });

  it('refuses when nothing is due, the session is closed or belongs to someone else', async () => {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('14:10');
    const free = await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }),
    );
    h.fakeProvider.set(snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }));
    await expect(h.payments.pay(USER_ID, free.record!.id)).rejects.toMatchObject({
      code: 'PC_PARKING_NOTHING_DUE',
      status: 409,
    });
    await expect(h.payments.pay(OTHER_USER_ID, free.record!.id)).rejects.toMatchObject({
      code: 'PC_PARKING_SESSION_NOT_FOUND',
      status: 404,
    });
    await h.sessions.markLeft(USER_ID, free.record!.id);
    await expect(h.payments.pay(USER_ID, free.record!.id)).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
    });
  });

  it('refuses info-mode timers (paid at the paymat) and disputed sessions', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('14:00') });
    await expect(h.payments.pay(USER_ID, timer.id)).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
    });

    const { h: h2, sessionId } = await fakeSession();
    await h2.sessions.dispute(USER_ID, sessionId, { reason: 'not_my_car' });
    await expect(h2.payments.pay(USER_ID, sessionId)).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
      details: { reason: 'disputed' },
    });
  });

  it('refuses when the vehicle lost its verification', async () => {
    const { h, sessionId } = await payableAt1520();
    await h.prisma.vehicle.updateMany({ where: { userId: USER_ID }, data: { verified: false } });
    await expect(h.payments.pay(USER_ID, sessionId)).rejects.toMatchObject({
      code: 'PC_PARKING_VEHICLE_NOT_VERIFIED',
      status: 403,
    });
  });

  it('refuses with 503 when the operator cannot confirm the amount', async () => {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:00');
    const created = await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }),
    );
    h.fakeProvider.failWith = new Error('operator down');
    await expect(h.payments.pay(USER_ID, created.record!.id)).rejects.toMatchObject({
      code: 'PC_PARKING_PROVIDER_UNAVAILABLE',
      status: 503,
    });
    expect(h.paymentsPort.createCalls).toHaveLength(0);
  });
});

describe('ParkingPaymentsService.applyPaymentSucceeded', () => {
  it('marks the session paid until 16:00, tells the operator and publishes parking.session.paid once', async () => {
    const { h, sessionId } = await payableAt1520();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    h.setTime('15:21');
    const payload = h.paymentsPort.succeed(payment.id);

    const outcome = await h.payments.applyPaymentSucceeded(payload);
    expect(outcome).toMatchObject({ action: 'applied', sessionId, status: 'paid' });
    const row = await sessionRow(h, sessionId);
    expect(row).toMatchObject({ status: 'paid', amountPaidKopecks: 6000, amountDueKopecks: 0 });
    expect(row.paidUntil?.toISOString()).toBe(at('16:00').toISOString());
    expect(h.emulator.registeredPayments(EMULATOR_DEMO_REF)).toEqual({
      paidUntil: at('16:00'),
      amountKopecks: 6000,
    });
    expect(link(h, payment.id)).toMatchObject({
      outcome: 'applied',
      registeredAt: at('15:21'),
    });
    expect(h.eventPayloads(PARKING_EVENTS.sessionPaid)).toEqual([
      expect.objectContaining({
        paymentId: payment.id,
        amountPaidKopecks: 6000,
        paidUntil: at('16:00').toISOString(),
      }),
    ]);

    // Redelivery of the same event changes nothing.
    const again = await h.payments.applyPaymentSucceeded(payload);
    expect(again).toMatchObject({ action: 'duplicate', status: 'paid' });
    expect(h.eventPayloads(PARKING_EVENTS.sessionPaid)).toHaveLength(1);
    expect(h.emulator.registeredPayments(EMULATOR_DEMO_REF)?.amountKopecks).toBe(6000);

    // The hero now shows F4 with the payment listed, and the next sync keeps the paid period.
    h.setTime('15:30');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F4');
    expect(hero.session).toMatchObject({
      amountPaidKopecks: 6000,
      payNow: null,
      payments: [
        {
          id: payment.id,
          amountKopecks: 6000,
          status: 'succeeded',
          paidUntil: at('16:00'),
          paidAt: at('15:21'),
        },
      ],
    });
  });

  it('an overstay payment extends the paid period by one hour', async () => {
    const { h, sessionId } = await payableAt1520();
    const first = await h.payments.pay(USER_ID, sessionId);
    await h.payments.applyPaymentSucceeded(h.paymentsPort.succeed(first.payment.id));

    h.setTime('16:05');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F5');
    const second = await h.payments.pay(USER_ID, sessionId);
    expect(second).toMatchObject({ amountKopecks: 4000 });
    expect(second.paidUntil.toISOString()).toBe(at('17:00').toISOString());
    await h.payments.applyPaymentSucceeded(h.paymentsPort.succeed(second.payment.id));
    const row = await sessionRow(h, sessionId);
    expect(row).toMatchObject({ status: 'paid', amountPaidKopecks: 10_000 });
    expect(row.paidUntil?.toISOString()).toBe(at('17:00').toISOString());
  });

  it('marks the session paid even when the operator rejects the registration, then rethrows for a retry', async () => {
    const { h, sessionId } = await fakeSession();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    const payload = h.paymentsPort.succeed(payment.id);

    h.fakeProvider.failWith = new Error('barrier API down');
    await expect(h.payments.applyPaymentSucceeded(payload)).rejects.toThrow('barrier API down');
    const row = await sessionRow(h, sessionId);
    expect(row).toMatchObject({ status: 'paid', amountPaidKopecks: 6000 });
    expect(link(h, payment.id)).toMatchObject({ outcome: 'applied', registeredAt: null });

    h.fakeProvider.failWith = null;
    await expect(h.payments.applyPaymentSucceeded(payload)).resolves.toMatchObject({
      action: 'duplicate',
    });
    expect(h.fakeProvider.registeredPayments).toHaveLength(1);
    expect(link(h, payment.id)?.['registeredAt']).toBeInstanceOf(Date);
    expect(h.eventPayloads(PARKING_EVENTS.sessionPaid)).toHaveLength(1);
  });

  it('ignores other purposes and payments without a session id', async () => {
    const { h, sessionId } = await payableAt1520();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    const payload = h.paymentsPort.succeed(payment.id);

    await expect(
      h.payments.applyPaymentSucceeded({ ...payload, purpose: 'other' }),
    ).resolves.toMatchObject({ action: 'ignored', reason: 'not_a_parking_payment' });
    await expect(h.payments.applyPaymentSucceeded({ ...payload, meta: {} })).resolves.toMatchObject(
      { action: 'ignored', reason: 'no_session_in_meta' },
    );
  });

  it('finding 2: a late success for a session closed meanwhile is refunded and raises an ops alert', async () => {
    const { h, sessionId } = await fakeSession();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    h.paymentsPort.setStatus(payment.id, 'expired');
    // The member paid at the paymat and left: the operator closes the session as paid.
    h.setTime('15:40');
    h.fakeProvider.set(
      snapshot({
        providerRef: 'op-1',
        enteredAt: at('14:00'),
        paidUntil: at('16:00'),
        amountPaidKopecks: 6000,
        exitedAt: at('15:35'),
      }),
    );
    await h.sync.reconcileMissing([]);
    expect((await sessionRow(h, sessionId)).status).toBe('closed');

    const payload = h.paymentsPort.succeed(payment.id);
    expect(payload.late).toBe(true);
    const outcome = await h.payments.applyPaymentSucceeded(payload);

    expect(outcome).toEqual({
      action: 'refund_queued',
      reason: 'session_closed',
      sessionId,
      refund: 'queued',
    });
    expect(h.paymentsPort.refundRequests).toEqual([
      { paymentId: payment.id, reason: 'session_closed', source: 'parking' },
    ]);
    expect(h.eventPayloads(PARKING_EVENTS.paymentOpsAlert)).toEqual([
      expect.objectContaining({
        alert: 'refund_queued',
        reason: 'session_closed',
        paymentId: payment.id,
        sessionId,
        userId: USER_ID,
        amountKopecks: 6000,
        late: true,
        refund: 'queued',
      }),
    ]);
    expect(h.prisma.auditLog.rows).toEqual([
      expect.objectContaining({ action: 'parking_payment.ops_alert', entityId: payment.id }),
    ]);
    expect(link(h, payment.id)).toMatchObject({ outcome: 'refund_queued' });
    expect(link(h, payment.id)?.['outcomeAt']).toBeInstanceOf(Date);
    expect(h.fakeProvider.registeredPayments).toHaveLength(0);

    // Redelivery: the refund request is repeated (idempotent), no second alert.
    await expect(h.payments.applyPaymentSucceeded(payload)).resolves.toMatchObject({
      action: 'refund_queued',
      refund: 'already_queued',
    });
    expect(h.eventPayloads(PARKING_EVENTS.paymentOpsAlert)).toHaveLength(1);
  });

  it('finding 2: a late success the open session can still use is applied normally', async () => {
    const { h, sessionId } = await payableAt1520();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    h.paymentsPort.setStatus(payment.id, 'expired');
    h.setTime('15:45');
    const outcome = await h.payments.applyPaymentSucceeded(h.paymentsPort.succeed(payment.id));
    expect(outcome).toMatchObject({ action: 'applied', status: 'paid' });
    expect(h.paymentsPort.refundRequests).toHaveLength(0);
    expect(h.eventPayloads(PARKING_EVENTS.paymentOpsAlert)).toHaveLength(0);
  });

  it('finding 2: a second attempt paying the same hour is refunded (already paid)', async () => {
    const { h, sessionId } = await payableAt1520();
    const first = await h.payments.pay(USER_ID, sessionId);
    h.paymentsPort.setStatus(first.payment.id, 'expired');
    const second = await h.payments.pay(USER_ID, sessionId);
    await h.payments.applyPaymentSucceeded(h.paymentsPort.succeed(second.payment.id));
    // The expired first attempt is captured late by the provider.
    const outcome = await h.payments.applyPaymentSucceeded(
      h.paymentsPort.succeed(first.payment.id),
    );
    expect(outcome).toMatchObject({ action: 'refund_queued', reason: 'already_paid' });
    const row = await sessionRow(h, sessionId);
    // The refunded duplicate never counts as paid.
    expect(row).toMatchObject({ status: 'paid', amountPaidKopecks: 6000 });
  });

  it('keeps a payment for a closed_unpaid session (it settles the disputed amount) and reports it', async () => {
    const { h, sessionId } = await payableAt1520();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    await h.sessions.markLeft(USER_ID, sessionId);
    expect((await sessionRow(h, sessionId)).status).toBe('closed_unpaid');
    const outcome = await h.payments.applyPaymentSucceeded(h.paymentsPort.succeed(payment.id));
    expect(outcome).toEqual({
      action: 'alerted',
      reason: 'session_closed_unpaid',
      sessionId,
    });
    expect(h.paymentsPort.refundRequests).toHaveLength(0);
    expect(h.eventPayloads(PARKING_EVENTS.paymentOpsAlert)).toEqual([
      expect.objectContaining({ alert: 'manual_review', refund: null }),
    ]);
  });

  it('refunds a payment whose session no longer exists', async () => {
    const { h, sessionId } = await payableAt1520();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    const payload = h.paymentsPort.succeed(payment.id);
    const missing = '0192f3a0-0000-7000-8000-00000000dead';
    await expect(
      h.payments.applyPaymentSucceeded({
        ...payload,
        meta: { ...payload.meta, sessionId: missing },
      }),
    ).resolves.toMatchObject({ action: 'refund_queued', reason: 'session_not_found' });
    expect(h.eventPayloads(PARKING_EVENTS.paymentOpsAlert)).toEqual([
      expect.objectContaining({ sessionId: null, reason: 'session_not_found' }),
    ]);
  });
});

describe('ParkingPaymentsService.sweep (finding 4)', () => {
  it('re-registers a paid payment the operator has not accepted yet', async () => {
    const { h, sessionId } = await fakeSession();
    const { payment } = await h.payments.pay(USER_ID, sessionId);
    const payload = h.paymentsPort.succeed(payment.id);
    h.fakeProvider.failWith = new Error('barrier API down');
    await expect(h.payments.applyPaymentSucceeded(payload)).rejects.toThrow();
    h.fakeProvider.failWith = null;

    h.setTime('15:21');
    // Within the grace period the outbox consumer still owns it.
    await expect(h.payments.sweep()).resolves.toMatchObject({ checked: 0 });
    h.setTime('15:30');
    const summary = await h.payments.sweep();
    expect(summary).toMatchObject({ checked: 1, applied: 1, failed: 0 });
    expect(h.fakeProvider.registeredPayments).toEqual([
      expect.objectContaining({ paymentId: payment.id, paidUntil: at('16:00') }),
    ]);
    expect(link(h, payment.id)?.['registeredAt']).toBeInstanceOf(Date);
    await expect(h.payments.sweep()).resolves.toMatchObject({ checked: 0 });
  });

  it('applies a paid payment whose payment.succeeded never arrived and skips unpaid ones', async () => {
    const { h, sessionId } = await payableAt1520();
    const paid = await h.payments.pay(USER_ID, sessionId);
    h.paymentsPort.succeed(paid.payment.id);
    h.setTime('15:30');
    const summary = await h.payments.sweep();
    expect(summary).toMatchObject({ checked: 1, applied: 1 });
    expect(await sessionRow(h, sessionId)).toMatchObject({ status: 'paid' });

    const { h: h2, sessionId: other } = await payableAt1520();
    await h2.payments.pay(USER_ID, other);
    h2.setTime('15:30');
    await expect(h2.payments.sweep()).resolves.toMatchObject({ checked: 1, skipped: 1 });
  });

  it('purges operator webhook ids older than 30 days', async () => {
    const h = new ParkingHarness();
    h.prisma.parkingWebhookLog.seed(
      {
        id: 'a',
        provider: 'fake',
        eventId: 'old',
        type: 't',
        receivedAt: at('10:00', '2025-12-01'),
      },
      { id: 'b', provider: 'fake', eventId: 'new', type: 't', receivedAt: at('10:00') },
    );
    await expect(h.payments.sweep()).resolves.toMatchObject({ webhookLogsPurged: 1 });
    expect(h.prisma.parkingWebhookLog.rows.map((row) => row['eventId'])).toEqual(['new']);
  });
});
