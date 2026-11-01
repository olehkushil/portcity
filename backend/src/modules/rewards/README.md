# Модуль rewards

Каталог винагород, обмін балів на винагороди (redemptions), гаманець ваучерів учасника
(винагороди, купони акцій, квитки на події, сертифікати), активація ваучера на 2 хвилини,
пристрої-валідатори на касах і бек-офіс. Вимоги: `docs/BRIEF.md` розділи 3-9.

English summary: guest-readable reward catalogue, points-for-reward redemptions through the club
ledger, the voucher wallet with 2-minute activation codes (6 chars + signed token) and a static
offline QR for tickets/certificates, cashier validator devices (`X-Validator-Key` + shift token;
the PIN only opens a shift, 5 wrong PINs lock it for 15 minutes) with atomic single-use
redemption, back-office CRUD, the minute `vouchers-expire` sweep (refunds unused points vouchers)
and the `rewards-events` outbox consumer. Activation and cancellation lock the voucher row and
write conditionally; lock order is voucher -> reward -> account. Provides `VOUCHER_ISSUER_PORT`.

## Структура

| Шлях                  | Що там                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`             | чиста логіка без Nest/Prisma: стан ваучера, активація, підписані токени, статичний QR і номер для показу, зміни валідатора, правила PIN, правила каталогу, рішення про погашення та скасування |
| `services/`           | `RewardsRepository` (абстракція) + `PrismaRewardsRepository`, сервіси каталогу, обміну, ваучерів, валідатора, пристроїв, адмін-ваучерів, мапери  |
| `controllers/`        | HTTP: учасник (`rewards`, `vouchers`), валідатор (`validator`), бек-офіс (`admin/rewards`, `admin/validator-devices`, `admin/vouchers`)            |
| `auth/`               | `ValidatorGuard`, декоратори `@ValidatorAuth()` і `@CurrentValidator()`                                                                            |
| `dto/`                | DTO з class-validator і Swagger                                                                                                                    |
| `jobs/`               | `vouchers-expire` (щохвилини) і споживач `rewards-events`; логіка - чисті функції з юніт-тестами, процесори лише зв'язують                         |
| `rewards.config.ts`   | власна секція змінних середовища                                                                                                                   |
| `index.ts`            | публічний API модуля                                                                                                                               |
| `test/rewards/`       | in-memory репозиторій, фейки портів і e2e-тест модуля                                                                                              |

## Модель (prisma/schema/rewards.prisma)

- `Reward` - винагорода каталогу: вартість у балах, вид (`parking_hour | partner | certificate | gift | cinema`),
  орендар (необов'язково), залишок `stock` (null - без обмежень), ліміт на учасника, період дії, `sortOrder`.
  Винагороди не видаляються (на них посилаються обміни): `DELETE` у бек-офісі деактивує.
  API віддає `imageUrl = S3_PUBLIC_BASE_URL + imageKey` (null без ключа або бази) і картку орендаря
  з `logoUrl`.
- `Redemption` - обмін балів: `created -> issued -> cancelled | refunded`, посилається на рядок списання
  в леджері (`pointsTxId`) і на виданий ваучер.
- `Voucher` - усе, що учасник показує на касі. `sourceType`: `redemption` (за бали), `promo` (купон),
  `event` (квиток), `admin` (подарунок від ТРЦ). `code` видається при активації; унікальний серед
  живих ваучерів (частковий індекс `vouchers_code_live_key WHERE status IN ('issued','active')`).
  `tokenHash` - HMAC підписаного токена поточної активації. `imageKey` - картинка ваучера (для
  обміну - зображення винагороди; promos може передати свою через `IssueVoucherInput.imageKey`).
- `ValidatorDevice` - планшет або телефон на касі: `deviceKeyHash = sha256(X-Validator-Key)`, `pinHash`
  (scrypt PHC), `tenantId` (null - пристрій ТРЦ, наприклад інфостійка), `active`, `revokedAt`,
  `failedPinAttempts` (невдалі PIN поспіль), `pinLockedUntil` (блокування відкриття зміни).
- `VoucherRedemptionLog` - кожна спроба погашення (успішна чи ні) з причиною, методом і IP.

## Машина станів ваучера (domain/voucher-state.ts)

```
issued -> active (вікно активації 120 с) -> redeemed
active -> issued   вікно минуло, а expiresAt не настав (повторна активація дозволена)
issued | active -> expired     настав expiresAt
issued | active -> cancelled   бали повертаються за правилом (domain/cancel-policy.ts)
```

Статус у відповідях API - ефективний (`effectiveVoucherStatus`): активація, що минула, читається як
`issued`, а ваучер після `expiresAt` - як `expired`, навіть до проходу щохвилинної задачі. Код і
`activationExpiresAt` показуються лише поки активація жива.

Конкурентність (знахідки 1 і 3 рев'ю): активація й скасування починаються з `SELECT ... FOR UPDATE`
на рядок ваучера (`RewardsRepository.lockVoucher`), а кожен запис, що змінює стан, умовний на
статус, прочитаний під блокуванням (`updateVoucherIf`): 0 змінених рядків -> `409 PC_VOUCHER_FINAL`
(ваучер уже фінальний) або `422 PC_VOUCHER_NOT_ACTIVE` (змінився інакше, повторіть). Скасований
ваучер більше не може «ожити» через паралельну активацію. Порядок блокувань усюди ваучер ->
винагорода -> рахунок балів: скасування й згоряння блокують винагороду (`lockReward`) до виклику
леджера, обмін бере винагорода -> рахунок, тож взаємних блокувань немає.

Відповідь ваучера (`VoucherDto`) також має `tenant { id, slug, name, floor, logoUrl }` (через
`CONTENT_PORT.getTenantSummaryById` із запасним `getTenants`; недоступний content дає
`tenant: null`), `imageUrl`,
`displayNumber` (8 цифр, стабільний для ваучера, похідний від id, лише для показу) і `qrPayload`.

Статичний QR квитків і сертифікатів (знахідка 5): поки ваучер виду `ticket` або `certificate`
живий, `qrPayload = PCV1:<base64url(voucherId.exp.hmac)>` (HMAC-SHA256 на `VOUCHER_PEPPER`, окремий
вид підпису), де `exp` - `expiresAt` ваучера (без строку - 3000-01-01). Його можна показати
офлайн; валідатор приймає його в полі `token` без активації: підпис, строк, збіг `exp` з поточним
`expiresAt` (зміна строку анулює старі QR) і вид ваучера; погашення одноразове й атомарне
(`UPDATE ... WHERE status IN ('issued','active') AND expires_at > now`).

Правило повернення балів: ваучер з `sourceType = redemption` при скасуванні повертає списані бали
(`ClubLedgerPort.reverse`, ключ ідемпотентності `voucher-cancel:<voucherId>`, у леджері з'являється
рядок `refund`), обмін стає `refunded`, одиниця залишку повертається винагороді. Адміністратор може
скасувати без повернення (`refundPoints: false`, наприклад зловживання) - обмін стає `cancelled`.
Купони, квитки й адмін-ваучери балів не мають. Погашений ваучер скасувати не можна.

Згоряння (знахідка 4, рішення продукту: застосунок обіцяє повернення балів): ваучер з
`sourceType = redemption`, що згорів невикористаним, повертає бали через `ClubLedgerPort.reverse`
(ключ `voucher-expire:<voucherId>`) у тій самій транзакції, що й `issued|active -> expired`; обмін
стає `refunded`, одиниця залишку повертається. Вимикається `REWARDS_REFUND_ON_EXPIRY=false`.
Купони, квитки та сертифікати з promos/admin не повертаються. Ідемпотентно: умовне оновлення
пропускає вже згорілий ваучер, а леджер тримає одну компенсацію на рядок списання; помилка
леджера відкочує згоряння, і наступний прохід повторює. Бали повертаються в початкові кошики
леджера (club, знахідка 2), тож строк згоряння не подовжується.

## Активація (domain/activation.ts, BRIEF розділ 7)

- `POST /vouchers/:id/activate` видає 6-символьний код з алфавіту `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
  і підписаний токен `base64url(voucherId.exp.hmac)` (HMAC-SHA256 на `VOUCHER_PEPPER`), дійсні 120 с.
