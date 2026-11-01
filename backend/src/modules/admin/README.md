# Модуль admin

Бек-офіс поверх інших модулів: ручні коригування балів із правилом «чотирьох очей», читання
журналу аудиту, CRUD feature flags, щоденні звіти (`daily_stats`, черга `reports-nightly`) і звернення
учасників у підтримку («Звернення», `support_requests`).
RBAC-guard-и живуть у `src/common/auth`; запис аудиту (`ADMIN_AUDIT_PORT`, `AuditService`) і читання
прапорців (`FEATURE_FLAGS_PORT`, `FeatureFlagsService`) реалізовані у `src/common/audit` та
`src/common/feature-flags` як глобальні модулі, бо їхні таблиці лежать у `base.prisma`, а потрібні
вони всім модулям (admin залежить від усіх, тож інакше виник би цикл). Admin ці порти споживає, як і
решта модулів, і не перевизначає їх. CRUD тенантів, винагород, акцій тощо хостить модуль-власник
таблиць (див. `docs/FOUNDATION_SUMMARY.md`, розділ 10); `/admin/auth/*` і `/admin/users` - identity.

English summary: manual point adjustments with four-eyes approval through CLUB_LEDGER_PORT
(including cumulative caps against split adjustments), audit log reads, feature flag CRUD, nightly
daily reports and member support requests (e-mailed to SUPPORT_EMAIL by notifications). Provides no
port (root of the module graph).

## Модель

