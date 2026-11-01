-- ============================================================================
-- Review fixes (integration, 2026-11-01).
-- Folds in the five pending SQL files written by the module fix agents (now archived in
-- docs/pending-sql/applied/): identity, club-rewards, receipts-content, parking-payments,
-- promos-notifications-admin.
--
-- Layout:
--   0. Sequence used by a column default of a table created in section 1.
--   1. Generated DDL, verbatim from
--        prisma migrate diff --from-schema-datamodel <schema before the review fixes>
--                            --to-schema-datamodel prisma/schema --script
--      (the "Prisma-generated" parts of receipts-content, parking-payments and
--      promos-notifications-admin are exactly this output and are NOT repeated below).
--   2. Hand-written objects Prisma does not model: CHECK constraints, foreign keys without
--      Prisma relations, an append-only trigger, partial indexes, sequence ownership.
--   3. Data backfills (identity, rewards, parking, admin).
--   4. Receipts and whitelist: canonical fiscal numbers (backfill with collision report).
--   5. Read-only reports to run after the deploy (comments only).
--
-- prisma migrate deploy applies the file as one multi-statement script (PostgreSQL runs it as
-- one implicit transaction), so the file has no BEGIN / COMMIT of its own (the pending
-- receipts-content file had them). No object created here exists in 20261030120000_init or
-- 20261101120000_module_requests (checked by name: types, tables, columns, indexes,
-- constraints, functions, triggers, sequences).
-- ============================================================================


-- ============================================================================
-- 0. Sequences (must exist before section 1: support_requests.number defaults to nextval)
-- ============================================================================

-- (none: support_requests.number is a SERIAL created in section 1 and restarted at 1001 in 2.6)


-- ============================================================================
-- 1. Generated DDL (prisma migrate diff)
-- ============================================================================

-- CreateEnum
CREATE TYPE "SupportRequestTopic" AS ENUM ('receipt', 'parking', 'voucher', 'other');

-- CreateEnum
CREATE TYPE "SupportRequestStatus" AS ENUM ('new', 'in_progress', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('female', 'male', 'other', 'unspecified');

-- CreateEnum
CREATE TYPE "PromoCategory" AS ENUM ('fashion', 'food', 'entertainment', 'kids', 'beauty', 'electronics', 'other');

-- CreateEnum
CREATE TYPE "EventCategory" AS ENUM ('kids', 'masterclass', 'cinema', 'concert', 'other');

-- CreateEnum
CREATE TYPE "EventAdmission" AS ENUM ('registration', 'external');

-- CreateEnum
CREATE TYPE "ReceiptVerification" AS ENUM ('not_required', 'pending', 'confirmed', 'rejected', 'unconfirmed');

-- AlterTable
ALTER TABLE "manual_adjustments" ADD COLUMN     "second_approval_reason" VARCHAR(32);

-- AlterTable
ALTER TABLE "points_transactions" ADD COLUMN     "counterparty" JSONB,
ADD COLUMN     "subtitle" VARCHAR(300),
ADD COLUMN     "title" VARCHAR(200);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "hours" JSONB,
ADD COLUMN     "location_text" VARCHAR(200),
ADD COLUMN     "map_image_url" VARCHAR(500);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "city" VARCHAR(100),
ADD COLUMN     "completed_profile_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "gender" "Gender";

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_failed_login_at" TIMESTAMPTZ(6),
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "login_challenge_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "login_challenge_id" UUID;

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "label" VARCHAR(40);

-- AlterTable
ALTER TABLE "parking_sessions" ADD COLUMN     "dispute_comment" VARCHAR(500),
ADD COLUMN     "dispute_reason" VARCHAR(30),
ADD COLUMN     "disputed_at" TIMESTAMPTZ(6),
ADD COLUMN     "presence_confirmed_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "parking_payment_links" ADD COLUMN     "outcome" VARCHAR(30),
ADD COLUMN     "outcome_at" TIMESTAMPTZ(6),
ADD COLUMN     "paid_until" TIMESTAMPTZ(6),
ADD COLUMN     "registered_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "promos" ADD COLUMN     "category" "PromoCategory" NOT NULL DEFAULT 'other';

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "admission" "EventAdmission" NOT NULL DEFAULT 'registration',
ADD COLUMN     "age_max" INTEGER,
ADD COLUMN     "age_min" INTEGER,
ADD COLUMN     "category" "EventCategory" NOT NULL DEFAULT 'other',
ADD COLUMN     "external_url" VARCHAR(500),
ADD COLUMN     "max_persons_per_registration" INTEGER,
ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "fiscal_id_raw" VARCHAR(128),
ADD COLUMN     "fn_raw" VARCHAR(64),
ADD COLUMN     "verification" "ReceiptVerification" NOT NULL DEFAULT 'not_required',
ADD COLUMN     "verification_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "verify_until" TIMESTAMPTZ(6),
ALTER COLUMN "fn" DROP NOT NULL;

-- AlterTable
ALTER TABLE "vouchers" ADD COLUMN     "image_key" TEXT;

-- AlterTable
ALTER TABLE "validator_devices" ADD COLUMN     "failed_pin_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pin_locked_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "support_requests" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "topic" "SupportRequestTopic" NOT NULL,
    "related_type" VARCHAR(32),
    "related_id" VARCHAR(64),
    "message" TEXT NOT NULL,
    "photo_key" VARCHAR(512),
    "status" "SupportRequestStatus" NOT NULL DEFAULT 'new',
    "admin_note" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_spend_allocations" (
    "spend_tx_id" UUID NOT NULL,
    "expires_on" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_spend_allocations_pkey" PRIMARY KEY ("spend_tx_id","expires_on")
);