- Повторний виклик у межах вікна повертає той самий код і токен (без нової події); після вікна -
  новий код, поки не настав `expiresAt`.
- Код унікальний серед живих ваучерів: перевірка перед записом плюс частковий унікальний індекс;
  колізія на індексі (гонка) повторює всю транзакцію з новим кодом, після
  `REWARDS_CODE_MAX_ATTEMPTS` спроб - `503 PC_VOUCHER_CODE_EXHAUSTED`.

## Обмін балів (POST /rewards/:id/redeem)

Одна транзакція: `SELECT ... FOR UPDATE` на винагороду, перевірка періоду, залишку та ліміту на учасника,
списання залишку, рядок `Redemption`, `ClubLedgerPort.spend` у тій самій транзакції
(ключ `redemption:<redemptionId>`), видача ваучера (`expiresAt = now + REWARDS_VOUCHER_TTL_DAYS`,
але не пізніше `validTo` винагороди), події `voucher.issued` і `redemption.created`. Будь-яка помилка
(зокрема `422 PC_POINTS_INSUFFICIENT` від леджера) відкочує все. Ендпоїнт вимагає `Idempotency-Key`.
Назва орендаря (підзаголовок ваучера) і поточна паркувальна сесія для `parking_hour` - лише збагачення:
недоступний порт content/parking не блокує обмін.

