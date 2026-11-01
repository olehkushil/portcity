import type { WelcomeBonuses } from '../../../common/contracts/club';

/** Welcome bonuses (plan 12.2): 50 for registration, 30 for a completed profile, 20 for the first receipt. */
export const WELCOME_KINDS = ['register', 'profile', 'firstReceipt'] as const;
export type WelcomeKind = (typeof WELCOME_KINDS)[number];

/** Shape of LoyaltyAccount.welcomeState (jsonb). */
export type WelcomeState = Record<WelcomeKind, boolean>;

export const EMPTY_WELCOME_STATE: Readonly<WelcomeState> = Object.freeze({
  register: false,
  profile: false,
  firstReceipt: false,
});

export function parseWelcomeState(json: unknown): WelcomeState {
  const source =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  return {
    register: source.register === true,
    profile: source.profile === true,
    firstReceipt: source.firstReceipt === true,
  };
}

/** Ledger idempotency key of a welcome credit: one bonus of each kind per member, ever. */
export function welcomeIdempotencyKey(kind: WelcomeKind, userId: string): string {
  return `welcome:${kind}:${userId}`;
}

const WELCOME_REASONS: Readonly<Record<WelcomeKind, string>> = Object.freeze({
  register: 'Вітальний бонус за реєстрацію',
  profile: 'Бонус за заповнений профіль',
  firstReceipt: 'Бонус за перший чек',
});

export function welcomeReason(kind: WelcomeKind): string {
  return WELCOME_REASONS[kind];
}

export interface WelcomeDecision {
  grant: boolean;
  amount: number;
  /** New welcome state after this decision (the flag is set even for a zero bonus). */
  state: WelcomeState;
}

/** Grants a bonus once per kind; a zero-configured bonus only marks the flag. */
export function decideWelcome(
  state: WelcomeState,
  kind: WelcomeKind,
  bonuses: WelcomeBonuses,
): WelcomeDecision {
  if (state[kind]) {
    return { grant: false, amount: 0, state };
  }
  const amount = Number.isInteger(bonuses[kind]) && bonuses[kind] > 0 ? bonuses[kind] : 0;
  return { grant: amount > 0, amount, state: { ...state, [kind]: true } };
}
