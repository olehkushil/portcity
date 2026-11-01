# Модуль club: клубні рахунки та леджер балів

Модуль веде клубні рахунки учасників, append-only леджер балів, FIFO-кошики згоряння, утримання
(holds), вітальні бонуси та версіоновані набори правил програми. Інші модулі працюють із балами
лише через порт `CLUB_LEDGER_PORT` (`src/common/contracts/club.ts`), який реалізує `LedgerService`.
Залежить від identity (`IDENTITY_PORT`: код учасника для QR картки). Споживачі порту: receipts,
rewards, content (базова ставка для карток орендарів, лише `getActiveRules`), admin.

## Структура

| Шлях                                     | Що там                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `domain/`                                | чиста логіка без Nest: баланс і FIFO, згоряння, стани, правила, вітальні бонуси, новачок, QR |
| `services/ledger.service.ts`             | `LedgerService implements ClubLedgerPort` + `expire(asOf)` для щоденної задачі              |
| `services/club-account.service.ts`       | створення рахунку, вітальні бонуси, картка (`GET /club/account`), історія                   |
| `services/club-jobs.service.ts`          | зняття утримань, нагадування про згоряння, нічна перевірка розбіжностей                     |
| `services/rule-sets.service.ts`          | версії правил, кеш активної версії (30 с), аудит змін                                       |
| `services/pending-moderation.reader.ts`  | `RECEIPTS_PORT.getPendingSummary` для картки (лінивий пошук порту, нулі як запасний варіант) |
| `club.config.ts`                         | власна секція змінних середовища (бонуси за поля профілю)                                   |
| `services/club.repository.ts`            | межа персистентності; `prisma-club.repository.ts` - PostgreSQL, `testing/` - in-memory       |
| `controllers/`, `dto/`                   | HTTP: картка, історія, публічні правила, адмінка правил і рахунків                          |
| `jobs/`                                  | обробники задач (чисті функції з тестами) і BullMQ-процесори, що їх лише викликають         |
| `testing/`                               | `InMemoryClubRepository`, `createClubTestKit()` для юніт- і e2e-тестів                       |

## Модель даних

- `LoyaltyAccount` - один на учасника: кешовані `availableBalance`, `pendingBalance`,
  `lifetimeEarned`, `newcomerLockUntil`, `welcomeState` (jsonb лише з прапорцями вітальних бонусів),
  `expiryReminders` (jsonb `{ "2026-12-01": [30, 7] }`: київський день кошика -> пороги вже
  опублікованих `points.expiring`; минулі дні вичищаються при кожному записі; окрема колонка з
  міграції `20261101120000_module_requests`, яка перенесла туди старі позначки з `welcome_state`).
- `PointsTransaction` - append-only рядок леджера. Тригер `points_transactions_append_only`
  дозволяє лише рух `state` вперед; модуль ніколи не змінює інші колонки й не видаляє рядки.
  Колонки для історії `title`, `subtitle`, `counterparty` (jsonb: `tenantId`, `tenantName`,
  `receiptId`, `receiptTotalKopecks`, `rewardId`, `rewardTitle`, `voucherId`) записуються один
  раз під час проведення (тригер порівнює весь рядок, тож змінити їх не можна); старі рядки мають
  NULL, і API підставляє заголовок за типом рядка.
