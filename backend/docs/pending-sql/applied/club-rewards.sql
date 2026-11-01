-- APPLIED (archive, do not run): folded into
-- prisma/schema/migrations/20261101180000_review_fixes/migration.sql (sections 1, 2.2, 2.3, 3.3).
-- The DDL there comes from prisma migrate diff; this file is kept for the review history.

-- =============================================================================================
-- Pending SQL: club + rewards review fixes (2026-11-01).
--
-- The plain DDL of the schema changes comes from `prisma migrate diff` (do not hand-write it):
--   club.prisma
--     points_transactions.title        varchar(200) NULL   (history display data, finding 10)
--     points_transactions.subtitle     varchar(300) NULL
--     points_transactions.counterparty jsonb        NULL
--     points_spend_allocations (spend_tx_id uuid, expires_on date, amount int,
--       created_at timestamptz default now(), PK (spend_tx_id, expires_on),
--       FK spend_tx_id -> points_transactions(id) ON DELETE RESTRICT)   (finding 2)
--   rewards.prisma
--     vouchers.image_key                   text        NULL              (finding 6)
--     validator_devices.failed_pin_attempts int        NOT NULL DEFAULT 0 (finding 8)
--     validator_devices.pin_locked_until    timestamptz NULL
--
-- Everything below is hand-written and belongs in the same migration, after the generated DDL.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. points_transactions append-only trigger: NO CHANGE NEEDED.
--    points_transactions_append_only() (init migration) compares the whole row minus `state`
--    (`(to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state')`), so the new
--    title / subtitle / counterparty columns are already immutable after INSERT, and INSERT is
--    not affected. Old rows keep NULLs; the API derives a title for them at read time.
--    Sanity check after deploy (must fail with restrict_violation):
--      UPDATE points_transactions SET title = 'x' WHERE id = (SELECT id FROM points_transactions LIMIT 1);
-- ---------------------------------------------------------------------------------------------


-- ---------------------------------------------------------------------------------------------
-- 2. points_spend_allocations: positive portions only, written once per debit row.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "points_spend_allocations"
  ADD CONSTRAINT "points_spend_allocations_amount_positive_chk" CHECK ("amount" > 0);

-- Same append-only rule as the ledger itself: a debit's allocations never change afterwards.
CREATE OR REPLACE FUNCTION points_spend_allocations_append_only() RETURNS trigger
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

-- No backfill: the buckets consumed by spends posted before this migration were not recorded
-- and cannot be reconstructed exactly (later spends and expiries changed the buckets). A refund
-- of such an older debit falls back to the previous behaviour (fresh now + pointsTtlMonths);
-- LedgerService.refundDebit documents it.


-- ---------------------------------------------------------------------------------------------
-- 3. validator_devices: the PIN failure counter never goes negative.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "validator_devices"
  ADD CONSTRAINT "validator_devices_failed_pin_attempts_chk" CHECK ("failed_pin_attempts" >= 0);


-- ---------------------------------------------------------------------------------------------
-- 4. Backfill vouchers.image_key: vouchers bought with points show the reward's picture.
--    New redemption vouchers copy rewards.image_key at issue time; promos/events may pass their
--    own key through IssueVoucherInput.imageKey.
-- ---------------------------------------------------------------------------------------------
UPDATE "vouchers" AS v
SET "image_key" = r."image_key"
FROM "redemptions" AS rd
JOIN "rewards" AS r ON r."id" = rd."reward_id"
WHERE rd."voucher_id" = v."id"
  AND v."image_key" IS NULL
  AND r."image_key" IS NOT NULL;


-- ---------------------------------------------------------------------------------------------
-- 5. Indexes: none new.
--    - GET /club/transactions?from=&to= and /club/transactions/summary use
--      points_transactions (account_id, created_at DESC) (init migration).
--    - GET /vouchers/summary counts per effective status with vouchers (user_id, status).
--    - points_spend_allocations is only read by its primary key (spend_tx_id, expires_on).
-- ---------------------------------------------------------------------------------------------
