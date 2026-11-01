# Архітектура PortCity backend

Документ описує, як влаштований код після інтеграції всіх десяти модулів і виправлень за трьома
рецензіями (стан на 01.11.2026, міграція `20261101180000_review_fixes`): процеси, карту модулів, порти,
каталог подій outbox, черги й розклади, основні потоки даних і спільний шар `src/common`. Вимоги продукту: `docs/BRIEF.md`; рішення й відхилення: `docs/INTEGRATION_NOTES.md`;
ендпоїнти: `docs/API.md`; експлуатація: `docs/RUNBOOK.md`. English summary at the end.

## 1. Процеси та точки входу

| Процес  | Файл                                              | Що робить                                                                                                                                                                                       |
| ------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API     | `src/main.ts`                                     | HTTP на `PORT`, префікс `/api/v1`, `/health`, `/ready`, Swagger `/docs`, `rawBody: true` для підписів вебхуків, graceful shutdown                                                               |
| Worker  | `src/worker.ts`                                   | той самий `AppModule`; запускає BullMQ-процесори (`BullRegistrar.register()`), застосовує розклади (`WorkerSchedules.apply()`), HTTP лише `/health` і `/ready` на `WORKER_PORT`; потребує Redis |
| Скрипти | `src/scripts/openapi.ts`, `src/scripts/api-md.ts` | `npm run openapi` пише `docs/openapi.json` без БД і Redis; `npm run docs:api` будує з нього `docs/API.md`                                                                                       |
| Seed    | `prisma/seed.ts`                                  | `npm run db:seed`: ідемпотентні демо-дані (BRIEF розділ 11, канон дизайну для паркінгу)                                                                                                         |

`src/worker.ts` першим імпортує `src/worker-mode.ts`, який виставляє `APP_MODE=worker` до того, як
`AppModule` прочитає конфігурацію. API ніколи не обробляє задачі: він лише ставить їх у черги і пише outbox.

## 2. Карта модулів

```
src/
  app.module.ts            корінь: інфраструктура (global) + 10 доменних модулів
  app.setup.ts             спільне HTTP-налаштування для main.ts і тестів (helmet, CORS, префікс)
  common/                  спільний шар (розділ 9)
  modules/
    identity/      вхід за SMS-кодом, сесії, профіль (стать, місто, діти, бонуси за поля), згоди, пристрої, видалення акаунта, бек-офіс з обов'язковим TOTP
    club/          клубні рахунки, append-only леджер балів, FIFO-кошики згоряння з розподілом списань, утримання, вітальні бонуси й бонуси за поля профілю, набори правил
    content/       орендарі (години, розташування, карта), білий список фіскальних номерів, правила орендарів, інформація про ТРЦ (`mall_info`), імпорт WordPress
    receipts/      QR-парсер, канонічні фіскальні номери, подання чеків, правила ризику й утримання на перевірку, модерація, оскарження, фото
    rewards/       каталог винагород, обміни, ваучери (повернення балів при згорянні, статичний QR квитків), активація на 2 хв, валідатори на касах
    promos/        акції з категоріями, шаблони купонів, заявки на купон, події (категорії, вік, зовнішній вхід) та реєстрації з квитками
    parking/       авто, сесії (оператор або таймер інфо-режиму), тариф, оплата з автоповерненням, спори, заявка талоном, нагадування, тривога
    payments/      платежі через порт провайдера (мок у розробці), спроби, вебхуки, повернення (ручні й автоматичні), екран квитанції, фіскалізація, звіряння
    notifications/ скринька, налаштування, push (stub / FCM), пошта (`MailPort`), споживачі подій outbox, нагадування
    admin/         ручні коригування («чотири очі» з накопиченими лімітами), журнал аудиту, feature flags, щоденні звіти, звернення в підтримку
```

