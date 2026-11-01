# Нотатки інтеграції

Журнал відхилень від плану та BRIEF, обмежень середовища і рішень, які впливають на інші модулі.
Кожен агент дописує у свій розділ; дати у форматі YYYY-MM-DD. English summary per entry is welcome.

## Розбіжності між BRIEF і планом розробки та відхилення від BRIEF

- 2026-11-01, integration: демо-часова лінія паркінгу йде за каноном дизайну (`design/v2/CONVENTIONS.md`):
  в'їзд 14:00, безкоштовно до 14:30, 60 грн о 15:20, оплачено до 16:00, виїзд 15:52. BRIEF розділ 11 називає
  14:12 / 14:42, але з 14:12 тариф дає «60 грн о 15:20» лише з виїздом до 16:12. Seed і емулятор узгоджені.
- 2026-11-01, integration: адреса ТРЦ - `просп. Соборності, 43, Луцьк` (типове `MALL_ADDRESS`); попереднє
  типове «вул. Сухомлинського, 1» - лише додаткова паркувальна локація з правил оператора.
- 2026-11-01, integration: до черг BRIEF розділ 9 додано `content-import` (асинхронний імпорт WordPress),
  `receipts-events` і `payments-events` (очищення персональних даних за `user.deleted`) поряд із
  черговими споживачами подій фундаменту (`club-events`, `rewards-events`, `promos-events`,
  `parking-events`, `notifications-events`).
- 2026-11-01, integration: BRIEF не описує таблицю заявок на купон; додано `coupon_claims` (запит promos-1).
- 2026-11-01, integration: `docker-compose.yml` запускає стек з `NODE_ENV=development` (локальне демо):
  у production емулятор паркінгу, мок-платежі, `SMS_PROVIDER=log` і dev-секрети відхиляються при старті.
- 2026-11-01, integration: admin access-токен (8 год) лишився без refresh-токенів; замість таблиці
  admin-сесій спільний `AdminGuard` перевіряє активність і роль адміністратора (див. рішення нижче).

## Обмеження середовища та обхідні шляхи

- 2026-10-30, foundation: Docker, PostgreSQL і Redis локально недоступні; усе, що їх потребує,
  виконується лише в CI (сервісні контейнери). Локально перевірені `typecheck`, `lint`, `test:unit`,
  `test:e2e` (без БД) і `build`.
- 2026-10-30, foundation: шлях репозиторію містить кирилицю, домашній каталог - пробіл; npm, tsc, jest,
  eslint і prisma працюють без обхідних шляхів.
- 2026-11-01, integration: `prisma/seed.ts` не завантажувався через `ts-node` з TypeScript 6
  (TS5011: при `outDir` потрібен явний `rootDir`), тобто `npm run db:seed` у CI впав би з першого запуску.
  У `tsconfig.json` додано `"rootDir": "./"` (збірка має власний `rootDir: ./src` у `tsconfig.build.json`,
  `dist/main.js` не змінився). Локально seed тепер компілюється і падає лише на підключенні до БД.
- 2026-11-01, integration: міграцію `20261101120000_module_requests` згенеровано без БД
  (`prisma migrate diff --from-schema-datamodel <копія схеми до змін> --to-schema-datamodel prisma/schema --script`)
  і доповнено вручну; застосування (`prisma migrate deploy`), seed (двічі, перевірка ідемпотентності),
  `test:int` і e2e проти PostgreSQL виконує лише CI.

## Рішення фундаменту (common layer)

- 2026-10-30: NestJS 12 (core 12.3.x; swagger, bullmq, terminus, config на 12.x), Prisma 6.19.3,
  BullMQ 6.5.x, ioredis 5.11.x (BullMQ 6 оголошує ioredis як optional peer `>=5`; свіжий ioredis 6.0.0
  не брали заради стабільності), TypeScript 6.0.x (Nest CLI 12 залежить від `~6.0`, typescript-eslint
  підтримує `<6.1`), ESLint 9.39 flat config, Jest 30 з `@swc/jest`.
- 2026-10-30: `exactOptionalPropertyTypes` вимкнено (BRIEF дозволяє, якщо шаблон не компілюється);
  `strictPropertyInitialization` вимкнено як у шаблоні Nest заради DTO. Решта strict-опцій увімкнена.
- 2026-10-30: додано `QUEUE_DRIVER=redis|memory` поверх BRIEF: BullMQ-черга підключається до Redis одразу
  при створенні, тому без драйвера `memory` тести та `npm run openapi` не могли б підняти `AppModule`.
  Модулі реєструють черги через `QueueModule.registerQueue(...)`, токени ті самі, що в `@InjectQueue`.
- 2026-10-30: `prisma` CLI у `dependencies` (а не dev), бо entrypoint контейнера виконує `prisma migrate deploy`.
- 2026-10-30: події outbox без зареєстрованого споживача не губляться одразу: повторюються до 60 проходів
  диспетчера (близько 5 хв), потім скидаються з error-логом.
- 2026-10-30: `/ready` обгортає відповідь terminus у problem+json (503, `PC_COMMON_SERVICE_UNAVAILABLE`,
  деталі по індикаторах у `details`).
- 2026-10-30: пакети `@nestjs/*` 12 постачаються лише як ESM; код збирається у CommonJS (Node 24 підтримує
  `require(esm)`), а Jest 30 потребує `--experimental-vm-modules`, який `.npmrc` (`node-options`) додає до
  всіх npm-скриптів і `npx`. Без npm (IDE-інтеграції) потрібен `NODE_OPTIONS=--experimental-vm-modules`.
- 2026-10-30: TypeScript 6 більше не підключає всі `@types/*` автоматично, тому в `tsconfig.json` явно
  вказано `"types": ["node", "jest"]` (як у шаблоні Nest 12).
- 2026-10-30: `QueueModule.registerQueue()` повертає динамічний модуль класу `QueueFeatureModule`, а не
  `QueueModule`: інакше Nest створював окрему копію `QueueRegistry`/`WorkerSchedules` для кожного модуля,
  що реєструє чергу (виявлено e2e-тестом).
