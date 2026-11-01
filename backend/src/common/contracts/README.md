# Контракти між модулями

Тут лежать типи, якими модулі обмінюються між собою: інтерфейси портів, DI-токени, DTO
результатів, назви подій outbox і форми їхніх payload. Повний опис, як ними користуватися:
`docs/FOUNDATION_SUMMARY.md` (розділи 4, 5 і 9).

Файли:

| Файл               | Токени                                   | Інтерфейс                                                                                            |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `shared.ts`        | -                                        | примітиви (`Tx`, `ActorRef`, `DateRange`, ...)                                                       |
| `identity.ts`      | `IDENTITY_PORT`                          | `IdentityPort`                                                                                       |
| `club.ts`          | `CLUB_LEDGER_PORT`                       | `ClubLedgerPort`                                                                                     |
| `content.ts`       | `CONTENT_PORT`                           | `ContentPort`                                                                                        |
| `receipts.ts`      | `RECEIPTS_PORT`                          | `ReceiptsPort`                                                                                       |
| `rewards.ts`       | `VOUCHER_ISSUER_PORT`                    | `VoucherIssuerPort`                                                                                  |
| `promos.ts`        | `PROMOS_PORT`                            | `PromosPort`                                                                                         |
| `parking.ts`       | `PARKING_PORT`                           | `ParkingPort`                                                                                        |
| `payments.ts`      | `PAYMENTS_PORT`                          | `PaymentsPort`                                                                                       |
| `notifications.ts` | `NOTIFICATIONS_PORT`                     | `NotificationsPort`                                                                                  |
| `admin.ts`         | `ADMIN_AUDIT_PORT`, `FEATURE_FLAGS_PORT` | `AdminAuditPort`, `FeatureFlagsPort` (реалізовані у `src/common/audit` і `src/common/feature-flags`) |
| `events.ts`        | -                                        | каталог подій outbox: константи назв, типи payload, `buildOutboxEvent()`                             |
| `port-stub.ts`     | -                                        | `unimplementedPort()` для модулів-заглушок (501)                                                     |

Правила:

- Під час паралельної розробки модулів файли були заморожені, зміни йшли через `docs/contract-requests/`
  (усі запити закрито 2026-11-01, рішення - `docs/INTEGRATION_NOTES.md`). Тепер контракт змінюють разом
  із реалізацією і споживачами в одному рев'ю; нова подія потребує споживача або запису в
  `src/common/outbox/audit-only-events.ts` (перевіряє `test/e2e/outbox-routes.e2e-spec.ts`), новий код
  помилки - запису в `*_ERROR_CODES` (перевіряє `error-codes.spec.ts`).
- Тільки типи, константи та чисті функції без імпортів з NestJS і Prisma (єдиний виняток -
  type-only імпорт `Tx` у `shared.ts`). Файл має компілюватися окремо від модуля, який його реалізує.
- Назви подій outbox - константи (`RECEIPT_EVENTS.credited === 'receipt.credited'`), payload -
  type-аліаси `<Event>Payload` з датами у форматі ISO-рядків.
- Коди помилок кожного модуля зарезервовані у `<module>.ts` (`*_ERROR_CODES`); модуль реєструє їх
  через `defineErrorCodes` у своєму `domain/errors.ts`.
- Кроссмодульні типи, що потрібні всім (гроші, пагінація, помилки), живуть у `src/common/*`, а не тут.
- Барел-файл `index.ts` не створюємо: імпортуйте напряму
  `import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../common/contracts/club';`.

## Зміни після рецензій (01.11.2026)

| Контракт           | Що змінилося                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.ts`      | `GENDERS`, `PROFILE_FIELDS` (7 полів профілю: firstName, lastName, birthDate, email, gender, city, children), нові коди помилок (діти, TOTP, блокування входу, капча, бюджет SMS)                                                              |
| `club.ts`          | `PointsDisplayInput` (`title`, `subtitle`, `counterparty: PointsCounterparty`) для всіх записів леджера; повернення списання в початкові кошики                                                                                                 |
| `content.ts`       | `ContentPort.getTenantSummaryById` (картка орендаря: `TenantDisplaySummary`); `canonicalFiscalNumber()` - спільний канонічний номер каси (content і receipts)                                                                                  |
| `receipts.ts`      | `ReceiptsPort.getPendingSummary(userId)` -> `{ count, expectedPoints }` (картка клубу; club шукає порт ліниво, без імпорту модуля)                                                                                                             |
| `payments.ts`      | `createPayment` більше не приймає транзакцію викликача (провайдер - поза транзакцією), спроби `<ключ>:a<n>`; `getPayments(ids)`; `requestRefund(AutoRefundRequest)` -> `AutoRefundResult` (`queued`, `already_queued`, `not_refundable`)         |
| `notifications.ts` | вид `payment_refunded` (повернення паркінгового платежу)                                                                                                                                                                                      |
| `events.ts`        | `user.profile_field_completed`, `parking.session.disputed`, `parking.payment.ops_alert`, `support.request_created`; `payment.succeeded.late`; `payment.refunded` тепер споживає notifications                                                 |
| `admin.ts`         | звернення в підтримку (`SupportRequestTopic`, `SupportRequestStatus`, `SUPPORT_REQUESTS_PER_DAY`)                                                                                                                                             |

English summary: one contract file per module plus `shared.ts`, `events.ts` and `port-stub.ts`;
frozen during the module phase (all requests closed on 2026-11-01); now changed together with the
implementation and consumers; types and constants only, no Nest or Prisma runtime imports. The review
fixes of 2026-11-01 added `ContentPort.getTenantSummaryById`, `ReceiptsPort.getPendingSummary`,
`PaymentsPort.getPayments` / `requestRefund` (and `createPayment` without a caller transaction), ledger
display data, profile fields, the `payment_refunded` notification kind and four new outbox events.
