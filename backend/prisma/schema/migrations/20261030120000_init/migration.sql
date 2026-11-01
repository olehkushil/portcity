-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ManualAdjustmentStatus" AS ENUM ('pending', 'approved', 'rejected', 'applied');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('admin', 'system', 'user');

-- CreateEnum
CREATE TYPE "PointsTxType" AS ENUM ('earn', 'welcome', 'spend', 'hold', 'release', 'expire', 'adjust', 'reverse', 'refund');

-- CreateEnum
CREATE TYPE "PointsTxState" AS ENUM ('pending', 'available', 'spent', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "PointsSourceType" AS ENUM ('receipt', 'redemption', 'manual', 'promo', 'event', 'parking', 'system');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'hidden', 'closed');

-- CreateEnum
CREATE TYPE "FiscalNumberStatus" AS ENUM ('active', 'pending', 'blocked');

-- CreateEnum
CREATE TYPE "FiscalNumberSource" AS ENUM ('admin', 'receipt', 'import');

-- CreateEnum
CREATE TYPE "ContentImportStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'blocked', 'deleted');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('ios', 'android', 'web');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('program', 'marketing', 'profiling');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('owner', 'manager', 'moderator', 'support', 'validator');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('inapp', 'push', 'both');

-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('queued', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "VehicleVerifiedVia" AS ENUM ('talon', 'paymat_code', 'operator', 'none');

-- CreateEnum
CREATE TYPE "ParkingZone" AS ENUM ('underground', 'surface');

-- CreateEnum
CREATE TYPE "ParkingSessionStatus" AS ENUM ('open', 'payable', 'paid', 'overstay', 'closed', 'closed_unpaid', 'closed_free');

-- CreateEnum
CREATE TYPE "ParkingSessionSource" AS ENUM ('provider', 'info_timer');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('parking', 'other');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('mock', 'liqpay', 'mono', 'wayforpay', 'fondy', 'portmone');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'refunded', 'partially_refunded', 'fiscalized');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('UAH');

-- CreateEnum
CREATE TYPE "PromoKind" AS ENUM ('info', 'coupon');

-- CreateEnum
CREATE TYPE "PromoStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('draft', 'published', 'cancelled', 'finished');

-- CreateEnum
CREATE TYPE "EventRegistrationStatus" AS ENUM ('active', 'cancelled', 'used');

-- CreateEnum
CREATE TYPE "ReceiptSource" AS ENUM ('qr', 'manual');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('uploaded', 'parsed', 'auto_approved', 'needs_moderation', 'approved', 'rejected', 'credited', 'appealed');

