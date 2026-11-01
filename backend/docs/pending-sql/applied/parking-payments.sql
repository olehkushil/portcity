-- APPLIED (archive, do not run): folded into
-- prisma/schema/migrations/20261101180000_review_fixes/migration.sql (the Prisma-generated part below
-- is section 1 there, generated once by prisma migrate diff; the hand-written part is 2.5,
-- the backfill 3.4 and 3.5).

-- Pending migration: parking + payments review fixes (2026-11-01).
-- Owner: parking/payments. To be folded into the next migration folder by the integration agent
-- (no migration folder was created on purpose). Column and index names match
-- `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema` for the edited
-- prisma/schema/parking.prisma; payments.prisma has no column changes.

-- ---------------------------------------------------------------------------------------------
-- Prisma-generated part (schema changes)
-- ---------------------------------------------------------------------------------------------

-- Finding 14: the member's own name for a car.
ALTER TABLE "vehicles" ADD COLUMN "label" VARCHAR(40);

-- Findings 9 and 10: «Так, я тут» (F7) and «Це не моє авто» (F2).
ALTER TABLE "parking_sessions"
  ADD COLUMN "presence_confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN "disputed_at" TIMESTAMPTZ(6),
  ADD COLUMN "dispute_reason" VARCHAR(30),
  ADD COLUMN "dispute_comment" VARCHAR(500);

-- Findings 1, 2 and 4: one link per payment attempt with what payment.succeeded did with it
-- and whether the operator accepted it.
ALTER TABLE "parking_payment_links"
  ADD COLUMN "paid_until" TIMESTAMPTZ(6),
  ADD COLUMN "outcome" VARCHAR(30),
  ADD COLUMN "outcome_at" TIMESTAMPTZ(6),
  ADD COLUMN "registered_at" TIMESTAMPTZ(6);

CREATE INDEX "parking_payment_links_created_at_idx" ON "parking_payment_links"("created_at");

-- Finding 7: operator webhooks are de-duplicated by the provider event id.
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

CREATE INDEX "parking_webhook_logs_received_at_idx" ON "parking_webhook_logs"("received_at");

CREATE UNIQUE INDEX "parking_webhook_logs_provider_event_id_key" ON "parking_webhook_logs"("provider", "event_id");

-- ---------------------------------------------------------------------------------------------
-- Hand-written part (Prisma does not know about these)
-- ---------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------
-- Data backfill (run once, in the same migration)
-- ---------------------------------------------------------------------------------------------

-- Paid period of existing links (the payment meta carries it since the module was built).
UPDATE "parking_payment_links" AS l
SET "paid_until" = (p."meta" ->> 'paidUntil')::timestamptz
FROM "payments" AS p
WHERE p."id" = l."payment_id"
  AND l."paid_until" IS NULL
  AND p."meta" ? 'paidUntil';

-- Payments already handled by the old consumer were applied and registered with the operator;
-- mark them so the new sweep does not replay history.
UPDATE "parking_payment_links" AS l
SET "outcome" = 'applied',
    "outcome_at" = COALESCE(p."paid_at", l."created_at"),
    "registered_at" = COALESCE(p."paid_at", l."created_at")
FROM "payments" AS p
WHERE p."id" = l."payment_id"
  AND l."outcome" IS NULL
  AND p."status" IN ('succeeded', 'fiscalized', 'partially_refunded', 'refunded');

-- Note: payments.idempotency_key stays VARCHAR(255). createPayment now accepts base keys of at
-- most 240 characters and appends `:a<n>` for retried attempts (existing parking keys are ~70).