| Таблиця (файл схеми)                  | Призначення                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual_adjustments` (`admin.prisma`) | заявка на коригування: `accountId`, `userId` (власник рахунку, копіюється з `CLUB_LEDGER_PORT.getBalance` при заявці), `amount` (знаковий, бали), `reason`, `requestedById`, `approvedById`, `status`, `pointsTxId`, `thresholdPoints` (500 на момент заявки), `decidedAt`, `appliedAt`, `rejectionReason`                                            |
| `daily_stats` (`admin.prisma`)        | один рядок на календарний день Києва, `stats` - JSON звіту (`DailyReport`)                                                                                                                                                                                                                                                                            |
| `support_requests` (`admin.prisma`)   | звернення: `number` (людський номер із послідовності `support_requests_number_seq`, старт 1001), `userId` (FK у SQL), `topic` (`receipt`/`parking`/`voucher`/`other`), `relatedType?`, `relatedId?`, `message`, `photoKey?` (`support/<userId>/...`), `status` (`new`/`in_progress`/`resolved`/`closed`), `adminNote?`, `resolvedById?`, `resolvedAt?` |
| `feature_flags` (`base.prisma`)       | admin - єдиний модуль, що пише сюди (CRUD); читання - `FEATURE_FLAGS_PORT` з кешем 5 с                                                                                                                                                                                                                                                                |
| `audit_logs` (`base.prisma`)          | append-only; admin лише читає, пише кожен модуль через `ADMIN_AUDIT_PORT`                                                                                                                                                                                                                                                                             |

Баланс і рядки леджера належать club: коригування пишеться лише через `CLUB_LEDGER_PORT`
(`credit` з `type: 'adjust'` для нарахування, `spend` для списання) з ключем ідемпотентності
`adjustment:<id>`, `sourceType: 'manual'`, `createdById` = адміністратор, що застосував. Таблиць club
модуль не читає: `userId` зберігається в рядку коригування (фільтр `GET /admin/adjustments?userId=`
іде за цією колонкою, індекс `(user_id, created_at)`), порт леджера питається лише під час заявки.

Доступ: усі ендпоїнти під `@Auth('admin', ...)`; спільний `AdminGuard` додатково відхиляє токени
деактивованих адміністраторів (403 `PC_ADMIN_INACTIVE`) і токени зі зміненою роллю (401
`PC_AUTH_TOKEN_INVALID`), питаючи identity з кешем `ADMIN_ACCESS_CACHE_SECONDS` (30 с).

## Машина станів коригування

```
pending --(інший адміністратор)--> approved --(запис у леджер)--> applied
pending --> rejected
approved --> rejected        (леджер відмовив, коригування відкликали)
```

- Заявник вирішує сам, лише якщо водночас: `|amount| <= 500` (`FOUR_EYES_THRESHOLD_POINTS`), сума його
  самостійно затверджених коригувань за поточний день Києва разом із новим не перевищує 500 і сума
  самостійно затверджених коригувань цільового рахунку за останні 24 години (будь-ким) разом із новим не
  перевищує 500 (суми за модулем, списання теж рахуються). Тоді рядок створюється одразу `approved` і в
  тій самій транзакції застосовується (`applied`); якщо леджер відмовляє, відкочується все.
- Інакше рядок лишається `pending` з `secondApprovalReason` (`amount` | `requester_daily_total` |
  `account_24h_total`); затвердити може лише інший адміністратор (`PC_ADJUSTMENT_SELF_APPROVAL`, 422).
  Розбиття 900 балів на 3 x 300 більше не обходить «чотири очі»: друга частина вже чекає на іншого.
- Суми читаються під транзакційними advisory-блокуваннями (спершу заявник, потім рахунок), тож
  паралельні запити не проскакують під поріг. Ескалація через накопичені суми пишеться в лог
  (`warn`, мітка `FOUR_EYES_CUMULATIVE` - для алерта на повтори) і в аудит (`selfApprovedTotals`).
  «Самостійно затверджені» - рядки `approved`/`applied` із `secondApprovalReason = null`; старі рядки
  понад поріг заповнює `amount` SQL-бекфіл. Затвердження комітиться окремо, потім пишеться леджер;
  якщо леджер відмовив (наприклад `PC_POINTS_INSUFFICIENT` для списання), рядок лишається `approved`,
  помилка повертається з `details.adjustmentStatus = 'approved'`, повтор - `POST /admin/adjustments/:id/apply`.
- Застосування серіалізується `SELECT ... FOR UPDATE` по рядку коригування; повторний запис у леджер
  неможливий завдяки ключу `adjustment:<id>`.
- Кожен крок аудитується (`manual_adjustment.request|approve|apply|reject`) і публікує подію outbox
  `adjustment.requested|approved|applied|rejected`.
- Чисті правила - `domain/adjustment-rules.ts` (табличний тест переходів).

## Ендпоїнти (префікс `/api/v1`, усі `@Auth('admin', ...)`, `owner` проходить будь-яку перевірку ролей)

| Метод і шлях                          | Ролі                        | Опис                                                                                                              |
| ------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /admin/adjustments`             | manager, support            | заявка на коригування (`Idempotency-Key`); у межах 500 балів (разом із накопиченими сумами) застосовується одразу |
| `GET /admin/adjustments`              | manager, moderator, support | список, `?status=&userId=&cursor=&limit=`                                                                         |
| `GET /admin/adjustments/:id`          | manager, moderator, support | одне коригування                                                                                                  |
| `POST /admin/adjustments/:id/approve` | manager                     | друге затвердження і запис у леджер (`Idempotency-Key`)                                                           |
| `POST /admin/adjustments/:id/apply`   | manager                     | повтор запису в леджер для `approved` (`Idempotency-Key`)                                                         |
| `POST /admin/adjustments/:id/reject`  | manager                     | відхилення `pending` або `approved` з причиною                                                                    |
| `GET /admin/audit`                    | manager, moderator, support | пошук: `entityType`, `entityId`, `actorType`, `actorId`, `action` (точна або `prefix.*`), `from`, `to`            |
| `GET /admin/audit/:id`                | manager, moderator, support | один запис аудиту                                                                                                 |
| `GET /admin/feature-flags`            | manager, moderator, support | усі прапорці                                                                                                      |
| `GET /admin/feature-flags/:key`       | manager, moderator, support | один прапорець                                                                                                    |
| `PUT /admin/feature-flags/:key`       | manager                     | створити або змінити (`{ enabled, payload?, reason? }`), подія `flag.updated`                                     |
| `DELETE /admin/feature-flags/:key`    | manager                     | видалити (читачі повертаються до значень за замовчуванням)                                                        |
| `GET /admin/reports/daily`            | manager, moderator, support | збережений звіт за день (`?day=`, за замовчуванням учора за Києвом)                                               |
| `GET /admin/reports/daily/range`      | manager, moderator, support | звіти за `?from=&to=` (включно, до 92 днів)                                                                       |
| `POST /admin/reports/daily/recompute` | manager                     | перерахувати і зберегти звіт за день (аудитується)                                                                |
| `GET /admin/support-requests`         | manager, support            | звернення, нові першими, `?status=&userId=&cursor=&limit=`                                                        |
| `GET /admin/support-requests/:id`     | manager, support            | одне звернення з короткоживучим посиланням на фото (`photoUrl`)                                                   |
| `PATCH /admin/support-requests/:id`   | manager, support            | `{ status, note? }`: зміна статусу та/або примітка (аудит `support_request.status_change` / `.note`)              |

