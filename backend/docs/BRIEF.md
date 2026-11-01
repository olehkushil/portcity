# PortCity Loyalty Backend — build brief (binding for all workflow agents)

Project: backend of the «Порт City» mall mobile app (Lutsk, Ukraine). Source of truth for product decisions: `C:/Agent/ПортСіті/План_розробки_PortCity_App.md` (sections 5, 7.3, 7.4, 12.2) and the clickable prototype `C:/Agent/ПортСіті/design/PortCity_App_prototype.html` (56 screens; tabs Паркінг · Картка · Акції|Події · Винагороди · ТРЦ). This brief condenses what the code must implement; when the brief and the plan disagree, the brief wins and the disagreement is noted in `docs/INTEGRATION_NOTES.md`.

## 0. Environment and ground rules

- Repository root: `C:/Agent/ПортСіті/backend` (Git Bash: `/c/Agent/ПортСіті/backend`). The path contains Cyrillic; the user's home path contains a space. Tools must cope; if one does not, record it in `docs/INTEGRATION_NOTES.md` and work around it.
- Node 24 is NOT installed system-wide. A portable Node 24.22.2 lives at
  `C:/Users/OLEHKU~1/AppData/Local/Temp/claude/C--Users-Oleh-Kushil--claude-spares-spare-zrJAoB/8b670004-2453-4b71-b528-e3f6da5b2138/scratchpad/tools/node/node-v24.22.2-win-x64`.
  Prepend it to PATH in every shell you open:
  - Bash: `export PATH="/c/Users/OLEHKU~1/AppData/Local/Temp/claude/C--Users-Oleh-Kushil--claude-spares-spare-zrJAoB/8b670004-2453-4b71-b528-e3f6da5b2138/scratchpad/tools/node/node-v24.22.2-win-x64:$PATH"`
  - PowerShell: `$env:Path = "C:\Users\OLEHKU~1\AppData\Local\Temp\claude\C--Users-Oleh-Kushil--claude-spares-spare-zrJAoB\8b670004-2453-4b71-b528-e3f6da5b2138\scratchpad\tools\node\node-v24.22.2-win-x64;" + $env:Path`
    Internet access works (npm registry, Prisma engine downloads). Docker, PostgreSQL and Redis are NOT available locally: anything that needs them must be skipped locally and run in CI (service containers). Never try to install software system-wide.
- The Bash tool in this environment mangles backslashes inside heredocs. Write files with the Write/Edit tools; use forward slashes in paths; in Python use `chr(92)` if you ever need a backslash.
- Package manager: npm (ships with Node). Commit-ready `package-lock.json` must exist. Only the foundation and integration agents may run `npm install`; module agents must not (concurrent installs corrupt the lockfile). A module agent that needs a dependency writes the package name and reason to `docs/deps-requests/<module>.md` and codes against it as if installed only when it is already in `package.json`; otherwise it uses what is available.
- Language: identifiers, comments and commit-style messages in English; README files and `docs/*.md` in Ukrainian (short English summary allowed). No emoji anywhere. Money in integer kopecks, points in integers, timestamps in UTC (`timestamptz`), business time zone `Europe/Kyiv`.
- No git commits by agents (the user commits). Do not create a GitHub repository.

## 1. Stack (fixed)