Кожен модуль має `<name>.module.ts`, `controllers/`, `services/`, `dto/`, `domain/` (чиста логіка з табличними
тестами), `jobs/` (процесор лише з'єднує, логіка - функція з тестом), `index.ts` і `README.md` українською
(модель, стан-машини, ендпоїнти, задачі, змінні середовища, відкриті питання).

### Граф імпортів модулів

Ациклічний; стрілка - "імпортує модуль і користується його портом" (порядок - від листків до кореня).

```
identity                 листок
payments                 листок
club          -> identity          (RECEIPTS_PORT - лінивим пошуком, без імпорту)
content       -> club
receipts      -> content, club, identity
parking       -> payments
rewards       -> club, content, parking
promos        -> rewards, content
notifications -> identity, promos
admin         -> усі дев'ять (корінь графа)
```

| Модуль        | Імпортує                | Порти, які споживає                                                                                         |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| identity      | -                       | `ADMIN_AUDIT_PORT`                                                                                          |
| payments      | -                       | `ADMIN_AUDIT_PORT`                                                                                          |
| club          | identity                | `IDENTITY_PORT`, `RECEIPTS_PORT` (лише `getPendingSummary`, лінивий `ModuleRef`), `ADMIN_AUDIT_PORT`        |
| content       | club                    | `CLUB_LEDGER_PORT` (базова ставка), `ADMIN_AUDIT_PORT`                                                      |
| receipts      | content, club, identity | `CONTENT_PORT`, `CLUB_LEDGER_PORT`, `IDENTITY_PORT` (вік акаунта), `FEATURE_FLAGS_PORT`, `ADMIN_AUDIT_PORT` |
| parking       | payments                | `PAYMENTS_PORT`, `FEATURE_FLAGS_PORT`, `ADMIN_AUDIT_PORT`                                                   |
| rewards       | club, content, parking  | `CLUB_LEDGER_PORT`, `CONTENT_PORT`, `PARKING_PORT`, `ADMIN_AUDIT_PORT`                                      |
| promos        | rewards, content        | `VOUCHER_ISSUER_PORT`, `CONTENT_PORT`, `FEATURE_FLAGS_PORT`, `ADMIN_AUDIT_PORT`                             |
| notifications | identity, promos        | `IDENTITY_PORT`, `PROMOS_PORT`, `ADMIN_AUDIT_PORT`                                                          |
| admin         | усі дев'ять             | `CLUB_LEDGER_PORT`, `RECEIPTS_PORT`, `VOUCHER_ISSUER_PORT`, `PARKING_PORT`, `ADMIN_AUDIT_PORT`              |

Усе інше між модулями йде через outbox (розділ 4). Модуль пише лише у власні таблиці; чужі дані читає
через порт власника. Єдине читання «проти» графа - картка клубу (`GET /club/account`) бере
`RECEIPTS_PORT.getPendingSummary` з контейнера (`ModuleRef.get(..., { strict: false })`), бо receipts
імпортує club; недоступний порт дає нулі.

## 3. Порти (синхронні контракти)

Інтерфейси й токени - `src/common/contracts/<module>.ts`; власник надає `{ provide: TOKEN, useExisting: Impl }`.
Методи, що пишуть, приймають `tx` останнім аргументом і приєднуються до транзакції викликача.
Виняток - `PAYMENTS_PORT.createPayment`: зовнішній провайдер ніколи не викликається всередині транзакції БД,
тому порт сам комітить рядок спроби, кличе провайдера поза транзакцією і повертає платіж; викликач
(parking) пише свій `ParkingPaymentLink` уже після повернення.

| Порт                  | Надає (клас)                            | Методи                                                                                                                                                                                                                                         | Споживачі                                                                                                                                                      |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDENTITY_PORT`       | identity (`IdentityPortService`)        | `getUser(s)`, `getDevice`, `resolveMemberCode`, `listPushDevices`, `hasConsent`, `listMarketingAudience`, `getAdminAccess`                                                                                                                     | club (код учасника для QR), notifications (статус, згоди, push-пристрої, аудиторія маркетингу), `AdminAccessGate` у `src/common/auth`                          |
| `CLUB_LEDGER_PORT`    | club (`LedgerService`)                  | `getBalance`, `getEntry`, `getActiveRules`, `credit`, `hold`, `release`, `spend`, `reverse`, `getDailyStats`                                                                                                                                   | receipts (нарахування/утримання, пороги), rewards (списання, повернення), content (базова ставка), admin (коригування, звіт)                                   |
| `CONTENT_PORT`        | content (`ContentPortService`)          | `getTenant(s)`, `getTenantSummaryById` (картка: slug, поверх, лого), `findTenantByFiscalNumber` (канонічний `fn`), `isExcluded`, `getTenantRule`, `recordSeenFiscalNumber`                                                                     | receipts (білий список кас, виключення, ставка), rewards (`tenant` у ваучері через `getTenantSummaryById`, запасний `getTenants`), promos (перевірка орендаря) |
| `RECEIPTS_PORT`       | receipts (`ReceiptsPortService`)        | `getReceipt`, `countForUser`, `getDailyStats`, `getPendingSummary` (неврегульовані чеки й очікувані бали)                                                                                                                                      | admin (щоденний звіт), club (`pendingModeration` на картці, лінивий пошук)                                                                                     |
| `VOUCHER_ISSUER_PORT` | rewards (`VoucherService`)              | `issue` (ідемпотентний за джерелом), `cancel`, `getVoucher`, `listBySource`, `getDailyStats`                                                                                                                                                   | promos (купони, квитки), admin (звіт)                                                                                                                          |
| `PROMOS_PORT`         | promos (`PromosPortService`)            | `getPromo`, `getEvent`, `validateClaim`                                                                                                                                                                                                        | notifications (назва і час події для нагадування про квиток)                                                                                                   |
| `PARKING_PORT`        | parking (`ParkingService`)              | `getSessionForUser`, `getSession`, `quote`, `getActiveTariff`, `getDailyStats`                                                                                                                                                                 | rewards (сесія для «Година паркінгу»), admin (звіт)                                                                                                            |
| `PAYMENTS_PORT`       | payments (`PaymentsService`)            | `createPayment` (ідемпотентний за логічним ключем, спроби `<ключ>:a<n>`, без транзакції викликача), `getPayment`, `getPayments` (пакетом), `getPaymentByIdempotencyKey` (остання спроба), `requestRefund` (автоповернення, один раз на платіж) | parking (оплата сесії, sweep оплат, автоматичне повернення непридатної оплати)                                                                                 |
| `NOTIFICATIONS_PORT`  | notifications (`NotificationsService`)  | `notify`, `countUnread`                                                                                                                                                                                                                        | резерв для синхронних викликачів (бек-офіс notifications користується сервісом напряму)                                                                        |
| `ADMIN_AUDIT_PORT`    | common (`AuditService`, глобальний)     | `audit(entry, tx?)`                                                                                                                                                                                                                            | усі модулі (кожна дія адміністратора і системні дії)                                                                                                           |
| `FEATURE_FLAGS_PORT`  | common (`FeatureFlagsService`, кеш 5 с) | `isEnabled`, `get`                                                                                                                                                                                                                             | receipts (`receipts.manual_submission`), promos (`events.registration`), parking (`parking.info_mode`, `parking.air_raid`)                                     |

Порти до зовнішнього світу - абстрактні класи з адаптерами: `StoragePort` (S3 / пам'ять), `SmsPort`
(log / TurboSMS), `ParkingProviderPort` (емулятор / vendor-заглушка; `findSessionByTalon`),
`PaymentProviderPort` (мок; `cancelCheckout`, ідемпотентні повернення, `strictWebhooks`), `PushPort`
(stub / FCM HTTP v1), `MailPort` (log; SMTP - TODO), `CaptchaVerifierPort` (noop),
`TaxReceiptVerifierPort` (noop, завжди `unknown`). Тести підміняють їх in-memory реалізаціями.

## 4. Outbox: каталог подій

Модуль публікує подію в тій самій транзакції, що змінює агрегат (`outbox.publish(tx, buildOutboxEvent(...))`).
Диспетчер у воркері (`OutboxDispatcher`, черга `outbox-dispatch`, кожні `OUTBOX_DISPATCH_EVERY_MS` = 5 с)
бере неопубліковані події (`FOR UPDATE SKIP LOCKED`), ставить задачу в кожну чергу-споживача з
`OutboxRouter` (`jobId = outbox-<eventId>`, ім'я задачі = тип події) і ставить `publishedAt`. Події зі
списку "лише аудит" (`src/common/outbox/audit-only-events.ts`) одразу позначаються опублікованими; подія без
маршруту і поза списком повторюється ~5 хв і скидається з error-логом. `test/e2e/outbox-routes.e2e-spec.ts`
гарантує, що кожен тип каталогу має споживача або статус "лише аудит". Споживачі ідемпотентні за `eventId`.
Опубліковані події видаляються через 7 днів (`maintenance`).

| Подія                                                                                         | Публікує      | Споживачі (черга)                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `user.registered`, `user.profile_completed`                                                   | identity      | club (`club-events`): рахунок, вітальні бонуси                                                                             |
| `user.profile_field_completed` (нова)                                                         | identity      | club (`club-events`): `PROFILE_BONUS_PER_FIELD` за поле, `PROFILE_BONUS_COMPLETE` за повний профіль                        |
| `user.deletion_requested`, `user.deletion_cancelled`                                          | identity      | notifications (`notifications-events`)                                                                                     |
| `user.deleted`                                                                                | identity      | receipts, parking, payments, notifications, rewards, admin (кожен у свою `*-events`): очищення персональних даних          |
| `user.device_registered`, `user.blocked`, `user.unblocked`                                    | identity      | лише аудит                                                                                                                 |
| `points.released`, `points.expiring`, `points.expired`                                        | club          | notifications                                                                                                              |
| `points.account_created`, `points.credited`, `points.held`, `points.spent`, `points.reversed` | club          | лише аудит                                                                                                                 |
| `tenant.updated`, `tenant.fiscal_number_seen`, `tenant.fiscal_number_confirmed`               | content       | лише аудит                                                                                                                 |
| `receipt.credited`                                                                            | receipts      | club (бонус за перший чек, блок новачка), notifications                                                                    |
| `receipt.needs_moderation`, `receipt.rejected`                                                | receipts      | notifications                                                                                                              |
| `receipt.submitted`, `receipt.approved`, `receipt.appealed`                                   | receipts      | лише аудит                                                                                                                 |
| `voucher.issued`, `voucher.expired`                                                           | rewards       | notifications                                                                                                              |
| `voucher.redeemed`, `voucher.cancelled`                                                       | rewards       | promos (`promos-events`: реєстрація `used`/`cancelled`, купон у пул), notifications                                        |
| `redemption.created`, `voucher.activated`                                                     | rewards       | лише аудит                                                                                                                 |
| `promo.published`, `event.published`                                                          | promos        | notifications (маркетингова розсилка за згодою)                                                                            |
| `event.registered`, `event.cancelled`                                                         | promos        | notifications                                                                                                              |
| `event.registration_cancelled`                                                                | promos        | rewards (`rewards-events`: скасувати квиток), notifications                                                                |
| `promo.coupon_claimed`                                                                        | promos        | лише аудит                                                                                                                 |
| `parking.session.opened`, `.payable`, `.paid`, `.overstay`, `.closed`                         | parking       | notifications                                                                                                              |
| `parking.session.free_ending`, `.exit_soon`, `.still_inside`                                  | parking       | notifications (нагадування F2, F4, F7)                                                                                     |
| `parking.session.disputed` (нова)                                                             | parking       | notifications (`parking_disputed`: «Звернення щодо паркування прийнято»)                                                   |
| `parking.vehicle.verified`                                                                    | parking       | лише аудит                                                                                                                 |
| `parking.payment.ops_alert` (нова)                                                            | parking       | лише аудит (дублюється записом `audit_logs` `parking_payment.ops_alert` і error-логом; RUNBOOK розділ 10)                  |
| `payment.succeeded`                                                                           | payments      | parking (`parking-events`: рішення один раз на платіж - застосувати, повернути або alert), notifications (лише не паркінг) |
| `payment.failed`                                                                              | payments      | notifications                                                                                                              |
| `payment.refunded`                                                                            | payments      | notifications (`payment_refunded` для паркінгових платежів; раніше - лише аудит)                                           |
| `payment.created`, `.cancelled`, `.expired`, `.fiscalized`                                    | payments      | лише аудит                                                                                                                 |
| `notification.created`                                                                        | notifications | notifications (`notifications-push`: доставка push)                                                                        |
| `adjustment.applied`                                                                          | admin         | notifications                                                                                                              |
| `support.request_created` (нова)                                                              | admin         | notifications: підтвердження «Звернення № N прийнято» і лист на `SUPPORT_EMAIL` (`MailPort`)                               |
| `adjustment.requested`, `.approved`, `.rejected`, `flag.updated`                              | admin         | лише аудит                                                                                                                 |

Payload кожної події - `src/common/contracts/events.ts` (`OutboxEventPayloads`).

## 5. Черги та розклади

Назви - `QUEUES` (`src/common/queue/queue.constants.ts`); власник реєструє чергу
`QueueModule.registerQueue(...)` і хостить `@Processor`. Розклади реєструються в `onModuleInit` через
`WorkerSchedules` (cron - у часовому поясі Europe/Kyiv) і застосовуються воркером при старті. Типово 3 спроби
з експоненційним backoff 2 с.

| Черга                  | Власник       | Задачі                                                                                          | Розклад (id)                                                                                                                                                                                                                                                       |
| ---------------------- | ------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outbox-dispatch`      | common        | `tick`                                                                                          | кожні 5 с (`outbox-dispatch`)                                                                                                                                                                                                                                      |
| `maintenance`          | common        | `idempotency-purge`, `outbox-purge`                                                             | щогодини (`maintenance-idempotency-purge`); `0 4 * * *` (`maintenance-outbox-purge`)                                                                                                                                                                               |
| `account-deletion`     | identity      | `run`, `execute-one`                                                                            | `15 4 * * *` (`account-deletion-daily`, `ACCOUNT_DELETION_CRON`)                                                                                                                                                                                                   |
| `points-release-holds` | club          | `release-holds`                                                                                 | `5 * * * *` (`points-release-holds-hourly`)                                                                                                                                                                                                                        |
| `points-expire`        | club          | `expire` (+ нагадування 30 і 7 днів), `drift-check`                                             | `30 3 * * *` (`points-expire-daily`); `15 4 * * *` (`points-balance-drift-nightly`)                                                                                                                                                                                |
| `content-import`       | content       | `run`                                                                                           | на вимогу: `POST /admin/content/import` з `async: true`                                                                                                                                                                                                            |
| `receipts-process`     | receipts      | `process` (parse -> rules -> credit), `sweep`, `verify-held`                                    | `process` на вимогу (запасний шлях); `sweep` кожні 10 хв (`receipts-process-sweep`); `verify-held` кожні 30 хв (`receipts-verify-held`): чеки в утриманні -> `TaxReceiptVerifierPort`                                                                              |
| `vouchers-expire`      | rewards       | `expire` (+ повернення балів за ваучери з обміну, `REWARDS_REFUND_ON_EXPIRY`)                   | кожні 60 с (`vouchers-expire-every-minute`)                                                                                                                                                                                                                        |
| `parking-sync`         | parking       | `sync`, `payments-sweep`                                                                        | `sync` кожні 60 с (`parking-sync-every-minute`, `PARKING_SYNC_EVERY_MS`); `payments-sweep` кожні 5 хв (`parking-payments-sweep`): незастосовані / незареєстровані оплати і непідтверджені повернення за 48 год, очищення `parking_webhook_logs` старших за 30 днів |
| `payments-reconcile`   | payments      | `reconcile`, `fiscalize`, `auto-refund`                                                         | щогодини (`payments-reconcile-hourly`, заодно дочерговує `auto-refund` у стані `queued`); `fiscalize` після `payment.succeeded`; `auto-refund` після `PAYMENTS_PORT.requestRefund` (12 спроб від 1 хв)                                                             |
| `reports-nightly`      | admin         | `compute-day`                                                                                   | `20 0 * * *` (`reports-nightly-daily`)                                                                                                                                                                                                                             |
| `notifications-push`   | notifications | `notification.created`                                                                          | outbox                                                                                                                                                                                                                                                             |
| `notifications-events` | notifications | події з розділу 4; `reminder.ticket`, `reminder.voucher_expiring` (відкладені)                  | outbox; нагадування за 24 год                                                                                                                                                                                                                                      |
| `club-events`          | club          | `user.registered`, `user.profile_completed`, `user.profile_field_completed`, `receipt.credited` | outbox                                                                                                                                                                                                                                                             |
| `rewards-events`       | rewards       | `event.registration_cancelled`, `user.deleted`                                                  | outbox                                                                                                                                                                                                                                                             |
| `promos-events`        | promos        | `voucher.redeemed`, `voucher.cancelled`, `promos-finish-events`                                 | outbox; `promos-finish-events` щогодини                                                                                                                                                                                                                            |
| `parking-events`       | parking       | `payment.succeeded` (довга політика повторів ~17 год), `user.deleted`                           | outbox                                                                                                                                                                                                                                                             |
| `receipts-events`      | receipts      | `user.deleted`                                                                                  | outbox                                                                                                                                                                                                                                                             |
| `payments-events`      | payments      | `user.deleted`                                                                                  | outbox                                                                                                                                                                                                                                                             |
| `admin-events`         | admin         | `user.deleted` (текст і фото звернень у підтримку)                                              | outbox                                                                                                                                                                                                                                                             |

`QUEUE_DRIVER=memory` (тести, `npm run openapi`, API без Redis) тримає задачі в пам'яті і нічого не диспетчеризує.

## 6. Потоки даних

### 6.1 Подання чека (`POST /receipts/qr`)

```mermaid
sequenceDiagram
  participant App as Застосунок
  participant API as API (receipts)
  participant Content as CONTENT_PORT
  participant Club as CLUB_LEDGER_PORT
  participant DB as PostgreSQL
  participant W as Воркер
  App->>API: POST /receipts/qr {qrText} + Idempotency-Key
  API->>API: IdempotencyInterceptor, розбір QR (qr-parser), канонічні fn і fiscalId (сирі - у fn_raw, fiscal_id_raw)
  API->>DB: дубль канонічного (fn, fiscalId)? -> 409 PC_RECEIPT_DUPLICATE
  API->>DB: tx: Receipt(parsed) + історія + outbox receipt.submitted
  API->>Content: findTenantByFiscalNumber / recordSeenFiscalNumber(fn, tx, {receiptId}) / isExcluded / getTenantRule
  API->>Club: getActiveRules()
  API->>API: правила (rules.ts) + шаблони шахрайства + денний ліміт балів QR: rejected | needs_moderation | auto_approved
  alt auto_approved
    API->>Club: tx під pg_advisory_xact_lock(учасник): credit, або hold на 24 год (новий акаунт / сума > 500 грн, verification = pending), ключ receipt:<id> + Receipt credited + outbox receipt.credited
  else needs_moderation
    API->>DB: moderation_reasons + outbox receipt.needs_moderation
  else rejected
    API->>DB: rejection_code + outbox receipt.rejected
  end
  API-->>App: {outcome, screen, title, message, pointsAwarded, moderationReasons, receipt}
  W->>DB: outbox-dispatch: receipt.credited -> club-events, notifications-events
  W->>W: club: бонус за перший чек; notifications: receipt_credited -> notification.created -> push
```

Якщо content або леджер недоступні, чек лишається `parsed` / `auto_approved`, у `receipts-process` ставиться
задача, а відповідь має `outcome = processing` (екран «на перевірці»); `sweep` кожні 10 хв підхоплює чеки,
що застрягли. Модератор: `GET /admin/receipts?status=needs_moderation` -> `POST /admin/receipts/:id/approve`
(нарахування одразу, аудит у транзакції) або `/reject` (причина показується учаснику, можливе одне оскарження).
Чеки в утриманні раз на 30 хв перевіряє `verify-held` через `TaxReceiptVerifierPort` (зараз noop: `unknown`,
після `verifyUntil` - `unconfirmed`, бали відпускаються клубом у `availableAt`); відмова перевірки сторнує
утримані бали (`receipt.rejected`, `PC_RECEIPT_NOT_VERIFIED`).

### 6.2 Оплата паркування (`POST /parking/session/:id/pay`)

```mermaid
sequenceDiagram
  participant App as Застосунок
  participant P as API (parking)
  participant Op as ParkingProviderPort (оператор / емулятор)
  participant Pay as PAYMENTS_PORT
  participant PSP as Платіжний провайдер (мок)
  participant W as Воркер
  App->>P: GET /parking/session (герой F0-F7, сума, наступна година)
  App->>P: POST /parking/session/:id/pay + Idempotency-Key
  P->>Op: актуальна сума (недоступний -> 503, «сплатіть у паркоматі»); < 5 хв до кінця години -> + наступна година
  P->>Pay: createPayment(ключ parking:<sessionId>:<paidUntil>, meta {sessionId, paidUntil, plate, plateDisplay}) - без транзакції parking
  Pay->>Pay: рядок спроби комітиться, провайдер поза транзакцією, checkout зберігається
  P->>P: ParkingPaymentLink(sessionId, paymentId, paidUntil)
  P-->>App: Payment {checkoutUrl}
  App->>PSP: checkout (мок: /api/v1/mock-checkout/:providerRef)
  PSP->>Pay: POST /webhooks/payments/:provider (підпис від сирого тіла)
  Pay->>Pay: tx: журнал вебхука (provider, externalId) + succeeded + outbox payment.succeeded
  W->>P: parking-events: під FOR UPDATE сесії - applied (paid до paidUntil, registerPayment, parking.session.paid) або refund_queued (requestRefund + parking.payment.ops_alert) або alerted
  W->>W: notifications-events: payment_refunded після повернення; payments-reconcile: fiscalize, auto-refund
  App->>P: GET /payments/:id (квитанція: displayNumber, отримувач, номер авто, operatorQrPayload), GET /parking/session (F4: «Виїзд до 16:00»)
  W->>P: parking-sync щохвилини: exit_soon за 10 хв до paidUntil, виїзд -> closed -> parking.session.closed
  W->>P: payments-sweep кожні 5 хв: повторює незастосовані оплати, реєстрацію в операторі й запити повернень
```

Повторне натискання повертає ту саму відкриту чи оплачену спробу (логічний ключ на сесію й оплачену годину);
після відхиленої картки, скасування чи простроченого checkout створюється нова спроба `<ключ>:a2`.
Рішення про оплату приймається один раз на платіж і записується в `ParkingPaymentLink.outcome`:
оплату, яку сесія вже не може використати (сесія закрита, ту саму годину оплатила інша спроба, сесію не
знайдено), parking автоматично повертає (`PAYMENTS_PORT.requestRefund`), оплата після «Я вже виїхав» з
боргом лишається для ручної звірки (`manual_review`). Подвійну оплату «застосунок + паркомат» автоматично
не повертає ніхто (рішення за замовчуванням, `docs/INTEGRATION_NOTES.md`). Якщо оператор не прийняв
реєстрацію оплати, сесія все одно позначається оплаченою, а `payments-sweep` і довга політика повторів
`parking-events` (~17 год) повторюють реєстрацію. `payments-reconcile` щогодини перепитує провайдера про
платежі, відкриті понад 20 хв (спершу `cancelCheckout`; пізній успіх приходить з `late: true`).

## 7. Конвенції коду

- TypeScript strict, `noImplicitOverride`, `noUncheckedIndexedAccess`, `isolatedModules`; типи в сигнатурах
  конструкторів `@Injectable()` імпортуються як `import type`.
- Ідентифікатори, коментарі, логи англійською; README і docs українською; без емодзі.
- Гроші - цілі копійки, бали - цілі, час у БД - UTC (`timestamptz`), бізнес-час - `Europe/Kyiv`
  (`src/common/time/kyiv.ts`), поточний час - з `Clock`. Ідентифікатори - UUID v7 з застосунку.
- Помилки: `throw new DomainError(Errors.PC_X_Y, 'detail', { details })`; відповідь - `application/problem+json`
  (`type`, `title`, `status`, `detail`, `code`, `instance`, `requestId`). Коди кожного модуля перелічені в
  `*_ERROR_CODES` контракту і збігаються з зареєстрованими (`src/common/contracts/error-codes.spec.ts`).
- Контролери: DTO з class-validator і Swagger, `@Auth('member')` / `@Auth('admin', ...roles)` / `@Public()`,
  `@Idempotent()` на мутаціях із фінансовим ефектом, курсорна пагінація `{ items, nextCursor }`.

## 8. Конфігурація

`AppConfigModule` валідує `process.env` zod-схемою `src/common/config/env.schema.ts` і надає `APP_CONFIG`.
Модульні змінні валідують секції (`envSectionProvider(TOKEN, schema, 'name')`): `idempotency`, `identity`,
`club`, `content`, `receipts`, `rewards`, `parking`, `payments`, `notifications`, `mail`. Усі змінні - у
`.env.example` з українськими коментарями; `env-example.spec.ts` перевіряє повноту за кожною секцією (і що
кожна секція з `src/` зареєстрована в тесті), що dev-значення `.env.example` і `docker-compose.yml`
проходять усі схеми в development і відхиляються в production.

**Політика секретів у production** (`src/common/config/secret-policy.ts`, застосовує `validateEnv` до
спільних і модульних змінних): кожна змінна `*_SECRET` або `*_PEPPER` (`JWT_SECRET`, `OTP_PEPPER`,
`VOUCHER_PEPPER`, `MEMBER_QR_SECRET`, `PARKING_WEBHOOK_SECRET`, `PAYMENTS_MOCK_WEBHOOK_SECRET`,
`PAYMENTS_RECEIPT_QR_SECRET`, ...) - щонайменше 32 символи і не з deny-list: префікси `dev-only-`,
`compose-only-`, `test-only-`, `unit-test-`, усе з `changeme`/`change-me`, літеральні значення з репозиторію
(`portcity-secret`, `ChangeMe-2026!`, `dev-validator-aroma-kava`, `minioadmin`...). `S3_SECRET_ACCESS_KEY` і
`SEED_ADMIN_PASSWORD` перевіряються лише за deny-list. `secret-policy.spec.ts` розбирає `.env.example` і
`docker-compose.yml` і доводить, що кожен секрет у них відхиляється. Також у production відхиляються
`STORAGE_DRIVER=memory`, `QUEUE_DRIVER=memory`, `PARKING_PROVIDER=emulator`, `PAYMENTS_PROVIDER=mock`,
`SMS_PROVIDER=log`, `OTP_DEV_ECHO=true`, `CORS_ORIGINS=*`, `OTP_STATIC_CODES` без `ALLOW_STATIC_OTP=true`
і 8-значних кодів. Seed у production відмовляється працювати без `SEED_ADMIN_PASSWORD`,
`SEED_VALIDATOR_KEY`, `SEED_VALIDATOR_PIN` або з їхніми значеннями за замовчуванням.

**`TRUST_PROXY`** (`src/common/config/trust-proxy.ts`): `false` - IP клієнта = адреса сокета; число N -
N проксі перед застосунком (балансувальник = 1, CDN + балансувальник = 2, максимум 10); список адрес /
CIDR / `loopback`, `linklocal`, `uniquelocal` - довіряти лише проксі з цих мереж. `true` трактується як
1 хоп; «довіряти всім» не налаштовується (будь-який клієнт підробив би `X-Forwarded-For` і обходив ліміти).
Від IP залежать rate limit, ліміти OTP і аудит; IPv6-клієнти рахуються за мережею /64 (`ipRateLimitKey`).

## 9. Спільний шар `src/common`

| Каталог                                             | Що надає                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/`                                           | zod-схема env, `APP_CONFIG`, `envSectionProvider`, політика секретів, розбір `TRUST_PROXY`                                                                                                         |
| `logging/`                                          | nestjs-pino, `x-request-id`, маскування облікових даних (Authorization, cookie, `X-Validator-*`, `Idempotency-Key`, паролі й коди в тілі), URL без query string (і в логах `ProblemDetailsFilter`) |
| `prisma/`                                           | `PrismaService` (lazy connect), `withTx` / `runInTx`, хелпери помилок Prisma                                                                                                                       |
| `redis/`                                            | ioredis-клієнт `REDIS_CLIENT`                                                                                                                                                                      |
| `queue/`                                            | `QUEUES`, `QueueModule.registerQueue`, `QueueRegistry`, `WorkerSchedules`, `InMemoryQueue`                                                                                                         |
| `outbox/`                                           | `OutboxService.publish`, `OutboxRouter` (маршрути і `ignore`), `OutboxDispatcher`, список "лише аудит"                                                                                             |
| `audit/`                                            | `AuditService` = `ADMIN_AUDIT_PORT` (append-only `audit_logs`)                                                                                                                                     |
| `feature-flags/`                                    | `FeatureFlagsService` = `FEATURE_FLAGS_PORT` (кеш 5 с)                                                                                                                                             |
| `idempotency/`                                      | `@Idempotent()`, `IdempotencyInterceptor`, таблиця `idempotency_keys` (24 год), оренда ключа в роботі `IDEMPOTENCY_LEASE_SECONDS` (120 с)                                                          |
| `maintenance/`                                      | очищення ключів ідемпотентності і старих подій outbox                                                                                                                                              |
| `auth/`                                             | JWT HS256, `@Auth/@Public/@Roles/@CurrentUser`, `MemberGuard`, `AdminGuard` + `AdminAccessGate`, `RolesGuard`, scrypt/HMAC/SHA-256                                                                 |
| `errors/`                                           | `DomainError`, `defineErrorCodes`, `ProblemDetailsFilter`, `ApiProblemResponses`                                                                                                                   |
| `time/`, `money/`, `phone/`, `pagination/`          | `Clock`/`FakeClock` і Europe/Kyiv; копійки й гривні; E.164; курсори                                                                                                                                |
| `storage/`                                          | `StoragePort`, S3 і in-memory адаптери; публічні й приватні префікси (див. нижче)                                                                                                                  |
| `health/`, `openapi/`, `throttling/`, `validation/` | `/health`, `/ready`; Swagger і схеми безпеки (`bearer`, `validator-key`, `validator-shift`); throttler 60 rpm/IP (IPv6 - мережа /64); глобальний `ValidationPipe`                                  |

**Сховище: публічні й приватні об'єкти.** `PUBLIC_OBJECT_PREFIXES` (`src/common/storage/storage.port.ts`):
`tenants/`, `promos/`, `events/`, `rewards/`, `banners/`, `mall/` - лише для них `StoragePort.publicUrl(key)`
повертає постійний URL від `S3_PUBLIC_BASE_URL`. Усе інше приватне: фото чеків (`receipts/<userId>/...`),
оскаржень і звернень у підтримку (`support/<userId>/...`) видаються тільки підписаними посиланнями не
довше години (`MAX_PRIVATE_DOWNLOAD_TTL_SECONDS` = 3600; `RECEIPTS_PHOTO_URL_TTL_SECONDS` має той самий
максимум), навіть якщо `S3_PUBLIC_BASE_URL` задано.
| `contracts/` | порти, DTO і каталог подій (по файлу на модуль + `shared`, `events`, `port-stub`) |

## 10. Авторизація

- Учасник: access JWT HS256 на 15 хв (`sub`, `typ: member`, `did`), refresh-токен 32 байти (зберігається SHA-256),
  ротація в межах сім'ї, повторне використання ротованого токена відкликає сім'ю.
- Бек-офіс: e-mail + пароль (scrypt PHC, нові паролі N = 2^17, перевірки під семафором) + TOTP (повтор коду
  відхиляється, `totp_last_step`). Для ролей з `ADMIN_REQUIRE_TOTP_ROLES` (типово owner, manager) TOTP
  обов'язковий: без нього вхід дає `403 PC_ADMIN_TOTP_SETUP_REQUIRED` і налаштування під час входу
  (`/admin/auth/totp/enroll` -> `/enroll/confirm`, RUNBOOK розділ 5.1). Невдалі входи блокують акаунт з
  backoff (5 хв - 1 год); виклик TOTP одноразовий, до 5 кодів. Admin access JWT на
  `ADMIN_ACCESS_TTL_SECONDS` (8 год) без refresh. `AdminGuard` після перевірки підпису питає
  `AdminAccessGate`, чи акаунт активний і чи роль у токені збігається зі збереженою (identity надає
  резолвер, кеш `ADMIN_ACCESS_CACHE_SECONDS` = 30 с); `owner` проходить будь-яку перевірку ролей.
- Валідатор каси: `X-Validator-Key` + токен зміни `X-Validator-Shift`. PIN (6-12 цифр для нових, 4-12 для
  старих) приймається лише в тілі `POST /validator/shift`; 5 помилок поспіль блокують відкриття зміни на
  15 хв. Заголовок `X-Validator-Pin` більше не приймається (і не дозволений у CORS, не є схемою OpenAPI).
- Помилки: `PC_AUTH_UNAUTHORIZED`, `PC_AUTH_TOKEN_EXPIRED`, `PC_AUTH_TOKEN_INVALID` (401), `PC_AUTH_FORBIDDEN`,
  `PC_ADMIN_INACTIVE` (403).

## 11. Дані, ідемпотентність, тести

- Схема - `prisma/schema/*.prisma` (файл на модуль, `base.prisma` спільний); міграції -
  `prisma/schema/migrations/20261030120000_init` (тригери append-only, CHECK, часткові індекси),
  `20261101120000_module_requests` (запити модулів: колонки, `coupon_claims`, часткові індекси утримань і
  джерела ваучера, EXCLUDE для правил орендарів, заповнення даних) і `20261101180000_review_fixes`
  (виправлення рецензій: діти й поля профілю, `points_spend_allocations` з тригером append-only,
  `mall_info`, `support_requests` з послідовністю номерів, `parking_webhook_logs`, колонки оплат, спорів,
  верифікації чеків, категорій акцій і подій; CHECK, FK без відношень Prisma, часткові індекси; заповнення
  даних і канонізація фіскальних номерів зі звітами `receipt_canonical_collisions`,
  `fiscal_number_canonical_collisions`). Жоден об'єкт не створюється двічі в трьох міграціях.
- `@Idempotent()` вимагає `Idempotency-Key` (8-128 символів). Область ключа - учасник + метод + шаблон
  маршруту; у хеш запиту входять метод, **конкретний шлях** (без query string і кінцевого `/`) і тіло, тож
  той самий ключ на інший ресурс того самого маршруту дає 409 mismatch, а не чужу збережену відповідь.
  Повтор з тим самим запитом повертає збережену відповідь (`Idempotent-Replayed: true`); ключ, чий
  обробник ще працює, - `409 PC_COMMON_IDEMPOTENCY_IN_PROGRESS`, доки не мине оренда
  `IDEMPOTENCY_LEASE_SECONDS` (120 с): після неї ключ вважається покинутим (запит упав) і його підхоплює
  повтор. Невдале збереження відповіді повторюється у фоні (1-60 с, разом 111 с - у межах оренди). Леджер
  ідемпотентний за власними ключами (`receipt:<id>`, `redemption:<id>`, `adjustment:<id>`,
  `voucher-expire:<id>`, `profile-field:<field>:<userId>`), платежі - за логічним ключем і спробою,
  ваучери - за джерелом, сповіщення - за `dedupe_key`, вебхуки - за `(provider, externalId|eventId)`.
- Тести: юніт `*.spec.ts` поруч із кодом (`npm run test:unit`), e2e `test/**/*.e2e-spec.ts` на повному
  `AppModule` з in-memory чергами й сховищем (`npm run test:e2e`), інтеграційні `**/*.int-spec.ts` проти
  PostgreSQL (`npm run test:int`, самопропуск без `DATABASE_URL`).

## 12. Логи, здоров'я, безпека HTTP

- `nestjs-pino`: JSON у production; `x-request-id` приймається або генерується і повертається в problem-документі.
- `/health` - liveness; `/ready` - PostgreSQL (`SELECT 1`) і Redis `PING` (за `QUEUE_DRIVER=redis`).
- `helmet`, CORS за allowlist `CORS_ORIGINS` (дозволені заголовки: `Authorization`, `Content-Type`,
  `Idempotency-Key`, `X-Request-Id`, `X-Validator-Key`, `X-Validator-Shift`), `trust proxy` за `TRUST_PROXY`
  (розділ 8), throttler у пам'яті процесу (за кількох реплік потрібне Redis-сховище; так само лічильники
  сплесків входу й попередження бюджету SMS - на репліку).

## English summary

NestJS 12 modular monolith run as API or worker from one `AppModule`. Ten domain modules own their tables and
queues, expose read/write ports through `src/common/contracts` (acyclic import graph, admin at the root) and
publish outbox events in the same transaction as their aggregate; the worker dispatcher routes every catalogue
event to consumer queues or marks it audit-only, so nothing is dropped. `user.deleted` is cleaned up by every
module that holds personal data (now including admin support requests). The shared AdminGuard re-checks admin
activity and role through identity (30 s cache); owner and manager must use TOTP. Receipt submission
canonicalises fiscal numbers and credits points synchronously through the ledger (24 h verification hold for
new accounts and totals above 500 UAH, daily QR points cap) with a BullMQ fallback; parking payments go
through the payments port (no caller transaction, attempts per logical key), a signed provider webhook and
`payment.succeeded` back into parking, which applies, auto-refunds or alerts once per payment; members are
told about parking refunds. Idempotency hashes the concrete path and leases in-progress keys for 120 s;
production refuses short or repository-default secrets. Migration 3 (`20261101180000_review_fixes`) carries
the review fixes.