## Валідатор (каса)

1. Адміністратор реєструє пристрій: `POST /admin/validator-devices {name, tenantId?, pin}` -> сирий
   `deviceKey` показується один раз; зберігається лише SHA-256.
2. Пристрій надсилає `X-Validator-Key` у кожному запиті (назви заголовків -
   `src/common/auth/auth.constants.ts`; в OpenAPI: відкриття зміни - лише `validator-key`, інші
   маршрути - `validator-key` + `validator-shift`). На початку зміни касир вводить PIN:
   `POST /validator/shift {pin}` -> `shiftToken` (підписаний, `VALIDATOR_SHIFT_HOURS`, прив'язаний до
   відбитка поточного `pinHash`). Далі пристрій надсилає `X-Validator-Shift`. PIN приймається лише
   цим ендпоїнтом: `X-Validator-Pin` на інших маршрутах більше не діє (`401 PC_VALIDATOR_PIN_REQUIRED`).
3. Захист PIN (знахідка 8): новий або змінений PIN - 6-12 цифр (відкриття зміни ще приймає 4-12 для
   пристроїв зі старим PIN). Невдалі PIN рахуються на пристрої (`failedPinAttempts`, атомарний
   інкремент, фіксується навіть при помилці запиту; у відповіді `details.attemptsLeft`); 5-й
   поспіль блокує відкриття зміни на 15 хв (`429 PC_VALIDATOR_PIN_LOCKED`, `details.lockedUntil`)
   і пише аудит `validator_device.pin_locked` (актор `system/validator`, IP). Успішний PIN скидає
   лічильник, новий PIN від адміністратора знімає блокування.
4. Зміна PIN (`POST /admin/validator-devices/:id/pin`) закриває всі відкриті зміни; відкликання
   (`POST /admin/validator-devices/:id/revoke`) зупиняє пристрій на наступному запиті.
5. `POST /validator/redeem {code | token}`: код нормалізується (регістр, пробіли, дефіси), токен
   активації перевіряється підписом і має збігатися з `tokenHash` поточної активації; `token` із
   префіксом `PCV1:` - статичний QR квитка/сертифіката. Погашення - атомарний умовний `UPDATE ...
   WHERE id = $1 AND status = 'active' AND activation_expires_at > $now AND (expires_at IS NULL OR
   expires_at > $now)` (для статичного QR - `status IN ('issued','active')`); програш гонки дає
   `409 PC_VOUCHER_ALREADY_REDEEMED`. Пристрій орендаря погашає лише ваучери свого орендаря;
   пристрій ТРЦ (`tenantId = null`) - будь-які. Кожна спроба записується в `voucher_redemption_logs`;
   помилки повертаються як problem+json (`PC_VOUCHER_NOT_FOUND`, `PC_VOUCHER_NOT_ACTIVE`,
   `PC_VOUCHER_EXPIRED`, `PC_VOUCHER_FINAL`, `PC_VOUCHER_WRONG_TENANT`, `PC_VALIDATOR_INACTIVE`)
   з `details: { outcome }` і без id ваучера. Орендар спершу перевіряється на відповідність: чужий
   ваучер завжди читається як `PC_VOUCHER_WRONG_TENANT`, без його стану (погашений, скасований,
   згорілий), а у власному журналі пристрою (`GET /validator/log`) такі спроби не показують id і
   назву ваучера (бек-офіс бачить усе).

## Ендпоїнти (префікс `/api/v1`)

