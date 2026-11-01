-- ============================================================================
-- Module requests (integration, 2026-11-01): docs/schema-requests/*.md
-- Generated with
--   prisma migrate diff --from-schema-datamodel <schema before> --to-schema-datamodel prisma/schema --script
-- and hand-extended where Prisma cannot express the change (backfills, partial indexes,
-- an exclusion constraint). Sections follow the request ids.
-- ============================================================================

-- CreateEnum (promos-1)
CREATE TYPE "CouponClaimStatus" AS ENUM ('active', 'cancelled');

-- ----------------------------------------------------------------------------
-- admin-1: manual_adjustments.user_id (owner of the adjusted account)
-- Added nullable, backfilled from loyalty_accounts, then made NOT NULL.
-- ----------------------------------------------------------------------------
ALTER TABLE "manual_adjustments" ADD COLUMN "user_id" UUID;

UPDATE "manual_adjustments" m
SET "user_id" = a."user_id"
FROM "loyalty_accounts" a
WHERE a."id" = m."account_id";

ALTER TABLE "manual_adjustments" ALTER COLUMN "user_id" SET NOT NULL;

-- ----------------------------------------------------------------------------
-- club-1: loyalty_accounts.expiry_reminders (markers of published points.expiring)
-- Markers move out of welcome_state.expiryReminders.
-- ----------------------------------------------------------------------------
ALTER TABLE "loyalty_accounts" ADD COLUMN "expiry_reminders" JSONB NOT NULL DEFAULT '{}';

UPDATE "loyalty_accounts"
SET "expiry_reminders" = "welcome_state" -> 'expiryReminders',
    "welcome_state" = "welcome_state" - 'expiryReminders'
WHERE jsonb_typeof("welcome_state") = 'object'
  AND jsonb_typeof("welcome_state" -> 'expiryReminders') = 'object';

-- ----------------------------------------------------------------------------
-- identity-1: admin_users.totp_last_step (TOTP replay protection)
-- ----------------------------------------------------------------------------
ALTER TABLE "admin_users" ADD COLUMN "totp_last_step" INTEGER;

-- ----------------------------------------------------------------------------
-- notifications-1: notifications.dedupe_key + unique (user_id, dedupe_key)
-- Backfilled from data._dedupeKey; if older rows were duplicated, only the earliest row of each
-- (user, key) keeps the key, so the unique index can be created.
-- ----------------------------------------------------------------------------
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" VARCHAR(200);

UPDATE "notifications" n
SET "dedupe_key" = LEFT(n."data" ->> '_dedupeKey', 200)
FROM (
  SELECT DISTINCT ON ("user_id", "data" ->> '_dedupeKey') "id"
  FROM "notifications"
  WHERE jsonb_typeof("data") = 'object' AND "data" ? '_dedupeKey'
  ORDER BY "user_id", "data" ->> '_dedupeKey', "created_at", "id"
) first_rows
WHERE n."id" = first_rows."id";

UPDATE "notifications"
SET "data" = "data" - '_dedupeKey'
WHERE jsonb_typeof("data") = 'object' AND "data" ? '_dedupeKey';

-- ----------------------------------------------------------------------------
-- parking-1: parking_sessions.level / spot (where the car is, from the operator)
-- ----------------------------------------------------------------------------
ALTER TABLE "parking_sessions" ADD COLUMN "level" VARCHAR(20),
ADD COLUMN "spot" VARCHAR(20);

-- ----------------------------------------------------------------------------
-- receipts-1: receipts.moderation_reasons / rejection_code
-- Backfilled from the receipt event notes the module wrote before the columns existed
-- ("moderation: a, b" and "PC_RECEIPT_TOO_OLD: ...").
-- ----------------------------------------------------------------------------
ALTER TABLE "receipts" ADD COLUMN "moderation_reasons" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "rejection_code" VARCHAR(64);

UPDATE "receipts" r
SET "moderation_reasons" = to_jsonb(
  regexp_split_to_array(trim(substring(e."note" FROM 13)), '\s*,\s*')
)
FROM (
  SELECT DISTINCT ON ("receipt_id") "receipt_id", "note"
  FROM "receipt_events"
  WHERE "note" LIKE 'moderation: %'
  ORDER BY "receipt_id", "created_at" DESC, "id" DESC
) e
WHERE e."receipt_id" = r."id";

UPDATE "receipts" r
SET "rejection_code" = substring(e."note" FROM '^(PC_RECEIPT_[A-Z_]+):')
FROM (
  SELECT DISTINCT ON ("receipt_id") "receipt_id", "note"
  FROM "receipt_events"
  WHERE "note" ~ '^PC_RECEIPT_[A-Z_]+:' AND "to_status" = 'rejected'
  ORDER BY "receipt_id", "created_at" DESC, "id" DESC
) e
WHERE e."receipt_id" = r."id" AND r."status" IN ('rejected', 'appealed');

-- ----------------------------------------------------------------------------
-- promos-1: coupon_claims
-- ----------------------------------------------------------------------------
CREATE TABLE "coupon_claims" (
    "id" UUID NOT NULL,
    "promo_id" UUID NOT NULL,
    "coupon_template_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "voucher_id" UUID,
    "status" "CouponClaimStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "coupon_claims_pkey" PRIMARY KEY ("id")
);

-- Existing coupons (vouchers kind coupon, source promo) become claims; the claim id is the voucher
-- source id, exactly what the module used as its deterministic claim slot id.
INSERT INTO "coupon_claims" ("id", "promo_id", "coupon_template_id", "user_id", "voucher_id",
                             "status", "created_at", "cancelled_at")
SELECT v."source_id",
       p."id",
       p."coupon_template_id",
       v."user_id",
       v."id",
       CASE WHEN v."status" = 'cancelled' THEN 'cancelled'::"CouponClaimStatus"
            ELSE 'active'::"CouponClaimStatus" END,
       v."created_at",
       CASE WHEN v."status" = 'cancelled' THEN v."updated_at" END
FROM "vouchers" v
JOIN "promos" p ON p."id"::text = v."meta" ->> 'promoId'
WHERE v."kind" = 'coupon'
  AND v."source_type" = 'promo'
  AND v."source_id" IS NOT NULL
  AND p."coupon_template_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- CreateIndex
CREATE UNIQUE INDEX "coupon_claims_voucher_id_key" ON "coupon_claims"("voucher_id");

-- CreateIndex
CREATE INDEX "coupon_claims_promo_id_user_id_status_idx" ON "coupon_claims"("promo_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "coupon_claims_coupon_template_id_idx" ON "coupon_claims"("coupon_template_id");

-- CreateIndex (admin-1)
CREATE INDEX "manual_adjustments_user_id_created_at_idx" ON "manual_adjustments"("user_id", "created_at");

-- CreateIndex (notifications-1)
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex (receipts-2: receipts-process sweep)
CREATE INDEX "receipts_status_updated_at_idx" ON "receipts"("status", "updated_at");

-- CreateIndex (rewards-2: perUserLimit checks)
CREATE INDEX "redemptions_user_id_reward_id_status_idx" ON "redemptions"("user_id", "reward_id", "status");

-- AddForeignKey (admin-1)
ALTER TABLE "manual_adjustments" ADD CONSTRAINT "manual_adjustments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (promos-1)
ALTER TABLE "coupon_claims" ADD CONSTRAINT "coupon_claims_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "promos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (promos-1)
ALTER TABLE "coupon_claims" ADD CONSTRAINT "coupon_claims_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written SQL that Prisma does not model (invisible to `prisma migrate diff`)
-- ============================================================================

-- club-2: hourly points-release-holds selects state = 'pending' AND available_at <= now()
-- ordered by available_at. The init migration already creates this partial index
-- (points_transactions_pending_available_at_idx), so nothing is created here.

-- rewards-1: VoucherIssuerPort.issue is idempotent by (sourceType, sourceId, kind); the index
-- turns a concurrent duplicate insert into P2002, which the service maps to the existing voucher.
-- Fails if duplicates already exist; find them with
--   SELECT source_type, source_id, kind, count(*) FROM vouchers
--   WHERE source_id IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;
CREATE UNIQUE INDEX "vouchers_source_kind_key"
  ON "vouchers" ("source_type", "source_id", "kind")
  WHERE "source_id" IS NOT NULL;

-- content-1: loyalty rule periods of one tenant never overlap (defence in depth: the service
-- already checks under SELECT ... FROM tenants FOR UPDATE and answers PC_TENANT_RULE_OVERLAP;
-- a violation of this constraint is SQLSTATE 23P01). btree_gist is a trusted extension
-- (PostgreSQL 13+), so the database owner may create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "tenant_loyalty_rules"
  ADD CONSTRAINT "tenant_loyalty_rules_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    tstzrange("valid_from", "valid_to", '[)') WITH &&
  );