- 2026-10-30: локальна перевірка фундаменту: `typecheck`, `lint`, `test:unit` (172 тести), `test:e2e`
  (4 тести без БД), `build` (`dist/main.js`, `dist/worker.js`), `node dist/scripts/openapi.js` і запуск
  `node dist/main.js` без PostgreSQL/Redis (`/health` 200, 404 у форматі problem+json) - зелені.
  `test:int`, міграції, seed і docker build перевірить CI.

## Рішення склейки (GLUE, фундамент + схема перед модулями)

- 2026-10-30: формат scrypt-хешів уніфіковано як PHC-рядок `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt b64>$<hash b64>`
  (так пише `prisma/seed.ts` для пароля адміністратора і PIN валідатора, так задокументовано в схемі).
  `hashPassword` тепер видає PHC (N=2^15, r=8, p=1, 64 байти), `verifyPassword` приймає PHC у будь-якому
  порядку параметрів і старий формат `scrypt$N$r$p$salt$hash`. Без цього seed-адміністратор не зміг би увійти.
- 2026-10-30: `AuditLog` і `FeatureFlag` лежать у `base.prisma`, а запис аудиту потрібен кожному модулю,
  тоді як admin залежить від усіх - виник би цикл. Тому `ADMIN_AUDIT_PORT` (`AuditService`) і
  `FEATURE_FLAGS_PORT` (`FeatureFlagsService`, кеш 5 с, `invalidate()`) реалізовано у `src/common/audit`
  і `src/common/feature-flags` як глобальні модулі; admin лише читає журнал і веде CRUD прапорців.
- 2026-10-30: контракти `src/common/contracts/*.ts` написано і заморожено на час паралельної розробки
  (один файл на модуль + `shared.ts`, `events.ts`, `port-stub.ts`); зміни - через `docs/contract-requests/`.
  Порти приймають `tx` останнім аргументом, щоб приєднуватися до транзакції викликача.
- 2026-10-30: кожен модуль-заглушка надає свій токен через `unimplementedPort()` (501 `PC_COMMON_NOT_IMPLEMENTED`),
  тож `AppModule` стартує завжди, а e2e-тести можуть робити `overrideProvider(TOKEN)`. Граф імпортів модулів
  ациклічний і зафіксований у `docs/FOUNDATION_SUMMARY.md` (розділ 4); `test/e2e/ports.e2e-spec.ts` перевіряє
  наявність усіх токенів.
