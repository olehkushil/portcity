import { FakeClock } from '../../../common/time/clock';
import { DomainError } from '../../../common/errors/domain-error';
import {
  EMULATOR_DEMO_REF,
  EMULATOR_TALON_REF,
  EMULATOR_TIMELINE,
  EmulatorParkingProvider,
  PARKING_WEBHOOK_SIGNATURE_HEADER,
  normaliseTalon,
  signParkingWebhook,
} from './emulator.provider';

const SECRET = 'test-parking-webhook-secret';

function emulator(
  scenario: 'free' | 'payable' | 'paid' | 'closed',
  iso: string,
  anchor: 'today' | 'now' = 'today',
): { provider: EmulatorParkingProvider; clock: FakeClock } {
  const clock = new FakeClock(iso);
  const provider = new EmulatorParkingProvider(
    { scenario, plate: 'AC1234BC', webhookSecret: SECRET, anchor },
    clock,
  );
  return { provider, clock };
}

describe('EmulatorParkingProvider', () => {
  describe('demo timeline (2026-01-15, Kyiv winter time)', () => {
    it('reports nothing before 14:00 Kyiv', async () => {
      const { provider } = emulator('payable', '2026-01-15T11:59:00.000Z');
      expect(await provider.listActiveSessions()).toEqual([]);
      expect(await provider.findSessionByPlate('AC1234BC')).toBeNull();
      expect(await provider.getSessionByRef(EMULATOR_DEMO_REF)).toBeNull();
    });

    it.each(['free', 'payable'] as const)(
      'scenario %s: the car is inside without a payment at 15:20',
      async (scenario) => {
        const { provider } = emulator(scenario, '2026-01-15T13:20:00.000Z');
        const sessions = await provider.listActiveSessions();
        // The demo plate and the talon-only demo session (plate null).
        expect(sessions).toHaveLength(2);
        expect(sessions[1]).toMatchObject({ providerRef: EMULATOR_TALON_REF, plate: null });
        expect(sessions[0]).toMatchObject({
          providerRef: EMULATOR_DEMO_REF,
          plate: 'AC1234BC',
          zone: 'underground',
          exitedAt: null,
          paidUntil: null,
          amountPaidKopecks: 0,
          level: '-2',
          spot: 'C',
        });
        expect(sessions[0]?.enteredAt.toISOString()).toBe('2026-01-15T12:00:00.000Z');
      },
    );

    it('scenario paid: the payment appears at 15:20 and is valid until 16:00', async () => {
      const before = emulator('paid', '2026-01-15T13:19:00.000Z');
      expect((await before.provider.findSessionByPlate('AC1234BC'))?.paidUntil).toBeNull();

      const after = emulator('paid', '2026-01-15T13:25:00.000Z');
      const snapshot = await after.provider.findSessionByPlate('AC1234BC');
      expect(snapshot?.paidUntil?.toISOString()).toBe('2026-01-15T14:00:00.000Z');
      expect(snapshot?.amountPaidKopecks).toBe(6000);
      expect(snapshot?.exitedAt).toBeNull();
    });

    it('scenario paid: the car is still inside after 16:00 (overstay is derived locally)', async () => {
      const { provider } = emulator('paid', '2026-01-15T14:05:00.000Z');
      const snapshot = await provider.findSessionByPlate('AC1234BC');
      expect(snapshot?.exitedAt).toBeNull();
      expect(snapshot?.paidUntil?.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });

    it.each([
      ['free', 11],
      ['payable', 80],
    ] as const)(
      'anchor now: scenario %s starts at its canonical moment (%i min after the entry)',
      async (scenario, elapsedMinutes) => {
        // 09:00 Kyiv, long before the wall-clock timeline would start.
        const { provider, clock } = emulator(scenario, '2026-01-15T07:00:00.000Z', 'now');
        const snapshot = await provider.findSessionByPlate('AC1234BC');
        expect(snapshot).not.toBeNull();
        expect((clock.nowMs() - (snapshot?.enteredAt.getTime() ?? 0)) / 60_000).toBe(
          elapsedMinutes,
        );
        // The shifted timeline then runs in real time.
        clock.advanceMinutes(30);
        const later = await provider.findSessionByPlate('AC1234BC');
        expect(later?.enteredAt.toISOString()).toBe(snapshot?.enteredAt.toISOString());
      },
    );

    it('anchor now: scenario closed reports the exit 112 minutes after the entry', async () => {
      const { provider } = emulator('closed', '2026-01-15T07:00:00.000Z', 'now');
      const snapshot = await provider.getSessionByRef(EMULATOR_DEMO_REF);
      expect(snapshot?.exitedAt).not.toBeNull();
      const minutes =
        ((snapshot?.exitedAt?.getTime() ?? 0) - (snapshot?.enteredAt.getTime() ?? 0)) / 60_000;
      expect(minutes).toBe(112);
      expect(snapshot?.amountPaidKopecks).toBe(6000);
    });

    it('scenario closed: the exit at 15:52 removes the session from the active list', async () => {
      const { provider } = emulator('closed', '2026-01-15T14:00:00.000Z');
      expect(await provider.listActiveSessions()).toEqual([]);
      expect(await provider.findSessionByPlate('AC1234BC')).toBeNull();
      const snapshot = await provider.getSessionByRef(EMULATOR_DEMO_REF);
      expect(snapshot?.exitedAt?.toISOString()).toBe('2026-01-15T13:52:00.000Z');
      expect(snapshot?.closedReason).toBe('exit');
      expect(snapshot?.paidUntil?.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });

    it('uses the Kyiv day in summer time too', async () => {
      const { provider } = emulator('payable', '2026-07-15T12:00:00.000Z');
      const sessions = await provider.listActiveSessions();
      expect(sessions[0]?.enteredAt.toISOString()).toBe('2026-07-15T11:00:00.000Z');
    });

    it('does not know other plates or refs', async () => {
      const { provider } = emulator('payable', '2026-01-15T13:20:00.000Z');
      expect(await provider.findSessionByPlate('AA0001BB')).toBeNull();
      expect(await provider.getSessionByRef('other')).toBeNull();
    });
  });

  describe('findSessionByTalon (finding 8)', () => {
    it('finds the talon-only demo session by PC-0418227 in any spelling', async () => {
      const { provider, clock } = emulator('payable', '2026-01-15T13:20:00.000Z');
      expect(EMULATOR_TIMELINE.talonCode).toBe('PC-0418227');
      expect(normaliseTalon(' pc 0418227 ')).toBe('PC0418227');
      for (const code of ['PC-0418227', 'pc0418227']) {
        await expect(provider.findSessionByTalon(code)).resolves.toMatchObject({
          providerRef: EMULATOR_TALON_REF,
          plate: null,
          enteredAt: new Date('2026-01-15T12:00:00.000Z'),
        });
      }
      await expect(provider.findSessionByTalon('PC-0000000')).resolves.toBeNull();
      await expect(provider.getSessionByRef(EMULATOR_TALON_REF)).resolves.toMatchObject({
        plate: null,
      });
      clock.set(new Date('2026-01-15T11:00:00.000Z'));
      await expect(provider.findSessionByTalon('PC-0418227')).resolves.toBeNull();
    });

    it('accepts a configured talon and keeps app payments of the talon session', async () => {
      const clock = new FakeClock('2026-01-15T13:20:00.000Z');
      const provider = new EmulatorParkingProvider(
        { scenario: 'payable', plate: 'AC1234BC', webhookSecret: SECRET, talonCode: 'T-777' },
        clock,
      );
      await expect(provider.findSessionByTalon('PC-0418227')).resolves.toBeNull();
      await provider.registerPayment({
        providerRef: EMULATOR_TALON_REF,
        paymentId: 'p-1',
        amountKopecks: 6000,
        paidUntil: new Date('2026-01-15T14:00:00.000Z'),
      });
      await expect(provider.findSessionByTalon('t-777')).resolves.toMatchObject({
        paidUntil: new Date('2026-01-15T14:00:00.000Z'),
        amountPaidKopecks: 6000,
      });
    });

    it('closes the talon session with the demo in scenario closed', async () => {
      const { provider } = emulator('closed', '2026-01-15T14:00:00.000Z');
      await expect(provider.findSessionByTalon('PC-0418227')).resolves.toBeNull();
      await expect(provider.getSessionByRef(EMULATOR_TALON_REF)).resolves.toMatchObject({
        exitedAt: new Date('2026-01-15T13:52:00.000Z'),
      });
    });
  });

  describe('registerPayment', () => {
    it('extends the paid period and sums amounts, idempotent by paymentId', async () => {
      const { provider } = emulator('payable', '2026-01-15T13:20:00.000Z');
      const paidUntil = new Date('2026-01-15T14:12:00.000Z');
      await provider.registerPayment({
        providerRef: EMULATOR_DEMO_REF,
        paymentId: 'pay-1',
        amountKopecks: 6000,
        paidUntil,
      });
      await provider.registerPayment({
        providerRef: EMULATOR_DEMO_REF,
        paymentId: 'pay-1',
        amountKopecks: 6000,
        paidUntil,
      });
      const snapshot = await provider.findSessionByPlate('AC1234BC');
      expect(snapshot?.paidUntil?.toISOString()).toBe(paidUntil.toISOString());
      expect(snapshot?.amountPaidKopecks).toBe(6000);

      const later = new Date('2026-01-15T15:12:00.000Z');
      await provider.registerPayment({
        providerRef: EMULATOR_DEMO_REF,
        paymentId: 'pay-2',
        amountKopecks: 4000,
        paidUntil: later,
      });
      const extended = await provider.findSessionByPlate('AC1234BC');
      expect(extended?.paidUntil?.toISOString()).toBe(later.toISOString());
      expect(extended?.amountPaidKopecks).toBe(10_000);
      expect(provider.registeredPayments(EMULATOR_DEMO_REF)).toEqual({
        paidUntil: later,
        amountKopecks: 10_000,
      });
    });
  });

  describe('verifyVehicle', () => {
    const { provider } = emulator('payable', '2026-01-15T13:20:00.000Z');

    it.each([
      [{ plate: 'AC1234BC', talonCode: '771234' }, 'verified'],
      [{ plate: 'AC1234BC', paymatCode: '1234' }, 'verified'],
      [{ plate: 'AC1234BC', talonCode: '9999' }, 'invalid_code'],
      [{ plate: 'AC1234BC' }, 'invalid_code'],
      [{ plate: 'ABCDEFG', talonCode: '1234' }, 'unknown_plate'],
    ] as const)('%p -> %s', async (input, expected) => {
      expect(await provider.verifyVehicle(input)).toBe(expected);
    });
  });

  describe('parseWebhook', () => {
    const { provider } = emulator('payable', '2026-01-15T13:20:00.000Z');
    const body = {
      eventId: 'evt-1',
      type: 'session.closed',
      session: {
        providerRef: 'op-42',
        plate: 'ас 1234 вс',
        zone: 'surface',
        enteredAt: '2026-01-15T12:12:00.000Z',
        exitedAt: '2026-01-15T13:52:00+02:00',
        paidUntil: null,
        amountPaidKopecks: 2000,
        closedReason: 'exit',
      },
    };

    it('accepts a correctly signed payload and normalises the plate', () => {
      const event = provider.parseWebhook({
        body,
        headers: { [PARKING_WEBHOOK_SIGNATURE_HEADER]: signParkingWebhook(SECRET, body) },
      });
      expect(event.eventId).toBe('evt-1');
      expect(event.type).toBe('session.closed');
      expect(event.snapshot).toMatchObject({
        providerRef: 'op-42',
        plate: 'AC1234BC',
        zone: 'surface',
        amountPaidKopecks: 2000,
        amountDueKopecks: null,
        closedReason: 'exit',
      });
      expect(event.snapshot.exitedAt?.toISOString()).toBe('2026-01-15T11:52:00.000Z');
    });

    it('without a raw body (in-process call) the signature covers the canonical JSON', () => {
      const reordered = { session: { ...body.session }, type: body.type, eventId: body.eventId };
      expect(() =>
        provider.parseWebhook({
          body: reordered,
          headers: { [PARKING_WEBHOOK_SIGNATURE_HEADER]: signParkingWebhook(SECRET, body) },
        }),
      ).not.toThrow();
    });

    it('with a raw body the signature covers the exact bytes received', () => {
      const wire = JSON.stringify(body, null, 2);
      const event = provider.parseWebhook({
        body,
        rawBody: Buffer.from(wire, 'utf8'),
        headers: { [PARKING_WEBHOOK_SIGNATURE_HEADER]: signParkingWebhook(SECRET, wire) },
      });
      expect(event.eventId).toBe('evt-1');

      // The canonical-JSON signature no longer matches once the raw bytes are known.
      expect(() =>
        provider.parseWebhook({
          body,
          rawBody: Buffer.from(wire, 'utf8'),
          headers: { [PARKING_WEBHOOK_SIGNATURE_HEADER]: signParkingWebhook(SECRET, body) },
        }),
      ).toThrow(expect.objectContaining({ code: 'PC_PARKING_WEBHOOK_SIGNATURE' }) as Error);
    });

    it('rejects a missing or wrong signature', () => {
      const attempt = (headers: Record<string, string>): void => {
        try {
          provider.parseWebhook({ body, headers });
          throw new Error('expected a DomainError');
        } catch (error) {
          expect(DomainError.is(error)).toBe(true);
          expect((error as DomainError).code).toBe('PC_PARKING_WEBHOOK_SIGNATURE');
          expect((error as DomainError).status).toBe(401);
        }
      };
      attempt({});
      attempt({ [PARKING_WEBHOOK_SIGNATURE_HEADER]: 'sha256=00' });
      attempt({ [PARKING_WEBHOOK_SIGNATURE_HEADER]: signParkingWebhook('other-secret', body) });
    });

    it('rejects a malformed payload with details', () => {
      const malformed = { eventId: 'evt-2', session: { providerRef: 'x', enteredAt: 'yesterday' } };
      try {
        provider.parseWebhook({
          body: malformed,
          headers: { [PARKING_WEBHOOK_SIGNATURE_HEADER]: signParkingWebhook(SECRET, malformed) },
        });
        throw new Error('expected a DomainError');
      } catch (error) {
        expect((error as DomainError).code).toBe('PC_PARKING_WEBHOOK_MALFORMED');
        expect((error as DomainError).status).toBe(400);
        expect(Array.isArray((error as DomainError).details)).toBe(true);
      }
    });
  });
});