-- CreateTable
CREATE TABLE "mall_info" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "address" VARCHAR(300),
    "hours" VARCHAR(32),
    "telegram_url" VARCHAR(500),
    "info_desk_location" VARCHAR(200),
    "info_desk_hours" VARCHAR(32),
    "parking_operator_name" VARCHAR(200),
    "parking_operator_phone" VARCHAR(32),
    "parking_operator_hours" VARCHAR(64),
    "rules_pdf_url" VARCHAR(500),
    "legal_documents" JSONB NOT NULL DEFAULT '[]',
    "floor_map_urls" JSONB NOT NULL DEFAULT '[]',
    "parking_map_url" VARCHAR(500),
    "support_phone" VARCHAR(32),
    "support_email" VARCHAR(200),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mall_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "children" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "birth_month" SMALLINT NOT NULL,
    "birth_year" SMALLINT NOT NULL,
    "gender" "Gender" NOT NULL DEFAULT 'unspecified',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "children_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parking_webhook_logs" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "event_id" VARCHAR(100) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "session_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "result" VARCHAR(200),

    CONSTRAINT "parking_webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_requests_number_key" ON "support_requests"("number");

-- CreateIndex
CREATE INDEX "support_requests_user_id_created_at_idx" ON "support_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_requests_status_created_at_idx" ON "support_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "children_user_id_idx" ON "children"("user_id");

-- CreateIndex
CREATE INDEX "parking_webhook_logs_received_at_idx" ON "parking_webhook_logs"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "parking_webhook_logs_provider_event_id_key" ON "parking_webhook_logs"("provider", "event_id");

-- CreateIndex
CREATE INDEX "manual_adjustments_requested_by_id_created_at_idx" ON "manual_adjustments"("requested_by_id", "created_at");

-- CreateIndex
CREATE INDEX "manual_adjustments_account_id_created_at_idx" ON "manual_adjustments"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_created_at_idx" ON "otp_challenges"("created_at");

-- CreateIndex
CREATE INDEX "parking_payment_links_created_at_idx" ON "parking_payment_links"("created_at");

-- CreateIndex
CREATE INDEX "promos_status_category_idx" ON "promos"("status", "category");

-- CreateIndex
CREATE INDEX "events_status_category_starts_at_idx" ON "events"("status", "category", "starts_at");

-- CreateIndex
CREATE INDEX "events_tenant_id_idx" ON "events"("tenant_id");