- 2026-10-30: до `QUEUES` додано черги-споживачі подій `club-events`, `rewards-events`, `promos-events`,
  `parking-events`, `notifications-events` (ім'я задачі = тип події), щоб не змішувати споживання outbox
  із власними робочими чергами з BRIEF розділ 9.
- 2026-10-30: `PARKING_EMULATOR_SCENARIO` став enum `free | payable | paid | closed` (типово `payable`) -
  як у seed; попереднє значення `prototype` прибрано з `.env.example`.
- 2026-10-30: адмін-ендпоїнти хостить модуль-власник таблиць (identity - `/admin/auth/*`, `/admin/users`;
  receipts - модерація; content/rewards/promos/club/parking/payments - свої CRUD), admin - коригування,
  аудит, прапорці, звіти. Композитні екрани бек-офісу збирає клієнт.
- 2026-10-30: оформлення `docs/*.md` і `src/common/contracts/README.md` оновлено; `docs/FOUNDATION_SUMMARY.md`
  (англійською) - обов'язковий вступ для модульних агентів.

## Рішення схеми (відхилення та розширення відносно BRIEF розділ 4)

- `Voucher.code` nullable (видається при активації), унікальність лише через частковий індекс
  `vouchers_code_live_key WHERE status IN ('issued','active')`; Prisma `upsert` не може цілитися в `code`,
  погашення - атомарний `UPDATE ... WHERE status = 'active' AND activation_expires_at > now()`.
- `ValidatorDevice.tenantId` nullable (пристрої інфостійки ТРЦ). `Tenant.category`, `Notification.kind`,
  `NotificationPreference.kind` - рядки, реєстри живуть у коді (`TENANT_CATEGORIES`, `NOTIFICATION_KINDS`
  у контрактах). `Event` не має `tenantId`.
- Додаткові колонки: `Device.fingerprint`, `AdminUser.name`, `Payment.refundedKopecks/paidAt`,
  `PaymentWebhookLog.paymentId`, `Receipt.updatedAt`, `ReceiptAppeal.resolvedById/resolution`,
  `Vehicle.verifiedAt`, `LoyaltyRuleSet.note`, `ContentImportRun.status/error`,
  `ManualAdjustment.decidedAt/appliedAt/rejectionReason`, таблиця `daily_stats` (admin, `reports-nightly`).
- Іменування: `PointsTransaction.createdById` (зв'язок з AdminUser, `onDelete: Restrict`),
  `LoyaltyRuleSet.createdById`, `ParkingTariff.createdById`, `TenantFiscalNumber.confirmedById`;
  `Receipt.moderatorId` як у BRIEF.
- Outbox має і повний індекс `outbox_events_published_at_idx` (з `base.prisma`), і частковий
  `outbox_events_unpublished_idx`; надлишковий повний можна прибрати при наступній міграції.
- Тригер `points_transactions_append_only` порівнює `to_jsonb(NEW) - 'state'` з `to_jsonb(OLD) - 'state'`:
  no-op оновлення проходять, будь-яка зміна крім `state` - `restrict_violation`, дозволені переходи
  лише `pending -> available|cancelled`, `available -> spent|expired` (`check_violation`). `audit_logs`
  відхиляє UPDATE/DELETE. Часткові індекси, CHECK і тригери невидимі для Prisma (drift не показується).
- Контракти seed: PHC scrypt для паролів і PIN; `ValidatorDevice.deviceKeyHash = sha256 hex` сирого
  `X-Validator-Key`; баланс = сума `amount` за рядками у станах available/spent/expired; демо-рахунок
  320 доступних, 380 lifetime, 6 транзакцій; `PARKING_EMULATOR_SCENARIO` формує демо-сесію на сьогодні.
  Seed не виконувався локально (немає PostgreSQL); перевіряє CI.

## Рішення інтеграції (2026-11-01)

- **Перевірка адміністратора в спільному `AdminGuard`.** Обрано перевірку активності й ролі на кожному
  admin-запиті, а не короткий TTL з admin refresh-токенами. `AdminAccessGate` (`src/common/auth/admin-access.ts`,
  глобальний) отримує резолвер від identity (`IdentityPort.getAdminAccess`, реєструється в
  `IdentityModule.onModuleInit`), бо спільний шар не може імпортувати доменний модуль. Відповідь кешується на
  `ADMIN_ACCESS_CACHE_SECONDS` (типово 30 с); identity скидає кеш після зміни ролі, активності чи пароля.
  Деактивований або невідомий адміністратор - 403 `PC_ADMIN_INACTIVE`, змінена роль - 401
  `PC_AUTH_TOKEN_INVALID`, збій перевірки - 503. Перевірка діє на всі `/admin/*` усіх модулів;
  `ActiveAdminGuard` identity прибрано. TTL admin-токена лишився 8 год (`ADMIN_ACCESS_TTL_SECONDS`).
  У e2e перевірку вимкнено за замовчуванням (`createTestApp({ adminAccessCheck: true })` вмикає), бо
  тести підписують токени для адміністраторів, яких немає в сховищі.
- **Жодна подія outbox не губиться.** `OutboxRouter.ignore(type, reason)` і список
  `src/common/outbox/audit-only-events.ts` позначають події, які навмисно ніхто не споживає (факт у
  журналі outbox); диспетчер одразу позначає їх опублікованими (`ignored` у результаті такту) замість
  5 хвилин повторів і error-логу. `test/e2e/outbox-routes.e2e-spec.ts` на повному `AppModule` перевіряє:
  кожен тип каталогу має маршрут або статус "лише аудит", немає застарілих записів у списку, усі черги
  маршрутів зареєстровані, `user.deleted` іде в notifications, parking, payments, receipts і rewards (з
  01.11.2026 - також admin: тексти й фото звернень).
- **Видалення акаунта (`user.deleted`).** receipts (`receipts-events`): видаляє фото чеків і оскаржень зі
  сховища, очищає ключі фото і тексти оскаржень, фіскальні дані лишаються. parking (`parking-events`):
  м'яко видаляє авто й маскує номери (`erased-<hex>`), прибирає номер із закритих сесій, від'єднує
  активні. payments (`payments-events`): прибирає персональні ключі з `meta` (номер авто, ім'я, контакти)
  і опис з номером; суми й статуси лишаються (фінансовий облік). notifications: видаляє скриньку і
  налаштування. rewards: скасовує живі ваучери без повернення балів. club тримає анонімного власника
  в леджері; promos отримує скасування квитків через `voucher.cancelled`.
- **Сирі тіла вебхуків.** `rawBody: true` у `src/main.ts` і в `test/utils/app-factory.ts`; підписи
  `X-Mock-Signature` (payments) і `X-Parking-Signature` (parking) рахуються від точних байтів тіла
  (канонічний JSON лише як запасний шлях, коли сирого тіла немає). Внутрішня доставка мок-checkout
  підписує той самий рядок, який передає як сире тіло.
- **Порти без заглушок.** Усі дев'ять портів мають справжні реалізації; `test/e2e/ports.e2e-spec.ts`
  перевіряє класи реалізацій і реєстрацію резолвера адміністратора (`unimplementedPort()` лишився для
  майбутніх модулів).
- **Граф модулів після інтеграції** (ациклічний): identity, payments - листки; club -> identity;
  content -> club; receipts -> content, club; parking -> payments; rewards -> club, content, parking;
  promos -> rewards, content; notifications -> identity, promos; admin -> усі. Зміна відносно
  FOUNDATION_SUMMARY: content імпортує `ClubModule` (базова ставка), notifications - `PromosModule`.
- **Змінні середовища.** `.env.example` містить усі змінні спільної схеми і всіх модульних секцій
  з українськими коментарями й безпечними dev-значеннями; `src/common/config/env-example.spec.ts`
  перевіряє повноту і те, що dev-значення проходять усі схеми, а в production відхиляються.
  Спільна схема тепер звужує `PARKING_PROVIDER` (`emulator | vendor`), `PAYMENTS_PROVIDER` (провайдери
  контракту) і `PUSH_PROVIDER` (`stub | fcm`) і в production відхиляє емулятор паркінгу та мок-платежі;
  identity відхиляє `SMS_PROVIDER=log` у production. Захист dev-секретів у production: `JWT_SECRET`,
  `OTP_PEPPER`, `VOUCHER_PEPPER`, `MEMBER_QR_SECRET` (спільна схема), `PARKING_WEBHOOK_SECRET` (parking),
  `PAYMENTS_MOCK_WEBHOOK_SECRET` (payments), `OTP_DEV_ECHO` (identity).
- **Коди помилок.** Контрактні `*_ERROR_CODES` тепер точно збігаються з кодами, які модулі реєструють
  (`src/common/contracts/error-codes.spec.ts`); identity мав ще 12 незапитаних кодів - їх теж внесено.
- **OpenAPI і `docs/API.md`.** `@Auth()`, `@Public()` і `@Roles()` додають розширення `x-auth` і `x-roles`;
  `npm run docs:api` будує `docs/API.md` (таблиці за тегами, бек-офіс - за сегментом `/admin/<група>`,
  ролі, `Idempotency-Key`) скриптом `src/scripts/api-md.ts`; CI перевіряє, що `docs/API.md` не застарів.
  Додано схеми безпеки `validator-shift` і `validator-pin` (останню прибрано 01.11.2026: PIN приймає лише
  `POST /validator/shift`), теги `vouchers` і `validator`.
- **Скрипти й CI.** `npm test` = unit + int (самопропуск без БД) + e2e; `npm run test:all` = unit + e2e.
  CI: job `checks` (lint, typecheck, prisma validate/generate, unit, build, OpenAPI, перевірка API.md,
  docker build) і job `integration` з PostgreSQL 17 і Redis 7: `prisma migrate deploy`, seed двічі,
  `test:int`, `test:e2e`.

## Рецензія та виправлення (01.11.2026)

Після інтеграції код пройшов три незалежні рецензії: **безпеки** (HTTP, логи, сховище, вхід, чеки),
**грошей і леджера** (бали, ваучери, платежі, тариф, ідемпотентність) і **відповідності прототипу**
(екрани учасника, картки, паркінгу, акцій і подій, винагород і ТРЦ). Рецензенти відтворювали знахідки
тестами; п'ять агентів виправили їх у своїх модулях, інтеграція зібрала SQL у міграцію
`prisma/schema/migrations/20261101180000_review_fixes` (початкові файли - архів `docs/pending-sql/applied/`),
застосувала seed-нотатки, доповнила `.env.example` і закрила залишки. Самі звіти рецензій у репозиторії
не зберігаються; нижче - зведення за впливом (критичність оцінена інтеграцією за наслідками).

### Критичні: гроші й бали

| Знахідка (рецензія)                                                                                                                       | Виправлення                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Той самий чек зараховувався кілька разів (тим самим і іншими учасниками), якщо переписати номер: провідні нулі, регістр, дефіси (безпека) | канонічні `fn` і `fiscal_id` у парсері QR, ручній формі й білому списку (`canonicalFiscalNumber`, `canonicalFiscalId`), унікальний ключ на канонічних значеннях, сирі - у `fn_raw`/`fiscal_id_raw`; міграція канонізує наявні рядки зі звітом колізій (RUNBOOK 4.1) |
| Підроблений QR (справжня каса + вигадані номер і сума) зараховувався одразу без жодних обмежень (безпека)                                 | утримання на 24 год для нових акаунтів і чеків понад 500 грн, денний ліміт 150 балів за QR-чеки, шаблони шахрайства на модерацію, `TaxReceiptVerifierPort` і задача `verify-held` (адаптер поки noop - залишковий ризик)                                            |
| «Обмін, потім скасування» поновлював 12-місячний строк балів, що мали скоро згоріти (безпека, леджер)                                     | `points_spend_allocations`: повернення списання йде в ті самі кошики з початковою датою; прострочені порції згоряють одразу                                                                                                                                         |
| Активація ваучера паралельно зі скасуванням «воскрешала» скасований ваучер (леджер)                                                       | `SELECT ... FOR UPDATE` і умовні записи за статусом, єдиний порядок блокувань ваучер -> винагорода -> рахунок                                                                                                                                                       |
| Успіх оплати, що прийшов після звіряння, яке прострочило платіж, ігнорувався: гроші списано, сесію не оплачено (леджер)                   | звіряння спершу скасовує checkout у провайдера; пізній успіх застосовується (`late: true`); parking один раз на платіж вирішує: застосувати, автоматично повернути (`requestRefund` + ops alert) або лишити для звірки                                              |
| Той самий `Idempotency-Key` на іншому `:id` того самого маршруту повертав збережену відповідь чужого ресурсу (безпека, леджер)            | конкретний шлях у хеші запиту: такий повтор - 409 mismatch; оренда ключа «в роботі» `IDEMPOTENCY_LEASE_SECONDS` (120 с) замість вічного блокування після падіння                                                                                                    |

### Високі: безпека й цілісність

| Знахідка                                                                                                                                         | Виправлення                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Після відхиленої картки учасник не міг заплатити за ту саму годину: той самий ключ повертав невдалий платіж                                      | спроби `<ключ>:a<n>`, новий `ParkingPaymentLink` на спробу                                                                                                                                                      |
| Провайдер платежів викликався всередині транзакції паркінгу                                                                                      | `createPayment` комітить спробу у власній транзакції, провайдер - поза транзакцією, зв'язок пишеться після                                                                                                      |
| Оплата за закриту сесію або вже оплачену годину мовчки лишалась у ТРЦ; дубль вебхука оператора міг відкотити сесію                               | рішення в `parking_payment_links.outcome`, автоповернення, `parking.payment.ops_alert`, `parking_webhook_logs` (дедуплікація за `eventId`), довга політика повторів і `payments-sweep` кожні 5 хв               |
| PIN валідатора: 4 цифри, без ліміту спроб, у кожному запиті заголовком `X-Validator-Pin`, який (з ключем і токеном зміни) потрапляв у access log | новий PIN 6-12 цифр, 5 помилок - блок 15 хв (аудит), PIN лише в тілі `POST /validator/shift`; заголовки `X-Validator-*` і `Idempotency-Key` маскуються в логах; схему `validator-pin` і CORS-заголовок прибрано |
| З `S3_PUBLIC_BASE_URL` фото чеків отримували постійні непідписані посилання                                                                      | публічні лише префікси `tenants/`, `promos/`, `events/`, `rewards/`, `banners/`, `mall/`; приватні - підписані посилання до 1 год                                                                               |
| Бек-офіс: owner/manager входили самим паролем, без блокування, необмежені паралельні scrypt (DoS пам'яті)                                        | обов'язковий TOTP для owner/manager з налаштуванням під час входу, блокування з backoff, детектор сплесків, семафор scrypt, одноразовий виклик TOTP, нові паролі ln=17                                          |
| SMS pumping і перебір OTP                                                                                                                        | пауза між кодами, добовий ліміт на номер, блок після 10 невдач, глобальний бюджет SMS, IPv6 за /64, хук капчі                                                                                                   |
| Dev- і compose-секрети приймались у production; `TRUST_PROXY=true` довіряв кожному хопу (підробка `X-Forwarded-For` обходила ліміти)             | політика секретів (`secret-policy.ts`: 32+ символи, deny-list), `TRUST_PROXY` як кількість хопів або CIDR                                                                                                       |
| Seed перезаписував пароль, роль і активність адміністратора при кожному запуску і працював у production з паролем за замовчуванням               | облікові дані лише при створенні, відмова в production без власних `SEED_*`, хеш ln=17, PIN 6 цифр (інтеграція)                                                                                                 |
| Персональні дані: тексти й фото звернень не стирались за `user.deleted`; рядок запиту (`?q=<телефон>`) потрапляв у лог помилок                   | споживач `admin-events` для `user.deleted`; `ProblemDetailsFilter` логує шлях без query string (інтеграція)                                                                                                     |
| Ваучер, куплений за бали, згорав разом із балами, хоча застосунок обіцяє повернення                                                              | повернення в задачі `vouchers-expire` (`REWARDS_REFUND_ON_EXPIRY=true`), у початкові кошики                                                                                                                     |
| Автоматичне повернення паркінгу відбувалось без повідомлення учасника                                                                            | `payment.refunded` паркінгового платежу -> сповіщення `payment_refunded` «Кошти за паркінг повернуто» (інтеграція)                                                                                              |
| Самостійно затверджені коригування можна було дробити нижче порогу «чотирьох очей»                                                               | накопичені ліміти (день Києва на заявника, 24 год на рахунок), `second_approval_reason`                                                                                                                         |

### Середні: розбіжності з прототипом

- Профіль: стать, місто, діти (до 6), `profileCompletion`, бонуси за кожне поле (10) і повний профіль (20).
- Клуб: назви й підзаголовки в історії балів (`title`, `subtitle`, `counterparty`), фільтр `from/to`, місячний
  підсумок, «на перевірці» на картці (`RECEIPTS_PORT.getPendingSummary`).
- ТРЦ і орендарі: години роботи з `isOpenNow`, розташування й карта, `GET /tenants/by-id/:id`, `mall_info`
  (Telegram, інфостійка, оператор паркінгу, правила, юридичні документи, карти поверхів).
- Акції й події: категорії, вік, ліміт осіб на реєстрацію, прив'язка до орендаря, зовнішній вхід, гостьовий доступ.
- Винагороди: картка орендаря й зображення у ваучері, `displayNumber`, статичний офлайн-QR квитків і
  сертифікатів, `GET /vouchers/summary`, гостьовий каталог.
- Паркінг: назва авто, «Так, я тут» (F7), «Це не моє авто» (F2) і спори, заявка талоном, наступна година при
  оплаті менш ніж за 5 хв до кінця, історія; екран квитанції (`displayNumber`, отримувач-оператор, номер авто,
  підписаний QR для оператора).
- Звернення в підтримку («Звернення № 1042 прийнято», лист на `SUPPORT_EMAIL`).

### Низькі

OpenAPI `/club/rules` без схеми безпеки, перелік кодів помилок, заголовки CORS, дрібні тексти.

### Що зробила інтеграція (консолідація)

- Міграція `20261101180000_review_fixes` (696 рядків): DDL згенеровано `prisma migrate diff` від знімка схеми
  до виправлень, ручний SQL п'яти файлів дописано без дублів (послідовність номерів звернень - до таблиці,
  CHECK, тригер append-only `points_spend_allocations`, FK без відношень Prisma, часткові індекси, заповнення
  даних, канонізація з таблицями звітів); `BEGIN/COMMIT` і `ON COMMIT DROP` прибрано, невидимі символи
  роздільників записано як `U&`-літерал. Перевірено скриптом: жоден об'єкт не створюється двічі в трьох
  міграціях, усі об'єкти схеми Prisma створені, міграції 1+2 точно дають знімок «до виправлень».
- Seed за нотатками модулів (див. RUNBOOK розділ 5), `.env.example` з усіма новими змінними,
  `env-example.spec.ts` перевіряє всі 10 секцій (і що жодна секція з `src/` не пропущена) та dev-значення
  `docker-compose.yml`.
- Залишки: лог помилок без query string, прибрано схему `validator-pin` і CORS-заголовок `X-Validator-Pin`,
  споживач `user.deleted` для звернень (черга `admin-events`), сповіщення про повернення паркінгу.

### Рішення за замовчуванням (потрібне підтвердження замовника)

1. Гостьовий онбординг: номер авто гостя зберігається лише на пристрої до входу (сервер не тримає анонімних номерів).
2. Спосіб оплати (картка, Apple Pay, Google Pay) обирається на сторінці провайдера (hosted checkout), не в застосунку.
3. Квитанції про оплату на e-mail не надсилаються: застосунок ділиться посиланням на фіскальний чек (`fiscalReceiptUrl`).
4. Код активації ваучера лишається 6 символів (у прототипі - 4): менше шансів підібрати за 2 хв.
5. Код учасника лишається 9 цифр (у прототипі - 7).
6. Охолодження перед видаленням акаунта - 30 днів, налаштовується `ACCOUNT_DELETION_GRACE_DAYS` (текст прототипу каже 7).
7. Бонус за профіль: 10 балів за кожне поле і 20 за повний профіль (як у прототипі) замість одного бонусу 30 з
   плану; набір правил seed має `welcome.profile = 0`, щоб не платити двічі. Наявним учасникам уже заповнені
   поля бонусів заднім числом не дають (міграція 3, розділ 3.1). Вбудовані значення без жодного набору правил
   (`DEFAULT_LOYALTY_RULES`) досі мають `profile: 30` - у середовищі без seed створіть набір правил з 0.
8. Подія: не більше 4 осіб на одну реєстрацію (прототип), також типово через прапорець `events.registration`.
9. QR-чеки нових акаунтів (до 30 днів) або на суму понад 500 грн утримуються 24 год до доступності балів.
10. Денний ліміт балів за QR-чеки - 150; понад нього чек іде на модерацію.
11. Оплата паркінгу, що прийшла після закриття сесії (або за вже оплачену годину), повертається автоматично;
    учасник отримує сповіщення після підтвердження повернення.
12. Подвійна оплата «застосунок + паркомат» автоматично не повертається: повернення - вручну за зверненням.
13. Нумерація звернень у підтримку починається з 1001.

### Залишкові ризики

- **Немає API перевірки чеків у податковій.** `TaxReceiptVerifierPort` - noop (`unknown`): утримання лише
  відкладає бали; підроблений чек старого акаунта до 500 грн у межах денного ліміту зараховується одразу.
  Максимальний збиток - 150 балів на акаунт на добу; потрібна угода з ДПС або оператором фіскальних даних.
- **Капча - noop.** Хук викликається на м'яких порогах OTP, але пропускає все; діють лише жорсткі ліміти.
- **Access-токен учасника stateless на 15 хв.** Блокування, вихід і видалення діють на вже виданий токен до
  15 хв (refresh після блокування відмовляє одразу).
- **Лічильники в пам'яті репліки.** Throttler, детектор сплесків входу в бек-офіс, попередження бюджету SMS,
  кеш перевірки адміністратора (30 с) і прапорців (5 с), квота неверифікованих номерів без Redis - на кожну
  репліку окремо; за кількох реплік ліміти фактично множаться (жорсткі ліміти OTP і входу - у БД).
- Не перевірено локально (немає PostgreSQL, Redis, Docker): `prisma migrate deploy` міграції 3 (зокрема
  канонізація на реальних даних), seed, `npm run test:int`, воркер із Redis, `docker build` - перевіряє CI.

## Запити модулів (Module requests)

Рішення щодо кожного запиту з `docs/schema-requests/`, `docs/contract-requests/`, `docs/deps-requests/`
(у файлах запитів дописано рядок статусу). Міграція для змін схеми - `prisma/schema/migrations/20261101120000_module_requests`.

| Запит                                                             | Рішення                | Що зроблено / причина                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema admin-1 (`ManualAdjustment.userId`)                        | прийнято               | колонка + FK + індекс, заповнення з `loyalty_accounts`; admin не читає таблиці club                                                                                                                           |
| schema club-1 (позначки нагадувань)                               | прийнято зі змінами    | колонка `loyalty_accounts.expiry_reminders` (а не кошик чи загальний `meta`); міграція переносить дані з `welcome_state`                                                                                      |
| schema club-2 (індекс утримань)                                   | прийнято               | частковий індекс `points_transactions(available_at) WHERE state = 'pending'`                                                                                                                                  |
| schema club-3 (київський день кошика в seed)                      | прийнято               | seed використовує `computeExpiresAt` і `bucketDayKey` з домену club                                                                                                                                           |
| schema content-1 (заборона перетину правил)                       | прийнято               | `btree_gist` + EXCLUDE `tenant_loyalty_rules_no_overlap`; 23P01 -> `PC_TENANT_RULE_OVERLAP`                                                                                                                   |
| schema identity-1 (`totpLastStep`)                                | прийнято               | атомарне `claimTotpStep`, повтор коду -> `PC_ADMIN_TOTP_INVALID`                                                                                                                                              |
| schema identity-2 (`AdminSession`)                                | відхилено              | обрано перевірку активності в `AdminGuard` (кеш 30 с) замість admin refresh-токенів                                                                                                                           |
| schema identity-3 (шифрування `totpSecret`)                       | відкладено             | потрібне рішення щодо керування ключем (відкрите питання)                                                                                                                                                     |
| schema notifications-1 (`dedupeKey`)                              | прийнято               | колонка + `@@unique([userId, dedupeKey])`, заповнення з `data._dedupeKey`, вставка `ON CONFLICT DO NOTHING`                                                                                                   |
| schema parking-1 (`level`, `spot`)                                | прийнято               | колонки; місце зберігає єдиний шлях запису сесії, кеш у пам'яті прибрано                                                                                                                                      |
| schema parking-2 (часова лінія seed)                              | прийнято               | 14:00 / 14:30 / 60 грн о 15:20 / до 16:00 / виїзд 15:52, `level -2`, `spot C`                                                                                                                                 |
| schema parking-3 (прапорець тривоги в seed)                       | прийнято               | `parking.air_raid` вимкнений, `freeExitMinutes: 30`                                                                                                                                                           |
| schema promos-1 (`coupon_claims`)                                 | прийнято               | таблиця як запропоновано, міграція переносить наявні купони, сервіс перейшов на неї                                                                                                                           |
| schema receipts-1 (причини і код відхилення)                      | прийнято               | колонки `moderation_reasons`, `rejection_code`, заповнення з нотаток подій; фільтр `?reason=` у черзі                                                                                                         |
| schema receipts-2 (індекс sweep)                                  | прийнято               | `receipts(status, updated_at)`                                                                                                                                                                                |
| schema rewards-1 (унікальність джерела ваучера)                   | прийнято               | частковий унікальний `vouchers_source_kind_key`; `issue` вставляє з `ON CONFLICT DO NOTHING`                                                                                                                  |
| schema rewards-2 (індекс ліміту на учасника)                      | прийнято               | `redemptions(user_id, reward_id, status)`                                                                                                                                                                     |
| contract admin-1 (коди admin)                                     | прийнято               | 4 коди в `ADMIN_ERROR_CODES`                                                                                                                                                                                  |
| contract club-1 (JSDoc `spend` для manual)                        | прийнято               | JSDoc у `ClubLedgerPort.spend`                                                                                                                                                                                |
| contract club-2 (`pendingAmount`)                                 | прийнято               | необов'язкове поле в `PointsReversedPayload`, club заповнює                                                                                                                                                   |
| contract club-3 (застарілий тест заглушки)                        | прийнято               | `ports.e2e-spec.ts` перевіряє справжні реалізації                                                                                                                                                             |
| contract content-1 (коди content)                                 | прийнято               | 6 кодів у `CONTENT_ERROR_CODES`                                                                                                                                                                               |
| contract content-2 (`receiptId` у `recordSeenFiscalNumber`)       | прийнято               | третій необов'язковий аргумент; receipts передає `receiptId`                                                                                                                                                  |
| contract content-3 (черга імпорту)                                | прийнято зі змінами    | `QUEUES.contentImport`; асинхронний режим за `async: true` (202), синхронний лишився типовим                                                                                                                  |
| contract content-4 (`MALL_ADDRESS`)                               | прийнято               | `DEFAULT_MALL_ADDRESS` у `src/common/config`, `.env.example`, обхідний шлях прибрано                                                                                                                          |
| contract content-5 (базова ставка)                                | прийнято, варіант (б)  | `ContentModule` імпортує `ClubModule`, `BaseRateService` інжектить `CLUB_LEDGER_PORT`                                                                                                                         |
| contract identity-1 (`user.deletion_cancelled`, `user.unblocked`) | прийнято               | події в каталозі, identity публікує; notifications споживає скасування, розблокування - лише аудит                                                                                                            |
| contract identity-2 (маршрути `user.*`)                           | прийнято               | маршрути або статус "лише аудит" для кожної події; `user.deleted` у п'яти модулях                                                                                                                             |
| contract identity-3 (активність у `AdminGuard`)                   | прийнято               | `getAdminAccess` + `AdminAccessGate` (обраний варіант: перевірка, а не короткий TTL)                                                                                                                          |
| contract notifications-1 (аудиторія маркетингу)                   | прийнято               | `IdentityPort.listMarketingAudience`; розсилка `promo.published` сторінками по 500                                                                                                                            |
| contract notifications-2 (`PC_NOTIFICATION_PREFERENCE_LOCKED`)    | прийнято               | код у контракті                                                                                                                                                                                               |
| contract parking-1 (коди parking)                                 | прийнято               | 5 кодів у `PARKING_ERROR_CODES`                                                                                                                                                                               |
| contract parking-2 (події-нагадування)                            | прийнято               | `parking.session.free_ending`, `exit_soon`, `still_inside` + `ParkingSessionReminderPayload`                                                                                                                  |
| contract parking-3 (сповіщення паркінгу)                          | прийнято               | 4 види, канонічні тексти, тексти закриття `user_left` і `timeout`; власний маршрут parking прибрано                                                                                                           |
| contract parking-4 (`FEATURE_FLAG_KEYS.parkingAirRaid`)           | прийнято               | ключ і `ParkingAirRaidFlagPayload` у контракті admin                                                                                                                                                          |
| contract promos-1 (коди promos)                                   | прийнято               | 15 кодів у `PROMOS_ERROR_CODES`                                                                                                                                                                               |
| contract receipts-1 (`PC_RECEIPT_MANUAL_DISABLED`)                | прийнято               | код у контракті                                                                                                                                                                                               |
| contract receipts-2 (`processing` і поля екрана)                  | прийнято зі змінами    | `processing`, `SUBMISSION_SCREENS`, `screen/title/message/moderationReasons`; `ReceiptSubmissionResult` - результат сервісу, HTTP віддає безпечну проєкцію `receipt`                                          |
| contract receipts-3 (відбиток пристрою)                           | відхилено (відкладено) | `getDevice` дає відбиток одного пристрою, а для `device_shared` потрібен пошук пристроїв інших учасників з тим самим відбитком (новий метод identity або колонка); claim у токені розкрив би відбиток клієнту |
| contract receipts-4 (передати `receiptId`)                        | прийнято               | разом із content-2                                                                                                                                                                                            |
| contract rewards-1 (`PC_VALIDATOR_NOT_FOUND`)                     | прийнято               | код у контракті                                                                                                                                                                                               |
| contract rewards-2 (заголовки валідатора)                         | прийнято               | константи в `auth.constants.ts`, схеми безпеки OpenAPI, CORS-заголовки                                                                                                                                        |
| deps notifications (`google-auth-library`, `firebase-admin`)      | відхилено              | не потрібні: FCM-адаптер на `node:crypto` і `fetch` з тестами                                                                                                                                                 |

Підсумок: схема - 17 пунктів, прийнято 15 (1 зі змінами), відхилено 1, відкладено 1; контракти - 25 пунктів,
прийнято 24 (3 зі змінами або з вибором варіанта), відхилено 1; залежності - 1 запит, відхилено.

## identity

- 2026-11-01, integration: `listMarketingAudience` (raw SQL з `JOIN LATERAL` за останньою згодою) і
  `getAdminAccess`; резолвер для `AdminAccessGate`; `ActiveAdminGuard` прибрано; події
  `user.deletion_cancelled`, `user.unblocked`; захист від повтору TOTP (`totpLastStep`); у production
  `SMS_PROVIDER=log` відхиляється при старті.

## club

- 2026-11-01, integration: позначки нагадувань у колонці `expiry_reminders`; `pendingAmount` у
  `points.reversed`; інтеграційний тест перевіряє колонку (лише CI).

## content

- 2026-11-01, integration: імпорт `ClubModule` для базової ставки; `MALL_ADDRESS` без обхідного шляху;
  асинхронний імпорт через `content-import`; 23P01 -> `PC_TENANT_RULE_OVERLAP`. e2e content підміняє
  `ContentImportService` фейком, тож шлях постановки в чергу покритий лише юніт-тестами.

## receipts

- 2026-11-01, integration: колонки `moderation_reasons`/`rejection_code` (розбір нотаток прибрано),
  `outcome = processing`, `receiptId` для нових фіскальних номерів, фільтр `?reason=`, споживач
  `user.deleted` на `receipts-events`.

## rewards

- 2026-11-01, integration: `issue` стійкий до гонок (`ON CONFLICT DO NOTHING` + повернення наявного
  ваучера без повторного `voucher.issued`); заголовки валідатора зі спільного шару, схеми безпеки.

## promos

- 2026-11-01, integration: заявки на купон у `coupon_claims`; `voucher.cancelled` повертає купон у пул
  лише при переході заявки active -> cancelled.

## parking

- 2026-11-01, integration: `level`/`spot` на рядку сесії; нагадування з каталогу (споживає
  notifications); `FEATURE_FLAG_KEYS.parkingAirRaid`; підпис вебхука від сирого тіла; споживач
  `user.deleted` (`ParkingErasureService`).

## payments

- 2026-11-01, integration: підпис мок-вебхука від сирого тіла; споживач `user.deleted` на
  `payments-events` (`erasePersonalMeta`).

## notifications

- 2026-11-01, integration: колонка `dedupe_key`; аудиторія маркетингу через identity; нові види й
  тексти паркінгу та скасування видалення; маршрути `parking.session.opened|free_ending|exit_soon|still_inside`,
  `user.deletion_cancelled`, `user.deleted`; очищення скриньки за `user.deleted`.

## admin

- 2026-11-01, integration: `ManualAdjustment.userId` пишеться при створенні й читається замість таблиці
  club; фільтр `?userId=` по колонці.

## Перевірка на PostgreSQL 17 (01.11.2026)

Деталі в `docs/DB_VERIFICATION.md`. Змінено за результатами:

- Міграції перенесено з `prisma/migrations` у `prisma/schema/migrations`: Prisma 6 з мультифайловою схемою шукає їх поруч із файлом datasource, і зі старого місця `migrate deploy` не застосовував нічого.
- `support_requests.number` тепер `@default(autoincrement())` з рестартом послідовності `support_requests_number_seq` на 1001, без дрейфу схеми.
- Вимога до бази: UTF-8 з локаллю, що знає регістр кирилиці (`C.UTF-8` вбудованого провайдера PostgreSQL 17, `en_US.UTF-8`, `uk_UA.UTF-8`); задано в `docker-compose.yml` і CI, API перевіряє це під час старту.
- Свідомий дрейф, який `prisma migrate dev` пропонуватиме прибрати і який не можна приймати: 3 зовнішні ключі між модулями (`events.tenant_id`, `support_requests.user_id`, `support_requests.resolved_by_id`) і 2 таблиці звіту канонічних номерів чеків.

## Відомі прогалини

- Локально не перевірено (немає PostgreSQL, Redis, Docker): `prisma migrate deploy` усіх трьох міграцій,
  seed, `npm run test:int` (identity, club, content), e2e проти справжньої БД, воркер із Redis, `docker build`.
  Усе це виконує CI; перший прогін CI - перша перевірка міграцій `20261101120000_module_requests`
  (зокрема `btree_gist`, EXCLUDE, часткових індексів і заповнення даних) і `20261101180000_review_fixes`
  (послідовність, тригер, `U&`-літерал у функціях канонізації, тимчасові таблиці, заповнення даних).
- Зовнішні інтеграції - адаптери або заглушки: TurboSMS не перевірений на живому акаунті; реальний
  оператор паркінгу (`vendor` відповідає 503, працює інфо-режим); платіжний провайдер лише мок;
  фіскалізація `none`; FCM не перевірений на живому проєкті.
- `device_shared` не бачить перевстановлень застосунку (receipts-3 відкладено).
- Rate limit (throttler) зберігається в пам'яті процесу; за кількох реплік API потрібне Redis-сховище.
- Кеш перевірки адміністратора і кеш прапорців - у пам'яті процесу: на інших репліках деактивація діє
  до 30 с, зміна прапорця - до 5 с.
- Масова маркетингова розсилка - одна довга задача на всю аудиторію (безпечно завдяки дедуплікації).
- Стан мок-провайдера платежів живе в пам'яті процесу API: після перезапуску незавершені мок-платежі
  звіряння закриває як `expired`.
- Інтеграційних тестів з PostgreSQL немає для receipts, rewards (часткові індекси, `FOR UPDATE`),
  promos, parking, payments, notifications.
- ~~`createPayment` викликається в транзакції сесії паркінгу~~ - виправлено 01.11.2026: провайдер
  викликається поза будь-якою транзакцією.
- Шифрування `totpSecret` at rest і таблиця admin-сесій відкладені; ендпоїнта скидання TOTP немає
  (процедура SQL - RUNBOOK розділ 5.1).
- Seed створює демо-учасника й демо-дані в будь-якому середовищі; для production потрібне рішення
  (окремий прапорець seed або не запускати його після першого розгортання).
- Звіти міграції 3 (`receipt_canonical_collisions`, `fiscal_number_canonical_collisions`) і FK без відношень
  Prisma поза схемою: `prisma migrate dev` може пропонувати їх видалити (RUNBOOK розділ 4).
- `MAIL_PROVIDER=smtp` не реалізовано: листи підтримці видно лише в логах.

## Відкриті питання до замовника

Зібрано з README модулів (2026-11-01).

1. identity: SMS-провайдер (TurboSMS чи Kyivstar/Vodafone, Viber з fallback) і договір; ліміт на пристрій
   і капча при аномаліях; чи відкликати сесії одразу при `DELETE /me`; обов'язковий 2FA для owner/manager;
   керування ключем для шифрування TOTP-секретів.
2. club: чи надсилати пропущене нагадування про згоряння, якщо задача не працювала саме того дня.
3. content: чи блокувати фіскальні номери автоматично при закритті орендаря; коли підключати реальний
   WordPress REST API і нічний імпорт.
4. receipts: чи дозволяти повторне оскарження; чи потрібен `Idempotency-Key` для ручного подання.
5. rewards: правило повернення балів при скасуванні (строк, види винагород); автоматичне застосування
   години паркінгу через оператора замість каси; чи може учасник сам скасовувати купони й квитки.
6. promos: перевипуск квитків при перенесенні події; дедлайн скасування 11:00 і максимум 4 особи.
7. parking: процес «Це не моє авто» (F2) і «Так, я ще тут» (F7); формат і події реального оператора
   (вебхуки, оплачена година, штрих-код талона); тлумачення правила тривоги (перші 30 хв від початку
   тривоги); процедура звірки `closed_unpaid`.
8. payments: вибір еквайра (LiqPay, monobank, WayForPay, Fondy, Portmone); хто фіскалізує (провайдер чи
   ПРРО Checkbox / Вчасно.Каса).
9. notifications: тексти з копірайтером; тихі години для push.
10. admin: чи налаштовувати поріг «чотирьох очей» через rule set; «примусовий» режим ручного списання.

English summary: integration closed every module request (decisions in the table above), added the
`20261101120000_module_requests` migration, a shared admin activity check in AdminGuard, an audit-only
list so no outbox event is dropped, `user.deleted` cleanup in every module holding personal data,
raw-body webhook signatures, a complete `.env.example` with production guards, generated `docs/API.md`
and CI that runs migrations, the seed (twice), integration and e2e specs against PostgreSQL and Redis.
On 2026-11-01 three reviews (security, money and ledger, prototype fit) were fixed module by module and
consolidated: migration `20261101180000_review_fixes` (canonical fiscal numbers with a collision report,
spend allocations, support requests, parking payment outcomes, profile fields and children), a hardened
seed, new environment variables, support-request erasure on `user.deleted`, a parking refund notification;
default product decisions and residual risks are listed in "Рецензія та виправлення (01.11.2026)".