| Метод і шлях                                  | Доступ                         | Опис                                                                    |
| --------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `GET /rewards?affordable=&kind=&cursor=&limit=` | гість або member (`@OptionalAuth`) | каталог з `affordable`, `available`, `remainingForUser`, `imageUrl`; для гостя `affordable` і `remainingForUser` = null, `affordable=true` ігнорується; хибний токен - 401 |
| `GET /rewards/:id`                            | гість або member               | деталі винагороди (для гостя персональні поля null)                     |
| `POST /rewards/:id/redeem`                    | member, `Idempotency-Key`      | обмін балів -> `{redemption, voucher, pointsSpent, pointsTxId, availableBalance}` |
| `GET /vouchers?status=&kind=&cursor=&limit=`  | member                         | мої ваучери (ефективний статус); `status` - один або кілька через кому (`issued,active`) |
| `GET /vouchers/summary`                       | member                         | кількість за ефективними статусами + `live` (issued + active) для «Мої ваучери (N)» |
| `GET /vouchers/:id`                           | member                         | деталі ваучера                                                          |
| `POST /vouchers/:id/activate`                 | member                         | `{code, token, activatedAt, activationExpiresAt, serverTime, voucher}`  |
| `POST /vouchers/:id/cancel {reason?}`         | member, `Idempotency-Key`      | скасування, повернення балів за правилом                                |
| `POST /validator/shift {pin}`                 | `X-Validator-Key`              | відкрити зміну -> `shiftToken` (єдине місце, де приймається PIN; 5 помилок - блокування 15 хв) |
| `GET /validator/me`                           | ключ + зміна                   | пристрій і поточна зміна                                                |
| `POST /validator/redeem {code \| token}`      | ключ + зміна                   | погашення -> зведення ваучера                                           |
| `GET /validator/log?cursor=&limit=`           | ключ + зміна                   | журнал спроб пристрою                                                   |
| `GET /admin/rewards`, `GET /admin/rewards/:id` | owner, manager                | каталог з фільтрами `active`, `kind`, `tenantId`                        |
| `POST /admin/rewards`, `PATCH /admin/rewards/:id`, `DELETE /admin/rewards/:id?reason=` | owner, manager | створення, зміна, деактивація (аудит) |
| `GET /admin/validator-devices`, `GET /admin/validator-devices/:id` | owner, manager | пристрої                                                   |
| `POST /admin/validator-devices`               | owner, manager                 | реєстрація, ключ показується один раз                                   |
| `PATCH /admin/validator-devices/:id`          | owner, manager                 | назва, орендар, реактивація                                             |
| `POST /admin/validator-devices/:id/revoke?reason=` | owner, manager            | відкликання                                                             |
| `POST /admin/validator-devices/:id/rotate-key` | owner, manager                | новий ключ (один раз), старий перестає діяти                            |
| `POST /admin/validator-devices/:id/pin {pin}` | owner, manager                 | новий PIN, відкриті зміни закриваються                                  |
| `GET /admin/validator-devices/:id/log`        | owner, manager                 | журнал спроб пристрою                                                   |
| `GET /admin/vouchers?userId=&status=&kind=&tenantId=&sourceType=` | owner, manager, support | пошук ваучерів (`status` - один або кілька через кому) |
| `GET /admin/vouchers/:id`                     | owner, manager, support        | деталі                                                                  |
| `POST /admin/vouchers`                        | owner, manager, `Idempotency-Key` | подарунковий ваучер (`sourceType = admin`)                           |
| `POST /admin/vouchers/:id/cancel {reason, refundPoints?}` | owner, manager, `Idempotency-Key` | скасування з правилом балів                        |

Усі мутації бек-офісу пишуть аудит через `ADMIN_AUDIT_PORT` у тій самій транзакції.

## Черги та задачі

| Черга             | Розклад            | Що робить                                                                                                   |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `vouchers-expire` | кожні 60 с (`vouchers-expire-every-minute`, задача `expire`) | активація, що минула -> `issued` (код звільняється), якщо `expiresAt` не настав; живі ваучери після `expiresAt` -> `expired` + подія `voucher.expired`, а ваучер за бали ще й повертає бали (`REWARDS_REFUND_ON_EXPIRY`). Пакетами по `REWARDS_SWEEP_BATCH_SIZE`, до 20 пакетів за прохід, кожен ваучер - окрема транзакція з умовним оновленням |
| `rewards-events`  | події outbox       | `event.registration_cancelled` -> скасувати квиток (без балів, ідемпотентно; страховка, бо promos скасовує квиток синхронно); `user.deleted` -> скасувати всі живі ваучери анонімізованого акаунта без повернення |