| Concern        | Choice                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | Node 24 LTS, TypeScript strict (`strict`, `noImplicitOverride`, `noUncheckedIndexedAccess` on; use `exactOptionalPropertyTypes` only if the Nest template compiles with it)                                                                               |
| Framework      | NestJS, latest stable major whose `@nestjs/*` packages are all released at that major (check `npm view @nestjs/core version`, `npm view @nestjs/swagger version`, `npm view @nestjs/bullmq version`; if any lags, use the previous major for all of them) |
| ORM / DB       | Prisma **6.19.x** (not 7) with the multi-file schema folder `prisma/schema/*.prisma` (`"prisma": { "schema": "prisma/schema", "seed": "..." }` in package.json), PostgreSQL 17                                                                            |
| Queues / cache | Redis 7, BullMQ latest **stable** (no rc) via `@nestjs/bullmq`, `ioredis`                                                                                                                                                                                 |
| Config         | `@nestjs/config` + `zod` schema for env (fail fast on boot)                                                                                                                                                                                               |
| API docs       | `@nestjs/swagger`; OpenAPI served at `/docs`, JSON written to `docs/openapi.json` by `npm run openapi`                                                                                                                                                    |
| Validation     | `class-validator` + `class-transformer`, global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`                                                                                                                        |
| Logging        | `nestjs-pino` (+ `pino-pretty` in dev); request id header `x-request-id`                                                                                                                                                                                  |
| Security       | `helmet`, `@nestjs/throttler` (global 60 rpm per IP plus stricter per-route limits), CORS allowlist from env                                                                                                                                              |
| Crypto         | Node `crypto` only: `scrypt` for admin passwords, HMAC-SHA256 with a server pepper for OTP codes and voucher codes, SHA-256 for refresh tokens. No native addons.                                                                                         |
| Dates          | `date-fns` v4 + `@date-fns/tz`                                                                                                                                                                                                                            |
| Ids            | UUID v7 generated in the app (`uuidv7` package); Prisma `String @id` columns typed `@db.Uuid`                                                                                                                                                             |
| Tests          | Jest + `ts-jest` (or `@swc/jest` if faster and it works) + `supertest`; unit specs beside code (`*.spec.ts`), integration specs in `test/**/*.int-spec.ts` that self-skip when `DATABASE_URL` is unset                                                    |
| Lint           | ESLint 9 flat config with `typescript-eslint` recommended-type-checked, Prettier; `npm run lint` must pass                                                                                                                                                |
| Health         | `@nestjs/terminus`: `GET /health` (liveness), `GET /ready` (DB + Redis)                                                                                                                                                                                   |
| Storage        | S3-compatible via `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` behind a `StoragePort` interface with an in-memory fake for tests                                                                                                                |

## 2. Repository layout

```
backend/
  package.json  package-lock.json  tsconfig.json  tsconfig.build.json  nest-cli.json
  eslint.config.mjs  .prettierrc  .editorconfig  .gitignore  .nvmrc (24)  .env.example
  Dockerfile  docker-compose.yml  .dockerignore
  ../.github/workflows/backend.yml
  prisma/schema/base.prisma            (datasource, generator, shared enums, Outbox, IdempotencyKey, FeatureFlag, AuditLog)
  prisma/schema/<module>.prisma        (one per module, see section 4)
  prisma/schema/migrations/<timestamp>_init/migration.sql   (generated with `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema --script`, then hand-extended with triggers and constraints listed in section 5)
  prisma/schema/migrations/migration_lock.toml
  prisma/seed.ts
  src/main.ts                 API entrypoint (port from env, prefix /api/v1, swagger at /docs, graceful shutdown)
  src/worker.ts               BullMQ worker entrypoint (same AppModule in worker mode, no HTTP listener except /health on WORKER_PORT)
  src/app.module.ts
  src/common/config/          env schema + ConfigModule wrapper
  src/common/prisma/          PrismaService (connect/disconnect, soft logging), transaction helper `withTx`
  src/common/redis/           RedisModule (ioredis client provider)
  src/common/auth/            JwtService wrapper, `@Auth()` decorator, MemberGuard, AdminGuard, RolesGuard, `@CurrentUser()`
  src/common/errors/          DomainError (code, status, details), ProblemDetailsFilter (RFC 7807), error code registry
  src/common/idempotency/     IdempotencyInterceptor (header `Idempotency-Key`, table idempotency_keys, 24 h TTL)
  src/common/outbox/          OutboxService.publish(tx, event), outbox dispatcher job
  src/common/time/            Kyiv time helpers, Clock interface (injectable, fakeable)
  src/common/money/           kopecks helpers, UAH formatting for messages
  src/common/phone/           E.164 normalisation for Ukrainian numbers (libphonenumber-js)
  src/common/storage/         StoragePort + S3 adapter + InMemory adapter
  src/common/contracts/       cross-module interfaces and DTO types; one file per module, owned by that module's agent
  src/modules/identity/       auth, users, devices, consents, account deletion, admin users
  src/modules/club/           loyalty accounts, points ledger, rules, expiry, holds
  src/modules/content/        tenants, fiscal numbers, tenant rules, WordPress import stub
  src/modules/receipts/       QR parser, submission, risk rules, moderation, photos
  src/modules/rewards/        reward catalogue, redemptions, vouchers, activation, validator
  src/modules/promos/         promos, coupon templates, events, registrations/tickets
  src/modules/parking/        vehicles, sessions, tariff, provider port + emulator, info mode
  src/modules/payments/       payments, provider port + mock, webhooks, fiscalisation hook
  src/modules/notifications/  in-app notifications, push port + FCM stub, outbox consumers
  src/modules/admin/          RBAC, audit log, manual adjustments (four eyes), feature flags, back-office CRUD facades
  test/                       e2e and integration specs, test utilities (app factory, DB reset)
  docs/                       BRIEF.md (this), ARCHITECTURE.md, API.md, RUNBOOK.md, INTEGRATION_NOTES.md, ADR/