- `PointsSpendAllocation` (`points_spend_allocations`) - які кошики (київський день згоряння) і
  скільки балів спожив кожен рядок списання (`spend`, від'ємний `adjust`, `reverse`). Пишеться
  один раз у транзакції списання; повернення цього рядка кладе бали назад у ті самі кошики.
- `PointsExpiryBucket` - залишок доступних балів на кожен київський день згоряння.
- `LoyaltyRuleSet` - версія правил (`config` jsonb, нормалізується `normalizeLoyaltyRules`).

Конвенція балансу (така сама в seed):

- `available = сума amount` по рядках у станах `available`, `spent`, `expired`;
  `pending = сума` по рядках `pending`; `cancelled` не враховується ніде;
- рядки списання (`spend`, від'ємний `adjust`), згоряння (`expire`) і сторно (`reverse`) мають
  від'ємну суму і одразу фінальний стан (`spent` або `expired`);
- інваріант кошиків: `сума(buckets.remaining) = max(availableBalance, 0)`.

## Машина станів

```
pending -> available -> spent | expired
pending -> cancelled
```

Повністю спожиті нарахування переводяться в `spent` (коли їхній кошик спорожнів або при сторно),
при згорянні кошика нарахування дня діляться на `spent` (спожиті FIFO раніше) і `expired`.

## Порт CLUB_LEDGER_PORT

Кожен метод запису працює в транзакції викликача, якщо передано `tx` (останній аргумент), інакше
у власній; першим кроком блокує рядок рахунку `SELECT ... FOR UPDATE`; перевіряє ключ
ідемпотентності вже під блокуванням (паралельні дублікати серіалізуються, другий отримує той
самий рядок); оновлює кешовані баланси й кошики і публікує подію outbox у тій самій транзакції.

| Метод                       | Поведінка                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credit(input, tx?)`        | доступні бали одразу; створює рахунок при першому використанні; `expiresAt = now + pointsTtlMonths` (або явний); спершу гасить від'ємний баланс, решта йде в кошик; подія `points.credited`                                                               |
| `hold(input, tx?)`          | рядок `pending` до `availableAt`; `expiresAt = availableAt + pointsTtlMonths`; росте `pendingBalance`; подія `points.held`                                                                                                                              |
| `release(txId, tx?)`        | `pending -> available`, бали в кошик, `lifetimeEarned` росте; повтор повертає рядок як є; `cancelled` -> 409 `PC_POINTS_INVALID_TRANSITION`; подія `points.released`                                                                                  |
| `spend(input, tx?)`         | FIFO за днем згоряння; 422 `PC_POINTS_ACCOUNT_NEGATIVE` (баланс < 0), `PC_POINTS_NEWCOMER_LOCK`, `PC_POINTS_INSUFFICIENT`; рядок `spend`, стан `spent`, сума від'ємна; подія `points.spent`                                                            |
| `reverse(input, tx?)`       | `pending` -> `cancelled`; доступне або спожите нарахування -> рядок `reverse` (може зробити баланс від'ємним); від'ємний рядок -> `refund` у ті самі кошики з початковим терміном (див. нижче); один компенсуючий рядок на транзакцію (ключ `reverse:<txId>`), повтор з будь-яким ключем повертає його; подія `points.reversed` |
| `getBalance`, `getEntry`    | читання; `getBalance` = null, якщо рахунку ще немає; `spendBlockedBy` = `negative_balance` або `newcomer_lock`                                                                                                                                          |
| `getActiveRules(at?)`       | версія правил на момент `at`; без жодної версії - вбудовані `DEFAULT_LOYALTY_RULES` (версія 0)                                                                                                                                                          |
| `getDailyStats(range)`      | `earned` (earn/welcome/додатний adjust, без cancelled), `spent` (spend + від'ємний adjust), `expired`, `reversed`                                                                                                                                       |

Поза портом: `LedgerService.expire(asOf?)` (щоденна задача) і `ensureAccount(userId, registeredAt?)`.

Дані для історії: усі вхідні типи запису (`credit`, `hold`, `spend`, `reverse`) мають необов'язкові
`title`, `subtitle`, `counterparty` (`PointsDisplayInput` у контракті). Не передані - модуль пише
заголовок за типом рядка («Нарахування за чек», «Обмін на винагороду», «Повернення балів»,
«Бали згоріли»...), для вітальних бонусів - їхній `reason`. Рядки згоряння й повернення
модуль підписує сам; rewards уже передає назву винагороди, орендаря й ваучер.

Повернення списання (`refund`, знахідка 2 рев'ю: «обмін, потім скасування» не має подовжувати
12-місячний строк):

- кожна порція повертається в кошик, з якого її списали (`points_spend_allocations`), тобто з
  початковою датою згоряння; `expiresAt` рядка `refund` - найближчий такий день (довідково);
- від'ємний баланс гаситься першим, FIFO за днем (найраніші бали платять борг, як при списанні);
- порції, день згоряння яких уже минув, згоряють одразу: у тій самій транзакції пишеться рядок
  `expire` (ключ `reverse:<txId>:expire`, підзаголовок «Термін дії повернених балів уже минув»),
  тож учасник бачить в історії і повернення, і згоряння; подія `points.expired`;
- рядки списання, проведені до появи розподілу (і рядки `expire`), повертаються зі свіжим
  строком `now + pointsTtlMonths`, як раніше.

Повторне використання ключа ідемпотентності для іншого рахунку або операції протилежного знаку -
409 `PC_COMMON_IDEMPOTENCY_MISMATCH`; гонка вставки з тим самим ключем - 409
`PC_COMMON_IDEMPOTENCY_IN_PROGRESS`.

## Правила програми

- Новачок (план 7.3/12.2): рахунок створюється з `newcomerLockUntil = registeredAt + 72 год`;
  блокування знімається раніше, коли зараховано другий чек (`earn` з `sourceType = receipt`,
  включно з утриманими). Нараховувати можна одразу, заблоковане лише списання.
- Списання з `sourceType = manual` (ручне коригування з адмінки, four eyes у модулі admin)
  записується як від'ємний `adjust` і не блокується періодом новачка; недостатній або від'ємний
  баланс його блокують.
- Вітальні бонуси (за замовчуванням 50 / 30 / 20): реєстрація (`user.registered`), заповнений
  профіль (`user.profile_completed`), перший чек (`receipt.credited` з `firstReceipt = true`).
  Кожен - один раз: фіксований ключ `welcome:<kind>:<userId>` і прапорець у `welcomeState`.
  Бонус, налаштований як 0, лише ставить прапорець.
- Бонуси за поля профілю (рішення продукту): `user.profile_field_completed { userId, field,
  allFieldsCompleted }` (поле `completedAll` теж приймається) дає `PROFILE_BONUS_PER_FIELD` (10)
  за кожне поле з `PROFILE_FIELDS` контракту identity, один раз на учасника й поле (ключ
  `profile-field:<field>:<userId>`), і `PROFILE_BONUS_COMPLETE` (20), коли заповнено всі поля
  (ключ `profile-complete:<userId>`). Рядки - тип `welcome`, заголовок «Бонус за профіль» /
  «Бонус за заповнений профіль», підзаголовок - назва поля. Невідоме поле ігнорується. Ці бонуси
  окремі від вітального бонусу `welcome.profile` набору правил; щоб платити лише за поля,
  створіть версію правил з `welcome.profile = 0`. Seed так і робить (набір v1: 50 / 0 / 20, рішення
  продукту 01.11.2026); вбудовані `DEFAULT_LOYALTY_RULES` (без жодного набору) досі мають 30.
- Згоряння: бали згоряють через `pointsTtlMonths` (12) після того, як стали доступними; кошик дня D
  згоряє першим запуском задачі після завершення дня D за Києвом (03:30 наступного дня).
- Від'ємний баланс після сторно: наступні нарахування спершу гасять борг, у кошик іде лише залишок;
  поки баланс < 0, списання заблоковане.
- Набори правил: `activeFrom` не може бути в минулому (допуск 60 с); версія, що вже діє, незмінна -
  зміни робляться новою версією; майбутню версію можна редагувати або видалити.

## Ендпоїнти (префікс `/api/v1`)

| Метод і шлях                                       | Доступ                                         | Опис                                                                                     |
| -------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /club/account`                                | member                                         | баланс, pending, lifetime, memberCode, QR `PC1:<memberCode>:<hmac8>`, newcomerLockUntil, spendBlockedBy, expiringSoon (30 днів), `pendingModeration { count, expectedPoints }` |
| `GET /club/transactions?cursor=&limit=&type=&state=&from=&to=` | member                             | історія балів, нові спершу, курсорна пагінація; `from` (включно) / `to` (не включно) - ISO date-time; кожен рядок має `title`, `subtitle`, `counterparty` |
| `GET /club/transactions/summary?month=YYYY-MM`     | member                                         | підсумок київського місяця (типово поточного): `earned`, `spent`, `expired`, `refunded`, `reversed` |
| `GET /club/rules`                                  | публічний                                      | правила, що діють (без `autoApproveThresholdKopecks`); в OpenAPI без вимоги безпеки      |
| `GET /admin/club/rule-sets`                        | admin: owner, manager, support, moderator      | усі версії, `active` позначає чинну                                                       |
| `GET /admin/club/rule-sets/:id`                    | те саме                                        | одна версія                                                                              |
| `POST /admin/club/rule-sets`                       | owner, manager                                 | нова версія: часткова `config` поверх правил на `activeFrom`, аудит                      |
| `PATCH /admin/club/rule-sets/:id`                  | owner, manager                                 | редагування запланованої версії, аудит                                                   |
| `DELETE /admin/club/rule-sets/:id?reason=`         | owner, manager                                 | видалення запланованої версії, аудит                                                     |
| `GET /admin/club/accounts/:userId`                 | owner, manager, support, moderator             | баланси, блокування, прапорці вітальних бонусів, кошики                                   |
| `GET /admin/club/accounts/:userId/transactions`    | те саме                                        | леджер з ключами ідемпотентності та автором                                              |

Ендпоїнтів, що змінюють бали, у модуля немає: бали рухають receipts, rewards та admin через порт
(їхні ендпоїнти мають `Idempotency-Key`).

`@Auth('member')` стоїть на кожному обробнику учасника, а не на класі контролера, тому публічний
`GET /club/rules` не має bearer-вимоги в OpenAPI (раніше її додавав класовий `ApiBearerAuth`).

`pendingModeration` береться з `RECEIPTS_PORT.getPendingSummary(userId)`. Club не може імпортувати
ReceiptsModule (receipts імпортує club), тому `PendingModerationReader` шукає порт у контейнері
застосунку (`ModuleRef.get(RECEIPTS_PORT, { strict: false })`) під час запиту й викликає метод
лише якщо він є; відсутній порт, метод, помилка або некоректна відповідь дають нулі.

## Події outbox

Публікує: `points.account_created`, `points.credited`, `points.held`, `points.released`,
`points.spent`, `points.reversed` (`amount` - вплив на доступний баланс, тож для скасованого
утримання `amount = 0`, а `pendingAmount` = скасовані утримані бали; для решти сторно
`pendingAmount = 0`), `points.expiring` (за 30 і 7 днів, не більше одного разу на рахунок, день і поріг),
`points.expired` (і від щоденної задачі, і від повернення в кошик, день якого вже минув).

Споживає (черга `club-events`): `user.registered`, `user.profile_completed`,
`user.profile_field_completed`, `receipt.credited`.

## Черги та розклади (Europe/Kyiv)

| Розклад                          | Черга                  | Задача          | Cron         |
| -------------------------------- | ---------------------- | --------------- | ------------ |
| `points-release-holds-hourly`    | `points-release-holds` | `release-holds` | `5 * * * *`  |
| `points-expire-daily`            | `points-expire`        | `expire`        | `30 3 * * *` |
| `points-balance-drift-nightly`   | `points-expire`        | `drift-check`   | `15 4 * * *` |

Кожна одиниця роботи (утримання, кошик, нагадування, рахунок) - окрема коротка транзакція з
блокуванням рахунку; помилки рахуються й логуються, повторний запуск безпечний. Перевірка
розбіжностей лише звітує (warn у лог), баланси не переписує.

## Змінні середовища (секція `club`, `club.config.ts`)

| Змінна                    | Типово | Опис                                                         |
| ------------------------- | ------ | ------------------------------------------------------------ |
| `PROFILE_BONUS_PER_FIELD` | 10     | бали за кожне заповнене поле профілю (0 - вимкнено, до 1000) |
| `PROFILE_BONUS_COMPLETE`  | 20     | бали, коли заповнено всі поля профілю (0 - вимкнено)         |

Також використовується спільна `MEMBER_QR_SECRET` (HMAC для QR картки). Змінні є в `.env.example`
(розділ identity, їх читають обидва модулі), секція `club` зареєстрована в `env-example.spec.ts`.

## Тести

- Юніт: `npx jest src/modules/club` - домен (таблиці станів, FIFO, згоряння, правила, нагадування,
  розбіжності, `planRefund`, дані історії, бонуси профілю), `LedgerService` на in-memory
  репозиторії (FIFO між кошиками, недостатній баланс, від'ємний баланс, новачок, ідемпотентні
  повтори, hold/release, згоряння, сторно в мінус; регресія «обмін, потім скасування» зберігає
  початковий строк, повернення в кілька кошиків, повернення + згоряння для минулих днів, старі
  рядки без розподілу), сервіси рахунку (вікно `from/to`, місячний підсумок, `pendingModeration`
  з запасним нулем), задач і правил, обробники задач (бонуси за поля профілю), HTTP-контролери
  на мінімальному Nest-застосунку (зокрема OpenAPI без безпеки для `/club/rules`).
- E2E: `test/club/club.e2e-spec.ts` - модуль у повному `AppModule` без БД.
- Інтеграційні: `test/club/ledger.int-spec.ts` - PostgreSQL (блокування, тригер append-only,
  outbox у тій самій транзакції, відкат разом із транзакцією викликача, паралельні списання);
  пропускаються без `DATABASE_URL`.

## Відкриті питання та обмеження

- Нагадування надсилаються рівно за 30 і 7 днів; якщо задача не працювала саме того дня,
  нагадування для цього порогу пропускається (наступний поріг спрацює).
- Списання, проведені до міграції з `points_spend_allocations`, не мають розподілу: їхнє
  повернення отримує свіжий строк (відтворити FIFO-історію точно неможливо).
- Бонус `welcome.profile` (30, `user.profile_completed`) і нові бонуси за поля (10 за поле + 20
  за повний профіль) нараховуються незалежно; чи вимикати перший - рішення продукту (версія
  правил з `welcome.profile = 0`).
- Виправлено за рев'ю 2026-11-01: повернення списання зберігає строк згоряння, дані історії
  (`title`, `subtitle`, `counterparty`), фільтр `from/to`, місячний підсумок, `pendingModeration`
  на картці, бонуси за поля профілю, OpenAPI `/club/rules` без безпеки. SQL - міграція
  `20261101180000_review_fixes` (розділи 1, 2.2, 3.3), seed - `prisma/seed.ts` (набір правил v1 має
  `welcome.profile = 0`); архів - `docs/pending-sql/applied/club-rewards.*`.
- Закрито під час інтеграції (2026-11-01): окрема колонка `expiry_reminders` (schema club-1,
  варіант колонки на рахунку), частковий індекс утримань за `available_at` (club-2), київський день
  кошика в seed (club-3, правка seed - integration), JSDoc `spend` для `manual` (club-1 контракт),
  `pendingAmount` у `points.reversed` (club-2 контракт), застаріла перевірка заглушки в
  `test/e2e/ports.e2e-spec.ts` (club-3 контракт, integration).

## English summary

Club owns loyalty accounts, the append-only points ledger (`LedgerService` = `CLUB_LEDGER_PORT`),
FIFO expiry buckets, holds, welcome and profile-field bonuses and versioned rule sets. Every write
locks the account row, is idempotent by ledger key, moves cached balances and buckets and
publishes its outbox event in the same (caller's) transaction. Debits record the buckets they
consumed (`points_spend_allocations`), so a refund restores the original expiry (portions already
past their day are expired at once). Rows carry display data written at posting time. Jobs:
hourly hold release, daily 03:30 Kyiv expiry with 30/7-day reminders, nightly drift report.
Endpoints: `GET /club/account` (+ `pendingModeration`), `GET /club/transactions` (+ `from/to`),
`GET /club/transactions/summary`, public `GET /club/rules`, `/admin/club/rule-sets` CRUD,
`/admin/club/accounts/:userId` (+ `/transactions`). Env: `PROFILE_BONUS_PER_FIELD`,
`PROFILE_BONUS_COMPLETE`.
