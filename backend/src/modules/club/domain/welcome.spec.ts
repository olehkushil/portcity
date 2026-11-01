import { DEFAULT_LOYALTY_RULES } from '../../../common/contracts/club';
import {
  EMPTY_WELCOME_STATE,
  type WelcomeKind,
  decideWelcome,
  parseWelcomeState,
  welcomeIdempotencyKey,
  welcomeReason,
} from './welcome';

describe('parseWelcomeState', () => {
  it.each([
    [{}, { register: false, profile: false, firstReceipt: false }],
    [null, { register: false, profile: false, firstReceipt: false }],
    ['x', { register: false, profile: false, firstReceipt: false }],
    [{ register: true }, { register: true, profile: false, firstReceipt: false }],
    [
      { register: 'yes', profile: 1, firstReceipt: true },
      { register: false, profile: false, firstReceipt: true },
    ],
  ])('%p -> %p', (input, expected) => {
    expect(parseWelcomeState(input)).toEqual(expected);
  });
});

describe('decideWelcome', () => {
  const bonuses = DEFAULT_LOYALTY_RULES.welcome;

  it.each([
    ['register', 50],
    ['profile', 30],
    ['firstReceipt', 20],
  ] as Array<[WelcomeKind, number]>)('grants %s once with %d points', (kind, amount) => {
    const first = decideWelcome(EMPTY_WELCOME_STATE, kind, bonuses);
    expect(first).toEqual({ grant: true, amount, state: { ...EMPTY_WELCOME_STATE, [kind]: true } });
    const second = decideWelcome(first.state, kind, bonuses);
    expect(second).toEqual({ grant: false, amount: 0, state: first.state });
  });

  it('marks the flag without granting when the bonus is disabled', () => {
    expect(decideWelcome(EMPTY_WELCOME_STATE, 'profile', { ...bonuses, profile: 0 })).toEqual({
      grant: false,
      amount: 0,
      state: { ...EMPTY_WELCOME_STATE, profile: true },
    });
  });

  it('does not mutate the input state', () => {
    const state = { ...EMPTY_WELCOME_STATE };
    decideWelcome(state, 'register', bonuses);
    expect(state).toEqual(EMPTY_WELCOME_STATE);
  });
});

describe('welcome keys and reasons', () => {
  it('derives a stable idempotency key per kind and user', () => {
    expect(welcomeIdempotencyKey('register', 'u-1')).toBe('welcome:register:u-1');
    expect(welcomeIdempotencyKey('firstReceipt', 'u-1')).toBe('welcome:firstReceipt:u-1');
  });

  it('has a Ukrainian reason for every kind', () => {
    expect(welcomeReason('register')).toContain('реєстрацію');
    expect(welcomeReason('profile')).toContain('профіль');
    expect(welcomeReason('firstReceipt')).toContain('перший чек');
  });
});