```

Each `src/modules/<name>/` contains `<name>.module.ts`, `controllers/`, `services/`, `dto/`, `domain/` (pure logic: state machines, calculators, parsers — no Nest imports), `jobs/` (BullMQ processors) where relevant, `index.ts` exporting the public service(s) and contracts, and `README.md` (Ukrainian).

## 3. Cross-module rules

- A module touches only its own tables through Prisma. Reading another module's tables for queries is allowed through that module's exported service; writing never.
- Side effects across modules go through the outbox: inside the same transaction the module inserts an `OutboxEvent` (`type` like `receipt.credited`, `voucher.activated`, `parking.session.payable`, `points.expiring`). The worker's dispatcher moves events to BullMQ queues; consumers live in the module that reacts (notifications, club, rewards).
- Every mutation endpoint that creates a financial or points effect requires the `Idempotency-Key` header (interceptor returns the stored response on replay with the same request hash; `409` on the same key with a different body).
- Domain errors use codes `PC_<MODULE>_<REASON>`, e.g. `PC_RECEIPT_DUPLICATE`, `PC_RECEIPT_TOO_OLD`, `PC_POINTS_INSUFFICIENT`, `PC_VOUCHER_NOT_ACTIVE`, `PC_OTP_INVALID`, `PC_PARKING_UNKNOWN_PLATE`. Responses are `application/problem+json` with `type`, `title`, `status`, `detail`, `code`, `instance`, `requestId`.
- Auth: Bearer access JWT (HS256 in dev from `JWT_SECRET`, 15 min, claims `sub`, `typ: member|admin`, `roles`, `did` device id). Refresh tokens: opaque 32-byte random, stored hashed with a `family` id, 60 days, rotated on every refresh; reuse of a rotated token revokes the whole family. Admin users: email + password (scrypt) + optional TOTP (`otplib`), separate guard, roles `owner | manager | moderator | support | validator`.
- Pagination: cursor-based (`?cursor=&limit=`), response `{ items, nextCursor }`.
- All list endpoints for members are scoped to the authenticated user; admin endpoints live under `/admin/*` and are audited.

## 4. Domain model (schema owners in brackets)

Shared enums live in `base.prisma`. Field types: ids `String @id @db.Uuid`, money `Int` kopecks (`BigInt` for aggregates), `createdAt DateTime @default(now()) @db.Timestamptz(6)`, soft deletes only where stated.

**[identity]** `User` (id, phone unique E.164, email nullable unique, firstName, lastName, birthDate nullable, status `active|blocked|deleted`, memberCode unique 9 digits, profileCompletedAt, createdAt, deletedAt) · `Device` (id, userId, platform `ios|android|web`, model, appVersion, pushToken nullable, pushEnabled, lastSeenAt) · `Consent` (id, userId, purpose `program|marketing|profiling`, version, grantedAt, revokedAt) · `OtpChallenge` (id, phone, codeHash, expiresAt, attempts, maxAttempts 5, ip, deviceFingerprint, consumedAt) · `RefreshToken` (id, userId, deviceId, family, tokenHash unique, expiresAt, revokedAt, replacedById) · `AdminUser` (id, email unique, passwordHash, totpSecret nullable, role, active, lastLoginAt) · `AccountDeletionRequest` (id, userId, requestedAt, executeAfter = +30 days, executedAt, reason).

**[club]** `LoyaltyAccount` (id, userId unique, availableBalance Int cached, pendingBalance Int cached, lifetimeEarned Int, newcomerLockUntil nullable, welcomeState jsonb, createdAt) · `PointsTransaction` append-only (id, accountId, type `earn|welcome|spend|hold|release|expire|adjust|reverse|refund`, state `pending|available|spent|expired|cancelled`, amount Int signed, sourceType `receipt|redemption|manual|promo|event|parking|system`, sourceId nullable, idempotencyKey unique nullable, availableAt nullable, expiresAt nullable, reason nullable, createdBy nullable (admin id), createdAt) · `PointsExpiryBucket` (accountId, expiresOn date, remaining Int) for efficient FIFO expiry · `LoyaltyRuleSet` (id, version unique, activeFrom, config jsonb, createdBy). Default config (plan 12.2): `baseRatePercent 3`, `maxPointsPerReceipt 500`, `minReceiptTotalKopecks 0`, `dailyReceiptLimit 10`, `autoApproveThresholdKopecks 100000`, `holdThresholdKopecks 300000`, `holdDays 7`, `uploadWindowDays 7`, `pointsTtlMonths 12`, `newcomerLockHours 72`, `welcome: { register 50, profile 30, firstReceipt 20 }`, `pointValueKopecks 100`, `expiryReminderDays [30, 7]`.

**[content]** `Tenant` (id, slug unique, name, category, floor, logoKey, website, phone, participates bool, ratePercentOverride nullable, excludedFromProgram bool, status) · `TenantFiscalNumber` (id, fn unique, tenantId nullable, status `active|pending|blocked`, source `admin|receipt|import`, firstSeenAt, confirmedBy) · `TenantLoyaltyRule` (id, tenantId, ratePercent, minTotalKopecks, dailyCapPoints, validFrom, validTo) · `ContentImportRun` (WordPress import stub: id, source, startedAt, finishedAt, stats jsonb).

**[receipts]** `Receipt` (id, userId, deviceId, fn, fiscalId, issuedAt, totalKopecks, rawQr nullable, source `qr|manual`, photoKey nullable, tenantId nullable, status `uploaded|parsed|auto_approved|needs_moderation|approved|rejected|credited|appealed`, riskFlags jsonb (string array), riskScore Int, moderatorId nullable, decisionReason nullable, decidedAt nullable, pointsAwarded Int nullable, pointsTxId nullable, submittedAt, createdAt; `@@unique([fn, fiscalId])`) · `ReceiptEvent` (id, receiptId, fromStatus, toStatus, actorType `system|user|admin`, actorId, note, createdAt) · `ReceiptAppeal` (id, receiptId, message, photoKey, createdAt, resolvedAt).

**[rewards]** `Reward` (id, title, description, costPoints, kind `parking_hour|partner|certificate|gift|cinema`, tenantId nullable, stock nullable, perUserLimit nullable, active, validFrom, validTo, imageKey, terms) · `Redemption` (id, userId, rewardId, pointsTxId, voucherId, status `created|issued|cancelled|refunded`, createdAt) · `Voucher` (id, userId, kind `coupon|reward|ticket|certificate`, title, subtitle, tenantId nullable, code String(6) unique among non-final vouchers (partial unique index), tokenHash nullable, status `issued|active|redeemed|expired|cancelled`, activatedAt, activationExpiresAt, redeemedAt, redeemedByDeviceId, redeemedByTenantId, expiresAt, sourceType `redemption|promo|event|admin`, sourceId, meta jsonb, createdAt) · `ValidatorDevice` (id, tenantId, name, pinHash, deviceKeyHash, active, lastSeenAt, revokedAt) · `VoucherRedemptionLog`.

**[promos]** `Promo` (id, tenantId nullable, title, body, kind `info|coupon`, validFrom, validTo, imageKey, status `draft|published|archived`, couponTemplateId nullable, priority) · `CouponTemplate` (id, discountText, perUserLimit, totalLimit, claimedCount, requiresActivation bool, validityHoursAfterClaim) · `Event` (id, title, description, startsAt, endsAt, venue, capacity, registeredCount, registrationOpen, ageLimit, imageKey, status) · `EventRegistration` (id, eventId, userId, adults Int, children Int, voucherId (ticket), status `active|cancelled|used`, createdAt; `@@unique([eventId, userId])`).

**[parking]** `Vehicle` (id, userId, plate normalised (Latin, no spaces), plateDisplay, verified bool, verifiedVia `talon|paymat_code|operator|none`, isDefault, createdAt, deletedAt) · `ParkingSession` (id, userId nullable, vehicleId nullable, plate nullable, zone `underground|surface`, enteredAt, exitedAt nullable, status `open|payable|paid|overstay|closed|closed_unpaid|closed_free`, paidUntil nullable, amountDueKopecks, amountPaidKopecks, providerRef nullable, source `provider|info_timer`, lastSyncedAt, closedReason nullable) · `ParkingTariff` (id, version, activeFrom, config jsonb) with default config from the operator's Rules: `freeMinutes 30`, `firstHourKopecks 2000` (minutes 31–60), `nextHourKopecks 4000` (each started hour after the first), `nightWindow { from "00:00", to "05:00", hourKopecks 50000 }`, `lostTicketKopecks 50000`, `exitGraceMinutes 0` (exit must happen by the end of the paid hour), `undergroundHours "08:00-21:00"`, `surfaceHours "05:00-24:00"` · `ParkingPaymentLink` (sessionId, paymentId).

**[payments]** `Payment` (id, userId, purpose `parking|other`, amountKopecks, currency `UAH`, provider `mock|liqpay|mono|wayforpay|fondy|portmone`, providerRef nullable, status `created|pending|succeeded|failed|cancelled|expired|refunded|partially_refunded|fiscalized`, idempotencyKey unique, checkoutUrl nullable, fiscalReceiptUrl nullable, failureCode nullable, meta jsonb, createdAt, updatedAt) · `PaymentWebhookLog` (id, provider, externalId unique per provider, payload jsonb, receivedAt, processedAt, result).

**[notifications]** `Notification` (id, userId, kind, title, body, data jsonb, channel `inapp|push|both`, sentAt nullable, readAt nullable, createdAt) · `PushDelivery` (id, notificationId, deviceId, provider, status, error, attempts) · `NotificationPreference` (userId, kind, enabled).

**[admin]** `AuditLog` append-only (id, actorType `admin|system|user`, actorId, action, entityType, entityId, before jsonb, after jsonb, reason, ip, createdAt) · `ManualAdjustment` (id, accountId, amount, reason, requestedBy, approvedBy nullable, status `pending|approved|rejected|applied`, pointsTxId, thresholdPoints 500 above which a second approver is required) · `FeatureFlag` (key, enabled, payload jsonb, updatedAt) in base.

**[common/base]** `OutboxEvent` (id, aggregateType, aggregateId, type, payload jsonb, occurredAt, publishedAt nullable, attempts) · `IdempotencyKey` (key, scope, requestHash, status, response jsonb, createdAt, expiresAt; pk (scope, key)).

## 5. Database rules to add by hand to the init migration SQL

- Trigger `points_transactions_append_only`: `BEFORE UPDATE OR DELETE` raises unless the update only moves `state` forward (`pending → available|cancelled`, `available → spent|expired`) — implement as a trigger function that allows changing `state` and nothing else, and forbids DELETE.
- Trigger `audit_log_append_only`: forbid UPDATE/DELETE.
- `CHECK (amount <> 0)` on points transactions; `CHECK (total_kopecks > 0)` on receipts; `CHECK (amount_kopecks > 0)` on payments.
- Partial unique index on vouchers `code` where `status IN ('issued','active')`.
- Index set: receipts `(user_id, submitted_at desc)`, `(status, submitted_at)`, `(fn, issued_at)`; points `(account_id, created_at desc)`, `(state, expires_at)`; outbox `(published_at) WHERE published_at IS NULL`; sessions `(plate, status)`, `(user_id, entered_at desc)`.
- Balance consistency: `availableBalance` and `pendingBalance` on `LoyaltyAccount` are updated in the same transaction as the ledger row under `SELECT ... FOR UPDATE` on the account; a nightly job recomputes from the ledger and reports drift.

## 6. State machines (implement as pure functions in `domain/`, each with a table-driven unit test)

```
Receipt:  uploaded → parsed → auto_approved → credited
                          ↘ needs_moderation → approved → credited
                                             ↘ rejected(reason) → appealed → needs_moderation
Points:   pending → available → spent | expired ;  pending → cancelled ; reverse on refund may drive available negative, spending blocked while negative
Voucher:  issued → active(2-minute timer) → redeemed | expired(back to issued if activation lapsed and expiresAt not reached) | cancelled(points returned per rule)
Ticket:   active → used | cancelled | expired
Parking:  open(free 30 min) → payable → paid(exit by paidUntil) → closed
                            ↘ overstay → payable ; closed_unpaid (paymat) ; closed_free (air-raid alert, privilege)
Payment:  created → pending(3DS/wallet) → succeeded → fiscalized → refunded | partially_refunded ; ↘ failed | cancelled | expired
```

## 7. Critical pure logic (test heavily)

**Receipt QR parser** (`receipts/domain/qr-parser.ts`). Input: decoded QR text. Accepted: URL of the tax service `cabinet.tax.gov.ua/cashregs/check` (http or https, with or without `www`, any parameter order, URL-encoded or not, surrounding whitespace) with parameters `fn` (fiscal number of the cash register, digits), `id` (fiscal number of the receipt, digits or alphanumerics), `date` (`YYYYMMDD`), `time` (`HHMMSS` or `HHMM`), `sm` (total in UAH, `.` or `,` decimal, optional thousands separator), `mac` (optional, offline receipts), unknown parameters ignored. Output `{ fn, fiscalId, issuedAt: Date (Kyiv local → UTC), totalKopecks, mac?, raw }` or a typed `QrParseError` with codes `NOT_A_TAX_URL | MISSING_PARAM | BAD_DATE | BAD_SUM`. Never throw anything else. At least 15 unit cases including comma decimals, `HHMM` time, encoded URL, garbage, zero sum, 1-kopeck rounding.

**Risk and auto-approval rules** (`receipts/domain/rules.ts`), pure, inputs are plain objects: `needs_moderation` if `fn` is not an active whitelisted fiscal number, or `total > autoApproveThreshold`, or the user already has `dailyReceiptLimit` receipts today (Kyiv day), or more than 3 receipts from the same `fn` by the same user within 10 minutes, or `source = manual`; reject with `PC_RECEIPT_TOO_OLD` when `issuedAt` is older than `uploadWindowDays`, `PC_RECEIPT_FUTURE` when it is more than 10 minutes in the future, `PC_RECEIPT_DUPLICATE` on `(fn, fiscalId)` collision (service level), `PC_RECEIPT_EXCLUDED_TENANT` when the tenant is excluded. Flags (do not block): `fast_submit` (< 2 min after issue), `fn_unknown`, `high_total`, `device_shared` (same device used by another user within 24 h). Points = `floor(totalKopecks / 100 * ratePercent / 100)` using the tenant override when present, capped at `maxPointsPerReceipt`; state `pending` with `availableAt = now + holdDays` when `total > holdThreshold`, otherwise `available`; `expiresAt = availableAt + pointsTtlMonths`.

**Parking tariff calculator** (`parking/domain/tariff.ts`): `quote(enteredAt, now, tariff, paidUntil?)` → `{ amountDueKopecks, freeUntil, currentHourEndsAt, breakdown: [{ from, to, kind: free|first_hour|hour|night, amountKopecks }] }`. Rules: first 30 minutes free; minutes 31–60 cost `firstHourKopecks`; every further started hour costs `nextHourKopecks`; any started hour whose start falls inside 00:00–05:00 Kyiv time costs `nightHourKopecks` instead; a paid session is valid until the end of the paid hour (`paidUntil`), after which overstay starts a new hour. Table-driven tests: 10 min, 30 min, 31 min, 59 min, 60 min, 61 min, 2 h 05, overnight 23:30→01:10, paid then overstay, DST boundary day (last Sunday of March).

**Points ledger** (`club/services/ledger.service.ts`): `credit`, `hold`, `release`, `spend` (FIFO by `expiresAt`, rejects when available < amount or account negative or newcomer lock active for spending), `expire(asOf)`, `reverse(txId, reason)`; all in `withTx` with `FOR UPDATE`; idempotent by key. Tests with a fake repository for the pure parts and an integration test against PostgreSQL when `DATABASE_URL` is set.

**Voucher activation** (`rewards/domain/activation.ts`): activation issues a 6-character code from an unambiguous alphabet (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`) unique among non-final vouchers and a signed token `base64url(voucherId.exp.hmac)` valid 120 seconds; redeem is atomic (`UPDATE ... WHERE status = 'active' AND activation_expires_at > now()`); re-activation allowed while `expiresAt` not reached.

## 8. API surface v1 (prefix `/api/v1`, JSON; annotate everything for Swagger; member endpoints need `MemberGuard` unless marked public)

- **auth** `POST /auth/otp/request {phone}` (public, 3 per phone per 10 min, 10 per IP per hour) · `POST /auth/otp/verify {phone, code, device{platform, model, appVersion, fingerprint}}` → `{accessToken, refreshToken, isNewUser, user}` · `POST /auth/refresh` · `POST /auth/logout` · `GET /me` · `PATCH /me` (name, birthDate, email) · `POST /me/consents` · `POST /me/devices` (push token) · `DELETE /me` (deletion request) · `GET /me/export` (JSON of personal data).
- **club** `GET /club/account` → balance, pending, memberCode, QR payload (`PC1:<memberCode>:<hmac8>`), newcomerLockUntil, expiring soon · `GET /club/transactions` · `GET /club/rules` (public parts).
- **receipts** `POST /receipts/qr {qrText}` (Idempotency-Key) → receipt with status and awarded points · `POST /receipts/manual {fn, fiscalId, issuedAt, totalKopecks, photoKey}` · `POST /receipts/photo-upload-url {contentType, sizeBytes}` → presigned PUT · `GET /receipts` · `GET /receipts/:id` · `POST /receipts/:id/appeal {message, photoKey?}`.
- **rewards** `GET /rewards` (+ `affordable=true` filter) · `GET /rewards/:id` · `POST /rewards/:id/redeem` (Idempotency-Key) → voucher · `GET /vouchers?status=` · `GET /vouchers/:id` · `POST /vouchers/:id/activate` → `{code, token, activationExpiresAt}` · `POST /vouchers/:id/cancel`.
- **validator** (ValidatorDevice auth: `X-Validator-Key` + PIN once per shift) `POST /validator/redeem {code | token}` → voucher summary · `GET /validator/log`.
- **promos / events** `GET /promos` · `GET /promos/:id` · `POST /promos/:id/claim` → coupon voucher · `GET /events` · `GET /events/:id` · `POST /events/:id/register {adults, children}` → ticket voucher · `DELETE /events/:id/register`.
- **parking** `GET /parking/vehicles` · `POST /parking/vehicles {plate}` · `DELETE /parking/vehicles/:id` · `POST /parking/vehicles/:id/verify {talonCode | paymatCode}` · `GET /parking/session` (current session for the user's vehicles via provider; for unverified plates only `{amountDueKopecks, paidUntil}` with 10 requests per hour) · `POST /parking/session/:id/pay` (Idempotency-Key) → Payment with checkoutUrl · `POST /parking/session/:id/left` (user says "I already left") · `GET /parking/tariff` (public) · `POST /parking/quote {enteredAt, now?}` (public) · info mode: `POST /parking/info/sessions {zone, enteredAt}` · `POST /parking/info/sessions/:id/paid-at-paymat {paidUntil}` · `POST /parking/info/sessions/:id/exit` · `GET /parking/history` · `POST /webhooks/parking/:provider` (provider-signed; emulator in dev).
- **payments** `GET /payments/:id` · `POST /webhooks/payments/:provider` (signature check per provider adapter; mock adapter in dev; idempotent by external id).
- **notifications** `GET /notifications` · `POST /notifications/:id/read` · `POST /notifications/read-all` · `GET/PUT /notifications/preferences`.
- **content** `GET /tenants?participates=&category=&q=` (public) · `GET /tenants/:slug` (public) · `GET /mall/info` (public: hours, address, parking hours, support contacts from config).
- **admin** (`AdminGuard` + roles) `POST /admin/auth/login` · `POST /admin/auth/totp` · `GET /admin/receipts?status=` · `POST /admin/receipts/:id/approve|reject {reason}` · `GET /admin/users?q=` · `GET /admin/users/:id` · `POST /admin/adjustments` · `POST /admin/adjustments/:id/approve` · CRUD for tenants, fiscal numbers, tenant rules, rewards, promos, coupon templates, events, rule sets, feature flags, validator devices · `GET /admin/audit?entityType=&entityId=` · `GET /admin/reports/daily` (counts: receipts by status, points earned/spent, active vouchers, parking sessions).
- **ops** `GET /health` · `GET /ready` · `GET /docs` (dev only unless `DOCS_ENABLED=true`).

## 9. Worker queues (BullMQ, `src/worker.ts`)

`outbox-dispatch` (every 5 s: unpublished events → queue per type, mark published) · `receipts-process` (parse → rules → credit, retries 3 with backoff) · `points-release-holds` (hourly) · `points-expire` (daily 03:30 Kyiv, FIFO buckets, plus reminders at 30 and 7 days) · `vouchers-expire` (every minute) · `notifications-push` (consume `notification.created`, send via PushPort, record delivery) · `parking-sync` (every 60 s via provider port; emulator in dev) · `payments-reconcile` (hourly: pending payments older than 20 min → query provider / expire) · `reports-nightly` (aggregates into `daily_stats` table owned by admin) · `account-deletion` (daily: execute requests past `executeAfter`: anonymise user, keep ledger with anonymised owner).
Every processor's handler logic is a plain function with a unit test; the processor class only wires it.

## 10. Docker and CI

- `Dockerfile`: multi-stage (`deps` → `build` with `prisma generate` → `runner` on `node:24-alpine`, non-root user, `HEALTHCHECK`), entrypoint script runs `npx prisma migrate deploy` then `node dist/main.js`; worker uses the same image with `node dist/worker.js`.
- `docker-compose.yml`: `postgres:17-alpine` (volume, healthcheck), `redis:7-alpine`, `api` (ports 3000), `worker`, profile `tools`: `adminer`, `metabase`. `.env.example` documents every variable in Ukrainian with safe dev defaults.
- `../.github/workflows/backend.yml`: on push and pull_request → `actions/setup-node@v4` (24, npm cache) → `npm ci` → `npm run lint` → `npm run typecheck` → `npx prisma validate` → `npm run test:unit` → job `integration` with services `postgres:17` and `redis:7`, env `DATABASE_URL`, `REDIS_URL`: `npx prisma migrate deploy`, `npm run db:seed`, `npm run test:int`, `npm run test:e2e` → `npm run build` → `docker build` (no push) → upload `docs/openapi.json` as an artifact.
- npm scripts: `start:dev`, `start:worker:dev`, `build`, `start`, `start:worker`, `lint`, `lint:fix`, `format`, `typecheck` (`tsc --noEmit -p tsconfig.json`), `test`, `test:unit`, `test:int`, `test:e2e`, `test:cov`, `db:generate`, `db:migrate` (dev), `db:deploy`, `db:seed`, `db:reset`, `openapi`.

## 11. Seed (`prisma/seed.ts`, idempotent upserts)

Tenants from the prototype: INTERTOP (fashion, floor 1), Aroma Kava (coffee), Coffee & Gelato, Premier City (cinema, floor 3), Strike City (bowling), Generator City (entertainment), Figli Migli (kids, floor 3), ТамТам (hypermarket, `excludedFromProgram = true`), plus 6 more plausible categories (sport, electronics, beauty, pharmacy, home, food court). Fiscal numbers: 2 fake `fn` per participating tenant (10 digits), status `active`. Rewards from the prototype: «Година паркінгу» 40 points (kind parking_hour), «Кава з собою» 60 (Aroma Kava), «Попкорн у Premier City» 80, «15 хвилин у Figli Migli» 50, «Подарункова карта 200 ₴» 200 (certificate), «Квиток у кіно» 450. Promos: «−20 % INTERTOP до 15.11», «1+1 Aroma Kava», one event «Майстер-клас для дітей, субота 15:00» capacity 30. Rule set v1 with defaults from section 4. Tariff v1 from section 4. Demo member `+380501234567` (name Олег, memberCode 734211800-style 9 digits → use `734211800`), vehicle `AC1234BC` verified, account with 320 available points and a history of 6 transactions, 3 receipts (credited, needs_moderation, rejected). Admin user `admin@portcity.local` with password from `SEED_ADMIN_PASSWORD` (default `ChangeMe-2026!`, printed as a warning). Parking emulator scenario reproducing the prototype timeline (entered 14:12, free until 14:42, 60 ₴ due at 15:20, paid until 16:00, closed 15:52 variant) selectable by `PARKING_EMULATOR_SCENARIO`.

## 12. Definition of done

Foundation: skeleton boots in test mode without DB (`npm run typecheck`, `npm run lint`, `npm run test:unit` green; `npm run build` produces `dist/main.js` and `dist/worker.js`).
Schema: `npx prisma validate` green, `prisma generate` done, init migration SQL present with section 5 additions, `prisma/seed.ts` compiles.
Each module: README (Ukrainian) with model, state machine, endpoints, jobs, open questions; unit tests for all `domain/` code; controllers with DTOs and Swagger decorators; guards applied; no `any` except in typed escape hatches with a comment; `npx tsc --noEmit` passes for the whole tree with your files in; `npx jest src/modules/<name>` green; `npx prisma validate` green.
Integration: whole tree typechecks, lints, unit tests green, `npm run build` green, `npm run openapi` writes `docs/openapi.json`, e2e smoke with the in-memory fakes where possible, `docs/ARCHITECTURE.md`, `docs/API.md` (generated summary of endpoints), `docs/RUNBOOK.md` (how to run with Docker, how to run without, how to seed, how to rotate secrets, how to add a tenant fiscal number), `README.md` at the root in Ukrainian with a 10-line quick start.