Логіка задач - `jobs/vouchers-expire.job.ts` (`runVouchersExpire`) і `jobs/rewards-events.handler.ts`
(`handleRewardsEventJob`), обидві з юніт-тестами.

## Події outbox

Публікує: `redemption.created`, `voucher.issued`, `voucher.activated`, `voucher.redeemed`,
`voucher.expired`, `voucher.cancelled` (payload - `src/common/contracts/events.ts`). Повернення ваучера
з `active` в `issued` події не має. Споживає: `event.registration_cancelled`, `user.deleted`.

## Порти

- Надає: `VOUCHER_ISSUER_PORT` = `VoucherService` (`issue` ідемпотентний за `(sourceType, sourceId, kind)`,
  `cancel`, `getVoucher`, `listBySource`, `getDailyStats`); приєднується до транзакції викликача (`tx`).
  Споживачі: promos (купони, квитки), admin (звіти).
  Ідемпотентність `issue`: спершу перевірка наявного ваучера (звичайний повтор), а вставка йде як
  `INSERT ... ON CONFLICT DO NOTHING` (`createMany(..., skipDuplicates)`) на частковий унікальний індекс
  `vouchers_source_kind_key (source_type, source_id, kind) WHERE source_id IS NOT NULL`. Два паралельні
  виклики (повторна доставка події, подвійний клік) дають один ваучер і одну подію `voucher.issued`;
  програвша сторона отримує ваучер-переможця, транзакція викликача не обривається.
- Споживає: `CLUB_LEDGER_PORT` (`spend`, `reverse`, `getBalance`; разом зі списанням і поверненням
  передає дані для історії балів: `title`, `subtitle`, `counterparty` з назвою винагороди, орендарем і
  ваучером), `CONTENT_PORT` (картки орендарів за id для ваучерів і каталогу -
  `services/tenant-cards.ts`: спершу `getTenantSummaryById` (content сам дає `logoUrl`), для id, на
  які він не відповів, або якщо методу немає - локальний запасний шлях через пакетний `getTenants`
  і `S3_PUBLIC_BASE_URL + logoKey`; перевірка `tenantId` в адмінці; недоступність не блокує),
  `PARKING_PORT` (сесія для `parking_hour`), `ADMIN_AUDIT_PORT` (адмін-дії, блокування PIN).
- `VoucherSummary` у контракті отримав необов'язкові `displayNumber`, `qrPayload`, `imageKey`
  (фейки порту в інших модулях лишаються валідними), `IssueVoucherInput` - `imageKey`.

## Змінні середовища (секція `rewards`, `rewards.config.ts`)

| Змінна                      | Типово | Опис                                                       |
| --------------------------- | ------ | ---------------------------------------------------------- |
| `REWARDS_VOUCHER_TTL_DAYS`  | 30     | строк дії ваучера, купленого за бали (1-365 днів)          |
| `REWARDS_CODE_MAX_ATTEMPTS` | 8      | спроб знайти вільний код до `PC_VOUCHER_CODE_EXHAUSTED`    |
| `REWARDS_SWEEP_BATCH_SIZE`  | 500    | розмір пакета щохвилинної задачі (10-5000)                 |
| `VALIDATOR_SHIFT_HOURS`     | 12     | тривалість зміни валідатора після введення PIN (1-48 год) |
| `REWARDS_REFUND_ON_EXPIRY`  | true   | повертати бали за ваучер з обміну, що згорів невикористаним |

Також використовуються спільні `VOUCHER_PEPPER` (підпис токенів активації, змін і статичних QR) і
`S3_PUBLIC_BASE_URL` (`imageUrl`, `logoUrl`; без неї - null). Змінна є в `.env.example`.

## Коди помилок

`PC_REWARD_NOT_FOUND` 404, `PC_REWARD_INACTIVE` 422, `PC_REWARD_OUT_OF_STOCK` 422,
`PC_REWARD_LIMIT_REACHED` 422, `PC_VOUCHER_NOT_FOUND` 404, `PC_VOUCHER_NOT_ACTIVE` 422,
`PC_VOUCHER_EXPIRED` 422, `PC_VOUCHER_ALREADY_REDEEMED` 409, `PC_VOUCHER_FINAL` 409,
`PC_VOUCHER_WRONG_TENANT` 422, `PC_VOUCHER_CODE_EXHAUSTED` 503, `PC_VALIDATOR_UNAUTHORIZED` 401,
`PC_VALIDATOR_PIN_REQUIRED` 401, `PC_VALIDATOR_PIN_INVALID` 401, `PC_VALIDATOR_INACTIVE` 403,
`PC_VALIDATOR_NOT_FOUND` 404, `PC_VALIDATOR_PIN_LOCKED` 429 (усі коди перелічені в
`REWARDS_ERROR_CODES` контракту).