-- CreateIndex
CREATE INDEX "receipts_fn_total_kopecks_submitted_at_idx" ON "receipts"("fn", "total_kopecks", "submitted_at");

-- CreateIndex
CREATE INDEX "receipts_verification_verification_checked_at_idx" ON "receipts"("verification", "verification_checked_at");

-- AddForeignKey
ALTER TABLE "points_spend_allocations" ADD CONSTRAINT "points_spend_allocations_spend_tx_id_fkey" FOREIGN KEY ("spend_tx_id") REFERENCES "points_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "children" ADD CONSTRAINT "children_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- 2. Hand-written objects Prisma does not model
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2.1 identity: shape checks. The application also refuses future months and children older
--     than 18 (identity/domain/children.ts); the database only guards the shape.
-- ----------------------------------------------------------------------------
ALTER TABLE "children"
  ADD CONSTRAINT "children_birth_month_check" CHECK ("birth_month" BETWEEN 1 AND 12);
ALTER TABLE "children"
  ADD CONSTRAINT "children_birth_year_check" CHECK ("birth_year" BETWEEN 1900 AND 2200);

-- Announced profile fields: only names from PROFILE_FIELDS (src/common/contracts/identity.ts).
ALTER TABLE "users"
  ADD CONSTRAINT "users_completed_profile_fields_check" CHECK (
    "completed_profile_fields" <@ ARRAY[
      'firstName', 'lastName', 'birthDate', 'email', 'gender', 'city', 'children'
    ]::text[]
  );

-- Admin login counters never go negative.
ALTER TABLE "admin_users"
  ADD CONSTRAINT "admin_users_failed_login_count_check" CHECK ("failed_login_count" >= 0);
ALTER TABLE "admin_users"
  ADD CONSTRAINT "admin_users_login_challenge_attempts_check" CHECK ("login_challenge_attempts" >= 0);