-- CreateEnum
CREATE TYPE "RewardKind" AS ENUM ('parking_hour', 'partner', 'certificate', 'gift', 'cinema');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('created', 'issued', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "VoucherKind" AS ENUM ('coupon', 'reward', 'ticket', 'certificate');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('issued', 'active', 'redeemed', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "VoucherSourceType" AS ENUM ('redemption', 'promo', 'event', 'admin');

-- CreateEnum
CREATE TYPE "VoucherRedeemMethod" AS ENUM ('code', 'token');

-- CreateEnum
CREATE TYPE "VoucherRedemptionOutcome" AS ENUM ('redeemed', 'not_found', 'not_active', 'activation_expired', 'already_redeemed', 'expired', 'cancelled', 'wrong_tenant', 'device_inactive');

-- CreateTable
CREATE TABLE "manual_adjustments" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "status" "ManualAdjustmentStatus" NOT NULL DEFAULT 'pending',
    "points_tx_id" UUID,
    "threshold_points" INTEGER NOT NULL DEFAULT 500,
    "decided_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "manual_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_stats" (
    "day" DATE NOT NULL,
    "stats" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_stats_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "available_balance" INTEGER NOT NULL DEFAULT 0,
    "pending_balance" INTEGER NOT NULL DEFAULT 0,
    "lifetime_earned" INTEGER NOT NULL DEFAULT 0,
    "newcomer_lock_until" TIMESTAMPTZ(6),
    "welcome_state" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_transactions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" "PointsTxType" NOT NULL,
    "state" "PointsTxState" NOT NULL,
    "amount" INTEGER NOT NULL,
    "source_type" "PointsSourceType" NOT NULL,
    "source_id" UUID,
    "idempotency_key" VARCHAR(255),
    "available_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_expiry_buckets" (
    "account_id" UUID NOT NULL,
    "expires_on" DATE NOT NULL,
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "points_expiry_buckets_pkey" PRIMARY KEY ("account_id","expires_on")
);

-- CreateTable
CREATE TABLE "loyalty_rule_sets" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL,
    "config" JSONB NOT NULL,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "floor" INTEGER,
    "logo_key" TEXT,
    "website" TEXT,
    "phone" VARCHAR(32),
    "description" TEXT,
    "participates" BOOLEAN NOT NULL DEFAULT true,
    "rate_percent_override" INTEGER,
    "excluded_from_program" BOOLEAN NOT NULL DEFAULT false,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_fiscal_numbers" (
    "id" UUID NOT NULL,
    "fn" VARCHAR(20) NOT NULL,
    "tenant_id" UUID,
    "status" "FiscalNumberStatus" NOT NULL DEFAULT 'pending',
    "source" "FiscalNumberSource" NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_fiscal_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_loyalty_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rate_percent" INTEGER NOT NULL,
    "min_total_kopecks" INTEGER NOT NULL DEFAULT 0,
    "daily_cap_points" INTEGER,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_loyalty_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_import_runs" (
    "id" UUID NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "status" "ContentImportStatus" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "stats" JSONB,
    "error" TEXT,

    CONSTRAINT "content_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "email" VARCHAR(254),
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "birth_date" DATE,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "member_code" VARCHAR(9) NOT NULL,
    "profile_completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "model" VARCHAR(100),
    "app_version" VARCHAR(32),
    "fingerprint" VARCHAR(128),
    "push_token" TEXT,
    "push_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "ip" VARCHAR(45),
    "device_fingerprint" VARCHAR(128),
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "family" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "role" "AdminRole" NOT NULL,
    "name" VARCHAR(200),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletion_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "execute_after" TIMESTAMPTZ(6) NOT NULL,
    "executed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "reason" TEXT,

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "channel" "NotificationChannel" NOT NULL DEFAULT 'inapp',
    "sent_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'fcm',
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","kind")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plate" VARCHAR(16) NOT NULL,
    "plate_display" VARCHAR(20) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_via" "VehicleVerifiedVia" NOT NULL DEFAULT 'none',
    "verified_at" TIMESTAMPTZ(6),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parking_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "vehicle_id" UUID,
    "plate" VARCHAR(16),
    "zone" "ParkingZone" NOT NULL,
    "entered_at" TIMESTAMPTZ(6) NOT NULL,
    "exited_at" TIMESTAMPTZ(6),
    "status" "ParkingSessionStatus" NOT NULL DEFAULT 'open',
    "paid_until" TIMESTAMPTZ(6),
    "amount_due_kopecks" INTEGER NOT NULL DEFAULT 0,
    "amount_paid_kopecks" INTEGER NOT NULL DEFAULT 0,
    "provider_ref" VARCHAR(100),
    "source" "ParkingSessionSource" NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6),
    "closed_reason" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "parking_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parking_tariffs" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL,
    "config" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parking_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parking_payment_links" (
    "session_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parking_payment_links_pkey" PRIMARY KEY ("session_id","payment_id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "amount_kopecks" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'UAH',
    "provider" "PaymentProvider" NOT NULL,
    "provider_ref" VARCHAR(100),
    "status" "PaymentStatus" NOT NULL DEFAULT 'created',
    "idempotency_key" VARCHAR(255) NOT NULL,
    "checkout_url" TEXT,
    "fiscal_receipt_url" TEXT,
    "failure_code" VARCHAR(100),
    "refunded_kopecks" INTEGER NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMPTZ(6),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_logs" (
    "id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "payment_id" UUID,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "result" VARCHAR(200),

    CONSTRAINT "payment_webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "kind" "PromoKind" NOT NULL DEFAULT 'info',
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6) NOT NULL,
    "image_key" TEXT,
    "status" "PromoStatus" NOT NULL DEFAULT 'draft',
    "coupon_template_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_templates" (
    "id" UUID NOT NULL,
    "discount_text" VARCHAR(200) NOT NULL,
    "per_user_limit" INTEGER NOT NULL DEFAULT 1,
    "total_limit" INTEGER,
    "claimed_count" INTEGER NOT NULL DEFAULT 0,
    "requires_activation" BOOLEAN NOT NULL DEFAULT true,
    "validity_hours_after_claim" INTEGER,
    "terms" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "coupon_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "venue" VARCHAR(200),
    "capacity" INTEGER,
    "registered_count" INTEGER NOT NULL DEFAULT 0,
    "registration_open" BOOLEAN NOT NULL DEFAULT true,
    "age_limit" INTEGER,
    "image_key" TEXT,
    "status" "EventStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_registrations" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "voucher_id" UUID,
    "status" "EventRegistrationStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "event_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "fn" VARCHAR(20) NOT NULL,
    "fiscal_id" VARCHAR(64) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "total_kopecks" INTEGER NOT NULL,
    "raw_qr" TEXT,
    "source" "ReceiptSource" NOT NULL,
    "photo_key" TEXT,
    "tenant_id" UUID,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'uploaded',
    "risk_flags" JSONB NOT NULL DEFAULT '[]',
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "moderator_id" UUID,
    "decision_reason" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "points_awarded" INTEGER,
    "points_tx_id" UUID,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_events" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "from_status" "ReceiptStatus",
    "to_status" "ReceiptStatus" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_appeals" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "photo_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_id" UUID,
    "resolution" TEXT,

    CONSTRAINT "receipt_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "cost_points" INTEGER NOT NULL,
    "kind" "RewardKind" NOT NULL,
    "tenant_id" UUID,
    "stock" INTEGER,
    "per_user_limit" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "image_key" TEXT,
    "terms" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reward_id" UUID NOT NULL,
    "points_tx_id" UUID,
    "voucher_id" UUID,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'created',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "VoucherKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "subtitle" VARCHAR(300),
    "tenant_id" UUID,
    "code" VARCHAR(6),
    "token_hash" VARCHAR(64),
    "status" "VoucherStatus" NOT NULL DEFAULT 'issued',
    "activated_at" TIMESTAMPTZ(6),
    "activation_expires_at" TIMESTAMPTZ(6),
    "redeemed_at" TIMESTAMPTZ(6),
    "redeemed_by_device_id" UUID,
    "redeemed_by_tenant_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "source_type" "VoucherSourceType" NOT NULL,
    "source_id" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validator_devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "device_key_hash" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "validator_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_redemption_logs" (
    "id" UUID NOT NULL,
    "voucher_id" UUID,
    "validator_device_id" UUID,
    "method" "VoucherRedeemMethod" NOT NULL,
    "code_tried" VARCHAR(16),
    "outcome" "VoucherRedemptionOutcome" NOT NULL,
    "message" TEXT,
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_redemption_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manual_adjustments_points_tx_id_key" ON "manual_adjustments"("points_tx_id");

-- CreateIndex
CREATE INDEX "manual_adjustments_status_created_at_idx" ON "manual_adjustments"("status", "created_at");

-- CreateIndex
CREATE INDEX "manual_adjustments_account_id_idx" ON "manual_adjustments"("account_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_created_at_idx" ON "audit_logs"("actor_type", "actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_accounts_user_id_key" ON "loyalty_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "points_transactions_idempotency_key_key" ON "points_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "points_transactions_account_id_created_at_idx" ON "points_transactions"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "points_transactions_state_expires_at_idx" ON "points_transactions"("state", "expires_at");

-- CreateIndex
CREATE INDEX "points_transactions_source_type_source_id_idx" ON "points_transactions"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "points_expiry_buckets_expires_on_idx" ON "points_expiry_buckets"("expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_rule_sets_version_key" ON "loyalty_rule_sets"("version");

-- CreateIndex
CREATE INDEX "loyalty_rule_sets_active_from_idx" ON "loyalty_rule_sets"("active_from");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_status_participates_idx" ON "tenants"("status", "participates");

-- CreateIndex
CREATE INDEX "tenants_category_idx" ON "tenants"("category");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_fiscal_numbers_fn_key" ON "tenant_fiscal_numbers"("fn");

-- CreateIndex
CREATE INDEX "tenant_fiscal_numbers_tenant_id_idx" ON "tenant_fiscal_numbers"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_fiscal_numbers_status_idx" ON "tenant_fiscal_numbers"("status");

-- CreateIndex
CREATE INDEX "tenant_loyalty_rules_tenant_id_valid_from_idx" ON "tenant_loyalty_rules"("tenant_id", "valid_from");

-- CreateIndex
CREATE INDEX "content_import_runs_started_at_idx" ON "content_import_runs"("started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_member_code_key" ON "users"("member_code");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "devices_fingerprint_idx" ON "devices"("fingerprint");

-- CreateIndex
CREATE INDEX "consents_user_id_purpose_idx" ON "consents"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_created_at_idx" ON "otp_challenges"("phone", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_ip_created_at_idx" ON "otp_challenges"("ip", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "account_deletion_requests_user_id_idx" ON "account_deletion_requests"("user_id");

-- CreateIndex
CREATE INDEX "account_deletion_requests_executed_at_execute_after_idx" ON "account_deletion_requests"("executed_at", "execute_after");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "push_deliveries_notification_id_idx" ON "push_deliveries"("notification_id");

-- CreateIndex
CREATE INDEX "push_deliveries_device_id_idx" ON "push_deliveries"("device_id");

-- CreateIndex
CREATE INDEX "push_deliveries_status_updated_at_idx" ON "push_deliveries"("status", "updated_at");

-- CreateIndex
CREATE INDEX "vehicles_user_id_idx" ON "vehicles"("user_id");

-- CreateIndex
CREATE INDEX "vehicles_plate_idx" ON "vehicles"("plate");

-- CreateIndex
CREATE UNIQUE INDEX "parking_sessions_provider_ref_key" ON "parking_sessions"("provider_ref");

-- CreateIndex
CREATE INDEX "parking_sessions_plate_status_idx" ON "parking_sessions"("plate", "status");

-- CreateIndex
CREATE INDEX "parking_sessions_user_id_entered_at_idx" ON "parking_sessions"("user_id", "entered_at" DESC);

-- CreateIndex
CREATE INDEX "parking_sessions_status_last_synced_at_idx" ON "parking_sessions"("status", "last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "parking_tariffs_version_key" ON "parking_tariffs"("version");

-- CreateIndex
CREATE INDEX "parking_tariffs_active_from_idx" ON "parking_tariffs"("active_from");

-- CreateIndex
CREATE INDEX "parking_payment_links_payment_id_idx" ON "parking_payment_links"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "payments_provider_provider_ref_idx" ON "payments"("provider", "provider_ref");

-- CreateIndex
CREATE INDEX "payment_webhook_logs_payment_id_idx" ON "payment_webhook_logs"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_logs_provider_external_id_key" ON "payment_webhook_logs"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "promos_coupon_template_id_key" ON "promos"("coupon_template_id");

-- CreateIndex
CREATE INDEX "promos_status_valid_from_valid_to_idx" ON "promos"("status", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "promos_tenant_id_idx" ON "promos"("tenant_id");

-- CreateIndex
CREATE INDEX "events_status_starts_at_idx" ON "events"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "event_registrations_voucher_id_key" ON "event_registrations"("voucher_id");

-- CreateIndex
CREATE INDEX "event_registrations_user_id_idx" ON "event_registrations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_registrations_event_id_user_id_key" ON "event_registrations"("event_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_points_tx_id_key" ON "receipts"("points_tx_id");

-- CreateIndex
CREATE INDEX "receipts_user_id_submitted_at_idx" ON "receipts"("user_id", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "receipts_status_submitted_at_idx" ON "receipts"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "receipts_fn_issued_at_idx" ON "receipts"("fn", "issued_at");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_idx" ON "receipts"("tenant_id");

-- CreateIndex
CREATE INDEX "receipts_device_id_idx" ON "receipts"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_fn_fiscal_id_key" ON "receipts"("fn", "fiscal_id");

-- CreateIndex
CREATE INDEX "receipt_events_receipt_id_created_at_idx" ON "receipt_events"("receipt_id", "created_at");

-- CreateIndex
CREATE INDEX "receipt_appeals_receipt_id_idx" ON "receipt_appeals"("receipt_id");

-- CreateIndex
CREATE INDEX "receipt_appeals_resolved_at_idx" ON "receipt_appeals"("resolved_at");

-- CreateIndex
CREATE INDEX "rewards_active_valid_from_valid_to_idx" ON "rewards"("active", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "rewards_kind_idx" ON "rewards"("kind");

-- CreateIndex
CREATE INDEX "rewards_tenant_id_idx" ON "rewards"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "redemptions_points_tx_id_key" ON "redemptions"("points_tx_id");

-- CreateIndex
CREATE UNIQUE INDEX "redemptions_voucher_id_key" ON "redemptions"("voucher_id");

-- CreateIndex
CREATE INDEX "redemptions_user_id_created_at_idx" ON "redemptions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "redemptions_reward_id_idx" ON "redemptions"("reward_id");

-- CreateIndex
CREATE INDEX "vouchers_user_id_status_idx" ON "vouchers"("user_id", "status");

-- CreateIndex
CREATE INDEX "vouchers_status_expires_at_idx" ON "vouchers"("status", "expires_at");

-- CreateIndex
CREATE INDEX "vouchers_status_activation_expires_at_idx" ON "vouchers"("status", "activation_expires_at");

-- CreateIndex
CREATE INDEX "vouchers_source_type_source_id_idx" ON "vouchers"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "validator_devices_device_key_hash_key" ON "validator_devices"("device_key_hash");

-- CreateIndex
CREATE INDEX "validator_devices_tenant_id_idx" ON "validator_devices"("tenant_id");

-- CreateIndex
CREATE INDEX "voucher_redemption_logs_validator_device_id_created_at_idx" ON "voucher_redemption_logs"("validator_device_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "voucher_redemption_logs_voucher_id_idx" ON "voucher_redemption_logs"("voucher_id");

-- AddForeignKey
ALTER TABLE "manual_adjustments" ADD CONSTRAINT "manual_adjustments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "loyalty_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_adjustments" ADD CONSTRAINT "manual_adjustments_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_adjustments" ADD CONSTRAINT "manual_adjustments_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_adjustments" ADD CONSTRAINT "manual_adjustments_points_tx_id_fkey" FOREIGN KEY ("points_tx_id") REFERENCES "points_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_transactions" ADD CONSTRAINT "points_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "loyalty_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_transactions" ADD CONSTRAINT "points_transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_expiry_buckets" ADD CONSTRAINT "points_expiry_buckets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "loyalty_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_rule_sets" ADD CONSTRAINT "loyalty_rule_sets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_fiscal_numbers" ADD CONSTRAINT "tenant_fiscal_numbers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_fiscal_numbers" ADD CONSTRAINT "tenant_fiscal_numbers_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_loyalty_rules" ADD CONSTRAINT "tenant_loyalty_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_sessions" ADD CONSTRAINT "parking_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_sessions" ADD CONSTRAINT "parking_sessions_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_tariffs" ADD CONSTRAINT "parking_tariffs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_payment_links" ADD CONSTRAINT "parking_payment_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "parking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parking_payment_links" ADD CONSTRAINT "parking_payment_links_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_logs" ADD CONSTRAINT "payment_webhook_logs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promos" ADD CONSTRAINT "promos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promos" ADD CONSTRAINT "promos_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_points_tx_id_fkey" FOREIGN KEY ("points_tx_id") REFERENCES "points_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_events" ADD CONSTRAINT "receipt_events_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_appeals" ADD CONSTRAINT "receipt_appeals_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_appeals" ADD CONSTRAINT "receipt_appeals_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "rewards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_points_tx_id_fkey" FOREIGN KEY ("points_tx_id") REFERENCES "points_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_redeemed_by_device_id_fkey" FOREIGN KEY ("redeemed_by_device_id") REFERENCES "validator_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_redeemed_by_tenant_id_fkey" FOREIGN KEY ("redeemed_by_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validator_devices" ADD CONSTRAINT "validator_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_redemption_logs" ADD CONSTRAINT "voucher_redemption_logs_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_redemption_logs" ADD CONSTRAINT "voucher_redemption_logs_validator_device_id_fkey" FOREIGN KEY ("validator_device_id") REFERENCES "validator_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- ============================================================================
-- Hand-written additions (BRIEF section 5).
-- Everything above this banner was generated with
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema --script
-- Prisma does not track triggers, CHECK constraints or partial indexes, so the
-- objects below never show up as drift in `prisma migrate dev`.
-- All regular (non-partial) indexes from section 5 are declared in the Prisma
-- schema and therefore already created above:
--   receipts_user_id_submitted_at_idx, receipts_status_submitted_at_idx,
--   receipts_fn_issued_at_idx, points_transactions_account_id_created_at_idx,
--   points_transactions_state_expires_at_idx, parking_sessions_plate_status_idx,
--   parking_sessions_user_id_entered_at_idx.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 5.1 points_transactions is append-only.
--     DELETE is forbidden. UPDATE may change only `state`, and only forward:
--       pending   -> available | cancelled
--       available -> spent | expired
--     Any other column change is rejected.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION points_transactions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'points_transactions is append-only: DELETE is not allowed (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Compare the whole row minus `state`: any other change is rejected,
  -- which also covers columns added in later migrations.
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'points_transactions is append-only: only state may change (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
         (OLD.state = 'pending'   AND NEW.state IN ('available', 'cancelled'))
      OR (OLD.state = 'available' AND NEW.state IN ('spent', 'expired'))
    ) THEN
      RAISE EXCEPTION 'points_transactions: illegal state transition % -> % (id=%)', OLD.state, NEW.state, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER points_transactions_append_only
  BEFORE UPDATE OR DELETE ON "points_transactions"
  FOR EACH ROW EXECUTE FUNCTION points_transactions_append_only();

-- ----------------------------------------------------------------------------
-- 5.2 audit_logs is append-only: no UPDATE, no DELETE.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
  RETURN NULL;
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- ----------------------------------------------------------------------------
-- 5.3 CHECK constraints.
-- ----------------------------------------------------------------------------
ALTER TABLE "points_transactions"
  ADD CONSTRAINT "points_transactions_amount_nonzero_chk" CHECK ("amount" <> 0);

ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_total_kopecks_positive_chk" CHECK ("total_kopecks" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_kopecks_positive_chk" CHECK ("amount_kopecks" > 0);

-- ----------------------------------------------------------------------------
-- 5.4 Voucher codes are unique among non-final vouchers only, so a code can be
--     reused once the voucher is redeemed, expired or cancelled.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX "vouchers_code_live_key"
  ON "vouchers" ("code")
  WHERE "status" IN ('issued', 'active');

-- ----------------------------------------------------------------------------
-- 5.5 Partial and extra indexes.
-- ----------------------------------------------------------------------------
-- Outbox dispatcher: unpublished events only.
CREATE INDEX "outbox_events_unpublished_idx"
  ON "outbox_events" ("published_at")
  WHERE "published_at" IS NULL;

-- One live (not soft-deleted) vehicle per plate per member.
CREATE UNIQUE INDEX "vehicles_user_id_plate_live_key"
  ON "vehicles" ("user_id", "plate")
  WHERE "deleted_at" IS NULL;

-- Holds waiting for release (points-release-holds job).
CREATE INDEX "points_transactions_pending_available_at_idx"
  ON "points_transactions" ("available_at")
  WHERE "state" = 'pending';

-- ----------------------------------------------------------------------------
-- 5.6 Balance consistency (procedural, no DDL): loyalty_accounts.available_balance
--     and pending_balance are updated in the same transaction as the ledger row
--     under SELECT ... FOR UPDATE on the account row; the nightly job recomputes
--     both from points_transactions and reports drift.
-- ----------------------------------------------------------------------------
