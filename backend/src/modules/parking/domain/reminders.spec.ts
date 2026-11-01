import { type ReminderFacts, dueReminders, reminderMoment } from './reminders';

const t = (hhmm: string): Date => new Date(`2026-01-15T${hhmm}:00.000+02:00`);

const open: ReminderFacts = {
  status: 'open',
  enteredAt: t('14:00'),
  freeUntil: t('14:30'),
  paidUntil: null,
};
const paid: ReminderFacts = { ...open, status: 'paid', paidUntil: t('16:00') };
const payable: ReminderFacts = { ...open, status: 'payable' };
const overstay: ReminderFacts = { ...open, status: 'overstay', paidUntil: t('16:00') };

describe('reminders', () => {
  it.each([
    ['open', open, 'free_ending', '14:25'],
    ['paid', paid, 'exit_soon', '15:50'],
    ['payable', payable, 'still_inside', '19:00'],
    ['overstay', overstay, 'still_inside', '18:00'],
  ] as const)('%s -> %s at %s', (_case, facts, kind, hhmm) => {
    expect(reminderMoment(facts)).toMatchObject({ kind, at: t(hhmm) });
  });

  it.each([
    ['payable', payable, '19:30', '00:30'],
    ['payable confirmed early', payable, '14:30', '19:30'],
    ['overstay confirmed before paidUntil', overstay, '15:00', '18:00'],
    ['overstay', overstay, '17:30', '19:30'],
  ] as const)(
    'F7 «Так, я тут» moves still_inside (%s, confirmed %s -> %s)',
    (_case, facts, confirmed, hhmm) => {
      const moment = reminderMoment({ ...facts, presenceConfirmedAt: t(confirmed) });
      const expected = hhmm === '00:30' ? new Date('2026-01-16T00:30:00.000+02:00') : t(hhmm);
      expect(moment).toMatchObject({ kind: 'still_inside', at: expected });
    },
  );

  it('closed sessions have no reminder', () => {
    expect(reminderMoment({ ...open, status: 'closed' })).toBeNull();
    expect(reminderMoment({ ...paid, paidUntil: null })).toBeNull();
  });

  it.each([
    // [facts, previous check, now, fires]
    ['before the moment', open, '14:24', '14:24:59', false],
    ['crossing the moment', open, '14:24', '14:25', true],
    ['crossing between ticks', open, '14:24:30', '14:25:30', true],
    ['already evaluated after the moment', open, '14:25', '14:26', false],
    ['first sight inside the window', open, null, '14:27', true],
    ['first sight after the deadline', open, null, '14:30', false],
    ['exit soon crossing', paid, '15:49:30', '15:50:30', true],
    ['exit soon after the deadline', paid, '15:59', '16:01', false],
    ['still inside crossing', payable, '18:59', '19:00', true],
    ['still inside first sight much later', payable, null, '23:00', true],
  ] as const)('%s', (_case, facts, previous, now, fires) => {
    const time = (value: string): Date =>
      new Date(`2026-01-15T${value.length === 5 ? `${value}:00` : value}.000+02:00`);
    const result = dueReminders(facts, previous ? time(previous) : null, time(now));
    expect(result.length > 0).toBe(fires);
  });

  it('honours custom lead times', () => {
    const settings = {
      freeEndingMinutes: 10,
      exitSoonMinutes: 15,
      stillInsidePayableHours: 5,
      stillInsideOverstayHours: 2,
    };
    expect(reminderMoment(open, settings)?.at).toEqual(t('14:20'));
    expect(reminderMoment(paid, settings)?.at).toEqual(t('15:45'));
  });
});