-- ----------------------------------------------------------------------------
-- 2.2 club: points_spend_allocations holds positive portions only and is append-only, like the
--     ledger itself (a debit's allocations never change afterwards).
--     points_transactions_append_only() from the init migration compares the whole row minus
--     `state`, so the new title / subtitle / counterparty columns are immutable after INSERT
--     without any change to that trigger.
-- ----------------------------------------------------------------------------
ALTER TABLE "points_spend_allocations"
  ADD CONSTRAINT "points_spend_allocations_amount_positive_chk" CHECK ("amount" > 0);

CREATE FUNCTION points_spend_allocations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'points_spend_allocations is append-only: % is not allowed (spend_tx_id=%)',
    TG_OP, OLD.spend_tx_id
    USING ERRCODE = 'restrict_violation';
  RETURN NULL;
END;
$$;

CREATE TRIGGER points_spend_allocations_append_only
  BEFORE UPDATE OR DELETE ON "points_spend_allocations"
  FOR EACH ROW EXECUTE FUNCTION points_spend_allocations_append_only();

-- ----------------------------------------------------------------------------
-- 2.3 rewards: the validator PIN failure counter never goes negative.
-- ----------------------------------------------------------------------------
ALTER TABLE "validator_devices"
  ADD CONSTRAINT "validator_devices_failed_pin_attempts_chk" CHECK ("failed_pin_attempts" >= 0);

-- ----------------------------------------------------------------------------
-- 2.4 content / receipts
-- ----------------------------------------------------------------------------
-- mall_info is a singleton: the only row has id = 1 (MALL_INFO_ID in content/domain/mall-info.ts).
ALTER TABLE "mall_info" ADD CONSTRAINT "mall_info_singleton" CHECK ("id" = 1);

-- Only a manual receipt may lack the cash register number (the moderator fills it in on approval).
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_fn_required_for_qr"
  CHECK ("fn" IS NOT NULL OR "source" = 'manual');

-- ----------------------------------------------------------------------------
-- 2.5 parking / payments
-- ----------------------------------------------------------------------------
ALTER TABLE "parking_sessions"
  ADD CONSTRAINT "parking_sessions_dispute_reason_chk"
  CHECK ("dispute_reason" IS NULL OR "dispute_reason" IN ('not_my_car', 'wrong_amount', 'barrier'));

ALTER TABLE "parking_payment_links"
  ADD CONSTRAINT "parking_payment_links_outcome_chk"
  CHECK ("outcome" IS NULL OR "outcome" IN ('applied', 'refund_queued', 'alerted'));

-- The 5-minute payments sweep (ParkingPaymentsService.sweep) only reads unfinished links.
CREATE INDEX "parking_payment_links_sweep_idx" ON "parking_payment_links"("created_at")
  WHERE "outcome" IS NULL
     OR ("outcome" = 'applied' AND "registered_at" IS NULL)
     OR ("outcome" = 'refund_queued' AND "outcome_at" IS NULL);

-- The hourly payments reconciliation re-queues automatic refunds still in state `queued`.
CREATE INDEX "payments_auto_refund_queued_idx" ON "payments"("updated_at")
  WHERE ("meta" #>> '{_internal,autoRefund,state}') = 'queued';

-- ----------------------------------------------------------------------------
-- 2.6 promos / notifications / admin
-- ----------------------------------------------------------------------------
-- promos-notifications-admin B.1: human numbers of support requests start at № 1001.
ALTER SEQUENCE "support_requests_number_seq" RESTART WITH 1001;

-- Foreign keys without Prisma relations (identity.prisma and content.prisma stay untouched).
-- Users are anonymised, never deleted, so RESTRICT is safe; a deleted admin keeps the history.
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_resolved_by_id_fkey"
  FOREIGN KEY ("resolved_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints mirroring the DTO / domain validation.
ALTER TABLE "events" ADD CONSTRAINT "events_age_range_check"
  CHECK (("age_min" IS NULL OR "age_min" BETWEEN 0 AND 99)
     AND ("age_max" IS NULL OR "age_max" BETWEEN 0 AND 99)
     AND ("age_min" IS NULL OR "age_max" IS NULL OR "age_min" <= "age_max"));
ALTER TABLE "events" ADD CONSTRAINT "events_max_persons_check"
  CHECK ("max_persons_per_registration" IS NULL OR "max_persons_per_registration" BETWEEN 1 AND 20);
ALTER TABLE "events" ADD CONSTRAINT "events_external_admission_url_check"
  CHECK ("admission" <> 'external' OR "external_url" IS NOT NULL);
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_message_check"
  CHECK (char_length("message") BETWEEN 1 AND 2000);
ALTER TABLE "manual_adjustments" ADD CONSTRAINT "manual_adjustments_second_approval_reason_check"
  CHECK ("second_approval_reason" IS NULL
      OR "second_approval_reason" IN ('amount', 'requester_daily_total', 'account_24h_total'));

-- Partial indexes.
-- Cumulative four-eyes check (AdjustmentsService.selfApprovedTotals): self-approved rows only,
-- per requester (Kyiv day) and per account (rolling 24 h).
CREATE INDEX "manual_adjustments_self_approved_requester_idx"
  ON "manual_adjustments" ("requested_by_id", "created_at")
  WHERE "second_approval_reason" IS NULL AND "status" IN ('approved', 'applied');
CREATE INDEX "manual_adjustments_self_approved_account_idx"
  ON "manual_adjustments" ("account_id", "created_at")
  WHERE "second_approval_reason" IS NULL AND "status" IN ('approved', 'applied');
-- Back-office queue of open support requests (GET /admin/support-requests?status=new|in_progress).
CREATE INDEX "support_requests_open_idx"
  ON "support_requests" ("created_at" DESC, "id" DESC)
  WHERE "status" IN ('new', 'in_progress');
-- Guest poster: published upcoming events by category (GET /events?category=).
CREATE INDEX "events_published_category_starts_at_idx"
  ON "events" ("category", "starts_at", "id")
  WHERE "status" = 'published';
-- Published promo list by category (GET /promos?category=).
CREATE INDEX "promos_published_category_priority_idx"
  ON "promos" ("category", "priority" DESC, "id" DESC)
  WHERE "status" = 'published';


-- ============================================================================
-- 3. Data backfills
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 3.1 identity: profile fields filled before this release count as already announced, so
--     existing members earn the per-field bonus only for fields they fill from now on (default
--     product decision "no retroactive profile bonuses", docs/INTEGRATION_NOTES.md). Without this
--     statement the first PATCH /me after the release would announce every filled field and club
--     would pay the bonuses retroactively. Children did not exist before this release, so
--     'children' is never backfilled.
-- ----------------------------------------------------------------------------
UPDATE "users"
SET "completed_profile_fields" = ARRAY(
  SELECT field FROM unnest(ARRAY[
    CASE WHEN "first_name" IS NOT NULL THEN 'firstName' END,
    CASE WHEN "last_name" IS NOT NULL THEN 'lastName' END,
    CASE WHEN "birth_date" IS NOT NULL THEN 'birthDate' END,
    CASE WHEN "email" IS NOT NULL THEN 'email' END,
    CASE WHEN "gender" IS NOT NULL THEN 'gender' END,
    CASE WHEN "city" IS NOT NULL THEN 'city' END
  ]::text[]) AS field
  WHERE field IS NOT NULL
)
WHERE "status" <> 'deleted'
  AND "completed_profile_fields" = '{}'::text[];

-- 3.2 identity: OTP rate-limit key. New rows store ipRateLimitKey(ip) (IPv6 -> its /64 network,
--     src/common/throttling/ip-key.ts). Older full IPv6 rows leave the 1-hour window by
--     themselves; IPv4-mapped addresses (::ffff:a.b.c.d) are normalised to plain IPv4.
UPDATE "otp_challenges"
SET "ip" = substring("ip" FROM 8)
WHERE "ip" LIKE '::ffff:%.%.%.%';

-- 3.3 rewards: vouchers bought with points show the reward's picture. New redemption vouchers
--     copy rewards.image_key at issue time; promos/events may pass their own key.
UPDATE "vouchers" AS v
SET "image_key" = r."image_key"
FROM "redemptions" AS rd
JOIN "rewards" AS r ON r."id" = rd."reward_id"
WHERE rd."voucher_id" = v."id"
  AND v."image_key" IS NULL
  AND r."image_key" IS NOT NULL;
-- club: no backfill of points_spend_allocations. The buckets consumed by spends posted before
-- this migration were not recorded; a refund of such an older debit falls back to the previous
-- behaviour (fresh now + pointsTtlMonths), see LedgerService.refundDebit.

-- 3.4 parking: paid period of existing links (the payment meta carries it since the module
--     was built).
UPDATE "parking_payment_links" AS l
SET "paid_until" = (p."meta" ->> 'paidUntil')::timestamptz
FROM "payments" AS p
WHERE p."id" = l."payment_id"
  AND l."paid_until" IS NULL
  AND p."meta" ? 'paidUntil';

-- 3.5 parking: payments already handled by the old consumer were applied and registered with
--     the operator; mark them so the new 5-minute sweep does not replay history.
UPDATE "parking_payment_links" AS l
SET "outcome" = 'applied',
    "outcome_at" = COALESCE(p."paid_at", l."created_at"),
    "registered_at" = COALESCE(p."paid_at", l."created_at")
FROM "payments" AS p
WHERE p."id" = l."payment_id"
  AND l."outcome" IS NULL
  AND p."status" IN ('succeeded', 'fiscalized', 'partially_refunded', 'refunded');
-- payments.idempotency_key stays VARCHAR(255): createPayment accepts base keys of at most 240
-- characters and appends `:a<n>` for retried attempts (existing parking keys are ~70).

-- 3.6 admin: adjustments above the threshold were always decided by a second admin.
UPDATE "manual_adjustments"
   SET "second_approval_reason" = 'amount'
 WHERE "second_approval_reason" IS NULL
   AND abs("amount") > "threshold_points";


-- ============================================================================
-- 4. Canonical fiscal numbers (finding: one receipt credited many times by rewriting its
--    number). Same rules as the application:
--      fn        -> canonicalFiscalNumber() in src/common/contracts/content.ts:
--                   separators removed, digits only, leading zeros stripped, then 6-20 digits;
--      fiscal_id -> canonicalFiscalId() in src/modules/receipts/domain/fiscal-ids.ts:
--                   trimmed, upper case, spaces and dashes removed, numeric ids without leading
--                   zeros ('0000' -> '0'), then 1-64 Latin letters or digits.
--    Separators are whitespace plus U+00AD (soft hyphen), U+2010..U+2015 (hyphens and dashes),
--    U+2212 (minus) and '-', written as a U& literal so the invisible characters stay readable.
--    Values that cannot be canonicalised are left as they are (report in section 5).
-- ============================================================================

CREATE FUNCTION pc_tmp_canonical_fn(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
           WHEN c ~ '^[0-9]{1,64}$' AND ltrim(c, '0') ~ '^[0-9]{6,20}$' THEN ltrim(c, '0')
           ELSE NULL
         END
  FROM (SELECT regexp_replace(raw, U&'[[:space:]\00AD\2010-\2015\2212-]+', '', 'g') AS c) AS s
$$;

CREATE FUNCTION pc_tmp_canonical_fiscal_id(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
           WHEN c !~ '^[A-Z0-9]{1,64}$' THEN NULL
           WHEN c ~ '^[0-9]+$' THEN COALESCE(NULLIF(ltrim(c, '0'), ''), '0')
           ELSE c
         END
  FROM (
    SELECT upper(regexp_replace(btrim(raw), U&'[[:space:]\00AD\2010-\2015\2212-]+', '', 'g')) AS c
  ) AS s
$$;

-- ----------------------------------------------------------------------------
-- 4a. Whitelist of cash registers (tenant_fiscal_numbers.fn is unique). When two rows collapse
--     into one canonical number, the active one (then the oldest) is kept; the others are
--     blocked, renamed to an unreachable tombstone ('#' + 19 hex chars, never a canonical
--     number) and reported. Lookups canonicalise their input, so a tombstoned row is never
--     matched again. Tombstones are written before the kept rows take their canonical value,
--     so the unique index never sees two equal values.
-- ----------------------------------------------------------------------------
CREATE TABLE "fiscal_number_canonical_collisions" (
  "fiscal_number_id"      UUID PRIMARY KEY,
  "kept_fiscal_number_id" UUID NOT NULL,
  "canonical_fn"          VARCHAR(20) NOT NULL,
  "original_fn"           VARCHAR(20) NOT NULL,
  "tenant_id"             UUID,
  "kept_tenant_id"        UUID,
  "status_before"         "FiscalNumberStatus" NOT NULL,
  "detected_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
COMMENT ON TABLE "fiscal_number_canonical_collisions" IS
  'Report of migration 20261101180000_review_fixes: whitelist rows merged into another canonical fn. Not in the Prisma schema; drop after review (docs/RUNBOOK.md).';

CREATE TEMP TABLE pc_tmp_fn_canon AS
SELECT f.id,
       f.fn,
       f.tenant_id,
       f.status,
       pc_tmp_canonical_fn(f.fn) AS cfn,
       row_number() OVER w AS rn,
       first_value(f.id) OVER w AS kept_id,
       first_value(f.tenant_id) OVER w AS kept_tenant_id
FROM "tenant_fiscal_numbers" f
WHERE pc_tmp_canonical_fn(f.fn) IS NOT NULL
WINDOW w AS (
  PARTITION BY pc_tmp_canonical_fn(f.fn)
  ORDER BY (f.status = 'active') DESC, f.created_at, f.id
);

INSERT INTO "fiscal_number_canonical_collisions"
  ("fiscal_number_id", "kept_fiscal_number_id", "canonical_fn", "original_fn", "tenant_id",
   "kept_tenant_id", "status_before")
SELECT id, kept_id, cfn, fn, tenant_id, kept_tenant_id, status
FROM pc_tmp_fn_canon
WHERE rn > 1;

UPDATE "tenant_fiscal_numbers" f
SET "fn" = '#' || substr(md5(f.id::text), 1, 19),
    "status" = 'blocked',
    "note" = left(coalesce(f.note || ' | ', '') || 'duplicate of ' || c.kept_id::text
                  || ' after the canonical fn backfill (was ' || f.fn || ')', 1000),
    "updated_at" = now()
FROM pc_tmp_fn_canon c
WHERE c.id = f.id AND c.rn > 1;

UPDATE "tenant_fiscal_numbers" f
SET "fn" = c.cfn,
    "updated_at" = now()
FROM pc_tmp_fn_canon c
WHERE c.id = f.id AND c.rn = 1 AND f.fn <> c.cfn;

-- ----------------------------------------------------------------------------
-- 4b. Receipts. The submitted values are kept in fn_raw / fiscal_id_raw (the QR text stays in
--     raw_qr). For every canonical (fn, fiscal_id) the oldest receipt (submitted_at,
--     created_at, id) is kept; every later copy is reported in receipt_canonical_collisions and
--     its fiscal_id is replaced by a tombstone ('#' + 32 hex chars of its id, never a canonical
--     receipt number) so the canonical key of the kept receipt is free. Later copies that are
--     still open (uploaded / parsed / auto_approved / needs_moderation / approved / appealed)
--     become `rejected` with rejection_code PC_RECEIPT_DUPLICATE; credited copies keep their
--     status and are reported as `credited_needs_reversal`: their points must be reversed
--     through the club ledger (back-office adjustment or a one-off script calling
--     CLUB_LEDGER_PORT.reverse with idempotency key `receipt-duplicate:<receipt_id>`), never by
--     SQL on points_transactions (append-only, cached balances). See docs/RUNBOOK.md.
-- ----------------------------------------------------------------------------
UPDATE "receipts" SET "fn_raw" = "fn" WHERE "fn_raw" IS NULL AND "fn" IS NOT NULL;
UPDATE "receipts" SET "fiscal_id_raw" = "fiscal_id" WHERE "fiscal_id_raw" IS NULL;

CREATE TABLE "receipt_canonical_collisions" (
  "receipt_id"          UUID PRIMARY KEY,
  "kept_receipt_id"     UUID NOT NULL,
  "user_id"             UUID NOT NULL,
  "kept_user_id"        UUID NOT NULL,
  "canonical_fn"        VARCHAR(20) NOT NULL,
  "canonical_fiscal_id" VARCHAR(64) NOT NULL,
  "original_fn"         VARCHAR(64),
  "original_fiscal_id"  VARCHAR(128) NOT NULL,
  "status_before"       "ReceiptStatus" NOT NULL,
  "points_awarded"      INTEGER,
  "points_tx_id"        UUID,
  -- rejected | already_rejected | credited_needs_reversal
  "action"              VARCHAR(32) NOT NULL,
  "detected_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
COMMENT ON TABLE "receipt_canonical_collisions" IS
  'Report of migration 20261101180000_review_fixes: receipts that became duplicates after fiscal number canonicalisation. Not in the Prisma schema; drop after review (docs/RUNBOOK.md).';

CREATE TEMP TABLE pc_tmp_receipt_canon AS
SELECT r.id,
       r.user_id,
       r.status,
       r.points_awarded,
       r.points_tx_id,
       r.fn,
       r.fiscal_id,
       COALESCE(pc_tmp_canonical_fn(r.fn), r.fn) AS cfn,
       COALESCE(pc_tmp_canonical_fiscal_id(r.fiscal_id), r.fiscal_id) AS cfid,
       row_number() OVER w AS rn,
       first_value(r.id) OVER w AS kept_id,
       first_value(r.user_id) OVER w AS kept_user_id
FROM "receipts" r
WHERE r.fn IS NOT NULL
  AND r.fiscal_id NOT LIKE '#%'
WINDOW w AS (
  PARTITION BY COALESCE(pc_tmp_canonical_fn(r.fn), r.fn),
               COALESCE(pc_tmp_canonical_fiscal_id(r.fiscal_id), r.fiscal_id)
  ORDER BY r.submitted_at, r.created_at, r.id
);

INSERT INTO "receipt_canonical_collisions"
  ("receipt_id", "kept_receipt_id", "user_id", "kept_user_id", "canonical_fn",
   "canonical_fiscal_id", "original_fn", "original_fiscal_id", "status_before", "points_awarded",
   "points_tx_id", "action")
SELECT id, kept_id, user_id, kept_user_id, cfn, cfid, fn, fiscal_id, status, points_awarded,
       points_tx_id,
       CASE
         WHEN status = 'credited' THEN 'credited_needs_reversal'
         WHEN status = 'rejected' THEN 'already_rejected'
         ELSE 'rejected'
       END
FROM pc_tmp_receipt_canon
WHERE rn > 1;

-- History rows for the copies that change status (status captured before the update).
INSERT INTO "receipt_events" ("id", "receipt_id", "from_status", "to_status", "actor_type",
                              "actor_id", "note", "created_at")
SELECT gen_random_uuid(), c.id, c.status, 'rejected'::"ReceiptStatus", 'system'::"ActorType", NULL,
       'PC_RECEIPT_DUPLICATE: canonical fiscal id backfill, same receipt as ' || c.kept_id::text,
       now()
FROM pc_tmp_receipt_canon c
WHERE c.rn > 1 AND c.status NOT IN ('credited', 'rejected');

UPDATE "receipts" r
SET "fiscal_id" = '#' || replace(r.id::text, '-', ''),
    "status" = CASE WHEN c.status IN ('credited', 'rejected') THEN r.status ELSE 'rejected' END,
    "rejection_code" = CASE
      WHEN c.status IN ('credited', 'rejected') THEN r.rejection_code
      ELSE 'PC_RECEIPT_DUPLICATE'
    END,
    "decision_reason" = CASE
      WHEN c.status IN ('credited', 'rejected') THEN r.decision_reason
      ELSE 'Цей чек уже зареєстровано в програмі'
    END,
    "decided_at" = CASE WHEN c.status IN ('credited', 'rejected') THEN r.decided_at ELSE now() END,
    "updated_at" = now()
FROM pc_tmp_receipt_canon c
WHERE c.id = r.id AND c.rn > 1;

-- Kept receipts take the canonical values (unique by construction of the partition).
UPDATE "receipts" r
SET "fn" = c.cfn,
    "fiscal_id" = c.cfid,
    "updated_at" = now()
FROM pc_tmp_receipt_canon c
WHERE c.id = r.id AND c.rn = 1 AND (r.fn <> c.cfn OR r.fiscal_id <> c.cfid);

-- Explicit clean-up (no ON COMMIT DROP: correct whether or not the runner wraps the script in
-- a transaction).
DROP TABLE pc_tmp_receipt_canon;
DROP TABLE pc_tmp_fn_canon;
DROP FUNCTION pc_tmp_canonical_fiscal_id(text);
DROP FUNCTION pc_tmp_canonical_fn(text);


-- ============================================================================
-- 5. Reports to run after the deploy (read-only; docs/RUNBOOK.md)
-- ============================================================================
-- Credited duplicates whose points still have to be reversed through the ledger:
--   SELECT receipt_id, user_id, kept_receipt_id, points_awarded, points_tx_id
--   FROM receipt_canonical_collisions WHERE action = 'credited_needs_reversal' ORDER BY detected_at;
-- Members with several collisions (likely abuse; review in the back office):
--   SELECT user_id, count(*) FROM receipt_canonical_collisions GROUP BY user_id HAVING count(*) > 1;
-- Whitelist rows merged into another number:
--   SELECT * FROM fiscal_number_canonical_collisions ORDER BY detected_at;
-- Receipts whose numbers could not be canonicalised (left unchanged, e.g. dots or Cyrillic):
--   SELECT id, fn, fiscal_id FROM receipts
--   WHERE fiscal_id NOT LIKE '#%' AND fiscal_id !~ '^[A-Z0-9]{1,64}$';
-- Sanity check of the ledger trigger (must fail with restrict_violation):
--   UPDATE points_transactions SET title = 'x' WHERE id = (SELECT id FROM points_transactions LIMIT 1);
