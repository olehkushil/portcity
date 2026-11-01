# Запити модуля content (контракти та спільний шар)

## content-1: локальні коди помилок у `CONTENT_ERROR_CODES`

- Що потрібно: додати до `CONTENT_ERROR_CODES` (`src/common/contracts/content.ts`) коди, які модуль уже
  реєструє в `src/modules/content/domain/errors.ts`:

  ```ts
  'PC_TENANT_INVALID_TRANSITION', // 409, active <-> hidden, active|hidden -> closed, closed -> active
  'PC_FISCAL_NUMBER_INVALID_TRANSITION', // 409, напр. active -> pending або видалення active
  'PC_FISCAL_NUMBER_TENANT_REQUIRED', // 422, active-номер має бути прив'язаний до орендаря
  'PC_TENANT_RULE_INVALID_PERIOD', // 422, validTo <= validFrom або некоректна дата
  'PC_CONTENT_IMPORT_NOT_FOUND', // 404
  'PC_CONTENT_IMPORT_EMPTY', // 422, у запиті імпорту немає жодного придатного запису
  ```

- Для чого: BRIEF розділ 3 (коди `PC_<MODULE>_<REASON>`), CRUD `/admin/tenants`, `/admin/fiscal-numbers`,
  `/admin/tenant-rules`, `POST /admin/content/import`.
- Коли: не блокує; коди працюють локально.
- Статус: виконано 2026-11-01 (integration).

## content-2: необов'язковий третій аргумент `recordSeenFiscalNumber`

- Що потрібно: розширити сигнатуру порту (реалізація вже приймає цей аргумент):

  ```ts
  recordSeenFiscalNumber(fn: string, tx?: Tx, options?: { receiptId?: Uuid | null }): Promise<FiscalNumberLookup>;
  ```

- Для чого: payload події `tenant.fiscal_number_seen` має поле `receiptId`; зараз через контракт воно
  завжди `null`, і модератор не бачить, з якого чека прийшов новий фіскальний номер.
- Коли: не блокує (receipts може передати аргумент після оновлення контракту).
- Статус: виконано 2026-11-01 (integration); receipts передає `{ receiptId }`.

## content-3: черга `QUEUES.contentImport` для асинхронного імпорту WordPress

- Що потрібно: у `src/common/queue/queue.constants.ts` додати `contentImport: 'content-import'`
  (власник - content).
- Для чого: `POST /admin/content/import` зараз виконує заглушку імпорту синхронно в межах запиту
  (до 500 записів, одна транзакція). Логіка вже є чистою функцією `runContentImport`
  (`src/modules/content/jobs/content-import.job.ts`); з чергою контролер ставитиме задачу, а процесор
  оновлюватиме `content_import_runs` (running -> succeeded | failed). Також дозволить нічний імпорт за
  розкладом, коли з'явиться реальний WordPress API.
- Коли: не блокує; можна після інтеграції.
- Статус: виконано 2026-11-01 (integration): `QUEUES.contentImport`; `POST /admin/content/import` з `async: true` ставить задачу (202), синхронний режим лишився типовим.

## content-4: значення за замовчуванням `MALL_ADDRESS`

- Що потрібно: у `src/common/config/env.schema.ts` і `.env.example` замінити типове
  `MALL_ADDRESS=м. Луцьк, вул. Сухомлинського, 1` на фактичну адресу ТРЦ
  `просп. Соборності, 43, Луцьк`.
- Для чого: `GET /mall/info` (BRIEF розділ 8). До виправлення `MallInfoService` трактує старе типове
  значення як "не налаштовано" і повертає `просп. Соборності, 43, Луцьк`
  (`resolveMallAddress`, `src/modules/content/services/mall-info.service.ts`).
- Коли: не блокує.
- Статус: виконано 2026-11-01 (integration): `DEFAULT_MALL_ADDRESS` у `src/common/config`, `.env.example` оновлено, обхідний шлях у `mall-info.service.ts` прибрано.

## content-5: базова ставка для картки орендаря (content -> club, лише читання)

- Що потрібно: погодити спосіб, яким content читає `baseRatePercent` активного набору правил.
  Зараз `BaseRateService` бере `CLUB_LEDGER_PORT` з контейнера ліниво
  (`moduleRef.get(CLUB_LEDGER_PORT, { strict: false })`), без імпорту `ClubModule`, кешує значення на
  60 с і за відсутності порту, заглушки 501 чи помилки повертає `DEFAULT_LOYALTY_RULES.baseRatePercent` (3).
  Варіанти: (а) залишити так і описати в таблиці залежностей FOUNDATION_SUMMARY як неявне читання;
  (б) дозволити `ContentModule` імпортувати `ClubModule` (циклу немає: club -> identity);
  (в) винести активні правила в спільний read-only сервіс.
- Для чого: `GET /tenants` і `GET /tenants/:slug` показують `earnsPoints` ("нараховує бали") та
  `effectiveRatePercent`; для орендарів без власного правила чи override потрібна базова ставка.
- Коли: не блокує.
- Статус: виконано 2026-11-01 (integration), варіант (б): `ContentModule` імпортує `ClubModule`, `BaseRateService` інжектить `CLUB_LEDGER_PORT`.

English summary: (1) list six content-local error codes in the contract; (2) add the optional
`{ receiptId }` argument to `recordSeenFiscalNumber`; (3) add a `content-import` queue so the
WordPress import stub can run asynchronously; (4) fix the shared `MALL_ADDRESS` default to
"просп. Соборності, 43, Луцьк"; (5) agree on how content reads the club base rate (now: lazy
CLUB_LEDGER_PORT lookup with a default fallback).
