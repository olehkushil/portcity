-- APPLIED (archive, do not run): folded into
-- prisma/schema/migrations/20261101180000_review_fixes/migration.sql (B.1 is section 0 there, before
-- the generated DDL; section A is section 1, generated once by prisma migrate diff; B.2-B.6
-- are 2.6 and 3.6).

-- Pending SQL for the promos / notifications / admin review fixes (2026-11-01).
--
-- To be folded into the next migration by the integration agent. Section A is what
-- `prisma migrate diff` produces for the schema changes in prisma/schema/promos.prisma and
-- prisma/schema/admin.prisma (notifications.prisma is unchanged); section B is hand-written SQL
-- Prisma does not know about. ORDER MATTERS: the sequence in B.1 must exist before
-- support_requests is created (its default calls nextval), so run B.1 first, then A, then the
-- rest of B.
--
-- Generated with:
--   prisma migrate diff --from-schema-datamodel <schema with the previous three files>
--                       --to-schema-datamodel prisma/schema --script

-- ===========================================================================================
-- B.1 (run FIRST) Human number of support requests: № 1001, 1002, ... (prototype: № 1042)
-- ===========================================================================================
CREATE SEQUENCE IF NOT EXISTS "support_request_number_seq" AS INTEGER START WITH 1001 INCREMENT BY 1 NO CYCLE;

-- ===========================================================================================
-- A. Prisma-generated DDL
-- ===========================================================================================

-- CreateEnum
CREATE TYPE "SupportRequestTopic" AS ENUM ('receipt', 'parking', 'voucher', 'other');

-- CreateEnum
CREATE TYPE "SupportRequestStatus" AS ENUM ('new', 'in_progress', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "PromoCategory" AS ENUM ('fashion', 'food', 'entertainment', 'kids', 'beauty', 'electronics', 'other');

-- CreateEnum
CREATE TYPE "EventCategory" AS ENUM ('kids', 'masterclass', 'cinema', 'concert', 'other');

-- CreateEnum
CREATE TYPE "EventAdmission" AS ENUM ('registration', 'external');

-- AlterTable
ALTER TABLE "manual_adjustments" ADD COLUMN     "second_approval_reason" VARCHAR(32);

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

-- CreateTable
CREATE TABLE "support_requests" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL DEFAULT nextval('support_request_number_seq'::regclass),
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

-- CreateIndex
CREATE UNIQUE INDEX "support_requests_number_key" ON "support_requests"("number");

-- CreateIndex
CREATE INDEX "support_requests_user_id_created_at_idx" ON "support_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_requests_status_created_at_idx" ON "support_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "manual_adjustments_requested_by_id_created_at_idx" ON "manual_adjustments"("requested_by_id", "created_at");

-- CreateIndex
CREATE INDEX "manual_adjustments_account_id_created_at_idx" ON "manual_adjustments"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "promos_status_category_idx" ON "promos"("status", "category");

-- CreateIndex
CREATE INDEX "events_status_category_starts_at_idx" ON "events"("status", "category", "starts_at");

-- CreateIndex
CREATE INDEX "events_tenant_id_idx" ON "events"("tenant_id");

-- ===========================================================================================
-- B. Hand-written SQL
-- ===========================================================================================

-- B.2 The sequence belongs to the column (dropped with it, visible in pg_dump of the table).
ALTER SEQUENCE "support_request_number_seq" OWNED BY "support_requests"."number";

-- B.3 Foreign keys without Prisma relations (identity.prisma and content.prisma stay untouched).
-- Users are anonymised, never deleted, so RESTRICT is safe; a deleted admin keeps the history.
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_resolved_by_id_fkey"
  FOREIGN KEY ("resolved_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- B.4 CHECK constraints mirroring the DTO/domain validation.
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

-- B.5 Backfill: adjustments above the threshold were always decided by a second admin.
UPDATE "manual_adjustments"
   SET "second_approval_reason" = 'amount'
 WHERE "second_approval_reason" IS NULL
   AND abs("amount") > "threshold_points";

-- B.6 Partial indexes.
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
