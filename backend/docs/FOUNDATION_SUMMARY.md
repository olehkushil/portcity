# Foundation summary for module builders

> Status 2026-11-01: the module phase is over and the integration pass is done. This document is kept as
> the builders' guide; the current state (final module graph: content also imports club, notifications
> imports promos; all ports real; contracts no longer frozen; audit-only outbox events; AdminGuard admin
> activity check) is described in `docs/ARCHITECTURE.md` and `docs/INTEGRATION_NOTES.md`.

English, binding for the module phase. Product requirements stay in `docs/BRIEF.md`; this
document tells you how to build your module on the foundation without stepping on the nine
other builders. Architecture background: `docs/ARCHITECTURE.md` (Ukrainian).

## 1. Environment and exact commands

Repository root: `C:/Agent/ПортСіті/backend`. Node 24 is portable, so every shell starts with:

```bash
cd "C:/Agent/ПортСіті/backend" && export PATH="/c/Users/OLEHKU~1/AppData/Local/Temp/claude/C--Users-Oleh-Kushil--claude-spares-spare-zrJAoB/8b670004-2453-4b71-b528-e3f6da5b2138/scratchpad/tools/node/node-v24.22.2-win-x64:$PATH"
```

| Command                                                              | What it does                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `node -v`                                                            | must print `v24.22.2`                                                                        |
| `npm run typecheck`                                                  | `tsc --noEmit` over `src`, `test`, `prisma` (whole tree, must stay green)                    |
| `npm run lint` / `npm run lint:fix`                                  | ESLint 9 + typescript-eslint type-checked + Prettier (formatting errors are lint errors)     |
| `npx prettier --write "src/modules/<name>/**/*.ts"`                  | format your files before linting                                                             |
| `npm run test:unit`                                                  | all `src/**/*.spec.ts` (no DB, no Redis)                                                     |
| `npx jest src/modules/<name>`                                        | only your module's specs (`.npmrc` passes the required `--experimental-vm-modules`)          |
| `npm run test:e2e`                                                   | `test/**/*.e2e-spec.ts` against the full AppModule with in-memory queues/storage, no DB      |
| `npm run test:int`                                                   | `**/*.int-spec.ts`; self-skips without `DATABASE_URL` (CI runs them with PostgreSQL + Redis) |
| `npm run build`                                                      | `nest build` -> `dist/main.js`, `dist/worker.js`, `dist/scripts/openapi.js`                  |
| `npm run openapi`                                                    | build + write `docs/openapi.json` without DB/Redis (gitignored, CI artifact)                 |
| `DATABASE_URL=postgresql://x:x@localhost:5432/x npx prisma validate` | schema check (the CLI needs the variable set to anything)                                    |
| `npx prisma generate`                                                | regenerate `@prisma/client` types (already done; harmless to repeat)                         |

Local machine has no Docker, PostgreSQL or Redis: integration tests, migrations, the seed, the
worker against Redis and the Docker build run in CI only (`../.github/workflows/backend.yml`).

Never: `npm install` (file `docs/deps-requests/<module>.md`), `git commit`, system-wide
installs, emoji in files, `any` outside a commented escape hatch.

## 2. Folder ownership