## Тести

- `npx jest src/modules/rewards` - юніт-тести: табличні тести всіх файлів `domain/` (зокрема
  статичний QR, правила PIN, порядок перевірки орендаря), сервіси на фейках
  (`test/rewards/support`: in-memory репозиторій з семантикою Prisma-реалізації, фейковий Prisma з
  відкатом транзакцій, фейки леджера, content, parking, outbox, аудиту), DTO, мапери, задачі.
  Регресії рев'ю: активація після скасування між читанням і записом (`serveStaleLockRead`
  відтворює переплетення) не «оживляє» ваучер, дві активації не перетирають одна одну, порядок
  блокувань ваучер -> винагорода -> леджер (`callLog`), повернення балів при згорянні,
  блокування PIN, відсутність id чужого ваучера в помилках, гостьовий каталог.
- `npx jest --config test/jest-e2e.config.js test/rewards` - e2e модуля на повному `AppModule`
  з підміною Prisma/репозиторію/портів: маршрути, guards, ідемпотентність, повний сценарій каси.
- Інтеграційних тестів з PostgreSQL ще немає: часткові індекси (`vouchers_code_live_key`,
  `vouchers_source_kind_key`) і `FOR UPDATE` (`lockVoucher`, `lockReward`) перевіряються лише на
  справжній БД (CI); на фейках перевіряється, що блокування беруться і в якому порядку.

Закрито під час інтеграції (2026-11-01): індекс `vouchers_source_kind_key` і гонко-безпечний `issue`,
індекс `(user_id, reward_id, status)` для ліміту на учасника, константи заголовків валідатора в
`src/common/auth`, `PC_VALIDATOR_NOT_FOUND` у контракті.

Виправлено за рев'ю 2026-11-01: блокування й умовні записи активації/скасування, порядок
блокувань, повернення балів при згорянні, статичний QR і `displayNumber`, `tenant`/`imageUrl` у
ваучері, кілька статусів і `GET /vouchers/summary`, захист валідатора (6 цифр, лічильник і
блокування, PIN лише на `/validator/shift`, жодних id чужих ваучерів), гостьовий каталог. SQL -
міграція `20261101180000_review_fixes` (розділи 1, 2.3, 3.3), seed - `prisma/seed.ts` (PIN
демо-валідатора `246813`); архів - `docs/pending-sql/applied/club-rewards.*`.

## Відкриті питання

1. Правило повернення балів: зараз повне повернення будь-коли до погашення і при згорянні
   (`REWARDS_REFUND_ON_EXPIRY`); чи потрібні обмеження (наприклад, без повернення після N днів
   або для певних видів винагород)?
2. Ваучери без орендаря (`parking_hour`, сертифікати) погашає лише пристрій ТРЦ (`tenantId = null`).
   Чи потрібне автоматичне застосування години паркінгу через провайдера паркінгу замість каси?
3. Умовне погашення порівнює `activation_expires_at` з часом застосунку (`Clock`), а не з `now()`
   PostgreSQL; при розсинхронізації годинників можлива похибка в межах секунд.
4. Чи дозволяти учаснику скасовувати купони й квитки через `POST /vouchers/:id/cancel` (зараз так;
   квиток promos закриває реєстрацію через подію `voucher.cancelled`)?
5. `displayNumber` похідний від id (8 цифр) і не унікальний гарантовано; якщо касі треба вводити
   його вручну як код погашення, потрібна окрема колонка з унікальним індексом.
6. Спроба за статичним QR пишеться в журнал як `method = token`; окреме значення enum
   (`static_qr`) - за потреби звітності.
7. Закрито інтеграцією 01.11.2026: схему безпеки `validator-pin` прибрано з OpenAPI, заголовок
   `X-Validator-Pin` - з дозволених у CORS. Константа `VALIDATOR_PIN_HEADER` лишилася лише для
   пояснення в `401 PC_VALIDATOR_PIN_REQUIRED` і для маскування заголовка в логах.
8. Подія `voucher.expired` не несе `pointsRefunded` (payload не змінювався); повернення видно в
   леджері (`points.reversed`, рядок `refund` з підзаголовком про ваучер).
