import { markReminderSent, parseExpiryReminderState, wasReminderSent } from './reminders';

describe('parseExpiryReminderState', () => {
  it.each([
    [null, {}],
    [{}, {}],
    ['x', {}],
    [[30, 7], {}],
    [{ '2027-01-15': [7, 30] }, { '2027-01-15': [30, 7] }],
    [{ '2027-01-15': [7, 7, -1, 1.5, 'a'] }, { '2027-01-15': [7] }],
    [{ 'not-a-day': [7], '2027-01-15': [] }, {}],
  ])('%p -> %p', (input, expected) => {
    expect(parseExpiryReminderState(input)).toEqual(expected);
  });
});

describe('wasReminderSent / markReminderSent', () => {
  it('marks a reminder once and keeps days sorted descending', () => {
    let state = markReminderSent({}, '2026-12-01', 7, '2026-11-24');
    state = markReminderSent(state, '2026-12-01', 30, '2026-11-24');
    state = markReminderSent(state, '2026-12-01', 7, '2026-11-24');
    expect(state).toEqual({ '2026-12-01': [30, 7] });
    expect(wasReminderSent(state, '2026-12-01', 7)).toBe(true);
    expect(wasReminderSent(state, '2026-12-01', 1)).toBe(false);
    expect(wasReminderSent(state, '2026-12-02', 7)).toBe(false);
  });

  it('prunes days before today and does not mutate the input', () => {
    const input = { '2026-10-01': [30, 7], '2026-11-24': [30] };
    const next = markReminderSent(input, '2026-12-31', 30, '2026-11-24');
    expect(next).toEqual({ '2026-11-24': [30], '2026-12-31': [30] });
    expect(input).toEqual({ '2026-10-01': [30, 7], '2026-11-24': [30] });
  });
});