## Звернення в підтримку

Учасник (`@Auth('member')`, хостить admin, бо таблиця тут):

| Метод і шлях                              | Опис                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /support/requests`                  | `{ topic, relatedType?, relatedId?, message, photoKey? }` (`Idempotency-Key`) -> `{ id, number }`; 5 на день Києва (`PC_SUPPORT_REQUEST_DAILY_LIMIT`, 429, `details.retryAfter`) |
| `GET /support/requests`                   | мої звернення, нові першими (`cursor`, `limit`)                                                                                                                                  |
| `POST /support/requests/photo-upload-url` | presigned PUT для фото (JPEG/PNG/WEBP/HEIC до 5 МБ) під `support/<userId>/...`; чужий ключ - `PC_SUPPORT_REQUEST_PHOTO_INVALID`                                                  |

Стан-машина: `new -> in_progress | resolved | closed`, `in_progress -> resolved | closed`,
`resolved -> in_progress | closed`, `closed` фінальний; PATCH з поточним статусом лише оновлює примітку.
Перехід у `resolved`/`closed` записує `resolvedById` і `resolvedAt`, повернення в роботу їх скидає.
Ліміт 5 на день рахується під advisory-блокуванням учасника. Створення публікує
`support.request_created` (номер, тема, текст, фото, учасник); notifications надсилає лист на
`SUPPORT_EMAIL` і підтвердження учаснику «Звернення № N прийнято». Чисті правила -
`domain/support-rules.ts`.

Звіт містить: чеки за статусами (`RECEIPTS_PORT`), бали нараховані/списані/згорілі/сторновані
(`CLUB_LEDGER_PORT`), ваучери видані/погашені/живі (`VOUCHER_ISSUER_PORT`), паркувальні сесії
(`PARKING_PORT`) і власні ручні коригування. Збій джерела не валить звіт: секція `null`, код
помилки в `errors`, `complete: false`.

## Задачі воркера

| Черга             | Задача        | Розклад                    | Що робить                                                                                   |
| ----------------- | ------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `reports-nightly` | `compute-day` | `20 0 * * *` (Europe/Kyiv) | рахує вчорашній день і досчитує до 3 попередніх днів без рядка (`catchUpDays`, максимум 31) |
| `admin-events`    | `user.deleted` | outbox (маршрут у `AdminModule.onModuleInit`) | очищення звернень видаленого учасника, див. нижче                              |

Логіка - чисті функції `runReportsNightly` (`jobs/reports-nightly.job.ts`) і `handleAdminEventJob`
(`jobs/admin-events.handler.ts`), обидві з юніт-тестами; процесори лише підключають сервіси. Запуск
звіту о 00:20 - до задачі згоряння балів club о 03:30.

**Видалення акаунта (`user.deleted`).** Фото звернень учасника видаляються зі сховища (відсутній об'єкт
не заважає), `photo_key` очищується, текст замінюється на «Текст звернення видалено разом з акаунтом
учасника.» (`SupportRequestsService.eraseUserRequests`, ідемпотентно). Номер, тема, пов'язаний об'єкт,
статус і примітка підтримки лишаються як історія обробки. Поза межами очищення: лист, уже надісланий на
`SUPPORT_EMAIL`, і payload `support.request_created` в outbox (видаляється через 7 днів після
публікації); примітки підтримки не мають містити персональних даних.

## Змінні середовища

Власних немає. Листи про звернення: спільна `SUPPORT_EMAIL` і секція `mail` модуля notifications.

## Схема й SQL (2026-11-01)

`manual_adjustments.second_approval_reason`, індекси `(requested_by_id, created_at)`,
`(account_id, created_at)`, enum `SupportRequestTopic`/`SupportRequestStatus` і таблиця
`support_requests` - у `prisma/schema/admin.prisma`. Послідовність номера, FK (`users`, `admin_users`),
CHECK, бекфіл `second_approval_reason = 'amount'` і часткові індекси (самостійно затверджені
коригування, відкриті звернення) - у міграції `prisma/schema/migrations/20261101180000_review_fixes`
(розділи 0, 2.6 і 3.6; послідовність створюється до таблиці). Початковий файл - архів
`docs/pending-sql/applied/promos-notifications-admin.sql`.

## Тести

`npx jest src/modules/admin`: домен (переходи, кумулятивні пороги «чотирьох очей», правила звернень,
фільтр аудиту, звіт, курсор, прапорці), сервіси (`SupportRequestsService` - номер, ліміт 5 на день
Києва, фото, статуси й аудит; `AdjustmentsService` - чотири очі, розбиття сум, блокування, робота з леджером, `userId` у рядку без читання таблиць club,
`FeatureFlagsAdminService`, `ReportsService`, `AuditLogService`) на in-memory фейках, задача
`reports-nightly`. E2E: `npx jest --config test/jest-e2e.config.js test/admin` - маршрути, ролі,
`Idempotency-Key`, валідація без БД; `test/admin/support.e2e-spec.ts` - маршрути звернень (учасник і
бек-офіс), ролі, валідація, маршрут `support.request_created` до notifications.

## Відкриті питання

1. Поріг «чотирьох очей» зафіксовано константою 500 балів (BRIEF розділ 4) і для разових, і для
   накопичених сум (день Києва на заявника, 24 год на рахунок); чи потрібне налаштування через rule set
   club - питання до замовника.
2. Списання ручним коригуванням підкоряється правилам леджера (недостатньо балів, негативний баланс;
   блок новачка на ручні списання не діє); чи потрібен адміністратору «примусовий» режим - питання до
   замовника.
3. Строк зберігання звернень (і листів у скриньці `SUPPORT_EMAIL`) після вирішення - питання до
   замовника; текст і фото видаленого учасника вже очищує споживач `admin-events`.
4. Учасник не отримує сповіщення про зміну статусу звернення (лише підтвердження створення).

Закрито під час консолідації рецензії (01.11.2026): споживач `user.deleted` (черга `admin-events`)
очищує текст і фото звернень видаленого учасника.

Закрито під час інтеграції (2026-11-01): колонка `manual_adjustments.user_id` (запит admin-1 до схеми,
міграція `20261101120000_module_requests` заповнює її з `loyalty_accounts`), коди
`PC_ADJUSTMENT_AMOUNT_INVALID`, `PC_ADJUSTMENT_ACCOUNT_NOT_FOUND`, `PC_FEATURE_FLAG_KEY_INVALID`,
`PC_REPORT_DAY_INVALID` внесено в `ADMIN_ERROR_CODES`.
