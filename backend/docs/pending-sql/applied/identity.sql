-- APPLIED (archive, do not run): folded into
-- prisma/schema/migrations/20261101180000_review_fixes/migration.sql (sections 1, 2.1, 3.1, 3.2;
-- the DROP CONSTRAINT IF EXISTS guards were dropped there because the migration runs once).

-- Identity: hand-written SQL that Prisma cannot express, for the next migration (security and
-- profile review fixes, 2026-11-01). Append it to the migration generated from
-- prisma/schema/identity.prisma (prisma migrate diff), after the generated DDL:
--   * users: gender (enum "Gender"), city, completed_profile_fields text[] default '{}'
--   * children table (user_id FK cascade, index on user_id)
--   * otp_challenges: index on created_at (global daily SMS budget)
--   * admin_users: failed_login_count, last_failed_login_at, locked_until, login_challenge_id,
--     login_challenge_attempts
-- Every statement is idempotent so it can be re-run safely.

-- ---------------------------------------------------------------------------------------------
-- 1. CHECK constraints
-- ---------------------------------------------------------------------------------------------

-- Children: month 1-12, plausible year. The application also refuses future months and children
-- older than 18 (domain/children.ts); the database only guards the shape.
ALTER TABLE children DROP CONSTRAINT IF EXISTS children_birth_month_check;
ALTER TABLE children
  ADD CONSTRAINT children_birth_month_check CHECK (birth_month BETWEEN 1 AND 12);
ALTER TABLE children DROP CONSTRAINT IF EXISTS children_birth_year_check;
ALTER TABLE children
  ADD CONSTRAINT children_birth_year_check CHECK (birth_year BETWEEN 1900 AND 2200);

-- Announced profile fields: only names from PROFILE_FIELDS (src/common/contracts/identity.ts).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_completed_profile_fields_check;
ALTER TABLE users
  ADD CONSTRAINT users_completed_profile_fields_check CHECK (
    completed_profile_fields <@ ARRAY[
      'firstName', 'lastName', 'birthDate', 'email', 'gender', 'city', 'children'
    ]::text[]
  );

-- Admin login counters never go negative.
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_failed_login_count_check;
ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_failed_login_count_check CHECK (failed_login_count >= 0);
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_login_challenge_attempts_check;
ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_login_challenge_attempts_check CHECK (login_challenge_attempts >= 0);

-- ---------------------------------------------------------------------------------------------
-- 2. Backfill: profile fields filled before this release count as already announced
-- ---------------------------------------------------------------------------------------------
-- Product decision needed (see src/modules/identity/README.md, open questions). Without this
-- statement, the first PATCH /me or POST /me/children after the release announces every field
-- that is already filled (user.profile_field_completed -> club pays the per-field bonuses
-- retroactively). With it, existing members earn bonuses only for fields they fill from now on.
-- Before the public launch (seed/demo data only) either choice is harmless; the statement is
-- written for the "no retroactive bonuses" choice. Children did not exist before this release,
-- so 'children' is never backfilled.
UPDATE users
SET completed_profile_fields = ARRAY(
  SELECT field FROM unnest(ARRAY[
    CASE WHEN first_name IS NOT NULL THEN 'firstName' END,
    CASE WHEN last_name IS NOT NULL THEN 'lastName' END,
    CASE WHEN birth_date IS NOT NULL THEN 'birthDate' END,
    CASE WHEN email IS NOT NULL THEN 'email' END,
    CASE WHEN gender IS NOT NULL THEN 'gender' END,
    CASE WHEN city IS NOT NULL THEN 'city' END
  ]) AS field
  WHERE field IS NOT NULL
)
WHERE status <> 'deleted'
  AND completed_profile_fields = '{}'::text[];

-- ---------------------------------------------------------------------------------------------
-- 3. OTP rate-limit key: IPv6 addresses become their /64 network
-- ---------------------------------------------------------------------------------------------
-- New rows store ipRateLimitKey(ip) (src/common/throttling/ip-key.ts). Rows written before the
-- release keep full IPv6 addresses; they leave the 1-hour IP window by themselves and are purged
-- after OTP_RETENTION_DAYS, so no backfill is needed. IPv4-mapped addresses (::ffff:a.b.c.d)
-- were already stored as Express reported them; normalising them is optional:
UPDATE otp_challenges
SET ip = substring(ip FROM 8)
WHERE ip LIKE '::ffff:%.%.%.%';