| Path                                                                                         | Owner during the module phase                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/<name>/**`                                                                      | the `<name>` builder, fully: `<name>.module.ts` (replace the stub, keep the class name), `controllers/`, `services/`, `dto/`, `domain/`, `jobs/`, `index.ts`, `README.md` (Ukrainian)                              |
| `src/common/**`                                                                              | foundation/integration; read-only for builders (request changes in your `docs/INTEGRATION_NOTES.md` section)                                                                                                       |
| `src/common/contracts/*.ts`                                                                  | frozen; additions via `docs/contract-requests/<consumer>-to-<owner>-<n>.md`                                                                                                                                        |
| `src/app.module.ts`                                                                          | foundation; it already imports all ten modules, do not edit                                                                                                                                                        |
| `prisma/**`                                                                                  | schema/integration agents; builders do not edit schema files or migrations, they file `docs/schema-requests/<module>-<n>.md` and code against the current schema (own `jsonb`/`meta` columns are the escape hatch) |
| `test/utils/**`, `test/jest*.js`, `test/setup-*.js`                                          | foundation; builders add new files only: `test/e2e/<name>*.e2e-spec.ts`, `test/int/<name>/*.int-spec.ts`                                                                                                           |
| `package.json`, lockfile, `tsconfig*`, `eslint.config.mjs`, `.env.example`, `Dockerfile`, CI | foundation/integration only; document new env variables in your module README, the integration agent merges them                                                                                                   |
| `docs/INTEGRATION_NOTES.md`                                                                  | append inside your module's heading only                                                                                                                                                                           |
| `docs/deps-requests/`, `docs/schema-requests/`, `docs/contract-requests/`                    | builders create request files (see the README in each folder)                                                                                                                                                      |

Module layout (brief section 2): `domain/` holds pure logic with no Nest or Prisma imports
(state machines, calculators, parsers) and table-driven unit tests; `services/` holds Prisma
access and orchestration; `jobs/` holds BullMQ processors whose logic is a plain function.

## 3. Prisma types and database access

- Types come from `@prisma/client` (generated by `npx prisma generate`, done in CI after `npm ci`):
  `import { Prisma, PointsTxState, type Receipt } from '@prisma/client';`. Enums are runtime
  objects (`PointsTxState.pending === 'pending'`) and types at the same time.
- Access the database through the global `PrismaService` (`src/common/prisma`): inject it, use
  `prisma.<model>`; interactive transactions with `prisma.withTx(async (tx) => ...)`, join a
  caller's transaction with `prisma.runInTx(tx, fn)`. Repository methods accept `DbClient`
  (`PrismaClient | Tx`) so they work inside and outside transactions.
- Ids are UUID v7 generated in code: `import { uuidv7 } from 'uuidv7'` and pass `id: uuidv7()`
  in every `create` (the schema has no id defaults). Time comes from `Clock` (`clock.now()`),
  never `new Date()`, so tests can use `FakeClock`.
- JSON columns: cast plain objects with `as Prisma.InputJsonObject`; `toJsonValue()` from
  `src/common/idempotency` normalises arbitrary values; use `Prisma.JsonNull`/`Prisma.DbNull`
  for nulls.
- Prisma errors: `isUniqueViolation`, `isRecordNotFound`, `isForeignKeyViolation` from
  `src/common/prisma`.
- Row locks: `` tx.$queryRaw`SELECT ... FROM loyalty_accounts WHERE id = ${id}::uuid FOR UPDATE` ``
  (table and column names are snake_case via `@map`).
- Hand-written SQL in the init migration that Prisma does not know about: `points_transactions`
  is append-only (UPDATE may only move `state` forward: pending -> available|cancelled,
  available -> spent|expired; no DELETE), `audit_logs` is append-only, CHECKs `amount <> 0`
  (points), `total_kopecks > 0` (receipts), `amount_kopecks > 0` (payments), partial unique
  `vouchers_code_live_key` on `vouchers.code WHERE status IN ('issued','active')` (so `upsert`
  cannot target `code`; redeem with `UPDATE ... WHERE status = 'active' AND activation_expires_at > now()`),
  partial unique `vehicles_user_id_plate_live_key WHERE deleted_at IS NULL`.
- Naming differences from the brief: `PointsTransaction.createdById`, `LoyaltyRuleSet.createdById`,
  `ParkingTariff.createdById`, `TenantFiscalNumber.confirmedById`; `AuditLog`, `FeatureFlag`,
  `OutboxEvent`, `IdempotencyKey` live in `base.prisma` and are accessed only through the common layer
  (audit, feature flags, outbox, idempotency) except admin's feature flag CRUD.
- A module touches only its own tables. Read other modules' data through their port; never write.

## 4. Ports: consume, provide, test

Every module exposes one port (admin: none, it consumes). Tokens and interfaces live in
`src/common/contracts/<module>.ts`. Until a module is built, its stub module provides the token
with an object whose methods throw `501 PC_COMMON_NOT_IMPLEMENTED`, so the whole AppModule boots
at all times.

Consume (receipts needs the ledger):

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../../common/contracts/club';

@Injectable()
export class ReceiptCreditService {
  constructor(@Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort) {}
}
```

and import the owner module: `imports: [ClubModule]` from `'../club/club.module'`. Interfaces
must be imported with `import type` (isolatedModules + decorator metadata).

Provide (club implements the ledger):

```ts
@Module({
  imports: [IdentityModule, QueueModule.registerQueue(QUEUES.pointsExpire, QUEUES.clubEvents)],
  controllers: [ClubController, AdminRuleSetsController],
  providers: [
    LedgerService,
    RulesService,
    { provide: CLUB_LEDGER_PORT, useExisting: LedgerService },
  ],
  exports: [CLUB_LEDGER_PORT, LedgerService],
})
export class ClubModule {}
```

with `export class LedgerService implements ClubLedgerPort`. Keep the token in `exports`.

Dependency graph (who may import whom; it is acyclic, keep it that way):

| Module        | Imports (ports it uses) | Used by                          |
| ------------- | ----------------------- | -------------------------------- |
| identity      | -                       | club, notifications, admin       |
| content       | -                       | receipts, rewards, promos, admin |
| payments      | -                       | parking, admin                   |
| club          | identity                | receipts, rewards, admin         |
| notifications | identity                | admin                            |
| receipts      | content, club           | admin                            |
| parking       | payments                | rewards, notifications, admin    |
| rewards       | club, content, parking  | promos, admin                    |
| promos        | rewards, content        | admin, notifications             |
| admin         | everything above        | -                                |

Rules: never import a module that (transitively) imports you; anything else crosses modules
through outbox events (section 5). Available everywhere without imports (global): `PrismaService`,
`Clock`, `APP_CONFIG`, `REDIS_CLIENT`, `OutboxService`, `OutboxRouter`, `QueueRegistry`,
`WorkerSchedules`, `StoragePort`, `TokenService`, `IdempotencyService`, `AuditService`
(`ADMIN_AUDIT_PORT`), `FeatureFlagsService` (`FEATURE_FLAGS_PORT`).

Transactions across ports: pass your open `tx` as the last argument
(`await this.ledger.credit(input, tx)`), so the ledger row and your row commit together.

Testing a consumer: unit tests instantiate services directly with a fake implementing the
interface (`const ledger: ClubLedgerPort = { credit: jest.fn(), ... }`); e2e tests override the
token: `createTestApp({ configure: (b) => b.overrideProvider(CLUB_LEDGER_PORT).useValue(fake) })`.

Audit everything an admin does: `await this.audit.audit({ actor: { type: 'admin', id: user.id }, action: 'tenant.update', entityType: 'tenant', entityId, before, after, reason, ip }, tx)`
with `@Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort`.

## 5. Outbox events

Publish inside the transaction that changes your aggregate; names and payload types come from
`src/common/contracts/events.ts`:

```ts
import { OUTBOX_AGGREGATES, RECEIPT_EVENTS, buildOutboxEvent } from '../../../common/contracts/events';

await this.prisma.withTx(async (tx) => {
  const receipt = await tx.receipt.update({ ... });
  await this.outbox.publish(
    tx,
    buildOutboxEvent(RECEIPT_EVENTS.credited, OUTBOX_AGGREGATES.receipt, receipt.id, {
      receiptId: receipt.id, userId: receipt.userId, tenantId: receipt.tenantId,
      totalKopecks: receipt.totalKopecks, pointsAwarded, pointsTxId, pointsState: 'available',
      availableAt: null, firstReceipt,
    }),
  );
});
```

Consume: register routes in your module's `onModuleInit` and host a processor on your
`<module>-events` queue (`QUEUES.clubEvents`, `rewardsEvents`, `promosEvents`, `parkingEvents`,
`notificationsEvents`):

```ts
export class ClubModule implements OnModuleInit {
  constructor(
    private readonly router: OutboxRouter,
    private readonly schedules: WorkerSchedules,
  ) {}
  onModuleInit(): void {
    this.router.addRoutes({
      [IDENTITY_EVENTS.registered]: QUEUES.clubEvents,
      [IDENTITY_EVENTS.profileCompleted]: QUEUES.clubEvents,
      [RECEIPT_EVENTS.credited]: QUEUES.clubEvents,
    });
  }
}

@Processor(QUEUES.clubEvents, { concurrency: 4 })
export class ClubEventsProcessor extends WorkerHost {
  async process(job: Job<OutboxJobData>): Promise<void> {
    switch (job.name) {
      case IDENTITY_EVENTS.registered:
        return handleUserRegistered(job.data as TypedOutboxEvent<'user.registered'>, this.deps);
      // ...
    }
  }
}
```

Facts: the worker's dispatcher runs every `OUTBOX_DISPATCH_EVERY_MS` (5 s), locks rows with
`FOR UPDATE SKIP LOCKED`, adds one job per target queue with `jobId = outbox-<eventId>` and
`name = event type`, then sets `publishedAt`. Consumers must be idempotent by `eventId`
(ledger `idempotencyKey`, notification `dedupeKey`, voucher `(sourceType, sourceId)`). Events
with no route are retried for about 5 minutes and then dropped with an error log, so register
routes for every event you consume. Patterns `receipt.*` and `parking.**` are allowed. With
`QUEUE_DRIVER=memory` (tests, openapi) nothing is dispatched: unit-test your handler function
directly and assert published rows through Prisma in integration tests.

## 6. BullMQ processors and schedules

1. Own your queue: `imports: [QueueModule.registerQueue(QUEUES.receiptsProcess)]` (names only
   from `QUEUES`; never call `BullModule.registerQueue` directly or the memory driver is lost).
2. Produce: `@InjectQueue(QUEUES.receiptsProcess) private readonly queue: Queue` then
   `queue.add('process', { receiptId }, { jobId: `receipt-${receiptId}` })`; in tests inspect
   `testApp.queues.getInMemory(QUEUES.receiptsProcess).jobs`.
3. Handler logic is a plain exported function with its own unit test; the processor only wires:

```ts
@Processor(QUEUES.receiptsProcess, { concurrency: 2 })
export class ReceiptsProcessProcessor extends WorkerHost {
  constructor(private readonly pipeline: ReceiptPipelineService) {
    super();
  }
  async process(job: Job<{ receiptId: string }>): Promise<ReceiptSubmissionOutcome> {
    return this.pipeline.process(job.data.receiptId);
  }
}
```

4. Schedules: in `onModuleInit`, `this.schedules.register({ id: 'points-expire-daily', queue: QUEUES.pointsExpire, jobName: 'expire', pattern: '30 3 * * *' })`
   (cron in Europe/Kyiv) or `{ every: 60_000 }` (>= 1000 ms); ids are stable strings.
5. Defaults: 3 attempts, exponential backoff 2 s, completed jobs kept 1000/24 h, failed 5000/7 d;
   override per job through `opts`. Processors run only in the worker
   (`npm run build && npm run start:worker`, needs Redis); the API never processes jobs.
6. Register the processor class in `providers`; the worker calls `BullRegistrar.register()`.

Queue ownership (brief section 9): receipts `receipts-process`; club `points-release-holds`
(hourly), `points-expire` (daily 03:30 Kyiv); rewards `vouchers-expire` (every minute);
notifications `notifications-push`; parking `parking-sync` (every 60 s); payments
`payments-reconcile` (hourly); admin `reports-nightly`; identity `account-deletion` (daily);
plus the `<module>-events` consumer queues above.

## 7. Testing conventions

- Unit: `*.spec.ts` next to the code, run with `npx jest src/modules/<name>`. `domain/` code gets
  table-driven tests (state machines, parser, tariff, rules). Services are tested by direct
  instantiation with fakes (`new LedgerService(fakePrisma as unknown as PrismaService, new FakeClock())`);
  Nest DI is not needed for unit tests. `TZ=UTC` is forced, Kyiv logic goes through `src/common/time`.
- Integration: `test/int/<name>/*.int-spec.ts` (or next to the code) wrapped in
  `describeWithDb('...', () => ...)` from `test/utils`; `resetDatabase(prisma)` truncates all
  tables, so seed what each test needs. CI runs `prisma migrate deploy` and `npm run db:seed` first.
- E2E: `test/e2e/<name>.e2e-spec.ts` with `createTestApp()` and supertest
  (`request(testApp.server).post('/api/v1/receipts/qr').set('Authorization', `Bearer ${testApp.memberToken('user-1', 'device-1')}`).set('Idempotency-Key', 'k-1')`).
  Without `DATABASE_URL` you can verify routing, validation, auth and port overrides; flows that hit
  Prisma need the database (wrap them in `describeWithDb` or fake the service). `testApp.clock`
  is a `FakeClock`, `testApp.storage` is in-memory, `testApp.queues` is the registry.
- Lint rules worth knowing: no `any`, no floating promises, unused variables prefixed `_`,
  `@typescript-eslint/no-unsafe-*` relaxed in spec files, `console` only in scripts and the seed.
- Definition of done per module (brief section 12): README, unit tests for all `domain/` code,
  DTOs with Swagger decorators, guards applied, whole-tree `npm run typecheck` and `npm run lint`
  green, `npx jest src/modules/<name>` green.

## 8. Environment variables

All variables are validated once at boot by `src/common/config/env.schema.ts` and injected as
`APP_CONFIG` (`@Inject(APP_CONFIG) private readonly config: AppConfig`). Documented in
Ukrainian in `.env.example`.

| Variable                                                                                                 | Default / notes                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`, `APP_MODE`, `PORT`, `WORKER_PORT`, `HOST`                                                    | development, api (worker sets worker), 3000, 3001, 0.0.0.0                                                   |
| `TRUST_PROXY`, `LOG_LEVEL`, `LOG_PRETTY`, `DOCS_ENABLED`, `CORS_ORIGINS`                                 | false, info, dev only, non-production, localhost list                                                        |
| `DATABASE_URL`, `PRISMA_LAZY_CONNECT`, `PRISMA_LOG_QUERIES`                                              | required unless lazy; tests set lazy                                                                         |
| `REDIS_URL`, `QUEUE_DRIVER`, `BULL_PREFIX`, `OUTBOX_BATCH_SIZE`, `OUTBOX_DISPATCH_EVERY_MS`              | redis://localhost:6379, redis (memory in tests), portcity, 100, 5000                                         |
| `JWT_SECRET`, `JWT_ISSUER`, `JWT_ACCESS_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`                           | dev secret (rejected in production), portcity, 900, 60                                                       |
| `OTP_PEPPER`, `VOUCHER_PEPPER`, `MEMBER_QR_SECRET`                                                       | HMAC peppers for OTP codes, voucher tokens, club QR                                                          |
| `THROTTLE_TTL_SECONDS`, `THROTTLE_LIMIT`, `IDEMPOTENCY_TTL_HOURS`                                        | 60, 60 (100000 in tests), 24                                                                                 |
| `STORAGE_DRIVER`, `S3_*`                                                                                 | memory (s3 required in production); endpoint, region, bucket, keys, path style, presign TTL, public base URL |
| `MALL_NAME`, `MALL_ADDRESS`, `MALL_HOURS`, `SUPPORT_PHONE`, `SUPPORT_EMAIL`                              | content's `GET /mall/info`                                                                                   |
| `PARKING_PROVIDER`, `PARKING_EMULATOR_SCENARIO`                                                          | emulator; `free`, `payable` (default), `paid`, `closed` (same values as the seed)                            |
| `PAYMENTS_PROVIDER`, `PUSH_PROVIDER`                                                                     | mock, stub                                                                                                   |
| `SEED_ADMIN_PASSWORD` (+ seed-only `SEED_VALIDATOR_KEY`, `SEED_VALIDATOR_PIN`, `SEED_ADMIN_TOTP_SECRET`) | ChangeMe-2026!, dev-validator-aroma-kava, 246813 (development only; production requires own values)          |

Module-specific variables: do not edit the shared schema; validate your own slice with
`envSectionProvider(PARKING_CONFIG, z.object({...}), 'parking')` (`src/common/config/env-section.ts`)
and list the variables in your module README.

## 9. Contracts

| File (`src/common/contracts/`) | Token(s) / interface                                                                                     | One line                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared.ts`                    | `Tx`, `Uuid`, `IsoDateTime`, `Kopecks`, `Points`, `ActorRef`, `SYSTEM_ACTOR`, `DateRange`, `PageOf`      | primitives used by every contract                                                                                                                                                         |
| `identity.ts`                  | `IDENTITY_PORT` / `IdentityPort`                                                                         | `getUser`, `getUsers`, `getDevice`, `resolveMemberCode`, `listPushDevices`, `hasConsent`; `UserSummary`, `DeviceSummary`, member code rules                                               |
| `club.ts`                      | `CLUB_LEDGER_PORT` / `ClubLedgerPort`                                                                    | `getBalance`, `getEntry`, `getActiveRules`, `credit`, `hold`, `release`, `spend`, `reverse`, `getDailyStats`; `LoyaltyRules` + `DEFAULT_LOYALTY_RULES`, `LedgerEntry`, `MEMBER_QR_PREFIX` |
| `content.ts`                   | `CONTENT_PORT` / `ContentPort`                                                                           | `getTenant(s)`, `findTenantByFiscalNumber`, `isExcluded`, `getTenantRule`, `recordSeenFiscalNumber`; `TenantSummary`, `TENANT_CATEGORIES`                                                 |
| `receipts.ts`                  | `RECEIPTS_PORT` / `ReceiptsPort`                                                                         | `getReceipt`, `countForUser`, `getDailyStats`; `ReceiptSummary`, `ReceiptSubmissionResult`, `RISK_FLAGS`, tax QR host                                                                     |
| `rewards.ts`                   | `VOUCHER_ISSUER_PORT` / `VoucherIssuerPort`                                                              | `issue`, `cancel`, `getVoucher`, `listBySource`, `getDailyStats`; `VoucherSummary`, activation constants                                                                                  |
| `promos.ts`                    | `PROMOS_PORT` / `PromosPort`                                                                             | `getPromo`, `getEvent`, `validateClaim`; `PromoSummary`, `EventSummary`, `ClaimValidation`                                                                                                |
| `parking.ts`                   | `PARKING_PORT` / `ParkingPort`                                                                           | `getSessionForUser`, `getSession`, `quote`, `getActiveTariff`, `getDailyStats`; `ParkingTariffConfig` + `DEFAULT_PARKING_TARIFF`, `ParkingQuote`                                          |
| `payments.ts`                  | `PAYMENTS_PORT` / `PaymentsPort`                                                                         | `createPayment`, `getPayment`, `getPaymentByIdempotencyKey`; `PaymentSummary`, `CreatePaymentInput`                                                                                       |
| `notifications.ts`             | `NOTIFICATIONS_PORT` / `NotificationsPort`                                                               | `notify`, `countUnread`; `NOTIFICATION_KINDS` registry, `NotifyInput`                                                                                                                     |
| `admin.ts`                     | `ADMIN_AUDIT_PORT` / `AdminAuditPort`, `FEATURE_FLAGS_PORT` / `FeatureFlagsPort`                         | `audit(entry, tx?)`; `isEnabled`, `get`; `FEATURE_FLAG_KEYS`, `FOUR_EYES_THRESHOLD_POINTS` (implemented in `src/common`)                                                                  |
| `events.ts`                    | `*_EVENTS` constants, `OutboxEventPayloads`, `buildOutboxEvent`, `TypedOutboxEvent`, `OUTBOX_AGGREGATES` | the outbox catalogue (section 5)                                                                                                                                                          |
| `port-stub.ts`                 | `unimplementedPort()`                                                                                    | 501 placeholder used by stub modules                                                                                                                                                      |

Each contract also reserves the module's error code names (`*_ERROR_CODES`); register them with
`defineErrorCodes({ PC_RECEIPT_TOO_OLD: { status: 422, title: '...' } })` in `domain/errors.ts`
and throw `new DomainError(ReceiptErrors.PC_RECEIPT_TOO_OLD, 'detail', { details })`.

## 10. HTTP conventions and who hosts which endpoint

- Controllers: `@ApiTags('receipts') @Controller('receipts')` (prefix `/api/v1` is global);
  `@Auth('member')` for members, `@Auth('admin', 'moderator', 'manager')` for back-office,
  `@Public()` to opt out, `@CurrentUser('id') userId: string` for the principal (`deviceId` is on
  the member token), `@Idempotent()` on every mutation with a financial or points effect,
  `@ApiProblemResponses(400, 404, 409, 422)` for documented errors, `@Throttle({ default: { limit: 3, ttl: 600_000 } })`
  for stricter limits, `CursorQueryDto` + `toPage(rows, limit, cursorOf)` for lists.
- Responses are plain DTO classes with `@ApiProperty`; errors are thrown as `DomainError` and
  rendered as `application/problem+json` by the global filter.
- Validator devices (rewards): a module-level guard reads `X-Validator-Key` (`VALIDATOR_KEY_HEADER`),
  compares `sha256Hex(key)` with `ValidatorDevice.deviceKeyHash`, checks the shift PIN with
  `verifyPassword`, and documents routes with `@ApiSecurity(VALIDATOR_KEY_SECURITY)`.
- Webhooks: `@Public()`, signature verification in the provider adapter, idempotent by external id.
- Passwords and PINs: `hashPassword`/`verifyPassword` (`src/common/auth`) produce and accept PHC
  strings `$scrypt$ln=..,r=..,p=..$<salt>$<hash>`, the format the seed writes.

Admin endpoints are hosted by the module that owns the tables (all under `/admin/...`, guarded
by `@Auth('admin', ...roles)`, audited through `ADMIN_AUDIT_PORT`):

| Endpoint group                                                                       | Hosting module |
| ------------------------------------------------------------------------------------ | -------------- |
| `/admin/auth/login`, `/admin/auth/totp`, `/admin/users`, admin user CRUD             | identity       |
| `/admin/receipts`, approve/reject, appeals                                           | receipts       |
| `/admin/tenants`, fiscal numbers, tenant rules                                       | content        |
| `/admin/rewards`, validator devices                                                  | rewards        |
| `/admin/promos`, coupon templates, events                                            | promos         |
| `/admin/rule-sets`, `/admin/club/accounts/:userId`                                   | club           |
| `/admin/parking/tariffs`, sessions                                                   | parking        |
| `/admin/payments`, refunds                                                           | payments       |
| `/admin/adjustments`, `/admin/audit`, `/admin/feature-flags`, `/admin/reports/daily` | admin          |

Composite back-office views (user + balance + receipts) are composed by the client from these
endpoints, not by a server-side facade.

## 11. Seed facts your code must agree with (`prisma/seed.ts`)

- Admin `admin@portcity.local` (role owner), password from `SEED_ADMIN_PASSWORD`, PHC scrypt with
  `PASSWORD_SCRYPT_PARAMS` (ln=17); written only when the row is created (TOTP enrolled at first login).
- Validator device "Aroma Kava, каса 1": `deviceKeyHash = sha256Hex(SEED_VALIDATOR_KEY)`,
  `pinHash` PHC scrypt of `SEED_VALIDATOR_PIN` (6-12 digits, default 246813); written only on create.
- Demo member `+380501234567`, member code `734211800`, vehicle `AC1234BC` verified, account
  with 320 available / 380 lifetime; ledger rows carry `idempotencyKey = seed:demo:<key>`.
  Balance convention: `availableBalance = sum(amount)` over rows in states `available`, `spent`
  and `expired`; `pending` rows form `pendingBalance`; `cancelled` rows count nowhere; spend,
  expire and reverse rows have negative amounts; fully consumed credits may be flipped to `spent`;
  `points_expiry_buckets` holds the unconsumed remainder per expiry day.
- Receipts: credited INTERTOP 6000.00 UAH (180 points), needs_moderation Premier City
  (`high_total`), rejected manual (`fn_unknown`); `rawQr` is a `cabinet.tax.gov.ua/cashregs/check` URL.
- Feature flags: `parking.info_mode`, `receipts.manual_submission`, `events.registration` (enabled).
- Parking session for today in Kyiv time shaped by `PARKING_EMULATOR_SCENARIO`.

## 12. What is verified and what is not

Verified locally on 2026-10-30: `npx prisma validate`, `npx prisma generate`, `npm run typecheck`,
`npm run lint`, `npm run test:unit` (23 suites, 188 tests), `npm run test:e2e` (2 suites, 15 tests,
no database), `npm run build`, and `node dist/scripts/openapi.js` booting the full AppModule with
the stub ports. Not verified locally (no Docker/PostgreSQL/Redis): `npm run test:int`,
`prisma migrate deploy`, `npm run db:seed`, the worker against Redis, `docker build`; CI covers them.
