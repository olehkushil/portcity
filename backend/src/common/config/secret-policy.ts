/**
 * Production secret policy (enforced by `validateEnv` when NODE_ENV=production):
 * - every secret, i.e. every variable named `*_SECRET` or `*_PEPPER` (shared ones such as
 *   JWT_SECRET, OTP_PEPPER, VOUCHER_PEPPER, MEMBER_QR_SECRET and module ones such as
 *   PARKING_WEBHOOK_SECRET or PAYMENTS_MOCK_WEBHOOK_SECRET), must be at least 32 characters long;
 * - no secret and no other credential listed in DENY_LIST_ONLY_KEYS may be a known default:
 *   the `dev-only-*`, `compose-only-*` and `test-only-*` placeholders, anything containing
 *   `changeme` / `change-me`, and the literal values shipped in `.env.example`,
 *   `docker-compose.yml` and the seed (`secret-policy.spec.ts` parses both files and proves that
 *   every secret they contain is refused).
 */

export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** Variables whose value is a secret: length and deny-list checks. */
export const SECRET_KEY_PATTERN = /_(SECRET|PEPPER)$/;

/** Credentials that are not ours to size (S3 keys, seed password): deny-list check only. */
export const DENY_LIST_ONLY_KEYS: readonly string[] = Object.freeze([
  'S3_SECRET_ACCESS_KEY',
  'SEED_ADMIN_PASSWORD',
]);

const DENIED_PREFIXES = ['dev-only-', 'compose-only-', 'test-only-', 'unit-test-'] as const;
const DENIED_FRAGMENTS = ['changeme', 'change-me', 'change_me'] as const;

/**
 * Literal defaults that appear in the repository (compose MinIO credentials, the seed admin
 * password, the seed validator key) and a few obvious placeholders. Compared case-insensitively.
 */
export const KNOWN_DEFAULT_SECRETS: readonly string[] = Object.freeze([
  'portcity',
  'portcity-secret',
  'ChangeMe-2026!',
  'dev-validator-aroma-kava',
  'secret',
  'password',
  'minioadmin',
]);

const KNOWN_DEFAULTS_LOWER = new Set(KNOWN_DEFAULT_SECRETS.map((value) => value.toLowerCase()));

/** True when the value is a placeholder or a default published in the repository. */
export function isDeniedSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (DENIED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  if (DENIED_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  return KNOWN_DEFAULTS_LOWER.has(normalized);
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export interface SecretIssue {
  key: string;
  message: string;
}

/**
 * Issues for the given variables (already cleaned: empty strings removed). Secret keys are checked
 * for length and against the deny list, DENY_LIST_ONLY_KEYS only against the deny list. Values
 * are never echoed in the messages.
 */
export function productionSecretIssues(env: Readonly<Record<string, string>>): SecretIssue[] {
  const issues: SecretIssue[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isSecretKey(key)) {
      if (isDeniedSecret(value)) {
        issues.push({
          key,
          message: 'must not be a development placeholder or a default from the repository',
        });
      } else if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
        issues.push({
          key,
          message: `must be a random secret of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
        });
      }
    } else if (DENY_LIST_ONLY_KEYS.includes(key) && isDeniedSecret(value)) {
      issues.push({ key, message: 'must not be a default value from the repository' });
    }
  }
  return issues;
}
